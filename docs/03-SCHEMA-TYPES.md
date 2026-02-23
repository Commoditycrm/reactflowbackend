# Schema & Type System - Complete Reference

## 📋 Table of Contents
- [Schema Overview](#schema-overview)
- [Core Types](#core-types)
- [Domain Model](#domain-model)
- [Relationships Explained](#relationships-explained)
- [Directives Reference](#directives-reference)
- [Type Hierarchy](#type-hierarchy)
- [Common Patterns](#common-patterns)

---

## Schema Overview

The schema defines the entire data model as a **graph** of interconnected types.

### File: `src/graphql/schema/schema.ts`

**Total Lines:** 5004 lines  
**Types Defined:** 40+ types  
**Relationships:** 100+ relationship definitions

### Schema Structure

```
Interfaces (Reusable contracts)
├── SoftDeletable     # Has deletedAt field
├── Timestamped       # Has createdAt, updatedAt
└── TimestampedCreatable  # Timestamped + createdBy

Enums (Fixed values)
├── UserRole
├── ResourceType
└── ProjectTerminologyType

Core Types (Main entities)
├── User
├── Organization
├── Counter
├── Status
├── BacklogItemType
├── RiskLevel
├── Invite
├── Resource (Interface)
│   ├── Human
│   ├── Contact
│   ├── Asset
│   └── Account
├── Project
├── Sprint
├── Folder
├── File
├── FlowNode
├── FileGroup
├── BacklogItem
├── Comment
├── ExternalFile
├── Label
├── Link
├── Dependency
└── Reminder
```

---

## Core Types

### User

**Purpose:** Represents authenticated users in the system

```graphql
type User implements Timestamped {
  # Identity
  id: ID!
  externalId: String!  # Firebase UID
  email: String!
  name: String!
  phoneNumber: String
  
  # Authorization
  role: String!  # UserRole enum
  
  # Relationships
  ownedOrganization: Organization
  memberOfOrganizations: [Organization!]!
  
  # Custom fields with Cypher
  pendingTask(projectId: ID!): Int!
  completedTask(projectId: ID!): Int!
  
  # UI Settings
  showHelpText: Boolean!
  
  # Timestamps
  createdAt: DateTime!
  updatedAt: DateTime
}
```

**Key Features:**

1. **Firebase Integration**  
   - `externalId` is auto-populated from JWT token (`$jwt.sub`)
   - `email` extracted from JWT
   - `name` from Firebase profile

2. **Role-Based Access**  
   ```typescript
   enum UserRole {
     COMPANY_ADMIN      # Organization owner
     SYSTEM_ADMIN       # Platform administrator
     ADMIN              # Organization admin
     SUPER_USER         # Power user
     USER               # Regular user
   }
   ```

3. **Authorization Rules**  
   ```graphql
   @authorization(
     validate: [
       # Can only UPDATE their own record
       { operations: [UPDATE], where: { node: { externalId: "$jwt.sub" } } }
       
       # Only SYSTEM_ADMIN can DELETE
       { operations: [DELETE], where: { jwt: { roles_INCLUDES: "SYSTEM_ADMIN" } } }
     ]
   )
   ```

4. **Custom Cypher Fields**  
   ```graphql
   pendingTask(projectId: ID!): Int!
     @cypher(statement: """
       # Complex query to count pending tasks assigned to user
       MATCH (p:Project {id: $projectId})
       # ... traversal logic
       RETURN COUNT(DISTINCT bi) AS pendingTask
     """)
   ```

**Usage Example:**
```graphql
query GetUserStats {
  user(where: { email: "john@example.com" }) {
    name
    role
    ownedOrganization {
      name
      memberUsers {
        name
      }
    }
    pendingTask(projectId: "proj-123")
    completedTask(projectId: "proj-123")
  }
}
```

---

### Organization

**Purpose:** Multi-tenant container for all data

```graphql
type Organization implements TimestampedCreatable & SoftDeletable {
  # Identity
  id: ID!
  name: String! @unique
  description: String
  
  # Auto-increment counter for BacklogItems
  counter: Counter!
  messageCounter: Int!
  
  # Relationships
  createdBy: User!  # Owner
  memberUsers: [User!]!
  invites: [Invite!]!
  projects: [Project!]!
  resources: [Resource!]!
  terminology: [ProjectTerminology!]!
  
  # Soft delete
  deletedAt: DateTime
  
  # Custom computed field
  estimatedSize: Int!  # Cypher calculation of data size
  lastModified: DateTime
  
  # Timestamps
  createdAt: DateTime!
  updatedAt: DateTime
}
```

**Key Features:**

1. **Unique Name Constraint**  
   - Organization names must be globally unique
   - Enforced at database level with `@unique`

2. **Auto-Increment Counter**  
   ```graphql
   counter: Counter! @relationship(type: "HAS_COUNTER", direction: OUT)
   ```
   - Used for generating sequential UIDs for BacklogItems
   - Format: `{counter}-{orgId}` → `"42-org-123"`

3. **Multi-Tenant Access Control**  
   ```graphql
   @authorization(
     validate: [
       # Owner has full access
       { where: { node: { createdBy: { externalId: "$jwt.sub" } } } }
       
       # Members can READ
       { 
         operations: [READ],
         where: { node: { memberUsers_SOME: { externalId: "$jwt.sub" } } }
       }
     ]
   )
   ```

4. **Estimated Size Calculation**  
   ```cypher
   # Counts nodes and properties to estimate DB usage
   MATCH (this)
   OPTIONAL MATCH (this)--(m)
   OPTIONAL MATCH (m)--(n)
   WITH collect(DISTINCT n) + collect(DISTINCT m) + collect(this) AS nodes
   UNWIND nodes AS node
   WITH node, size(keys(node)) AS propertyCount
   RETURN toInteger(count(node) * 40 + sum(propertyCount) * 20) AS estimatedBytes
   ```

**Usage Example:**
```graphql
mutation CreateOrganization {
  createUsers(input: [{
    name: "John Doe"
    email: "john@company.com"
    ownedOrganization: {
      create: {
        node: {
          name: "ACME Corp"
          description: "My organization"
          counter: {
            create: { node: {} }  # Auto-initialized to 0
          }
        }
      }
    }
  }]) {
    users {
      id
      ownedOrganization {
        id
        name
        estimatedSize
      }
    }
  }
}
```

---

### Counter

**Purpose:** Auto-increment sequence for BacklogItem UIDs

```graphql
type Counter {
  id: ID!
  organization: Organization!
  counter: Int!  # Auto-initialized to 0
}
```

**Mutation operations disabled:**
```graphql
@mutation(operations: [])  # Cannot directly create/update/delete
```

**Usage Pattern:**
```typescript
// In resolver: src/graphql/resolvers/create.resolvers.ts
const result = await tx.run(`
  MATCH (user:User {externalId: $uid})-[:OWNS|:MEMBER_OF]->(org:Organization)
        -[:HAS_COUNTER]->(counter)
  SET counter.counter = counter.counter + 1
  RETURN org.id AS orgId, counter.counter AS newCounter
`);

const newCounter = result.records[0].get("newCounter");
const uniqueUid = `${newCounter}-${orgId}`;
```

---

### Status

**Purpose:** Customizable workflow statuses (e.g., "To Do", "In Progress", "Done")

```graphql
type Status implements Timestamped {
  id: ID!
  name: String!           # Display name
  defaultName: String!    # System name (immutable for default statuses)
  color: String!          # Hex color code
  description: String
  position: Int           # Sort order
  default: Boolean!       # System-provided status
  autoSelect: Boolean!    # Auto-select on create
  uniqueStatus: String!   # Composite key: "{orgId}-{defaultName}"
  organization: Organization!
  
  createdAt: DateTime!
  updatedAt: DateTime
}
```

**Key Features:**

1. **Default Statuses**  
   - System creates default statuses on org creation
   - Default statuses cannot be deleted
   - `defaultName` is immutable for default statuses

2. **Unique Constraint**  
   ```graphql
   uniqueStatus: String! @unique
   @populatedBy(callback: "uniqueKeySetter", operations: [CREATE])
   ```
   - Prevents duplicate status names per organization
   - Format: `"{orgId}-{defaultName}"`

3. **Authorization**  
   ```graphql
   @authorization(validate: [
     # Only owner or admins can DELETE
     {
       operations: [DELETE]
       where: {
         node: {
           AND: [
             { default: false }  # Cannot delete default statuses
             { organization: { createdBy: { externalId: "$jwt.sub" } } }
           ]
         }
       }
     }
   ])
   ```

**Usage Example:**
```graphql
mutation CreateCustomStatus {
  createStatuses(input: [{
    name: "Under Review"
    color: "#FFA500"
    position: 2
    organization: {
      connect: { where: { node: { id: "org-123" } } }
    }
  }]) {
    statuses {
      id
      name
      color
      default
    }
  }
}
```

---

### BacklogItemType

**Purpose:** Categorize tasks (e.g., "Bug", "Feature", "Epic")

```graphql
type BacklogItemType implements Timestamped {
  id: ID!
  name: String!
  defaultName: String!
  default: Boolean!
  autoSelect: Boolean!
  uniqueBacklogType: String! @unique
  organization: Organization!
  
  createdAt: DateTime!
  updatedAt: DateTime
}
```

**Similar to Status:**
- Has default types provided by system
- Organization-scoped uniqueness
- Cannot delete default types

---

### RiskLevel

**Purpose:** Classify task risk (e.g., "Low", "Medium", "High")

```graphql
type RiskLevel implements Timestamped {
  id: ID!
  name: String!
  defaultName: String!
  color: String!
  default: Boolean!
  autoSelect: Boolean!
  uniqueRiskLevel: String! @unique
  organization: Organization!
  
  createdAt: DateTime!
  updatedAt: DateTime
}
```

---

### BacklogItem

**Purpose:** Tasks, bugs, features, epics

```graphql
type BacklogItem implements TimestampedCreatable & SoftDeletable {
  # Identity
  id: ID!
  uid: Int!              # Auto-increment within org
  uniqueUid: String!     # "{uid}-{orgId}"
  label: String!
  description: String
  
  # Classification
  type: BacklogItemType!
  status: Status!
  riskLevel: RiskLevel
  priority: Int
  
  # Hierarchy
  parent: BacklogItemParent  # FlowNode or BacklogItem
  childItems: [BacklogItem!]!
  
  # Relationships
  project: Project!
  sprint: Sprint
  assignedUser: [User!]!
  labels: [Label!]!
  comments: [Comment!]!
  dependencies: [BacklogItem!]!  # This depends on...
  dependents: [BacklogItem!]!    # This is depended on by...
  
  # Dates
  startDate: DateTime
  endDate: DateTime
  occuredOn: DateTime
  paidOn: DateTime
  
  # Financial
  projectedExpense: Float
  actualExpense: Float
  
  # Soft delete
  deletedAt: DateTime
  
  # Timestamps
  createdBy: User!
  createdAt: DateTime!
  updatedAt: DateTime
}
```

**Key Features:**

1. **Auto-Increment UID**  
   ```typescript
   // Generated in custom resolver
   uid: 42
   uniqueUid: "42-org-123"
   ```

2. **Hierarchical Structure**  
   ```graphql
   parent: BacklogItemParent @relationship(type: "HAS_CHILD_ITEM", direction: IN)
   childItems: [BacklogItem!]! @relationship(type: "HAS_CHILD_ITEM", direction: OUT)
   ```

3. **Union Type for Parent**  
   ```graphql
   union BacklogItemParent = FlowNode | BacklogItem | Project
   ```

4. **Dependencies**  
   ```graphql
   dependencies: [BacklogItem!]! @relationship(type: "DEPENDS_ON", direction: OUT)
   dependents: [BacklogItem!]! @relationship(type: "DEPENDS_ON", direction: IN)
   ```

**Usage Example:**
```graphql
mutation CreateTask {
  createBacklogItemWithUID(input: {
    label: "Fix login bug"
    description: "Users cannot login on mobile"
    project: { connect: { where: { node: { id: "proj-123" } } } }
    type: { connect: { where: { node: { defaultName: "Bug" } } } }
    status: { connect: { where: { node: { defaultName: "To Do" } } } }
    assignedUser: { connect: { where: { node: { email: "dev@company.com" } } } }
  }) {
    uid
    uniqueUid
    label
  }
}
```

---

### Project

**Purpose:** Container for files, folders, and tasks

```graphql
type Project implements TimestampedCreatable & SoftDeletable {
  id: ID!
  name: String!
  description: String
  uniqueProject: String! @unique
  
  # Relationships
  organization: Organization!
  assignedUsers: [User!]!
  resources: [Resource!]!
  
  # Structure
  folders: [Folder!]!
  files: [File!]!
  backlogItems: [BacklogItem!]!
  sprints: [Sprint!]!
  
  # Settings
  enableSprint: Boolean!
  
  # Soft delete
  deletedAt: DateTime
  
  createdBy: User!
  createdAt: DateTime!
  updatedAt: DateTime
}
```

**Unique Constraint:**
```graphql
uniqueProject: String! @unique
@populatedBy(callback: "uniqueProjectExtractor", operations: [CREATE])
```

Format: `"{orgId}-{projectName}"`

---

### File & Folder

**Purpose:** Organize FlowNodes in hierarchical structure

```graphql
type Folder implements TimestampedCreatable & SoftDeletable {
  id: ID!
  name: String!
  description: String
  
  # Hierarchy
  project: Project!
  parentFolder: Folder
  childFolders: [Folder!]!
  childFiles: [File!]!
  
  deletedAt: DateTime
  createdBy: User!
  createdAt: DateTime!
  updatedAt: DateTime
}

type File implements TimestampedCreatable & SoftDeletable {
  id: ID!
  name: String!
  description: String
  
  # Parent (union)
  parentConnection: FileParentConnection!
  
  # Children
  flowNodes: [FlowNode!]!
  
  deletedAt: DateTime
  createdBy: User!
  createdAt: DateTime!
  updatedAt: DateTime
}
```

**FileParentConnection (Union):**
```graphql
union FileParentConnection = FolderConnection | ProjectConnection

type FolderConnection {
  folder: Folder!
}

type ProjectConnection {
  project: Project!
}
```

---

### FlowNode

**Purpose:** Visual workflow node (contains BacklogItems)

```graphql
type FlowNode implements TimestampedCreatable & SoftDeletable {
  id: ID!
  label: String!
  description: String
  
  # Positioning
  positionX: Float
  positionY: Float
  type: String  # Node type (for ReactFlow)
  
  # Relationships
  file: File!
  childItems: [BacklogItem!]!
  fileGroup: FileGroup  # Optional grouping
  links: [Link!]!       # Connections to other nodes
  
  deletedAt: DateTime
  createdBy: User!
  createdAt: DateTime!
  updatedAt: DateTime
}
```

---

### Sprint

**Purpose:** Time-boxed iteration for agile workflows

```graphql
type Sprint implements TimestampedCreatable & SoftDeletable {
  id: ID!
  name: String!
  goal: String
  uniqueSprint: String! @unique
  
  # Dates
  startDate: DateTime!
  endDate: DateTime!
  
  # Relationships
  project: Project!
  backlogItems: [BacklogItem!]!
  
  deletedAt: DateTime
  createdBy: User!
  createdAt: DateTime!
  updatedAt: DateTime
}
```

**Unique Constraint:**
```graphql
uniqueSprint: String! @unique
@populatedBy(callback: "uniqueSprint", operations: [CREATE])
```

Format: `"{projectId}-{sprintName}"`

---

## Interfaces

### SoftDeletable

```graphql
interface SoftDeletable {
  deletedAt: DateTime
}
```

**Usage:**
- Instead of deleting, set `deletedAt` timestamp
- Queries automatically filter `WHERE deletedAt IS NULL`
- Allows data recovery

### Timestamped

```graphql
interface Timestamped {
  createdAt: DateTime!
  updatedAt: DateTime
}
```

**Auto-populated:**
```graphql
createdAt: DateTime! @timestamp(operations: [CREATE])
updatedAt: DateTime @timestamp(operations: [UPDATE])
```

### TimestampedCreatable

```graphql
interface TimestampedCreatable implements Timestamped {
  createdBy: User!
  createdAt: DateTime!
  updatedAt: DateTime
}
```

**Tracks creator:**
```graphql
createdBy: User! @relationship(type: "CREATED_BY", direction: OUT)
```

---

## Directives Reference

### @id

**Purpose:** Auto-generate unique ID

```graphql
id: ID! @id
```

**Behavior:**
- Generates UUID on creation
- Creates unique constraint in Neo4j
- Cannot be modified

### @unique

**Purpose:** Enforce uniqueness constraint

```graphql
email: String! @unique
```

**Behavior:**
- Creates unique index in Neo4j
- Prevents duplicate values
- Throws error on violation

### @timestamp

**Purpose:** Auto-populate timestamps

```graphql
createdAt: DateTime! @timestamp(operations: [CREATE])
updatedAt: DateTime @timestamp(operations: [UPDATE])
```

**Behavior:**
- Sets current DateTime on specified operations
- Uses Neo4j `datetime()` function

### @populatedBy

**Purpose:** Auto-populate from callback function

```graphql
email: String! @populatedBy(callback: "emailExtractor", operations: [CREATE])
```

**Callback:**
```typescript
// src/graphql/callbacks/populatedByCallbacks.ts
const emailExtractor = (_parent, _args, _context) => {
  return _context?.authorization?.jwt?.email;
};
```

### @authorization

**Purpose:** Field/type-level authorization

```graphql
@authorization(
  validate: [
    {
      operations: [UPDATE]
      where: { node: { externalId: "$jwt.sub" } }
    }
  ]
)
```

**Special variables:**
- `$jwt.sub` - User's Firebase UID
- `$jwt.email` - User's email
- `$jwt.roles` - Array of roles

### @cypher

**Purpose:** Custom Cypher query for field

```graphql
pendingTask(projectId: ID!): Int!
  @cypher(
    statement: "MATCH (p:Project {id: $projectId}) ..."
    columnName: "pendingTask"
  )
```

**Variables available:**
- `this` - Current node
- `$param` - Field arguments
- `$jwt` - JWT context

### @relationship

**Purpose:** Define graph relationship

```graphql
ownedOrganization: Organization
  @relationship(
    type: "OWNS"           # Relationship type in Neo4j
    direction: OUT         # OUT, IN, or none
    aggregate: false       # Enable aggregations
    nestedOperations: [CREATE, CONNECT]
  )
```

### @settable

**Purpose:** Control when field can be set

```graphql
externalId: String!
  @settable(onCreate: true, onUpdate: false)
```

---

## Relationships Explained

### User ← OWNS → Organization

```cypher
(user:User)-[:OWNS]->(org:Organization)
```

- One-to-one
- User creates organization

### User ← MEMBER_OF → Organization

```cypher
(user:User)-[:MEMBER_OF]->(org:Organization)
```

- Many-to-many
- Users can be members of organizations

### Organization ← BELONGS_TO ← Project

```cypher
(org:Organization)<-[:BELONGS_TO]-(project:Project)
```

- One-to-many
- Projects belong to one organization

### Project → HAS_CHILD_FOLDER → Folder

```cypher
(project:Project)-[:HAS_CHILD_FOLDER]->(folder:Folder)
```

- One-to-many
- Projects contain folders

### Folder → HAS_CHILD_FILE → File

```cypher
(folder:Folder)-[:HAS_CHILD_FILE]->(file:File)
```

- One-to-many
- Folders contain files

### File → HAS_FLOW_NODE → FlowNode

```cypher
(file:File)-[:HAS_FLOW_NODE]->(node:FlowNode)
```

- One-to-many
- Files contain flow nodes

### FlowNode → HAS_CHILD_ITEM → BacklogItem

```cypher
(node:FlowNode)-[:HAS_CHILD_ITEM]->(item:BacklogItem)
```

- One-to-many
- Nodes contain tasks

### BacklogItem → DEPENDS_ON → BacklogItem

```cypher
(dependent:BacklogItem)-[:DEPENDS_ON]->(dependency:BacklogItem)
```

- Many-to-many
- Tasks can depend on other tasks

---

## Next Steps

- **[Read Resolvers Guide](./04-RESOLVERS.md)** for custom business logic
- **[Read Auth Guide](./05-AUTH.md)** for authorization patterns
- **[Read Services Guide](./06-SERVICES.md)** for external integrations

---

## Summary

The schema provides:
- ✅ **Type safety** - Strongly typed API
- ✅ **Authorization** - Built-in access control
- ✅ **Soft deletes** - Data recovery
- ✅ **Auto-generation** - Less boilerplate
- ✅ **Flexibility** - Custom Cypher queries
- ✅ **Multi-tenancy** - Organization isolation
