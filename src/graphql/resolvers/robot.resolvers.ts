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
import { buildImportPayload, ImportPayload, isAllowedMeshUrl } from "../../robots/importPayload";
import { applyBom, BomRow, parseBomCsv, parsedFromBom, parsedFromModelParts, SYNTHETIC_ROOT } from "../../robots/parts";
import {
  ABSORB_FLOW_NODES_CQL,
  CAN_EDIT_PROJECT_CQL,
  CREATE_GROUP_WITH_NODE_CQL,
  DELETE_GROUPS_CQL,
  LINK_GROUP_NODE_CQL,
  LOAD_GROUPS_FOR_EDIT_CQL,
  MOVE_PARTS_CQL,
  RECOMPUTE_GROUPS_CQL,
  RENAME_GROUP_CQL,
  ROBOT_GROUP_PARTS_CQL,
  ROBOT_OF_GROUP_CQL,
  SET_GROUP_FIELDS_CQL,
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
import { motorModelsFromConfig, planRobot, RobotPlan } from "../../robots/robotPlan";
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
// Importing robots
// ---------------------------------------------------------------------------

type CommonImport = {
  projectId: string;
  name: string;
  license?: string | null;
  attribution?: string | null;
  sourceUrl?: string | null;
  createTasks?: boolean | null;
};

const checkCommon = (input: CommonImport) => {
  const name = (input.name ?? "").trim().slice(0, 120);
  if (!name) fail("Robot name is required.", "BAD_USER_INPUT");
  if (input.sourceUrl && !/^https?:\/\//i.test(input.sourceUrl)) {
    fail("Source URL must start with http(s)://", "BAD_USER_INPUT");
  }
  return name;
};

const parseBom = (csv: string | null | undefined): BomRow[] => {
  try {
    return parseBomCsv(csv ?? "");
  } catch (e) {
    if (e instanceof UrdfError) fail(e.message, "BAD_USER_INPUT");
    throw e;
  }
};

const planOrFail = <T>(fn: () => T): T => {
  try {
    return fn();
  } catch (e) {
    if (e instanceof UrdfError) fail(e.message, "BAD_USER_INPUT");
    throw e;
  }
};

/** Shared write path: build-flow file, flow nodes, tasks, robot, groups and parts in one transaction. */
const writeImport = async (
  ctx: Ctx,
  input: CommonImport,
  name: string,
  plan: RobotPlan,
  payload: ImportPayload,
  unmatchedBomRows: string[],
) => {
  const { sub, isSystemAdmin } = auth(ctx);
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
      approxSize: plan.approxSize,
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
      unmatchedBomRows,
    };
  } catch (error) {
    if (tx) await tx.rollback();
    if (!(error instanceof GraphQLError)) logger?.error?.("robot import failed", error);
    throw error;
  } finally {
    if (session) await session.close();
  }
};

type ImportInput = CommonImport & {
  urdf: string;
  meshes: { fileName: string; url: string }[];
  motorConfigJson?: string | null;
  bomCsv?: string | null;
};

const importRobotFromUrdf = async (_src: unknown, { input }: { input: ImportInput }, ctx: Ctx) => {
  auth(ctx);
  const name = checkCommon(input);
  if (!Array.isArray(input.meshes) || input.meshes.length > MAX_MESHES) {
    fail(`Upload at most ${MAX_MESHES} mesh files.`, "BAD_USER_INPUT");
  }
  const hosts = extraMeshHosts();
  for (const m of input.meshes) {
    if (!m.fileName || !isAllowedMeshUrl(m.url, hosts)) {
      fail(`Mesh "${m.fileName}" must be uploaded to the app's storage first.`, "BAD_USER_INPUT");
    }
  }

  let motorModels: Record<string, string> = {};
  if (input.motorConfigJson) {
    try {
      motorModels = motorModelsFromConfig(JSON.parse(input.motorConfigJson));
    } catch {
      fail("The motor config is not valid JSON.", "BAD_USER_INPUT");
    }
  }
  const bom = parseBom(input.bomCsv);
  const urdf = planOrFail(() => parseUrdf(input.urdf));
  const fromBom = applyBom(urdf, bom);
  const plan = planOrFail(() =>
    planRobot(urdf, { motorModels: { ...motorModels, ...fromBom.motorModels }, partMotors: fromBom.partMotors }),
  );
  const payload = buildImportPayload(plan, input.meshes, { createTasks: input.createTasks !== false });
  return writeImport(ctx, input, name, plan, payload, fromBom.unmatched);
};

