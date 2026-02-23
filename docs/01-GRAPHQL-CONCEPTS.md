# GraphQL Concepts & Setup - Complete Guide

## 📋 Table of Contents
- [What is GraphQL?](#what-is-graphql)
- [GraphQL vs REST](#graphql-vs-rest)
- [Core GraphQL Concepts](#core-graphql-concepts)
- [Schema Definition Language (SDL)](#schema-definition-language-sdl)
- [How GraphQL Works in This Project](#how-graphql-works-in-this-project)
- [Apollo Server Setup](#apollo-server-setup)
- [Making GraphQL Queries](#making-graphql-queries)
- [Real Examples from the Codebase](#real-examples-from-the-codebase)

---

## What is GraphQL?

**GraphQL** is a query language for APIs and a runtime for fulfilling those queries with your existing data. Think of it as a more flexible alternative to REST APIs.

### Key Benefits

1. **Ask for what you need, get exactly that** - No over-fetching or under-fetching
2. **Get many resources in a single request** - Reduce network calls
3. **Strongly typed** - Know exactly what's possible and what's not
4. **Self-documenting** - Schema serves as documentation
5. **Real-time subscriptions** - WebSocket support built-in

### Simple Analogy

**REST**: Like a restaurant with a fixed menu. You order "User Profile" and get everything (name, email, address, preferences, etc.)

**GraphQL**: Like a buffet. You specify exactly what you want: "Give me just the name and email from User Profile"

---

## GraphQL vs REST

### REST API Example

```bash
# Get user
GET /api/users/123
Response: { id, name, email, address, phone, preferences, ... }

# Get user's projects
GET /api/users/123/projects
Response: [{ id, title, createdAt, ... }]

# Get project details
GET /api/projects/456
Response: { id, title, description, members, tasks, ... }
```

**3 requests, lots of unnecessary data**

### GraphQL Example

```graphql
query {
  user(id: "123") {
    name
    email
    projects {
      title
      tasks {
        label
        status {
          name
        }
      }
    }
  }
}
```

**1 request, exactly what you need**

---

## Core GraphQL Concepts

### 1. Schema

The **schema** is the contract between client and server. It defines:
- What data is available
- What operations can be performed
- What types exist

```graphql
type User {
  id: ID!              # ! means required/non-null
  name: String!
  email: String!
  age: Int             # Optional field
  projects: [Project!]!  # Array of Projects (non-null)
}
```

### 2. Types

**Scalar Types** (primitives):
```graphql
String    # Text: "John Doe"
Int       # Integer: 42
Float     # Decimal: 3.14
Boolean   # true/false
ID        # Unique identifier: "abc123"
DateTime  # ISO 8601: "2024-01-07T10:30:00Z"
```

**Object Types** (custom structures):
```graphql
type User {
  id: ID!
  name: String!
}

type Project {
  id: ID!
  title: String!
  owner: User!  # Relationship to User type
}
```

**Enums** (fixed set of values):
```graphql
enum UserRole {
  ADMIN
  USER
  GUEST
}
```

**Interfaces** (shared fields):
```graphql
interface Timestamped {
  createdAt: DateTime!
  updatedAt: DateTime
}

type User implements Timestamped {
  id: ID!
  name: String!
  createdAt: DateTime!
  updatedAt: DateTime
}
```

### 3. Queries (Read Operations)

Queries fetch data without side effects:

```graphql
type Query {
  # Get single user by ID
  user(id: ID!): User
  
  # Get all users with optional filtering
  users(
    where: UserWhere
    options: UserOptions
  ): [User!]!
  
  # Get projects for a user
  userProjects(userId: ID!): [Project!]!
}
```

**Example usage:**
```graphql
query GetUser {
  user(id: "123") {
    name
    email
    projects {
      title
    }
  }
}
```

### 4. Mutations (Write Operations)

Mutations create, update, or delete data:

```graphql
type Mutation {
  # Create new user
  createUsers(input: [UserCreateInput!]!): CreateUsersMutationResponse!
  
  # Update user
  updateUsers(
    where: UserWhere
    update: UserUpdateInput
  ): UpdateUsersMutationResponse!
  
  # Delete user
  deleteUsers(where: UserWhere): DeleteInfo!
}
```

**Example usage:**
```graphql
mutation CreateUser {
  createUsers(
    input: [{
      name: "John Doe"
      email: "john@example.com"
    }]
  ) {
    users {
      id
      name
      email
    }
  }
}
```

### 5. Subscriptions (Real-time)

Subscriptions push data when events occur:

```graphql
type Subscription {
  userCreated: User!
  taskUpdated(projectId: ID!): Task!
}
```

**Example usage:**
```graphql
subscription OnUserCreated {
  userCreated {
    id
    name
    email
  }
}
```

### 6. Directives

Directives add behavior to fields or types:

```graphql
type User {
  id: ID! @id                    # Auto-generate ID
  email: String! @unique         # Must be unique
  createdAt: DateTime! @timestamp(operations: [CREATE])
  
  # Only user themselves can read this field
  ssn: String @authorization(
    validate: [{ where: { node: { id: "$jwt.userId" } } }]
  )
}
```

**Common directives in this project:**
- `@id` - Auto-generate unique ID
- `@unique` - Enforce uniqueness constraint
- `@timestamp` - Auto-populate timestamps
- `@authorization` - Field-level permissions
- `@relationship` - Define graph relationships
- `@cypher` - Custom Cypher queries
- `@populatedBy` - Auto-populate from callbacks

---

## Schema Definition Language (SDL)

SDL is the syntax for defining GraphQL schemas.

### Basic Type Definition

```graphql
type User {
  # Fields
  id: ID!              # Required ID
  name: String!        # Required String
  age: Int             # Optional Int
  email: String!       # Required String
  
  # Relationships
  organization: Organization!
  projects: [Project!]!
  
  # Computed fields
  fullName: String!
  projectCount: Int!
}
```

### Field Arguments

```graphql
type User {
  # Field with arguments
  tasks(
    status: String
    limit: Int = 10        # Default value
    offset: Int = 0
  ): [Task!]!
}
```

**Usage:**
```graphql
query {
  user(id: "123") {
    tasks(status: "ACTIVE", limit: 5) {
      title
    }
  }
}
```

### Input Types (for mutations)

```graphql
input UserCreateInput {
  name: String!
  email: String!
  age: Int
}

input UserUpdateInput {
  name: String
  email: String
  age: Int
}

type Mutation {
  createUser(input: UserCreateInput!): User!
  updateUser(id: ID!, input: UserUpdateInput!): User!
}
```

---

## How GraphQL Works in This Project

### The Flow

```
Client Request
    ↓
Apollo Server (receives GraphQL query)
    ↓
Authentication Middleware (validates JWT)
    ↓
Authorization Checks (@authorization directives)
    ↓
Resolvers (custom or auto-generated)
    ↓
Neo4j GraphQL Library (generates Cypher)
    ↓
Neo4j Database (executes Cypher)
    ↓
Response (formatted data)
    ↓
Client
```

### Auto-Generated vs Custom Resolvers

**Auto-Generated** (by @neo4j/graphql):
```graphql
type User {
  id: ID! @id
  name: String!
  email: String!
}
```

Automatically creates:
- `users(where: UserWhere): [User!]!` query
- `createUsers(input: [UserCreateInput!]!): CreateUsersMutationResponse!`
- `updateUsers(where: UserWhere, update: UserUpdateInput): UpdateUsersMutationResponse!`
- `deleteUsers(where: UserWhere): DeleteInfo!`

**Custom Resolvers** (in `resolvers/*.ts`):
```graphql
type Query {
  generateTasksWithAI(input: GenerateTaskInput!): [GeneratedTask!]!
}
```

Requires custom implementation in `read.resolvers.ts`:
```typescript
const generateTasksWithAI = async (_source, { input }, _context) => {
  // Custom logic here
  const result = await openai.chat.completions.create({...});
  return processedTasks;
};
```

---

## Apollo Server Setup

### File: `src/graphql/init/apollo.init.ts`

```typescript
import { ApolloServer } from "@apollo/server";
import { expressMiddleware } from "@apollo/server/express4";

export const initializeApolloServer = async (httpServer) => {
  // 1. Get Neo4j connection
  const neo4jInstance = await Neo4JConnection.getInstance();

  // 2. Create Neo4j GraphQL instance with schema
  const neoInstance = new NeoConnection(
    typeDefs,              // GraphQL schema
    neo4jInstance.driver,  // Neo4j driver
    features,              // Feature flags
    resolvers              // Custom resolvers
  );
  
  // 3. Generate executable schema
  const schema = await neoInstance.init();

  // 4. Initialize OGM (Object Graph Mapper)
  await OGMConnection.init(typeDefs, driver, features);

  // 5. Setup WebSocket for subscriptions
  const wsServer = new WebSocketServer({
    server: httpServer,
    path: "/api/graphql",
  });

  // 6. Create Apollo Server
  const server = new ApolloServer({
    schema,
    introspection: !isProduction(),  // Enable GraphQL playground
    plugins: [
      ApolloServerPluginDrainHttpServer({ httpServer }),
      // ... other plugins
    ],
    formatError: errorHandling,
  });

  // 7. Start server
  await server.start();

  // 8. Apply middleware to Express
  router.use(
    "/graphql",
    expressMiddleware(server, {
      context: async ({ req }) => {
        return await NeoConnection.authorizeUserOnContext(req);
      },
    })
  );

  return router;
};
```

### Context (Authentication)

Every GraphQL request has a **context** object with user info:

```typescript
// File: src/graphql/init/neo.init.ts
static async authorizeUserOnContext(req: Request) {
  const token = getTokenFromHeader(req.headers.authorization);
  
  if (!token) {
    throw new GraphQLError("Authentication token is required");
  }

  // Verify Firebase token
  const decodedToken = await getFirebaseAdminAuth()
    .auth()
    .verifyIdToken(token, true);

  if (!decodedToken?.email_verified) {
    throw new GraphQLError("Please verify your email first.");
  }

  // Return user info in context
  return { jwt: decodedToken };
}
```

Now `$jwt.sub`, `$jwt.email`, etc. are available in authorization rules!

---

## Making GraphQL Queries

### Using GraphQL Playground

When running in development, visit: `http://localhost:4000/api/v1/graphql`

### Query Structure

```graphql
# Operation type and name
query GetUserProjects {
  # Root field
  users(
    # Arguments
    where: { email: "john@example.com" }
  ) {
    # Selection set (fields you want)
    id
    name
    email
    
    # Nested selection
    projects {
      id
      title
      tasks {
        label
        status {
          name
        }
      }
    }
  }
}
```

### Variables

Instead of hardcoding values:

```graphql
# Query with variable
query GetUser($userId: ID!) {
  user(id: $userId) {
    name
    email
  }
}
```

```json
// Variables (sent separately)
{
  "userId": "123"
}
```

### Fragments (Reusable selections)

```graphql
fragment UserInfo on User {
  id
  name
  email
}

query GetUsers {
  users {
    ...UserInfo
    projects {
      title
    }
  }
}
```

---

## Real Examples from the Codebase

### Example 1: Create User with Organization

```graphql
mutation CreateOrgOwner {
  createUsers(
    input: [{
      name: "John Doe"
      email: "john@company.com"
      phoneNumber: "+1234567890"
      
      # Nested create!
      ownedOrganization: {
        create: {
          node: {
            name: "ACME Corp"
            description: "My company"
          }
        }
      }
    }]
  ) {
    users {
      id
      name
      email
      ownedOrganization {
        id
        name
        counter {
          counter
        }
      }
    }
  }
}
```

**What happens behind the scenes:**
1. Creates User node
2. Creates Organization node
3. Creates Counter node for organization
4. Creates OWNS relationship: User→Organization
5. Creates HAS_COUNTER relationship: Organization→Counter
6. Returns nested data

### Example 2: Query with Filtering

```graphql
query GetActiveProjects {
  projects(
    where: {
      deletedAt: null
      status: "ACTIVE"
      organization: {
        createdBy: {
          externalId: "firebase-uid-123"
        }
      }
    }
    options: {
      sort: [{ createdAt: DESC }]
      limit: 10
    }
  ) {
    id
    name
    description
    createdAt
    memberUsers {
      name
      email
    }
  }
}
```

**Generated Cypher (simplified):**
```cypher
MATCH (project:Project)
WHERE project.deletedAt IS NULL
  AND project.status = 'ACTIVE'
  AND EXISTS {
    MATCH (project)<-[:BELONGS_TO]-(org:Organization)
          <-[:OWNS]-(user:User)
    WHERE user.externalId = 'firebase-uid-123'
  }
WITH project
ORDER BY project.createdAt DESC
LIMIT 10
RETURN project {
  .id,
  .name,
  .description,
  .createdAt,
  memberUsers: [(project)-[:HAS_MEMBER]->(user:User) | user { .name, .email }]
}
```

### Example 3: Custom Cypher Field

From schema:
```graphql
type User {
  pendingTask(projectId: ID!): Int!
    @cypher(
      statement: """
      MATCH (p:Project {id: $projectId})
      WHERE p.deletedAt IS NULL
      
      // Complex traversal to find all backlog items
      CALL {
        WITH p
        MATCH path=(p)-[:HAS_CHILD_ITEM*1..5]->(bi:BacklogItem)
        WHERE bi.deletedAt IS NULL
        RETURN DISTINCT bi
      }
      
      // Filter by assigned user
      WITH DISTINCT bi
      WHERE EXISTS {
        MATCH (bi)-[:HAS_ASSIGNED_USER]->(this)
      }
      
      // Filter by status
      MATCH (bi)-[:HAS_STATUS]->(s:Status)
      WHERE toLower(s.defaultName) <> 'completed'
      
      RETURN COUNT(DISTINCT bi) AS pendingTask
      """
      columnName: "pendingTask"
    )
}
```

**Usage:**
```graphql
query {
  user(id: "123") {
    name
    pendingTask(projectId: "proj-456")
    completedTask(projectId: "proj-456")
  }
}
```

### Example 4: Authorization in Action

```graphql
type BacklogItem
  @authorization(
    validate: [
      {
        operations: [UPDATE]
        where: {
          node: {
            project: {
              organization: {
                OR: [
                  { createdBy: { externalId: "$jwt.sub" } }
                  { memberUsers_SINGLE: { externalId: "$jwt.sub" } }
                ]
              }
            }
          }
        }
      }
    ]
  )
{
  id: ID!
  label: String!
  project: Project!
}
```

**What this means:**
- User can UPDATE a BacklogItem only if:
  - They own the organization (createdBy matches $jwt.sub), OR
  - They are a member of the organization

**If authorization fails:**
```json
{
  "errors": [{
    "message": "Forbidden",
    "extensions": {
      "code": "FORBIDDEN"
    }
  }]
}
```

---

## Advanced GraphQL Features

### 1. Aliases

Query same field with different arguments:

```graphql
query {
  activeProjects: projects(where: { status: "ACTIVE" }) {
    id
    title
  }
  
  completedProjects: projects(where: { status: "COMPLETED" }) {
    id
    title
  }
}
```

### 2. Inline Fragments (Polymorphic queries)

```graphql
query {
  search(text: "project") {
    ... on Project {
      title
      description
    }
    ... on BacklogItem {
      label
      status {
        name
      }
    }
  }
}
```

### 3. Pagination

```graphql
query GetProjectsWithPagination {
  projects(
    options: {
      limit: 10
      offset: 20
      sort: [{ createdAt: DESC }]
    }
  ) {
    id
    title
  }
  
  projectsAggregate {
    count
  }
}
```

---

## Best Practices

### 1. Name Your Operations

❌ Bad:
```graphql
query {
  users { name }
}
```

✅ Good:
```graphql
query GetAllUsers {
  users { name }
}
```

### 2. Use Fragments for Complex Types

❌ Bad:
```graphql
query {
  user(id: "123") {
    id
    name
    email
    organization {
      id
      name
    }
  }
  
  anotherUser: user(id: "456") {
    id
    name
    email
    organization {
      id
      name
    }
  }
}
```

✅ Good:
```graphql
fragment UserDetails on User {
  id
  name
  email
  organization {
    id
    name
  }
}

query {
  user(id: "123") {
    ...UserDetails
  }
  
  anotherUser: user(id: "456") {
    ...UserDetails
  }
}
```

### 3. Use Variables for Dynamic Values

❌ Bad:
```graphql
mutation {
  createUsers(input: [{ name: "John", email: "john@example.com" }]) {
    users { id }
  }
}
```

✅ Good:
```graphql
mutation CreateUser($input: [UserCreateInput!]!) {
  createUsers(input: $input) {
    users { id }
  }
}
```

### 4. Request Only What You Need

❌ Bad (over-fetching):
```graphql
query {
  users {
    id
    name
    email
    phoneNumber
    address
    preferences
    settings
    organization {
      id
      name
      description
      settings
      members {
        id
        name
        email
        # ... etc
      }
    }
  }
}
```

✅ Good:
```graphql
query {
  users {
    id
    name
    email
  }
}
```

---

## Common Errors & Solutions

### Error: "Field not found"
```json
{
  "errors": [{
    "message": "Cannot query field 'username' on type 'User'."
  }]
}
```

**Solution:** Check schema - field might be named `name` not `username`

### Error: "Authentication required"
```json
{
  "errors": [{
    "message": "Authentication token is required",
    "extensions": { "code": "UNAUTHENTICATED" }
  }]
}
```

**Solution:** Include JWT token in headers:
```http
Authorization: Bearer <your-firebase-token>
```

### Error: "Forbidden"
```json
{
  "errors": [{
    "message": "Forbidden",
    "extensions": { "code": "FORBIDDEN" }
  }]
}
```

**Solution:** Check `@authorization` rules - you might not have permission

---

## Testing GraphQL Queries

### Using cURL

```bash
curl -X POST http://localhost:4000/api/v1/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{
    "query": "query { users { id name } }"
  }'
```

### Using Postman

1. Create POST request to `http://localhost:4000/api/v1/graphql`
2. Headers:
   - `Content-Type: application/json`
   - `Authorization: Bearer <token>`
3. Body (raw JSON):
```json
{
  "query": "query GetUsers { users { id name email } }",
  "variables": {}
}
```

### Using GraphQL Playground (Development)

1. Visit `http://localhost:4000/api/v1/graphql`
2. Click "HTTP HEADERS" at bottom
3. Add:
```json
{
  "Authorization": "Bearer <your-token>"
}
```
4. Write query in left pane
5. Click play button

---

## Next Steps

- **[Read Neo4j & Cypher Guide](./02-NEO4J-CYPHER.md)** to understand the database
- **[Read Schema Documentation](./03-SCHEMA-TYPES.md)** to see all available types
- **[Read Resolvers Guide](./04-RESOLVERS.md)** to understand custom logic

---

## Summary

GraphQL gives you:
- ✅ **Precise data fetching** - Get exactly what you need
- ✅ **Single endpoint** - `/api/v1/graphql` for everything
- ✅ **Strongly typed** - Know what's possible
- ✅ **Self-documenting** - Schema is the documentation
- ✅ **Real-time** - Subscriptions for live updates
- ✅ **Efficient** - Reduce network calls

With Neo4j GraphQL, you get:
- ✅ **Auto-generated CRUD** - Less code to write
- ✅ **Complex relationships** - Graph database power
- ✅ **Custom Cypher** - Full database control
- ✅ **Authorization** - Built into schema
