import { identity, invert, multiply, ParsedUrdf, UrdfError, UrdfJoint, UrdfLink } from "./urdf";

/**
 * Other ways in: a CAD model (GLB, or STEP converted to GLB in the browser)
 * described as a tree of named parts with world transforms, and a bill of
 * materials (CSV). Both are turned into the same ParsedUrdf shape so the rest
 * of the pipeline (planRobot, buildImportPayload) is shared.
 */

export const SYNTHETIC_ROOT = "__model_root__";

export interface ModelPartInput {
  name: string;
  parent?: string | null;
  /** Row-major 4×4 world transform. */
  matrix: number[];
  /** World-space centre of the part's geometry (bounding-box centre). */
  center?: number[] | null;
}

const MAX_PARTS = 2000;

/** World-space centres given by the client, keyed by part name. */
export const centersFromModelParts = (parts: ModelPartInput[]): Record<string, [number, number, number]> => {
  const out: Record<string, [number, number, number]> = {};
  for (const p of parts ?? []) {
    const c = p.center;
    if (Array.isArray(c) && c.length === 3 && c.every((n) => Number.isFinite(n))) out[p.name.trim()] = [c[0]!, c[1]!, c[2]!];
  }
  return out;
};

/** Builds a tree of fixed joints whose forward kinematics reproduce the given world transforms. */
export const parsedFromModelParts = (robotName: string, parts: ModelPartInput[]): ParsedUrdf => {
  if (!Array.isArray(parts) || !parts.length) throw new UrdfError("The model has no parts.");
  if (parts.length > MAX_PARTS) throw new UrdfError(`The model has too many parts (limit ${MAX_PARTS}).`);

  const names = new Set<string>();
  for (const p of parts) {
    const name = String(p?.name ?? "").trim();
    if (!name) throw new UrdfError("A part has no name.");
    if (name === SYNTHETIC_ROOT) throw new UrdfError(`"${SYNTHETIC_ROOT}" is a reserved name.`);
    if (names.has(name)) throw new UrdfError(`Duplicate part name "${name}".`);
    if (!Array.isArray(p.matrix) || p.matrix.length !== 16 || p.matrix.some((n) => !Number.isFinite(n))) {
      throw new UrdfError(`Part "${name}" has an invalid transform.`);
    }
    names.add(name);
  }

  const byName = new Map(parts.map((p) => [p.name.trim(), p]));
  // Parent must exist and must not create a loop; otherwise attach to the root.
  const parentOf = new Map<string, string>();
  for (const p of parts) {
    const name = p.name.trim();
    const parent = p.parent?.trim();
    parentOf.set(name, parent && byName.has(parent) && parent !== name ? parent : SYNTHETIC_ROOT);
  }
  for (const name of names) {
    const seen = new Set<string>([name]);
    let cur = parentOf.get(name)!;
    while (cur !== SYNTHETIC_ROOT) {
      if (seen.has(cur)) {
        parentOf.set(name, SYNTHETIC_ROOT);
        break;
      }
      seen.add(cur);
      cur = parentOf.get(cur)!;
    }
  }

  const links: UrdfLink[] = [
    { name: SYNTHETIC_ROOT, visuals: [] },
    ...parts.map((p) => ({
      name: p.name.trim(),
      visuals: [{ meshFile: p.name.trim(), meshPath: p.name.trim(), scale: [1, 1, 1] as [number, number, number], origin: identity(), color: null }],
    })),
  ];
  const world = (n: string) => (n === SYNTHETIC_ROOT ? identity() : byName.get(n)!.matrix);
  const joints: UrdfJoint[] = parts.map((p) => {
    const name = p.name.trim();
    const parent = parentOf.get(name)!;
    return {
      name: `${parent}->${name}`,
      type: "fixed",
      parent,
      child: name,
      origin: multiply(invert(world(parent)), world(name)),
      axis: [1, 0, 0],
      limit: null,
    };
  });
  return { robotName, links, joints, rootLink: SYNTHETIC_ROOT };
};

// ---------------------------------------------------------------------------
// Bill of materials
// ---------------------------------------------------------------------------

