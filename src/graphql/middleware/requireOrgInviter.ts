import { Request, Response, NextFunction } from "express";
import { NeoConnection } from "../init/neo.init";
import { Neo4JConnection } from "../../database/connection";
import logger from "../../logger";

// Only the org owner or an admin member may invite. Without this the invite
// endpoint was open to anyone (spam + user-existence probing).
export const requireOrgInviter = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  let jwt: Record<string, any>;
  try {
    // same session check the graphql layer uses
    ({ jwt } = await NeoConnection.authorizeUserOnContext(req));
  } catch {
    res.status(401).json({ message: "Authentication required." });
    return;
  }

  const externalId = jwt?.sub || jwt?.uid;
  // real session users only, not invite/warmup tokens
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
