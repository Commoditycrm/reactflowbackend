export const CREATE_PROJECT_FROM_TEMPLATE = `
CALL apoc.periodic.iterate(
  "
  MATCH (sourceRoot:Project {id:$templateProjectId})
  MATCH (org:Organization {id:$orgId})
  MATCH (user:User {externalId:$userId})
  WITH sourceRoot, org, user, org.id + '-' + toLower(replace($name, ' ', '')) AS uniqueKey
  RETURN sourceRoot, org, user, uniqueKey
  ",
  "
  CALL apoc.util.validate(
    EXISTS {
      MATCH (:Project {uniqueProject: uniqueKey})
    },
    'A project with the same name already exists in this organization.',
    []
  )
  
  MERGE (newRoot:Project {refId: sourceRoot.id}) 
  ON CREATE SET 
    newRoot.createdAt = datetime(),
    newRoot.name = $name,
    newRoot.description = $description,
    newRoot.id = randomUUID(),
    newRoot.isTemplate = false,
    newRoot.uniqueProject = uniqueKey,
    newRoot.isDescriptionEditable = false

  MERGE (user)-[:CREATED_PROJECT]->(newRoot)
  MERGE (newRoot)<-[:HAS_PROJECTS]-(org)
  MERGE (newRoot)-[:HAS_WS_NOTIFICATION]->(wn:WhatsappNotification)
    ON CREATE SET wn.enabled = false
  MERGE (newRoot)-[:HAS_AUTO_HIDE_CONFIG]->(at:AutoHideCompletedTasks)
    ON CREATE SET at.enabled = false,
                at.days = 2;
  ",
  {
    batchSize: 1,
    parallel: false,
    params: {
      templateProjectId: $templateProjectId,
      name: $name,
      description: $description,
      userId: $userId,
      orgId: $orgId
    }
  }
)
YIELD batches, total, errorMessages, failedBatches, failedOperations
RETURN errorMessages
`;

export const CLONE_ROOT_FILES = `
// cloning rootLevel files
CALL apoc.periodic.iterate(
    "MATCH (sourceRoot:Project {id:$templateProjectId})
     MATCH (user:User {externalId:$userId})
     OPTIONAL MATCH (sourceRoot)-[:HAS_CHILD_FILE]->(sourceFile:File)
     WHERE sourceFile.deletedAt IS NULL
     MATCH (newRoot:Project {refId: sourceRoot.id})
     RETURN newRoot, sourceFile, user",
    
    "MERGE (newFile:File {refId: sourceFile.id})
     ON CREATE SET
        newFile.id = randomUUID(),
        newFile.name = sourceFile.name,
        newFile.createdAt = datetime()
    WITH newRoot, newFile, user
    CALL apoc.lock.nodes([newFile])
    MERGE (user)-[:CREATED_FILE]->(newFile)
    MERGE (newRoot)-[:HAS_CHILD_FILE]->(newFile)",

    {batchSize: 35, parallel:true,retries: 3,params: { templateProjectId: $templateProjectId,userId:$userId }}
);
`;

export const CLONE_SUB_FOLDERS = `
// clonning subFolders
CALL apoc.periodic.iterate(
    "MATCH (sourceRoot:Project {id:$templateProjectId})
     MATCH path = (sourceRoot)-[:HAS_CHILD_FOLDER*1..]->(folder:Folder)
     WHERE folder.deletedAt IS NULL
     WITH DISTINCT sourceRoot, folder, path, 
          length(path) AS level, 
          CASE length(path) 
             WHEN 1 THEN sourceRoot.id 
             ELSE last(nodes(path)[..-1]).id 
          END AS parentId 
     ORDER BY level 
     RETURN sourceRoot, folder, parentId, level",
    
    "WITH sourceRoot, folder, parentId, level
     MATCH (newRoot:Project {refId: sourceRoot.id})
     MATCH (user:User {externalId:$userId})
     MERGE (newFolder:Folder {refId: folder.id})
     ON CREATE SET
        newFolder.id = randomUUID(),
        newFolder.createdAt = datetime(),
        newFolder.name = folder.name
     MERGE (user)-[:CREATED_FOLDER]->(newFolder)
     MERGE(newFolder)-[:FOLDER_IN_PROJECT]->(newRoot)
     WITH parentId,level,newFolder,newRoot
     OPTIONAL MATCH (parentFolder:Folder {refId: parentId})
     FOREACH (ignore IN CASE WHEN level = 1 THEN [1] ELSE [] END |
         MERGE (newRoot)-[:HAS_CHILD_FOLDER]->(newFolder)
     )
     FOREACH (ignore IN CASE WHEN parentFolder IS NOT NULL AND level > 1 THEN [1] ELSE [] END |
         MERGE (parentFolder)-[:HAS_CHILD_FOLDER]->(newFolder)
     )",
    {
        batchSize: 25, 
        parallel: true,  
        iterateList: true,
        retries: 3,
        params: { templateProjectId: $templateProjectId,userId:$userId }
    }
);
`;

