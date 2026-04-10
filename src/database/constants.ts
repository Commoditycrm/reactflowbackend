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

export const CLONE_BACKLOGITEMS_ALL_LEVELS = `
CALL apoc.periodic.iterate(
  "
  MATCH (srcProject:Project {id: $templateProjectId})

  CALL {
    WITH srcProject
    OPTIONAL MATCH (srcProject)-[:HAS_CHILD_FILE]->(file:File)-[:HAS_FLOW_NODE]->(fn:FlowNode)
    WHERE file.deletedAt IS NULL
      AND fn.deletedAt IS NULL

    OPTIONAL MATCH folderPath = (srcProject)-[:HAS_CHILD_FOLDER*1..5]->(:Folder)
      -[:HAS_CHILD_FILE]->(file2:File)-[:HAS_FLOW_NODE]->(fn2:FlowNode)
    WHERE file2.deletedAt IS NULL
      AND fn2.deletedAt IS NULL
      AND ALL(x IN nodes(folderPath) WHERE NOT x:Folder OR x.deletedAt IS NULL)

    RETURN apoc.coll.toSet(collect(DISTINCT fn) + collect(DISTINCT fn2)) AS flowNodes
  }

  CALL {
    WITH srcProject, flowNodes
    UNWIND flowNodes AS fn

    MATCH p = (fn)-[:HAS_CHILD_ITEM*1..5]->(bi:BacklogItem)-[:ITEM_IN_PROJECT]->(srcProject)
    WHERE bi.deletedAt IS NULL
      AND ALL(x IN nodes(p) WHERE NOT x:BacklogItem OR x.deletedAt IS NULL)

    WITH bi, fn, p, nodes(p) AS ns, length(p) AS relLen
    RETURN
      bi,
      CASE
        WHEN relLen = 2 THEN fn
        ELSE ns[size(ns) - 3]
      END AS originalParent,
      relLen - 1 AS level

    UNION

    WITH srcProject
    MATCH p = (srcProject)-[:HAS_CHILD_ITEM*1..5]->(bi:BacklogItem)-[:ITEM_IN_PROJECT]->(srcProject)
    WHERE bi.deletedAt IS NULL
      AND ALL(x IN nodes(p) WHERE NOT x:BacklogItem OR x.deletedAt IS NULL)

    WITH bi, p, nodes(p) AS ns, length(p) AS relLen, srcProject
    RETURN
      bi,
      CASE
        WHEN relLen = 2 THEN srcProject
        ELSE ns[size(ns) - 3]
      END AS originalParent,
      relLen - 1 AS level
  }

  RETURN DISTINCT bi, originalParent, level
  ORDER BY level ASC
  ",
  "
  WITH bi, originalParent, level

  MATCH (newProject:Project {refId: $templateProjectId})
  MATCH (user:User {externalId: $userId})

  MERGE (clonedBI:BacklogItem {refId: bi.id})
  ON CREATE SET
    clonedBI.id = randomUUID(),
    clonedBI.uniqueUid = randomUUID(),
    clonedBI.uid = bi.uid,
    clonedBI.label = bi.label,
    clonedBI.description = bi.description,
    clonedBI.startDate = bi.startDate,
    clonedBI.endDate = bi.endDate,
    clonedBI.occuredOn = bi.occuredOn,
    clonedBI.paidOn = bi.paidOn,
    clonedBI.projectedExpense = bi.projectedExpense,
    clonedBI.actualExpense = bi.actualExpense,
    clonedBI.isRecurringTask = bi.isRecurringTask,
    clonedBI.scheduleDays = bi.scheduleDays,
    clonedBI.isTopLevelParentItem = bi.isTopLevelParentItem,
    clonedBI.createdAt = datetime(),
    clonedBI.updatedAt = datetime()

  MERGE (user)-[:CREATED_ITEM]->(clonedBI)
  MERGE (clonedBI)-[:ITEM_IN_PROJECT]->(newProject)

  WITH bi, clonedBI, originalParent, newProject

  OPTIONAL MATCH (bi)-[:HAS_STATUS]->(s:Status)
  FOREACH (_ IN CASE WHEN s IS NOT NULL THEN [1] ELSE [] END |
    MERGE (clonedBI)-[:HAS_STATUS]->(s)
  )

  WITH bi, clonedBI, originalParent, newProject

  OPTIONAL MATCH (bi)-[:HAS_BACKLOGITEM_TYPE]->(bit:BacklogItemType)
  FOREACH (_ IN CASE WHEN bit IS NOT NULL THEN [1] ELSE [] END |
    MERGE (clonedBI)-[:HAS_BACKLOGITEM_TYPE]->(bit)
  )

  WITH bi, clonedBI, originalParent, newProject

  OPTIONAL MATCH (bi)-[:HAS_RISK_LEVEL]->(rl:RiskLevel)
  FOREACH (_ IN CASE WHEN rl IS NOT NULL THEN [1] ELSE [] END |
    MERGE (clonedBI)-[:HAS_RISK_LEVEL]->(rl)
  )

  WITH clonedBI, originalParent, newProject

  OPTIONAL MATCH (newParentFN:FlowNode {refId: originalParent.id})
  OPTIONAL MATCH (newParentBI:BacklogItem {refId: originalParent.id})

  FOREACH (_ IN CASE WHEN originalParent:Project THEN [1] ELSE [] END |
    MERGE (newProject)-[:HAS_CHILD_ITEM]->(clonedBI)
  )

  FOREACH (_ IN CASE WHEN originalParent:FlowNode AND newParentFN IS NOT NULL THEN [1] ELSE [] END |
    MERGE (newParentFN)-[:HAS_CHILD_ITEM]->(clonedBI)
  )

  FOREACH (_ IN CASE WHEN originalParent:BacklogItem AND newParentBI IS NOT NULL THEN [1] ELSE [] END |
    MERGE (newParentBI)-[:HAS_CHILD_ITEM]->(clonedBI)
  )
  ",
  {
    batchSize: 25,
    parallel: false,
    iterateList: true,
    retries: 3,
    params: {
      templateProjectId: $templateProjectId,
      userId: $userId
    }
  }
);
`;

