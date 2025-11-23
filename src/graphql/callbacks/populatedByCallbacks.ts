import { Neo4jGraphQLCallback } from "@neo4j/graphql";
import { Neo4JConnection } from "../../database/connection";
import logger from "../../logger";
import { DateTime } from "neo4j-driver";
import { toEpochMs } from "../../util/minutesBetweens";
import { GraphQLError } from "graphql";
import { ApolloServerErrorCode } from "@apollo/server/errors";
import { UserRole } from "../../interfaces";
import { FirebaseFunctions } from "../firebase/firebaseFunctions";

const firebaseFunctions = FirebaseFunctions.getInstance();

const externalIdExtractor = (
  _parent: Record<string, any>,
  _args: Record<string, any>,
  _context: Record<string, any>
) => {
  return _context?.authorization?.jwt?.sub as string;
};

const userNameExtractor = (
  _parent: Record<string, any>,
  _args: Record<string, any>,
  _context: Record<string, any>
) => {
  return _context?.authorization?.jwt?.name;
};

const phoneNumberExtractor = (
  _parent: Record<string, any>,
  _args: Record<string, any>,
  _context: Record<string, any>
) => {
  return _context?.authorization?.jwt?.phone_number;
};

const emailExtractor = (
  _parent: Record<string, any>,
  _args: Record<string, any>,
  _context: Record<string, any>
) => {
  return _context?.authorization?.jwt?.email as string;
};

const counterStarter = (
  _parent: Record<string, any>,
  _args: Record<string, any>,
  _context: Record<string, any>
) => {
  return 0;
};

