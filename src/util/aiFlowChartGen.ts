import { FlowKind, ShapeType } from "../interfaces/types";

const allowedKinds: FlowKind[] = [
  "start",
  "process",
  "decision",
  "input",
  "storage",
  "end",
];

const normalizeKind = (value: unknown): FlowKind => {
  if (typeof value !== "string") return "process";
  return allowedKinds.includes(value as FlowKind)
    ? (value as FlowKind)
    : "process";
};

export { normalizeKind };
