import { XMLParser } from "fast-xml-parser";

/**
 * Minimal URDF reader for the Split & Explain feature.
 *
 * It reads the parts (links), the joints between them and each link's visual
 * mesh, then computes where every link sits when all joints are at zero.
 * Everything here is pure and synchronous so it can be unit-tested without a
 * database.
 */

export type Vec3 = [number, number, number];
/** 4×4 homogeneous transform, row-major. */
export type Mat4 = number[];

export interface UrdfVisual {
  /** File name of the mesh, without any package:// prefix or folders. */
  meshFile: string | null;
  /** The mesh path exactly as written in the URDF. */
  meshPath: string | null;
  scale: Vec3;
  /** Visual origin relative to the link frame. */
  origin: Mat4;
  color: string | null;
}

export interface UrdfLink {
  name: string;
  visuals: UrdfVisual[];
}

export type UrdfJointType =
  | "revolute"
  | "continuous"
  | "prismatic"
  | "fixed"
  | "floating"
  | "planar";

export interface UrdfJoint {
  name: string;
  type: UrdfJointType;
  parent: string;
  child: string;
  origin: Mat4;
  axis: Vec3;
  limit: { lower: number; upper: number; effort: number; velocity: number } | null;
}

export interface ParsedUrdf {
  robotName: string;
  links: UrdfLink[];
  joints: UrdfJoint[];
  rootLink: string;
}

export class UrdfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UrdfError";
  }
}

const JOINT_TYPES: UrdfJointType[] = [
  "revolute",
  "continuous",
  "prismatic",
  "fixed",
  "floating",
  "planar",
];

/** Joint types that a motor drives. */
export const isActuatedJoint = (j: Pick<UrdfJoint, "type">): boolean =>
  j.type === "revolute" || j.type === "continuous" || j.type === "prismatic";

// ---------------------------------------------------------------------------
// Matrix helpers
// ---------------------------------------------------------------------------

export const identity = (): Mat4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export const multiply = (a: Mat4, b: Mat4): Mat4 => {
  const out = new Array<number>(16).fill(0);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += (a[r * 4 + k] ?? 0) * (b[k * 4 + c] ?? 0);
      out[r * 4 + c] = s;
    }
  }
  return out;
};

/** URDF convention: R = Rz(yaw) · Ry(pitch) · Rx(roll). */
export const fromXyzRpy = (xyz: Vec3, rpy: Vec3): Mat4 => {
  const [r, p, y] = rpy;
  const cr = Math.cos(r), sr = Math.sin(r);
  const cp = Math.cos(p), sp = Math.sin(p);
  const cy = Math.cos(y), sy = Math.sin(y);
  return [
    cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr, xyz[0],
    sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr, xyz[1],
    -sp, cp * sr, cp * cr, xyz[2],
    0, 0, 0, 1,
  ];
};

export const translationOf = (m: Mat4): Vec3 => [m[3] ?? 0, m[7] ?? 0, m[11] ?? 0];

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const asArray = <T>(v: T | T[] | undefined): T[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];

const parseVec = (raw: unknown, fallback: Vec3, what: string): Vec3 => {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const parts = String(raw).trim().split(/\s+/).map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
    throw new UrdfError(`Invalid ${what}: "${String(raw)}"`);
  }
  return [parts[0]!, parts[1]!, parts[2]!];
};

const parseOrigin = (node: any, what: string): Mat4 => {
  if (!node) return identity();
  return fromXyzRpy(
    parseVec(node["@_xyz"], [0, 0, 0], `${what} origin xyz`),
    parseVec(node["@_rpy"], [0, 0, 0], `${what} origin rpy`),
  );
};

