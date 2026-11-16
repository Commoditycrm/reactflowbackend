# Split & Explain (robots)

Split a robot into its parts, explain each part, and link each part to build tasks.

## How it fits together

1. In the frontend's **Robots** tab, a user picks the robot's `.urdf`, its STL meshes and, optionally, a pypot-style motor config (`{ "motors": { "<joint>": { "type": "MX-28" } } }`). The meshes are uploaded to Firebase Storage under `robot-models/org:<orgId>/<batchId>/`.
2. `importRobotFromUrdf` (see `src/graphql/resolvers/robot.resolvers.ts`):
   - parses the URDF and plans the robot (`src/robots/urdf.ts`, `src/robots/robotPlan.ts`): part groups (left/right halves and `_motor` links merged), build order, motors per group and the explode offset of every part;
   - creates a **build-flow File** with one FlowNode per part group, linked along the joint tree (reuses `CREATE_AI_FLOWNODE_CQL`);
   - drafts procure / make / assemble / test **BacklogItems** per group (reuses `CREATE_AI_BACKLOGITEM_CQL`) and links them with `PREDECESSOR`;
   - creates `Robot`, `RobotPartGroup` and `RobotPart` nodes.
3. `generatePartExplanations` asks Claude for what / why / made-of per part group. It may only quote numbers from the org's `ComponentSpec` records; everything else becomes an open question. Drafts are `source: AI, status: DRAFT`.
4. `updatePartExplanation` lets a person edit and/or confirm. `upsertComponentSpec` (org owners/admins) records a component's specs with source links and marks confirmed explanations that use it as `STALE`.

## Graph

```
(Project)-[:HAS_ROBOT]->(Robot)-[:HAS_PART_GROUP]->(RobotPartGroup)-[:HAS_PART]->(RobotPart)
(Robot)-[:HAS_BUILD_FLOW]->(File)
(RobotPartGroup)-[:PART_GROUP_NODE]->(FlowNode)-[:HAS_CHILD_ITEM]->(BacklogItem)
(RobotPartGroup)-[:HAS_EXPLANATION]->(PartExplanation)<-[:CONFIRMED_EXPLANATION]-(User)
(Organization)-[:HAS_COMPONENT_SPEC]->(ComponentSpec)
```

## Permissions

- Reads use the generated queries, filtered like `File` (org owner, project creator, assigned users, ADMIN / COMPANY_ADMIN members, SYSTEM_ADMIN).
- Generated create/update/delete mutations are off. Custom mutations check access in Cypher (`src/robots/robot.cypher.ts`):
  - import, AI drafting and delete: org owner or ADMIN / SUPER_USER member (same as creating a File);
  - edit/confirm an explanation: anyone who can read the project.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | – | Already required by the AI flow features. |
| `ROBOT_AI_MODEL` | `claude-haiku-4-5` | Model for part explanations. |
| `ROBOT_MESH_URL_HOSTS` | – | Extra hosts allowed for mesh URLs (comma-separated). Firebase Storage hosts are always allowed. |

**Storage CORS:** the browser loads STL files with `fetch`, so the Firebase Storage bucket needs a CORS rule allowing `GET` from the app's origins, e.g.

```json
[{ "origin": ["https://app.example.com"], "method": ["GET"], "maxAgeSeconds": 3600 }]
```

applied with `gsutil cors set cors.json gs://<bucket>`.

## Limits and follow-ups

- STL meshes only; no Collada/OBJ yet. URDF ≤ 5 MB, ≤ 500 links, ≤ 600 meshes.
- Explode offsets follow the joint tree (child slides away from parent). Users cannot yet merge/split groups in the UI.
- `ORG_ADMIN_CQL` picks the first org the user administers; users in several orgs will need an org argument.
- Supply/bottleneck tab (needs `ComponentSpec` ↔ `Asset` stock) is not built yet.

## Tests

`yarn test` runs `test/robots/robotPlan.test.ts` (node:test). Set `POPPY_DIR` to a checkout of `poppy-project/poppy-humanoid` to also run the end-to-end Poppy Humanoid case (15 groups, 26 parts, 25 motors).
