/**
 * Split & Explain: robots split into explained parts that link to build tasks.
 *
 * This is interpolated into the main typeDefs in schema.ts. All writes go
 * through the custom mutations at the bottom (see robot.resolvers.ts), so the
 * generated create/update/delete mutations are switched off with
 * @mutation(operations: []). Reads use the generated queries, filtered by the
 * same project rules as File.
 */

/** Who may read something that belongs to a project (mirrors File's READ rule). */
const projectReadRule = (pathToProject: string, close: string) => `
  {
    ${pathToProject}
      OR: [
        { organization: { createdBy: { externalId: "$jwt.sub" } } }
        { createdBy: { externalId: "$jwt.sub" } }
        { assignedUsers_SOME: { externalId: "$jwt.sub" } }
        {
          organization: {
            memberUsers_SOME: {
              externalId: "$jwt.sub"
              role_IN: ["ADMIN", "COMPANY_ADMIN"]
            }
          }
        }
      ]
    ${close}
  }
`;

const readFilter = (pathToProject: string, close: string, softDeletable = true) => `
  @authorization(
    filter: [
      {
        operations: [READ, AGGREGATE]
        where: {
          AND: [
            ${softDeletable ? "{ node: { deletedAt: null } }" : ""}
            {
              OR: [
                { jwt: { roles_INCLUDES: "SYSTEM_ADMIN" } }
                ${projectReadRule(pathToProject, close)}
              ]
            }
          ]
        }
      }
    ]
  )
`;

