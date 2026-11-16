import Anthropic from "@anthropic-ai/sdk";
import { GraphQLError } from "graphql";
import { randomUUID } from "node:crypto";
import { Session, Transaction } from "neo4j-driver";
import { Neo4JConnection } from "../../database/connection";
import { CREATE_AI_BACKLOGITEM_CQL, CREATE_AI_FLOWNODE_CQL } from "../../database/constants";
import { NodeLayoutType } from "../../interfaces";
import logger from "../../logger";
import {
  buildExplanationPrompt,
  DraftExplanation,
  EXPLANATION_SYSTEM_PROMPT,
  GroupForAi,
  parseExplanationResponse,
} from "../../robots/explanations";
import { buildImportPayload, isAllowedMeshUrl } from "../../robots/importPayload";
import {
  CAN_EDIT_PROJECT_CQL,
  CREATE_BUILD_FLOW_FILE_CQL,
  CREATE_ROBOT_CQL,
  GROUP_ACCESS_CQL,
  LINK_TASK_DEPENDENCIES_CQL,
  LOAD_COMPONENT_SPECS_CQL,
  LOAD_GROUPS_FOR_AI_CQL,
  ORG_ADMIN_CQL,
  ORG_MOTOR_DEMAND_CQL,
  ORG_STOCK_CQL,
  ROBOT_ACCESS_CQL,
  ROBOT_UNKNOWN_MOTORS_CQL,
  SOFT_DELETE_ROBOT_CQL,
  UPDATE_EXPLANATION_CQL,
  UPSERT_COMPONENT_SPEC_CQL,
  WRITE_EXPLANATIONS_CQL,
} from "../../robots/robot.cypher";
import { motorModelsFromConfig, planRobot } from "../../robots/robotPlan";
import { computeSupply, DemandRow, modelKey, StockRow } from "../../robots/supply";
import { parseUrdf, UrdfError } from "../../robots/urdf";
import convertToFlowchartRenderData from "../../util/convertFlowNodeRenderData";
import { EnvLoader } from "../../util/EnvLoader";
import withTimeout from "../../util/timeOutFuc";

type Ctx = { jwt?: { sub?: string; roles?: string[] } };

const MAX_MESHES = 600;
const AI_BATCH = 12;

let anthropicClient: Anthropic | undefined;
const getAnthropic = (): Anthropic => {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: EnvLoader.getOrThrow("ANTHROPIC_API_KEY") });
  }
  return anthropicClient;
};

/** Neo4j integers come back as Integer objects. */
const toNum = (v: unknown, fallback: number): number => {
  if (typeof v === "number") return v;
  const n = (v as { toNumber?: () => number } | null)?.toNumber?.();
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
};

const fail = (message: string, code: string): never => {
  throw new GraphQLError(message, { extensions: { code } });
};

const auth = (ctx: Ctx) => {
  const sub = ctx?.jwt?.sub;
  if (!sub) fail("UNAUTHORIZED", "UNAUTHORIZED");
  return {
    sub: sub as string,
    isSystemAdmin: Array.isArray(ctx.jwt?.roles) && ctx.jwt!.roles!.includes("SYSTEM_ADMIN"),
  };
};

const openSession = async (): Promise<Session> =>
  (await Neo4JConnection.getInstance()).driver.session();

const extraMeshHosts = (): string[] =>
  (EnvLoader.get("ROBOT_MESH_URL_HOSTS") ?? "")
    .split(",")
    .map((h: string) => h.trim())
    .filter(Boolean);

const robotAccess = async (session: Session, sub: string, isSystemAdmin: boolean, robotId: string, edit: boolean) => {
  const res = await session.run(ROBOT_ACCESS_CQL, { sub, isSystemAdmin, robotId, edit });
  const row = res.records[0];
  if (!row) fail("Robot not found or you do not have access.", "FORBIDDEN");
  return {
    robotId: row!.get("robotId") as string,
    robotName: row!.get("robotName") as string,
    projectId: row!.get("projectId") as string,
    orgId: row!.get("orgId") as string,
  };
};

// ---------------------------------------------------------------------------
// importRobotFromUrdf
// ---------------------------------------------------------------------------

type ImportInput = {
  projectId: string;
  name: string;
  urdf: string;
  meshes: { fileName: string; url: string }[];
  motorConfigJson?: string | null;
  license?: string | null;
  attribution?: string | null;
  sourceUrl?: string | null;
  createTasks?: boolean | null;
};