export const CLONE_SUB_FILES = `
CALL apoc.periodic.iterate(
    // Query to get file data - fixed to match only copied folders
    "MATCH (sourceRoot:Project {id: $templateProjectId})
     MATCH path = (sourceRoot)-[:HAS_CHILD_FOLDER*1..]->(folder:Folder)
     MATCH (folder)-[:HAS_CHILD_FILE]->(sourceFile:File)
     WHERE sourceFile.deletedAt IS NULL
     WITH DISTINCT folder, sourceFile
     // Match the corresponding new folder that was created
     MATCH (newFolder:Folder {refId: folder.id})
     RETURN sourceFile, newFolder",
    
    // Processing query for files
    "WITH sourceFile, newFolder
     MATCH (user:User {externalId: $userId})
     MERGE (newFile:File {refId: sourceFile.id})
     ON CREATE SET
         newFile.id = randomUUID(),
         newFile.name = sourceFile.name,
         newFile.createdAt = datetime()
     
     MERGE (user)-[:CREATED_FILE]->(newFile)
     MERGE (newFolder)-[:HAS_CHILD_FILE]->(newFile)
     ",
    {
        batchSize: 35,
        parallel: true,
        retries: 3, 
        params: { templateProjectId: $templateProjectId,userId:$userId }
    }
);
`;

export const CLONE_FLOWNODE = `
CALL apoc.periodic.iterate(
    "MATCH (newRoot:Project {refId: $templateProjectId})
     CALL(newRoot) {
       WITH newRoot
       MATCH (newRoot)-[:HAS_CHILD_FOLDER*1..]->(folder:Folder)
       MATCH (folder)-[:HAS_CHILD_FILE]->(newFile:File)
       RETURN newFile
       UNION
       MATCH(newRoot)-[:HAS_CHILD_FILE]->(newFile:File)
       RETURN newFile
     }
     MATCH (originalFile:File {id: newFile.refId})
     MATCH (originalFile)-[:HAS_FLOW_NODE]->(sourceFlowNode:FlowNode)
     WHERE sourceFlowNode.deletedAt IS NULL
     RETURN DISTINCT newFile, sourceFlowNode,newRoot",
    
    // Processing query for FlowNodes
    "WITH newFile, sourceFlowNode,newRoot
     MATCH (user:User {externalId: $userId})
     MERGE (newFlowNode:FlowNode {refId: sourceFlowNode.id})
     ON CREATE SET
         newFlowNode.id = randomUUID(),
         newFlowNode.name = sourceFlowNode.name,
         newFlowNode.description = sourceFlowNode.description,
         newFlowNode.color = sourceFlowNode.color,
         newFlowNode.shape = sourceFlowNode.shape,
         newFlowNode.posX = sourceFlowNode.posX,
         newFlowNode.posY = sourceFlowNode.posY,
         newFlowNode.width = sourceFlowNode.width,
         newFlowNode.height = sourceFlowNode.height,
         newFlowNode.type = sourceFlowNode.type,
         newFlowNode.createdAt = datetime()
     WITH newFlowNode,newFile,user
     CALL apoc.lock.nodes([newFlowNode])
     MERGE (newFile)-[:HAS_FLOW_NODE]->(newFlowNode)
     MERGE (user)-[:CREATED_FLOW_NODE]->(newFlowNode)",
    {
        batchSize: 35,
        parallel: true,
        retries: 3,
        params: { templateProjectId: $templateProjectId,userId:$userId }
    }
)
`;

export const LINK_TO_FLOWNODE = `
CALL apoc.periodic.iterate(
    // Query to get link data
    "MATCH (newRoot:Project {refId: $templateProjectId})
     CALL(newRoot) {
         WITH newRoot
         MATCH (newRoot)-[:HAS_CHILD_FOLDER*1..]->(folder:Folder)
         MATCH (folder)-[:HAS_CHILD_FILE]->(newFile:File)
         RETURN newFile
         UNION 
         WITH newRoot
         MATCH(newRoot)-[:HAS_CHILD_FILE]->(rootFiles:File)
         RETURN rootFiles AS newFile
     }
     MATCH (newFile)-[:HAS_FLOW_NODE]->(newFlowNode:FlowNode)
     MATCH (originalFile:File {id: newFile.refId})
     MATCH (originalFile)-[:HAS_FLOW_NODE]->(sourceFlowNode:FlowNode {id: newFlowNode.refId})
     MATCH (sourceFlowNode)-[linkTo:LINKED_TO]->(targetFlowNode:FlowNode)
     WHERE targetFlowNode.deletedAt IS NULL
     CALL(newRoot) {
         WITH newRoot
         MATCH (newRoot)-[:HAS_CHILD_FOLDER*1..]->(f:Folder)
         MATCH (f)-[:HAS_CHILD_FILE]->(targetFile:File)
         RETURN targetFile
         UNION 
         WITH newRoot
         MATCH(newRoot)-[:HAS_CHILD_FILE]->(targetFile:File)
         RETURN targetFile
     }
     MATCH (targetFile)-[:HAS_FLOW_NODE]->(newTargetNode:FlowNode {refId: targetFlowNode.id})
     RETURN DISTINCT newFlowNode, newTargetNode, linkTo",
    
    // Processing query for links
    "WITH newFlowNode, newTargetNode, linkTo
     MERGE (newFlowNode)-[newLink:LINKED_TO]->(newTargetNode)
     ON CREATE SET 
         newLink.color = linkTo.color,
         newLink.animated = linkTo.animated,
         newLink.bidirectional = linkTo.bidirectional,
         newLink.label = linkTo.label,
         newLink.id = randomUUID(),
         newLink.sourceHandle = linkTo.sourceHandle,
         newLink.targetHandle = linkTo.targetHandle,
         newLink.source = newFlowNode.id",
    {
        batchSize: 35,
        parallel: true,
        retries: 3,
        params: { templateProjectId: $templateProjectId }
    }
);
`;

