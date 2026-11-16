/**
 * Cypher for Split & Explain. Permission checks mirror the @authorization
 * rules on File: creating needs the org owner or an ADMIN / SUPER_USER member;
 * reading also allows the project's creator and assigned users and
 * COMPANY_ADMIN members.
 */

const EDIT_RULE = `
  $isSystemAdmin
  OR (u)-[:OWNS]->(org)
  OR ((u)-[:MEMBER_OF]->(org) AND u.role IN ["ADMIN", "SUPER_USER"])
`;

const READ_RULE = `
  ${EDIT_RULE}
  OR ((u)-[:MEMBER_OF]->(org) AND u.role = "COMPANY_ADMIN")
  OR (u)-[:CREATED_PROJECT]->(p)
  OR (p)-[:HAS_ASSIGNED_USER]->(u)
`;

export const CAN_EDIT_PROJECT_CQL = `
MATCH (u:User {externalId: $sub})
MATCH (org:Organization)-[:HAS_PROJECTS]->(p:Project {id: $projectId})
WHERE p.deletedAt IS NULL AND (${EDIT_RULE})
RETURN p.id AS projectId, org.id AS orgId
LIMIT 1
`;

/** Finds a live robot's project if the user may read (or, with $edit, edit) it. */
export const ROBOT_ACCESS_CQL = `
MATCH (u:User {externalId: $sub})
MATCH (org:Organization)-[:HAS_PROJECTS]->(p:Project)-[:HAS_ROBOT]->(r:Robot {id: $robotId})
WHERE r.deletedAt IS NULL AND p.deletedAt IS NULL
  AND (
    ($edit AND (${EDIT_RULE}))
    OR (NOT $edit AND (${READ_RULE}))
  )
RETURN r.id AS robotId, r.name AS robotName, p.id AS projectId, org.id AS orgId
LIMIT 1
`;

export const GROUP_ACCESS_CQL = `
MATCH (u:User {externalId: $sub})
MATCH (org:Organization)-[:HAS_PROJECTS]->(p:Project)-[:HAS_ROBOT]->(r:Robot)-[:HAS_PART_GROUP]->(g:RobotPartGroup {id: $groupId})
WHERE r.deletedAt IS NULL AND p.deletedAt IS NULL AND (${READ_RULE})
RETURN g.id AS groupId, r.id AS robotId
LIMIT 1
`;

export const ORG_ADMIN_CQL = `
MATCH (u:User {externalId: $sub})
MATCH (org:Organization)
WHERE ((u)-[:OWNS]->(org) OR ((u)-[:MEMBER_OF]->(org) AND u.role IN ["ADMIN", "SUPER_USER"]))
  AND org.deletedAt IS NULL
RETURN org.id AS orgId
LIMIT 1
`;

export const CREATE_BUILD_FLOW_FILE_CQL = `
MATCH (u:User {externalId: $sub})
MATCH (p:Project {id: $projectId})
CREATE (f:File {id: $fileId, name: $name, createdAt: datetime()})
CREATE (p)-[:HAS_CHILD_FILE]->(f)
CREATE (u)-[:CREATED_FILE]->(f)
RETURN f.id AS fileId
`;

/** Tasks in the same group run in order; a child group's assembly waits for its parent's. */
export const LINK_TASK_DEPENDENCIES_CQL = `
UNWIND $links AS link
MATCH (a:BacklogItem {id: link.before})
MATCH (b:BacklogItem {id: link.after})
MERGE (a)-[:PREDECESSOR]->(b)
RETURN count(*) AS linked
`;

export const CREATE_ROBOT_CQL = `
MATCH (u:User {externalId: $sub})
MATCH (p:Project {id: $projectId})
MATCH (f:File {id: $fileId})
CREATE (r:Robot {
  id: $robotId,
  name: $name,
  license: $license,
  attribution: $attribution,
  sourceUrl: $sourceUrl,
  approxSize: $approxSize,
  createdAt: datetime()
})
CREATE (p)-[:HAS_ROBOT]->(r)
CREATE (u)-[:CREATED_ROBOT]->(r)
CREATE (r)-[:HAS_BUILD_FLOW]->(f)
WITH r
UNWIND $groups AS gi
CREATE (g:RobotPartGroup {
  id: gi.id,
  key: gi.key,
  name: gi.name,
  qty: gi.qty,
  category: gi.category,
  order: gi.order,
  motors: gi.motors
})
CREATE (r)-[:HAS_PART_GROUP]->(g)
WITH r, g, gi
OPTIONAL MATCH (n:FlowNode {id: gi.flowNodeId})
FOREACH (_ IN CASE WHEN n IS NULL THEN [] ELSE [1] END | CREATE (g)-[:PART_GROUP_NODE]->(n))
WITH r, collect(g) AS groups
UNWIND $parts AS pi
MATCH (g:RobotPartGroup {id: pi.groupId})
CREATE (pt:RobotPart {
  id: pi.id,
  linkName: pi.linkName,
  side: pi.side,
  meshUrl: pi.meshUrl,
  meshFile: pi.meshFile,
  matrix: pi.matrix,
  scale: pi.scale,
  color: pi.color,
  explode: pi.explode,
  depth: pi.depth
})
CREATE (g)-[:HAS_PART]->(pt)
RETURN count(pt) AS parts
`;

