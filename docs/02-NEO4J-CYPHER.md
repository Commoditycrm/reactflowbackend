# Neo4j & Cypher - Complete Database Guide

## 📋 Table of Contents
- [What is Neo4j?](#what-is-neo4j)
- [Graph Database Concepts](#graph-database-concepts)
- [Cypher Query Language](#cypher-query-language)
- [Neo4j in This Project](#neo4j-in-this-project)
- [Common Patterns](#common-patterns)
- [Real Examples from Codebase](#real-examples-from-codebase)
- [Performance & Optimization](#performance--optimization)

---

## What is Neo4j?

**Neo4j** is a **graph database** - it stores data as a graph of nodes and relationships, not tables and rows.

### Why Graph Database?

**Perfect for:**
- ✅ Complex relationships (social networks, org charts)
- ✅ Deep hierarchies (folder structures, dependencies)
- ✅ Recommendation engines
- ✅ Fraud detection
- ✅ Network analysis

**Your Project Example:**
```
Organization → Projects → Folders → Files → FlowNodes → BacklogItems
      ↓
    Users (members)
      ↓
  Permissions
```

This complex web of relationships is **natural** in Neo4j, awkward in SQL.

---

## Graph Database Concepts

### 1. Nodes (Vertices)

Nodes represent **entities** - like rows in a table, but richer.

**Example:**
```
(:User {
  id: "123",
  name: "John Doe",
  email: "john@example.com",
  role: "ADMIN"
})
```

**Components:**
- `User` = **Label** (like table name)
- `{...}` = **Properties** (like columns)

**Multiple Labels:**
```
(:User:Employee:Manager {
  id: "123",
  name: "John"
})
```

### 2. Relationships (Edges)

Relationships **connect** nodes and can have properties.

**Example:**
```
(user:User)-[:OWNS {since: "2024-01-01"}]->(org:Organization)
```

**Components:**
- `OWNS` = **Type** (relationship name)
- `{since: ...}` = **Properties** (optional)
- `->` = **Direction** (one-way relationship)

**Bi-directional:**
```
(user)-[:FRIENDS_WITH]-(other)  # No arrow = both directions
```

### 3. Paths

A **path** is a sequence of connected nodes and relationships.

```
(user:User)-[:OWNS]->(org:Organization)<-[:MEMBER_OF]-(member:User)
```

This reads: "User owns Organization, which has members"

### 4. Properties

Both nodes and relationships can have properties:

**Node properties:**
```
(:Project {
  id: "proj-123",
  name: "My Project",
  createdAt: "2024-01-07T10:00:00Z",
  deletedAt: null
})
```

**Relationship properties:**
```
(user)-[:ASSIGNED_TO {
  assignedAt: "2024-01-07",
  role: "Developer"
}]->(task)
```

---

## Cypher Query Language

**Cypher** is Neo4j's query language - think SQL for graphs.

### Basic Syntax

Cypher uses **ASCII art** to represent patterns:

```cypher
(node)              # Node
[relationship]      # Relationship
(a)-[r]->(b)       # Pattern: a related to b
```

### 1. CREATE - Create Nodes & Relationships

**Create a node:**
```cypher
CREATE (u:User {
  id: "123",
  name: "John Doe",
  email: "john@example.com"
})
RETURN u
```

**Create relationship:**
```cypher
MATCH (u:User {id: "123"})
MATCH (o:Organization {id: "org-456"})
CREATE (u)-[:MEMBER_OF]->(o)
```

**Create everything at once:**
```cypher
CREATE (u:User {name: "John"})-[:OWNS]->(o:Organization {name: "ACME Corp"})
RETURN u, o
```

### 2. MATCH - Find Patterns

**Find all users:**
```cypher
MATCH (u:User)
RETURN u
```

**Find user by email:**
```cypher
MATCH (u:User {email: "john@example.com"})
RETURN u
```

**Find with WHERE:**
```cypher
MATCH (u:User)
WHERE u.age > 25 AND u.role = "ADMIN"
RETURN u.name, u.email
```

**Find relationships:**
```cypher
MATCH (u:User)-[:OWNS]->(o:Organization)
RETURN u.name, o.name
```

**Find indirect relationships:**
```cypher
MATCH (u:User)-[:OWNS]->(org:Organization)<-[:MEMBER_OF]-(member:User)
RETURN u.name AS owner, member.name AS member
```

### 3. WHERE - Filtering

**Basic conditions:**
```cypher
MATCH (u:User)
WHERE u.age >= 18 AND u.email ENDS WITH "@company.com"
RETURN u
```

**NULL checks:**
```cypher
MATCH (p:Project)
WHERE p.deletedAt IS NULL
RETURN p
```

**Relationship existence:**
```cypher
MATCH (u:User)
WHERE EXISTS {
  MATCH (u)-[:OWNS]->(org:Organization)
}
RETURN u
```

**NOT EXISTS:**
```cypher
MATCH (u:User)
WHERE NOT EXISTS {
  MATCH (u)-[:MEMBER_OF]->(:Organization)
}
RETURN u  # Users not in any organization
```

### 4. SET - Update Properties

**Update single property:**
```cypher
MATCH (u:User {id: "123"})
SET u.lastLogin = datetime()
RETURN u
```

**Update multiple:**
```cypher
MATCH (u:User {id: "123"})
SET u.name = "Jane Doe",
    u.updatedAt = datetime()
RETURN u
```

**Add label:**
```cypher
MATCH (u:User {id: "123"})
SET u:PremiumUser
RETURN u
```

### 5. DELETE & REMOVE

**Delete node:**
```cypher
MATCH (u:User {id: "123"})
DELETE u
```

**Delete relationship:**
```cypher
MATCH (u:User)-[r:MEMBER_OF]->(org:Organization)
WHERE u.id = "123"
DELETE r
```

**Soft delete (set property):**
```cypher
MATCH (u:User {id: "123"})
SET u.deletedAt = datetime()
RETURN u
```

**DETACH DELETE (delete node and all relationships):**
```cypher
MATCH (u:User {id: "123"})
DETACH DELETE u
```

**REMOVE (remove property or label):**
```cypher
MATCH (u:User {id: "123"})
REMOVE u.phoneNumber, u:PremiumUser
RETURN u
```

### 6. RETURN - Shape Results

**Return nodes:**
```cypher
MATCH (u:User)
RETURN u
```

**Return specific properties:**
```cypher
MATCH (u:User)
RETURN u.name, u.email
```

**Return with alias:**
```cypher
MATCH (u:User)
RETURN u.name AS userName, u.email AS userEmail
```

**Return object projection:**
```cypher
MATCH (u:User)
RETURN u {
  .id,
  .name,
  .email
}
```

**Return nested:**
```cypher
MATCH (u:User)-[:OWNS]->(o:Organization)
RETURN u {
  .name,
  organization: o { .id, .name }
}
```

### 7. ORDER BY, LIMIT, SKIP

```cypher
MATCH (u:User)
WHERE u.deletedAt IS NULL
RETURN u
ORDER BY u.createdAt DESC
LIMIT 10
SKIP 20
```

### 8. WITH - Chaining & Aggregation

**WITH is like piping results:**

```cypher
MATCH (u:User)-[:OWNS]->(o:Organization)
WITH u, count(o) AS orgCount
WHERE orgCount > 1
RETURN u.name, orgCount
```

**Collecting:**
```cypher
MATCH (u:User)-[:OWNS]->(o:Organization)
WITH u, collect(o.name) AS orgNames
RETURN u.name, orgNames
```

### 9. Aggregation Functions

```cypher
MATCH (u:User)
RETURN 
  count(u) AS totalUsers,
  avg(u.age) AS averageAge,
  min(u.createdAt) AS firstCreated,
  max(u.createdAt) AS lastCreated
```

**Group by (implicit with RETURN):**
```cypher
MATCH (u:User)-[:MEMBER_OF]->(o:Organization)
RETURN o.name, count(u) AS memberCount
ORDER BY memberCount DESC
```

### 10. CALL - Subqueries

**CALL for complex logic:**
```cypher
MATCH (p:Project)
CALL {
  WITH p
  MATCH (p)-[:HAS_CHILD_FILE]->(f:File)
  WHERE f.deletedAt IS NULL
  RETURN count(f) AS fileCount
}
RETURN p.name, fileCount
```

**UNION in CALL:**
```cypher
CALL {
  MATCH (u:User {role: "ADMIN"})
  RETURN u
  
  UNION
  
  MATCH (u:User {role: "SUPER_USER"})
  RETURN u
}
RETURN u.name
```

---

## Neo4j in This Project

### Connection Setup

**File: `src/database/connection.ts`**

```typescript
export class Neo4JConnection {
  private static instance: Neo4JConnection;
  public driver!: Driver;

  private constructor() {}

  public static async getInstance(): Promise<Neo4JConnection> {
    if (!Neo4JConnection.instance) {
      const conn = new Neo4JConnection();

      // Create driver with optimized settings
      conn.driver = neo4j.driver(
        conn.neo4jUri,
        neo4j.auth.basic(conn.neo4jUser, conn.neo4jPassword),
        {
          maxConnectionPoolSize: 100,        // Handle high concurrency
          maxConnectionLifetime: 3600000,    // 1 hour
          connectionAcquisitionTimeout: 60000,
          fetchSize: 2000,                   // Large fetch for performance
          disableLosslessIntegers: true,     // Use JS numbers
          connectionTimeout: 30000
        }
      );

      // Test connection
      const session = conn.driver.session();
      await session.run("RETURN 1", {}, { timeout: 10000 });
      await session.close();

      Neo4JConnection.instance = conn;
    }
    return Neo4JConnection.instance;
  }
}
```

### How GraphQL Uses Neo4j

**The flow:**
```
GraphQL Query
    ↓
Neo4j GraphQL Library (@neo4j/graphql)
    ↓
Cypher Query Generation
    ↓
Neo4j Driver
    ↓
Neo4j Database
```

**Example:**

GraphQL:
```graphql
query {
  users(where: { email: "john@example.com" }) {
    name
    email
    projects {
      title
    }
  }
}
```

Generated Cypher:
```cypher
MATCH (this:User)
WHERE this.email = $param0
  AND this.deletedAt IS NULL
RETURN this {
  .name,
  .email,
  projects: [
    (this)-[:MEMBER_OF]->(:Organization)<-[:BELONGS_TO]-(project:Project) |
    project { .title }
  ]
} AS this
```

---

## Common Patterns

### Pattern 1: Variable-Length Paths

**Find all descendants:**
```cypher
MATCH (folder:Folder)-[:HAS_CHILD_FOLDER*1..5]->(child:Folder)
WHERE folder.id = "root-folder"
RETURN child
```

**Explanation:**
- `*1..5` = 1 to 5 hops (levels deep)
- `*` = any length
- `*3` = exactly 3 hops

**Real example from codebase:**
```cypher
MATCH path=(p:Project)-[:HAS_CHILD_FOLDER*1..5]->(:Folder)-[:HAS_CHILD_FILE]->(file:File)
WHERE file.deletedAt IS NULL
  AND ALL(x IN nodes(path) WHERE NOT x:Folder OR x.deletedAt IS NULL)
RETURN file
```

### Pattern 2: Soft Delete with ALL

**Ensure entire path is not deleted:**
```cypher
MATCH path=(root:Project)-[:HAS_CHILD_FOLDER*]->(folder:Folder)
WHERE root.id = $projectId
  AND ALL(node IN nodes(path) WHERE node.deletedAt IS NULL)
RETURN folder
```

### Pattern 3: Optional Matching

**Get users with optional organization:**
```cypher
MATCH (u:User)
OPTIONAL MATCH (u)-[:MEMBER_OF]->(o:Organization)
WHERE o.deletedAt IS NULL
RETURN u, o
```

### Pattern 4: Collecting Lists

**Get user with all their projects:**
```cypher
MATCH (u:User)
OPTIONAL MATCH (u)-[:MEMBER_OF]->(org:Organization)<-[:BELONGS_TO]-(p:Project)
WHERE p.deletedAt IS NULL
WITH u, collect(DISTINCT p) AS projects
RETURN u {
  .id,
  .name,
  projectList: [proj IN projects | proj { .id, .title }]
}
```

### Pattern 5: Counting Relationships

**Get project with task count:**
```cypher
MATCH (p:Project)
OPTIONAL MATCH (p)-[:HAS_CHILD_ITEM*]->(task:BacklogItem)
WHERE task.deletedAt IS NULL
WITH p, count(DISTINCT task) AS taskCount
RETURN p { .id, .name, taskCount }
```

### Pattern 6: APOC Functions

**APOC** (Awesome Procedures On Cypher) extends Cypher with utilities:

```cypher
// Convert to set (remove duplicates)
RETURN apoc.coll.toSet([1, 2, 2, 3]) AS unique
// Result: [1, 2, 3]

// Flatten nested arrays
RETURN apoc.coll.flatten([[1, 2], [3, 4]]) AS flat
// Result: [1, 2, 3, 4]

// Date formatting
RETURN apoc.date.format(timestamp(), 'ms', 'yyyy-MM-dd') AS date
```

---

## Real Examples from Codebase

### Example 1: Get Pending Tasks (Complex Traversal)

**File: `src/graphql/schema/schema.ts`**

```cypher
# Find all BacklogItems assigned to user that are not completed

MATCH (p:Project {id: $projectId})
WHERE p.deletedAt IS NULL

# Step 1: Find all FlowNodes in project (files at any depth)
CALL {
  WITH p
  
  # Direct files under project
  OPTIONAL MATCH (p)-[:HAS_CHILD_FILE]->(file:File)-[:HAS_FLOW_NODE]->(n:FlowNode)
  WHERE file.deletedAt IS NULL AND n.deletedAt IS NULL

  # Files in nested folders (up to 5 levels)
  OPTIONAL MATCH path=(p)-[:HAS_CHILD_FOLDER*1..5]->(:Folder)-[:HAS_CHILD_FILE]->(file2:File)-[:HAS_FLOW_NODE]->(n2:FlowNode)
  WHERE file2.deletedAt IS NULL 
    AND n2.deletedAt IS NULL
    AND ALL(x IN nodes(path) WHERE NOT x:Folder OR x.deletedAt IS NULL)

  # Combine and deduplicate
  RETURN apoc.coll.toSet(collect(DISTINCT n) + collect(DISTINCT n2)) AS nodes
}

# Step 2: Find all BacklogItems under FlowNodes or directly under Project
CALL {
  WITH p, nodes

  # BacklogItems under FlowNodes (nested up to 5 levels)
  UNWIND nodes AS n
  MATCH pathBI = (n)-[:HAS_CHILD_ITEM*1..5]->(bi:BacklogItem)-[:ITEM_IN_PROJECT]->(p)
  WHERE bi.deletedAt IS NULL
    AND ALL(x IN nodes(pathBI) WHERE NOT x:BacklogItem OR x.deletedAt IS NULL)
  RETURN DISTINCT bi

  UNION

  # BacklogItems directly under Project
  WITH p
  MATCH pathBI = (p)-[:HAS_CHILD_ITEM*1..5]->(bi:BacklogItem)-[:ITEM_IN_PROJECT]->(p)
  WHERE bi.deletedAt IS NULL
    AND ALL(x IN nodes(pathBI) WHERE NOT x:BacklogItem OR x.deletedAt IS NULL)
  RETURN DISTINCT bi
}

# Step 3: Filter by assigned user
WITH DISTINCT bi, this
WHERE EXISTS {
  MATCH (bi)-[:HAS_ASSIGNED_USER]->(u:User)
  WHERE u.externalId = this.externalId
}

# Step 4: Filter by status (not completed)
MATCH (bi)-[:HAS_STATUS]->(s:Status)
WHERE toLower(coalesce(s.defaultName, s.name, "")) <> 'completed'

# Step 5: Count
RETURN COUNT(DISTINCT bi) AS pendingTask
```

**Breakdown:**
1. **CALL subquery #1**: Find all FlowNodes in project (handling nested folders)
2. **CALL subquery #2**: Find all BacklogItems (under FlowNodes or Project)
3. **EXISTS filter**: Only items assigned to current user
4. **Status filter**: Exclude completed tasks
5. **COUNT**: Return total

### Example 2: Create BacklogItem with Auto-Increment UID

**File: `src/graphql/resolvers/create.resolvers.ts`**

```typescript
const createBacklogItemWithUID = async (_source, { input }, _context) => {
  const session = driver.session();
  
  try {
    const tx = session.beginTransaction();

    // Step 1: Increment organization counter
    const orgCounterResult = await tx.run(`
      MATCH (user:User {externalId: $externalId})
            -[:OWNS|:MEMBER_OF]->(org:Organization)
            -[:HAS_COUNTER]->(counter)
      SET counter.counter = counter.counter + 1
      RETURN org.id AS orgId, counter.counter AS newCounter
    `, { externalId: _context.jwt.sub });

    const orgId = orgCounterResult.records[0].get("orgId");
    const newCounter = orgCounterResult.records[0].get("newCounter");

    // Step 2: Create BacklogItem with generated UID
    const createdBacklogItem = await BacklogItem.create({
      input: { 
        ...input, 
        uid: newCounter,                    // Auto-increment
        uniqueUid: `${newCounter}-${orgId}` // Unique across all orgs
      },
      context: { executionContext: tx },
      // ... selection set
    });

    await tx.commit();
    return createdBacklogItem;
  } catch (error) {
    await tx.rollback();
    throw error;
  } finally {
    await session.close();
  }
};
```

### Example 3: Clone Project with All Relationships

**File: `src/database/constants.ts`**

```typescript
export const CREATE_PROJECT_FROM_TEMPLATE = `
  # Find source project
  MATCH (source:Project {id: $sourceProjectId})
  WHERE source.deletedAt IS NULL
  
  # Create new project
  CREATE (newProject:Project)
  SET newProject = source,
      newProject.id = randomUUID(),
      newProject.name = $newName,
      newProject.createdAt = datetime(),
      newProject.updatedAt = null,
      newProject.deletedAt = null
  
  WITH source, newProject
  
  # Copy organization relationship
  MATCH (source)-[:BELONGS_TO]->(org:Organization)
  CREATE (newProject)-[:BELONGS_TO]->(org)
  
  # Copy root files
  CALL {
    WITH source, newProject
    ${CLONE_ROOT_FILES}
  }
  
  # Copy folders (recursive)
  CALL {
    WITH source, newProject
    ${CLONE_SUB_FOLDERS}
  }
  
  # Copy backlog items
  CALL {
    WITH source, newProject
    ${CLONE_BACKLOGITEM}
  }
  
  RETURN newProject
`;
```

### Example 4: Dependency Management

**Link dependent tasks:**
```cypher
# File: src/database/constants.ts
export const CONNECT_DEPENDENCY_CQL = `
  MATCH (dependent:BacklogItem {id: $dependentId})
  MATCH (dependency:BacklogItem {id: $dependencyId})
  
  # Prevent circular dependencies
  WHERE NOT EXISTS {
    MATCH path=(dependency)-[:DEPENDS_ON*]->(dependent)
  }
  
  # Create dependency relationship
  MERGE (dependent)-[:DEPENDS_ON]->(dependency)
  
  RETURN dependent, dependency
`;
```

**Update dependent task dates:**
```cypher
# When dependency date changes, update dependents
MATCH (dependency:BacklogItem {id: $taskId})
MATCH (dependent:BacklogItem)-[:DEPENDS_ON*]->(dependency)

# Calculate new dates based on dependency chain
WITH dependent, dependency
WHERE dependency.endDate IS NOT NULL

SET dependent.startDate = 
  CASE 
    WHEN dependent.startDate < dependency.endDate 
    THEN dependency.endDate
    ELSE dependent.startDate
  END,
  dependent.updatedAt = datetime()

RETURN collect(dependent) AS updatedTasks
```

---

## Performance & Optimization

### 1. Indexes

**Auto-created by @neo4j/graphql:**
```cypher
# For @id fields
CREATE CONSTRAINT user_id IF NOT EXISTS
FOR (u:User) REQUIRE u.id IS UNIQUE

# For @unique fields
CREATE CONSTRAINT user_email IF NOT EXISTS
FOR (u:User) REQUIRE u.email IS UNIQUE
```

**Check existing indexes:**
```cypher
SHOW INDEXES
```

**Create custom index:**
```cypher
CREATE INDEX user_role IF NOT EXISTS
FOR (u:User) ON (u.role)
```

### 2. Query Profiling

**EXPLAIN (plan without executing):**
```cypher
EXPLAIN
MATCH (u:User)-[:OWNS]->(o:Organization)
RETURN u, o
```

**PROFILE (plan + execution stats):**
```cypher
PROFILE
MATCH (u:User)-[:OWNS]->(o:Organization)
RETURN u, o
```

Look for:
- `db hits` - lower is better
- `rows` - how many records processed
- `NodeByLabelScan` - good
- `AllNodesScan` - bad (add index!)

### 3. Best Practices

**✅ Use parameters (prevent injection):**
```cypher
MATCH (u:User {email: $email})  # Good
RETURN u

# vs
MATCH (u:User {email: "user@example.com"})  # Bad (not parameterized)
```

**✅ Filter early:**
```cypher
# Good - filter first
MATCH (u:User)
WHERE u.deletedAt IS NULL
MATCH (u)-[:OWNS]->(o:Organization)
RETURN u, o

# Bad - filter late
MATCH (u:User)-[:OWNS]->(o:Organization)
WHERE u.deletedAt IS NULL
RETURN u, o
```

**✅ Use LIMIT:**
```cypher
MATCH (u:User)
RETURN u
LIMIT 100  # Always limit in production
```

**✅ Avoid Cartesian products:**
```cypher
# Bad - creates cartesian product
MATCH (u:User), (o:Organization)
WHERE u.orgId = o.id
RETURN u, o

# Good - use relationship
MATCH (u:User)-[:MEMBER_OF]->(o:Organization)
RETURN u, o
```

### 4. Connection Pooling

**From connection.ts:**
```typescript
{
  maxConnectionPoolSize: 100,              // Max concurrent connections
  maxConnectionLifetime: 3600000,          // Recycle after 1 hour
  connectionAcquisitionTimeout: 60000,     // Wait up to 60s for connection
  fetchSize: 2000,                         // Fetch 2000 records at a time
  connectionTimeout: 30000                 // Connect timeout 30s
}
```

### 5. Monitoring Queries

**Log slow queries:**
```cypher
# In neo4j.conf
dbms.logs.query.enabled=true
dbms.logs.query.threshold=1s
```

**Current queries:**
```cypher
CALL dbms.listQueries()
```

**Kill long-running query:**
```cypher
CALL dbms.killQuery('query-id')
```

---

## Debugging Cypher

### Common Errors

**Error: "Node not found"**
```cypher
MATCH (u:User {id: "nonexistent"})
RETURN u
# Returns empty, no error

# To ensure exists:
MATCH (u:User {id: $userId})
WITH u
WHERE u IS NOT NULL
RETURN u
```

**Error: "Variable not defined"**
```cypher
# Bad
MATCH (u:User)
RETURN u, o  # o not defined!

# Good
MATCH (u:User)
OPTIONAL MATCH (u)-[:OWNS]->(o:Organization)
RETURN u, o
```

**Error: "Cartesian product"**
```cypher
# Warning: This creates NxM results
MATCH (u:User)
MATCH (o:Organization)
RETURN u, o

# Fix: Connect them
MATCH (u:User)-[:MEMBER_OF]->(o:Organization)
RETURN u, o
```

### Testing Cypher Queries

**Using Neo4j Browser:**
1. Open http://localhost:7474
2. Login with credentials
3. Run query
4. See visual graph

**Using Cypher Shell:**
```bash
cypher-shell -u neo4j -p password
```

```cypher
neo4j> MATCH (u:User) RETURN count(u);
+----------+
| count(u) |
+----------+
| 42       |
+----------+
```

---

## Next Steps

- **[Read Schema Documentation](./03-SCHEMA-TYPES.md)** for complete data model
- **[Read Resolvers Guide](./04-RESOLVERS.md)** for custom Cypher in resolvers
- **[Read Auth Guide](./05-AUTH.md)** for authorization patterns

---

## Summary

Neo4j gives you:
- ✅ **Natural relationships** - No JOIN nightmares
- ✅ **Deep traversals** - Variable-length paths
- ✅ **Fast queries** - Index-backed lookups
- ✅ **Flexible schema** - Add properties anytime

Cypher gives you:
- ✅ **Readable syntax** - ASCII art patterns
- ✅ **Powerful traversals** - Complex path matching
- ✅ **Aggregations** - Built-in functions
- ✅ **Subqueries** - CALL for complex logic

Together with GraphQL:
- ✅ **Auto-generated queries** - Less code
- ✅ **Type safety** - Schema validation
- ✅ **Performance** - DataLoader batching