export const CLONE_BACKLOGITEM = `
CALL apoc.periodic.iterate(
    "
    MATCH (newRoot:Project {refId:$templateProjectId}) 
    OPTIONAL MATCH (newRoot)-[:HAS_CHILD_FOLDER*1..]->(folders:Folder)
     MATCH (newRoot)<-[:HAS_PROJECTS]-(org:Organization)
     MATCH (org)-[:HAS_COUNTER]->(orgCounter:Counter)
     MATCH (org)-[:HAS_STATUS]->(status:Status)
     WHERE toLower(status.name) CONTAINS 'not started'  
     CALL (newRoot,folders){
        WITH newRoot , folders
        OPTIONAL MATCH(newRoot)-[:HAS_CHILD_FILE]->(rootFiles:File)
        WHERE rootFiles IS NOT NULL AND rootFiles.deletedAt IS NULL
        RETURN rootFiles AS newFile
        UNION 
        OPTIONAL MATCH(folders)-[:HAS_CHILD_FILE]->(nestedFiles:File)
        WHERE nestedFiles IS NOT NULL AND nestedFiles.deletedAt IS NULL
        RETURN nestedFiles AS newFile
     }
     MATCH (newFile)-[:HAS_FLOW_NODE]->(newFlowNode:FlowNode)
     MATCH (originalFile:File {id: newFile.refId})
     MATCH (originalFile)-[:HAS_FLOW_NODE]->(sourceFlowNode:FlowNode {id: newFlowNode.refId})
     MATCH (sourceFlowNode)-[:HAS_CHILD_ITEM]->(sourceBacklogItem:BacklogItem)
     MATCH (sourceBacklogItem)-[:HAS_BACKLOGITEM_TYPE]->(backlogItemType:BacklogItemType)
     MATCH(sourceBacklogItem)-[:HAS_RISK_LEVEL]->(riskLevel:RiskLevel)
     WHERE sourceBacklogItem.deletedAt IS NULL
     RETURN org, newRoot, orgCounter, sourceBacklogItem, backlogItemType,riskLevel, newFlowNode, status",
    "
     WITH org, newRoot, orgCounter, sourceBacklogItem, backlogItemType,riskLevel, newFlowNode, status
     MATCH (user:User {externalId: $userId})

    CALL {
      WITH org, backlogItemType
      OPTIONAL MATCH (org)-[:HAS_BACKLOGITEM_TYPE]->(matchType:BacklogItemType)
      WHERE toLower(matchType.name) = toLower(backlogItemType.name)
      WITH collect(matchType) AS types
      RETURN coalesce(head([t IN types WHERE t IS NOT NULL]), head(types)) AS itemType
    }

    CALL {
      WITH org, riskLevel
      OPTIONAL MATCH (org)-[:HAS_RISK_LEVEL]->(matchRisk:RiskLevel)
      WHERE toLower(matchRisk.name) = toLower(riskLevel.name)
      WITH collect(matchRisk) AS risks
      RETURN coalesce(head([r IN risks WHERE r IS NOT NULL]), head(risks)) AS itemRiskLevel
    }

     WITH org, newRoot, orgCounter, itemType,itemRiskLevel, user, status, 
        collect({sourceItem: sourceBacklogItem, flowNode: newFlowNode}) AS itemsWithFlowNodes
    WHERE itemType IS NOT NULL AND itemRiskLevel IS NOT NULL
     UNWIND itemsWithFlowNodes AS itemData
     
     CALL apoc.atomic.add(orgCounter, 'counter', 1) YIELD newValue AS newUid

     MERGE (newBacklogItem:BacklogItem {refId: itemData.sourceItem.id, projectId: newRoot.id})
     ON CREATE SET
        newBacklogItem.id = randomUUID(),
        newBacklogItem.label = itemData.sourceItem.label,
        newBacklogItem.description = itemData.sourceItem.description,
        newBacklogItem.createdAt = datetime(),
        newBacklogItem.isTopLevelParentItem = itemData.sourceItem.isTopLevelParentItem,
        newBacklogItem.actualExpense = itemData.sourceItem.actualExpense,
        newBacklogItem.uid = newUid,
        newBacklogItem.isRecurringTask = itemData.sourceItem.isRecurringTask,
        newBacklogItem.uniqueUid = toString(toInteger(newUid)) + '-' + org.id

     MERGE (newBacklogItem)<-[:CREATED_ITEM]-(user)
     MERGE (newBacklogItem)-[:HAS_BACKLOGITEM_TYPE]->(itemType)
     MERGE(newBacklogItem)-[:HAS_RISK_LEVEL]->(itemRiskLevel)
     MERGE (newBacklogItem)-[:HAS_STATUS]->(status)
     MERGE(newBacklogItem)-[:ITEM_IN_PROJECT]->(newRoot)
     WITH itemData.flowNode AS sourceFlowNode, newBacklogItem
     MERGE (sourceFlowNode)-[:HAS_CHILD_ITEM]->(newBacklogItem)
    ",
    {batchSize: 35, parallel:true, retries: 3, params: { templateProjectId: $templateProjectId, userId:$userId }}
);
`;