const importRobotFromUrdf = async (_src: unknown, { input }: { input: ImportInput }, ctx: Ctx) => {
  const { sub, isSystemAdmin } = auth(ctx);

  const name = (input.name ?? "").trim().slice(0, 120);
  if (!name) fail("Robot name is required.", "BAD_USER_INPUT");
  if (!Array.isArray(input.meshes) || input.meshes.length > MAX_MESHES) {
    fail(`Upload at most ${MAX_MESHES} mesh files.`, "BAD_USER_INPUT");
  }
  const hosts = extraMeshHosts();
  for (const m of input.meshes) {
    if (!m.fileName || !isAllowedMeshUrl(m.url, hosts)) {
      fail(`Mesh "${m.fileName}" must be uploaded to the app's storage first.`, "BAD_USER_INPUT");
    }
  }
  if (input.sourceUrl && !/^https?:\/\//i.test(input.sourceUrl)) {
    fail("Source URL must start with http(s)://", "BAD_USER_INPUT");
  }

  // Parse and plan before touching the database.
  let motorModels: Record<string, string> = {};
  if (input.motorConfigJson) {
    try {
      motorModels = motorModelsFromConfig(JSON.parse(input.motorConfigJson));
    } catch {
      fail("The motor config is not valid JSON.", "BAD_USER_INPUT");
    }
  }
  let plan;
  try {
    plan = planRobot(parseUrdf(input.urdf), { motorModels });
  } catch (e) {
    if (e instanceof UrdfError) fail(e.message, "BAD_USER_INPUT");
    throw e;
  }
  const payload = buildImportPayload(plan!, input.meshes, { createTasks: input.createTasks !== false });

  const fileId = randomUUID();
  const robotId = randomUUID();
  const layout = convertToFlowchartRenderData({
    nodes: payload.flowNodes,
    edges: payload.flowEdges,
    fileId,
    layoutDirection: NodeLayoutType.Vertical,
  });
  const dbIdBySeed = new Map(payload.flowNodes.map((n) => [n.id, randomUUID()]));
  const nodes = layout.nodes.map((n) => ({ ...n, dbId: dbIdBySeed.get(n.id)!, aiNodeId: n.id }));
  const nodeIdByGroupKey = new Map(payload.groups.map((g) => [g.key, dbIdBySeed.get(g.flowSeedId)!]));
  const backlogItems = payload.tasks.map((t) => ({
    id: t.id,
    nodeId: nodeIdByGroupKey.get(t.groupKey)!,
    label: t.label,
    description: t.description,
  }));

  let session: Session | undefined;
  let tx: Transaction | undefined;
  try {
    session = await openSession();
    const allowed = await session.run(CAN_EDIT_PROJECT_CQL, { sub, isSystemAdmin, projectId: input.projectId });
    if (!allowed.records.length) {
      fail("Only organization owners and admins can add robots to this project.", "FORBIDDEN");
    }

    tx = session.beginTransaction();
    const jwt = { sub };
    await tx.run(CREATE_BUILD_FLOW_FILE_CQL, {
      sub,
      projectId: input.projectId,
      fileId,
      name: `${name} – build flow`.slice(0, 120),
    });
    await tx.run(CREATE_AI_FLOWNODE_CQL, { nodes, edges: layout.edges, jwt });
    if (backlogItems.length) {
      await tx.run(CREATE_AI_BACKLOGITEM_CQL, {
        fileId,
        backlogItems,
        createdNodeIds: nodes.map((n) => n.dbId),
        jwt,
      });
      if (payload.taskLinks.length) {
        await tx.run(LINK_TASK_DEPENDENCIES_CQL, { links: payload.taskLinks });
      }
    }
    await tx.run(CREATE_ROBOT_CQL, {
      sub,
      projectId: input.projectId,
      fileId,
      robotId,
      name,
      license: input.license?.slice(0, 120) ?? null,
      attribution: input.attribution?.slice(0, 500) ?? null,
      sourceUrl: input.sourceUrl?.slice(0, 500) ?? null,
      approxSize: plan!.approxSize,
      groups: payload.groups.map(({ flowSeedId, ...g }) => ({ ...g, flowNodeId: dbIdBySeed.get(flowSeedId)! })),
      parts: payload.parts,
    });
    await tx.commit();
    tx = undefined;

    return {
      robotId,
      buildFlowFileId: fileId,
      groupCount: payload.groups.length,
      partCount: payload.parts.length,
      taskCount: backlogItems.length,
      missingMeshes: payload.missingMeshes,
    };
  } catch (error) {
    if (tx) await tx.rollback();
    if (!(error instanceof GraphQLError)) logger?.error?.("importRobotFromUrdf failed", error);
    throw error;
  } finally {
    if (session) await session.close();
  }
};

// ---------------------------------------------------------------------------
// generatePartExplanations
// ---------------------------------------------------------------------------

