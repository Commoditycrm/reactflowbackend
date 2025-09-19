import { GraphQLError } from "graphql";
import { Neo4JConnection } from "../../database/connection";
import {
  GET_PARENT_FOLDER_FOR_BACKLOGS_CQL,
  GET_PARENT_FOLDER_FOR_FOLDER_CQL,
} from "../../database/constants";
import logger from "../../logger";
import { OGMConnection } from "../init/ogm.init";
import { User, UserRole } from "../../@types/ogm.types";
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

const isUserAssignedInParent = async (
  userId: string,
  itemId: string,
  externalId: string,
  isFolder: boolean
) => {
  const session = (await Neo4JConnection.getInstance()).driver.session();
  const vars = isFolder ? { folderId: itemId } : { backlogItemId: itemId };

  try {
    const { records } = await session.run(
      isFolder
        ? GET_PARENT_FOLDER_FOR_FOLDER_CQL
        : GET_PARENT_FOLDER_FOR_BACKLOGS_CQL,
      {
        userId,
        ...vars,
        externalId,
      }
    );

    const isUserAssigned = records[0]?.get("isUserAssigned");
    const topLevelParentId = records[0]?.get("topLevelParentId");

    return { isUserAssigned, topLevelParentId };
  } catch (e) {
    logger?.error(e);
    throw new Error("Internal Server");
  } finally {
    session.close();
  }
};

const assignUserToProject = async (
  _source: Record<string, any>,
  { proectId, userId }: Record<string, any>,
  _context: Record<string, any>
): Promise<boolean> => {
  const Project = await (await OGMConnection.getInstance()).model("Project");

  const { isUserAssigned, topLevelParentId } = await isUserAssignedInParent(
    userId,
    proectId,
    _context?.jwt?.sub,
    true
  );
  // Perform assignment logic if ownership validation passes
  if (isUserAssigned || topLevelParentId === proectId) {
    await Project.update({
      where: { id: proectId },
      update: {
        assignedUsers: [
          {
            connect: [
              {
                where: {
                  node: {
                    id: userId,
                  },
                },
              },
            ],
          },
        ],
      },
    });

    return true;
  } else {
    throw new GraphQLError("User does not have permission to assign users.");
  }
};

const assignUserToBacklogItem = async (
  _source: Record<string, any>,
  { backlogItemId, userId }: Record<string, any>,
  _context: Record<string, any>
): Promise<boolean> => {
  const BacklogItem = await (
    await OGMConnection.getInstance()
  ).model("BacklogItem");

  const { isUserAssigned } = await isUserAssignedInParent(
    userId,
    backlogItemId,
    _context?.jwt?.sub,
    false
  );

  // Perform assignment logic if ownership validation passes
  if (isUserAssigned) {
    await BacklogItem.update({
      where: { id: backlogItemId },
      disconnect: {
        assignedUser: {
          where: {
            node: {
              role_IN: [
                UserRole.CompanyAdmin,
                UserRole.SuperUser,
                UserRole.User,
              ],
            },
          },
        },
      },
      connect: {
        assignedUser: {
          where: {
            node: {
              id: userId,
            },
          },
        },
      },
    });

    return true;
  } else {
    throw new GraphQLError("User does not have permission to assign users.");
  }
};

const updateUserDetail = async (
  _source: Record<string, any>,
  { name, phoneNumber }: Record<string, any>,
  _context: Record<string, any>
): Promise<User[]> => {
  const User = (await OGMConnection.getInstance()).model("User");
  const externalId = _context?.jwt?.sub;

  try {
    const currentUser = await getFirebaseAdminAuth().auth().getUser(externalId);

    const payload: any = { displayName: name };

    if (phoneNumber && currentUser.phoneNumber !== phoneNumber) {
      payload.phoneNumber = phoneNumber;
    }

    try {
      await getFirebaseAdminAuth().auth().updateUser(externalId, payload);
    } catch (error: any) {
      if (error.code === "auth/phone-number-already-exists") {
        logger?.info(`updating username in firebase:${error.code}`);
        await getFirebaseAdminAuth().auth().updateUser(externalId, {
          displayName: name,
        });
      } else {
        throw error;
      }
    }

    const result = await User.update<{ users: User[] }>({
      where: { externalId },
      update: {
        name,
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
      `user detail updated for uid=${externalId}, user=${updated[0]?.email}`
    );
    return updated ?? [];
  } catch (err: unknown) {
    const logMsg =
      err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    logger?.error(
      `Failed to update user detail for uid=${externalId}: ${logMsg}`
    );
    if (err instanceof GraphQLError) throw err;
    const message =
      err instanceof Error
        ? err.message
        : typeof err === "string"
        ? err
        : "Unexpected server error.";

    throw new GraphQLError(message, {
      originalError: err instanceof Error ? err : undefined,
      extensions: {
        code: ApolloServerErrorCode.INTERNAL_SERVER_ERROR,
        ...(typeof (err as any)?.code === "string" && {
          firebaseCode: (err as any).code,
        }),
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
  assignUserToProject,
  assignUserToBacklogItem,
  updateUserDetail,
  updatePhoneNumber,
};