export const CLONE_SUB_ITEM = `
CALL apoc.periodic.iterate(
    "
     MATCH (newRoot:Project {refId:$templateProjectId}) 
     OPTIONAL MATCH(newRoot)-[:HAS_CHILD_FOLDER*1..]->(folders:Folder)
     MATCH (newRoot)<-[:HAS_PROJECTS]-(org:Organization)
     MATCH (org)-[:HAS_COUNTER]->(orgCounter:Counter)
     MATCH (org)-[:HAS_STATUS]->(status:Status)
     WHERE toLower(status.name) CONTAINS 'not started' AND folders.deletedAt IS NULL
     CALL(newRoot,folders) {
     OPTIONAL MATCH(newRoot)-[:HAS_CHILD_FILE]->(rootFiles:File)
     WHERE rootFiles IS NOT NULL AND rootFiles.deletedAt IS NULL
       RETURN rootFiles AS newFile
       UNION
       MATCH(folders)-[:HAS_CHILD_FILE]->(nestedFiles:File)
       WHERE nestedFiles IS NOT NULL AND nestedFiles.deletedAt IS NULL
       RETURN nestedFiles AS newFile
     }
     MATCH (newFile)-[:HAS_FLOW_NODE]->(newFlowNode:FlowNode)
     MATCH (newFlowNode)-[:HAS_CHILD_ITEM]->(newBacklogItem:BacklogItem)
     MATCH (sourceBacklogItem:BacklogItem {id: newBacklogItem.refId})
     MATCH (sourceBacklogItem)-[:HAS_CHILD_ITEM]->(sourceSubItem:BacklogItem)
     MATCH (sourceSubItem)-[:HAS_BACKLOGITEM_TYPE]->(subItemType:BacklogItemType)
     MATCH(sourceSubItem)-[:HAS_RISK_LEVEL]->(riskLevel:RiskLevel)
     WHERE sourceSubItem.deletedAt IS NULL
     RETURN org, newRoot, orgCounter, sourceSubItem, subItemType,riskLevel, newBacklogItem, status",
    "
     WITH org, newRoot, orgCounter, sourceSubItem, subItemType,riskLevel, newBacklogItem, status
     MATCH (user:User {externalId: $userId}) 

    CALL {
      WITH org, subItemType
      OPTIONAL MATCH (org)-[:HAS_BACKLOGITEM_TYPE]->(matchType:BacklogItemType)
      WHERE toLower(matchType.name) = toLower(subItemType.name)
      WITH collect(matchType) AS types
      RETURN coalesce(head([t IN types WHERE t IS NOT NULL]), head(types)) AS itemType
    }

    CALL {
      WITH org, riskLevel
      OPTIONAL MATCH (org)-[:HAS_RISK_LEVEL]->(matchRisk:RiskLevel)
      WHERE toLower(matchRisk.name) = toLower(riskLevel.name)
      WITH collect(matchRisk) AS risks
      RETURN coalesce(head([r IN risks WHERE r IS NOT NULL]), head(risks)) AS itemRiskLevel
    }

     WITH org, newRoot, orgCounter, itemType,itemRiskLevel, user, status, 
          collect({subItem: sourceSubItem, parent: newBacklogItem}) AS allSubItemsWithParents

     UNWIND allSubItemsWithParents AS subItemData
     
     CALL apoc.atomic.add(orgCounter, 'counter', 1) YIELD newValue AS newSubUid

     MERGE (newSubItem:BacklogItem {refId: subItemData.subItem.id})
     ON CREATE SET
         newSubItem.id = randomUUID(),
         newSubItem.label = subItemData.subItem.label,
         newSubItem.description = subItemData.subItem.description,
         newSubItem.createdAt = datetime(),
         newSubItem.isTopLevelParentItem = false,
         newSubItem.actualExpense = subItemData.subItem.actualExpense,
         newSubItem.uid = newSubUid,
         newSubItem.isRecurringTask = subItemData.subItem.isRecurringTask,
         newSubItem.uniqueUid = toString(toInteger(newSubUid)) + '-' + org.id
     MERGE (newSubItem)<-[:CREATED_ITEM]-(user)
     MERGE (newSubItem)-[:HAS_BACKLOGITEM_TYPE]->(itemType)
     MERGE (newSubItem)-[:HAS_RISK_LEVEL]->(itemRiskLevel)
     MERGE (newSubItem)-[:HAS_STATUS]->(status)
     MERGE(newSubItem)-[:ITEM_IN_PROJECT]->(newRoot)
     WITH subItemData.parent AS parentBacklogItem, newSubItem
     MERGE (parentBacklogItem)-[:HAS_CHILD_ITEM]->(newSubItem)
    ",
    {batchSize: 35, parallel:true, retries:3, params: { templateProjectId: $templateProjectId, userId:$userId }}
);
`;
export const CONNECT_DEPENDENCY_CQL = `
CALL apoc.periodic.iterate(
  "
  MATCH (sourceBacklogItem:BacklogItem)<-[:PREDECESSOR]-(sourcePredecessor:BacklogItem)
  WHERE sourceBacklogItem.deletedAt IS NULL AND sourcePredecessor.deletedAt IS NULL
  
  MATCH (newBacklogItem:BacklogItem {refId: sourceBacklogItem.id})-[:ITEM_IN_PROJECT]->(project:Project {refId:$templateProjectId})
  MATCH (newPredecessor:BacklogItem {refId: sourcePredecessor.id})-[:ITEM_IN_PROJECT]->(project)
  
  RETURN newBacklogItem, newPredecessor
  ",
  "
  WITH newBacklogItem, newPredecessor
  MERGE (newPredecessor)-[:PREDECESSOR]->(newBacklogItem)
  ",
  {batchSize: 35, parallel: false, retries: 3,params: { templateProjectId: $templateProjectId }}
);
`;
export const UPDATE_INDEPENDENT_TASK_DATE_CQL = `
CALL apoc.periodic.iterate(
    "
    MATCH (newRoot:Project {refId: $templateProjectId})
    MATCH (newBacklogItem:BacklogItem)-[:ITEM_IN_PROJECT]->(newRoot)
    MATCH (sourceBacklogItem:BacklogItem {id: newBacklogItem.refId})
    WHERE NOT EXISTS {
        MATCH (sourceBacklogItem)<-[:PREDECESSOR]-(:BacklogItem)
    }
    AND NOT EXISTS {
        MATCH (newBacklogItem)<-[:PREDECESSOR]-(:BacklogItem)
    }
    RETURN newBacklogItem, sourceBacklogItem
    ",
    "
    WITH newBacklogItem, sourceBacklogItem,
         CASE 
             WHEN sourceBacklogItem.startDate IS NOT NULL AND sourceBacklogItem.endDate IS NOT NULL
             THEN duration.between(sourceBacklogItem.startDate, sourceBacklogItem.endDate)
             ELSE duration({days: 1}) // Default to 1 day if no dates exist
         END AS originalDuration,
         datetime($userStartDate + 'T00:00:00.000000000Z') AS startDate
    
    WITH newBacklogItem, startDate, (startDate + originalDuration) AS tentativeEndDate
    
    // Adjust endDate if it falls on a weekend
    WITH newBacklogItem, startDate, tentativeEndDate,
         CASE 
             WHEN tentativeEndDate.dayOfWeek = 6 THEN tentativeEndDate + duration({days: 2}) // If Saturday, move to Monday
             WHEN tentativeEndDate.dayOfWeek = 7 THEN tentativeEndDate + duration({days: 1}) // If Sunday, move to Monday
             ELSE tentativeEndDate
         END AS adjustedEndDate
    
    SET newBacklogItem.startDate = startDate
    SET newBacklogItem.endDate = adjustedEndDate
    ",
    {batchSize: 50, parallel: false, retries: 3, params: { templateProjectId:$templateProjectId, userStartDate: $userStartDate}}
);

`;

