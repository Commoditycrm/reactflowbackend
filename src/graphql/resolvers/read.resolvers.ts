import logger from "../../logger";
import { OGMConnection } from "../init/ogm.init";
import { v4 as uuidv4 } from "uuid";
import { getFirebaseAdminAuth } from "../firebase/admin";
import { GraphQLError } from "graphql";
import { ApolloServerErrorCode } from "@apollo/server/errors";
import { BacklogItemType, SprintWhere, User, UserRole } from "../../interfaces";
import { EnvLoader } from "../../util/EnvLoader";
import { Neo4JConnection } from "../../database/connection";
import { GeneratedTask } from "../../interfaces/types";
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({
  apiKey: EnvLoader.getOrThrow("ANTHROPIC_API_KEY"),
});

export const getModelWhereClause = (
  modelName: string,
  loggedInUser: User,
): Record<string, any> => {
  const commonOrgWhere = {
    organization: {
      id:
        loggedInUser?.ownedOrganization?.id ||
        loggedInUser?.memberOfOrganizations[0]?.id,
    },
  };

  switch (modelName) {
    case "Project":
      return {
        ...commonOrgWhere,
      };
    case "Folder":
      return {
        project: {
          ...commonOrgWhere,
        },
      };
    case "File":
      return {
        OR: [
          {
            parentConnection: {
              Folder: {
                node: {
                  project: {
                    ...commonOrgWhere,
                  },
                },
              },
            },
          },
          {
            parentConnection: {
              Project: {
                node: {
                  ...commonOrgWhere,
                },
              },
            },
          },
        ],
      };
    case "FlowNode":
      return {
        file: {
          OR: [
            {
              parentConnection: {
                Project: {
                  node: {
                    ...commonOrgWhere,
                  },
                },
              },
            },
            {
              parentConnection: {
                Folder: {
                  node: {
                    project: {
                      ...commonOrgWhere,
                    },
                  },
                },
              },
            },
          ],
        },
      };
    case "BacklogItem":
      return {
        project: {
          ...commonOrgWhere,
        },
      };
    case "Sprint":
      return {
        project: {
          ...commonOrgWhere,
        },
      };
    default:
      return {};
  }
};

// Function to fetch the logged-in user
const getLoggedInUser = async (context: Record<string, any>): Promise<User> => {
  const User = await (await OGMConnection.getInstance()).model("User");

  const loggedInUser = await User.find<User[]>({
    where: { externalId: context?.jwt?.sub },
    selectionSet: `
    {
        ownedOrganization {
            id 
        } 
        memberOfOrganizations 
        {
            id
        }
    }`,
  });

  if (!loggedInUser[0]) {
    throw new Error("Logged-in user not found.");
  }
  return loggedInUser[0];
};

// Function to fetch soft-deleted items
const fetchSoftDeletedItems = async (
  modelName: string,
  loggedInUser: User,
  { limit, offset }: { limit: number; offset: number },
  context: Record<string, any>,
  selectionSet: string,
) => {
  const Model = await (await OGMConnection.getInstance()).model(modelName);
  const whereClause = getModelWhereClause(modelName, loggedInUser);

  return await Model.find({
    where: {
      NOT: { deletedAt: null },
      ...whereClause,
    },
    options: {
      limit: limit ? limit : 10,
      offset: offset > 0 ? offset : 0,
    },
    selectionSet,
    rootValue: {},
    context,
  });
};

// Main function to retrieve soft-deleted items
const fetchSoftDeletedItemsByType = async (
  modelName: string,
  _source: Record<string, any>,
  { limit, offset }: { limit: number; offset: number },
  _context: Record<string, any>,
  selectionSet: string,
) => {
  try {
    const loggedInUser = await getLoggedInUser(_context);
    const deletedItems = await fetchSoftDeletedItems(
      modelName,
      loggedInUser,
      { limit, offset },
      _context,
      selectionSet,
    );
    logger?.info(`Reading soft deleted ${modelName} items completed`);
    return deletedItems;
  } catch (error) {
    logger?.error(error);
    throw error;
  }
};

// Function to retrieve soft-deleted folders
const softDeletedFolders = async (
  _source: Record<string, any>,
  { limit, offset }: { limit: number; offset: number },
  _context: Record<string, any>,
) => {
  return fetchSoftDeletedItemsByType(
    "Folder",
    _source,
    { limit, offset },
    _context,
    `{ id name deletedAt createdBy { id name email role }}`,
  );
};

// Function to retrieve soft-deleted files
const softDeletedFiles = async (
  _source: Record<string, any>,
  { limit, offset }: { limit: number; offset: number },
  _context: Record<string, any>,
) => {
  return fetchSoftDeletedItemsByType(
    "File",
    _source,
    { limit, offset },
    _context,
    `{ id name deletedAt createdBy { id name email role } }`,
  );
};

