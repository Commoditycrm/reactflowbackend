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

## Other ways in

- **CAD model (GLB, or STEP converted to GLB in the browser):** `importRobotFromModel(format: GLB)` takes the uploaded GLB URL and its mesh parts (name, parent, world matrix, centre). Parts become links joined by fixed joints that reproduce the transforms (`src/robots/parts.ts`); a synthetic root is skipped. Numbered instances ("nut", "nut_2") group together with that quantity; parts at the same depth are ordered from the base up.
- **Bill of materials (CSV):** header with a `joint` or `part` column, a `motor`/`model` column and optional `qty`. Joint rows set that joint's motor model; part rows add motors to that part. Works with URDF and GLB imports, or on its own (`format: BOM`, no 3D). Unmatched rows are returned as `unmatchedBomRows`.

## Editing part groups

Motors are stored on each `RobotPart` (`motors: [name|model]`), and a group's `motors` and `qty` are recomputed from its parts after every edit.

- `renamePartGroup` – name and category; the flow node is renamed too.
- `mergePartGroups` – parts move into the first group; tasks, comments and `LINKED_TO` links of the other groups' flow nodes move to its node, then those nodes and groups are deleted.
- `movePartsToGroup` – to an existing group, or a new one (with its own flow node linked from the source group's node). Emptying a group is refused (use merge).
- Confirmed explanations of changed groups become `STALE`.

## Purchase lists

`importPurchaseList(input: { projectId, name, sections })` turns a purchase list into a flow: one FlowNode per section (linked in order) and, per item, three BacklogItems — Get quote → Place order → Receive & inspect — linked with `PREDECESSOR`. The description holds vendor, part number, quantity, country, website, contact, spec and alternatives as escaped HTML. Items marked "buy later" get a "(Later)" prefix. The frontend parses the spreadsheet (sections, header row, alternative rows, yellow = later); logic in `src/purchases/purchasePlan.ts`.

Two optional inputs:

- `folderId`: the file(s) go inside that folder (any depth up to 5, must belong to the project and not be deleted) instead of at the project's top level.
- `splitByCountry: true`: one flow file per vendor country (the item's main vendor, not its alternatives), named `<name> – <Country>`. Country cells are normalised: notes in brackets are dropped, the first country is used when a cell lists several ("India (Distributor) / Japan Make" → India), case is fixed ("usa" → USA), and blanks or dashes go to an "Unspecified" file, created last. An item's optional `origin` (set in the import dialog, e.g. "Local") overrides its country for grouping; the task description keeps the full country text. The sheet's sections are kept inside each file. Everything is created in one transaction, and the limits (500 items, 50 sections) apply to the whole import.

The result lists every created file in `files { fileId name country itemCount taskCount }`; `fileId` is the first one.

## Supply and bottlenecks

`robotSupplyStatus(robotId)` compares the motors a robot needs (per model, from `RobotPartGroup.motors`) with the organisation's **Assets** whose `modelNumber` matches (case-insensitive):

- *available here* = units assigned to the robot's project + unassigned units;
- *shortfall* = needed − available here;
- *shared bottleneck* = other live robots in the org need the same model and total demand exceeds total stock.

Robots in projects the user cannot read are reported as "Another robot" without names. Logic: `src/robots/supply.ts` (unit-tested).

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

- URDF meshes must be STL; CAD models must be STEP or GLB (Collada/OBJ not yet). URDF ≤ 5 MB, ≤ 500 links, ≤ 600 meshes; models ≤ 2000 parts; BOM ≤ 1 MB.
- Explode offsets follow the joint tree (child slides away from parent); for CAD models, from the robot's centre using part centres.
- `ORG_ADMIN_CQL` picks the first org the user administers; users in several orgs will need an org argument.
- Supply matches motors to Assets by model number only; there is no reservation step beyond assigning an Asset to a project.

## Tests

`yarn test` runs `test/robots/robotPlan.test.ts` (node:test). Set `POPPY_DIR` to a checkout of `poppy-project/poppy-humanoid` to also run the end-to-end Poppy Humanoid case (15 groups, 26 parts, 25 motors).
