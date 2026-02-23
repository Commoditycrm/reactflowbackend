// Delete the 3 diagram summary embeddings

MATCH (n:OrgDiagramSummary_89dbdec4_56f7_4746_9fe5_1ea4d641d7a3)
WHERE n.fileId IN ['980799f4-11bc-439b-afa9-34d8746bf23f', 'df167d09-78b8-4968-9569-b7d9a08b62ad', '2ab526c7-c0e5-4eb2-aac2-d2051b70aab2']
DELETE n;

// Verify they're deleted
MATCH (n:OrgDiagramSummary_89dbdec4_56f7_4746_9fe5_1ea4d641d7a3)
RETURN count(n) as remaining_diagrams;