// Function to retrieve soft-deleted backlog items
const softDeletedBacklogItems = async (
  _source: Record<string, any>,
  { limit, offset }: { limit: number; offset: number },
  _context: Record<string, any>,
) => {
  return fetchSoftDeletedItemsByType(
    "BacklogItem",
    _source,
    { limit, offset },
    _context,
    `{ id label deletedAt createdBy { id name email role } type { id name } }`,
  );
};

// Function to retrieve soft-deleted flow nodes
const softDeletedFlowNodes = async (
  _source: Record<string, any>,
  {
    limit,
    offset,
    where,
  }: { limit: number; offset: number; where: SprintWhere },
  _context: Record<string, any>,
) => {
  return fetchSoftDeletedItemsByType(
    "FlowNode",
    _source,
    { limit, offset },
    _context,
    `{ id name  deletedAt createdBy { id name email role }}`,
  );
};

const softDeleteSprints = async (
  _source: Record<string, any>,
  {
    limit,
    offset,
    where,
  }: { limit: number; offset: number; where: SprintWhere },
  _context: Record<string, any>,
) => {
  return fetchSoftDeletedItemsByType(
    "Sprint",
    _source,
    { limit, offset },
    _context,
    `{ id name deletedAt createdBy { id name email role }}`,
  );
};

const softDeleteProjects = async (
  _source: Record<string, any>,
  {
    limit,
    offset,
    where,
  }: { limit: number; offset: number; where: SprintWhere },
  _context: Record<string, any>,
) => {
  return fetchSoftDeletedItemsByType(
    "Project",
    _source,
    { limit, offset },
    _context,
    `{ id name deletedAt createdBy { id name email role }}`,
  );
};

const countSoftDeletedItems = async (
  modelName: string,
  loggedInUser: User,
  context: Record<string, any>,
): Promise<number> => {
  const Model = await (await OGMConnection.getInstance()).model(modelName);
  const whereClause = getModelWhereClause(modelName, loggedInUser);

  const result = await Model.aggregate({
    where: {
      NOT: { deletedAt: null },
      ...whereClause,
    },
    aggregate: {
      count: true,
    },
    context,
  });
  return result?.count || 0;
};

const countAllSoftDeletedItems = async (
  _source: Record<string, any>,
  _args: Record<string, any>,
  _context: Record<string, any>,
) => {
  try {
    const loggedInUser = await getLoggedInUser(_context);

    const models = [
      "Folder",
      "File",
      "BacklogItem",
      "FlowNode",
      "Sprint",
      "Project",
    ];

    const counts = await Promise.all(
      models.map(async (modelName) => ({
        type: modelName,
        count: await countSoftDeletedItems(modelName, loggedInUser, _context),
      })),
    );
    return counts;
  } catch (error) {
    logger?.error(error);
    throw new Error("Failed to count soft-deleted items.");
  }
};

