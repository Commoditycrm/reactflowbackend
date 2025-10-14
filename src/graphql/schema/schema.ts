import { gql } from "graphql-tag";

const typeDefs = gql`
  #TODO: DELETE user (delete only the PII) so that createdBy is not null
  #TODO: or we probably need to execute a custom cypher with a variable path matching to match anything to that specific company and delete them ?
  #TODO: for each createdBy
  # @authorization(
  #     validate: [
  #       {
  #         when: [AFTER]
  #         operations: [CREATE]
  #         where: { node: { externalId: "$jwt.sub" } }
  #       }
  #     ]
  #   )
  type JWT @jwt {
    roles: [String!]!
  }

  enum UserRole {
    COMPANY_ADMIN
    SUPER_USER
    USER
    SYSTEM_ADMIN
  }

  interface SoftDeletable @limit(max: 15) {
    deletedAt: DateTime
  }

  interface Timestamped @limit(max: 15) {
    createdAt: DateTime!
    updatedAt: DateTime
  }

  interface TimestampedCreatable implements Timestamped @limit(max: 15) {
    createdBy: User! @declareRelationship
    createdAt: DateTime!
    updatedAt: DateTime
  }

  type User implements Timestamped
    @authorization(
      validate: [
        {
          when: [AFTER]
          operations: [CREATE]
          where: {
            OR: [
              { node: { memberOfOrganizations: { NOT: { id: null } } } }
              { node: { ownedOrganization: { NOT: { id: null } } } }
            ]
          }
        }
        { operations: [UPDATE], where: { node: { externalId: "$jwt.sub" } } }
        {
          operations: [DELETE]
          where: { jwt: { roles_INCLUDES: "SYSTEM_ADMIN" } }
        }

        # TODO: | READ is only for admin or himself or super user
      ]
    )
    @limit(default: 10)
    @mutation(operations: [CREATE, UPDATE])
    @query(read: true, aggregate: false) {
    id: ID! @id
    name: String!
      @populatedBy(callback: "userNameExtractor", operations: [CREATE])
    phoneNumber: String
      @unique
      @populatedBy(callback: "phoneNumberExtractor", operations: [CREATE])
      @settable(onCreate: true, onUpdate: false)
    externalId: String!
      @unique
      @populatedBy(callback: "externalIdExtractor", operations: [CREATE])
      @settable(onCreate: true, onUpdate: false)
      @authorization(
        validate: [{ where: { node: { externalId: "$jwt.sub" } } }]
      ) #Todo: READ externalId if he is cureentUser or COMPANY_ADMIN or SYSTEM_ADMIN
    email: String!
      @unique
      @populatedBy(callback: "emailExtractor", operations: [CREATE])
    ownedOrganization: Organization
      @relationship(
        type: "OWNS"
        direction: OUT
        aggregate: false
        nestedOperations: [CREATE]
      )
      @settable(onCreate: true, onUpdate: false)

    pendingTask(projectId: ID!): Int!
      @cypher(
        statement: """
        MATCH (p:Project {id: $projectId})

        CALL(p) {
          WITH p
          MATCH (p)-[:HAS_CHILD_FILE]->(file:File)-[:HAS_FLOW_NODE]->(n:FlowNode)
          WHERE file.deletedAt IS NULL AND n.deletedAt IS NULL
          RETURN n
          UNION
          MATCH path=(p)-[:HAS_CHILD_FOLDER*1..5]->(:Folder)-[:HAS_CHILD_FILE]->(file:File)-[:HAS_FLOW_NODE]->(n:FlowNode)
          WHERE file.deletedAt IS NULL AND n.deletedAt IS NULL
            AND ALL(x IN nodes(path) WHERE NOT x:Folder OR x.deletedAt IS NULL)
          RETURN n
        }

        WITH DISTINCT p, n, this

        MATCH (n)-[:HAS_CHILD_ITEM*1..2]->(bi:BacklogItem)-[:ITEM_IN_PROJECT]->(p)
        MATCH (bi)-[:HAS_STATUS]->(s:Status)
        WHERE bi.deletedAt IS NULL
          AND toLower(s.defaultName) <> 'completed'
          AND (
            EXISTS { MATCH (bi)-[:HAS_ASSIGNED_USER]->(this) }
          )

        RETURN COUNT(DISTINCT bi) AS pendingTask
        """
        columnName: "pendingTask"
      )

    completedTask(projectId: ID!): Int!
      @cypher(
        statement: """
        MATCH (p:Project {id: $projectId})

        CALL {
          WITH p
          MATCH (p)-[:HAS_CHILD_FILE]->(file:File)-[:HAS_FLOW_NODE]->(n:FlowNode)
          WHERE file.deletedAt IS NULL AND n.deletedAt IS NULL
          RETURN n
          UNION
          MATCH path=(p)-[:HAS_CHILD_FOLDER*1..5]->(:Folder)-[:HAS_CHILD_FILE]->(file:File)-[:HAS_FLOW_NODE]->(n:FlowNode)
          WHERE file.deletedAt IS NULL AND n.deletedAt IS NULL
            AND ALL(x IN nodes(path) WHERE NOT x:Folder OR x.deletedAt IS NULL)
          RETURN n
        }

        WITH DISTINCT p, n, this

        MATCH (n)-[:HAS_CHILD_ITEM*1..2]->(bi:BacklogItem)-[:ITEM_IN_PROJECT]->(p)
        WHERE bi.deletedAt IS NULL
        MATCH (bi)-[:HAS_STATUS]->(s:Status)
        WHERE s.deletedAt IS NULL
          AND s.defaultName = 'Completed'
          AND (
            EXISTS { MATCH (bi)-[:HAS_ASSIGNED_USER]->(this) }
          )

        RETURN COUNT(DISTINCT bi) AS completedTask
        """
        columnName: "completedTask"
      )

    role: String!
      @populatedBy(callback: "userRoleSetter", operations: [CREATE])
      @settable(onCreate: true, onUpdate: false)
    showHelpText: Boolean! @default(value: true)
    memberOfOrganizations: [Organization!]!
      @relationship(
        type: "MEMBER_OF"
        direction: OUT
        aggregate: false
        nestedOperations: [CONNECT, DISCONNECT]
      )
    createdAt: DateTime!
      @timestamp(operations: [CREATE])
      @settable(onCreate: true, onUpdate: false)
    updatedAt: DateTime
      @timestamp(operations: [UPDATE])
      @settable(onCreate: false, onUpdate: true)
  }

  type Counter
    @authorization(
      validate: [
        {
          operations: [CREATE, UPDATE, DELETE]
          where: {
            node: { organization: { createdBy: { externalId: "$jwt.sub" } } }
          }
        }
      ]
    )
    @mutation(operations: [])
    @query(read: false, aggregate: false) {
    id: ID! @id
    organization: Organization!
      @relationship(
        type: "HAS_COUNTER"
        direction: IN
        aggregate: false
        nestedOperations: []
      )
    counter: Int!
      @populatedBy(callback: "counterStarter", operations: [CREATE])
      @settable(onCreate: true, onUpdate: false)
  }

  type Status implements Timestamped
    @query(read: true, aggregate: false)
    @mutation(operations: [CREATE, DELETE, UPDATE])
    @authorization(
      validate: [
        {
          operations: [CREATE, UPDATE]
          where: {
            node: { organization: { createdBy: { externalId: "$jwt.sub" } } }
          }
        }
        {
          operations: [READ]
          when: [BEFORE]
          where: {
            node: {
              OR: [
                { organization: { createdBy: { externalId: "$jwt.sub" } } }
                {
                  organization: {
                    memberUsers_SINGLE: { externalId: "$jwt.sub" }
                  }
                }
              ]
            }
          }
        }
        {
          operations: [DELETE]
          when: [BEFORE]
          where: {
            node: {
              AND: [
                { organization: { createdBy: { externalId: "$jwt.sub" } } }
                { default: false }
              ]
            }
          }
        }
        {
          operations: [READ]
          when: [BEFORE]
          where: { jwt: { roles_INCLUDES: "SYSTEM_ADMIN" } }
        }
      ]
    ) {
    id: ID! @id
    name: String!
    defaultName: String!
      @authorization(
        validate: [
          {
            operations: [UPDATE]
            when: [BEFORE]
            where: { node: { default: false } }
          }
        ]
      )
      @populatedBy(callback: "defaultNameSetter", operations: [CREATE])
    color: String!
    description: String
    position: Int
    default: Boolean!
      @populatedBy(callback: "defaultKeySetter", operations: [CREATE])
    autoSelect: Boolean! @default(value: false)
    uniqueStatus: String!
      @unique
      @populatedBy(callback: "uniqueKeySetter", operations: [CREATE])
    organization: Organization!
      @relationship(
        type: "HAS_STATUS"
        direction: IN
        aggregate: false
        nestedOperations: [CONNECT]
      )
    createdAt: DateTime! @timestamp(operations: [CREATE])
    updatedAt: DateTime @timestamp(operations: [UPDATE])
  }

  type BacklogItemType implements Timestamped
    @query(read: true, aggregate: false)
    @authorization(
      validate: [
        {
          operations: [CREATE, UPDATE]
          where: {
            node: { organization: { createdBy: { externalId: "$jwt.sub" } } }
          }
        }
        {
          operations: [READ]
          when: [BEFORE]
          where: {
            node: {
              OR: [
                { organization: { createdBy: { externalId: "$jwt.sub" } } }
                {
                  organization: {
                    memberUsers_SINGLE: { externalId: "$jwt.sub" }
                  }
                }
              ]
            }
          }
        }
        {
          operations: [DELETE]
          when: [BEFORE]
          where: {
            node: {
              AND: [
                { default: false }
                { organization: { createdBy: { externalId: "$jwt.sub" } } }
              ]
            }
          }
        }
        {
          operations: [READ]
          when: [BEFORE]
          where: { jwt: { roles_INCLUDES: "SYSTEM_ADMIN" } }
        }
      ]
    ) {
    id: ID! @id
    name: String!
    defaultName: String!
      @authorization(
        validate: [
          {
            operations: [UPDATE]
            when: [BEFORE]
            where: { node: { default: false } }
          }
        ]
      )
      @populatedBy(callback: "defaultNameSetter", operations: [CREATE])
    default: Boolean!
      @populatedBy(callback: "defaultKeySetter", operations: [CREATE])
    autoSelect: Boolean! @default(value: false)
    uniqueBacklogType: String!
      @populatedBy(callback: "uniqueKeySetter", operations: [CREATE])
    organization: Organization!
      @relationship(
        type: "HAS_BACKLOGITEM_TYPE"
        direction: IN
        aggregate: false
        nestedOperations: [CONNECT]
      )
    createdAt: DateTime! @timestamp(operations: [CREATE])
    updatedAt: DateTime @timestamp(operations: [UPDATE])
  }

  type RiskLevel implements Timestamped
    @authorization(
      validate: [
        {
          operations: [CREATE]
          where: {
            node: { organization: { createdBy: { externalId: "$jwt.sub" } } }
          }
        }
        {
          operations: [READ]
          when: [BEFORE]
          where: {
            node: {
              OR: [
                { organization: { createdBy: { externalId: "$jwt.sub" } } }
                {
                  organization: {
                    memberUsers_SINGLE: { externalId: "$jwt.sub" }
                  }
                }
              ]
            }
          }
        }
        {
          operations: [DELETE]
          when: [BEFORE]
          where: {
            node: {
              AND: [
                { default: false }
                { organization: { createdBy: { externalId: "$jwt.sub" } } }
              ]
            }
          }
        }
        {
          operations: [READ]
          when: [BEFORE]
          where: { jwt: { roles_INCLUDES: "SYSTEM_ADMIN" } }
        }
      ]
    ) {
    id: ID! @id
    name: String!
    defaultName: String!
      @authorization(
        validate: [
          {
            operations: [UPDATE]
            when: [BEFORE]
            where: { node: { default: false } }
          }
        ]
      )
      @populatedBy(callback: "defaultNameSetter", operations: [CREATE])
    color: String!
    default: Boolean!
      @populatedBy(callback: "defaultKeySetter", operations: [CREATE])
    autoSelect: Boolean! @default(value: false)
    uniqueRiskLevel: String!
      @unique
      @populatedBy(callback: "uniqueKeySetter", operations: [CREATE])
    organization: Organization!
      @relationship(
        type: "HAS_RISK_LEVEL"
        direction: IN
        aggregate: false
        nestedOperations: [CONNECT]
      )

    createdAt: DateTime! @timestamp(operations: [CREATE])
    updatedAt: DateTime @timestamp(operations: [UPDATE])
  }

  type Organization implements TimestampedCreatable & Timestamped & SoftDeletable
    @authorization(
      filter: [
        {
          operations: [READ, AGGREGATE]
          where: {
            OR: [
              { node: { deletedAt: null } }
              { jwt: { roles_INCLUDES: "SYSTEM_ADMIN" } }
            ]
          }
        }
      ]
      validate: [
        {
          operations: [CREATE]
          where: { node: { createdBy: { externalId: "$jwt.sub" } } }
        }
        {
          operations: [UPDATE]
          where: {
            node: {
              OR: [
                { createdBy: { externalId: "$jwt.sub" } }
                { memberUsers_SINGLE: { externalId: "$jwt.sub" } }
              ]
            }
          }
        }
        {
          operations: [READ]
          where: {
            node: {
              OR: [
                { memberUsers_SOME: { externalId: "$jwt.sub" } }
                { invites_SOME: { email: "$jwt.email" } }
                { createdBy: { externalId: "$jwt.sub" } }
              ]
            }
          }
        }
        {
          operations: [READ, DELETE, UPDATE]
          where: { jwt: { roles_INCLUDES: "SYSTEM_ADMIN" } }
        }
      ]
    )
    @mutation(operations: [UPDATE])
    @limit(default: 10, max: 15)
    @query(read: true, aggregate: false) {
    id: ID! @id
    estimatedSize: Int!
      @cypher(
        statement: """
        MATCH (this)
        OPTIONAL MATCH (this)--(m)
        OPTIONAL MATCH (m)--(n)
        WITH collect(DISTINCT n) + collect(DISTINCT m) + collect(this) AS nodes
        UNWIND nodes AS node
        WITH node, size(keys(node)) AS propertyCount
        RETURN toInteger(count(node) * 40 + sum(propertyCount) * 20) AS estimatedBytes
        """
        columnName: "estimatedBytes"
      )
    name: String!
      @unique
      @authorization(
        validate: [
          {
            operations: [UPDATE]
            where: { node: { createdBy: { externalId: "$jwt.sub" } } }
          }
        ]
      )
    description: String
      @authorization(
        validate: [
          {
            operations: [UPDATE]
            where: { node: { createdBy: { externalId: "$jwt.sub" } } }
          }
        ]
      )
    counter: Counter!
      @relationship(
        type: "HAS_COUNTER"
        direction: OUT
        aggregate: false
        nestedOperations: [CREATE]
      )
      @settable(onCreate: true, onUpdate: false)
    messageCounter: Int!
      @populatedBy(callback: "messageCounterSetter", operations: [CREATE])

    status: [Status!]!
      @relationship(
        type: "HAS_STATUS"
        direction: OUT
        aggregate: false
        nestedOperations: [CREATE]
      )
      @settable(onCreate: true, onUpdate: false)
    backlogItemType: [BacklogItemType!]!
      @relationship(
        type: "HAS_BACKLOGITEM_TYPE"
        direction: OUT
        aggregate: false
        nestedOperations: [CREATE]
      )
      @settable(onCreate: true, onUpdate: false)
    riskLevels: [RiskLevel!]!
      @relationship(
        type: "HAS_RISK_LEVEL"
        direction: OUT
        aggregate: false
        nestedOperations: []
      )
    memberUsers: [User!]!
      @relationship(
        type: "MEMBER_OF"
        direction: IN
        aggregate: false
        nestedOperations: [CONNECT, DISCONNECT]
      )
    invites: [Invite!]!
      @relationship(
        type: "INVITE_FOR"
        direction: IN
        nestedOperations: []
        aggregate: false
      )
    projects: [Project!]!
      @relationship(type: "HAS_PROJECTS", direction: OUT, nestedOperations: [])
    resources: [Resource!]!
      @relationship(type: "HAS_RESOURCE", direction: OUT, nestedOperations: [])
    terminology: [ProjectTerminology!]!
      @relationship(
        type: "HAS_TERMINOLOGY"
        direction: OUT
        nestedOperations: []
        aggregate: false
      )
    createdBy: User!
      @relationship(
        type: "OWNS"
        direction: IN
        nestedOperations: [CONNECT]
        aggregate: false
      )
      @settable(onCreate: true, onUpdate: false)
    createdAt: DateTime!
      @timestamp(operations: [CREATE])
      @settable(onCreate: true, onUpdate: false)
    updatedAt: DateTime
      @timestamp(operations: [UPDATE])
      @settable(onCreate: false, onUpdate: true)
    deletedAt: DateTime
      @authorization(
        validate: [
          {
            when: [BEFORE]
            operations: [UPDATE]
            where: { jwt: { roles_INCLUDES: "SYSTEM_ADMIN" } }
          }
        ]
      )
    lastModified: DateTime @timestamp(operations: [CREATE])
  }

  enum ProjectTerminologyType {
    Folder
    File
    Sprint
  }

  type ProjectTerminology implements Timestamped
    @query(read: true, aggregate: false)
    @mutation(operations: [UPDATE])
    @authorization(
      validate: [
        {
          operations: [CREATE]
          when: [BEFORE]
          where: {
            node: { organization: { createdBy: { externalId: "$jwt.sub" } } }
          }
        }
        {
          operations: [READ]
          when: [BEFORE]
          where: {
            node: {
              OR: [
                { organization: { createdBy: { externalId: "$jwt.sub" } } }
                {
                  organization: {
                    memberUsers_SINGLE: { externalId: "$jwt.sub" }
                  }
                }
              ]
            }
          }
        }
      ]
    ) {
    id: ID! @id
    type: ProjectTerminologyType!
    label: String!
    organization: Organization!
      @relationship(
        type: "HAS_TERMINOLOGY"
        direction: IN
        nestedOperations: [CONNECT]
        aggregate: false
      )
    createdAt: DateTime! @timestamp(operations: [CREATE])
    updatedAt: DateTime @timestamp(operations: [UPDATE])
  }

  type Invite
    @mutation(operations: [CREATE, DELETE])
    @authorization(
      validate: [
        {
          operations: [CREATE]
          where: {
            node: { organization: { createdBy: { externalId: "$jwt.sub" } } }
          }
        }
        {
          operations: [READ]
          where: {
            node: {
              OR: [
                {
                  organization: { memberUsers_SOME: { externalId: "$jwt.sub" } }
                }
                { organization: { createdBy: { externalId: "$jwt.sub" } } }
                { email: "$jwt.sub" }
                { email: "$jwt.email" }
              ]
            }
          }
        }
        {
          operations: [DELETE]
          where: {
            OR: [
              {
                node: {
                  organization: { createdBy: { externalId: "$jwt.sub" } }
                }
              }
              { node: { invitedBy: { externalId: "$jwt.sub" } } }
              { jwt: { roles_INCLUDES: "SYSTEM_ADMIN" } }
            ]
          }
        }
      ]
    ) {
    id: ID! @id
    email: String!
    token: String! @unique
    createdAt: DateTime! @timestamp(operations: [CREATE])
    uniqueInvite: String!
      @unique
      @populatedBy(callback: "uniqueInviteExtractor", operations: [CREATE])
    invitedBy: User!
      @relationship(
        type: "INVITED_BY"
        direction: OUT
        aggregate: false
        nestedOperations: [CONNECT]
      )
    organization: Organization!
      @relationship(
        type: "INVITE_FOR"
        direction: OUT
        aggregate: false
        nestedOperations: [CONNECT]
      )
    projects: [Project!]!
      @relationship(
        type: "INVITE_TO_PROJECT"
        direction: OUT
        nestedOperations: [CONNECT]
        aggregate: false
      )
  }

  enum ResourceType {
    HUMAN_RESOURCES
    CONTACTS
    ASSETS
    ACCOUNTS
  }

  interface Resource implements Timestamped {
    id: ID!
    name: String!
    resourceType: ResourceType!
    createdAt: DateTime!
    updatedAt: DateTime
    organization: Organization! @declareRelationship
    address: Address @declareRelationship
    attachedFiles: [ExternalFile!]! @declareRelationship
    projects: [Project!]! @declareRelationship
    notes: [Comment!]! @declareRelationship
    lastModified: DateTime
  }

  type Address {
    city: String
    country: String
    postalCode: String
    state: String
    street: String
  }

  type Human implements Resource & Timestamped
    @authorization(
      validate: [
        {
          when: [AFTER]
          operations: [CREATE, UPDATE, DELETE]
          where: {
            node: { organization: { createdBy: { externalId: "$jwt.sub" } } }
          }
        }
        # {
        #   when: [BEFORE]
        #   operations: [READ]
        #   where: {
        #     node: {
        #       OR: [
        #         {
        #           projects_SINGLE: {
        #             assignedUsers_SINGLE: { externalId: "$jwt.sub" }
        #           }
        #         }
        #         { projects_SINGLE: { createdBy: { externalId: "$jwt.sub" } } }
        #         { organization: { createdBy: { externalId: "$jwt.sub" } } }
        #       ]
        #     }
        #   }
        # }
      ]
    ) {
    id: ID! @id
    name: String!
      @populatedBy(operations: [CREATE, UPDATE], callback: "resourceNameSetter")
      @settable(onCreate: false, onUpdate: false)
    resourceType: ResourceType!
    firstName: String!
    lastName: String!
    middleName: String
    email: String
    phone: String
    role: String
    organization: Organization!
      @relationship(
        type: "HAS_RESOURCE"
        direction: IN
        nestedOperations: [CONNECT]
        aggregate: false
      )
    address: Address
      @relationship(
        type: "HAS_ADDRESS"
        direction: OUT
        nestedOperations: [CREATE, UPDATE]
        aggregate: false
      )
    attachedFiles: [ExternalFile!]!
      @relationship(
        type: "HAS_ATTACHED_FILE"
        direction: OUT
        aggregate: false
        nestedOperations: []
      )
    projects: [Project!]!
      @relationship(
        type: "HAS_RESOURCE"
        direction: IN
        nestedOperations: []
        aggregate: false
      )
    notes: [Comment!]!
      @relationship(
        type: "HAS_COMMENT"
        direction: OUT
        nestedOperations: [CREATE]
        aggregate: false
      )
    lastModified: DateTime @timestamp(operations: [CREATE, UPDATE])
    createdAt: DateTime! @timestamp(operations: [CREATE])
    updatedAt: DateTime @timestamp(operations: [UPDATE])
  }

  type Contact implements Resource & Timestamped
    @authorization(
      validate: [
        {
          when: [AFTER]
          operations: [CREATE, UPDATE, DELETE]
          where: {
            node: { organization: { createdBy: { externalId: "$jwt.sub" } } }
          }
        }
        # {
        #   when: [BEFORE]
        #   operations: [READ]
        #   where: {
        #     node: {
        #       OR: [
        #         {
        #           projects_SINGLE: {
        #             assignedUsers_SINGLE: { externalId: "$jwt.sub" }
        #           }
        #         }
        #         { projects_SINGLE: { createdBy: { externalId: "$jwt.sub" } } }
        #         { organization: { createdBy: { externalId: "$jwt.sub" } } }
        #       ]
        #     }
        #   }
        # }
      ]
    ) {
    id: ID! @id
    name: String!
      @populatedBy(operations: [CREATE, UPDATE], callback: "resourceNameSetter")
      @settable(onCreate: false, onUpdate: false)
    resourceType: ResourceType!
    firstName: String!
    lastName: String!
    middleName: String
    email: String
    phone: String
    role: String
    linkedin: String
    organization: Organization!
      @relationship(
        type: "HAS_RESOURCE"
        direction: IN
        nestedOperations: [CONNECT]
        aggregate: false
      )
    address: Address
      @relationship(
        type: "HAS_ADDRESS"
        direction: OUT
        nestedOperations: [CREATE, UPDATE]
        aggregate: false
      )
    attachedFiles: [ExternalFile!]!
      @relationship(
        type: "HAS_ATTACHED_FILE"
        direction: OUT
        aggregate: false
        nestedOperations: []
      )
    projects: [Project!]!
      @relationship(
        type: "HAS_RESOURCE"
        direction: IN
        nestedOperations: []
        aggregate: false
      )
    notes: [Comment!]!
      @relationship(
        type: "HAS_COMMENT"
        direction: OUT
        nestedOperations: [CREATE]
        aggregate: false
      )
    lastModified: DateTime @timestamp(operations: [CREATE, UPDATE])
    createdAt: DateTime! @timestamp(operations: [CREATE])
    updatedAt: DateTime @timestamp(operations: [UPDATE])
  }

  type Asset implements Resource & Timestamped
    @authorization(
      validate: [
        {
          when: [AFTER]
          operations: [CREATE, UPDATE, DELETE]
          where: {
            node: { organization: { createdBy: { externalId: "$jwt.sub" } } }
          }
        }
      ]
    ) {
    id: ID! @id
    name: String!
    resourceType: ResourceType!
    assetType: String!
    assetDescription: String
    modelNumber: String
    serialNumber: String
    dateOfManufacture: DateTime
    dateOfPurchase: DateTime
    dateOfBuilt: DateTime
    organization: Organization!
      @relationship(
        type: "HAS_RESOURCE"
        direction: IN
        nestedOperations: [CONNECT]
        aggregate: false
      )
    address: Address
      @relationship(
        type: "HAS_ADDRESS"
        direction: OUT
        nestedOperations: [CREATE]
        aggregate: false
      )
    attachedFiles: [ExternalFile!]!
      @relationship(
        type: "HAS_ATTACHED_FILE"
        direction: OUT
        aggregate: false
        nestedOperations: []
      )
    projects: [Project!]!
      @relationship(
        type: "HAS_RESOURCE"
        direction: IN
        nestedOperations: []
        aggregate: false
      )
    notes: [Comment!]!
      @relationship(
        type: "HAS_COMMENT"
        direction: OUT
        nestedOperations: [CREATE]
        aggregate: false
      )
    lastModified: DateTime @timestamp(operations: [CREATE, UPDATE])
    createdAt: DateTime! @timestamp(operations: [CREATE])
    updatedAt: DateTime @timestamp(operations: [UPDATE])
  }

  type Account implements Resource & Timestamped
    @authorization(
      validate: [
        {
          when: [AFTER]
          operations: [CREATE, UPDATE, DELETE]
          where: {
            node: { organization: { createdBy: { externalId: "$jwt.sub" } } }
          }
        }
        # {
        #   when: [BEFORE]
        #   operations: [READ]
        #   where: {
        #     node: {
        #       OR: [
        #         {
        #           projects_SINGLE: {
        #             assignedUsers_SINGLE: { externalId: "$jwt.sub" }
        #           }
        #         }
        #         { projects_SINGLE: { createdBy: { externalId: "$jwt.sub" } } }
        #         { organization: { createdBy: { externalId: "$jwt.sub" } } }
        #       ]
        #     }
        #   }
        # }
      ]
    ) {
    id: ID! @id
    name: String!
    resourceType: ResourceType!
    businessEmail: String
    phone: String
    website: String
    dateOfEstablishment: DateTime
    businessAddress: String
    organization: Organization!
      @relationship(
        type: "HAS_RESOURCE"
        direction: IN
        nestedOperations: [CONNECT]
        aggregate: false
      )
    address: Address
      @relationship(
        type: "HAS_ADDRESS"
        direction: OUT
        nestedOperations: [CREATE, UPDATE]
        aggregate: false
      )
    attachedFiles: [ExternalFile!]!
      @relationship(
        type: "HAS_ATTACHED_FILE"
        direction: OUT
        aggregate: false
        nestedOperations: []
      )
    projects: [Project!]!
      @relationship(
        type: "HAS_RESOURCE"
        direction: IN
        nestedOperations: []
        aggregate: false
      )
    notes: [Comment!]!
      @relationship(
        type: "HAS_COMMENT"
        direction: OUT
        nestedOperations: [CREATE, DELETE, DISCONNECT]
        aggregate: false
      )
    lastModified: DateTime @timestamp(operations: [CREATE, UPDATE])
    createdAt: DateTime! @timestamp(operations: [CREATE])
    updatedAt: DateTime @timestamp(operations: [UPDATE])
  }

  enum BacklogTable {
    WORK_ITEMS
    MY_ITEMS
    EXPENSE
  }

  input BacklogItemFilterInput {
    typeIds: [ID!]
    assignedUserIds: [ID!]
    statusIds: [ID!]
    sprintIds: [ID!]
    riskLevelIds: [ID!]
    titleContains: [String!]
    tableType: BacklogTable
    occuredOn: DateTime
    paidOn: DateTime
  }

  type Project implements SoftDeletable
    @authorization(
      filter: [
        { operations: [READ, AGGREGATE], where: { node: { deletedAt: null } } }
      ]
      validate: [
        {
          operations: [READ]
          when: [AFTER]
          where: {
            OR: [
              {
                node: {
                  organization: { createdBy: { externalId: "$jwt.sub" } }
                }
              }
              { node: { createdBy: { externalId: "$jwt.sub" } } }
              { node: { assignedUsers_SINGLE: { externalId: "$jwt.sub" } } }
              {
                node: {
                  organization: { invites_SINGLE: { email: "$jwt.sub" } }
                }
              }
              { jwt: { roles_INCLUDES: "SYSTEM_ADMIN" } }
              { node: { isTemplate: true } }
            ]
          }
        }
        {
          when: [AFTER]
          operations: [CREATE]
          where: {
            OR: [
              {
                AND: [
                  { node: { isTemplate: true } }
                  { jwt: { roles_INCLUDES: "SYSTEM_ADMIN" } }
                ]
              }
              {
                AND: [
                  { node: { isTemplate: false } }
                  {
                    OR: [
                      {
                        node: {
                          organization: {
                            createdBy: { externalId: "$jwt.sub" }
                          }
                        }
                      }
                      {
                        node: {
                          organization: {
                            memberUsers_SINGLE: { externalId: "$jwt.sub" }
                          }
                        }
                      }
                    ]
                  }
                ]
              }
            ]
          }
        }
        {
          when: [AFTER]
          operations: [UPDATE]
          where: {
            OR: [
              {
                AND: [
                  { node: { isTemplate: true } }
                  { jwt: { roles_INCLUDES: "SYSTEM_ADMIN" } }
                ]
              }
              {
                AND: [
                  { node: { isTemplate: false } }
                  {
                    OR: [
                      {
                        node: {
                          organization: {
                            createdBy: { externalId: "$jwt.sub" }
                          }
                        }
                      }
                      { node: { createdBy: { externalId: "$jwt.sub" } } }
                      {
                        node: {
                          assignedUsers_SINGLE: {
                            externalId: "$jwt.sub"
                            role: "SUPER_USER"
                          }
                        }
                      }
                    ]
                  }
                ]
              }
            ]
          }
        }
        {
          when: [BEFORE]
          operations: [DELETE]
          where: {
            OR: [
              {
                AND: [
                  { node: { isTemplate: true } }
                  { jwt: { roles_INCLUDES: "SYSTEM_ADMIN" } }
                ]
              }
              {
                AND: [
                  { node: { isTemplate: false } }
                  {
                    OR: [
                      {
                        node: {
                          organization: {
                            createdBy: { externalId: "$jwt.sub" }
                          }
                        }
                      }
                      { node: { createdBy: { externalId: "$jwt.sub" } } }
                    ]
                  }
                ]
              }
            ]
          }
        }
      ]
    )
    @fulltext(indexes: [{ indexName: "projectName", fields: ["name"] }])
    @query(read: true, aggregate: false) {
    id: ID! @id
    name: String!
    description: String
    isDescriptionEditable: Boolean! @default(value: false)
    isTemplate: Boolean! @default(value: false)
    uniqueProject: String!
      @unique
      @populatedBy(
        callback: "uniqueProjectExtractor"
        operations: [CREATE, UPDATE]
      )
    startDate: DateTime
      @cypher(
        statement: """
        MATCH(this)<-[:ITEM_IN_PROJECT]-(items:BacklogItem)
        WHERE items.deletedAt IS NULL
        RETURN min(items.startDate) AS startDate
        """
        columnName: "startDate"
      )
    endDate: DateTime
      @cypher(
        statement: """
        MATCH(this)<-[:ITEM_IN_PROJECT]-(items:BacklogItem)
        WHERE items.deletedAt IS NULL
        RETURN max(items.endDate) AS endDate
        """
        columnName: "endDate"
      )
    progress: Float
      @cypher(
        statement: """
        WITH this

        CALL(this) {
          WITH this
          MATCH (this)-[:HAS_CHILD_FILE]->(file:File)-[:HAS_FLOW_NODE]->(n:FlowNode)
          WHERE file.deletedAt IS NULL AND n.deletedAt IS NULL
          RETURN DISTINCT n

          UNION

          MATCH path=(this)-[:HAS_CHILD_FOLDER*1..5]->(:Folder)-[:HAS_CHILD_FILE]->(file:File)-[:HAS_FLOW_NODE]->(n:FlowNode)
          WHERE file.deletedAt IS NULL AND n.deletedAt IS NULL
            AND ALL(x IN nodes(path) WHERE NOT x:Folder OR x.deletedAt IS NULL)
          RETURN DISTINCT n
         }
         WITH DISTINCT n
         MATCH (n)-[:HAS_CHILD_ITEM*1..2]->(bi:BacklogItem)-[:ITEM_IN_PROJECT]->(this)
         OPTIONAL MATCH (bi)-[:HAS_STATUS]->(s:Status)

         WITH count(DISTINCT bi) AS totalItems,
          count(DISTINCT CASE WHEN toLower(s.defaultName) IN ['completed','done','closed'] THEN bi END) AS completedItems

         RETURN CASE
           WHEN totalItems > 0
             THEN toFloat(round(100.0 * completedItems / totalItems))
             ELSE 0.0
           END AS progress
        """
        columnName: "progress"
      )
    assignedUsers: [User!]!
      @relationship(
        type: "HAS_ASSIGNED_USER"
        direction: OUT
        aggregate: true
        nestedOperations: [CONNECT, DISCONNECT]
      )
    folders: [Folder!]!
      @relationship(
        type: "HAS_CHILD_FOLDER"
        direction: OUT
        aggregate: true
        nestedOperations: []
      )
    files: [File!]!
      @relationship(
        type: "HAS_CHILD_FILE"
        direction: OUT
        aggregate: true
        nestedOperations: []
      )
    backlogItems(
      filters: BacklogItemFilterInput
      limit: Int! = 10
      offset: Int! = 0
    ): [BacklogItem!]!
      @cypher(
        statement: """
        WITH this, coalesce($filters,{}) AS f, $jwt.sub AS me
        WITH this, f, me, coalesce(f.table, f.tableType) AS tab

        CALL(this) {
          WITH this
          MATCH (this)-[:HAS_CHILD_FILE]->(file:File)-[:HAS_FLOW_NODE]->(n:FlowNode)
          WHERE file.deletedAt IS NULL AND n.deletedAt IS NULL
          RETURN DISTINCT n

          UNION

          MATCH path=(this)-[:HAS_CHILD_FOLDER*1..5]->(:Folder)-[:HAS_CHILD_FILE]->(file:File)-[:HAS_FLOW_NODE]->(n:FlowNode)
          WHERE file.deletedAt IS NULL AND n.deletedAt IS NULL
            AND ALL(x IN nodes(path) WHERE NOT x:Folder OR x.deletedAt IS NULL)
          RETURN DISTINCT n
        }
        WITH DISTINCT n, this, f, me, tab

        OPTIONAL MATCH(this)-[:HAS_AUTO_HIDE_CONFIG]->(cfg:AutoHideCompletedTasks)
        MATCH (n)-[:HAS_CHILD_ITEM*1..2]->(bi:BacklogItem)-[:ITEM_IN_PROJECT]->(this)
        WHERE bi.deletedAt IS NULL

          AND (
            size(coalesce(f.assignedUserIds,[])) = 0
            OR ANY(id IN f.assignedUserIds WHERE
              (id = "UNASSIGNED" AND NOT (bi)-[:HAS_ASSIGNED_USER]->(:User))
              OR (bi)-[:HAS_ASSIGNED_USER]->(:User {id: id})
            )
          )
          AND (
            size(coalesce(f.typeIds,[]))=0
            OR ANY(id IN f.typeIds WHERE (bi)-[:HAS_BACKLOGITEM_TYPE]->(:BacklogItemType {id: id}))
          )
          AND (
            size(coalesce(f.statusIds,[]))=0
            OR ANY(id IN f.statusIds WHERE (bi)-[:HAS_STATUS]->(:Status {id: id}))
          )
          AND (
            size(coalesce(f.sprintIds,[]))=0
            OR ANY(id IN f.sprintIds WHERE (bi)-[:HAS_SPRINTS]->(:Sprint {id: id}))
          )
          AND (
            size(coalesce(f.riskLevelIds,[]))=0
            OR ANY(id IN f.riskLevelIds WHERE (bi)-[:HAS_RISK_LEVEL]->(:RiskLevel {id: id}))
          )
          AND (
            size(coalesce(f.titleContains,[]))=0
            OR ANY(q IN f.titleContains WHERE toLower(bi.label) CONTAINS toLower(q))
          )

        WITH DISTINCT bi, tab, me,cfg,f,
          EXISTS {
            MATCH (bi)-[:HAS_ASSIGNED_USER]->(:User {externalId: me})
          } AS isMine,
          EXISTS {
            MATCH (bi)-[:HAS_BACKLOGITEM_TYPE]->(et:BacklogItemType)
            WHERE toLower(et.defaultName) = 'expense'
          } AS isExpense,(size(coalesce(f.statusIds,[])) > 0) AS hasStatusFilter

        WHERE tab IS NULL
          OR (tab = 'WORK_ITEMS' AND NOT isExpense)
          OR (tab = 'MY_ITEMS'   AND isMine AND NOT isExpense)
          OR (tab = 'EXPENSE'    AND isExpense)
          AND (
           tab <> 'EXPENSE'
           OR
          ((f.occurredOn IS NULL OR (bi.occurredOn IS NOT NULL AND date(bi.occurredOn) >= date(f.occurredOn)) OR (bi.occurredOn IS NOT NULL AND date(bi.occurredOn) <= date(f.occurredOn)))
           AND (f.paidOn IS NULL OR (bi.paidOn IS NOT NULL AND date(bi.paidOn) >= date(f.paidOn)) OR (bi.paidOn IS NOT NULL AND date(bi.paidOn) <= date(f.paidOn)))
          ))
        WITH bi, tab, f, cfg, hasStatusFilter
        WHERE
         tab IS NULL
         OR hasStatusFilter
         OR NOT coalesce(cfg.enabled,false)
         OR NOT (
            EXISTS {
            MATCH (bi)-[:HAS_STATUS]->(cs:Status)
            WHERE toLower(coalesce(cs.defaultName, cs.name)) = 'completed'
          }
          AND bi.updatedAt < datetime() - duration({days: coalesce(cfg.days, 2)})
        )

        RETURN bi AS backlogItems
        ORDER BY bi.uid DESC
        SKIP $offset LIMIT $limit
        """
        columnName: "backlogItems"
      )
    backlogItemsCount(filters: BacklogItemFilterInput): Int!
      @cypher(
        statement: """
        WITH this, coalesce($filters,{}) AS f, $jwt.sub AS me
        WITH this, f, me, coalesce(f.table, f.tableType) AS tab

        CALL(this) {
          WITH this
          MATCH (this)-[:HAS_CHILD_FILE]->(file:File)-[:HAS_FLOW_NODE]->(n:FlowNode)
          WHERE file.deletedAt IS NULL AND n.deletedAt IS NULL
          RETURN DISTINCT n

          UNION

          MATCH path=(this)-[:HAS_CHILD_FOLDER*1..5]->(:Folder)-[:HAS_CHILD_FILE]->(file:File)-[:HAS_FLOW_NODE]->(n:FlowNode)
          WHERE file.deletedAt IS NULL AND n.deletedAt IS NULL
           AND ALL(x IN nodes(path) WHERE NOT x:Folder OR x.deletedAt IS NULL)
          RETURN DISTINCT n
        }
        WITH DISTINCT n, this, f, me, tab
        OPTIONAL MATCH(this)-[:HAS_AUTO_HIDE_CONFIG]->(cfg:AutoHideCompletedTasks)
        MATCH (n)-[:HAS_CHILD_ITEM*1..2]->(bi:BacklogItem)-[:ITEM_IN_PROJECT]->(this)
        WHERE bi.deletedAt IS NULL

          AND (
            size(coalesce(f.assignedUserIds,[])) = 0
            OR ANY(id IN f.assignedUserIds WHERE
              (id = "UNASSIGNED" AND NOT (bi)-[:HAS_ASSIGNED_USER]->(:User))
              OR (bi)-[:HAS_ASSIGNED_USER]->(:User {id: id})
            )
          )
          AND (
            size(coalesce(f.typeIds,[]))=0
            OR ANY(id IN f.typeIds WHERE (bi)-[:HAS_BACKLOGITEM_TYPE]->(:BacklogItemType {id: id}))
          )
          AND (
            size(coalesce(f.statusIds,[]))=0
            OR ANY(id IN f.statusIds WHERE (bi)-[:HAS_STATUS]->(:Status {id: id}))
          )
          AND (
            size(coalesce(f.sprintIds,[]))=0
            OR ANY(id IN f.sprintIds WHERE (bi)-[:HAS_SPRINTS]->(:Sprint {id: id}))
          )
          AND (
            size(coalesce(f.riskLevelIds,[]))=0
            OR ANY(id IN f.riskLevelIds WHERE (bi)-[:HAS_RISK_LEVEL]->(:RiskLevel {id: id}))
          )
          AND (
            size(coalesce(f.titleContains,[]))=0
            OR ANY(q IN f.titleContains WHERE toLower(bi.label) CONTAINS toLower(q))
          )

        WITH DISTINCT bi, tab, me,f,cfg,
          EXISTS {
            MATCH (bi)-[:HAS_ASSIGNED_USER]->(:User {externalId: me})
          } AS isMine,
          EXISTS {
            MATCH (bi)-[:HAS_BACKLOGITEM_TYPE]->(et:BacklogItemType)
            WHERE toLower(et.defaultName) = 'expense'
          } AS isExpense,(size(coalesce(f.statusIds,[])) > 0) AS hasStatusFilter

        WHERE tab IS NULL
          OR (tab = 'WORK_ITEMS' AND NOT isExpense)
          OR (tab = 'MY_ITEMS'   AND isMine AND NOT isExpense)
          OR (tab = 'EXPENSE'    AND isExpense)
         AND (
           tab <> 'EXPENSE'
           OR
          ((f.occurredOn IS NULL OR (bi.occurredOn IS NOT NULL AND date(bi.occurredOn) >= date(f.occurredOn)) OR (bi.occurredOn IS NOT NULL AND date(bi.occurredOn) <= date(f.occurredOn)))
           AND (f.paidOn IS NULL OR (bi.paidOn IS NOT NULL AND date(bi.paidOn) >= date(f.paidOn)) OR (bi.paidOn IS NOT NULL AND date(bi.paidOn) <= date(f.paidOn)))
          ))
        WITH bi, tab, f, cfg, hasStatusFilter
        WHERE
         tab IS NULL
         OR hasStatusFilter
         OR NOT coalesce(cfg.enabled,false)
         OR NOT (
            EXISTS {
            MATCH (bi)-[:HAS_STATUS]->(cs:Status)
            WHERE toLower(coalesce(cs.defaultName, cs.name)) = 'completed'
          }
          AND bi.updatedAt < datetime() - duration({days: coalesce(cfg.days, 2)})
        )


        RETURN count(DISTINCT bi) AS backlogItemsCount
        """
        columnName: "backlogItemsCount"
      )
    getAllFiles(
      limit: Int = 10
      offset: Int = 0
      searchQuery: String
    ): [File!]!
      @cypher(
        statement: """
        WITH this, $searchQuery AS sq

        CALL(this) {
          WITH this
          MATCH (this)-[:HAS_CHILD_FILE]->(file:File)
          WHERE file.deletedAt IS NULL
          RETURN file

          UNION

          WITH this
          MATCH path=(this)-[:HAS_CHILD_FOLDER*1..5]->(:Folder)-[:HAS_CHILD_FILE]->(file:File)
          WHERE file.deletedAt IS NULL
            AND ALL(x IN nodes(path) WHERE NOT x:Folder OR x.deletedAt IS NULL)
          RETURN file
        }

        WITH DISTINCT file,sq
        WHERE sq IS NULL OR trim(sq) = "" OR toLower(file.name) CONTAINS toLower(sq)

        RETURN file
        ORDER BY file.createdAt DESC
        SKIP $offset LIMIT $limit
        """
        columnName: "file"
      )

    organization: Organization!
      @relationship(
        type: "HAS_PROJECTS"
        direction: IN
        aggregate: false
        nestedOperations: [CONNECT]
      )
    createdBy: User!
      @relationship(
        type: "CREATED_PROJECT"
        direction: IN
        nestedOperations: [CONNECT]
        aggregate: false
      )
    sprints: [Sprint!]!
      @relationship(
        type: "HAS_SPRINTS"
        direction: IN
        nestedOperations: []
        aggregate: false
      )
    resources: [Resource!]!
      @relationship(
        type: "HAS_RESOURCE"
        direction: OUT
        nestedOperations: [CONNECT, DISCONNECT]
      )
    triggerLastModified: Boolean
      @populatedBy(
        callback: "updateOrgLastModified"
        operations: [UPDATE, CREATE]
      )
    createdAt: DateTime! @timestamp(operations: [CREATE])
    updatedAt: DateTime @timestamp(operations: [UPDATE])
    deletedAt: DateTime
    # @authorization(
    #   validate: [
    #     {
    #       when: [BEFORE]
    #       operations: [UPDATE]
    #       where: {
    #         node: {
    #           OR: [
    #             { createdBy: { externalId: "$jwt.sub" } }
    #             { organization: { createdBy: { externalId: "$jwt.sub" } } }
    #             {
    #               createdBy: {
    #                 externalId: "$jwt.sub"
    #                 role_IN: ["SUPER_USER", "USER"]
    #               }
    #             }
    #           ]
    #         }
    #       }
    #     }
    #   ]
    # )
  }

  extend type Project {
    whatsappNotifications: WhatsappNotification!
      @relationship(
        type: "HAS_WS_NOTIFICATION"
        direction: OUT
        nestedOperations: [CREATE]
        aggregate: false
      )
    autoHideCompletedTask: AutoHideCompletedTasks!
      @relationship(
        type: "HAS_AUTO_HIDE_CONFIG"
        direction: OUT
        nestedOperations: [CREATE]
        aggregate: false
      )
  }

  type CalenderEvent implements Timestamped & TimestampedCreatable
    @query(read: true, aggregate: false)
    @authorization(
      validate: [
        {
          when: [BEFORE]
          operations: [READ]
          where: {
            node: {
              OR: [
                {
                  project: {
                    organization: { createdBy: { externalId: "$jwt.sub" } }
                  }
                }
                {
                  project: {
                    organization: {
                      memberUsers_SINGLE: { externalId: "$jwt.sub" }
                    }
                  }
                }
              ]
            }
          }
        }
        {
          when: [AFTER]
          operations: [CREATE]
          where: {
            node: {
              OR: [
                {
                  project: { assignedUsers_SINGLE: { externalId: "$jwt.sub" } }
                }
                { project: { createdBy: { externalId: "$jwt.sub" } } }
                {
                  project: {
                    organization: { createdBy: { externalId: "$jwt.sub" } }
                  }
                }
              ]
            }
          }
        }
        {
          when: [AFTER]
          operations: [UPDATE, DELETE]
          where: {
            node: {
              OR: [
                { createdBy: { externalId: "$jwt.sub" } }
                {
                  project: {
                    organization: { createdBy: { externalId: "$jwt.sub" } }
                  }
                }
              ]
            }
          }
        }
      ]
    ) {
    id: ID! @id
    title: String!
    startDate: DateTime!
    endDate: DateTime!
    description: String
    createdAt: DateTime! @timestamp(operations: [CREATE])
    updatedAt: DateTime @timestamp(operations: [UPDATE])
    uniqueDuration: String!
      @populatedBy(
        operations: [CREATE, UPDATE]
        callback: "uniqueEventExtractor"
      )
      @unique
    createdBy: User!
      @relationship(
        type: "CREATED_EVENT"
        direction: IN
        nestedOperations: [CONNECT]
        aggregate: false
      )
    project: Project!
      @relationship(
        type: "HAS_EVENT"
        direction: IN
        nestedOperations: [CONNECT]
        aggregate: false
      )
    resource: Asset
      @relationship(
        type: "HAS_RESOURCE"
        direction: OUT
        nestedOperations: [CONNECT, DISCONNECT]
        aggregate: false
      )
  }

  type WhatsappNotification {
    enabled: Boolean! @default(value: false)
    priorities: [RiskLevel!]!
      @relationship(
        type: "HAS_RISKLEVEL"
        direction: OUT
        nestedOperations: [CONNECT, DISCONNECT]
        aggregate: false
      )
    project: Project!
      @relationship(
        type: "HAS_WS_NOTIFICATION"
        direction: IN
        nestedOperations: [CONNECT]
        aggregate: false
      )
  }

  type AutoHideCompletedTasks {
    enabled: Boolean! @default(value: false)
    days: Int!
    project: Project!
      @relationship(
        type: "HAS_AUTO_HIDE_CONFIG"
        direction: IN
        nestedOperations: []
        aggregate: false
      )
  }

  union FolderParent = Project | Folder

  type Folder implements TimestampedCreatable & Timestamped & SoftDeletable
    @authorization(
      filter: [
        { operations: [READ, AGGREGATE], where: { node: { deletedAt: null } } }
      ]
      validate: [
        {
          when: [AFTER]
          operations: [READ]
          where: {
            OR: [
              {
                node: {
                  project: {
                    organization: { createdBy: { externalId: "$jwt.sub" } }
                  }
                }
              }
              { node: { project: { createdBy: { externalId: "$jwt.sub" } } } }
              {
                node: {
                  project: { assignedUsers_SINGLE: { externalId: "$jwt.sub" } }
                }
              }
            ]
          }
        }
        {
          when: [AFTER]
          operations: [UPDATE, CREATE]
          where: {
            OR: [
              {
                AND: [
                  { jwt: { roles_INCLUDES: "SYSTEM_ADMIN" } }
                  { node: { project: { isTemplate: true } } }
                ]
              }
              {
                AND: [
                  { node: { project: { isTemplate: false } } }
                  {
                    node: {
                      OR: [
                        {
                          project: {
                            assignedUsers_SINGLE: {
                              externalId: "$jwt.sub"
                              role: "SUPER_USER"
                            }
                          }
                        }
                        { project: { createdBy: { externalId: "$jwt.sub" } } }
                        {
                          project: {
                            organization: {
                              createdBy: { externalId: "$jwt.sub" }
                            }
                          }
                        }
                      ]
                    }
                  }
                ]
              }
            ]
          }
        }
        {
          when: [BEFORE]
          operations: [DELETE]
          where: {
            OR: [
              {
                AND: [
                  { jwt: { roles_INCLUDES: "SYSTEM_ADMIN" } }
                  { node: { project: { isTemplate: true } } }
                ]
              }
              {
                AND: [
                  { node: { project: { isTemplate: false } } }
                  {
                    node: {
                      OR: [
                        { project: { createdBy: { externalId: "$jwt.sub" } } }
                        {
                          project: {
                            organization: {
                              createdBy: { externalId: "$jwt.sub" }
                            }
                          }
                        }
                      ]
                    }
                  }
                ]
              }
            ]
          }
        }
      ]
    )
    @query(read: true, aggregate: false)
    @mutation(operations: [CREATE, UPDATE]) {
    id: ID! @id
    name: String!
    description: String
    startDate: DateTime
      @cypher(
        statement: """
        MATCH(this)-[:HAS_CHILD_FOLDER*0..]->(folders:Folder)
        WHERE folders.deletedAt IS NULL
        MATCH(folders)-[:HAS_CHILD_FILE]->(file:File)
        WHERE file.deletedAt IS NULL
        MATCH(file)-[:HAS_FLOW_NODE]->(flownode:FlowNode)
        WHERE flownode.deletedAt IS NULL
        MATCH(flownode)-[:HAS_CHILD_ITEM]->(backlogItem:BacklogItem)
        WHERE backlogItem.deletedAt is NULL
        RETURN min(backlogItem.startDate) AS startDate
        """
        columnName: "startDate"
      )
    endDate: DateTime
      @cypher(
        statement: """
        MATCH(this)-[:HAS_CHILD_FOLDER*0..]->(folders:Folder)
        WHERE folders.deletedAt IS NULL
        MATCH(folders)-[:HAS_CHILD_FILE]->(file:File)
        WHERE file.deletedAt IS NULL
        MATCH(file)-[:HAS_FLOW_NODE]->(flownode:FlowNode)
        WHERE flownode.deletedAt IS NULL
        MATCH(flownode)-[:HAS_CHILD_ITEM]->(backlogItem:BacklogItem)
        WHERE backlogItem.deletedAt is NULL
        RETURN max(backlogItem.endDate) AS endDate
        """
        columnName: "endDate"
      )
    parent: FolderParent!
      @relationship(
        type: "HAS_CHILD_FOLDER"
        direction: IN
        aggregate: false
        nestedOperations: [CONNECT, DISCONNECT]
      )
    folders: [Folder!]!
      @relationship(
        type: "HAS_CHILD_FOLDER"
        direction: OUT
        aggregate: false
        nestedOperations: []
      )
    files: [File!]!
      @relationship(
        type: "HAS_CHILD_FILE"
        direction: OUT
        aggregate: false
        nestedOperations: []
      )
    project: Project!
      @relationship(
        type: "FOLDER_IN_PROJECT"
        direction: OUT
        nestedOperations: [CONNECT]
        aggregate: true
      )
    createdBy: User!
      @relationship(
        type: "CREATED_FOLDER"
        direction: IN
        aggregate: false
        nestedOperations: [CONNECT]
      )
    triggerLastModified: Boolean
      @populatedBy(
        callback: "updateOrgLastModified"
        operations: [UPDATE, CREATE]
      )
    deletedAt: DateTime @unique
    createdAt: DateTime!
      @timestamp(operations: [CREATE])
      @settable(onCreate: true, onUpdate: false)
    updatedAt: DateTime
      @timestamp(operations: [UPDATE])
      @settable(onCreate: false, onUpdate: true)
  }

  union FileParent = Project | Folder

  type File implements TimestampedCreatable & Timestamped & SoftDeletable
    @authorization(
      filter: [
        { operations: [READ, AGGREGATE], where: { node: { deletedAt: null } } }
      ]
      validate: [
        {
          when: [BEFORE]
          operations: [READ]
          where: {
            node: {
              OR: [
                {
                  parentConnection: {
                    Project: {
                      node: {
                        OR: [
                          {
                            organization: {
                              createdBy: { externalId: "$jwt.sub" }
                            }
                          }
                          { createdBy: { externalId: "$jwt.sub" } }
                          { assignedUsers_SINGLE: { externalId: "$jwt.sub" } }
                        ]
                      }
                    }
                  }
                }
                {
                  parentConnection: {
                    Folder: {
                      node: {
                        OR: [
                          {
                            project: {
                              organization: {
                                createdBy: { externalId: "$jwt.sub" }
                              }
                            }
                          }
                          { project: { createdBy: { externalId: "$jwt.sub" } } }
                          {
                            project: {
                              assignedUsers_SINGLE: { externalId: "$jwt.sub" }
                            }
                          }
                        ]
                      }
                    }
                  }
                }
                { createdBy: { externalId: "$jwt.sub" } }
              ]
            }
          }
        }
        {
          when: [BEFORE]
          operations: [DELETE, UPDATE, CREATE]
          where: {
            node: {
              OR: [
                {
                  parentConnection: {
                    Project: {
                      node: {
                        OR: [
                          {
                            organization: {
                              createdBy: { externalId: "$jwt.sub" }
                            }
                          }
                          { createdBy: { externalId: "$jwt.sub" } }
                          {
                            assignedUsers_SINGLE: {
                              externalId: "$jwt.sub"
                              role: "SUPER_USER"
                            }
                          }
                        ]
                      }
                    }
                  }
                }
                {
                  parentConnection: {
                    Folder: {
                      node: {
                        OR: [
                          {
                            project: {
                              organization: {
                                createdBy: { externalId: "$jwt.sub" }
                              }
                            }
                          }
                          { project: { createdBy: { externalId: "$jwt.sub" } } }
                          {
                            project: {
                              assignedUsers_SINGLE: {
                                externalId: "$jwt.sub"
                                role: "SUPER_USER"
                              }
                            }
                          }
                        ]
                      }
                    }
                  }
                }
              ]
            }
          }
        }
      ]
    )
    @fulltext(indexes: [{ indexName: "fullTextOnFileName", fields: ["name"] }])
    @query(read: true, aggregate: false)
    @mutation(operations: [CREATE, UPDATE]) {
    id: ID! @id
    name: String!
    startDate: DateTime
      @cypher(
        statement: """
        MATCH(this)-[:HAS_FLOW_NODE]->(flowNode:FlowNode)
        WHERE flowNode.deletedAt IS NULL
        MATCH(flowNode)-[:HAS_CHILD_ITEM]->(backlogItem:BacklogItem)
        RETURN min(backlogItem.startDate) AS startDate
        """
        columnName: "startDate"
      )
    endDate: DateTime
      @cypher(
        statement: """
        MATCH(this)-[:HAS_FLOW_NODE]->(flownode:FlowNode)
        WHERE flownode.deletedAt IS NULL
        MATCH(flownode)-[:HAS_CHILD_ITEM]->(backlogItem:BacklogItem)
        RETURN max(backlogItem.endDate) AS endDate
        """
        columnName: "endDate"
      )
    flowNodes: [FlowNode!]!
      @relationship(
        type: "HAS_FLOW_NODE"
        direction: OUT
        aggregate: false
        nestedOperations: []
      )
    parent: FileParent!
      @relationship(
        type: "HAS_CHILD_FILE"
        direction: IN
        aggregate: false
        nestedOperations: [CONNECT, DISCONNECT]
      )
    createdBy: User!
      @relationship(
        type: "CREATED_FILE"
        direction: IN
        aggregate: false
        nestedOperations: [CONNECT]
      )
      @settable(onCreate: true, onUpdate: false)
    triggerLastModified: Boolean
      @populatedBy(
        callback: "updateOrgLastModified"
        operations: [UPDATE, CREATE]
      )
    deletedAt: DateTime @unique
    createdAt: DateTime!
      @timestamp(operations: [CREATE])
      @settable(onCreate: true, onUpdate: false)
    updatedAt: DateTime
      @timestamp(operations: [UPDATE])
      @settable(onCreate: false, onUpdate: true)
  }

  type LINKED_TO
    @relationshipProperties
    @query(read: false, aggregate: false)
    @mutation(operations: []) {
    id: ID! @id
    source: String
    sourceHandle: String
    targetHandle: String
    animated: Boolean
    label: String
    color: String
    bidirectional: Boolean
  }

  type FlowNode implements TimestampedCreatable & Timestamped & SoftDeletable
    @authorization(
      filter: [
        { operations: [READ, AGGREGATE], where: { node: { deletedAt: null } } }
      ]
      validate: [
        {
          when: [AFTER]
          operations: [UPDATE, DELETE]
          where: {
            node: {
              OR: [
                { createdBy: { externalId: "$jwt.sub" } }
                {
                  file: {
                    parentConnection: {
                      Project: {
                        node: {
                          OR: [
                            {
                              organization: {
                                createdBy: { externalId: "$jwt.sub" }
                              }
                            }
                            { createdBy: { externalId: "$jwt.sub" } }
                            { assignedUsers_SINGLE: { externalId: "$jwt.sub" } }
                          ]
                        }
                      }
                    }
                  }
                }
                {
                  file: {
                    parentConnection: {
                      Folder: {
                        node: {
                          OR: [
                            {
                              project: {
                                organization: {
                                  createdBy: { externalId: "$jwt.sub" }
                                }
                              }
                            }
                            {
                              project: { createdBy: { externalId: "$jwt.sub" } }
                            }
                            {
                              project: {
                                assignedUsers_SINGLE: { externalId: "$jwt.sub" }
                              }
                            }
                          ]
                        }
                      }
                    }
                  }
                }
              ]
            }
          }
        }
        {
          when: [BEFORE]
          operations: [CREATE]
          where: {
            node: {
              OR: [
                {
                  file: {
                    parentConnection: {
                      Project: {
                        node: {
                          OR: [
                            {
                              organization: {
                                createdBy: { externalId: "$jwt.sub" }
                              }
                            }
                            { createdBy: { externalId: "$jwt.sub" } }
                            { assignedUsers_SINGLE: { externalId: "$jwt.sub" } }
                          ]
                        }
                      }
                    }
                  }
                }
                {
                  file: {
                    parentConnection: {
                      Folder: {
                        node: {
                          OR: [
                            {
                              project: {
                                organization: {
                                  createdBy: { externalId: "$jwt.sub" }
                                }
                              }
                            }
                            {
                              project: { createdBy: { externalId: "$jwt.sub" } }
                            }
                            {
                              project: {
                                assignedUsers_SINGLE: { externalId: "$jwt.sub" }
                              }
                            }
                          ]
                        }
                      }
                    }
                  }
                }
              ]
            }
          }
        }
      ]
    )
    @query(read: true, aggregate: false) {
    id: ID! @id
    name: String!
    description: String
    color: String!
    shape: String!
    posX: Float!
    posY: Float!
    width: Float!
    height: Float!
    type: String!
    startDate: DateTime
      @cypher(
        statement: """
        MATCH(this)-[:HAS_CHILD_ITEM]->(backlogItem:BacklogItem)
        RETURN min(backlogItem.startDate) AS startDate
        """
        columnName: "startDate"
      )
    endDate: DateTime
      @cypher(
        statement: """
        MATCH(this)-[:HAS_CHILD_ITEM]->(backlogItem:BacklogItem)
        RETURN max(backlogItem.endDate) AS endDate
        """
        columnName: "endDate"
      )

    childItems: [BacklogItem!]!
      @relationship(
        type: "HAS_CHILD_ITEM"
        direction: OUT
        aggregate: false
        nestedOperations: []
      )
    file: File!
      @relationship(
        type: "HAS_FLOW_NODE"
        direction: IN
        aggregate: false
        nestedOperations: [CONNECT]
      )
    linkedTo: [FlowNode!]!
      @relationship(
        type: "LINKED_TO"
        direction: OUT
        properties: "LINKED_TO"
        aggregate: false
        nestedOperations: [CONNECT, DISCONNECT, UPDATE]
        queryDirection: DEFAULT_UNDIRECTED
      )
    comments: [Comment!]!
      @relationship(
        type: "HAS_COMMENT"
        direction: OUT
        aggregate: false
        nestedOperations: []
      )
    createdBy: User!
      @relationship(
        type: "CREATED_FLOW_NODE"
        direction: IN
        aggregate: false
        nestedOperations: [CONNECT]
      )
      @settable(onCreate: true, onUpdate: false)
    triggerLastModified: Boolean
      @populatedBy(
        callback: "updateOrgLastModified"
        operations: [UPDATE, CREATE]
      )
    deletedAt: DateTime
    createdAt: DateTime!
      @timestamp(operations: [CREATE])
      @settable(onCreate: true, onUpdate: false)
    updatedAt: DateTime
      @timestamp(operations: [UPDATE])
      @settable(onCreate: false, onUpdate: true)
  }

  type Link implements TimestampedCreatable & Timestamped
    @limit(default: 10)
    @query(read: true, aggregate: false) {
    id: ID! @id
    title: String!
    url: String!
    createdAt: DateTime! @timestamp(operations: [CREATE])
    updatedAt: DateTime @timestamp(operations: [UPDATE])
    backlogItem: BacklogItem!
      @relationship(
        type: "HAS_LINK"
        direction: IN
        aggregate: false
        nestedOperations: [CONNECT]
      )
    createdBy: User!
      @relationship(
        type: "LINK_CREATED"
        direction: IN
        aggregate: false
        nestedOperations: [CONNECT]
      )
  }

  union BacklogItemParent = FlowNode | BacklogItem

  type BacklogItem implements TimestampedCreatable & Timestamped & SoftDeletable
    @authorization(
      filter: [
        { operations: [READ, AGGREGATE], where: { node: { deletedAt: null } } }
      ]

      validate: [
        {
          when: [BEFORE]
          operations: [READ]
          where: {
            node: {
              OR: [
                {
                  project: {
                    organization: { createdBy: { externalId: "$jwt.sub" } }
                  }
                }
                { project: { createdBy: { externalId: "$jwt.sub" } } }
                {
                  project: { assignedUsers_SINGLE: { externalId: "$jwt.sub" } }
                }
                { createdBy: { externalId: "$jwt.sub" } }
                { project: { isTemplate: true } }
              ]
            }
          }
        }
        {
          operations: [DELETE]
          where: {
            node: {
              OR: [
                { createdBy: { externalId: "$jwt.sub" } }
                {
                  project: {
                    organization: { createdBy: { externalId: "$jwt.sub" } }
                  }
                }
              ]
            }
          }
        }
        {
          operations: [UPDATE]
          where: {
            node: {
              OR: [
                {
                  project: {
                    organization: { createdBy: { externalId: "$jwt.sub" } }
                  }
                }
                { project: { createdBy: { externalId: "$jwt.sub" } } }
                {
                  project: {
                    assignedUsers_SINGLE: {
                      externalId: "$jwt.sub"
                      role_NOT: "USER"
                    }
                  }
                }
                { createdBy: { externalId: "$jwt.sub" } }
              ]
            }
          }
        }
        # system admin auhorization
        {
          when: [BEFORE]
          operations: [READ]
          where: { jwt: { roles_INCLUDES: "SYSTEM_ADMIN" } }
        }
      ]
    )
    @fulltext(
      indexes: [{ indexName: "fullTextOnBacklogItemLabel", fields: ["label"] }]
    )
    @mutation(operations: [UPDATE])
    @query(read: true, aggregate: false) {
    id: ID! @id
    uniqueUid: String! @unique @settable(onCreate: false, onUpdate: false)
    label: String!
    uid: Int! @settable(onCreate: false, onUpdate: false)
    description: String
    startDate: DateTime
    endDate: DateTime
    occuredOn: DateTime
    paidOn: DateTime
    projectedExpense: Float
    isRecurringTask: Boolean! @default(value: false)
    scheduleDays: Int
    actualExpense: Float
    isTopLevelParentItem: Boolean!
      @populatedBy(callback: "topLevelParentItem", operations: [CREATE])
    type: BacklogItemType!
      @relationship(
        type: "HAS_BACKLOGITEM_TYPE"
        direction: OUT
        aggregate: false
        nestedOperations: [CONNECT, DISCONNECT]
      )
    status: Status!
      @relationship(
        type: "HAS_STATUS"
        direction: OUT
        aggregate: false
        nestedOperations: [CONNECT, DISCONNECT]
      )
    riskLevel: RiskLevel!
      @relationship(
        type: "HAS_RISK_LEVEL"
        direction: OUT
        nestedOperations: [CONNECT, DISCONNECT]
        aggregate: false
      )
    assignedUser: User
      @relationship(
        type: "HAS_ASSIGNED_USER"
        direction: OUT
        aggregate: false
        nestedOperations: [CONNECT, DISCONNECT]
      )
    sprints: [Sprint!]!
      @relationship(
        type: "HAS_SPRINTS"
        direction: OUT
        aggregate: false
        nestedOperations: [DISCONNECT, CONNECT]
      )
    attachedFiles: [ExternalFile!]!
      @relationship(
        type: "HAS_ATTACHED_FILE"
        direction: OUT
        aggregate: false
        nestedOperations: []
      )
    links: [Link!]!
      @relationship(
        type: "HAS_LINK"
        direction: OUT
        aggregate: false
        nestedOperations: []
      )
    comments: [Comment!]!
      @relationship(
        type: "HAS_COMMENT"
        direction: OUT
        aggregate: false
        nestedOperations: []
      )
    childItems: [BacklogItem!]!
      @relationship(
        type: "HAS_CHILD_ITEM"
        direction: OUT
        aggregate: false
        nestedOperations: [CONNECT]
      )
      @settable(onCreate: false, onUpdate: false)
    createdBy: User!
      @relationship(
        type: "CREATED_ITEM"
        direction: IN
        aggregate: false
        nestedOperations: [CONNECT]
      )
      @settable(onCreate: true, onUpdate: false)
    parent: BacklogItemParent!
      @relationship(
        type: "HAS_CHILD_ITEM"
        direction: IN
        aggregate: false
        nestedOperations: [CONNECT]
      )
    project: Project!
      @relationship(
        type: "ITEM_IN_PROJECT"
        direction: OUT
        nestedOperations: [CONNECT]
        aggregate: false
      )
    predecessors: [BacklogItem!]!
      @relationship(
        type: "PREDECESSOR"
        direction: IN
        nestedOperations: [CONNECT, DISCONNECT]
        aggregate: false
      )
    successors: [BacklogItem!]!
      @relationship(
        type: "PREDECESSOR"
        direction: OUT
        nestedOperations: [CONNECT, DISCONNECT]
        aggregate: false
      )
    resources: [Resource!]!
      @relationship(
        type: "HAS_RESOURCE"
        direction: OUT
        nestedOperations: [CONNECT, DISCONNECT]
      )
    triggerLastModified: Boolean
      @populatedBy(
        callback: "updateOrgLastModified"
        operations: [UPDATE, CREATE]
      )
    deletedAt: DateTime @unique
    createdAt: DateTime!
      @timestamp(operations: [CREATE])
      @settable(onCreate: true, onUpdate: false)
    updatedAt: DateTime
      @timestamp(operations: [UPDATE])
      @settable(onCreate: false, onUpdate: true)
  }

  type BacklogItemHistory
    @limit(default: 10)
    @mutation(operations: [CREATE, DELETE])
    @query(read: true, aggregate: false) {
    id: ID! @id
    newValue: String!
    oldValue: String!
    field: String!
    modifiedAt: DateTime! @timestamp(operations: [CREATE])
    backlogItem: BacklogItem!
      @relationship(
        type: "HAS_HISTORY"
        direction: OUT
        nestedOperations: [CONNECT]
        aggregate: false
      )
    modifiedBy: User!
      @relationship(
        type: "MODIFIED_BY"
        direction: OUT
        nestedOperations: [CONNECT]
        aggregate: false
      )
  }

  union CommentParent =
      FlowNode
    | BacklogItem
    | Human
    | Contact
    | Asset
    | Account

  type Comment implements TimestampedCreatable & Timestamped
    @authorization(
      validate: [
        {
          operations: [DELETE, UPDATE]
          where: { node: { createdBy: { externalId: "$jwt.sub" } } }
        }
      ]
    )
    @limit(default: 10, max: 15)
    @query(read: true, aggregate: false) {
    id: ID! @id
    message: String!
      @authorization(
        validate: [
          {
            when: [BEFORE]
            operations: [UPDATE]
            where: { node: { createdBy: { externalId: "$jwt.sub" } } }
          }
        ]
      )
    pinned: Boolean! @default(value: false)
    createdBy: User!
      @relationship(
        type: "COMMENTED"
        direction: IN
        aggregate: false
        nestedOperations: [CONNECT]
      )
      @settable(onCreate: true, onUpdate: false)
    commentParent: CommentParent
      @relationship(
        type: "HAS_COMMENT"
        direction: IN
        aggregate: false
        nestedOperations: [CONNECT]
      )
      @settable(onCreate: true, onUpdate: false)
    triggerLastModified: Boolean
      @populatedBy(
        callback: "updateOrgLastModified"
        operations: [UPDATE, CREATE]
      )
    createdAt: DateTime!
      @timestamp(operations: [CREATE])
      @settable(onCreate: true, onUpdate: false)
    updatedAt: DateTime
      @timestamp(operations: [UPDATE])
      @settable(onCreate: false, onUpdate: true)
  }

  type Sprint implements TimestampedCreatable & Timestamped
    @authorization(
      filter: [
        { operations: [READ, AGGREGATE], where: { node: { deletedAt: null } } }
      ]
      validate: [
        {
          when: [BEFORE]
          operations: [READ]
          where: {
            node: {
              OR: [
                {
                  project: {
                    organization: { createdBy: { externalId: "$jwt.sub" } }
                  }
                }
                {
                  project: {
                    assignedUsers_SINGLE: {
                      externalId: "$jwt.sub"
                      role: "SUPER_USER"
                    }
                  }
                }
                { project: { createdBy: { externalId: "$jwt.sub" } } }
              ]
            }
          }
        }
        {
          when: [BEFORE]
          operations: [DELETE]
          where: {
            OR: [
              { node: { createdBy: { externalId: "$jwt.sub" } } }
              {
                node: {
                  project: {
                    organization: { createdBy: { externalId: "$jwt.sub" } }
                  }
                }
              }
            ]
          }
        }
      ]
    )
    @query(read: true, aggregate: false) {
    id: ID! @id
    name: String!
    startDate: DateTime!
    endDate: DateTime!
    uniqueSprint: String!
      @unique
      @settable(onCreate: false, onUpdate: false)
      @populatedBy(callback: "uniqueSprint", operations: [CREATE])
    createdBy: User!
      @relationship(
        type: "CREATED_SPRINT"
        direction: IN
        aggregate: false
        nestedOperations: [CONNECT]
      )
      @settable(onCreate: true, onUpdate: false)
    project: Project!
      @relationship(
        type: "HAS_SPRINTS"
        direction: OUT
        aggregate: false
        nestedOperations: [CONNECT]
      )
    triggerLastModified: Boolean
      @populatedBy(
        callback: "updateOrgLastModified"
        operations: [UPDATE, CREATE]
      )
    deletedAt: DateTime
    createdAt: DateTime!
      @timestamp(operations: [CREATE])
      @settable(onCreate: true, onUpdate: false)
    updatedAt: DateTime @timestamp(operations: [UPDATE])
  }

  union ExternalFileParent = BacklogItem | Human | Contact | Asset | Account

  type ExternalFile implements TimestampedCreatable & Timestamped
    @mutation(operations: [CREATE, DELETE])
    @query(read: true, aggregate: false) {
    id: ID! @id
    url: String!
    name: String
    type: ExternalFileType! #TODO: creator connection . can only be deleted by the creator, company admin or super user
    createdBy: User!
      @relationship(
        type: "CREATED_EXTERNAL_FILE"
        direction: IN
        aggregate: false
        nestedOperations: [CONNECT]
      )
    parent: ExternalFileParent!
      @relationship(
        type: "HAS_ATTACHED_FILE"
        direction: IN
        aggregate: false
        nestedOperations: [CONNECT]
      )
    triggerLastModified: Boolean
      @populatedBy(
        callback: "updateOrgLastModified"
        operations: [UPDATE, CREATE]
      )
    createdAt: DateTime!
      @timestamp(operations: [CREATE])
      @settable(onCreate: true, onUpdate: false)
    updatedAt: DateTime
      @timestamp(operations: [UPDATE])
      @settable(onCreate: false, onUpdate: true)
  }

  type DeleteInfo
    @query(read: false, aggregate: false)
    @mutation(operations: []) {
    nodesDeleted: Int!
    relationshipsDeleted: Int!
  }

  enum ExternalFileType {
    IMAGE
    PDF
    DOC
    TEXT
    OTHER
  }

  type OpenAIResponse
    @query(read: false, aggregate: false)
    @mutation(operations: []) {
    id: ID!
    content: String!
    description: String!
  }

  type SearchResult
    @query(read: false, aggregate: false)
    @mutation(operations: []) {
    backlogItem: BacklogItem!
  }

  type DeletedItemCont
    @query(read: false, aggregate: false)
    @mutation(operations: []) {
    type: String!
    count: Int!
  }

  type statusCountResult
    @query(read: false, aggregate: false)
    @mutation(operations: []) {
    color: String!
    count: Int!
    status: String!
    id: ID!
  }

  type RiskLevelItemCount
    @query(read: false, aggregate: false)
    @mutation(operations: []) {
    riskLevel: String!
    count: Int!
    id: ID!
  }

  type ItemCountResult
    @query(read: false, aggregate: false)
    @mutation(operations: []) {
    label: String!
    counts: [Int!]!
  }

  type ItemCountGroupedRiskLevel
    @query(read: false, aggregate: false)
    @mutation(operations: []) {
    id: ID!
    riskLevel: String!
    counts: [Int!]!
    color: String!
  }

  type OpenAIResponse
    @query(read: false, aggregate: false)
    @mutation(operations: []) {
    id: ID!
    content: String!
    description: String!
  }

  type FirebaseStorage
    @query(read: false, aggregate: false)
    @mutation(operations: []) {
    orgId: String!
    fileCount: Int!
    totalBytes: Int!
    totalMB: Float!
  }

  type SearchResult
    @query(read: false, aggregate: false)
    @mutation(operations: []) {
    backlogItem: BacklogItem!
  }

  type DeletedItemCont
    @query(read: false, aggregate: false)
    @mutation(operations: []) {
    type: String!
    count: Int!
  }

  type CustomizationDataCreationResult
    @query(read: false, aggregate: false)
    @mutation(operations: []) {
    defaulStatusCount: Int!
    defaultBacklogTypeCount: Int!
    defaultRiskLevelCount: Int!
  }

  input CommentsFilter {
    assignedUserIds: [ID!]
    riskLevelIds: [ID!]
    myMention: String
  }

  input DueTaskFilter {
    assignedUserIds: [ID!]
    riskLevelIds: [ID!]
  }

  type Mutation {
    updateUserRole(userId: ID!, role: UserRole!): Boolean!
    updateUserDetail(name: String!, phoneNumber: String): [User!]!
    updatePhoneNumber(phoneNumber: String!): Boolean!
    assignUserToProject(userId: ID!, projectId: ID!): Boolean!
    assignUserToBacklogItem(userId: ID!, backlogItemId: ID!): Boolean!
    createBacklogItemWithUID(
      input: BacklogItemCreateInput!
    ): CreateBacklogItemsMutationResponse!
    deleteUser(userId: ID!): [User!]!
    deleteFirebaseUser(userId: String!): Boolean!
    disableUser(userId: ID!): Boolean!
    createProjectWithTemplate(
      templateProjectId: ID!
      name: String!
      description: String
      startDate: String!
      orgId: ID!
    ): [Project!]!

    finishInviteSignup(
      email: String!
      name: String!
      externalId: String!
      phoneNumber: String
    ): [User!]!
      @cypher(
        statement: """
        MATCH (invite:Invite {email: $email})
        OPTIONAL MATCH (invite)-[:INVITE_FOR]->(org:Organization)
        OPTIONAL MATCH (invite)-[:INVITE_TO_PROJECT]->(project:Project)

        MERGE (user:User {email: $email})
          ON CREATE SET user.name = $name,
            user.createdAt = datetime(),
            user.externalId = $externalId,
            user.role='SUPER_USER',
            user.id=randomUUID(),
            user.showHelpText = true,
            user.phoneNumber = $phoneNumber

        MERGE (user)-[:MEMBER_OF]->(org)
        FOREACH (p IN CASE WHEN project IS NULL THEN [] ELSE [project] END |
          MERGE (p)-[:HAS_ASSIGNED_USER]->(user)
        )

        DETACH DELETE invite
        RETURN user
        """
        columnName: "user"
      )
    customizationDataCreation(orgId: ID!): CustomizationDataCreationResult!
      @cypher(
        statement: """
        MATCH (org:Organization {id: $orgId})
        WITH org
        CALL(org) {
          WITH org

          UNWIND [
            { color: '#52c41a', label: 'Low' },
            { color: '#faad14', label: 'Medium' },
            { color: '#ff4d4f', label: 'High' },
            { color: '#666666', label: 'Critical' }
          ] AS riskLevel
          CREATE (newRisk:RiskLevel {
            id: randomUUID(),
            name: riskLevel.label,
            uniqueRiskLevel: org.id + '-' + toLower(replace(riskLevel.label, ' ', '')),
            createdAt: datetime(),
            default: true,
            color: riskLevel.color,
            defaultName:riskLevel.label,
            autoSelect: CASE WHEN riskLevel.label = 'Low' THEN true ELSE false END
          })
          MERGE (org)-[:HAS_RISK_LEVEL]->(newRisk)
          WITH org, count(*) AS createdRiskLevelCount

          UNWIND [
            { name: "Not started", color: '#1b79d1', position: 1 },
            { name: "Blocked", color: '#FF4D4F', position: 2 },
            { name: "In progress", color: '#FAAD14', position: 3 },
            { name: "Completed", color: '#17bf55', position: 4 }
          ] AS status
          CREATE (newStatus:Status {
            id: randomUUID(),
            name: status.name,
            color: status.color,
            position: status.position,
            createdAt: datetime(),
            defaultName:status.name,
            default: true,
            uniqueStatus: org.id + '-' + toLower(replace(status.name, ' ', '')),
            autoSelect:CASE WHEN status.name = 'Not started' THEN true ELSE false END
          })
          MERGE (org)-[:HAS_STATUS]->(newStatus)
          WITH org, createdRiskLevelCount, count(*) AS createdStatusCount

          UNWIND [
            { id: 1, name: "Epic" },
            { id: 2, name: "Story" },
            { id: 3, name: "Issue" },
            { id: 4, name: "Task" },
            { id: 5, name: "Expense" }
          ] AS type
          CREATE (newType:BacklogItemType {
            id: randomUUID(),
            typeId: type.id,
            name: type.name,
            defaultName:type.name,
            uniqueBacklogType: org.id + '-' + toLower(replace(type.name," ","")),
            createdAt: datetime(),
            default: true,
            autoSelect: CASE WHEN type.name = 'Task' THEN true ELSE false END
          })
          MERGE (org)-[:HAS_BACKLOGITEM_TYPE]->(newType)
          WITH org, createdRiskLevelCount, createdStatusCount, count(*) AS createdBacklogTypeCount

          UNWIND [
            { label: "Folder", type: "Folder" },
            { label: "Canvas", type: "File" },
            { label: "Sprint", type: "Sprint" }
          ] AS terminology
          CREATE (newTerm:ProjectTerminology {
            id: randomUUID(),
            label: terminology.label,
            type: terminology.type,
            createdAt: datetime()
          })
          MERGE (org)-[:HAS_TERMINOLOGY]->(newTerm)

          RETURN {
            defaultRiskLevelCount: createdRiskLevelCount,
            defaulStatusCount: createdStatusCount,
            defaultBacklogTypeCount: createdBacklogTypeCount
          } AS result LIMIT 1
        }
        RETURN result
        """
        columnName: "result"
      )
    deleteFlowNode(flowNodeId: String!): DeleteInfo!
    deleteFile(fileId: String!): DeleteInfo!
    deleteFolder(folderId: String!): DeleteInfo!
    deleteBacklogItem(itemId: String!): DeleteInfo!
    emptyRecycleBin: DeleteInfo!
    deleteOrg(orgId: String): Boolean!
  }

  type Query {
    softDeletedFolders(
      limit: Int = 10
      offset: Int = 0
      where: FolderWhere
    ): [Folder!]!
    softDeletedFiles(
      limit: Int = 10
      offset: Int = 0
      where: FileWhere
    ): [File!]!
    softDeletedBacklogItems(
      limit: Int = 10
      offset: Int = 0
      where: BacklogItemWhere
    ): [BacklogItem!]!
    softDeletedFlowNodes(limit: Int = 10, offset: Int = 0): [FlowNode!]!
    softDeleteSprints(
      limit: Int = 10
      offset: Int = 0
      where: SprintWhere
    ): [Sprint!]!
    softDeleteProjects(
      limit: Int = 10
      offset: Int = 0
      where: ProjectWhere
    ): [Project!]!
    countAllSoftDeletedItems: [DeletedItemCont!]!
    generateTask(prompt: String!): [OpenAIResponse!]!
    backlogItemsSearchWithUid(
      query: String!
      limit: Int = 10
      offset: Int = 0
    ): [BacklogItem!]!
      @cypher(
        statement: """
        MATCH (user:User { externalId: $jwt.sub })
        WITH user, toInteger($query) AS q
        CALL {
          WITH user
          MATCH (project:Project)
          WHERE project.deletedAt IS NULL
            AND (
              EXISTS { MATCH (project)<-[:HAS_PROJECTS]-(org:Organization)<-[:OWNS]-(user) } OR
              EXISTS { MATCH (project)<-[:CREATED_PROJECT]-(user) } OR
              EXISTS { MATCH (project)-[:HAS_ASSIGNED_USER]->(user) }
            )
          RETURN DISTINCT project
        }

        CALL (project) {
          WITH project
          MATCH (project)-[:HAS_CHILD_FILE]->(file:File)-[:HAS_FLOW_NODE]->(n:FlowNode)
          WHERE file.deletedAt IS NULL AND n.deletedAt IS NULL
          RETURN DISTINCT n

          UNION

          MATCH path=(project)-[:HAS_CHILD_FOLDER*1..5]->(:Folder)-[:HAS_CHILD_FILE]->(file:File)-[:HAS_FLOW_NODE]->(n:FlowNode)
          WHERE file.deletedAt IS NULL AND n.deletedAt IS NULL
            AND ALL(x IN nodes(path) WHERE NOT x:Folder OR x.deletedAt IS NULL)
          RETURN DISTINCT n
        }

        WITH DISTINCT project, n, q

        MATCH (n)-[:HAS_CHILD_ITEM*1..2]->(bi:BacklogItem)
        WHERE bi.deletedAt IS NULL
        AND EXISTS { MATCH (bi)-[:ITEM_IN_PROJECT]->(project) }
        AND (q IS NOT NULL AND bi.uid = q)

        RETURN DISTINCT bi AS result
        SKIP $offset
        LIMIT $limit
        """
        columnName: "result"
      )
    fullTextSearchOnBacklogItems(
      query: String!
      limit: Int = 10
      offset: Int = 0
    ): [BacklogItem!]!
      @cypher(
        statement: """
        MATCH (user:User { externalId: $jwt.sub })
        CALL {
          WITH user
          MATCH (p:Project)
          WHERE p.deletedAt IS NULL
            AND (
              EXISTS { MATCH (p)<-[:HAS_PROJECTS]-(org:Organization)<-[:OWNS]-(user) } OR
              EXISTS { MATCH (p)<-[:CREATED_PROJECT]-(user) } OR
              EXISTS { MATCH (p)-[:HAS_ASSIGNED_USER]->(user) }
            )
          RETURN collect(p) AS projects
        }
        CALL {
          WITH $query AS q
          CALL db.index.fulltext.queryNodes('fullTextOnBacklogItemLabel', '*' + q + '*')
          YIELD node, score
          WHERE node:BacklogItem AND node.deletedAt IS NULL
          RETURN node AS bi, score
        }

        WITH projects, bi, score
        WHERE EXISTS {
          MATCH (bi)-[:ITEM_IN_PROJECT]->(p:Project)
          WHERE p IN projects

          AND (
            EXISTS {
              MATCH (p)-[:HAS_CHILD_FILE]->(:File)-[:HAS_FLOW_NODE]->(:FlowNode)-[:HAS_CHILD_ITEM*1..2]->(bi)
            }
            OR EXISTS {
              MATCH (p)-[:HAS_CHILD_FOLDER*1..5]->(:Folder)
                -[:HAS_CHILD_FILE]->(:File)
                -[:HAS_FLOW_NODE]->(:FlowNode)
                -[:HAS_CHILD_ITEM*1..2]->(bi)
            }
          )
        }
        WITH bi, max(score) AS bestScore
        ORDER BY bestScore DESC
        SKIP $offset
        LIMIT $limit
        RETURN bi AS result
        """
        columnName: "result"
      )

    countBacklogItemsGroupedByRisk(
      projectId: ID!
      start: DateTime!
      end: DateTime!
    ): [ItemCountGroupedRiskLevel!]!
      @cypher(
        statement: """
        MATCH (p:Project {id: $projectId})<-[:HAS_PROJECTS]-(org:Organization)
        MATCH (org)-[:HAS_RISK_LEVEL]->(r:RiskLevel)
        WITH p, collect(DISTINCT {name: r.name, color: r.color,id:r.id}) AS levels,
          datetime($start) AS ds, datetime($end) AS de

        OPTIONAL MATCH (p)-[:HAS_CHILD_FILE]->(rf:File)
        WHERE rf.deletedAt IS NULL
        OPTIONAL MATCH path=(p)-[:HAS_CHILD_FOLDER*1..]->(fo:Folder)-[:HAS_CHILD_FILE]->(sf:File)
        WHERE sf.deletedAt IS NULL
          AND ALL(n IN nodes(path) WHERE NOT n:Folder OR n.deletedAt IS NULL)

        WITH p, levels, ds, de, collect(DISTINCT rf)+collect(DISTINCT sf) AS files
        UNWIND files AS file
        WITH DISTINCT file, p, levels, ds, de

        MATCH (file)-[:HAS_FLOW_NODE]->(n:FlowNode)
        WHERE n.deletedAt IS NULL
        WITH p, levels, ds, de, collect(DISTINCT n) AS nodes

        UNWIND nodes AS n
        MATCH (n)-[:HAS_CHILD_ITEM*1..2]->(bi:BacklogItem)
        MATCH (bi)-[:ITEM_IN_PROJECT]->(p)
        WHERE bi.deletedAt IS NULL
        OPTIONAL MATCH (bi)-[:HAS_STATUS]->(s:Status)
        OPTIONAL MATCH (bi)-[:HAS_RISK_LEVEL]->(rl:RiskLevel)

        WITH levels, ds, de, bi,
          (toLower(s.defaultName) CONTAINS 'completed') AS isCompleted,
          rl.name AS rlName,
          CASE WHEN bi.updatedAt IS NOT NULL AND bi.updatedAt >= ds AND bi.updatedAt <= de
            THEN date(bi.updatedAt).month END AS cm,
          CASE WHEN bi.startDate IS NOT NULL AND bi.startDate >= ds AND bi.startDate <= de
            THEN date(bi.startDate).month END AS pm

        WITH levels,
          [x IN collect({risk: rlName, m: cm, c: isCompleted})
            WHERE x.c AND x.risk IS NOT NULL AND x.m IS NOT NULL |
            {risk: x.risk, m: x.m}] AS cList,
          [x IN collect({risk: rlName, m: pm, c: isCompleted})
            WHERE NOT x.c AND x.risk IS NOT NULL AND x.m IS NOT NULL |
            {risk: x.risk, m: x.m}] AS pList

        UNWIND levels AS lv
        WITH lv, cList, pList,
          [m IN range(1,12) | size([x IN cList WHERE x.risk = lv.name AND x.m = m])] AS completedCounts,
          [m IN range(1,12) | size([x IN pList WHERE x.risk = lv.name AND x.m = m])]  AS pendingCounts

        WITH
          [{riskLevel: lv.name, counts: completedCounts, color: lv.color,id:lv.id},
          {riskLevel: 'pending-' + lv.name, counts: pendingCounts, color: lv.color,id:lv.id}] AS pair
        UNWIND pair AS finalResult
        RETURN finalResult
        """
        columnName: "finalResult"
      )

    countBacklogItemsGroupedByStatus(projectId: ID): [statusCountResult!]!
      @cypher(
        statement: """
        WITH $projectId AS projectId, $jwt.sub AS userId
        OPTIONAL MATCH (p:Project)
        WHERE
          (projectId IS NOT NULL AND p.id = projectId) OR
          (
            projectId IS NULL AND
            (p)<-[:HAS_PROJECTS]-(:Organization)<-[:OWNS]-(:User {externalId: userId})
          )
        WITH DISTINCT p
        WHERE p.deletedAt IS NULL

        MATCH (p)<-[:HAS_PROJECTS]-(org:Organization)-[:HAS_STATUS]->(s:Status)
        WHERE s.deletedAt IS NULL

        CALL {
          WITH p
          MATCH (p)-[:HAS_CHILD_FILE]->(file:File)-[:HAS_FLOW_NODE]->(n:FlowNode)
          WHERE file.deletedAt IS NULL AND n.deletedAt IS NULL
          RETURN DISTINCT n
          UNION
          WITH p
          MATCH path=(p)-[:HAS_CHILD_FOLDER*1..5]->(:Folder)-[:HAS_CHILD_FILE]->(file:File)-[:HAS_FLOW_NODE]->(n:FlowNode)
          WHERE file.deletedAt IS NULL AND n.deletedAt IS NULL
            AND ALL(x IN nodes(path) WHERE NOT x:Folder OR x.deletedAt IS NULL)
          RETURN DISTINCT n
        }

        WITH DISTINCT p, s, n

        MATCH (n)-[:HAS_CHILD_ITEM*1..2]->(bi:BacklogItem)-[:ITEM_IN_PROJECT]->(p)
        WHERE bi.deletedAt IS NULL

        WITH s, collect(DISTINCT bi) AS items

        WITH
          s,
          size([x IN items WHERE EXISTS { MATCH (x)-[:HAS_STATUS]->(s) }]) AS cnt,
          s.name  AS status,
          s.color AS color,
          s.id    AS sid

        RETURN { status: status, color: color, count: cnt, id: sid } AS result
        ORDER BY result.status
        """
        columnName: "result"
      )

    getDueTask(
      projectId: ID
      limit: Int! = 5
      offset: Int! = 0
      filters: DueTaskFilter
    ): [BacklogItem!]!
      @cypher(
        statement: """
        CALL() {
          WITH $projectId AS projectId, $jwt.sub AS userId, coalesce($filters,{}) AS f
          WHERE projectId IS NOT NULL

          MATCH (p:Project {id: projectId})
          WHERE p.deletedAt IS NULL

          OPTIONAL MATCH (p)-[:HAS_CHILD_FILE]->(rf:File)
          WHERE rf.deletedAt IS NULL
          OPTIONAL MATCH path=(p)-[:HAS_CHILD_FOLDER*1..]->(:Folder)-[:HAS_CHILD_FILE]->(sf:File)
          WHERE sf.deletedAt IS NULL

          WITH p, f,
            coalesce(collect(DISTINCT rf), []) + coalesce(collect(DISTINCT sf), []) AS files,
            collect(DISTINCT path) AS paths
          WHERE size(files) > 0
            AND (size(paths) = 0 OR ALL(pa IN paths WHERE ALL(n IN nodes(pa) WHERE NOT n:Folder OR n.deletedAt IS NULL)))

          UNWIND files AS file
          OPTIONAL MATCH (file)-[:HAS_FLOW_NODE]->(:FlowNode)-[:HAS_CHILD_ITEM*1..2]->(bi:BacklogItem)
          MATCH (bi)-[:ITEM_IN_PROJECT]->(p)
          WHERE bi.deletedAt IS NULL
            AND bi.endDate <= datetime()
            AND (coalesce(f.riskLevelIds,[]) = [] OR EXISTS { MATCH (bi)-[:HAS_RISK_LEVEL]->(rl:RiskLevel) WHERE rl.id IN f.riskLevelIds })
            AND (coalesce(f.assignedUserIds,[]) = [] OR EXISTS { MATCH (bi)-[:HAS_ASSIGNED_USER]->(u:User) WHERE u.id IN f.assignedUserIds })

          WITH DISTINCT bi AS backlogItems
          MATCH (backlogItems)-[:HAS_STATUS]->(s:Status)
          WHERE toLower(s.defaultName) <> 'completed'
          RETURN backlogItems

          UNION

          WITH $projectId AS projectId, $jwt.sub AS userId, coalesce($filters,{}) AS f
          WHERE projectId IS NULL

          MATCH (p:Project)<-[:HAS_PROJECTS]-(org:Organization)<-[:OWNS]-(:User {externalId: userId})
          WHERE p.deletedAt IS NULL

          OPTIONAL MATCH (p)-[:HAS_CHILD_FILE]->(rf:File)
          WHERE rf.deletedAt IS NULL
          OPTIONAL MATCH path=(p)-[:HAS_CHILD_FOLDER*1..]->(:Folder)-[:HAS_CHILD_FILE]->(sf:File)
          WHERE sf.deletedAt IS NULL

          WITH p, f,
            coalesce(collect(DISTINCT rf), []) + coalesce(collect(DISTINCT sf), []) AS files,
            collect(DISTINCT path) AS paths
          WHERE size(files) > 0
            AND (size(paths) = 0 OR ALL(pa IN paths WHERE ALL(n IN nodes(pa) WHERE NOT n:Folder OR n.deletedAt IS NULL)))

          UNWIND files AS file
          OPTIONAL MATCH (file)-[:HAS_FLOW_NODE]->(:FlowNode)-[:HAS_CHILD_ITEM*1..2]->(bi:BacklogItem)
          MATCH (bi)-[:ITEM_IN_PROJECT]->(p)
          WHERE bi.deletedAt IS NULL
            AND bi.endDate <= datetime()
            AND (coalesce(f.riskLevelIds,[]) = [] OR EXISTS { MATCH (bi)-[:HAS_RISK_LEVEL]->(rl:RiskLevel) WHERE rl.id IN f.riskLevelIds })
            AND (coalesce(f.assignedUserIds,[]) = [] OR EXISTS { MATCH (bi)-[:HAS_ASSIGNED_USER]->(u:User) WHERE u.id IN f.assignedUserIds })

          WITH DISTINCT bi AS backlogItems
          MATCH (backlogItems)-[:HAS_STATUS]->(s:Status)
          WHERE toLower(s.defaultName) <> 'completed'
          RETURN backlogItems
        }

        WITH DISTINCT backlogItems
        RETURN backlogItems
        ORDER BY backlogItems.endDate ASC, backlogItems.uid ASC
        SKIP $offset
        LIMIT $limit
        """
        columnName: "backlogItems"
      )
    dueTaskCount(projectId: ID, filters: DueTaskFilter): Int!
      @cypher(
        statement: """
          CALL () {
          WITH $projectId AS projectId, $jwt.sub AS userId, coalesce($filters,{}) AS f
          WHERE projectId IS NOT NULL

          MATCH (p:Project {id: projectId})
          WHERE p.deletedAt IS NULL

          OPTIONAL MATCH (p)-[:HAS_CHILD_FILE]->(rf:File)
          WHERE rf.deletedAt IS NULL

          OPTIONAL MATCH path=(p)-[:HAS_CHILD_FOLDER*1..]->(:Folder)-[:HAS_CHILD_FILE]->(sf:File)
          WHERE sf.deletedAt IS NULL
          WITH p, f,
            coalesce(collect(DISTINCT rf), []) + coalesce(collect(DISTINCT sf), []) AS files,
            collect(DISTINCT path) AS paths
          WHERE size(files) > 0
            AND (size(paths) = 0 OR ALL(pa IN paths WHERE ALL(n IN nodes(pa) WHERE NOT n:Folder OR n.deletedAt IS NULL)))

          UNWIND files AS file
          OPTIONAL MATCH (file)-[:HAS_FLOW_NODE]->(:FlowNode)-[:HAS_CHILD_ITEM*1..2]->(bi:BacklogItem)
          MATCH (bi)-[:ITEM_IN_PROJECT]->(p)
          WHERE bi.deletedAt IS NULL
            AND bi.endDate <= datetime()
            AND (coalesce(f.riskLevelIds,[]) = [] OR EXISTS { MATCH (bi)-[:HAS_RISK_LEVEL]->(rl:RiskLevel) WHERE rl.id IN f.riskLevelIds })
            AND (coalesce(f.assignedUserIds,[]) = [] OR EXISTS { MATCH (bi)-[:HAS_ASSIGNED_USER]->(u:User) WHERE u.id IN f.assignedUserIds })

          WITH DISTINCT bi AS backlogItems
          MATCH (backlogItems)-[:HAS_STATUS]->(s:Status)
          WHERE toLower(s.defaultName) <> 'completed'
          RETURN backlogItems

          UNION

          WITH $projectId AS projectId, $jwt.sub AS userId, coalesce($filters,{}) AS f
          WHERE projectId IS NULL

          MATCH (p:Project)<-[:HAS_PROJECTS]-(org:Organization)<-[:OWNS|MEMBER_OF]-(:User {externalId: userId})
          WHERE p.deletedAt IS NULL

          OPTIONAL MATCH (p)-[:HAS_CHILD_FILE]->(rf:File)
          WHERE rf.deletedAt IS NULL

          OPTIONAL MATCH path=(p)-[:HAS_CHILD_FOLDER*1..]->(:Folder)-[:HAS_CHILD_FILE]->(sf:File)
          WHERE sf.deletedAt IS NULL
          WITH p, f,
            coalesce(collect(DISTINCT rf), []) + coalesce(collect(DISTINCT sf), []) AS files,
            collect(DISTINCT path) AS paths
          WHERE size(files) > 0
            AND (size(paths) = 0 OR ALL(pa IN paths WHERE ALL(n IN nodes(pa) WHERE NOT n:Folder OR n.deletedAt IS NULL)))

          UNWIND files AS file
          OPTIONAL MATCH (file)-[:HAS_FLOW_NODE]->(:FlowNode)-[:HAS_CHILD_ITEM*1..2]->(bi:BacklogItem)
          MATCH (bi)-[:ITEM_IN_PROJECT]->(p)
          WHERE bi.deletedAt IS NULL
            AND bi.endDate <= datetime()
            AND (coalesce(f.riskLevelIds,[]) = [] OR EXISTS { MATCH (bi)-[:HAS_RISK_LEVEL]->(rl:RiskLevel) WHERE rl.id IN f.riskLevelIds })
            AND (coalesce(f.assignedUserIds,[]) = [] OR EXISTS { MATCH (bi)-[:HAS_ASSIGNED_USER]->(u:User) WHERE u.id IN f.assignedUserIds })

          WITH DISTINCT bi AS backlogItems
          MATCH (backlogItems)-[:HAS_STATUS]->(s:Status)
          WHERE toLower(s.defaultName) <> 'completed'
          RETURN backlogItems
        }

        RETURN count(DISTINCT backlogItems) AS backlogItemsCount
        """
        columnName: "backlogItemsCount"
      )

    getComments(
      limit: Int! = 5
      offset: Int! = 0
      projectId: ID
      filters: CommentsFilter
    ): [Comment!]!
      @cypher(
        statement: """
        WITH $projectId AS projectId, $jwt.sub AS userId, coalesce($filters,{}) AS f
        OPTIONAL MATCH (p:Project)
        WHERE (projectId IS NOT NULL AND p.id = projectId)
          OR (projectId IS NULL AND (p)<-[:HAS_PROJECTS]-(:Organization)<-[:OWNS]-(:User {externalId: userId}))
        WITH DISTINCT p, f
        WHERE p.deletedAt IS NULL

        OPTIONAL MATCH (p)-[:HAS_CHILD_FILE]->(rf:File)
        WHERE rf.deletedAt IS NULL

        OPTIONAL MATCH path = (p)-[:HAS_CHILD_FOLDER*1..5]->(folders:Folder)-[:HAS_CHILD_FILE]->(sf:File)
        WHERE sf.deletedAt IS NULL

        WITH p,
             coalesce(collect(DISTINCT rf), []) + coalesce(collect(DISTINCT sf), []) AS files,
             f, collect(DISTINCT path) AS paths
        WHERE size(files) > 0
          AND (
            size(paths) = 0
            OR ALL(pa IN paths WHERE ALL(n IN nodes(pa) WHERE NOT n:Folder OR n.deletedAt IS NULL))
          )

        UNWIND files AS file
        OPTIONAL MATCH (file)-[:HAS_FLOW_NODE]->(nodes)-[:HAS_CHILD_ITEM*1..2]->(bi:BacklogItem)
        MATCH (bi)-[:ITEM_IN_PROJECT]->(p)
        WHERE bi.deletedAt IS NULL
          AND (coalesce(f.riskLevelIds,[]) = [] OR
            EXISTS { MATCH (bi)-[:HAS_RISK_LEVEL]->(rl:RiskLevel) WHERE rl.id IN f.riskLevelIds })
          AND (coalesce(f.assignedUserIds,[]) = [] OR
            EXISTS { MATCH (bi)-[:HAS_ASSIGNED_USER]->(u:User) WHERE u.id IN f.assignedUserIds })

        WITH DISTINCT bi AS items, trim(coalesce(f.myMention, '')) AS mention
        MATCH (items)-[:HAS_COMMENT]->(comments:Comment)
        WHERE mention = '' OR toLower(comments.message) CONTAINS toLower(mention)

        RETURN comments
        ORDER BY comments.createdAt DESC
        SKIP $offset
        LIMIT $limit
        """
        columnName: "comments"
      )

    commentsCount(projectId: ID, filters: CommentsFilter): Int!
      @cypher(
        statement: """
        WITH $projectId AS projectId, $jwt.sub AS userId, coalesce($filters,{}) AS f
        OPTIONAL MATCH (p:Project)
        WHERE (projectId IS NOT NULL AND p.id = projectId)
          OR (projectId IS NULL AND (p)<-[:HAS_PROJECTS]-(:Organization)<-[:OWNS]-(:User {externalId: userId}))
        WITH DISTINCT p, f
        WHERE p.deletedAt IS NULL

        OPTIONAL MATCH (p)-[:HAS_CHILD_FILE]->(rf:File)
        WHERE rf.deletedAt IS NULL

        OPTIONAL MATCH path = (p)-[:HAS_CHILD_FOLDER*1..5]->(folders:Folder)-[:HAS_CHILD_FILE]->(sf:File)
        WHERE sf.deletedAt IS NULL

        WITH p,
          coalesce(collect(DISTINCT rf), []) + coalesce(collect(DISTINCT sf), []) AS files,
          f, collect(DISTINCT path) AS paths
        WHERE size(files) > 0
          AND (
            size(paths) = 0
            OR ALL(pa IN paths WHERE ALL(n IN nodes(pa) WHERE NOT n:Folder OR n.deletedAt IS NULL))
          )

        UNWIND files AS file
        OPTIONAL MATCH (file)-[:HAS_FLOW_NODE]->(nodes)-[:HAS_CHILD_ITEM*1..2]->(bi:BacklogItem)
        MATCH (bi)-[:ITEM_IN_PROJECT]->(p)
        WHERE bi.deletedAt IS NULL
          AND (coalesce(f.riskLevelIds,[]) = [] OR
            EXISTS { MATCH (bi)-[:HAS_RISK_LEVEL]->(rl:RiskLevel) WHERE rl.id IN f.riskLevelIds })
          AND (coalesce(f.assignedUserIds,[]) = [] OR
            EXISTS { MATCH (bi)-[:HAS_ASSIGNED_USER]->(u:User) WHERE u.id IN f.assignedUserIds })

        WITH DISTINCT bi AS items, trim(coalesce(f.myMention, '')) AS mention
        MATCH (items)-[:HAS_COMMENT]->(comments:Comment)
        WHERE mention = '' OR toLower(comments.message) CONTAINS toLower(mention)

        RETURN COUNT(DISTINCT comments) AS commentsCount
        """
        columnName: "commentsCount"
      )

    backlogItemCountByRiskLevel(
      projectId: ID!
      statusIds: [ID!]!
    ): [RiskLevelItemCount!]!
      @cypher(
        statement: """
        WITH $projectId AS projectId,$statusIds AS statusIds
        MATCH (p:Project {id: projectId})<-[:HAS_PROJECTS]-(org:Organization)
        MATCH (org)-[:HAS_RISK_LEVEL]->(rl:RiskLevel)
        CALL(p) {
          WITH p
          MATCH (p)-[:HAS_CHILD_FILE]->(file:File)-[:HAS_FLOW_NODE]->(n:FlowNode)
          WHERE file.deletedAt IS NULL AND n.deletedAt IS NULL
          RETURN DISTINCT n

          UNION

          MATCH path=(p)-[:HAS_CHILD_FOLDER*1..5]->(:Folder)-[:HAS_CHILD_FILE]->(file:File)-[:HAS_FLOW_NODE]->(n:FlowNode)
          WHERE file.deletedAt IS NULL AND n.deletedAt IS NULL
            AND ALL(x IN nodes(path) WHERE NOT x:Folder OR x.deletedAt IS NULL)
          RETURN DISTINCT n
        }
        WITH DISTINCT n, p, org, rl,statusIds
        MATCH (n)-[:HAS_CHILD_ITEM*1..2]->(bi:BacklogItem)-[:ITEM_IN_PROJECT]->(p)
        WHERE bi.deletedAt IS NULL
          AND (
            statusIds IS NULL OR size(statusIds) = 0 OR
            EXISTS {
              MATCH (bi)-[:HAS_STATUS]->(s:Status)<-[:HAS_STATUS]-(org)
              USING INDEX s:Status(id)
              WHERE s.id IN statusIds
            }
          )
        MATCH (bi)-[:HAS_RISK_LEVEL]->(rl)
        WITH rl.name AS riskLevelName,rl.id AS riskId, COUNT(DISTINCT bi) AS count
        RETURN { id: riskId, riskLevel: riskLevelName, count: count} AS riskLevelCounts
        """
        columnName: "riskLevelCounts"
      )

    countBacklogItemsCompletionTrends(
      projectId: ID!
      start: DateTime!
      end: DateTime!
    ): [ItemCountResult!]!
      @cypher(
        statement: """
        MATCH (p:Project {id: $projectId})
        CALL(p) {
          WITH p
          MATCH (p)-[:HAS_CHILD_FILE]->(file:File)-[:HAS_FLOW_NODE]->(n:FlowNode)
          WHERE file.deletedAt IS NULL AND n.deletedAt IS NULL
          RETURN DISTINCT n AS nodes

          UNION

          MATCH path=(p)-[:HAS_CHILD_FOLDER*1..5]->(:Folder)-[:HAS_CHILD_FILE]->(file:File)-[:HAS_FLOW_NODE]->(n:FlowNode)
          WHERE file.deletedAt IS NULL AND n.deletedAt IS NULL
            AND ALL(x IN nodes(path) WHERE NOT x:Folder OR x.deletedAt IS NULL)
          RETURN DISTINCT n AS nodes
        }
        WITH DISTINCT nodes , p
        MATCH(nodes)-[:HAS_CHILD_ITEM*1..2]-(b:BacklogItem)-[:ITEM_IN_PROJECT]->(p)
        WHERE b.endDate IS NOT NULL AND b.updatedAt IS NOT NULL
          AND b.deletedAt IS NULL
          AND b.endDate >= datetime($start)
          AND b.endDate <= datetime($end)
        OPTIONAL MATCH (b)-[:HAS_STATUS]->(s:Status)
        WITH
          date(b.endDate).month AS month,
          toLower(s.defaultName) AS currentStatus
        WITH
          month,
          count(*) AS targeted,
          count(CASE WHEN currentStatus = "completed" THEN 1 END) AS completed
        WITH collect({month: month, targeted: targeted, completed: completed}) AS rawData,
          ["Target", "Complete"] AS labels
        UNWIND range(0, 1) AS i
        WITH rawData, labels[i] AS label, i
        CALL(rawData,label,i) {
          WITH rawData, label, i
          RETURN {
            label: label,
            counts: [m IN range(1, 12) |
              coalesce(
                head([
                  r IN rawData WHERE r.month = m |
                  (CASE i WHEN 0 THEN r.targeted ELSE r.completed END)
                ]),
                0
              )
            ]
          } AS result
        }
        RETURN result
        """
        columnName: "result"
      )

    getItemCountByUserActivity(projectId: ID!): [ItemCountResult!]!
      @cypher(
        statement: """
        MATCH (p:Project {id: $projectId})<-[:ITEM_IN_PROJECT]-(b:BacklogItem)-[:HAS_STATUS]->(s:Status)
        WHERE toLower(s.defaultName) = "completed"
          AND b.deletedAt IS NULL
          AND b.updatedAt IS NOT NULL
          AND date(b.updatedAt).year = date().year

        MATCH (b)-[:HAS_ASSIGNED_USER]->(u:User)
        WHERE u.name <> "Deleted Account"

        WITH u.name AS username, date(b.updatedAt).month AS month, count(*) AS count
        ORDER BY username, month

        WITH collect(DISTINCT username) AS users,
             collect({username: username, month: month, count: count}) AS rows

        UNWIND users AS label
        CALL(label,rows) {
          WITH rows, label
          RETURN {
            label: label,
            counts: [
              m IN range(1, 12) |
              reduce(total = 0, r IN [x IN rows WHERE x.username = label AND x.month = m] | total + r.count)
            ]
          } AS result
        }
        RETURN result
        """
        columnName: "result"
      )
    getFirebaseStorage(orgId: String!): FirebaseStorage!
  }
`;

export default typeDefs;
