import { GraphQLError } from "graphql";
import {
  CLONE_BACKLOGITEM,
  CLONE_FLOWNODE,
  CLONE_ROOT_FILES,
  CLONE_SUB_FILES,
  CLONE_SUB_FOLDERS,
  CLONE_SUB_ITEM,
  CONNECT_DEPENDENCY_CQL,
  CREATE_PROJECT_FROM_TEMPLATE,
  FINISH_SIGNUP_CQL,
  getUpdateDependentTaskDatesCQL,
  LINK_TO_FLOWNODE,
  REMOVE_REFID_EXISTING_NODE,
  UPDATE_INDEPENDENT_TASK_DATE_CQL,
} from "../../database/constants";
import logger from "../../logger";
import { OGMConnection } from "../init/ogm.init";
import { Neo4JConnection } from "./../../database/connection";
import { ApolloServerErrorCode } from "@apollo/server/errors";
import { Integer } from "neo4j-driver";
import { BacklogItem, UserRole } from "../../@types/ogm.types";
import { FirebaseFunctions } from "../firebase/firebaseFunctions";

const firebaseFunctions = FirebaseFunctions.getInstance();

const createBacklogItemWithUID = async (
  _source: Record<string, any>,
  { input }: Record<string, any>,
  _context: Record<string, any>
) => {
  const session = (await Neo4JConnection.getInstance()).driver.session();
  const BacklogItem = await (
    await OGMConnection.getInstance()
  ).model("BacklogItem");

  try {
    const tx = session.beginTransaction();

    const orgCounterResult = await tx.run(
      `
      MATCH (user:User {externalId: $externalId})-[:OWNS|:MEMBER_OF]->(org:Organization)-[:HAS_COUNTER]->(counter)
      SET counter.counter = counter.counter + 1
      RETURN org.id AS orgId, counter.counter AS newCounter
      `,
      { externalId: _context.jwt.sub }
    );

    if (orgCounterResult.records.length === 0) {
      await tx.rollback();
      throw new Error("Organization or counter not found for the user.");
    }

    const firstRecord = orgCounterResult.records[0];
    if (!firstRecord) {
      await tx.rollback();
      throw new Error("No record found for organization counter.");
    }
    const orgId = firstRecord.get("orgId");
    const newCounter = firstRecord.get("newCounter");

    // Create the new BacklogItem with UID
    const createdBacklogItem: any = await BacklogItem.create<BacklogItem>({
      input: { ...input, uid: newCounter, uniqueUid: `${newCounter}-${orgId}` },
      context: { executionContext: tx },
      rootValue: _source,
      selectionSet: `{
        backlogItems {
          id
          label
          uid
          projectedExpense
          actualExpense
          uniqueUid
          occuredOn
          paidOn
          startDate
          riskLevel{
          id
          name
          color
          }
          type {
            id
            name
          }
          status {
           id
           name
           color
          }
          assignedUser {
            id
            name
            email
            role
            phoneNumber
          }
          sprints{
            id
            name
          }
          createdBy{
            id
            name
            role
          }
        }
      }`,
    });

    // Commit the transaction
    await tx.commit();

    return createdBacklogItem;
  } catch (error) {
    logger?.error(error);
    throw error;
  } finally {
    await session.close();
  }
};

