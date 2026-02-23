// First, let's inspect the actual structure of these nodes

// Query 1: Find all diagram summary nodes and see their labels/properties
MATCH (n)
WHERE n.fileId IN ['980799f4-11bc-439b-afa9-34d8746bf23f', 'df167d09-78b8-4968-9569-b7d9a08b62ad', '2ab526c7-c0e5-4eb2-aac2-d2051b70aab2']
RETURN labels(n) as nodeLabels, properties(n) as nodeProperties
LIMIT 5;

// Query 2: Alternative - search by DiagramSummaryNode label
MATCH (n:DiagramSummaryNode)
WHERE n.fileId IN ['980799f4-11bc-439b-afa9-34d8746bf23f', 'df167d09-78b8-4968-9569-b7d9a08b62ad', '2ab526c7-c0e5-4eb2-aac2-d2051b70aab2']
RETURN labels(n), n.fileId, n.summary
LIMIT 5;

// Query 3: Delete using DiagramSummaryNode label (try this if Query 2 works)
MATCH (n:DiagramSummaryNode)
WHERE n.fileId IN ['980799f4-11bc-439b-afa9-34d8746bf23f', 'df167d09-78b8-4968-9569-b7d9a08b62ad', '2ab526c7-c0e5-4eb2-aac2-d2051b70aab2']
DETACH DELETE n;
