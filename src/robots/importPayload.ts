import { randomUUID } from "node:crypto";
import { RobotPlan } from "./robotPlan";

/**
 * Pure step between the robot plan and the database writes: decides the flow
 * nodes, edges, tasks and task dependencies for the build flow, and the rows
 * for the robot's groups and parts.
 */

export interface MeshUpload {
  fileName: string;
  url: string;
}

export interface FlowNodeSeed {
  id: string; // the layout helper's temporary id
  label: string;
  kind: "process";
  shape: "rectangle";
  description: string;
}

export interface TaskSeed {
  id: string;
  groupKey: string;
  step: "procure" | "make" | "assemble" | "test";
  label: string;
  description: string;
}

export interface ImportPayload {
  flowNodes: FlowNodeSeed[];
  flowEdges: { id: string; source: string; target: string; label: string }[];
  tasks: TaskSeed[];
  taskLinks: { before: string; after: string }[];
  groups: {
    id: string;
    key: string;
    name: string;
    qty: number;
    category: string;
    order: number;
    motors: string[];
    flowSeedId: string;
  }[];
  parts: {
    id: string;
    groupId: string;
    linkName: string;
    side: "LEFT" | "RIGHT" | "CENTER";
    meshUrl: string | null;
    meshFile: string | null;
    /** STL = one file per part; GLB = one model file, part = node named meshNode. */
    meshFormat: "STL" | "GLB" | null;
    meshNode: string | null;
    motors: string[];
    matrix: number[];
    scale: number[];
    color: string | null;
    explode: number[];
    depth: number;
  }[];
  missingMeshes: string[];
}

const motorSummary = (models: (string | null)[]): string => {
  const counts = new Map<string, number>();
  for (const m of models) counts.set(m ?? "unknown motor", (counts.get(m ?? "unknown motor") ?? 0) + 1);
  return [...counts.entries()].map(([m, n]) => `${n} × ${m}`).join(", ");
};

export const buildImportPayload = (
  plan: RobotPlan,
  meshes: MeshUpload[],
  opts: {
    createTasks: boolean;
    newId?: () => string;
    /** Default STL (URDF + per-part files). GLB: every part is a node of one model file. NONE: no 3D. */
    model?: { format: "STL" } | { format: "GLB"; url: string } | { format: "NONE" };
  } = { createTasks: true },
): ImportPayload => {
  const model = opts.model ?? { format: "STL" as const };
  const newId = opts.newId ?? randomUUID;
  const meshByName = new Map(meshes.map((m) => [m.fileName.toLowerCase(), m.url]));

  const groups = plan.groups.map((g) => ({
    id: newId(),
    key: g.key,
    name: g.name,
    qty: g.qty,
    category: g.category,
    order: g.order,
    motors: g.joints.map((j) => `${j.name}|${j.motorModel ?? ""}`),
    flowSeedId: `g${g.order + 1}`,
  }));
  const groupByKey = new Map(groups.map((g) => [g.key, g]));

  const flowNodes: FlowNodeSeed[] = plan.groups.map((g) => {
    const qty = g.qty > 1 ? ` ×${g.qty}` : "";
    const motors = g.joints.length
      ? `Motors: ${motorSummary(g.joints.map((j) => j.motorModel))}.`
      : "No motors.";
    return {
      id: `g${g.order + 1}`,
      label: `${g.order + 1}. ${g.name}${qty}`.slice(0, 80),
      kind: "process",
      shape: "rectangle",
      description: `${g.category}. ${motors}`.slice(0, 300),
    };
  });

  const flowEdges = plan.dependencies.map(([a, b], i) => ({
    id: `e-${i + 1}`,
    source: groupByKey.get(a)!.flowSeedId,
    target: groupByKey.get(b)!.flowSeedId,
    label: "",
  }));

  const tasks: TaskSeed[] = [];
  const taskLinks: { before: string; after: string }[] = [];
  const assembleTask = new Map<string, string>();

  if (opts.createTasks) {
    for (const g of plan.groups) {
      const qty = g.qty > 1 ? ` (×${g.qty})` : "";
      const hasMotors = g.joints.length > 0;
      const steps: [TaskSeed["step"], string, string][] = [];
      if (hasMotors) {
        steps.push([
          "procure",
          `Procure motors for ${g.name}${qty}`,
          `Order ${motorSummary(g.joints.map((j) => j.motorModel))} for the ${g.name.toLowerCase()}.`,
        ]);
      }
      steps.push([
        "make",
        `Make ${g.name} parts${qty}`,
        `Print or machine the ${g.name.toLowerCase()} parts from the robot's model files.`,
      ]);
      steps.push([
        "assemble",
        `Assemble ${g.name}${qty}`,
        `Fit the ${g.name.toLowerCase()} parts${hasMotors ? " and motors" : ""} and attach to the parent assembly.`,
      ]);
      if (hasMotors) {
        steps.push([
          "test",
          `Test ${g.name} joints`,
          `Check range of motion and motor IDs for: ${g.joints.map((j) => j.name).join(", ")}.`.slice(0, 500),
        ]);
      }
      let prev: string | null = null;
      for (const [step, label, description] of steps) {
        const id = newId();
        tasks.push({ id, groupKey: g.key, step, label: label.slice(0, 120), description });
        if (prev) taskLinks.push({ before: prev, after: id });
        if (step === "assemble") assembleTask.set(g.key, id);
        prev = id;
      }
    }
    for (const [a, b] of plan.dependencies) {
      const before = assembleTask.get(a);
      const after = assembleTask.get(b);
      if (before && after) taskLinks.push({ before, after });
    }
  }

  const missing = new Set<string>();
  const parts = plan.parts.map((p) => {
    let url: string | null = null;
    let meshFormat: "STL" | "GLB" | null = null;
    let meshNode: string | null = null;
    if (model.format === "STL" && p.meshFile) {
      url = meshByName.get(p.meshFile.toLowerCase()) ?? null;
      if (url) meshFormat = "STL";
      else missing.add(p.meshFile);
    } else if (model.format === "GLB" && p.meshFile) {
      url = model.url;
      meshFormat = "GLB";
      meshNode = p.meshFile;
    }
    return {
      id: newId(),
      groupId: groupByKey.get(p.groupKey)!.id,
      linkName: p.linkName,
      side: p.side.toUpperCase() as "LEFT" | "RIGHT" | "CENTER",
      meshUrl: url,
      meshFile: model.format === "NONE" ? null : p.meshFile,
      meshFormat,
      meshNode,
      motors: [...p.motors],
      matrix: p.matrix,
      scale: [...p.scale],
      color: p.color,
      explode: [...p.explode],
      depth: p.depth,
    };
  });

  return {
    flowNodes,
    flowEdges,
    tasks,
    taskLinks,
    groups,
    parts,
    missingMeshes: [...missing].sort(),
  };
};

const DEFAULT_MESH_HOSTS = ["firebasestorage.googleapis.com", "storage.googleapis.com"];

/** Only meshes stored in the app's own storage may be referenced. */
export const isAllowedMeshUrl = (url: string, extraHosts: string[] = []): boolean => {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && [...DEFAULT_MESH_HOSTS, ...extraHosts].includes(u.hostname);
  } catch {
    return false;
  }
};