const createProjectWithTemplate = async (
  _source: Record<string, any>,
  {
    templateProjectId,
    name,
    description,
    startDate,
    orgId,
  }: {
    templateProjectId: string;
    name: string;
    description: string;
    startDate: string;
    orgId: string;
  },
  _context: Record<string, any>
) => {
  const session = (await Neo4JConnection.getInstance()).driver.session();
  const tx = session.beginTransaction();
  try {
    const params = {
      templateProjectId,
      name,
      description,
      userId: _context?.jwt?.sub,
      orgId,
    };

    const rootProject = await tx.run(CREATE_PROJECT_FROM_TEMPLATE, params);
    logger?.info(`Created Project using ${templateProjectId} in org:${orgId}`);
    const errorMessages = rootProject.records?.[0]?.get(
      "errorMessages"
    ) as Record<string, Integer | null>;

    if (errorMessages && Object.keys(errorMessages).length > 0) {
      const messages = Object.entries(errorMessages)
        .map(([msg, count]) => {
          const safeCount =
            count && typeof count === "object" && "low" in count
              ? count.low
              : 1;
          return `${msg} (${safeCount})`;
        })
        .join("; ");

      throw new GraphQLError("Project creation failed: " + messages, {
        extensions: {
          code: ApolloServerErrorCode.GRAPHQL_VALIDATION_FAILED,
        },
      });
    }

    await tx.run(CLONE_ROOT_FILES, params);
    await tx.run(CLONE_SUB_FOLDERS, params);
    logger?.info(`Cloned root files and sub folders`);

    await tx.run(CLONE_SUB_FILES, params);
    logger?.info(`Cloned sub files`);

    await tx.run(CLONE_FLOWNODE, params);
    await tx.run(LINK_TO_FLOWNODE, { templateProjectId });
    logger?.info(`Cloned flownodes and connected their links`);

    await tx.run(CLONE_BACKLOGITEM, params);
    await tx.run(CLONE_SUB_ITEM, params);
    logger?.info(`Cloned parent and sub backlogItem`);

    await tx.run(CONNECT_DEPENDENCY_CQL, { templateProjectId });

    const result = await tx.run(
      `MATCH (newProject:Project {refId:$rootId}) RETURN newProject`,
      { rootId: templateProjectId }
    );

    await tx.run(UPDATE_INDEPENDENT_TASK_DATE_CQL, {
      templateProjectId,
      userStartDate: startDate,
    });

    const query = getUpdateDependentTaskDatesCQL(templateProjectId);
    await tx.run(query);

    const project =
      result.records.map((record) => record.get("newProject").properties) || [];

    await tx.run(REMOVE_REFID_EXISTING_NODE);

    if (result?.records.length === 0) {
      await tx.commit();
      return [];
    }

    await tx.commit();
    return project;
  } catch (error) {
    await tx.rollback();
    logger?.error("Batch failure:", error);
    throw new GraphQLError(`${error}`, {
      extensions: {
        code: ApolloServerErrorCode.INTERNAL_SERVER_ERROR,
      },
    });
  } finally {
    await session.close();
  }
};

const finishInviteSignup = async (
  _source: Record<string, any>,
  { input, password }: Record<string, any>,
  _context: Record<string, any>
) => {
  const role = _context?.jwt?.role || UserRole.SuperUser;
  const orgId = _context?.jwt?.orgId;
  const session = (await Neo4JConnection.getInstance()).driver.session();

  const fullName = [input?.firstName, input?.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();
  const inviteUserPayLoad = {
    email: input?.email,
    password,
    name: fullName,
    ...(input.phoneNumber && { phoneNumber: `+${input?.phoneNumber}` }),
    role,
  };

  const tx = session.beginTransaction();
  try {
    logger.info("finishInviteSignup:start", { email: input?.email, orgId });

    // create firebase user
    logger.info("Creating Firebase user", { email: input?.email });
    const { user } = await firebaseFunctions.createInvitedUser(
      inviteUserPayLoad
    );
    logger.info("Firebase user created", {
      uid: user?.uid,
      email: user?.email,
    });

    // run signup cypher
    const params = {
      orgId,
      status: input?.status,
      resourceType: input?.resourceType,
      email: input?.email,
      externalId: user.uid,
      firstName: input?.firstName,
      role,
    };

    logger.info("Executing FINISH_SIGNUP_CQL", params);
    const response = await tx.run(FINISH_SIGNUP_CQL, params);
    await tx.commit();

    const result = response.records[0]?.get("workforce");
    if (!result) {
      logger.error("No workforce returned from Cypher", {
        email: input?.email,
      });
      return [];
    }

    const workForce = result.properties || result;
    logger.info("WorkForce created successfully", {
      id: workForce.id,
      email: workForce.email,
    });
    return [workForce];
  } catch (err) {
    logger.error("finishInviteSignup:error", {
      error: String(err),
      email: input?.email,
    });
    try {
      await tx.rollback();
    } catch (rollbackErr) {
      logger.error("Transaction rollback failed", {
        error: String(rollbackErr),
      });
    }
    throw new GraphQLError("FINISH_INVITE_SIGNUP_FAILED", {
      extensions: { code: "INTERNAL_SERVER_ERROR", detail: String(err) },
    });
  } finally {
    await session.close();
  }
};

export const createOperationMutations = {
  createBacklogItemWithUID,
  createProjectWithTemplate,
  finishInviteSignup,
};
