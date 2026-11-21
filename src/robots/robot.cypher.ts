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

/** A live folder anywhere inside the project (folders nest up to 5 deep). */
export const FOLDER_IN_PROJECT_CQL = `
MATCH (p:Project {id: $projectId})-[:HAS_CHILD_FOLDER*1..5]->(fo:Folder {id: $folderId})
WHERE fo.deletedAt IS NULL
RETURN fo.id AS folderId, fo.name AS name
LIMIT 1
`;

/** Same as CREATE_BUILD_FLOW_FILE_CQL, but the file goes inside a folder of the project. */
export const CREATE_FLOW_FILE_IN_FOLDER_CQL = `
MATCH (u:User {externalId: $sub})
MATCH (p:Project {id: $projectId})-[:HAS_CHILD_FOLDER*1..5]->(fo:Folder {id: $folderId})
WHERE fo.deletedAt IS NULL
WITH u, fo LIMIT 1
CREATE (f:File {id: $fileId, name: $name, createdAt: datetime()})
CREATE (fo)-[:HAS_CHILD_FILE]->(f)
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
  qty: toInteger(gi.qty),
  category: gi.category,
  order: toInteger(gi.order),
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
  meshFormat: pi.meshFormat,
  meshNode: pi.meshNode,
  motors: pi.motors,
  matrix: pi.matrix,
  scale: pi.scale,
  color: pi.color,
  explode: pi.explode,
  depth: toInteger(pi.depth)
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

// ---------------------------------------------------------------------------
// Supply
// ---------------------------------------------------------------------------

/** Motors needed per model by every live robot in the org, with whether the user can see each project. */
export const ORG_MOTOR_DEMAND_CQL = `
MATCH (u:User {externalId: $sub})
MATCH (org:Organization {id: $orgId})-[:HAS_PROJECTS]->(p:Project)-[:HAS_ROBOT]->(r:Robot)-[:HAS_PART_GROUP]->(g:RobotPartGroup)
WHERE r.deletedAt IS NULL AND p.deletedAt IS NULL
UNWIND g.motors AS m
WITH u, org, p, r, g, trim(coalesce(split(m, "|")[1], "")) AS model
WHERE model <> ""
WITH u, org, p, r, g, model, count(*) AS n
RETURN r.id AS robotId, r.name AS robotName, p.id AS projectId, p.name AS projectName,
       g.id AS groupId, model, n,
       (
         $isSystemAdmin
         OR EXISTS { (u)-[:OWNS]->(org) }
         OR (EXISTS { (u)-[:MEMBER_OF]->(org) } AND u.role IN ["ADMIN", "SUPER_USER", "COMPANY_ADMIN"])
         OR EXISTS { (u)-[:CREATED_PROJECT]->(p) }
         OR EXISTS { (p)-[:HAS_ASSIGNED_USER]->(u) }
       ) AS readable
`;

export const ROBOT_UNKNOWN_MOTORS_CQL = `
MATCH (r:Robot {id: $robotId})-[:HAS_PART_GROUP]->(g:RobotPartGroup)
UNWIND g.motors AS m
WITH m WHERE trim(coalesce(split(m, "|")[1], "")) = ""
RETURN count(*) AS unknown
`;

/** Asset units whose model number matches one of the models (case-insensitive). */
export const ORG_STOCK_CQL = `
MATCH (org:Organization {id: $orgId})-[:HAS_RESOURCE]->(a:Asset)
WHERE a.deletedAt IS NULL AND a.modelNumber IS NOT NULL
  AND toUpper(trim(a.modelNumber)) IN $modelKeys
