// Neo4j Cypher Script: Clear Old Vector Indices
// Run this in Neo4j Browser when switching embedding dimensions
// from 1536 (OpenAI) to 1024 (qwen3-embedding:0.6b)

// Step 1: Show all vector indices
SHOW INDEXES WHERE type = "VECTOR" YIELD name, labelsOrTypes, properties;

// Step 2: Drop all vector indices (uncomment and run)
// Replace YOUR_ORG_ID with your actual organization ID (use underscores)
// DROP INDEX document_embeddings_org_YOUR_ORG_ID IF EXISTS;
// DROP INDEX diagram_summary_embeddings_org_YOUR_ORG_ID IF EXISTS;

// Step 3: Verify they're gone
// SHOW INDEXES WHERE type = "VECTOR";

// Note: The indices will be automatically recreated with the correct
// dimensions (1024) when you next ingest documents or index diagrams.

// Example: If your org ID is "89dbdec4-56f7-4746-9fe5-1ea4d641d7a3"
// DROP INDEX document_embeddings_org_89dbdec4_56f7_4746_9fe5_1ea4d641d7a3 IF EXISTS;
// DROP INDEX diagram_summary_embeddings_org_89dbdec4_56f7_4746_9fe5_1ea4d641d7a3 IF EXISTS;