/** "package://robot/meshes/Head_Visual.STL" → "Head_Visual.STL" */
export const meshBaseName = (path: string): string => {
  const clean = path.replace(/^package:\/\//, "").replace(/^file:\/\//, "");
  const parts = clean.split(/[\\/]/);
  return parts[parts.length - 1] ?? clean;
};

const MAX_URDF_BYTES = 5 * 1024 * 1024;
const MAX_LINKS = 500;

export const parseUrdf = (xml: string): ParsedUrdf => {
  if (typeof xml !== "string" || !xml.trim()) {
    throw new UrdfError("The URDF file is empty.");
  }
  if (xml.length > MAX_URDF_BYTES) {
    throw new UrdfError("The URDF file is too large (limit 5 MB).");
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    // Robot descriptions never need entity expansion; keeping it off avoids
    // entity-expansion abuse in uploaded files.
    processEntities: false,
    allowBooleanAttributes: true,
  });

  let doc: any;
  try {
    doc = parser.parse(xml);
  } catch (e: any) {
    throw new UrdfError(`The URDF file is not valid XML: ${e?.message ?? e}`);
  }

  const robot = doc?.robot;
  if (!robot) throw new UrdfError("No <robot> element found.");

  // Named materials declared at robot level.
  const materials = new Map<string, string>();
  for (const m of asArray<any>(robot.material)) {
    const rgba = m?.color?.["@_rgba"];
    if (m?.["@_name"] && rgba) materials.set(String(m["@_name"]), String(rgba));
  }

  const links: UrdfLink[] = asArray<any>(robot.link).map((l) => {
    const name = l?.["@_name"];
    if (!name) throw new UrdfError("A <link> is missing its name.");
    const visuals: UrdfVisual[] = asArray<any>(l.visual).map((v) => {
      const mesh = v?.geometry?.mesh;
      const meshPath = mesh?.["@_filename"] ? String(mesh["@_filename"]) : null;
      const mat = v?.material;
      const color =
        (mat?.color?.["@_rgba"] as string | undefined) ??
        (mat?.["@_name"] ? materials.get(String(mat["@_name"])) : undefined) ??
        null;
      return {
        meshPath,
        meshFile: meshPath ? meshBaseName(meshPath) : null,
        scale: parseVec(mesh?.["@_scale"], [1, 1, 1], `mesh scale of link ${name}`),
        origin: parseOrigin(v?.origin, `visual of link ${name}`),
        color: color ? String(color) : null,
      };
    });
    return { name: String(name), visuals };
  });

  if (!links.length) throw new UrdfError("The URDF has no links.");
  if (links.length > MAX_LINKS) {
    throw new UrdfError(`The URDF has too many links (limit ${MAX_LINKS}).`);
  }

  const linkNames = new Set<string>();
  for (const l of links) {
    if (linkNames.has(l.name)) throw new UrdfError(`Duplicate link name "${l.name}".`);
    linkNames.add(l.name);
  }

  const joints: UrdfJoint[] = asArray<any>(robot.joint).map((j) => {
    const name = String(j?.["@_name"] ?? "");
    const type = String(j?.["@_type"] ?? "") as UrdfJointType;
    const parent = String(j?.parent?.["@_link"] ?? "");
    const child = String(j?.child?.["@_link"] ?? "");
    if (!name) throw new UrdfError("A <joint> is missing its name.");
    if (!JOINT_TYPES.includes(type)) {
      throw new UrdfError(`Joint "${name}" has unknown type "${type}".`);
    }
    if (!linkNames.has(parent) || !linkNames.has(child)) {
      throw new UrdfError(`Joint "${name}" connects links that do not exist.`);
    }
    const lim = j?.limit;
    return {
      name,
      type,
      parent,
      child,
      origin: parseOrigin(j?.origin, `joint ${name}`),
      axis: parseVec(j?.axis?.["@_xyz"], [1, 0, 0], `axis of joint ${name}`),
      limit: lim
        ? {
            lower: Number(lim["@_lower"] ?? 0),
            upper: Number(lim["@_upper"] ?? 0),
            effort: Number(lim["@_effort"] ?? 0),
            velocity: Number(lim["@_velocity"] ?? 0),
          }
        : null,
    };
  });

  const children = new Set<string>();
  for (const j of joints) {
    if (children.has(j.child)) {
      throw new UrdfError(`Link "${j.child}" has more than one parent joint.`);
    }
    children.add(j.child);
  }
  const roots = links.filter((l) => !children.has(l.name));
  if (roots.length !== 1) {
    throw new UrdfError(
      roots.length === 0
        ? "The joints form a loop; a URDF must be a tree."
        : `The URDF has ${roots.length} unconnected parts; expected one root link.`,
    );
  }

  return {
    robotName: String(robot["@_name"] ?? "Robot"),
    links,
    joints,
    rootLink: roots[0]!.name,
  };
};

/** World transform of every link with all joints at zero. */
export const computeLinkTransforms = (urdf: ParsedUrdf): Map<string, Mat4> => {
  const byParent = new Map<string, UrdfJoint[]>();
  for (const j of urdf.joints) {
    const list = byParent.get(j.parent) ?? [];
    list.push(j);
    byParent.set(j.parent, list);
  }
  const world = new Map<string, Mat4>([[urdf.rootLink, identity()]]);
  const queue = [urdf.rootLink];
  while (queue.length) {
    const link = queue.shift()!;
    const parentT = world.get(link)!;
    for (const j of byParent.get(link) ?? []) {
      world.set(j.child, multiply(parentT, j.origin));
      queue.push(j.child);
    }
  }
  return world;
};