OPTIONAL MATCH (proj:Project)-[:HAS_RESOURCE]->(a)
WHERE proj.deletedAt IS NULL
RETURN a.id AS assetId, a.modelNumber AS model, collect(DISTINCT proj.id) AS projectIds
`;

// ---------------------------------------------------------------------------
// Editing part groups
// ---------------------------------------------------------------------------

const FLOW_NODE_LABEL = `toString(g.order + 1) + ". " + g.name + CASE WHEN g.qty > 1 THEN " ×" + toString(g.qty) ELSE "" END`;

export const ROBOT_OF_GROUP_CQL = `
MATCH (r:Robot)-[:HAS_PART_GROUP]->(:RobotPartGroup {id: $groupId})
RETURN r.id AS robotId
LIMIT 1
`;

export const RENAME_GROUP_CQL = `
MATCH (:Robot {id: $robotId})-[:HAS_PART_GROUP]->(g:RobotPartGroup {id: $groupId})
SET g.name = $name, g.category = coalesce($category, g.category)
WITH g
OPTIONAL MATCH (g)-[:PART_GROUP_NODE]->(n:FlowNode)
SET n.name = ${FLOW_NODE_LABEL}
RETURN g.id AS id
`;

export const LOAD_GROUPS_FOR_EDIT_CQL = `
MATCH (:Robot {id: $robotId})-[:HAS_PART_GROUP]->(g:RobotPartGroup)
WHERE g.id IN $groupIds
OPTIONAL MATCH (g)-[:PART_GROUP_NODE]->(n:FlowNode)
OPTIONAL MATCH (g)-[:HAS_PART]->(p:RobotPart)
RETURN g.id AS id, g.order AS order, n.id AS nodeId, collect(p.id) AS partIds
`;

/** Moves parts (of this robot) into the target group. */
export const MOVE_PARTS_CQL = `
MATCH (r:Robot {id: $robotId})-[:HAS_PART_GROUP]->(t:RobotPartGroup {id: $targetId})
UNWIND $partIds AS pid
MATCH (r)-[:HAS_PART_GROUP]->(src:RobotPartGroup)-[rel:HAS_PART]->(p:RobotPart {id: pid})
WHERE src <> t
DELETE rel
CREATE (t)-[:HAS_PART]->(p)
RETURN count(p) AS moved
`;

export const LINK_GROUP_NODE_CQL = `
MATCH (g:RobotPartGroup {id: $groupId})
MATCH (n:FlowNode {id: $nodeId})
MERGE (g)-[:PART_GROUP_NODE]->(n)
RETURN n.id AS id
`;

/** Moves tasks, comments and links from other flow nodes onto the target node, then deletes them. */
export const ABSORB_FLOW_NODES_CQL = `
MATCH (tn:FlowNode {id: $targetNodeId})
UNWIND $nodeIds AS nid
MATCH (other:FlowNode {id: nid})
WHERE other <> tn
CALL {
  WITH tn, other
  MATCH (other)-[r:HAS_CHILD_ITEM]->(b:BacklogItem)
  MERGE (tn)-[:HAS_CHILD_ITEM]->(b)
  DELETE r
}
CALL {
  WITH tn, other
  MATCH (other)-[r:HAS_COMMENT]->(c:Comment)
  MERGE (tn)-[:HAS_COMMENT]->(c)
  DELETE r
}
CALL {
  WITH tn, other
  MATCH (other)-[r:LINKED_TO]->(x:FlowNode)
  WHERE x <> tn AND NOT EXISTS { (tn)-[:LINKED_TO]->(x) }
  CREATE (tn)-[r2:LINKED_TO]->(x)
  SET r2 = properties(r), r2.source = tn.id
}
CALL {
  WITH tn, other
  MATCH (x:FlowNode)-[r:LINKED_TO]->(other)
  WHERE x <> tn AND NOT EXISTS { (x)-[:LINKED_TO]->(tn) }
  CREATE (x)-[r2:LINKED_TO]->(tn)
  SET r2 = properties(r)
}
DETACH DELETE other
RETURN count(*) AS absorbed
`;

export const DELETE_GROUPS_CQL = `
MATCH (:Robot {id: $robotId})-[:HAS_PART_GROUP]->(g:RobotPartGroup)
WHERE g.id IN $groupIds
OPTIONAL MATCH (g)-[:HAS_EXPLANATION]->(e:PartExplanation)
DETACH DELETE e, g
RETURN count(*) AS deleted
`;

/** Recomputes motors and quantity from the parts, flags confirmed explanations and renames flow nodes. */
export const RECOMPUTE_GROUPS_CQL = `
MATCH (g:RobotPartGroup)
WHERE g.id IN $groupIds
OPTIONAL MATCH (g)-[:HAS_PART]->(p:RobotPart)
WITH g, collect(p) AS parts
SET g.motors = reduce(acc = [], x IN parts | acc + coalesce(x.motors, [])),
    g.qty = CASE
      WHEN any(x IN parts WHERE x.side = "LEFT") AND any(x IN parts WHERE x.side = "RIGHT") THEN 2
      ELSE 1
    END
