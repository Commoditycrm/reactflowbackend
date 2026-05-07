type AINode = {
  id: string;
  label: string;
  kind: string;
  shape: string;
  description?: string;
};

type AIEdge = {
  id?: string;
  source: string;
  target: string;
  label?: string;
  sourceHandle?: string;
  targetHandle?: string;
  animated?: boolean;
};

type CqlNodePayload = {
  id: string; // AI temp id like n1, n2
  fileId: string;
  name: string;
  color: string;
  shape: string;
  posX: number;
  posY: number;
  width: number;
  height: number;
  type: string;
  description: string;
};

type CqlEdgePayload = {
  id: string;
  source: string;
  target: string;
  label: string;
  sourceHandle: string;
  targetHandle: string;
  animated: boolean;
  color: string;
};

type RFNode = {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: any;
  style?: { width?: number; height?: number };
};

type LayoutDirection = "vertical" | "horizontal" | "horizantal";

type RFEdge = {
  id: string;
  source: string;
  target: string;
  label?: string;
  sourceHandle?: string;
  targetHandle?: string;
  animated?: boolean;
  color?: string;
};

function getNodeSize(kind: string, shape: string) {
  if (shape === "circle" || kind === "start" || kind === "end") {
    return { width: 70, height: 70 };
  }

  if (shape === "diamond" || kind === "decision") {
    return { width: 120, height: 80 };
  }

  if (shape === "parallelogram" || kind === "input") {
    return { width: 130, height: 60 };
  }

  if (shape === "cylinder" || kind === "storage") {
    return { width: 130, height: 70 };
  }

  return { width: 130, height: 55 };
}

function sortEdgesForLayout(edges: RFEdge[]) {
  return [...edges].sort((a, b) => {
    const al = (a.label || "").trim().toLowerCase();
    const bl = (b.label || "").trim().toLowerCase();

    const rank = (v: string) => {
      if (v === "yes" || v === "true") return 0;
      if (v === "no" || v === "false") return 1;
      if (v === "") return 2;
      return 3;
    };

    return rank(al) - rank(bl) || al.localeCompare(bl);
  });
}

function layoutFlow(
  nodes: RFNode[],
  edges: RFEdge[],
  layoutDirection: LayoutDirection = "vertical",
) {
  const H_SPACING = 220;
  const V_SPACING = 140;
  const CENTER_X = 300; // all single vertical nodes align to this center

  const outgoing = new Map<string, RFEdge[]>();
  const incomingCount = new Map<string, number>();

  for (const node of nodes) {
    outgoing.set(node.id, []);
    incomingCount.set(node.id, 0);
  }

  for (const edge of edges) {
    outgoing.get(edge.source)?.push(edge);
    incomingCount.set(edge.target, (incomingCount.get(edge.target) || 0) + 1);
  }

  for (const [nodeId, list] of outgoing.entries()) {
    outgoing.set(nodeId, sortEdgesForLayout(list));
  }

  const startNode =
    nodes.find((n) => n.data?.kind === "start") ||
    nodes.find((n) => (incomingCount.get(n.id) || 0) === 0) ||
    nodes[0];

  if (!startNode) {
    throw new Error("No start node found");
  }

  const levels = new Map<string, number>();
  const visited = new Set<string>();
  const queue: string[] = [startNode.id];

  levels.set(startNode.id, 0);
  visited.add(startNode.id);

  while (queue.length) {
    const currentId = queue.shift()!;
    const currentLevel = levels.get(currentId) || 0;
    const nextEdges = outgoing.get(currentId) || [];

    for (const edge of nextEdges) {
      if (visited.has(edge.target)) continue;

      levels.set(edge.target, currentLevel + 1);
      visited.add(edge.target);
      queue.push(edge.target);
    }
  }

  let maxLevel = Math.max(...Array.from(levels.values()), 0);

  for (const node of nodes) {
    if (!levels.has(node.id)) {
      maxLevel += 1;
      levels.set(node.id, maxLevel);
    }
  }

  const grouped = new Map<number, RFNode[]>();

  for (const node of nodes) {
    const level = levels.get(node.id) ?? 0;

    if (!grouped.has(level)) {
      grouped.set(level, []);
    }

    grouped.get(level)!.push(node);
  }

  const positioned = new Map<string, { x: number; y: number }>();

  for (const [level, levelNodes] of [...grouped.entries()].sort(
    (a, b) => a[0] - b[0],
  )) {
    levelNodes.sort((a, b) => {
      const ak = a.data?.kind || "";
      const bk = b.data?.kind || "";

      if (ak === "decision" && bk !== "decision") return -1;
      if (bk === "decision" && ak !== "decision") return 1;

      return (a.data?.label || "").localeCompare(b.data?.label || "");
    });

    const totalWidth = (levelNodes.length - 1) * H_SPACING;
    const firstCenterX = CENTER_X - totalWidth / 2;

    levelNodes.forEach((node, index) => {
      const nodeWidth = node.style?.width || 130;
      const nodeHeight = node.style?.height || 55;

      if (layoutDirection === "vertical") {
        const totalWidth = (levelNodes.length - 1) * H_SPACING;
        const firstCenterX = CENTER_X - totalWidth / 2;
        const nodeCenterX = firstCenterX + index * H_SPACING;

        positioned.set(node.id, {
          x: nodeCenterX - nodeWidth / 2,
          y: 80 + level * V_SPACING,
        });
      } else {
        const totalHeight = (levelNodes.length - 1) * V_SPACING;
        const firstCenterY = 300 - totalHeight / 2;
        const nodeCenterY = firstCenterY + index * V_SPACING;

        positioned.set(node.id, {
          x: 80 + level * H_SPACING,
          y: nodeCenterY - nodeHeight / 2,
        });
      }
    });
  }

  return nodes.map((node) => ({
    ...node,
    position: positioned.get(node.id) || { x: 0, y: 0 },
  }));
}