const generatePartExplanations = async (
  _src: unknown,
  { robotId, groupIds, overwriteConfirmed }: { robotId: string; groupIds?: string[] | null; overwriteConfirmed?: boolean | null },
  ctx: Ctx,
) => {
  const { sub, isSystemAdmin } = auth(ctx);
  let session: Session | undefined;
  try {
    session = await openSession();
    const robot = await robotAccess(session, sub, isSystemAdmin, robotId, true);
    const res = await session.run(LOAD_GROUPS_FOR_AI_CQL, { robotId, groupIds: groupIds ?? [] });
    const groups: GroupForAi[] = res.records
      .filter((r) => overwriteConfirmed || r.get("explanationStatus") !== "CONFIRMED")
      .map((r) => ({
        id: r.get("id"),
        key: r.get("key"),
        name: r.get("name"),
        qty: toNum(r.get("qty"), 1),
        category: r.get("category"),
        motors: r.get("motors") ?? [],
        links: r.get("links") ?? [],
        comments: r.get("comments") ?? [],
      }));
    if (!groups.length) return 0;

    const models = [...new Set(groups.flatMap((g) => g.motors.map((m) => m.split("|")[1] ?? "").filter(Boolean)))];
    const specRes = await session.run(LOAD_COMPONENT_SPECS_CQL, { orgId: robot.orgId, models });
    const specs = specRes.records.map((r) => ({
      model: r.get("model"),
      kind: r.get("kind"),
      specsJson: r.get("specsJson"),
      sources: r.get("sources") ?? [],
    }));
    // Release the connection during the slow AI calls.
    await session.close();
    session = undefined;

    const model = EnvLoader.get("ROBOT_AI_MODEL") || "claude-haiku-4-5";
    const drafts: DraftExplanation[] = [];
    for (let i = 0; i < groups.length; i += AI_BATCH) {
      const batch = groups.slice(i, i + AI_BATCH);
      const batchModels = new Set(batch.flatMap((g) => g.motors.map((m) => m.split("|")[1] ?? "")));
      let completion: Anthropic.Message;
      try {
        completion = await withTimeout(
          getAnthropic().messages.create({
            model,
            max_tokens: 4000,
            temperature: 0,
            system: EXPLANATION_SYSTEM_PROMPT,
            messages: [
              {
                role: "user",
                content: buildExplanationPrompt(robot.robotName, batch, specs.filter((s) => batchModels.has(s.model))),
              },
            ],
          }),
          45000,
        );
      } catch (error: any) {
        const message = error?.error?.message || error?.message || "AI service failed";
        const billing = /credit balance is too low|billing/i.test(message);
        fail(billing ? "Anthropic API credits are exhausted." : message, billing ? "PAYMENT_REQUIRED" : "INTERNAL_SERVER_ERROR");
      }
      if (completion!.stop_reason === "max_tokens") {
        fail("AI response was incomplete. Please try again.", "AI_RESPONSE_TRUNCATED");
      }
      const text = completion!.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text ?? "";
      try {
        drafts.push(...parseExplanationResponse(text, batch));
      } catch {
        fail("The AI returned an invalid response. Please try again.", "INVALID_AI_JSON");
      }
    }
    if (!drafts.length) return 0;

    session = await openSession();
    const written = await session.executeWrite((tx) =>
      tx.run(WRITE_EXPLANATIONS_CQL, { items: drafts, overwriteConfirmed: !!overwriteConfirmed }),
    );
    return Number(written.records[0]?.get("written") ?? 0);
  } finally {
    if (session) await session.close();
  }
};

// ---------------------------------------------------------------------------
// updatePartExplanation, deleteRobot, upsertComponentSpec
// ---------------------------------------------------------------------------

type UpdateExplanationInput = {
  groupId: string;
  what?: string | null;
  why?: string | null;
  madeOf?: string[] | null;
  confirm?: boolean | null;
};

const updatePartExplanation = async (_src: unknown, { input }: { input: UpdateExplanationInput }, ctx: Ctx) => {
  const { sub, isSystemAdmin } = auth(ctx);
  const what = input.what == null ? null : input.what.trim().slice(0, 600);
  const why = input.why == null ? null : input.why.trim().slice(0, 800);
  const madeOf = input.madeOf == null ? null : input.madeOf.map((m) => m.trim().slice(0, 80)).filter(Boolean).slice(0, 12);
  const edited = what !== null || why !== null || madeOf !== null;
  const confirm = !!input.confirm;
  if (!edited && !confirm) fail("Nothing to update.", "BAD_USER_INPUT");

  const session = await openSession();
  try {
    const access = await session.run(GROUP_ACCESS_CQL, { sub, isSystemAdmin, groupId: input.groupId });
    if (!access.records.length) fail("Part not found or you do not have access.", "FORBIDDEN");
    const res = await session.executeWrite((tx) =>
      tx.run(UPDATE_EXPLANATION_CQL, { sub, groupId: input.groupId, what, why, madeOf, edited, confirm }),
    );
    return res.records[0]?.get("id");
  } finally {
    await session.close();
  }
};