export const getUpdateDependentTaskDatesCQL = (projectId: string) => `
CALL apoc.periodic.commit("
    MATCH (project:Project {refId: '${projectId}'}) 
    MATCH (dependentTask:BacklogItem)-[:ITEM_IN_PROJECT]->(project)
    
    WHERE EXISTS { 
        MATCH (predecessor:BacklogItem)-[:PREDECESSOR]->(dependentTask)
        WHERE (predecessor)-[:ITEM_IN_PROJECT]->(project)
    }

    MATCH (predecessor:BacklogItem)-[:PREDECESSOR]->(dependentTask)
    WHERE (predecessor)-[:ITEM_IN_PROJECT]->(project)
      AND predecessor.endDate IS NOT NULL
    
    WITH dependentTask, 
         COUNT(predecessor) AS totalPredecessors,
         COLLECT(predecessor.endDate) AS predecessorEndDates
    
    WHERE dependentTask.startDate IS NULL
      AND size(predecessorEndDates) = totalPredecessors
      AND totalPredecessors > 0
    
    WITH dependentTask, 
         apoc.coll.max(predecessorEndDates) AS latestEndDate
    
    OPTIONAL MATCH (refTask:BacklogItem {id: dependentTask.refId})
    WITH dependentTask, latestEndDate,
         CASE
             WHEN refTask.startDate IS NOT NULL AND refTask.endDate IS NOT NULL
             THEN duration.inDays(date(refTask.startDate), date(refTask.endDate)).days
             ELSE 3 
         END AS taskDuration
    
    WITH dependentTask, 
         datetime({year: latestEndDate.year, month: latestEndDate.month, day: latestEndDate.day}) AS newStartDate,
         datetime({year: latestEndDate.year, month: latestEndDate.month, day: latestEndDate.day}) + duration({days: taskDuration}) AS tentativeEndDate
    
    WITH dependentTask, newStartDate, tentativeEndDate,
         CASE 
             WHEN tentativeEndDate.dayOfWeek = 6 THEN tentativeEndDate + duration({days: 2})
             WHEN tentativeEndDate.dayOfWeek = 7 THEN tentativeEndDate + duration({days: 1})
             ELSE tentativeEndDate
         END AS newEndDate
    
    SET dependentTask.startDate = newStartDate,
        dependentTask.endDate = newEndDate
    
    RETURN count(dependentTask) AS updatedCount
    LIMIT 25
");
`;