const userRoleSetter = (
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

const topLevelParentItem: Neo4jGraphQLCallback = (
  _parent: Record<string, any>,
  _args: Record<string, any>,
  _context: Record<string, any>
) => {
  if (_parent?.parent?.Folder || _parent?.parent?.FlowNode) {
    return true;
  }
  return false;
};

const uniqueSprint = (
  _parent: Record<string, any>,
  _args: Record<string, any>,
  _context: Record<string, any>
) => {
  const projectId = _parent?.project?.connect?.where?.node?.id;
  return `${projectId}-${_parent?.name.trim()}`;
};

const uniqueInviteExtractor = (
  _parent: Record<string, any>,
  _args: Record<string, any>,
  _context: Record<string, any>
) => {
  const orgId = _parent?.organization?.connect?.where?.node?.id;
  const userEmail = _parent?.email.trim();
  return `${orgId}-${userEmail}`;
};

const uniqueProjectExtractor = async (
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

const updateOrgLastModified = async (
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

const defaultKeySetter = (
  _parent: Record<string, any>,
  _args: Record<string, any>,
  _context: Record<string, any>
) => {
  if (_parent?.organization?.connect?.where?.node?.id) {
    return false;
  }
  return true;
};

const defaultNameSetter = (
  _parent: Record<string, any>,
  _args: Record<string, any>,
  _context: Record<string, any>
) => {
  const name = _parent?.name;
  return name;
};

const uniqueKeySetter = (
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

const messageCounterSetter = async (
  _parent: Record<string, any>,
  _args: Record<string, any>,
  _context: Record<string, any>
): Promise<number> => {
  const uid = _context?.jwt?.sub;
  const email = _context?.jwt?.email;

  try {
    await firebaseFunctions.setUserClaims(
      uid,
      email,
      UserRole.CompanyAdmin,
      true
    );
    logger.info(`✅ User claim set: orgCreated = true for ${email}`);
  } catch (error: any) {
    logger.error(`Error setting user claims for ${email}:`, error);
    throw new Error(
      error?.message || "Failed to set user claims. Please try again."
    );
  }
  return 0;
};

const uniqueEventExtractor = async (
  _parent: any,
  _args: any,
  _context: any
) => {
  const externalId = _context?.jwt?.uid;
  const eventId: string | null = _context?.resolveTree?.args?.where?.id ?? null;

  let startDate: DateTime | null = _parent?.startDate ?? null;
  let endDate: DateTime | null = _parent?.endDate ?? null;
  let resourceId: string | null =
    _parent?.resource?.connect?.where?.node?.id ?? null;

  const session = (await Neo4JConnection.getInstance()).driver.session();

  const backfillIfNeeded = async () => {
    if (!eventId) return;
    if (startDate && endDate && resourceId !== null) return;

    const res = await session.executeRead((tx) =>
      tx.run(
        `
      MATCH (e:CalenderEvent {id:$id})
      OPTIONAL MATCH (e)-[:HAS_RESOURCE]->(r:Asset)
      RETURN e.startDate AS startDate, e.endDate AS endDate, r.id AS resourceId
      `,
        { id: eventId }
      )
    );
    const rec = res.records[0];
    if (!rec) {
      throw new GraphQLError("Event not found.", {
        extensions: { code: ApolloServerErrorCode.BAD_USER_INPUT },
      });
    }
    startDate = startDate ?? rec.get("startDate");
    endDate = endDate ?? rec.get("endDate");
    resourceId = resourceId ?? (rec.get("resourceId") || null);
  };

  try {
    await backfillIfNeeded();

    if (!startDate || !endDate) {
      throw new GraphQLError("Start and end time are required.", {
        extensions: { code: ApolloServerErrorCode.BAD_USER_INPUT },
      });
    }

    const s = toEpochMs(startDate);
    const e = toEpochMs(endDate);

    const durationMs = e - s;
    const fiveMin = 5 * 60 * 1000;
    const tenMin = 10 * 60 * 1000;

    if (durationMs <= 0) {
      throw new GraphQLError("End time must be after start time.", {
        extensions: { code: ApolloServerErrorCode.BAD_USER_INPUT },
      });
    }
    if (durationMs === fiveMin || durationMs === tenMin) {
      throw new GraphQLError(
        "Event duration cannot be exactly 5 minutes or 10 minutes. Choose a different duration.",
        { extensions: { code: ApolloServerErrorCode.BAD_USER_INPUT } }
      );
    }

    if (resourceId) {
      const res = await session.executeRead((tx) =>
        tx.run(
          `
         MATCH (r:Asset {id:$resourceId})
         OPTIONAL MATCH (r)<-[:HAS_RESOURCE]-(other:CalenderEvent)
         WHERE ($eventId IS NULL OR other.id <> $eventId)
         AND other.startDate < datetime({epochMillis: toInteger($endMs)})
         AND other.endDate   >= datetime({epochMillis: toInteger($startMs)})
         RETURN count(other) AS conflicts
        `,
          { resourceId, startMs: s, endMs: e, eventId: eventId ?? null }
        )
      );

      const conflicts =
        res.records[0]?.get("conflicts").toNumber?.() ??
        res.records[0]?.get("conflicts");
      if (conflicts > 0) {
        throw new GraphQLError(
          "Another event already exists in the selected time range for this resource.",
          { extensions: { code: ApolloServerErrorCode.BAD_USER_INPUT } }
        );
      }

      return `RES#${resourceId}#${s}#${e}`;
    }

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
  } catch (err) {
    logger?.error(`Error while setting unique event: ${err}`);
    throw err;
  } finally {
    await session.close();
  }
};

const resourceNameSetter = (
  _parent: Record<string, any>,
  _args: Record<string, any>,
  _context: Record<string, any>
) => {
  const { firstName, lastName, middleName } = _parent;
  return middleName
    ? `${firstName} ${middleName} ${lastName}`
    : `${firstName} ${lastName}`;
};

export const populatedCallBacks = {
  counterStarter,
  emailExtractor,
  externalIdExtractor,
  userRoleSetter,
  topLevelParentItem,
  userNameExtractor,
  uniqueSprint,
  uniqueInviteExtractor,
  uniqueProjectExtractor,
  updateOrgLastModified,
  defaultKeySetter,
  uniqueKeySetter,
  defaultNameSetter,
  phoneNumberExtractor,
  messageCounterSetter,
  uniqueEventExtractor,
  resourceNameSetter,
};