export const LOAD_GROUPS_FOR_AI_CQL = `
MATCH (r:Robot {id: $robotId})-[:HAS_PART_GROUP]->(g:RobotPartGroup)
WHERE size($groupIds) = 0 OR g.id IN $groupIds
OPTIONAL MATCH (g)-[:HAS_PART]->(pt:RobotPart)
OPTIONAL MATCH (g)-[:HAS_EXPLANATION]->(e:PartExplanation)
OPTIONAL MATCH (g)-[:PART_GROUP_NODE]->(n:FlowNode)
OPTIONAL MATCH (n)-[:HAS_COMMENT]->(c:Comment)
WITH r, g, e,
     collect(DISTINCT pt.linkName) AS links,
     collect(DISTINCT left(coalesce(c.message, ""), 400))[0..5] AS comments
RETURN g.id AS id, g.key AS key, g.name AS name, g.qty AS qty, g.category AS category,
       g.motors AS motors, links, comments, e.status AS explanationStatus
ORDER BY g.order
`;

export const LOAD_COMPONENT_SPECS_CQL = `
MATCH (org:Organization {id: $orgId})-[:HAS_COMPONENT_SPEC]->(c:ComponentSpec)
WHERE c.model IN $models
RETURN c.model AS model, c.kind AS kind, c.specsJson AS specsJson, c.sources AS sources
`;

export const WRITE_EXPLANATIONS_CQL = `
UNWIND $items AS it
MATCH (g:RobotPartGroup {id: it.groupId})
OPTIONAL MATCH (g)-[:HAS_EXPLANATION]->(old:PartExplanation)
WITH g, it, old
WHERE old IS NULL OR $overwriteConfirmed OR old.status <> "CONFIRMED"
CALL {
  WITH old
  WITH old WHERE old IS NOT NULL
  DETACH DELETE old
}
CREATE (e:PartExplanation {
  id: randomUUID(),
  what: it.what,
  why: it.why,
  madeOf: it.madeOf,
  openQuestions: it.openQuestions,
  source: "AI",
  status: "DRAFT",
  updatedAt: datetime()
})
CREATE (g)-[:HAS_EXPLANATION]->(e)
RETURN count(e) AS written
`;

export const UPDATE_EXPLANATION_CQL = `
MATCH (u:User {externalId: $sub})
MATCH (g:RobotPartGroup {id: $groupId})
OPTIONAL MATCH (g)-[:HAS_EXPLANATION]->(existing:PartExplanation)
CALL {
  WITH g, existing
  WITH g, existing WHERE existing IS NULL
  CREATE (n:PartExplanation {
    id: randomUUID(), what: "", why: "", madeOf: [], openQuestions: [],
    source: "HUMAN", status: "DRAFT", updatedAt: datetime()
  })
  CREATE (g)-[:HAS_EXPLANATION]->(n)
  RETURN n AS created
  UNION
  WITH g, existing
  WITH existing WHERE existing IS NOT NULL
  RETURN existing AS created
}
WITH u, created AS e
SET e.what = coalesce($what, e.what),
    e.why = coalesce($why, e.why),
    e.madeOf = coalesce($madeOf, e.madeOf),
    e.source = CASE WHEN $edited THEN "HUMAN" ELSE e.source END,
    e.status = CASE WHEN $confirm THEN "CONFIRMED" WHEN $edited THEN "DRAFT" ELSE e.status END,
    e.confirmedAt = CASE WHEN $confirm THEN datetime() WHEN $edited THEN null ELSE e.confirmedAt END,
    e.updatedAt = datetime()
WITH u, e
CALL {
  WITH u, e
  WITH u, e WHERE $confirm OR $edited
  OPTIONAL MATCH (:User)-[old:CONFIRMED_EXPLANATION]->(e)
  DELETE old
  WITH u, e
  WITH u, e WHERE $confirm
  CREATE (u)-[:CONFIRMED_EXPLANATION]->(e)
}
RETURN e.id AS id
`;

export const SOFT_DELETE_ROBOT_CQL = `
MATCH (r:Robot {id: $robotId})
SET r.deletedAt = datetime()
RETURN r.id AS id
`;

export const UPSERT_COMPONENT_SPEC_CQL = `
MATCH (org:Organization {id: $orgId})
OPTIONAL MATCH (org)-[:HAS_COMPONENT_SPEC]->(existing:ComponentSpec {model: $model})
CALL {
  WITH org, existing
  WITH org, existing WHERE existing IS NULL
  CREATE (c:ComponentSpec {id: randomUUID(), model: $model})
  CREATE (org)-[:HAS_COMPONENT_SPEC]->(c)
  RETURN c
  UNION
  WITH org, existing
  WITH existing WHERE existing IS NOT NULL
  RETURN existing AS c
}
SET c.kind = $kind, c.specsJson = $specsJson, c.sources = $sources, c.verifiedAt = datetime()
WITH org, c
// Confirmed explanations that rely on this component need a fresh look.
CALL {
  WITH org, c
  MATCH (org)-[:HAS_PROJECTS]->(:Project)-[:HAS_ROBOT]->(:Robot)-[:HAS_PART_GROUP]->(g:RobotPartGroup)-[:HAS_EXPLANATION]->(e:PartExplanation {status: "CONFIRMED"})
  WHERE any(m IN g.motors WHERE m ENDS WITH ("|" + c.model))
  SET e.status = "STALE"
  RETURN count(e) AS staled
}
RETURN c.id AS id
`;
