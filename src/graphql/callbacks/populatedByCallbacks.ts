import { Neo4jGraphQLCallback } from "@neo4j/graphql";
import { Neo4JConnection } from "../../database/connection";
import logger from "../../logger";
import { UserRole } from "../../@types/ogm.types";

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

export const setinvitedUserEmails = async (
  _parent: Record<string, any>,
  _args: Record<string, any>,
  _context: Record<string, any>
) => {
  return [];
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

export const uniqueProjectExtractor = (
  _parent: Record<string, any>,
  _args: Record<string, any>,
  _context: Record<string, any>
) => {
  const orgId = _parent?.organization?.connect?.where?.node?.id;
  const projectName = _parent?.name?.trim().toLowerCase();
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
