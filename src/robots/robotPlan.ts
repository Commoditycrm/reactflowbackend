import {
  computeLinkTransforms,
  isActuatedJoint,
  multiply,
  ParsedUrdf,
  translationOf,
  UrdfJoint,
  Vec3,
} from "./urdf";

/**
 * Turns a parsed URDF into what Split & Explain stores: part groups (shown as
 * one numbered part and one flow node each), the parts inside them, explode
 * directions for the split view, and the order in which to build them.
 */

export type Side = "left" | "right" | "center";

export interface PlannedPart {
  linkName: string;
  groupKey: string;
  side: Side;
  /** Mesh file name from the URDF, or null for links with no visual. */
  meshFile: string | null;
  /** Visual world transform (row-major 4×4) with all joints at zero. */
  matrix: number[];
  scale: Vec3;
  color: string | null;
  /** Direction × distance (in metres) the part moves at 100% split. */
  explode: Vec3;
  depth: number;
}

export interface PlannedJoint {
  name: string;
  type: UrdfJoint["type"];
  /** Motor model from the robot's config, when one was provided. */
  motorModel: string | null;
  limit: UrdfJoint["limit"];
}

export interface PlannedGroup {
  key: string;
  name: string;
  /** How many copies: 2 when the group has left and right halves. */
  qty: number;
  category: string;
  /** Build order, 0 = first. Parents come before children. */
  order: number;
  linkNames: string[];
  joints: PlannedJoint[];
}

export interface RobotPlan {
  robotName: string;
  groups: PlannedGroup[];
  parts: PlannedPart[];
  /** [parentGroupKey, childGroupKey] pairs: the child is built after the parent. */
  dependencies: [string, string][];
  /** Height of the bounding box of link origins, in metres. */
  approxSize: number;
}

export interface PlanOptions {
  /** jointName → motor model, e.g. from a Poppy-style motor config. */
  motorModels?: Record<string, string>;
  /** Distance between neighbouring parts at 100% split, as a share of robot size. */
  gapRatio?: number;
}

const SIDE_PATTERNS: [RegExp, Side][] = [
  [/^(l|left)[_\-.]/i, "left"],
  [/^(r|right)[_\-.]/i, "right"],
  [/[_\-.](l|left)$/i, "left"],
  [/[_\-.](r|right)$/i, "right"],
];

const STRIP_SUFFIXES = /([_\-.](motors?|link|visual|collision|mesh|assembly|asm))+$/i;

export const sideOf = (linkName: string): Side => {
  for (const [re, side] of SIDE_PATTERNS) if (re.test(linkName)) return side;
  return "center";
};

/** "l_shoulder_motor" → "shoulder", "RightUpperArm_link" → "rightupperarm"… */
export const groupKeyOf = (linkName: string): string => {
  let base = linkName;
  for (const [re] of SIDE_PATTERNS) base = base.replace(re, "");
  base = base.replace(STRIP_SUFFIXES, "");
  base = base.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return base || linkName.toLowerCase();
};

export const displayName = (key: string): string => {
  const words = key.split("_").filter(Boolean);
  if (!words.length) return key;
  const s = words.join(" ");
  return s.charAt(0).toUpperCase() + s.slice(1);
};

const CATEGORY_RULES: [RegExp, string][] = [
  [/head|neck|camera|eye|sensor|lidar|imu/, "Perception"],
  [/hand|grip|finger|wrist|arm|elbow|forearm/, "Manipulation"],
  [/batter|power|psu/, "Power"],
  [/foot|ankle|toe|sole/, "Locomotion"],
  [/leg|thigh|shin|knee|hip|calf/, "Locomotion"],
];

const categoryOf = (key: string, actuated: boolean): string => {
  for (const [re, cat] of CATEGORY_RULES) if (re.test(key)) return cat;
  return actuated ? "Actuation" : "Structure";
};

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const norm = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 | null => {
  const n = norm(a);
  return n < 1e-9 ? null : scale(a, 1 / n);
};
const round = (a: Vec3): Vec3 => a.map((v) => Math.round(v * 1e5) / 1e5) as Vec3;