export interface BomRow {
  joint: string | null;
  part: string | null;
  model: string;
  qty: number;
}

/** Minimal RFC 4180 CSV reader (quotes, escaped quotes, CRLF). */
export const parseCsv = (text: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === "," || ch === ";" || ch === "\t") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows;
};

const findCol = (header: string[], names: RegExp) => header.findIndex((h) => names.test(h.trim().toLowerCase()));

const MAX_BOM_BYTES = 1024 * 1024;

/**
 * Reads a BOM with a header row. Recognised columns (any order, case-insensitive):
 * joint; part / link / component / item / name; motor / model / actuator / servo / part number; qty / quantity / count.
 */
export const parseBomCsv = (csv: string): BomRow[] => {
  if (!csv?.trim()) return [];
  if (csv.length > MAX_BOM_BYTES) throw new UrdfError("The BOM file is too large (limit 1 MB).");
  const [header, ...rows] = parseCsv(csv);
  if (!header) return [];
  const jointCol = findCol(header, /^joints?$/);
  const partCol = findCol(header, /^(part|link|component|item|name|part name|assembly)$/);
  const modelCol = findCol(header, /^(motor|model|actuator|servo|motor model|part number|part no\.?|mpn)$/);
  const qtyCol = findCol(header, /^(qty|quantity|count|units)$/);
  if (modelCol === -1 || (jointCol === -1 && partCol === -1)) {
    throw new UrdfError("The BOM needs a header with a motor/model column and a joint or part column.");
  }
  const out: BomRow[] = [];
  for (const r of rows.slice(0, 5000)) {
    const model = (r[modelCol] ?? "").trim().slice(0, 60);
    if (!model) continue;
    const qtyRaw = qtyCol >= 0 ? Number((r[qtyCol] ?? "").trim() || 1) : 1;
    const qty = Number.isFinite(qtyRaw) ? Math.min(Math.max(Math.round(qtyRaw), 0), 200) : 1;
    if (!qty) continue;
    const joint = jointCol >= 0 ? (r[jointCol] ?? "").trim().slice(0, 120) || null : null;
    const part = partCol >= 0 ? (r[partCol] ?? "").trim().slice(0, 120) || null : null;
    if (!joint && !part) continue;
    out.push({ joint, part, model, qty });
  }
  return out;
};

/**
 * Maps BOM rows onto a robot: rows naming a joint set that joint's motor
 * model; rows naming a part (link) add motors to that part.
 */
export const applyBom = (urdf: ParsedUrdf, rows: BomRow[]) => {
  const jointByLower = new Map(urdf.joints.map((j) => [j.name.toLowerCase(), j.name]));
  const linkByLower = new Map(urdf.links.map((l) => [l.name.toLowerCase(), l.name]));
  const motorModels: Record<string, string> = {};
  const partMotors: Record<string, string[]> = {};
  const unmatched: string[] = [];
  for (const row of rows) {
    const joint = row.joint ? jointByLower.get(row.joint.toLowerCase()) : undefined;
    if (joint) {
      motorModels[joint] = row.model;
      continue;
    }
    const partName = row.part ?? row.joint;
    const link = partName ? linkByLower.get(partName.toLowerCase()) : undefined;
    if (link) {
      const list = partMotors[link] ?? [];
      for (let i = 0; i < row.qty; i++) list.push(row.model);
      partMotors[link] = list;
      continue;
    }
    unmatched.push(row.joint ?? row.part ?? row.model);
  }
  return { motorModels, partMotors, unmatched: [...new Set(unmatched)] };
};

/** A robot with no 3D model: one part per BOM part name, all attached to the root. */
export const parsedFromBom = (robotName: string, rows: BomRow[]): ParsedUrdf => {
  const names = [...new Set(rows.map((r) => r.part ?? r.joint).filter((n): n is string => !!n))];
  if (!names.length) throw new UrdfError("The BOM has no part names.");
  return parsedFromModelParts(
    robotName,
    names.slice(0, MAX_PARTS).map((name) => ({ name, parent: null, matrix: identity() })),
  );
};