export const LINK_CLONED_BACKLOG_ITEMS = `
MATCH (newRoot:Project {refId: $templateProjectId})

MATCH (child:BacklogItem {projectId: newRoot.id})
WHERE child.refId IS NOT NULL
  AND child.parentSourceId IS NOT NULL
  AND child.parentSourceLabel IS NOT NULL

CALL {
  WITH newRoot, child
  WHERE child.parentSourceLabel = 'Project'
  MERGE (newRoot)-[:HAS_CHILD_ITEM]->(child)
  RETURN 1 AS linked

  UNION

  WITH newRoot, child
  WHERE child.parentSourceLabel = 'BacklogItem'
  MATCH (parentClone:BacklogItem {
    refId: child.parentSourceId,
    projectId: newRoot.id
  })
  MERGE (parentClone)-[:HAS_CHILD_ITEM]->(child)
  RETURN 1 AS linked

  UNION

  WITH newRoot, child
  WHERE child.parentSourceLabel = 'FlowNode'

  CALL {
    WITH newRoot
    OPTIONAL MATCH (newRoot)-[:HAS_CHILD_FILE]->(rf:File)-[:HAS_FLOW_NODE]->(rfn:FlowNode)
    WHERE rf.deletedAt IS NULL AND rfn.deletedAt IS NULL

    OPTIONAL MATCH pathFolder=(newRoot)-[:HAS_CHILD_FOLDER*1..5]->(:Folder)-[:HAS_CHILD_FILE]->(nf:File)-[:HAS_FLOW_NODE]->(nfn:FlowNode)
    WHERE nf.deletedAt IS NULL AND nfn.deletedAt IS NULL
      AND ALL(x IN nodes(pathFolder) WHERE NOT x:Folder OR x.deletedAt IS NULL)

    RETURN apoc.coll.toSet(collect(DISTINCT rfn) + collect(DISTINCT nfn)) AS newFlowNodes
  }

  UNWIND newFlowNodes AS f
  WITH child, f
  WHERE f.refId = child.parentSourceId
  MERGE (f)-[:HAS_CHILD_ITEM]->(child)
  RETURN 1 AS linked
}

RETURN count(*) AS totalLinked
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

export const CREATE_RECURRING_TASKS = `
CALL apoc.periodic.iterate(
"
  MATCH (bi:BacklogItem {isRecurringTask: true})-[:ITEM_IN_PROJECT]->(p:Project)
  WHERE bi.deletedAt IS NULL
    AND p.deletedAt IS NULL
    AND bi.scheduleDays IS NOT NULL
    AND bi.scheduleDays > 0
    AND bi.startDate IS NOT NULL
    AND bi.endDate => datetime()

  WITH bi, p, coalesce(bi.lastRecurringCreatedAt, bi.startDate) AS baseDate
  WHERE date(datetime()) >= date(baseDate) + duration({days: bi.scheduleDays})

  MATCH (org)-[:HAS_PROJECTS]->(p)
  MATCH (org)-[:HAS_COUNTER]->(orgCounter:Counter)
  MATCH (bi)-[:HAS_BACKLOGITEM_TYPE]->(type:BacklogItemType)
  WHERE toLower(coalesce(type.defaultName, type.name, '')) <> 'expense'
  MATCH (bi)-[:HAS_RISK_LEVEL]->(level:RiskLevel)
  MATCH (org)-[:HAS_STATUS]->(status:Status)
  WHERE toLower(coalesce(status.defaultName, status.name, '')) CONTAINS 'not started'

  OPTIONAL MATCH (creator:User)-[:CREATED_ITEM]->(bi)
  OPTIONAL MATCH (bi)-[:HAS_ASSIGNED_USER]->(assignedUser:User)

  MATCH (parent)-[:HAS_CHILD_ITEM]->(bi)
  WHERE
    (
      parent:Project
      AND parent.deletedAt IS NULL
    )
    OR
    (
      parent:FlowNode
      AND parent.deletedAt IS NULL
    )
    OR
    (
      parent:BacklogItem
      AND parent.deletedAt IS NULL
    )

  WITH bi, p, org, orgCounter, type, level, status,
       head(collect(DISTINCT parent)) AS parent,
       head(collect(DISTINCT creator)) AS user,
       collect(DISTINCT assignedUser) AS assignedUsers
  WHERE parent IS NOT NULL

  RETURN DISTINCT
    bi,
    p,
    org,
    orgCounter,
    type,
    level,
    status,
    parent,
    user,
    assignedUsers
",
"
  WITH bi, p, org, orgCounter, type, level, status, parent, user, assignedUsers,
       datetime() AS now,
       CASE
         WHEN bi.startDate IS NOT NULL AND bi.endDate IS NOT NULL
         THEN duration.between(bi.startDate, bi.endDate)
         ELSE NULL
       END AS oldDuration

  CALL apoc.atomic.add(orgCounter, 'counter', 1) YIELD newValue

  CREATE (newItem:BacklogItem)
  SET newItem.id = randomUUID(),
      newItem.label = coalesce(bi.label, ''),
      newItem.description = bi.description,
      newItem.createdAt = now,
      newItem.startDate = now,
      newItem.endDate = CASE
                          WHEN oldDuration IS NOT NULL THEN now + oldDuration
                          ELSE NULL
                        END,
      newItem.isTopLevelParentItem = coalesce(bi.isTopLevelParentItem, false),
      newItem.projectedExpense = bi.projectedExpense,
      newItem.occuredOn = datetime(),
      newItem.uid = newValue,
      newItem.uniqueUid = toString(toInteger(newValue)) + '-' + org.id,
      newItem.isRecurringTask = false,
      newItem.refId = bi.id

  SET bi.lastRecurringCreatedAt = now

  FOREACH (_ IN CASE WHEN user IS NULL THEN [] ELSE [1] END |
    MERGE (newItem)<-[:CREATED_ITEM]-(user)
  )

  MERGE (newItem)-[:HAS_BACKLOGITEM_TYPE]->(type)
  MERGE (newItem)-[:HAS_RISK_LEVEL]->(level)
  MERGE (newItem)-[:HAS_STATUS]->(status)
  MERGE (newItem)-[:ITEM_IN_PROJECT]->(p)
  CREATE (parent)-[:HAS_CHILD_ITEM {createdAt: now}]->(newItem)

  FOREACH (a IN assignedUsers |
    FOREACH (_ IN CASE WHEN a IS NULL THEN [] ELSE [1] END |
      MERGE (newItem)-[:HAS_ASSIGNED_USER]->(a)
    )
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

export const CLEANUP_DUMMY_PROJECTS_CQL = `
CALL apoc.periodic.iterate(
  "
  MATCH (n:Project) WHERE NOT EXISTS(()-[:HAS_PROJECTS]->(n)) 
  RETURN n
  ",
  "
  DETACH DELETE n
  ",
  { batchSize: 100, parallel: true }
)
YIELD  batches, total
RETURN  batches, total
`;

export const CLEANUP_DUMMY_FOLDERS_CQL = `
CALL apoc.periodic.iterate(
  "
  MATCH (n:Folder)
  WHERE NOT EXISTS (()-[:HAS_CHILD_FOLDER]->(n))
  RETURN n
  ",
  "
  DETACH DELETE n
  ",
  { batchSize: 100, parallel: true }
)
YIELD  batches, total
RETURN  batches, total
`;

export const CLEANUP_DUMMY_FILES_CQL = `
CALL apoc.periodic.iterate(
  "
  MATCH (n:File) WHERE NOT EXISTS(()-[:HAS_CHILD_FILE]->(n))
  RETURN n
  ",
  "
  DETACH DELETE n
  ",
  { batchSize: 100, parallel: true }
)
YIELD  batches, total
RETURN  batches, total
`;

export const CLEANUP_DUMMY_NODES_CQL = `
CALL apoc.periodic.iterate(
  "
  MATCH (n:FlowNode) WHERE NOT EXISTS(()-[:HAS_FLOW_NODE]->(n))
  RETURN n
  ",
  "
  DETACH DELETE n
  ",
  { batchSize: 100, parallel: true }
)
YIELD  batches, total
RETURN  batches, total
`;

export const CLEANUP_DUMMY_ITEMS_CQL = `
CALL apoc.periodic.iterate(
  "
  MATCH (n:BacklogItem) WHERE NOT EXISTS(()-[:HAS_CHILD_ITEM]->(n))
  RETURN n
  UNION 
  MATCH (n:BacklogItem) WHERE NOT EXISTS((n)-[:ITEM_IN_PROJECT]->())
  RETURN n
  ",
  "
  DETACH DELETE n
  ",
  { batchSize: 100, parallel: true }
)
YIELD  batches, total
RETURN  batches, total
`;

export const CLEANUP_DUMMY_COMMENTS_CQL = `
CALL apoc.periodic.iterate(
  "
  MATCH (n:Comment) WHERE NOT EXISTS(()-[:HAS_COMMENT]->(n))
  RETURN n
  ",
  "
  DETACH DELETE n
  ",
  { batchSize: 100, parallel: true }
)
YIELD  batches, total
RETURN  batches, total
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
    newFile.name = $name,
    newFile.id = randomUUID()
MERGE (user)-[:CREATED_FILE]->(newFile)
MERGE(parent)-[:HAS_CHILD_FILE]->(newFile)
",{
 batchSize: 1,
    parallel: false,
    params: {
      fileId:$fileId,
      parentId:$parentId,
      userId:$userId,
      name:$name
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
         newFlowNode.createdAt = datetime(),
         newFlowNode.fontSize = sourceFlowNode.fontSize,
         newFlowNode.textDecoration = sourceFlowNode.textDecoration
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

export const COPY_FILE_GROUP_NODE_CQL = `
CALL apoc.periodic.iterate(
    "
     MATCH(newFile:File {refId:$fileId})
     MATCH (originalFile:File {id:$fileId})
     MATCH (originalFile)-[:HAS_GROUP_NODE]->(groupNode:GroupNode)
     WHERE groupNode.deletedAt IS NULL
     RETURN newFile, groupNode",
    
    "WITH newFile, groupNode
     MATCH (user:User {externalId: $userId})
     MERGE (newGroupNode:GroupNode {refId: groupNode.id})
     ON CREATE SET
         newGroupNode.id = randomUUID(),
         newGroupNode.name = groupNode.name,
         newGroupNode.color = groupNode.color,
         newGroupNode.posX = groupNode.posX,
         newGroupNode.posY = groupNode.posY,
         newGroupNode.width = groupNode.width,
         newGroupNode.height = groupNode.height,
         newGroupNode.layoutType = groupNode.layoutType,
         newGroupNode.createdAt = datetime()
     WITH newGroupNode,newFile,user
     CALL apoc.lock.nodes([newGroupNode])
     MERGE (newFile)-[:HAS_GROUP_NODE]->(newGroupNode)
     MERGE (user)-[:CREATED_GROUP_NODE]->(newGroupNode)",
    {
        batchSize: 35,
        parallel: true,
        retries: 3,
        params: { fileId: $fileId,userId:$userId }
    }
)`;

export const COPY_FILE_GROUP_CHILD_CONNECTION_CQL = `
CALL apoc.periodic.iterate(
"
  MATCH (originalFile:File {id:$fileId})-[:HAS_FLOW_NODE]->(origChild:FlowNode)-[:BELONGS_TO_GROUP]->(origGroup:GroupNode)
  WHERE origChild.deletedAt IS NULL AND origGroup.deletedAt IS NULL
  RETURN origChild, origGroup
",
"
  WITH origChild, origGroup
  MATCH (newGroup:GroupNode {refId: origGroup.id})
  MATCH (newChild:FlowNode {refId: origChild.id})

  OPTIONAL MATCH (newChild)-[r:BELONGS_TO_GROUP]->(:GroupNode)
  DELETE r

  MERGE (newChild)-[:BELONGS_TO_GROUP]->(newGroup)
",
{
  batchSize: 500,
  parallel: false,
  retries: 3,
  params: { fileId: $fileId }
}
);
`;

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

export const IMPORT_BACKLOGITEMS_ROWS_CREATE = `
CALL apoc.periodic.iterate(
  "
  UNWIND $rows AS row
  RETURN row
  ",
  "
  WITH row
  MATCH (newRoot:Project {id:$projectId})
  MATCH (newRoot)<-[:HAS_PROJECTS]-(org:Organization)
  MATCH (org)-[:HAS_COUNTER]->(orgCounter:Counter)
  MATCH (user:User {externalId:$userId})

  WITH row, newRoot, org, orgCounter, user,
       coalesce(nullIf(trim(toString(row.workItemType)), ''), 'Epic') AS typeName,
       coalesce(nullIf(trim(toString(row.statusLabel)), ''), 'Not started') AS statusName,
       trim(toString(row.id)) AS refRaw,
       trim(toString(row.parentIdResolved)) AS parentRaw,
       row.sprints AS sprintsList,
       trim(toString(row.label)) AS label

  WITH row, newRoot, org, orgCounter, user, typeName, statusName, sprintsList, label,
       CASE WHEN refRaw =~ '^[0-9]+\\.[0]+$' THEN toString(toInteger(refRaw)) ELSE refRaw END AS refId,
       CASE WHEN parentRaw =~ '^[0-9]+\\.[0]+$' THEN toString(toInteger(parentRaw)) ELSE parentRaw END AS parentRef

  CALL {
    WITH org, typeName
    OPTIONAL MATCH (org)-[:HAS_BACKLOGITEM_TYPE]->(t:BacklogItemType)
    WHERE toLower(t.defaultName) = toLower(typeName)
    RETURN head(collect(t)) AS itemType
  }

  CALL {
    WITH org
    OPTIONAL MATCH (org)-[:HAS_RISK_LEVEL]->(r:RiskLevel)
    WHERE toLower(r.defaultName) CONTAINS 'low'
    RETURN head(collect(r)) AS itemRiskLevel
  }

  CALL {
    WITH org, statusName
    OPTIONAL MATCH (org)-[:HAS_STATUS]->(s:Status)
    WHERE toLower(s.defaultName) = toLower(statusName) OR toLower(s.defaultName) CONTAINS toLower(statusName)
    RETURN head(collect(s)) AS status
  }

  WITH row, newRoot, org, orgCounter, user, itemType, itemRiskLevel, status,
       refId, parentRef, sprintsList, label
  WHERE refId <> '' AND label <> '' AND itemType IS NOT NULL AND itemRiskLevel IS NOT NULL AND status IS NOT NULL

  CALL apoc.atomic.add(orgCounter, 'counter', 1) YIELD newValue AS newUid

  MERGE (bi:BacklogItem {refId: refId, projectId: newRoot.id})
  ON CREATE SET
    bi.id = randomUUID(),
    bi.createdAt = datetime(),
    bi.uid = newUid,
    bi.uniqueUid = toString(toInteger(newUid)) + '-' + org.id,
    bi.startDate = datetime(),
    bi.endDate = datetime(),
    bi.isRecurringTask = false,
    bi.isTopLevelParentItem = false

  SET bi.label = label

  SET bi.parentRefId =
    CASE
      WHEN parentRef IS NULL OR trim(parentRef) = '' OR trim(parentRef) = $projectId THEN null
      ELSE trim(parentRef)
    END

  SET bi.sprintsRef = CASE WHEN sprintsList IS NULL THEN [] ELSE sprintsList END

  MERGE (bi)<-[:CREATED_ITEM]-(user)
  MERGE (bi)-[:HAS_BACKLOGITEM_TYPE]->(itemType)
  MERGE (bi)-[:HAS_RISK_LEVEL]->(itemRiskLevel)
  MERGE (bi)-[:HAS_STATUS]->(status)
  MERGE (bi)-[:ITEM_IN_PROJECT]->(newRoot)

  FOREACH (_ IN CASE WHEN bi.parentRefId IS NULL THEN [1] ELSE [] END |
    MERGE (newRoot)-[:HAS_CHILD_ITEM]->(bi)
  )

  RETURN 1
  ",
  {
    batchSize: $batchSize,
    parallel: true,
    retries: 3,
    params: { projectId: $projectId, userId: $userId, rows: $rows }
  }
)
YIELD batches, total, failedBatches, failedOperations, errorMessages
RETURN {batches:batches, total:total, failedBatches:failedBatches, failedOperations:failedOperations, errorMessages:errorMessages} AS result
`;

export const IMPORT_BACKLOGITEMS_ROWS_CONNECT_PARENTS = `
CALL apoc.periodic.iterate(
  "
  MATCH (p:Project {id:$projectId})
  MATCH (c:BacklogItem {projectId: p.id})
  WHERE c.parentRefId IS NOT NULL AND trim(c.parentRefId) <> ''
  RETURN p, c
  ",
  "
  WITH p, c, trim(c.parentRefId) AS prefRaw
  WITH p, c,
       CASE WHEN prefRaw =~ '^[0-9]+\\.[0]+$' THEN toString(toInteger(prefRaw)) ELSE prefRaw END AS pref

  MATCH (par:BacklogItem {refId: pref, projectId: p.id})

  OPTIONAL MATCH (anyParent)-[r:HAS_CHILD_ITEM]->(c)
  DELETE r

  MERGE (par)-[:HAS_CHILD_ITEM]->(c)

  RETURN 1
  ",
  {
    batchSize: $batchSize,
    parallel: false,
    retries: 3,
    params: { projectId: $projectId }
  }
)
YIELD batches, total, failedBatches, failedOperations, errorMessages
RETURN {batches:batches, total:total, failedBatches:failedBatches, failedOperations:failedOperations, errorMessages:errorMessages} AS result
`;

export const IMPORT_BACKLOGITEMS_CREATE_SPRINTS_AND_CONNECT = `
CALL apoc.periodic.iterate(
  "
  MATCH (p:Project {id:$projectId})
  MATCH (u:User {externalId:$userId})
  MATCH (bi:BacklogItem {projectId: p.id})
  WHERE bi.sprintsRef IS NOT NULL AND size(bi.sprintsRef) > 0
  RETURN p, u, bi
  ",
  "
  WITH p, u, bi
  UNWIND bi.sprintsRef AS sprintRaw
  WITH p, u, bi, trim(toString(sprintRaw)) AS sprintName
  WHERE sprintName <> ''

  WITH p, u, bi, sprintName, (p.id + '-' + toLower(sprintName)) AS sprintKey

  MERGE (s:Sprint {uniqueSprint: sprintKey})
  ON CREATE SET
    s.id = randomUUID(),
    s.name = sprintName,
    s.startDate = datetime(),
    s.endDate = datetime()
  ON MATCH SET
    s.name = sprintName

  MERGE (u)-[:CREATED_SPRINT]->(s)
  MERGE (s)-[:HAS_SPRINTS]->(p)      
  MERGE (bi)-[:HAS_SPRINTS]->(s)     

  RETURN 1
  ",
  {
    batchSize: $batchSize,
    parallel: false,
    retries: 3,
    params: { projectId: $projectId, userId: $userId }
  }
)
YIELD batches, total, failedBatches, failedOperations, errorMessages
RETURN {batches:batches, total:total, failedBatches:failedBatches, failedOperations:failedOperations, errorMessages:errorMessages} AS result
`;

export const IMPORT_CONTACTS_QUERY = `
CALL apoc.periodic.iterate(
  "
  UNWIND $rows AS row
  RETURN row
  ",
  "
  // 1) Find organization
  MATCH (org:Organization {id: row.organizationId})

  // 2) Create or update contact
  MERGE (c:Contact {
    organizationRowKey: row.organizationId + '|' + coalesce(row.email, row.name)
  })
  ON CREATE SET
    c.id = randomUUID(),
    c.createdAt = datetime(),
    c.lastModified = datetime()
  SET
    c.resourceType = row.resourceType,
    c.firstName = row.firstName,
    c.lastName = coalesce(row.lastName, ''),
    c.middleName = row.middleName,
    c.name = coalesce(row.name, trim(coalesce(row.firstName,'') + ' ' + coalesce(row.lastName,''))),
    c.email = row.email,
    c.phone = row.phone,
    c.role = row.role,
    c.linkedin = row.linkedin,
    c.updatedAt = datetime(),
    c.lastModified = datetime()

  // 3) Connect organization -> contact
  MERGE (org)-[:HAS_RESOURCE]->(c)

  // 4) Create/update address only if at least one address field exists
  FOREACH (_ IN CASE
    WHEN row.address IS NOT NULL AND (
      row.address.street IS NOT NULL OR
      row.address.city IS NOT NULL OR
      row.address.state IS NOT NULL OR
      row.address.country IS NOT NULL OR
      row.address.postalCode IS NOT NULL
    )
    THEN [1] ELSE [] END |

    MERGE (a:Address {
      contactAddressKey:
        c.id + '|' +
        coalesce(row.address.street,'') + '|' +
        coalesce(row.address.city,'') + '|' +
        coalesce(row.address.state,'') + '|' +
        coalesce(row.address.country,'') + '|' +
        coalesce(row.address.postalCode,'')
    })
    ON CREATE SET
      a.id = randomUUID(),
      a.createdAt = datetime(),
      a.lastModified = datetime()
    SET
      a.street = row.address.street,
      a.city = row.address.city,
      a.state = row.address.state,
      a.country = row.address.country,
      a.postalCode = row.address.postalCode,
      a.updatedAt = datetime(),
      a.lastModified = datetime()

    MERGE (c)-[:HAS_ADDRESS]->(a)
  )
  ",
  {
    batchSize: 100,
    parallel: false,
    params: { rows:$rows }
  }
);
`;