export const planRobot = (urdf: ParsedUrdf, opts: PlanOptions = {}): RobotPlan => {
  const world = computeLinkTransforms(urdf);
  const jointByChild = new Map(urdf.joints.map((j) => [j.child, j]));

  // Depth from the root link (root = 0).
  const depth = new Map<string, number>([[urdf.rootLink, 0]]);
  const ordered: string[] = [urdf.rootLink];
  for (let i = 0; i < ordered.length; i++) {
    const link = ordered[i]!;
    for (const j of urdf.joints) {
      if (j.parent === link && !depth.has(j.child)) {
        depth.set(j.child, (depth.get(link) ?? 0) + 1);
        ordered.push(j.child);
      }
    }
  }

  // Robot size and centre from link origins.
  const positions = ordered.map((n) => translationOf(world.get(n)!));
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of positions) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k]!, p[k]!);
      hi[k] = Math.max(hi[k]!, p[k]!);
    }
  }
  const centre = scale(add(lo, hi), 0.5);
  const size = Math.max(norm(sub(hi, lo)), 0.05);
  const gap = size * (opts.gapRatio ?? 0.08);

  // Explode: each child slides away from its parent along their connection,
  // and inherits its parent's offset, so whole limbs move together.
  const explode = new Map<string, Vec3>([[urdf.rootLink, [0, 0, 0]]]);
  for (const link of ordered.slice(1)) {
    const j = jointByChild.get(link)!;
    const parentPos = translationOf(world.get(j.parent)!);
    const pos = translationOf(world.get(link)!);
    const dir =
      unit(sub(pos, parentPos)) ?? unit(sub(pos, centre)) ?? ([0, 0, 1] as Vec3);
    explode.set(link, add(explode.get(j.parent) ?? [0, 0, 0], scale(dir, gap)));
  }

  // Groups.
  const groups = new Map<string, PlannedGroup & { sides: Set<Side>; minDepth: number }>();
  const groupOfLink = new Map<string, string>();
  for (const link of ordered) {
    const key = groupKeyOf(link);
    groupOfLink.set(link, key);
    const g =
      groups.get(key) ??
      {
        key,
        name: displayName(key),
        qty: 1,
        category: "Structure",
        order: 0,
        linkNames: [],
        joints: [],
        sides: new Set<Side>(),
        minDepth: Infinity,
      };
    g.linkNames.push(link);
    g.sides.add(sideOf(link));
    g.minDepth = Math.min(g.minDepth, depth.get(link) ?? 0);
    const j = jointByChild.get(link);
    if (j && isActuatedJoint(j)) {
      g.joints.push({
        name: j.name,
        type: j.type,
        motorModel: opts.motorModels?.[j.name] ?? null,
        limit: j.limit,
      });
    }
    groups.set(key, g);
  }

  const groupList = [...groups.values()].sort(
    (a, b) => a.minDepth - b.minDepth || a.key.localeCompare(b.key),
  );
  const finalGroups: PlannedGroup[] = groupList.map((g, i) => ({
    key: g.key,
    name: g.name,
    qty: g.sides.has("left") && g.sides.has("right") ? 2 : 1,
    category: categoryOf(g.key, g.joints.length > 0),
    order: i,
    linkNames: g.linkNames,
    joints: g.joints,
  }));

  // Build dependencies between groups, following the joint tree.
  const deps = new Set<string>();
  const dependencies: [string, string][] = [];
  for (const j of urdf.joints) {
    const a = groupOfLink.get(j.parent)!;
    const b = groupOfLink.get(j.child)!;
    const id = `${a}>${b}`;
    if (a !== b && !deps.has(id)) {
      deps.add(id);
      dependencies.push([a, b]);
    }
  }

  const linkByName = new Map(urdf.links.map((l) => [l.name, l]));
  const parts: PlannedPart[] = [];
  for (const link of ordered) {
    const l = linkByName.get(link)!;
    const visuals = l.visuals.length ? l.visuals : [null];
    for (const v of visuals) {
      parts.push({
        linkName: link,
        groupKey: groupOfLink.get(link)!,
        side: sideOf(link),
        meshFile: v?.meshFile ?? null,
        matrix: multiply(world.get(link)!, v?.origin ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]).map(
          (n) => Math.round(n * 1e6) / 1e6,
        ),
        scale: v?.scale ?? [1, 1, 1],
        color: v?.color ?? null,
        explode: round(explode.get(link) ?? [0, 0, 0]),
        depth: depth.get(link) ?? 0,
      });
    }
  }

  return {
    robotName: urdf.robotName,
    groups: finalGroups,
    parts,
    dependencies,
    approxSize: Math.round(size * 1000) / 1000,
  };
};

/**
 * Reads a Poppy/pypot-style motor config ({ motors: { name: { type } } }) into
 * jointName → model. Returns {} for anything else.
 */
export const motorModelsFromConfig = (config: unknown): Record<string, string> => {
  const motors = (config as any)?.motors;
  if (!motors || typeof motors !== "object") return {};
  const out: Record<string, string> = {};
  for (const [name, m] of Object.entries<any>(motors)) {
    if (m && typeof m.type === "string") out[name] = m.type.slice(0, 60);
  }
  return out;
};