export const generateTask = async (
  _source: Record<string, any>,
  { prompt }: { prompt: string },
  _context: Record<string, any>,
): Promise<GeneratedTask[]> => {
  const uid = _context?.jwt?.uid;

  if (!uid) {
    throw new GraphQLError("UNAUTHORIZED", {
      extensions: { code: "UNAUTHORIZED" },
    });
  }

  const neo4j = await Neo4JConnection.getInstance();
  const session = neo4j.driver.session();

  try {
    const result = await session.executeRead((tx) =>
      tx.run(
        `
        MATCH (u:User {externalId: $uid})-[:OWNS|MEMBER_OF]->(org:Organization)
        MATCH (org)-[:HAS_BACKLOGITEM_TYPE]->(t:BacklogItemType)
        RETURN {
          id: t.id,
          name: t.name,
          defaultName: t.defaultName
        } AS type
        `,
        { uid },
      ),
    );

    if (result.records.length === 0) {
      throw new GraphQLError("UNAUTHORIZED", {
        extensions: { code: "UNAUTHORIZED" },
      });
    }

    const orgTypes = result.records.map((record) => {
      const type = record.get("type");
      return {
        id: type.id,
        name: type.name,
        defaultName: type.defaultName,
      } as BacklogItemType;
    });

    const normalizedPrompt = (prompt || "").toLowerCase().trim();

    const matchedType =
      orgTypes
        .map((type) => ({
          ...type,
          _matchName: (type.defaultName ?? type.name ?? "").trim(),
        }))
        .filter((type) => type._matchName.length > 0)
        .sort((a, b) => b._matchName.length - a._matchName.length)
        .find((type) =>
          normalizedPrompt.includes(type._matchName.toLowerCase()),
        ) ?? null;

    const matchedTypeData = matchedType
      ? ({
          id: matchedType.id,
          name: matchedType.name,
          defaultName: matchedType.defaultName,
          createdAt: new Date(),
          updatedAt: undefined,
        } as BacklogItemType)
      : null;

    const safePrompt = (prompt || "").trim().slice(0, 1000);
    const detectedTypeName =
      matchedTypeData?.defaultName || matchedTypeData?.name || "General";

    const completion = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 180,
      temperature: 0.3,
      system: "Generate concise task lists.",
      messages: [
        {
          role: "user",
          content: `
            Input: ${safePrompt}
            Detected task type: ${detectedTypeName}

            Rules:
             - Generate 4 to 6 tasks only
             - Each task must be actionable
             - Each description must be under 120 characters
             - Output valid JSON only
             - Do not include markdown
             - Do not include explanation
             - Use this exact format

            [
              { "task": "...", "description": "..." }
            ]
            `.trim(),
        },
      ],
    });

    const textBlock = completion.content.find(
      (block): block is Anthropic.TextBlock => block.type === "text",
    );

    const rawText = textBlock?.text?.trim() || "";

    // Extract JSON array safely in case model adds accidental text
    const jsonMatch = rawText.match(/\[[\s\S]*\]/);
    const jsonString = jsonMatch ? jsonMatch[0] : "[]";

    let parsedTasks: Array<{ task: string; description: string }> = [];

    try {
      const parsed = JSON.parse(jsonString);

      if (Array.isArray(parsed)) {
        parsedTasks = parsed;
      }
    } catch (parseError) {
      logger?.error("Failed to parse Anthropic JSON response", parseError);
    }

    const tasks: GeneratedTask[] = parsedTasks
      .filter(
        (item) =>
          item &&
          typeof item.task === "string" &&
          typeof item.description === "string" &&
          item.task.trim().length > 0 &&
          item.description.trim().length > 0,
      )
      .slice(0, 6)
      .map((item) => ({
        id: uuidv4(),
        content: item.task.trim(),
        description: item.description.trim().slice(0, 120),
        type: matchedTypeData,
      }));

    if (tasks.length > 0) {
      return tasks;
    }

    return [
      {
        id: uuidv4(),
        content: "No tasks could be generated",
        description: "Please refine the prompt to generate meaningful tasks.",
        type: matchedTypeData,
      },
    ];
  } catch (error: any) {
    logger?.error("generateTask error", error);

    const anthropicMessage =
      error?.error?.message ||
      error?.message ||
      "Failed to fetch response from Anthropic.";

    const isBillingIssue =
      anthropicMessage.toLowerCase().includes("credit balance is too low") ||
      anthropicMessage.toLowerCase().includes("billing");

    throw new GraphQLError(
      isBillingIssue
        ? "Anthropic API credits are exhausted. Please add credits in Plans & Billing."
        : anthropicMessage,
      {
        extensions: {
          code: isBillingIssue ? "PAYMENT_REQUIRED" : "INTERNAL_SERVER_ERROR",
        },
      },
    );
  } finally {
    await session.close();
  }
};

const getFirebaseStorage = async (
  _source: Record<string, any>,
  { orgId }: { orgId: string },
  _context: Record<string, any>,
) => {
  const app = getFirebaseAdminAuth();
  const userRole = _context?.jwt?.roles;
  if (userRole[0] !== UserRole.SystemAdmin) {
    throw new GraphQLError("UNAUTHORIZED", {
      extensions: {
        code: ApolloServerErrorCode.INTERNAL_SERVER_ERROR,
      },
    });
  }
  const bucket = app.storage().bucket();
  const prefix = `attachments/org:${orgId}/`;

  try {
    const [files] = await bucket.getFiles({ prefix });
    if (!files.length) {
      return {
        orgId,
        fileCount: 0,
        totalBytes: 0,
        totalMB: 0,
      };
    }

    const totalBytes = files.reduce((sum, file) => {
      const size = Number(file?.metadata?.size) || 0;
      return sum + size;
    }, 0);

    return {
      orgId,
      fileCount: files.length,
      totalBytes,
      totalMB: parseFloat((totalBytes / (1024 * 1024)).toFixed(2)),
    };
  } catch (error) {
    logger?.error(`Error while fething storage from firebase:${error}`);
    throw new Error("Field to fetch firebase storage");
  }
};

export const readOperationQueries = {
  softDeletedFolders,
  softDeletedFiles,
  softDeletedBacklogItems,
  softDeletedFlowNodes,
  softDeleteSprints,
  softDeleteProjects,
  generateTask,
  countAllSoftDeletedItems,
  getFirebaseStorage,
};
