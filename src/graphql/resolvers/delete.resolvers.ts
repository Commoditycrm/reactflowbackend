import { GraphQLError } from "graphql";
import logger from "../../logger";
import { getFirebaseAdminAuth } from "../firebase/admin";
import { OGMConnection } from "../init/ogm.init";
import { Neo4JConnection } from "../../database/connection";
import { Model } from "@neo4j/graphql-ogm";
import { ApolloServerErrorCode } from "@apollo/server/errors";
import { User } from "../../interfaces";

/**
 * True if the caller and the target user share at least one organization
 * (either OWNS or MEMBER_OF). Used to keep COMPANY_ADMIN actions scoped to
 * their own org; SYSTEM_ADMIN callers bypass this check.
 */
const callerSharesOrgWithTarget = async (
  callerExternalId: string,
  targetUserId: string
): Promise<boolean> => {
  const session = (await Neo4JConnection.getInstance()).driver.session();
  try {
    const result = await session.run(
      `
      MATCH (caller:User {externalId: $callerExternalId})-[:OWNS|MEMBER_OF]->(org:Organization)<-[:OWNS|MEMBER_OF]-(target:User {id: $targetUserId})
      RETURN org.id AS orgId
      LIMIT 1
      `,
      { callerExternalId, targetUserId }
    );
    return result.records.length > 0;
  } finally {
    await session.close();
  }
};

