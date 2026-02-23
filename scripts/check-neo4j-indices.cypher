// Alternative queries to check for remaining vector indices

// Option 1: Show all indices (works on most Neo4j versions)
SHOW INDEXES;

// Option 2: Show vector indices specifically (Neo4j 5.x)
CALL db.indexes() YIELD name, type, labelsOrTypes WHERE type = 'VECTOR' RETURN name, labelsOrTypes;

// Option 3: Simple version
CALL db.indexes() YIELD name, type WHERE type CONTAINS 'VECTOR' RETURN name, type;
