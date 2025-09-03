import { GraphQLError } from "graphql";
import logger from "../../logger";
import { getFirebaseAdminAuth } from "../firebase/admin";
import { OGMConnection } from "../init/ogm.init";
import { Neo4JConnection } from "../../database/connection";
import { Model } from "@neo4j/graphql-ogm";
import { ApolloServerErrorCode } from "@apollo/server/errors";
import {
  DELETE_BACKLOG_CQL,
  DELETE_FILE_CQL,
  DELETE_FLOWNODE_CQL,
  DELETE_FOLDER_CQL,
} from "../../database/constants";
import { User, UserRole } from "../../@types/ogm.types";
import { getModelWhereClause } from "./read.resolvers";

const deleteUser = async (
  _source: Record<string, any>,
  { userId }: { userId: string },
  _context: Record<string, any>
) => {
  const currentUserId = _context?.jwt?.sub;

  if (!currentUserId) {
    throw new GraphQLError("Authentication required.", {
      extensions: { code: ApolloServerErrorCode.INTERNAL_SERVER_ERROR },
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
        extensions: { code: ApolloServerErrorCode.INTERNAL_SERVER_ERROR },
      });
    }

    if (!["SYSTEM_ADMIN", "COMPANY_ADMIN"].includes(currentUser.role)) {
      logger?.error("Unauthorized deletion attempt", {
        currentUserId,
        currentUserRole: currentUser.role,
        targetUserId: userId,
      });
      throw new GraphQLError("Unauthorized access. Insufficient permissions.", {
        extensions: { code: ApolloServerErrorCode.INTERNAL_SERVER_ERROR },
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

    const [updateResult, _firebaseResult] = await Promise.allSettled([
      User.update({
        where: { id: userId },
        update: {
          name: "Deleted Account",
          email: `Deleted Account_${targetUser?.email}`,
        },
      }),
      getFirebaseAdminAuth().auth().deleteUser(targetUser.externalId),
    ]);

    if (updateResult.status === "rejected") {
      logger?.error("Failed to update user in database", {
        userId,
        error: updateResult.reason,
      });
      throw new GraphQLError("Failed to delete user account.", {
        extensions: { code: ApolloServerErrorCode.INTERNAL_SERVER_ERROR },
      });
    }

    if (_firebaseResult.status === "rejected") {
      logger?.warn("Failed to delete user from Firebase (user may not exist)", {
        userId,
        externalId: targetUser.externalId,
        error: _firebaseResult.reason,
      });
    }

    logger?.info("User successfully deleted", {
      deletedUserId: userId,
      deletedBy: currentUserId,
    });

    return updateResult.value?.users ?? [];
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
  const User = (await OGMConnection.getInstance()).model("User");

  try {
    const [currentUser] = await User.find({
      where: {
        externalId: currentUserId,
      },
    });
    if (
      currentUser.role !== "SYSTEM_ADMIN" &&
      currentUser.role !== "COMPANY_ADMIN"
    ) {
      logger?.error("Unauthorized access attempt by user", { currentUserId });
      throw new GraphQLError("Unauthorized access. Insufficient permissions.", {
        extensions: { code: "FORBIDDEN" },
      });
    }
    await getFirebaseAdminAuth().auth().updateUser(userId, {
      disabled: true,
    });
    return true;
  } catch (error) {
    logger?.error(error);
    throw new GraphQLError(
      "Unable to disable user account or account not found."
    );
  }
};

const deleteFolder = async (
  _source: Record<string, any>,
  { folderId }: { folderId: string },
  _context: Record<string, any>
) => {
  const session = (await Neo4JConnection.getInstance()).driver.session();

  const tx = session.beginTransaction();
  try {
    const result = await tx.run(DELETE_FOLDER_CQL, { folderId });
    const summary = result.summary.counters.updates();
    await tx.commit();
    return {
      nodesDeleted: summary?.nodesDeleted || 0,
      relationshipsDeleted: summary?.relationshipsDeleted || 0,
    };
  } catch (error) {
    await tx.rollback();
    logger?.error(error);
    if (error instanceof GraphQLError) {
      throw error;
    }
    throw new GraphQLError(
      "An unexpected error occurred while deleting the folder.",
      {
        extensions: { code: ApolloServerErrorCode.INTERNAL_SERVER_ERROR },
      }
    );
  } finally {
    session.close();
  }
};

const deleteFile = async (
  _source: Record<string, any>,
  { fileId }: { fileId: string },
  _context: Record<string, any>
) => {
  const session = (await Neo4JConnection.getInstance()).driver.session();

  const tx = session.beginTransaction();
  try {
    const result = await tx.run(DELETE_FILE_CQL, { fileId });
    const summary = result?.summary?.counters.updates();
    await tx.commit();
    return {
      nodesDeleted: summary?.nodesDeleted || 0,
      relationshipsDeleted: summary?.relationshipsDeleted || 0,
    };
  } catch (error) {
    logger?.error(error);
    tx.rollback();
    if (error instanceof GraphQLError) {
      throw error;
    }
    throw new GraphQLError(
      "An unexpected error occurred while deleting the File.",
      {
        extensions: {
          code: ApolloServerErrorCode.INTERNAL_SERVER_ERROR,
        },
      }
    );
  } finally {
    session.close();
  }
};

const deleteFlowNode = async (
  _source: Record<string, any>,
  { flowNodeId }: { flowNodeId: string },
  _context: Record<string, any>
) => {
  const session = (await Neo4JConnection.getInstance()).driver.session();
  const tx = session.beginTransaction();
  try {
    const result = await tx.run(DELETE_FLOWNODE_CQL, { nodeId: flowNodeId });
    const summary = result.summary?.counters.updates();
    await tx.commit();
    return {
      nodesDeleted: summary?.nodesDeleted || 0,
      relationshipsDeleted: summary?.relationshipsDeleted || 0,
    };
  } catch (error) {
    logger?.error(error);
    tx.rollback();
    if (error instanceof GraphQLError) {
      throw error;
    }
    throw new GraphQLError(
      "An unexpected error occurred while deleting the Node",
      {
        extensions: {
          code: ApolloServerErrorCode.INTERNAL_SERVER_ERROR,
        },
      }
    );
  } finally {
    session.close();
  }
};

const deleteBacklogItem = async (
  _source: Record<string, any>,
  { itemId }: { itemId: string },
  _context: Record<string, any>
) => {
  const session = (await Neo4JConnection.getInstance()).driver.session();
  const tx = session.beginTransaction();
  try {
    const result = await tx.run(DELETE_BACKLOG_CQL, { itemId });
    const summary = result.summary?.counters.updates();
    await tx.commit();
    return {
      nodesDeleted: summary?.nodesDeleted || 0,
      relationshipsDeleted: summary?.relationshipsDeleted || 0,
    };
  } catch (error) {
    logger?.error(error);
    tx.rollback();
    if (error instanceof GraphQLError) {
      throw error;
    }
    throw new GraphQLError(
      "An unexpected error occurred while deleting the BacklogItem",
      {
        extensions: {
          code: ApolloServerErrorCode.INTERNAL_SERVER_ERROR,
        },
      }
    );
  }
};

const emptyRecycleBin = async (
  _source: Record<string, any>,
  _parent: Record<string, any>,
  _context: Record<string, any>
) => {
  const currentUserId = _context?.jwt?.sub;
  const ogm = await OGMConnection.getInstance();
  const UserModel = ogm.model("User");
  const session = (await Neo4JConnection.getInstance()).driver.session();

  const models = [
    "Folder",
    "File",
    "BacklogItem",
    "FlowNode",
    "Sprint",
    "Project",
  ];

  let totalNodesDeleted = 0;
  let totalRelationshipsDeleted = 0;
  try {
    const [currentUser] = await UserModel.find<User[]>({
      where: { externalId: currentUserId },
      selectionSet: `{ id role externalId ownedOrganization { id } memberOfOrganizations { id } }`,
    });
    const allowedRoles = [UserRole.CompanyAdmin, UserRole.SystemAdmin];
    if (!allowedRoles.includes(currentUser?.role as UserRole)) {
      throw new GraphQLError("Unauthorized access. Insufficient permissions.", {
        extensions: {
          code: ApolloServerErrorCode.GRAPHQL_VALIDATION_FAILED,
        },
      });
    }
    for (const modelName of models) {
      const Model = ogm.model(modelName);

      if (!currentUser) {
        throw new GraphQLError("Current user not found.", {
          extensions: {
            code: ApolloServerErrorCode.INTERNAL_SERVER_ERROR,
          },
        });
      }

      const whereClause = {
        NOT: { deletedAt: null },
        ...getModelWhereClause(modelName, currentUser),
      };

      const result = await Model.delete({
        where: whereClause,
        context: _context,
      });
      totalNodesDeleted += result?.nodesDeleted || 0;
      totalRelationshipsDeleted += result?.relationshipsDeleted || 0;
    }

    logger?.info("Recycle bin emptied successfully by admin", {
      nodesDeleted: totalNodesDeleted,
      relationshipsDeleted: totalRelationshipsDeleted,
    });

    return {
      nodesDeleted: totalNodesDeleted,
      relationshipsDeleted: totalRelationshipsDeleted,
    };
  } catch (error) {
    logger?.error("Error while emptying recycle bin", error);
    if (error instanceof GraphQLError) throw error;
    throw new GraphQLError(
      "An unexpected error occurred while emptying the recycle bin.",
      {
        extensions: {
          code: ApolloServerErrorCode.INTERNAL_SERVER_ERROR,
        },
      }
    );
  } finally {
    await session.close();
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
  const session = (await Neo4JConnection.getInstance()).driver.session();
  const tx = session.beginTransaction();
  const userRole = _context?.jwt?.roles[0];
  if (userRole !== UserRole.SystemAdmin) {
    throw new GraphQLError("UNAUTHORIZED", {
      extensions: {
        code: ApolloServerErrorCode.BAD_REQUEST,
      },
    });
  }

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
    const uids =
      result.records && result.records[0] ? result.records[0].get("uids") : [];
    await getFirebaseAdminAuth().auth().deleteUsers(uids);
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
    return true;
  } catch (error) {
    await tx.rollback();
    logger?.error(error);
    throw new GraphQLError("An unexpected error occurred while Deleting Org.", {
      extensions: {
        code: ApolloServerErrorCode.INTERNAL_SERVER_ERROR,
      },
    });
  } finally {
    session.close();
  }
};

export const deleteOperationMutations = {
  deleteUser,
  disableUser,
  deleteFolder,
  deleteFile,
  deleteFlowNode,
  deleteBacklogItem,
  emptyRecycleBin,
  deleteFirebaseUser,
  deleteOrg,
};