const deleteRobot = async (_src: unknown, { robotId }: { robotId: string }, ctx: Ctx) => {
  const { sub, isSystemAdmin } = auth(ctx);
  const session = await openSession();
  try {
    await robotAccess(session, sub, isSystemAdmin, robotId, true);
    await session.executeWrite((tx) => tx.run(SOFT_DELETE_ROBOT_CQL, { robotId }));
    return true;
  } finally {
    await session.close();
  }
};

type ComponentSpecInput = { model: string; kind: string; specsJson: string; sources: string[] };

const upsertComponentSpec = async (_src: unknown, { input }: { input: ComponentSpecInput }, ctx: Ctx) => {
  const { sub } = auth(ctx);
  const model = (input.model ?? "").trim().slice(0, 60);
  const kind = (input.kind ?? "").trim().slice(0, 40);
  if (!model || !kind) fail("Model and kind are required.", "BAD_USER_INPUT");
  let specs: unknown;
  try {
    specs = JSON.parse(input.specsJson);
  } catch {
    fail("specsJson must be valid JSON.", "BAD_USER_INPUT");
  }
  if (!specs || typeof specs !== "object" || Array.isArray(specs)) {
    fail("specsJson must be a JSON object.", "BAD_USER_INPUT");
  }
  if (input.specsJson.length > 20000) fail("specsJson is too large.", "BAD_USER_INPUT");
  const sources = (input.sources ?? []).map((s) => s.trim()).filter(Boolean);
  if (!sources.length || sources.some((s) => !/^https?:\/\//i.test(s))) {
    fail("Give at least one source URL for the specs.", "BAD_USER_INPUT");
  }

  const session = await openSession();
  try {
    const org = await session.run(ORG_ADMIN_CQL, { sub });
    const orgId = org.records[0]?.get("orgId");
    if (!orgId) fail("Only organization owners and admins can edit components.", "FORBIDDEN");
    const res = await session.executeWrite((tx) =>
      tx.run(UPSERT_COMPONENT_SPEC_CQL, { orgId, model, kind, specsJson: JSON.stringify(specs), sources: sources.slice(0, 10) }),
    );
    return res.records[0]?.get("id");
  } finally {
    await session.close();
  }
};

export const robotMutations = {
  importRobotFromUrdf,
  generatePartExplanations,
  updatePartExplanation,
  deleteRobot,
  upsertComponentSpec,
};

// ---------------------------------------------------------------------------
// robotSupplyStatus
// ---------------------------------------------------------------------------

const robotSupplyStatus = async (_src: unknown, { robotId }: { robotId: string }, ctx: Ctx) => {
  const { sub, isSystemAdmin } = auth(ctx);
  const session = await openSession();
  try {
    const robot = await robotAccess(session, sub, isSystemAdmin, robotId, false);
    const demandRes = await session.run(ORG_MOTOR_DEMAND_CQL, { sub, isSystemAdmin, orgId: robot.orgId });
    const demand: DemandRow[] = demandRes.records.map((r) => ({
      robotId: r.get("robotId"),
      robotName: r.get("robotName"),
      projectId: r.get("projectId"),
      projectName: r.get("projectName") ?? "",
      readable: !!r.get("readable"),
      groupId: r.get("groupId"),
      model: r.get("model"),
      n: toNum(r.get("n"), 0),
    }));
    const modelKeys = [...new Set(demand.filter((d) => d.robotId === robotId).map((d) => modelKey(d.model)))];
    const stockRes = modelKeys.length ? await session.run(ORG_STOCK_CQL, { orgId: robot.orgId, modelKeys }) : null;
    const stock: StockRow[] = (stockRes?.records ?? []).map((r) => ({
      assetId: r.get("assetId"),
      model: r.get("model"),
      projectIds: r.get("projectIds") ?? [],
    }));
    const unknownRes = await session.run(ROBOT_UNKNOWN_MOTORS_CQL, { robotId });
    const unknown = toNum(unknownRes.records[0]?.get("unknown"), 0);
    return computeSupply(robotId, robot.projectId, demand, stock, unknown);
  } finally {
    await session.close();
  }
};

export const robotQueries = { robotSupplyStatus };