export const robotTypeDefs = `
  enum ExplanationSource {
    AI
    HUMAN
  }

  enum ExplanationStatus {
    DRAFT
    CONFIRMED
    STALE
  }

  enum RobotPartSide {
    LEFT
    RIGHT
    CENTER
  }

  type Robot implements Timestamped & SoftDeletable
    ${readFilter("node: { project: {", "} }")}
    @query(read: true, aggregate: false)
    @mutation(operations: []) {
    id: ID! @id
    name: String!
    "Licence of the 3D model, e.g. CC BY-SA 4.0. Shown with the credit line."
    license: String
    "Credit line required by the model's licence."
    attribution: String
    sourceUrl: String
    "Rough robot size in metres, used to scale the explode distance."
    approxSize: Float
    project: Project!
      @relationship(type: "HAS_ROBOT", direction: IN, nestedOperations: [], aggregate: false)
    buildFlowFile: File
      @relationship(type: "HAS_BUILD_FLOW", direction: OUT, nestedOperations: [], aggregate: false)
    groups: [RobotPartGroup!]!
      @relationship(type: "HAS_PART_GROUP", direction: OUT, nestedOperations: [], aggregate: false)
    createdBy: User!
      @relationship(type: "CREATED_ROBOT", direction: IN, nestedOperations: [], aggregate: false)
    deletedAt: DateTime
    createdAt: DateTime!
      @timestamp(operations: [CREATE])
      @settable(onCreate: true, onUpdate: false)
    updatedAt: DateTime
      @timestamp(operations: [UPDATE])
      @settable(onCreate: false, onUpdate: true)
  }

  type RobotPartGroup
    ${readFilter("node: { robot: { deletedAt: null, project: {", "} } }", false)}
    @query(read: true, aggregate: false)
    @mutation(operations: []) {
    id: ID! @id
    "Stable key from the import, e.g. shoulder."
    key: String!
    name: String!
    "2 when the group has a left and a right copy."
    qty: Int!
    category: String!
    "Build order: parents before children."
    order: Int!
    "Actuated joints in the group, as jointName|motorModel (model may be empty)."
    motors: [String!]!
    robot: Robot!
      @relationship(type: "HAS_PART_GROUP", direction: IN, nestedOperations: [], aggregate: false)
    parts: [RobotPart!]!
      @relationship(type: "HAS_PART", direction: OUT, nestedOperations: [], aggregate: false)
    flowNode: FlowNode
      @relationship(type: "PART_GROUP_NODE", direction: OUT, nestedOperations: [], aggregate: false)
    explanation: PartExplanation
      @relationship(type: "HAS_EXPLANATION", direction: OUT, nestedOperations: [], aggregate: false)
  }

  type RobotPart
    ${readFilter("node: { group: { robot: { deletedAt: null, project: {", "} } } }", false)}
    @query(read: true, aggregate: false)
    @mutation(operations: []) {
    id: ID! @id
    linkName: String!
    side: RobotPartSide!
    "Download URL of the mesh (STL) or of the whole model (GLB); null for a part with no visual."
    meshUrl: String
    meshFile: String
    "STL or GLB; null when the part has no 3D model."
    meshFormat: String
    "For GLB: name of the node in the model file."
    meshNode: String
    "Motors in this part, as name|model (model may be empty)."
    motors: [String!]!
    "Row-major 4×4 transform of the mesh with all joints at zero."
    matrix: [Float!]!
    scale: [Float!]!
    color: String
    "Offset in metres at 100% split."
    explode: [Float!]!
    depth: Int!
    group: RobotPartGroup!
      @relationship(type: "HAS_PART", direction: IN, nestedOperations: [], aggregate: false)
  }

  type PartExplanation
    ${readFilter("node: { group: { robot: { deletedAt: null, project: {", "} } } }", false)}
    @query(read: true, aggregate: false)
    @mutation(operations: []) {
    id: ID! @id
    what: String!
    why: String!
    madeOf: [String!]!
    "Things the AI could not tell from the data; a person should answer them."
    openQuestions: [String!]!
    source: ExplanationSource!
    status: ExplanationStatus!
    group: RobotPartGroup!
      @relationship(type: "HAS_EXPLANATION", direction: IN, nestedOperations: [], aggregate: false)
    confirmedBy: User
      @relationship(type: "CONFIRMED_EXPLANATION", direction: IN, nestedOperations: [], aggregate: false)
    confirmedAt: DateTime
    updatedAt: DateTime
  }

  "A real component (servo, motor, battery…) with specs and where each came from."
  type ComponentSpec
    @authorization(
      filter: [
        {
          operations: [READ, AGGREGATE]
          where: {
            OR: [
              { jwt: { roles_INCLUDES: "SYSTEM_ADMIN" } }
              { node: { organization: { createdBy: { externalId: "$jwt.sub" } } } }
              { node: { organization: { memberUsers_SOME: { externalId: "$jwt.sub" } } } }
            ]
          }
        }
      ]
    )
    @query(read: true, aggregate: false)
    @mutation(operations: []) {
    id: ID! @id
    model: String!
    kind: String!
    "JSON object of spec name → value, e.g. {\\"stallTorqueNm\\": 2.5}."
    specsJson: String!
    "URLs the specs were taken from."
    sources: [String!]!
    verifiedAt: DateTime
    organization: Organization!
      @relationship(type: "HAS_COMPONENT_SPEC", direction: IN, nestedOperations: [], aggregate: false)
  }

  input RobotMeshInput {
    "File name as referenced in the URDF, e.g. head_visual.STL."
    fileName: String!
    "Firebase Storage download URL of the uploaded file."
    url: String!
  }

  input ImportRobotInput {
    projectId: ID!
    name: String!
    "Contents of the .urdf file."
    urdf: String!
    meshes: [RobotMeshInput!]!
    "Optional pypot-style motor config JSON: { motors: { joint: { type } } }."
    motorConfigJson: String
    "Optional bill of materials CSV (joint or part column, motor/model column, optional qty)."
    bomCsv: String
    license: String
    attribution: String
    sourceUrl: String
    "Create procure/build/assemble/test tasks for each part group."
    createTasks: Boolean = true
  }

  enum RobotModelFormat {
    "One GLB file (STEP is converted to GLB in the browser)."
    GLB
    "No 3D model: parts come from the bill of materials."
    BOM
  }

  input RobotModelPartInput {
    "Unique node name in the model file."
    name: String!
    parent: String
    "Row-major 4×4 world transform."
    matrix: [Float!]!
    "World-space centre of the part's geometry."
    center: [Float!]
  }

  input ImportRobotModelInput {
    projectId: ID!
    name: String!
    format: RobotModelFormat!
    "Firebase Storage URL of the GLB (format GLB)."
    modelUrl: String
    "Mesh nodes of the model (format GLB)."
    parts: [RobotModelPartInput!]
    bomCsv: String
    license: String
    attribution: String
    sourceUrl: String
    createTasks: Boolean = true
  }

  input UpdatePartExplanationInput {
    groupId: ID!
    what: String
    why: String
    madeOf: [String!]
    "Mark the explanation as checked by a person."
    confirm: Boolean = false
  }

  input ComponentSpecInput {
    model: String!
    kind: String!
    specsJson: String!
    sources: [String!]!
  }

  enum RobotSupplyState {
    COVERED
    SHORT
    SHARED_SHORT
    NO_STOCK_DATA
  }

  type RobotSupplyOtherRobot
    @query(read: false, aggregate: false)
    @mutation(operations: []) {
    "Null when the user cannot see that robot's project."
    robotId: ID
    robotName: String!
    projectName: String!
    needed: Int!
  }

  type RobotSupplyLine
    @query(read: false, aggregate: false)
    @mutation(operations: []) {
    model: String!
    needed: Int!
    groupIds: [ID!]!
    "Asset units in the organisation with this model number."
    inStock: Int!
    assignedHere: Int!
    unassigned: Int!
    assignedElsewhere: Int!
    availableHere: Int!
    shortfall: Int!
    otherDemand: Int!
    sharedShortfall: Int!
    otherRobots: [RobotSupplyOtherRobot!]!
    state: RobotSupplyState!
  }

  type RobotSupplyStatus
    @query(read: false, aggregate: false)
    @mutation(operations: []) {
    robotId: ID!
    lines: [RobotSupplyLine!]!
    unknownMotors: Int!
    shortModels: Int!
    sharedBottlenecks: Int!
  }

  type ImportRobotResult
    @query(read: false, aggregate: false)
    @mutation(operations: []) {
    robotId: ID!
    buildFlowFileId: ID!
    groupCount: Int!
    partCount: Int!
    taskCount: Int!
    "Meshes the URDF refers to that were not uploaded."
    missingMeshes: [String!]!
    "BOM rows whose joint/part name matched nothing."
    unmatchedBomRows: [String!]!
  }
`;

/** Custom mutation fields, added inside the main type Mutation block. */
export const robotMutationFields = `
    importRobotFromUrdf(input: ImportRobotInput!): ImportRobotResult!
    importRobotFromModel(input: ImportRobotModelInput!): ImportRobotResult!
    renamePartGroup(groupId: ID!, name: String!, category: String): ID!
    "Merges groups into the first one; returns its id. Tasks, comments and links move to its flow node."
    mergePartGroups(robotId: ID!, groupIds: [ID!]!, name: String): ID!
    "Moves parts to an existing group, or to a new group when newGroupName is given; returns the target group id."
    movePartsToGroup(robotId: ID!, partIds: [ID!]!, targetGroupId: ID, newGroupName: String): ID!
    generatePartExplanations(robotId: ID!, groupIds: [ID!], overwriteConfirmed: Boolean = false): Int!
    updatePartExplanation(input: UpdatePartExplanationInput!): ID!
    deleteRobot(robotId: ID!): Boolean!
    upsertComponentSpec(input: ComponentSpecInput!): ID!
`;

/** Custom query fields, added inside the main type Query block. */
export const robotQueryFields = `
    robotSupplyStatus(robotId: ID!): RobotSupplyStatus!
`;