export const REMOVE_REFID_EXISTING_NODE = `
CALL apoc.periodic.iterate(
    "MATCH (n) 
     WHERE n.refId IS NOT NULL 
     RETURN n",
    "
     REMOVE n.refId
    ",
    {batchSize: 30, parallel: true,retries:3}
);
`;

export const CREATE_RECURRING_PARENT_TASK = `
CALL apoc.periodic.iterate(
"
  MATCH (p:Project)<-[:ITEM_IN_PROJECT]-(bi:BacklogItem {isRecurringTask:true})
  WHERE bi.deletedAt IS NULL
  WITH DISTINCT p

  CALL(p) {
    WITH p
    MATCH (p)-[:HAS_CHILD_FILE]->(file:File)-[:HAS_FLOW_NODE]->(n:FlowNode)
    WHERE file.deletedAt IS NULL AND n.deletedAt IS NULL
    RETURN n
    UNION
    MATCH fpath=(p)-[:HAS_CHILD_FOLDER*1..5]->(:Folder)-[:HAS_CHILD_FILE]->(file:File)-[:HAS_FLOW_NODE]->(n:FlowNode)
    WHERE file.deletedAt IS NULL AND n.deletedAt IS NULL
      AND ALL(x IN nodes(fpath) WHERE NOT x:Folder OR x.deletedAt IS NULL)
    RETURN n
  }

  MATCH (n)-[:HAS_CHILD_ITEM]->(bi:BacklogItem)-[:ITEM_IN_PROJECT]->(p)
  WHERE bi.deletedAt IS NULL AND bi.isRecurringTask = true

  WITH p, n AS parent, bi
  MATCH (org)-[:HAS_PROJECTS]->(p)
  MATCH (user:User)-[:CREATED_ITEM]->(bi)
  OPTIONAL MATCH(bi)-[:HAS_ASSIGNED_USER]->(assignedUser:User)
  MATCH (org)-[:HAS_STATUS]->(status:Status)
  MATCH (bi)-[:HAS_BACKLOGITEM_TYPE]->(type:BacklogItemType)
  MATCH (bi)-[:HAS_RISK_LEVEL]->(level:RiskLevel)
  MATCH (org)-[:HAS_COUNTER]->(orgCounter:Counter)

  WHERE toLower(status.defaultName) CONTAINS 'not started'
  RETURN bi, p, parent, level, status, type, org, user, orgCounter,assignedUser
",
"
  WITH bi, p, parent, level, status, type, org, user, orgCounter,assignedUser,
       datetime() AS now,
       duration.between(bi.startDate, bi.endDate) AS oldDuration

  CALL apoc.atomic.add(orgCounter, 'counter', 1) YIELD newValue

  CREATE (newItem:BacklogItem)
  SET newItem.id = randomUUID(),
      newItem.label = coalesce(bi.label, ''),
      newItem.description = bi.description,
      newItem.createdAt = now,
      newItem.isTopLevelParentItem = coalesce(bi.isTopLevelParentItem, false),
      newItem.actualExpense = bi.actualExpense,
      newItem.uid = newValue,
      newItem.uniqueUid = toString(toInteger(newValue)) + '-' + org.id,
      newItem.isRecurringTask = false,
      newItem.startDate = now,
      newItem.refId = bi.id,
      newItem.endDate = CASE
                          WHEN bi.startDate IS NOT NULL AND bi.endDate IS NOT NULL
                            THEN now + oldDuration
                          ELSE NULL
                        END

  SET bi.endDate = now

  MERGE (newItem)<-[:CREATED_ITEM]-(user)
  MERGE (newItem)-[:HAS_BACKLOGITEM_TYPE]->(type)
  MERGE (newItem)-[:HAS_RISK_LEVEL]->(level)
  MERGE (newItem)-[:HAS_STATUS]->(status)
  MERGE (newItem)-[:ITEM_IN_PROJECT]->(p)
  MERGE (parent)-[:HAS_CHILD_ITEM {createdAt: now}]->(newItem)
  FOREACH (a IN CASE WHEN assignedUser IS NULL THEN [] ELSE [assignedUser] END |
    MERGE (newItem)-[:HAS_ASSIGNED_USER]->(a)
  )
",
{ batchSize: 200, parallel: false, retries: 1 }
);
`;