function convertToFlowchartRenderData(apiResponse: {
  nodes: AINode[];
  edges: AIEdge[];
  fileId: string;
  layoutDirection?: "vertical" | "horizontal" | "horizantal";
}) {
  const { nodes, edges, fileId, layoutDirection } = apiResponse;

  const nodeColor = "#ffffff";
  const edgeColor = "#b0b0b5";

  const renderNodes: RFNode[] = nodes.map((node) => {
    const size = getNodeSize(node.kind, node.shape);

    return {
      id: node.id,
      type: "customNode",
      position: { x: 0, y: 0 },
      style: {
        width: size.width,
        height: size.height,
      },
      data: {
        label: node.label,
        type: node.shape,
        description: node.description || "",
        kind: node.kind,
        color: nodeColor,
      },
    };
  });

  const isHorizontal =
    layoutDirection === "horizontal" || layoutDirection === "horizantal";

  const sourceHandle = isHorizontal ? "c" : "d";
  const targetHandle = "a";

  const renderEdges: RFEdge[] = edges.map((edge, index) => ({
    id: edge.id || `e-${index + 1}`,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle || sourceHandle,
    targetHandle: edge.targetHandle || targetHandle,
    color: edgeColor,
    label: edge.label || "",
    animated: edge.animated || false,
  }));

  const layoutedNodes = layoutFlow(renderNodes, renderEdges, layoutDirection);

  const cqlNodes: CqlNodePayload[] = layoutedNodes.map((node) => ({
    id: node.id,
    fileId,
    name: node.data?.label || "",
    color: node.data?.color || nodeColor,
    shape: node.data?.type || "rectangle",
    posX: node.position.x,
    posY: node.position.y,
    width: node.style?.width || 130,
    height: node.style?.height || 55,
    type: node.type || "customNode",
    description: node.data?.description || "",
  }));

  const cqlEdges: CqlEdgePayload[] = renderEdges.map((edge, index) => ({
    id: edge.id || `e-${index + 1}`,
    source: edge.source,
    target: edge.target,
    label: edge.label || "",
    sourceHandle: edge.sourceHandle || "d",
    targetHandle: edge.targetHandle || "b",
    animated: edge.animated || false,
    color: edge.color || edgeColor,
  }));

  return {
    nodes: cqlNodes,
    edges: cqlEdges,
  };
}

export default convertToFlowchartRenderData;
