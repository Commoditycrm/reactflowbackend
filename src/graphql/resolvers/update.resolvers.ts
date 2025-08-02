import { GraphQLError } from "graphql";
import { Neo4JConnection } from "../../database/connection";
import {
  GET_PARENT_FOLDER_FOR_BACKLOGS_CQL,
  GET_PARENT_FOLDER_FOR_FOLDER_CQL,
} from "../../database/constants";
import logger from "../../logger";
import { OGMConnection } from "../init/ogm.init";
import { UserRole } from "../../@types/ogm.types";

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

export const updateOperationMutations = {
  updateUserRole,
  assignUserToProject,
  assignUserToBacklogItem,
};
