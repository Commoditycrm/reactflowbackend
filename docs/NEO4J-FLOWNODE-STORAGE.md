# FlowNode Storage in Neo4j - Complete Guide

## Overview

Your FlowNodes and GroupNodes (diagram data) are stored in Neo4j as graph nodes with relationships. This document explains the exact storage structure and how to query it directly from Neo4j Browser.

---

## 📊 Neo4j Structure

### 1. **FlowNode** Node

Stored as a node with label `FlowNode` containing these properties:

```cypher
(:FlowNode {
  id: "UUID",
  name: "Node name",
  description: "Description text",
  color: "#hexcolor",
  shape: "rectangle|circle|diamond|etc",
  posX: Float,
  posY: Float,
  width: Float,
  height: Float,
  type: "customNode",
  deletedAt: DateTime (null if not deleted),
  createdAt: DateTime,
  updatedAt: DateTime
})
```

### 2. **GroupNode** Node

Stored as a node with label `GroupNode` for grouping flow nodes:

```cypher
(:GroupNode {
  id: "UUID",
  name: "Group name",
  posX: Float,
  posY: Float,
  width: Float,
  height: Float,
  color: "#hexcolor",
  layoutType: "HORIZONTAL|VERTICAL",
  deletedAt: DateTime,
  createdAt: DateTime,
  updatedAt: DateTime
})
```

### 3. **Relationships**

#### FlowNode Relationships:

1. **HAS_FLOW_NODE** (File → FlowNode)
   - Direction: `(File)-[:HAS_FLOW_NODE]->(FlowNode)`
   - Links the diagram file to its flow nodes

2. **LINKED_TO** (FlowNode → FlowNode)
   - Direction: `(FlowNode)-[:LINKED_TO]->(FlowNode)`
   - Represents edges/arrows in your diagram
   - **Has properties** (edge data):
     ```cypher
     [:LINKED_TO {
       id: "edge-uuid",
       source: "source-node-id",
       sourceHandle: "a|b|c|d",
       targetHandle: "a|b|c|d",
       animated: Boolean,
       label: "Edge label",
       color: "#hexcolor",
       bidirectional: Boolean
     }]
     ```

3. **BELONGS_TO_GROUP** (FlowNode → GroupNode)
   - Direction: `(FlowNode)-[:BELONGS_TO_GROUP]->(GroupNode)`
   - Groups nodes together

4. **HAS_CHILD_ITEM** (FlowNode → BacklogItem)
   - Direction: `(FlowNode)-[:HAS_CHILD_ITEM]->(BacklogItem)`

5. **LINK_TO_FILE** (FlowNode → File)
   - Direction: `(FlowNode)-[:LINK_TO_FILE]->(File)`
   - Links to other files

6. **HAS_COMMENT** (FlowNode → Comment)
   - Direction: `(FlowNode)-[:HAS_COMMENT]->(Comment)`

7. **CREATED_FLOW_NODE** (User → FlowNode)
   - Direction: `(User)-[:CREATED_FLOW_NODE]->(FlowNode)`

---

## 🔌 Accessing Neo4j Browser

### Connection Details

Based on your `.env` file:

```
URL: http://localhost:7474
Bolt URL: neo4j://localhost:7687
Username: neo4j
Password: [your NEO4J_PASSWORD from .env]
```

### Steps to Access:

1. Open your browser and go to: **http://localhost:7474**
2. Click "Connect"
3. Enter:
   - **Connect URL**: `neo4j://localhost:7687`
   - **Database**: `neo4j` (default)
   - **Username**: `neo4j`
   - **Password**: Your password from `.env` file

---

## 🔍 Cypher Queries to View Your Diagrams

### Query 1: Get all FlowNodes for a specific file

Replace the file ID with yours (`d109eb25-1e39-4e6f-bc1c-6e442528db9f`):

```cypher
// Get all flow nodes for a specific file
MATCH (file:File {id: 'd109eb25-1e39-4e6f-bc1c-6e442528db9f'})-[:HAS_FLOW_NODE]->(node:FlowNode)
WHERE node.deletedAt IS NULL
RETURN node
```