export const CREATE_RECURRING_SUB_TASK = `
CALL apoc.periodic.iterate(
"
  MATCH (p:Project)<-[:ITEM_IN_PROJECT]-(bi:BacklogItem {isRecurringTask:true})
  MATCH (parentBI:BacklogItem)-[:HAS_CHILD_ITEM]->(bi)
  WHERE bi.deletedAt IS NULL
    AND parentBI <> bi
  WITH DISTINCT p

  CALL(p) {
    WITH p
    MATCH (p)-[:HAS_CHILD_FILE]->(file:File)-[:HAS_FLOW_NODE]->(n:FlowNode)
    WHERE file.deletedAt IS NULL AND n.deletedAt IS NULL
    RETURN n
    UNION
    MATCH fpath=(p)-[:HAS_CHILD_FOLDER*1..5]->(:Folder)-[:HAS_CHILD_FILE]->(file:File)-[:HAS_FLOW_NODE]->(n:FlowNode)
    WHERE file.deletedAt IS NULL AND n.deletedAt IS NULL
      AND ALL(x IN nodes(fpath) WHERE NOT x:Folder OR x.deletedAt IS NULL)
    RETURN n
  }

  MATCH (n)-[:HAS_CHILD_ITEM]->(parentBI:BacklogItem)-[:HAS_CHILD_ITEM]->(bi:BacklogItem)
  MATCH (bi)-[:ITEM_IN_PROJECT]->(p)
  WHERE bi.deletedAt IS NULL
    AND bi.isRecurringTask = true
    AND parentBI <> bi

  WITH p, parentBI AS parent, bi
  MATCH (org)-[:HAS_PROJECTS]->(p)
  MATCH (user:User)-[:CREATED_ITEM]->(bi)
  MATCH (org)-[:HAS_STATUS]->(status:Status)
  OPTIONAL MATCH(bi)-[:HAS_ASSIGNED_USER]->(assignedUser:User)
  MATCH (bi)-[:HAS_BACKLOGITEM_TYPE]->(type:BacklogItemType)
  MATCH (bi)-[:HAS_RISK_LEVEL]->(level:RiskLevel)
  MATCH (org)-[:HAS_COUNTER]->(orgCounter:Counter)

  WHERE toLower(status.defaultName) CONTAINS 'not started'

  RETURN bi, p, parent, level, status, type, org, user, orgCounter,assignedUser
",
"
  WITH bi, p, parent, level, status, type, org, user, orgCounter,assignedUser,
       datetime() AS now,
       duration.between(bi.startDate, bi.endDate) AS oldDuration

  CALL apoc.atomic.add(orgCounter, 'counter', 1) YIELD oldValue, newValue

  CREATE (newItem:BacklogItem)
  SET newItem.id                   = randomUUID(),
      newItem.label                = coalesce(bi.label, ''),
      newItem.description          = bi.description,
      newItem.createdAt            = now,
      newItem.isTopLevelParentItem = coalesce(bi.isTopLevelParentItem, false),
      newItem.actualExpense        = bi.actualExpense,
      newItem.uid                  = newValue,
      newItem.uniqueUid            = toString(toInteger(newValue)) + '-' + org.id,
      newItem.isRecurringTask      = false,
      newItem.startDate            = now,
      newItem.refId = bi.id,
      newItem.endDate              = CASE
                                       WHEN bi.startDate IS NOT NULL AND bi.endDate IS NOT NULL
                                         THEN now + oldDuration
                                       ELSE NULL
                                     END

  SET bi.endDate = now

  FOREACH (_ IN CASE WHEN user IS NULL THEN [] ELSE [1] END |
    MERGE (newItem)<-[:CREATED_ITEM]-(user)
  )
  MERGE (newItem)-[:HAS_BACKLOGITEM_TYPE]->(type)
  MERGE (newItem)-[:HAS_RISK_LEVEL]->(level)
  MERGE (newItem)-[:HAS_STATUS]->(status)
  MERGE (newItem)-[:ITEM_IN_PROJECT]->(p)
  MERGE (parent)-[:HAS_CHILD_ITEM {createdAt: now}]->(newItem)
  FOREACH (a IN CASE WHEN assignedUser IS NULL THEN [] ELSE [assignedUser] END |
    MERGE (newItem)-[:HAS_ASSIGNED_USER]->(a)
  )
",
{ batchSize: 200, parallel: false, retries: 1 }
);
`;

export const CLEANUP_SOFT_DELETE_ITEMS = `
CALL apoc.periodic.iterate(
  '
  MATCH (n)
  WHERE n.deletedAt IS NOT NULL
    AND n.deletedAt < datetime() - duration($window)
  RETURN n
  ',
  '
  DETACH DELETE n
  ',
  { batchSize: 1000, parallel: false ,params:{window:$window} }
)
YIELD batches, total, failedBatches, errorMessages
RETURN total AS deletedNodes, batches, failedBatches, errorMessages
`;

