import { BacklogItemType } from "./ogm.types";

export interface SendEmailProps {
  to: string;
  type: string;
}

export type InviteWorkForceProps = SendEmailProps & {
  senderName: string;
  organizationName: string;
  role: string;
  inviteLink: string;
  name: string;
};

export type InviteUserProps = SendEmailProps & {
  inviteLink: string;
  inviterName: string;
  orgName: string;
};

export type GeneratedTask = {
  id: string;
  content: string;
  description: string;
  type: BacklogItemType | null;
};

export type ImportSheetResult = {
  createdCount: number;
  parentLinksCreated: number;
  sprintLinksCreated: number;
  skippedCount: number;
  errors: string[];
};

export type FlowKind =
  | "start"
  | "process"
  | "decision"
  | "input"
  | "storage"
  | "end";

export type ShapeType =
  | "rectangle"
  | "round-rectangle"
  | "arrow-rectangle"
  | "circle"
  | "cylinder"
  | "diamond"
  | "hexagon"
  | "parallelogram"
  | "plus"
  | "triangle";

export const kindToShape: Record<FlowKind, ShapeType> = {
  start: "circle",
  process: "rectangle",
  decision: "diamond",
  input: "parallelogram",
  storage: "cylinder",
  end: "circle",
};

export type GeneratedFlowNode = {
  id: string;
  label: string;
  description?: string;
  kind: FlowKind;
  shape: ShapeType;
};

export type GeneratedFlowEdge = {
  id: string;
  source: string;
  target: string;
  label?: string;
};

export type GeneratedFlowchart = {
  title: string;
  nodes: GeneratedFlowNode[];
  edges: GeneratedFlowEdge[];
};