WITH g
OPTIONAL MATCH (g)-[:HAS_EXPLANATION]->(e:PartExplanation {status: "CONFIRMED"})
SET e.status = "STALE"
WITH g
OPTIONAL MATCH (g)-[:PART_GROUP_NODE]->(n:FlowNode)
SET n.name = ${FLOW_NODE_LABEL}
RETURN count(DISTINCT g) AS updated
`;

export const SET_GROUP_FIELDS_CQL = `
MATCH (:Robot {id: $robotId})-[:HAS_PART_GROUP]->(g:RobotPartGroup {id: $groupId})
SET g.name = coalesce($name, g.name), g.order = toInteger(coalesce($order, g.order))
RETURN g.id AS id
`;

/** New, empty group with its own flow node next to the source group's node. */
export const CREATE_GROUP_WITH_NODE_CQL = `
MATCH (u:User {externalId: $sub})
MATCH (r:Robot {id: $robotId})-[:HAS_PART_GROUP]->(src:RobotPartGroup {id: $sourceGroupId})
MATCH (r)-[:HAS_PART_GROUP]->(every:RobotPartGroup)
WITH u, r, src, max(every.order) AS maxOrder
CREATE (g:RobotPartGroup {
  id: $groupId, key: $key, name: $name, qty: 1, category: src.category,
  order: toInteger(maxOrder + 1), motors: []
})
CREATE (r)-[:HAS_PART_GROUP]->(g)
WITH u, r, src, g
OPTIONAL MATCH (src)-[:PART_GROUP_NODE]->(sn:FlowNode)
OPTIONAL MATCH (r)-[:HAS_BUILD_FLOW]->(f:File)
CALL {
  WITH u, g, sn, f
  WITH u, g, sn, f WHERE f IS NOT NULL
  CREATE (n:FlowNode {
    id: $nodeId,
    name: toString(g.order + 1) + ". " + g.name,
    color: coalesce(sn.color, "#ffffff"),
    shape: coalesce(sn.shape, "rectangle"),
    posX: toFloat(coalesce(sn.posX, 0.0) + 280.0),
    posY: toFloat(coalesce(sn.posY, 0.0)),
    width: toFloat(coalesce(sn.width, 200.0)),
    height: toFloat(coalesce(sn.height, 80.0)),
    description: "",
    type: coalesce(sn.type, "process"),
    textDecoration: "normal",
    createdAt: datetime()
  })
  CREATE (f)-[:HAS_FLOW_NODE]->(n)
  CREATE (u)-[:CREATED_FLOW_NODE]->(n)
  CREATE (g)-[:PART_GROUP_NODE]->(n)
  WITH sn, n
  WITH sn, n WHERE sn IS NOT NULL
  CREATE (sn)-[:LINKED_TO {
    id: randomUUID(), source: sn.id, sourceHandle: "d", targetHandle: "b",
    animated: false, label: "", color: "#b0b0b5", bidirectional: false
  }]->(n)
}
RETURN g.id AS id
`;

export const ROBOT_GROUP_PARTS_CQL = `
MATCH (:Robot {id: $robotId})-[:HAS_PART_GROUP]->(g:RobotPartGroup)
OPTIONAL MATCH (g)-[:HAS_PART]->(p:RobotPart)
RETURN g.id AS id, collect(p.id) AS partIds
`;