const deleteUser = async (
  _source: Record<string, any>,
  { userId }: { userId: string },
  _context: Record<string, any>
) => {
  const currentUserId = _context?.jwt?.sub;

  if (!currentUserId) {
    throw new GraphQLError("Authentication required.", {
      extensions: { code: "UNAUTHENTICATED" },
    });
  }

  // Initialize OGM connection once
  const User: Model = (await OGMConnection.getInstance()).model("User");

  try {
    // Single query to get both users with proper error handling
    const [currentUserResult, targetUserResult] = await Promise.allSettled([
      User.find<User[]>({
        where: { externalId: currentUserId },
        options: { limit: 1 },
      }),
      User.find<User[]>({ where: { id: userId }, options: { limit: 1 } }),
    ]);

    // Handle current user query failure
    if (currentUserResult.status === "rejected") {
      logger?.error("Failed to fetch current user", {
        currentUserId,
        error: currentUserResult.reason,
      });
      throw new GraphQLError("Authentication failed.", {
        extensions: { code: ApolloServerErrorCode.INTERNAL_SERVER_ERROR },
      });
    }

    if (targetUserResult.status === "rejected") {
      logger?.error("Failed to fetch target user", {
        userId,
        error: targetUserResult.reason,
      });
      throw new GraphQLError("Unable to process user deletion request.", {
        extensions: { code: ApolloServerErrorCode.INTERNAL_SERVER_ERROR },
      });
    }

    const [currentUser] = currentUserResult.value;
    const [targetUser] = targetUserResult.value;

    if (!currentUser) {
      logger?.error("Current user not found in database", { currentUserId });
      throw new GraphQLError("Authentication failed.", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    if (!["SYSTEM_ADMIN", "COMPANY_ADMIN"].includes(currentUser.role)) {
      logger?.error("Unauthorized deletion attempt", {
        currentUserId,
        currentUserRole: currentUser.role,
        targetUserId: userId,
      });
      throw new GraphQLError("Unauthorized access. Insufficient permissions.", {
        extensions: { code: "FORBIDDEN" },
      });
    }

    if (!targetUser) {
      throw new GraphQLError("User not found.", {
        extensions: { code: ApolloServerErrorCode.BAD_REQUEST },
      });
    }

    if (currentUser.id === targetUser.id) {
      throw new GraphQLError("Cannot delete your own account.", {
        extensions: { code: ApolloServerErrorCode.BAD_REQUEST },
      });
    }

    // COMPANY_ADMIN may only delete users within their own org.
    if (currentUser.role !== "SYSTEM_ADMIN") {
      const sameOrg = await callerSharesOrgWithTarget(currentUserId, userId);
      if (!sameOrg) {
        logger?.error("Cross-org deletion attempt blocked", {
          currentUserId,
          targetUserId: userId,
        });
        throw new GraphQLError(
          "Unauthorized access. Insufficient permissions.",
          { extensions: { code: "FORBIDDEN" } }
        );
      }
    }

    // Anonymize in the DB first. Firebase deletion is irreversible, so we only
    // fire it once the DB write commits -- doing both in parallel could delete
    // the login while leaving the un-anonymized node behind on a DB failure.
    let updateResult;
    try {
      updateResult = await User.update({
        where: { id: userId },
        update: {
          name: "Deleted Account",
          email: `Deleted Account_${targetUser?.email}`,
        },
      });
    } catch (dbError) {
      logger?.error("Failed to update user in database", {
        userId,
        error: dbError,
      });
      throw new GraphQLError("Failed to delete user account.", {
        extensions: { code: ApolloServerErrorCode.INTERNAL_SERVER_ERROR },
      });
    }

    // externalId is non-nullable and not OGM-settable on update, so revoke access
    // in raw Cypher: detaching OWNS/MEMBER_OF drops the node out of every
    // org-scoped authorization query, which is what actually neutralizes it.
    const revokeSession = (await Neo4JConnection.getInstance()).driver.session();
    try {
      await revokeSession.run(
        `
        MATCH (u:User {id: $userId})
        SET u.deletedAt = datetime()
        WITH u
        OPTIONAL MATCH (u)-[r:OWNS|MEMBER_OF]->(:Organization)
        DELETE r
        `,
        { userId }
      );
    } catch (revokeError) {
      logger?.error("Failed to revoke access for deleted user", {
        userId,
        error: revokeError,
      });
      throw new GraphQLError("Failed to fully revoke user access.", {
        extensions: { code: ApolloServerErrorCode.INTERNAL_SERVER_ERROR },
      });
    } finally {
      await revokeSession.close();
    }

    // DB committed; now remove the Firebase credential so no new token can be
    // minted. "user-not-found" just means it was already gone.
    try {
      await getFirebaseAdminAuth().auth().deleteUser(targetUser.externalId);
    } catch (firebaseError: any) {
      if (firebaseError?.code === "auth/user-not-found") {
        logger?.warn("Firebase user already absent during deletion", {
          userId,
          externalId: targetUser.externalId,
        });
      } else {
        logger?.error("Failed to revoke Firebase login for deleted user", {
          userId,
          externalId: targetUser.externalId,
          error: firebaseError,
        });
        throw new GraphQLError(
          "User was anonymized but their login could not be revoked. Please retry.",
          { extensions: { code: ApolloServerErrorCode.INTERNAL_SERVER_ERROR } }
        );
      }
    }

    logger?.info("User successfully deleted", {
      deletedUserId: userId,
      deletedBy: currentUserId,
    });

    return updateResult?.users ?? [];
  } catch (error) {
    // Enhanced error logging
    logger?.error("Error in deleteUser operation", {
      userId,
      currentUserId,
      error: error instanceof Error ? error.message : error,
      stack: error instanceof Error ? error.stack : undefined,
    });

    // Re-throw GraphQLErrors as-is
    if (error instanceof GraphQLError) {
      throw error;
    }

    // Generic fallback error
    throw new GraphQLError(
      "Unable to delete user account. Please try again later.",
      { extensions: { code: ApolloServerErrorCode.INTERNAL_SERVER_ERROR } }
    );
  }
};

const disableUser = async (
  _source: Record<string, any>,
  { userId }: { userId: string },
  _context: Record<string, any>
) => {
  const currentUserId = _context?.jwt?.sub;

  if (!currentUserId) {
    throw new GraphQLError("Authentication required.", {
      extensions: { code: "UNAUTHENTICATED" },
    });
  }

  const User = (await OGMConnection.getInstance()).model("User");

  try {
    const [currentUser] = await User.find({
      where: { externalId: currentUserId },
      options: { limit: 1 },
    });

    if (!currentUser) {
      logger?.error("Current user not found in database", { currentUserId });
      throw new GraphQLError("Authentication failed.", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    if (
      currentUser.role !== "SYSTEM_ADMIN" &&
      currentUser.role !== "COMPANY_ADMIN"
    ) {
      logger?.error("Unauthorized access attempt by user", { currentUserId });
      throw new GraphQLError("Unauthorized access. Insufficient permissions.", {
        extensions: { code: "FORBIDDEN" },
      });
    }

    const [targetUser] = await User.find({
      where: { id: userId },
      options: { limit: 1 },
    });

    if (!targetUser) {
      throw new GraphQLError("User not found.", {
        extensions: { code: ApolloServerErrorCode.BAD_REQUEST },
      });
    }

    // COMPANY_ADMIN may only disable users within their own org.
    if (currentUser.role !== "SYSTEM_ADMIN") {
      const sameOrg = await callerSharesOrgWithTarget(currentUserId, userId);
      if (!sameOrg) {
        logger?.error("Cross-org disable attempt blocked", {
          currentUserId,
          targetUserId: userId,
        });
        throw new GraphQLError(
          "Unauthorized access. Insufficient permissions.",
          { extensions: { code: "FORBIDDEN" } }
        );
      }
    }

    // Firebase identifies users by their uid (externalId), not the DB id.
    await getFirebaseAdminAuth().auth().updateUser(targetUser.externalId, {
      disabled: true,
    });
    return true;
  } catch (error) {
    if (error instanceof GraphQLError) {
      throw error;
    }
    logger?.error(error);
    throw new GraphQLError(
      "Unable to disable user account or account not found."
    );
  }
};

const deleteFirebaseUser = async (
  _source: Record<string, any>,
  { userId }: { userId: string },
  _context: Record<string, any>
) => {
  try {
    await getFirebaseAdminAuth().auth().deleteUser(userId);
    return true;
  } catch (error) {
    if (error instanceof Error) {
      throw new GraphQLError(error.message, {
        extensions: {
          code: ApolloServerErrorCode.INTERNAL_SERVER_ERROR,
        },
      });
    } else {
      throw new GraphQLError(
        "An unexpected error occurred while Empty recycleBin",
        {
          extensions: {
            code: ApolloServerErrorCode.INTERNAL_SERVER_ERROR,
          },
        }
      );
    }
  }
};

const deleteOrg = async (
  _source: Record<string, any>,
  { orgId }: { orgId: string },
  _context: Record<string, any>
) => {
  const callerExternalId = _context?.jwt?.sub;
  if (!callerExternalId) {
    throw new GraphQLError("Authentication required.", {
      extensions: { code: "UNAUTHENTICATED" },
    });
  }

  // Verify SYSTEM_ADMIN against the DB rather than the client-presented JWT
  // claim -- this is a destructive, org-wide delete.
  const authSession = (await Neo4JConnection.getInstance()).driver.session();
  try {
    const roleResult = await authSession.run(
      `MATCH (u:User {externalId: $callerExternalId}) RETURN u.role AS role LIMIT 1`,
      { callerExternalId }
    );
    if (roleResult.records[0]?.get("role") !== "SYSTEM_ADMIN") {
      throw new GraphQLError("UNAUTHORIZED", {
        extensions: { code: "FORBIDDEN" },
      });
    }
  } finally {
    await authSession.close();
  }

  const session = (await Neo4JConnection.getInstance()).driver.session();
  const tx = session.beginTransaction();

  let uids: string[] = [];
  try {
    const result = await tx.run(
      `
      MATCH (org:Organization {id:$orgId})
      CALL(org) {
        OPTIONAL MATCH(users:User)-[:MEMBER_OF]->(org)
        RETURN users.externalId AS uid
        UNION
        OPTIONAL MATCH(user:User)-[:OWNS]->(org)
        RETURN user.externalId AS uid
      } WITH uid WHERE uid IS NOT NULL RETURN collect(DISTINCT uid) AS uids
      `,
      {
        orgId,
      }
    );
    uids =
      result.records && result.records[0] ? result.records[0].get("uids") : [];
    await tx.run(
      `CALL apoc.periodic.iterate(
     '
      MATCH (org:Organization {id: $orgId})
      OPTIONAL MATCH (org)--(n)
      OPTIONAL MATCH (n)--(m)
      WITH collect(DISTINCT org) + collect(DISTINCT n) + collect(DISTINCT m) AS nodes
      UNWIND nodes AS node
      RETURN node
    ',
    '
      DETACH DELETE node
    ',
    {
      batchSize: 100,
      parallel: false,
      params: { orgId: $orgId }
    }
    )`,
      { orgId }
    );
    await tx.commit();
  } catch (error) {
    await tx.rollback();
    logger?.error(error);
    throw new GraphQLError("An unexpected error occurred while Deleting Org.", {
      extensions: {
        code: ApolloServerErrorCode.INTERNAL_SERVER_ERROR,
      },
    });
  } finally {
    await session.close();
  }

  // Graph delete committed; remove the Firebase logins afterwards so a Firebase
  // failure can't strand an already-deleted graph. Orphaned auth accounts are
  // swept by the cleanup-firebase-orphan cron.
  if (uids.length) {
    try {
      await getFirebaseAdminAuth().auth().deleteUsers(uids);
    } catch (firebaseError) {
      logger?.error("Org graph deleted but Firebase user cleanup failed", {
        orgId,
        error: firebaseError,
      });
    }
  }
  return true;
};

export const deleteOperationMutations = {
  deleteUser,
  disableUser,
  deleteFirebaseUser,
  deleteOrg,
};
