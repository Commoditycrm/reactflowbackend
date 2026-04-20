import { FlowKind } from "../interfaces/types";

export function inferKindFromLabel(label: string): FlowKind {
  const text = label.toLowerCase().trim();

  if (text.includes("?") || text.startsWith("is ") || text.startsWith("has ")) {
    return "decision";
  }

  if (
    text.includes("input") ||
    text.includes("enter") ||
    text.includes("receive")
  ) {
    return "input";
  }

  if (
    text.includes("save") ||
    text.includes("store") ||
    text.includes("database")
  ) {
    return "storage";
  }

  if (text.includes("start") || text.includes("begin")) {
    return "start";
  }

  if (text.includes("end") || text.includes("finish")) {
    return "end";
  }

  return "process";
}