### Query 2: Get FlowNodes with their edges (complete diagram)

```cypher
// Get diagram with nodes and edges
MATCH (file:File {id: 'd109eb25-1e39-4e6f-bc1c-6e442528db9f'})-[:HAS_FLOW_NODE]->(node:FlowNode)
WHERE node.deletedAt IS NULL
OPTIONAL MATCH (node)-[edge:LINKED_TO]->(targetNode:FlowNode)
WHERE targetNode.deletedAt IS NULL
  AND edge.color IS NOT NULL
RETURN node, edge, targetNode
```

### Query 3: Get complete diagram with GroupNodes

```cypher
// Get everything: FlowNodes, GroupNodes, and edges
MATCH (file:File {id: 'd109eb25-1e39-4e6f-bc1c-6e442528db9f'})

// Get FlowNodes
OPTIONAL MATCH (file)-[:HAS_FLOW_NODE]->(flowNode:FlowNode)
WHERE flowNode.deletedAt IS NULL

// Get edges between FlowNodes
OPTIONAL MATCH (flowNode)-[edge:LINKED_TO]->(targetNode:FlowNode)
WHERE targetNode.deletedAt IS NULL
  AND edge.color IS NOT NULL

// Get GroupNodes
OPTIONAL MATCH (file)-[:HAS_GROUP_NODE]->(groupNode:GroupNode)
WHERE groupNode.deletedAt IS NULL

RETURN flowNode, edge, targetNode, groupNode
```

### Query 4: View a specific FlowNode with all its relationships

```cypher
// View all relationships for a specific node
MATCH (node:FlowNode {id: '35cac216-1d79-4629-93b9-482ecd13fe12'})
OPTIONAL MATCH (node)-[r]->(related)
RETURN node, r, related
```

### Query 5: Get edge properties (LINKED_TO relationship details)

```cypher
// Get all edges with their properties
MATCH (file:File {id: 'd109eb25-1e39-4e6f-bc1c-6e442528db9f'})-[:HAS_FLOW_NODE]->(source:FlowNode)
MATCH (source)-[edge:LINKED_TO]->(target:FlowNode)
WHERE source.deletedAt IS NULL 
  AND target.deletedAt IS NULL
  AND edge.color IS NOT NULL
RETURN 
  source.name AS sourceName,
  target.name AS targetName,
  edge.id AS edgeId,
  edge.label AS label,
  edge.color AS color,
  edge.animated AS animated,
  edge.bidirectional AS bidirectional,
  edge.sourceHandle AS sourceHandle,
  edge.targetHandle AS targetHandle
```

### Query 6: Count nodes and edges in a diagram

```cypher
// Statistics for a diagram
MATCH (file:File {id: 'd109eb25-1e39-4e6f-bc1c-6e442528db9f'})-[:HAS_FLOW_NODE]->(flowNode:FlowNode)
WHERE flowNode.deletedAt IS NULL
WITH file, COUNT(flowNode) AS flowNodeCount

OPTIONAL MATCH (file)-[:HAS_FLOW_NODE]->(fn:FlowNode)-[edge:LINKED_TO]->(:FlowNode)
WHERE fn.deletedAt IS NULL AND edge.color IS NOT NULL
WITH file, flowNodeCount, COUNT(edge) AS edgeCount

OPTIONAL MATCH (file)-[:HAS_GROUP_NODE]->(groupNode:GroupNode)
WHERE groupNode.deletedAt IS NULL

RETURN 
  flowNodeCount,
  edgeCount,
  COUNT(groupNode) AS groupNodeCount
```

### Query 7: Visual graph view (best for Neo4j Browser visualization)

```cypher
// Visual representation in Neo4j Browser
MATCH path = (file:File {id: 'd109eb25-1e39-4e6f-bc1c-6e442528db9f'})-[:HAS_FLOW_NODE]->(node:FlowNode)
OPTIONAL MATCH edgePath = (node)-[:LINKED_TO]->(targetNode:FlowNode)
WHERE node.deletedAt IS NULL
RETURN path, edgePath
LIMIT 100
```

---

## 📝 Example: Understanding Your Data

Based on your GraphQL response, here's how the data is stored:

