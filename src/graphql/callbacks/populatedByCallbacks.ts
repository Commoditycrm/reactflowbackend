import { Neo4jGraphQLCallback } from "@neo4j/graphql";
import { Neo4JConnection } from "../../database/connection";
import logger from "../../logger";
import { UserRole } from "../../@types/ogm.types";
import { DateTime } from "neo4j-driver";
import { toEpochMs } from "../../util/minutesBetweens";
import { GraphQLError } from "graphql";
import { ApolloServerErrorCode } from "@apollo/server/errors";

export const externalIdExtractor = (
  _parent: Record<string, any>,
  _args: Record<string, any>,
  _context: Record<string, any>
) => {
  return _context?.authorization?.jwt?.sub as string;
};

export const userNameExtractor = (
  _parent: Record<string, any>,
  _args: Record<string, any>,
  _context: Record<string, any>
) => {
  return _context?.authorization?.jwt?.name;
};

export const phoneNumberExtractor = (
  _parent: Record<string, any>,
  _args: Record<string, any>,
  _context: Record<string, any>
) => {
  return _context?.authorization?.jwt?.phone_number;
};

export const emailExtractor = (
  _parent: Record<string, any>,
  _args: Record<string, any>,
  _context: Record<string, any>
) => {
  return _context?.authorization?.jwt?.email as string;
};

export const counterStarter = (
  _parent: Record<string, any>,
  _args: Record<string, any>,
  _context: Record<string, any>
) => {
  return 0;
};

export const userRoleSetter = (
  _parent: Record<string, any>,
  _args: Record<string, any>,
  _context: Record<string, any>
) => {
  const userRole = _context?.jwt?.roles[0];
  if (_parent?.ownedOrganization?.create) {
    return userRole === UserRole.SystemAdmin ? userRole : UserRole.CompanyAdmin;
  }
  return UserRole.SuperUser;
};

export const topLevelParentItem: Neo4jGraphQLCallback = (
  _parent: Record<string, any>,
  _args: Record<string, any>,
  _context: Record<string, any>
) => {
  if (_parent?.parent?.Folder || _parent?.parent?.FlowNode) {
    return true;
  }
  return false;
};

export const uniqueSprint = (
  _parent: Record<string, any>,
  _args: Record<string, any>,
  _context: Record<string, any>
) => {
  const projectId = _parent?.project?.connect?.where?.node?.id;
  return `${projectId}-${_parent?.name.trim()}`;
};

export const uniqueInviteExtractor = (
  _parent: Record<string, any>,
  _args: Record<string, any>,
  _context: Record<string, any>
) => {
  const orgId = _parent?.organization?.connect?.where?.node?.id;
  const userEmail = _parent?.email.trim();
  return `${orgId}-${userEmail}`;
};

export const uniqueProjectExtractor = async (
  _parent: Record<string, any>,
  _args: Record<string, any>,
  _context: Record<string, any>
) => {
  let orgId = _parent?.organization?.connect?.where?.node?.id;
  const projectName = _parent?.name?.trim().toLowerCase().replace(/\s+/g, "");
  const externalId = _context?.jwt?.uid;
  if (!orgId) {
    const session = (await Neo4JConnection.getInstance()).driver.session();
    try {
      const res = await session.executeRead((tx) =>
        tx.run(
          "MATCH(:User {externalId:$uid})-[:OWNS|MEMBER_OF]->(org:Organization) RETURN org.id AS orgId",
          {
            uid: externalId,
          }
        )
      );
      orgId = res.records[0]?.get("orgId");
    } catch (error) {
      logger?.error(`Field to get orgId:${error}`);
    } finally {
      await session.close();
    }
  }

  return `${orgId}-${projectName}`;
};

export const updateOrgLastModified = async (
  _parent: Record<string, any>,
  _args: Record<string, any>,
  context: Record<string, any>
) => {
  const userId = context?.jwt?.sub;
  const session = (await Neo4JConnection.getInstance()).driver.session();
  try {
    const tx = session.beginTransaction();
    await tx.run(
      `
      MATCH (u:User {externalId: $userId})-[:MEMBER_OF|OWNS]->(org:Organization)
      SET org.lastModified = datetime()
      RETURN org
      `,
      { userId }
    );
    await tx.commit();
    return true;
  } catch (error) {
    logger?.error("Error updating Organization.lastModified:", error);
    return false;
  } finally {
    await session.close();
  }
};

export const defaultKeySetter = (
  _parent: Record<string, any>,
  _args: Record<string, any>,
  _context: Record<string, any>
) => {
  if (_parent?.organization?.connect?.where?.node?.id) {
    return false;
  }
  return true;
};

export const defaultNameSetter = (
  _parent: Record<string, any>,
  _args: Record<string, any>,
  _context: Record<string, any>
) => {
  const name = _parent?.name;
  return name;
};

export const uniqueKeySetter = (
  _parent: Record<string, any>,
  _args: Record<string, any>,
  _context: Record<string, any>
) => {
  const orgId = _parent?.organization?.connect?.where?.node?.id;
  const name = String(_parent?.name || "")
    .replace(/\s+/g, "")
    .toLowerCase();
  return `${orgId}-${name}`;
};

export const messageCounterSetter = (
  _parent: Record<string, any>,
  _args: Record<string, any>,
  _context: Record<string, any>
) => {
  return 0;
};

export const uniqueEventExtractor = async (
  _parent: Record<string, any>,
  _args: Record<string, any>,
  _context: Record<string, any>
) => {
  const externalId = _context?.jwt?.uid;
  const startDate: DateTime = _parent?.startDate || _args?.startDate;
  const endDate: DateTime = _parent?.endDate || _args?.endDate;

  let resourceId = _parent?.resource?.connect?.where?.node?.id || null;

  const s = toEpochMs(startDate);
  const e = toEpochMs(endDate);

  const session = (await Neo4JConnection.getInstance()).driver.session();
  try {
    if (resourceId) {
      const res = await session.executeRead((tx) =>
        tx.run(
          `
          MATCH (r:Asset {id:$resourceId})<-[:HAS_RESOURCE]-(e:CalenderEvent)
          WHERE datetime({epochMillis: toInteger($startMs)}) < e.endDate
          AND datetime({epochMillis: toInteger($endMs)})   > e.startDate
          RETURN 1 LIMIT 1

          `,
          { resourceId, startMs: s, endMs: e }
        )
      );
      if (res.records.length > 0) {
        throw new GraphQLError(
          "An event already exists in the selected time range. Please choose a different duration.",
          {
            extensions: {
              code: ApolloServerErrorCode.INTERNAL_SERVER_ERROR,
            },
          }
        );
      }
      return `RES#${resourceId}#${s}#${e}`;
    } else {
      const orgRes = await session.run(
        `
        MATCH (:User {externalId:$uid})-[:OWNS|MEMBER_OF]->(org:Organization)
        RETURN org.id AS orgId
        LIMIT 1
        `,
        { uid: externalId }
      );
      const orgId = orgRes.records[0]?.get("orgId") || "NOORG";
      return `ORG#${orgId}#${s}#${e}`;
    }
  } catch (error) {
    logger?.error(`Error while setting unique event: ${error}`);
    throw error;
  } finally {
    await session.close();
  }
};

export const resourceNameSetter = (
  _parent: Record<string, any>,
  _args: Record<string, any>,
  _context: Record<string, any>
) => {
  const { firstName, lastName, middleName } = _parent;
  return middleName
    ? `${firstName} ${middleName} ${lastName}`
    : `${firstName} ${lastName}`;
};