export const CREATE_INVITE_USER_CQL = `
 MATCH (invite:Invite)
 WHERE
  ( $uniqueInvite IS NOT NULL AND invite.uniqueInvite = $uniqueInvite ) OR
  ( $uniqueInvite IS NULL AND invite.email = $email )
 OPTIONAL MATCH (invite)-[:INVITE_FOR]->(org:Organization)
 OPTIONAL MATCH (invite)-[:INVITE_TO_PROJECT]->(project:Project)

 MERGE (user:User {email: $email})
  ON CREATE SET user.name = $name,
  user.createdAt = datetime(),
  user.externalId = $externalId,
  user.role='SUPER_USER',
  user.id=randomUUID(),
  user.showHelpText = true,
  user.phoneNumber = COALESCE($phoneNumber, null)

  MERGE (user)-[:MEMBER_OF]->(org)
  FOREACH (p IN CASE WHEN project IS NULL THEN [] ELSE [project] END |
    MERGE (p)-[:HAS_ASSIGNED_USER]->(user)
  )

  DETACH DELETE invite
  RETURN user
`;

//clon canvas
export const COPY_FILE_CQL = `
CALL apoc.periodic.iterate(
"
  MATCH (sourceFile:File {id:$fileId})
  MATCH (user:User {externalId:$userId})
  MATCH(parent:Folder|Project {id:$parentId})
  RETURN sourceFile, user,parent
"
,
"
 MERGE (newFile:File {refId: sourceFile.id}) 
  ON CREATE SET 
    newFile.createdAt = datetime(),
    newFile.name = 'clone'+' '+ sourceFile.name,
    newFile.id = randomUUID()
MERGE (user)-[:CREATED_FILE]->(newFile)
MERGE(parent)-[:HAS_CHILD_FILE]->(newFile)
",{
 batchSize: 1,
    parallel: false,
    params: {
      fileId:$fileId,
      parentId:$parentId,
      userId:$userId
    }
  }
)
`;

export const COPY_FILE_NODES_CQL = `
CALL apoc.periodic.iterate(
    "
     MATCH(newFile:File {refId:$fileId})
     MATCH (originalFile:File {id:$fileId})
     MATCH (originalFile)-[:HAS_FLOW_NODE]->(sourceFlowNode:FlowNode)
     WHERE sourceFlowNode.deletedAt IS NULL
     RETURN newFile, sourceFlowNode",
    
    // Processing query for FlowNodes
    "WITH newFile, sourceFlowNode
     MATCH (user:User {externalId: $userId})
     MERGE (newFlowNode:FlowNode {refId: sourceFlowNode.id})
     ON CREATE SET
         newFlowNode.id = randomUUID(),
         newFlowNode.name = sourceFlowNode.name,
         newFlowNode.description = sourceFlowNode.description,
         newFlowNode.color = sourceFlowNode.color,
         newFlowNode.shape = sourceFlowNode.shape,
         newFlowNode.posX = sourceFlowNode.posX,
         newFlowNode.posY = sourceFlowNode.posY,
         newFlowNode.width = sourceFlowNode.width,
         newFlowNode.height = sourceFlowNode.height,
         newFlowNode.type = sourceFlowNode.type,
         newFlowNode.createdAt = datetime()
     WITH newFlowNode,newFile,user
     CALL apoc.lock.nodes([newFlowNode])
     MERGE (newFile)-[:HAS_FLOW_NODE]->(newFlowNode)
     MERGE (user)-[:CREATED_FLOW_NODE]->(newFlowNode)",
    {
        batchSize: 35,
        parallel: true,
        retries: 3,
        params: { fileId: $fileId,userId:$userId }
    }
)`;

export const COPY_FILE_LINKS_CQL = `
CALL apoc.periodic.iterate(
"
MATCH (newFile:File {refId: $fileId})
MATCH (newFile)-[:HAS_FLOW_NODE]->(newFlowNode:FlowNode)
MATCH (originalFile:File {id: newFile.refId})
MATCH (originalFile)-[:HAS_FLOW_NODE]->(sourceFlowNode:FlowNode {id: newFlowNode.refId})
MATCH (sourceFlowNode)-[linkTo:LINKED_TO]->(targetFlowNode:FlowNode)
WHERE targetFlowNode.deletedAt IS NULL
MATCH (newFile)-[:HAS_FLOW_NODE]->(newTargetNode:FlowNode {refId: targetFlowNode.id})
RETURN DISTINCT newFlowNode, newTargetNode, linkTo
",
"
WITH newFlowNode, newTargetNode, linkTo
MERGE (newFlowNode)-[newLink:LINKED_TO]->(newTargetNode)
ON CREATE SET
  newLink.color = linkTo.color,
  newLink.animated = linkTo.animated,
  newLink.bidirectional = linkTo.bidirectional,
  newLink.label = linkTo.label,
  newLink.id = randomUUID(),
  newLink.sourceHandle = linkTo.sourceHandle,
  newLink.targetHandle = linkTo.targetHandle,
  newLink.source = newFlowNode.id
",
{
  batchSize: 35,
  parallel: true,
  retries: 3,
  params: { fileId: $fileId }
});
`;