### Node: "Customer orders in BaseCamp (BC)"

```cypher
// Neo4j storage
(:FlowNode {
  id: "35cac216-1d79-4629-93b9-482ecd13fe12",
  name: "Customer orders in BaseCamp (BC)",
  shape: "rectangle",
  color: "#7f31f3",
  posX: -244.83231368916228,
  posY: -54.66666666666666,
  width: 82.0,
  height: 59.0,
  type: "customNode",
  description: null,
  deletedAt: null,
  createdAt: [DateTime],
  updatedAt: [DateTime]
})
```

### Edge: Customer → Order

```cypher
// The LINKED_TO relationship
(:FlowNode {id: "35cac216-1d79-4629-93b9-482ecd13fe12"})
  -[:LINKED_TO {
      id: "8f830a79-5cd0-44d1-9665-d4a3ba2fd5b0",
      source: "35cac216-1d79-4629-93b9-482ecd13fe12",
      sourceHandle: "c",
      targetHandle: "a",
      color: "#828282",
      label: "",
      animated: false,
      bidirectional: false
    }]->
(:FlowNode {id: "1140ba5d-c3cb-454b-88bb-df09f6ced824", name: "Order: Status-Pending"})
```

---

## 🔄 GraphQL to Cypher Mapping

Your GraphQL query translates to Cypher like this:

**GraphQL:**
```graphql
flowNodes(where: { file: { id: "d109eb25-1e39-4e6f-bc1c-6e442528db9f" } })
```

**Equivalent Cypher:**
```cypher
MATCH (file:File {id: "d109eb25-1e39-4e6f-bc1c-6e442528db9f"})-[:HAS_FLOW_NODE]->(node:FlowNode)
WHERE node.deletedAt IS NULL
RETURN node
```

**GraphQL (with edges):**
```graphql
linkedToConnection(where: { NOT: { edge: { color: null } } })
```

**Equivalent Cypher:**
```cypher
MATCH (node)-[edge:LINKED_TO]->(targetNode:FlowNode)
WHERE edge.color IS NOT NULL
  AND targetNode.deletedAt IS NULL
RETURN edge, targetNode
```

---

## 🛠️ Useful Neo4j Browser Commands

```cypher
// Show all labels (node types)
CALL db.labels()

// Show all relationship types
CALL db.relationshipTypes()

// Show schema
CALL db.schema.visualization()

// Count all FlowNodes
MATCH (n:FlowNode)
WHERE n.deletedAt IS NULL
RETURN COUNT(n)

// Find all files with diagrams
MATCH (file:File)-[:HAS_FLOW_NODE]->(node:FlowNode)
WHERE node.deletedAt IS NULL
RETURN DISTINCT file.id, file.name, COUNT(node) AS nodeCount
ORDER BY nodeCount DESC

// Clear the query result visualization
:clear
```

---

## 📍 Code Location Reference

The GraphQL schema defining FlowNode structure is in:
- **File**: [src/graphql/schema/schema.ts](../src/graphql/schema/schema.ts#L2877-L3130)
  - FlowNode type definition: Lines 2877-3130
  - LINKED_TO relationship properties: Lines 2852-2875
  - GroupNode type definition: Lines 3139+

The Neo4j connection is configured in:
- **File**: [src/database/connection.ts](../src/database/connection.ts)
- **Environment**: `.env` file (NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD)

---

## 💡 Tips

1. **Performance**: Always include `WHERE deletedAt IS NULL` to filter soft-deleted nodes
2. **Visualization**: Neo4j Browser shows a graph visualization when you return nodes and relationships
3. **Edge Filter**: The `WHERE edge.color IS NOT NULL` mimics your GraphQL filter
4. **Limiting Results**: Add `LIMIT 100` to large queries to avoid overwhelming the browser
5. **Path Queries**: Use `MATCH path = ...` for better visualization in Neo4j Browser

---

## 🔗 Related Documentation

- [Neo4j Cypher Reference](../docs/02-NEO4J-CYPHER.md)
- [GraphQL Schema Types](../docs/03-SCHEMA-TYPES.md)
- [Main README](../README.md)
