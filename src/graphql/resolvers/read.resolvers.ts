import logger from "../../logger";
import { OGMConnection } from "../init/ogm.init";
import OpenAI from "openai";
import { v4 as uuidv4 } from "uuid";
import { getFirebaseAdminAuth } from "../firebase/admin";
import { GraphQLError } from "graphql";
import { ApolloServerErrorCode } from "@apollo/server/errors";
import { EnvLoader } from "../../util/EnvLoader";
import { SprintWhere, User, UserRole } from "../../@types/ogm.types";
export const getModelWhereClause = (
  modelName: string,
  loggedInUser: User
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
  selectionSet: string
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
  selectionSet: string
) => {
  try {
    const loggedInUser = await getLoggedInUser(_context);
    const deletedItems = await fetchSoftDeletedItems(
      modelName,
      loggedInUser,
      { limit, offset },
      _context,
      selectionSet
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
  _context: Record<string, any>
) => {
  return fetchSoftDeletedItemsByType(
    "Folder",
    _source,
    { limit, offset },
    _context,
    `{ id name deletedAt createdBy { id name email role }}`
  );
};

// Function to retrieve soft-deleted files
const softDeletedFiles = async (
  _source: Record<string, any>,
  { limit, offset }: { limit: number; offset: number },
  _context: Record<string, any>
) => {
  return fetchSoftDeletedItemsByType(
    "File",
    _source,
    { limit, offset },
    _context,
    `{ id name deletedAt createdBy { id name email role } }`
  );
};

// Function to retrieve soft-deleted backlog items
const softDeletedBacklogItems = async (
  _source: Record<string, any>,
  { limit, offset }: { limit: number; offset: number },
  _context: Record<string, any>
) => {
  return fetchSoftDeletedItemsByType(
    "BacklogItem",
    _source,
    { limit, offset },
    _context,
    `{ id label deletedAt createdBy { id name email role } type { id name } }`
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
  _context: Record<string, any>
) => {
  return fetchSoftDeletedItemsByType(
    "FlowNode",
    _source,
    { limit, offset },
    _context,
    `{ id name  deletedAt createdBy { id name email role }}`
  );
};

const softDeleteSprints = async (
  _source: Record<string, any>,
  {
    limit,
    offset,
    where,
  }: { limit: number; offset: number; where: SprintWhere },
  _context: Record<string, any>
) => {
  return fetchSoftDeletedItemsByType(
    "Sprint",
    _source,
    { limit, offset },
    _context,
    `{ id name deletedAt createdBy { id name email role }}`
  );
};

const softDeleteProjects = async (
  _source: Record<string, any>,
  {
    limit,
    offset,
    where,
  }: { limit: number; offset: number; where: SprintWhere },
  _context: Record<string, any>
) => {
  return fetchSoftDeletedItemsByType(
    "Project",
    _source,
    { limit, offset },
    _context,
    `{ id name deletedAt createdBy { id name email role }}`
  );
};

const countSoftDeletedItems = async (
  modelName: string,
  loggedInUser: User,
  context: Record<string, any>
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
  _context: Record<string, any>
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
      }))
    );
    return counts;
  } catch (error) {
    logger?.error(error);
    throw new Error("Failed to count soft-deleted items.");
  }
};

const generateTask = async (
  _source: Record<string, any>,
  { prompt }: { prompt: string },
  _context: Record<string, any>
): Promise<{ id: string; content: string; description: string }[]> => {
  const openai = new OpenAI({
    apiKey: EnvLoader.getOrThrow("OPENAI_API_KEY"),
  });

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are a helpful assistant. Your goal is to generate a task list based on any user input. Each task must be accompanied by a detailed description (max 300 characters). The output should follow this format: 'Task: <task name> | Description: <description>'. If the input is vague, generate general-purpose tasks with relevant descriptions.",
        },
        { role: "user", content: prompt },
      ],
      max_tokens: 1000,
    });

    const tasksRaw = completion.choices[0]?.message?.content || "";
    // Split the tasks by lines, parse task and description
    const tasks = tasksRaw
      .split("\n")
      .map((line) => {
        const match = line.match(/^Task:\s*(.+?)\s*\|\s*Description:\s*(.+)$/);
        return match
          ? {
              id: uuidv4(),
              content: match?.[1]?.trim() ?? "",
              description: match?.[2]?.trim() ?? "",
            }
          : null;
      })
      .filter(
        (task): task is { id: string; content: string; description: string } =>
          task !== null
      );

    return tasks.length > 0
      ? tasks
      : [
          {
            id: "1",
            content: "No tasks could be generated",
            description:
              "Please refine the prompt to generate meaningful tasks.",
          },
        ];
  } catch (error: any) {
    logger?.error(error);
    throw new Error("Failed to fetch response from OpenAI.");
  }
};

const getFirebaseStorage = async (
  _source: Record<string, any>,
  { orgId }: { orgId: string },
  _context: Record<string, any>
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