type ImportModelInput = CommonImport & {
  format: "GLB" | "BOM";
  modelUrl?: string | null;
  parts?: { name: string; parent?: string | null; matrix: number[] }[] | null;
  bomCsv?: string | null;
};

const importRobotFromModel = async (_src: unknown, { input }: { input: ImportModelInput }, ctx: Ctx) => {
  auth(ctx);
  const name = checkCommon(input);
  const bom = parseBom(input.bomCsv);
  let urdf;
  let model: { format: "GLB"; url: string } | { format: "NONE" };
  if (input.format === "GLB") {
    if (!input.modelUrl || !isAllowedMeshUrl(input.modelUrl, extraMeshHosts())) {
      fail("Upload the model file to the app's storage first.", "BAD_USER_INPUT");
    }
    urdf = planOrFail(() => parsedFromModelParts(name, input.parts ?? []));
    model = { format: "GLB", url: input.modelUrl! };
  } else {
    if (!bom.length) fail("The bill of materials has no rows with a motor/model.", "BAD_USER_INPUT");
    urdf = planOrFail(() => parsedFromBom(name, bom));
    model = { format: "NONE" };
  }
  const fromBom = applyBom(urdf, bom);
  const plan = planOrFail(() =>
    planRobot(urdf, { partMotors: fromBom.partMotors, skipLinks: [SYNTHETIC_ROOT] }),
  );
  if (!plan.groups.length) fail("No parts found in the model.", "BAD_USER_INPUT");
  const payload = buildImportPayload(plan, [], { createTasks: input.createTasks !== false, model });
  return writeImport(ctx, input, name, plan, payload, fromBom.unmatched);
};

// ---------------------------------------------------------------------------
// Editing part groups
// ---------------------------------------------------------------------------

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "group";

const editAccess = async (session: Session, ctx: Ctx, robotId: string) => {
  const { sub, isSystemAdmin } = auth(ctx);
  await robotAccess(session, sub, isSystemAdmin, robotId, true);
  return sub;
};

const renamePartGroup = async (
  _src: unknown,
  { groupId, name, category }: { groupId: string; name: string; category?: string | null },
  ctx: Ctx,
) => {
  const clean = (name ?? "").trim().slice(0, 80);
  if (!clean) fail("Name is required.", "BAD_USER_INPUT");
  const session = await openSession();
  try {
    const r = await session.run(ROBOT_OF_GROUP_CQL, { groupId });
    const robotId = r.records[0]?.get("robotId");
    if (!robotId) fail("Part group not found.", "NOT_FOUND");
    await editAccess(session, ctx, robotId);
    const res = await session.executeWrite((tx) =>
      tx.run(RENAME_GROUP_CQL, { robotId, groupId, name: clean, category: category?.trim().slice(0, 40) || null }),
    );
    return res.records[0]?.get("id");
  } finally {
    await session.close();
  }
};

