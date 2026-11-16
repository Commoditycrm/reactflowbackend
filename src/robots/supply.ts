/**
 * Supply status for a robot: how many of each motor model it needs, how many
 * the organisation has in stock (Assets with that model number), and whether
 * other robots in the organisation compete for the same stock.
 *
 * Pure so it can be unit-tested; robot.resolvers.ts feeds it database rows.
 */

/** One row per (robot, part group, model): n motors of that model. */
export interface DemandRow {
  robotId: string;
  robotName: string;
  projectId: string;
  projectName: string;
  /** False when the asking user cannot see that project. */
  readable: boolean;
  groupId: string;
  model: string;
  n: number;
}

/** One row per physical unit (Asset) of a model. */
export interface StockRow {
  model: string;
  assetId: string;
  /** Projects the asset is assigned to; empty = unassigned. */
  projectIds: string[];
}

export type SupplyState = "COVERED" | "SHORT" | "SHARED_SHORT" | "NO_STOCK_DATA";

export interface OtherRobotDemand {
  robotId: string | null;
  robotName: string;
  projectName: string;
  needed: number;
}

export interface SupplyLine {
  model: string;
  needed: number;
  groupIds: string[];
  inStock: number;
  assignedHere: number;
  unassigned: number;
  assignedElsewhere: number;
  /** Units this robot can use: assigned to its project or unassigned. */
  availableHere: number;
  shortfall: number;
  otherDemand: number;
  /** Total demand across the org minus total stock, when positive. */
  sharedShortfall: number;
  otherRobots: OtherRobotDemand[];
  state: SupplyState;
}

export interface SupplyStatus {
  robotId: string;
  lines: SupplyLine[];
  /** Joints whose motor model is unknown, so they cannot be checked. */
  unknownMotors: number;
  shortModels: number;
  sharedBottlenecks: number;
}

export const modelKey = (model: string): string => model.trim().toUpperCase().replace(/\s+/g, " ");

export const computeSupply = (
  robotId: string,
  projectId: string,
  demand: DemandRow[],
  stock: StockRow[],
  unknownMotors: number,
): SupplyStatus => {
  const mine = demand.filter((d) => d.robotId === robotId);
  const keys = new Map<string, string>(); // key → display model (first seen on this robot)
  for (const d of mine) if (!keys.has(modelKey(d.model))) keys.set(modelKey(d.model), d.model.trim());

  const lines: SupplyLine[] = [];
  for (const [key, model] of keys) {
    const here = mine.filter((d) => modelKey(d.model) === key);
    const needed = here.reduce((s, d) => s + d.n, 0);
    const groupIds = [...new Set(here.map((d) => d.groupId))];

    const units = stock.filter((s) => modelKey(s.model) === key);
    const assignedHere = units.filter((u) => u.projectIds.includes(projectId)).length;
    const unassigned = units.filter((u) => u.projectIds.length === 0).length;
    const assignedElsewhere = units.length - assignedHere - unassigned;
    const availableHere = assignedHere + unassigned;

    const others = new Map<string, OtherRobotDemand>();
    for (const d of demand) {
      if (d.robotId === robotId || modelKey(d.model) !== key) continue;
      const id = d.readable ? d.robotId : `hidden:${d.robotId}`;
      const o =
        others.get(id) ??
        {
          robotId: d.readable ? d.robotId : null,
          robotName: d.readable ? d.robotName : "Another robot",
          projectName: d.readable ? d.projectName : "a project you can't see",
          needed: 0,
        };
      o.needed += d.n;
      others.set(id, o);
    }
    const otherRobots = [...others.values()].sort((a, b) => b.needed - a.needed);
    const otherDemand = otherRobots.reduce((s, o) => s + o.needed, 0);

    const shortfall = Math.max(0, needed - availableHere);
    const sharedShortfall = Math.max(0, needed + otherDemand - units.length);

    let state: SupplyState;
    if (units.length === 0) state = "NO_STOCK_DATA";
    else if (shortfall > 0) state = "SHORT";
    else if (sharedShortfall > 0 && otherDemand > 0) state = "SHARED_SHORT";
    else state = "COVERED";

    lines.push({
      model,
      needed,
      groupIds,
      inStock: units.length,
      assignedHere,
      unassigned,
      assignedElsewhere,
      availableHere,
      shortfall,
      otherDemand,
      sharedShortfall,
      otherRobots,
      state,
    });
  }

  const order: Record<SupplyState, number> = { SHORT: 0, SHARED_SHORT: 1, NO_STOCK_DATA: 2, COVERED: 3 };
  lines.sort((a, b) => order[a.state] - order[b.state] || b.needed - a.needed || a.model.localeCompare(b.model));

  return {
    robotId,
    lines,
    unknownMotors,
    shortModels: lines.filter((l) => l.state === "SHORT" || l.state === "NO_STOCK_DATA").length,
    sharedBottlenecks: lines.filter((l) => l.state === "SHARED_SHORT" || (l.state === "SHORT" && l.otherDemand > 0)).length,
  };
};
