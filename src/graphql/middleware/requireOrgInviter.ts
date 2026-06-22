import { Request, Response, NextFunction } from "express";
import { NeoConnection } from "../init/neo.init";
import { Neo4JConnection } from "../../database/connection";
import logger from "../../logger";

/**
 * Authenticates the caller's session and authorizes them to invite to the
 * organization named in the request body (`orgId`). The caller must OWN the org
 * or be an ADMIN-level member of it. This mirrors the GraphQL `createInvites`
 * authorization so the REST invite endpoints can no longer be hit anonymously
 * (which previously allowed invite-spam and a user-existence enumeration oracle).
 */
export const requireOrgInviter = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  let jwt: Record<string, any>;
  try {
    // Reuses the same session verification (cookie/redis) the GraphQL layer uses.
    ({ jwt } = await NeoConnection.authorizeUserOnContext(req));
  } catch {
    res.status(401).json({ message: "Authentication required." });
    return;
  }

  const externalId = jwt?.sub || jwt?.uid;
  // Only real session users may invite — reject invite tokens and warmup tokens.
  if (!externalId || jwt.role === "invitee" || jwt.warmup) {
    res.status(401).json({ message: "Authentication required." });
    return;
  }

  const orgId = req.body?.orgId;
  if (!orgId) {
    res.status(400).json({ message: "orgId is required." });
    return;
  }

  const session = (await Neo4JConnection.getInstance()).driver.session();
  try {
    const result = await session.run(
      `
      MATCH (u:User {externalId: $externalId})-[:OWNS|MEMBER_OF]->(org:Organization {id: $orgId})
      WHERE EXISTS { (u)-[:OWNS]->(org) }
         OR u.role IN ['ADMIN', 'COMPANY_ADMIN', 'SYSTEM_ADMIN']
      RETURN org.id AS orgId
      LIMIT 1
      `,
      { externalId, orgId },
    );
    if (result.records.length === 0) {
      res
        .status(403)
        .json({ message: "Not authorized to invite to this organization." });
      return;
    }
  } catch (error) {
    logger?.error("requireOrgInviter authorization check failed", { error });
    res.status(500).json({ message: "Authorization check failed." });
    return;
  } finally {
    await session.close();
  }

  (req as any).inviter = jwt;
  next();
};