const mergePartGroups = async (
  _src: unknown,
  { robotId, groupIds, name }: { robotId: string; groupIds: string[]; name?: string | null },
  ctx: Ctx,
) => {
  const ids = [...new Set(groupIds ?? [])];
  if (ids.length < 2) fail("Pick at least two part groups to merge.", "BAD_USER_INPUT");
  const session = await openSession();
  try {
    await editAccess(session, ctx, robotId);
    const loaded = await session.run(LOAD_GROUPS_FOR_EDIT_CQL, { robotId, groupIds: ids });
    if (loaded.records.length !== ids.length) fail("Some part groups do not belong to this robot.", "BAD_USER_INPUT");
    const rows = loaded.records.map((r) => ({
      id: r.get("id") as string,
      order: toNum(r.get("order"), 0),
      nodeId: r.get("nodeId") as string | null,
    }));
    const targetId = ids[0]!;
    const others = rows.filter((r) => r.id !== targetId);
    const target = rows.find((r) => r.id === targetId)!;
    const targetNodeId = target.nodeId ?? others.find((o) => o.nodeId)?.nodeId ?? null;
    const otherNodeIds = others.map((o) => o.nodeId).filter((n): n is string => !!n && n !== targetNodeId);
    const partIds = loaded.records.filter((r) => r.get("id") !== targetId).flatMap((r) => r.get("partIds") as string[]);
    const newName = name?.trim().slice(0, 80) || null;
    const order = Math.min(...rows.map((r) => r.order));

    await session.executeWrite(async (tx) => {
      if (partIds.length) await tx.run(MOVE_PARTS_CQL, { robotId, targetId, partIds });
      if (targetNodeId && !target.nodeId) await tx.run(LINK_GROUP_NODE_CQL, { groupId: targetId, nodeId: targetNodeId });
      if (targetNodeId && otherNodeIds.length) await tx.run(ABSORB_FLOW_NODES_CQL, { targetNodeId, nodeIds: otherNodeIds });
      await tx.run(DELETE_GROUPS_CQL, { robotId, groupIds: others.map((o) => o.id) });
      await tx.run(SET_GROUP_FIELDS_CQL, { robotId, groupId: targetId, name: newName, order });
      await tx.run(RECOMPUTE_GROUPS_CQL, { groupIds: [targetId] });
    });
    return targetId;
  } finally {
    await session.close();
  }
};

const movePartsToGroup = async (
  _src: unknown,
  {
    robotId,
    partIds,
    targetGroupId,
    newGroupName,
  }: { robotId: string; partIds: string[]; targetGroupId?: string | null; newGroupName?: string | null },
  ctx: Ctx,
) => {
  const ids = [...new Set(partIds ?? [])];
  if (!ids.length) fail("Pick at least one part to move.", "BAD_USER_INPUT");
  const newName = newGroupName?.trim().slice(0, 80) || null;
  if (!targetGroupId && !newName) fail("Choose a group or give the new group a name.", "BAD_USER_INPUT");
  const session = await openSession();
  try {
    const sub = await editAccess(session, ctx, robotId);
    // Which groups currently hold these parts, and would any be left empty?
    const all = await session.run(ROBOT_GROUP_PARTS_CQL, { robotId });
    const groups = all.records.map((r) => ({ id: r.get("id") as string, partIds: r.get("partIds") as string[] }));
    const sources = groups.filter((g) => g.partIds.some((p) => ids.includes(p)));
    const found = new Set(sources.flatMap((g) => g.partIds.filter((p) => ids.includes(p))));
    if (found.size !== ids.length) fail("Some parts do not belong to this robot.", "BAD_USER_INPUT");
    if (targetGroupId && !groups.some((g) => g.id === targetGroupId)) {
      fail("The target group does not belong to this robot.", "BAD_USER_INPUT");
    }
    const emptied = sources.filter((g) => g.id !== targetGroupId && g.partIds.every((p) => ids.includes(p)));
    if (emptied.length) {
      fail("That would leave a part group empty. Use Merge to combine whole groups.", "BAD_USER_INPUT");
    }

    let targetId = targetGroupId ?? "";
    await session.executeWrite(async (tx) => {
      if (!targetGroupId) {
        targetId = randomUUID();
        await tx.run(CREATE_GROUP_WITH_NODE_CQL, {
          sub,
          robotId,
          sourceGroupId: sources[0]!.id,
          groupId: targetId,
          nodeId: randomUUID(),
          name: newName,
          key: slug(newName!),
        });
      }
      await tx.run(MOVE_PARTS_CQL, { robotId, targetId, partIds: ids });
      await tx.run(RECOMPUTE_GROUPS_CQL, { groupIds: [targetId, ...sources.map((g) => g.id)] });
    });
    return targetId;
  } finally {
    await session.close();
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
  importRobotFromModel,
  renamePartGroup,
  mergePartGroups,
  movePartsToGroup,
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

