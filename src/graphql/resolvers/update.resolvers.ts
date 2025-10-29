import { GraphQLError } from "graphql";
import { Neo4JConnection } from "../../database/connection";
import logger from "../../logger";
import { OGMConnection } from "../init/ogm.init";
import { User } from "../../@types/ogm.types";
import { ApolloServerErrorCode } from "@apollo/server/errors";
import { getFirebaseAdminAuth } from "../firebase/admin";

const updateUserRole = async (
  _source: Record<string, any>,
  { userId, role }: Record<string, any>,
  _context: Record<string, any>
) => {
  const session = (await Neo4JConnection.getInstance()).driver.session();

  try {
    const tx = session.beginTransaction();

    // Attempt to update the user's role only if they are part of an organization created by the current user
    const result = await tx.run(
      `
      MATCH (user:User {id: $userId})-[:MEMBER_OF]->(org)<-[:OWNS]-(creator:User {externalId: $externalId})
      SET user.role = $role
      RETURN user.id AS userId, user.role AS updatedRole
    `,
      {
        userId: userId,
        role: role,
        externalId: _context.jwt.sub,
      }
    );

    if (result.records.length === 0) {
      await tx.rollback();
      throw new Error("User not found or not authorized to update role.");
    }

    if (result.records[0] && result.records[0].get("updatedRole") === role) {
      await tx.commit();
      logger?.info("Role updated successfully.");
      return true;
    } else {
      await tx.rollback();
      return false;
    }
  } catch (error) {
    logger?.error("Transaction failed: ", error);
    throw error;
  } finally {
    await session.close();
  }
};

const updateUserDetail = async (
  _source: Record<string, any>,
  { name, phoneNumber }: Record<string, any>,
  _context: Record<string, any>
): Promise<User[]> => {
  const User = (await OGMConnection.getInstance()).model("User");
  const externalId = _context?.jwt?.sub;

  if (!externalId) {
    throw new GraphQLError("Unauthenticated.", {
      extensions: { code: "UNAUTHENTICATED" },
    });
  }

  const auth = getFirebaseAdminAuth().auth();

  try {
    const currentUser = await auth.getUser(externalId);
    logger?.info(`Fetched Firebase user: ${externalId}`);

    // --- sanitize phone number ---
    const cleanedPhone = phoneNumber?.replace(/[^\d+]/g, "") ?? null;
    if (cleanedPhone && !/^\+\d{7,15}$/.test(cleanedPhone)) {
      throw new GraphQLError(
        "Invalid phone format. Must be E.164 like +14155552671",
        {
          extensions: { code: "BAD_USER_INPUT" },
        }
      );
    }

    const payload: Record<string, any> = {};

    // --- detect changes ---
    if (name && name !== currentUser.displayName) {
      payload.displayName = name;
    }
    if (cleanedPhone && cleanedPhone !== currentUser.phoneNumber) {
      payload.phoneNumber = cleanedPhone;
    }
    console.log(payload,"Hello")

    // --- update Firebase if anything changed ---
    if (Object.keys(payload).length > 0) {
      try {
        await auth.updateUser(externalId, payload);
        logger?.info(
          `Firebase user updated: uid=${externalId}, changes=${JSON.stringify(
            payload
          )}`
        );
      } catch (error: any) {
        if (error.code === "auth/phone-number-already-exists") {
          logger?.warn(
            `Phone number already in use. Skipping phone update for uid=${externalId}`
          );
          // only update name in that case
          if (payload.displayName) {
            await auth.updateUser(externalId, {
              displayName: payload.displayName,
            });
            logger?.info(`Firebase display name updated for uid=${externalId}`);
          }
        } else {
          logger?.error(
            `Firebase update failed for uid=${externalId}: ${
              error.code || error.message
            }`
          );
          throw error;
        }
      }
    } else {
      logger?.info(`No Firebase changes for uid=${externalId}`);
    }

    // --- update Neo4j DB ---
    const result = await User.update<{ users: User[] }>({
      where: { externalId },
      update: {
        ...(name && { name }),
        ...(cleanedPhone && { phoneNumber: cleanedPhone }),
      },
      context: _context,
    });

    const updatedUser = result?.users?.[0];
    if (!updatedUser) {
      throw new GraphQLError("User not found in database.", {
        extensions: { code: "FORBIDDEN" },
      });
    }

    logger?.info(
      `User detail updated in Neo4j for uid=${externalId}, name=${updatedUser.name}, phone=${updatedUser.phoneNumber}`
    );

    return [updatedUser];
  } catch (err: any) {
    const logMsg =
      err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    logger?.error(
      `Failed to update user detail for uid=${externalId}: ${logMsg}`
    );

    throw new GraphQLError(err?.message || "Unexpected server error.", {
      originalError: err instanceof Error ? err : undefined,
      extensions: {
        code:
          err instanceof GraphQLError
            ? err.extensions?.code
            : ApolloServerErrorCode.INTERNAL_SERVER_ERROR,
        ...(typeof err?.code === "string" && { firebaseCode: err.code }),
        detail: logMsg,
      },
    });
  }
};

const updatePhoneNumber = async (
  _source: Record<string, any>,
  { phoneNumber }: Record<string, any>,
  _context: Record<string, any>
): Promise<Boolean> => {
  const User = (await OGMConnection.getInstance()).model("User");
  const externalId = _context?.jwt?.sub;

  try {
    await getFirebaseAdminAuth().auth().updateUser(externalId, {
      phoneNumber,
    });
    const result = await User.update<{ users: User[] }>({
      where: {
        externalId,
      },
      update: {
        phoneNumber,
      },
      context: _context,
    });

    const updated = result?.users;
    if (!updated[0]) {
      throw new GraphQLError("User not found.", {
        extensions: { code: "FORBIDDEN" },
      });
    }

    logger?.info(
      `phoneNumber updated for uid=${externalId}, user=${updated[0]?.email}`
    );
    return true;
  } catch (error) {
    logger?.error(
      `Failed to update phoneNumber for uid=${externalId}: ${error}`
    );
    if (error instanceof GraphQLError) throw error;
    throw new GraphQLError("Failed to update phoneNumber.", {
      extensions: { code: ApolloServerErrorCode.INTERNAL_SERVER_ERROR },
    });
  }
};

export const updateOperationMutations = {
  updateUserRole,
  updateUserDetail,
  updatePhoneNumber,
};
