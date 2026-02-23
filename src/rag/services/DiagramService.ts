import { Neo4JConnection } from "../../database/connection";
import logger from "../../logger";
import {
  DiagramData,
  DiagramEdge,
  DiagramGroup,
  DiagramListItem,
  DiagramNode,
} from "../types/rag.types";

/**
 * Fetches diagram data (FlowNodes, LINKED_TO edges, GroupNodes) from Neo4j
 * and serializes it into structured text that an LLM can understand.
 */
export class DiagramService {
  private static instance: DiagramService;

  private constructor() {}

  static getInstance(): DiagramService {
    if (!DiagramService.instance)
      DiagramService.instance = new DiagramService();
    return DiagramService.instance;
  }

  // ─── Data Fetching ───────────────────────────────────────────────────────

  /**
   * List all diagram files in a project with node/edge/group counts.
   */
  async listProjectDiagrams(
    projectId: string,
    userId: string,
    orgId: string
  ): Promise<DiagramListItem[]> {
    const conn = await Neo4JConnection.getInstance();
    const session = conn.driver.session();

    try {
      const result = await session.run(
        `
        MATCH (u:User {externalId: $userId})-[:OWNS|MEMBER_OF]->(org:Organization {id: $orgId})
        MATCH (org)-[:HAS_PROJECTS]->(p:Project {id: $projectId})
        WHERE p.deletedAt IS NULL

        // Direct files under project
        CALL {
          WITH p
          OPTIONAL MATCH (p)-[:HAS_CHILD_FILE]->(file:File)
          WHERE file.deletedAt IS NULL
          RETURN file
          UNION
          WITH p
          OPTIONAL MATCH (p)-[:HAS_CHILD_FOLDER*1..5]->(folder:Folder)-[:HAS_CHILD_FILE]->(file:File)
          WHERE file.deletedAt IS NULL AND folder.deletedAt IS NULL
          RETURN file
        }

        WITH DISTINCT file
        WHERE file IS NOT NULL

        // Only files that have FlowNodes (i.e. diagrams)
        MATCH (file)-[:HAS_FLOW_NODE]->(fn:FlowNode)
        WHERE fn.deletedAt IS NULL

        WITH file, collect(DISTINCT fn) AS flowNodes

        // Count edges
        OPTIONAL MATCH (file)-[:HAS_FLOW_NODE]->(src:FlowNode)-[edge:LINKED_TO]->(tgt:FlowNode)
        WHERE src.deletedAt IS NULL AND tgt.deletedAt IS NULL AND edge.color IS NOT NULL

        WITH file, flowNodes, count(DISTINCT edge) AS edgeCount

        // Count groups
        OPTIONAL MATCH (file)-[:HAS_GROUP_NODE]->(gn:GroupNode)
        WHERE gn.deletedAt IS NULL

        WITH file, size(flowNodes) AS nodeCount, edgeCount, count(DISTINCT gn) AS groupCount

        // Check if summary embedding exists
        OPTIONAL MATCH (file)<-[:SUMMARY_OF]-(ds:DiagramSummaryNode)
        WHERE ds.embedding IS NOT NULL

        RETURN file.id AS fileId,
               file.name AS fileName,
               nodeCount,
               edgeCount,
               groupCount,
               ds IS NOT NULL AS hasSummaryEmbedding
        ORDER BY file.name
        `,
        { userId, orgId, projectId }
      );

      return result.records.map((r) => ({
        fileId: r.get("fileId"),
        fileName: r.get("fileName"),
        nodeCount: r.get("nodeCount"),
        edgeCount: r.get("edgeCount"),
        groupCount: r.get("groupCount"),
        hasSummaryEmbedding: r.get("hasSummaryEmbedding"),
      }));
    } catch (error) {
      logger?.error("DiagramService.listProjectDiagrams failed", { error });
      throw error;
    } finally {
      await session.close();
    }
  }

  /**
   * Fetch the complete graph data for a single diagram file.
   */
  async fetchDiagramData(
    fileId: string,
    projectId: string,
    userId: string,
    orgId: string
  ): Promise<DiagramData | null> {
    const conn = await Neo4JConnection.getInstance();
    const session = conn.driver.session();

    try {
      // ── 1. Verify access & get file name ─────────────────────────────────
      const accessResult = await session.run(
        `
        MATCH (u:User {externalId: $userId})-[:OWNS|MEMBER_OF]->(org:Organization {id: $orgId})
        MATCH (org)-[:HAS_PROJECTS]->(p:Project {id: $projectId})
        WHERE p.deletedAt IS NULL
        MATCH (file:File {id: $fileId})
        WHERE file.deletedAt IS NULL
          AND (
            EXISTS { MATCH (p)-[:HAS_CHILD_FILE]->(file) }
            OR EXISTS { MATCH (p)-[:HAS_CHILD_FOLDER*1..5]->(:Folder)-[:HAS_CHILD_FILE]->(file) }
          )
        RETURN file.name AS fileName
        `,
        { userId, orgId, projectId, fileId }
      );

      if (accessResult.records.length === 0) return null;
      const fileName = accessResult.records[0]!.get("fileName") as string;

      // ── 2. Fetch FlowNodes ────────────────────────────────────────────────
      const nodesResult = await session.run(
        `
        MATCH (file:File {id: $fileId})-[:HAS_FLOW_NODE]->(fn:FlowNode)
        WHERE fn.deletedAt IS NULL

        OPTIONAL MATCH (fn)-[:BELONGS_TO_GROUP]->(pg:GroupNode)
        WHERE pg.deletedAt IS NULL

        OPTIONAL MATCH (fn)-[:HAS_CHILD_ITEM]->(ci:BacklogItem)
        WHERE ci.deletedAt IS NULL

        OPTIONAL MATCH (fn)-[:LINK_TO_FILE]->(fl:File)
        WHERE fl.deletedAt IS NULL

        OPTIONAL MATCH (fn)-[:HAS_COMMENT]->(cmt:Comment)
        WHERE cmt.deletedAt IS NULL

        RETURN fn.id AS id,
               fn.name AS name,
               fn.shape AS shape,
               fn.color AS color,
               fn.posX AS posX,
               fn.posY AS posY,
               fn.width AS width,
               fn.height AS height,
               fn.type AS type,
               fn.description AS description,
               pg.id AS parentGroupId,
               count(DISTINCT ci) AS childItemCount,
               count(DISTINCT fl) AS fileLinksCount,
               count(DISTINCT cmt) AS commentsCount
        `,
        { fileId }
      );

      const nodes: DiagramNode[] = nodesResult.records.map((r) => ({
        id: r.get("id"),
        name: r.get("name"),
        shape: r.get("shape"),
        color: r.get("color"),
        posX: r.get("posX"),
        posY: r.get("posY"),
        width: r.get("width"),
        height: r.get("height"),
        type: r.get("type"),
        description: r.get("description"),
        parentGroupId: r.get("parentGroupId"),
        childItemCount: r.get("childItemCount"),
        fileLinksCount: r.get("fileLinksCount"),
        commentsCount: r.get("commentsCount"),
      }));

      // ── 3. Fetch Edges (LINKED_TO relationships) ─────────────────────────
      const edgesResult = await session.run(
        `
        MATCH (file:File {id: $fileId})-[:HAS_FLOW_NODE]->(src:FlowNode)-[edge:LINKED_TO]->(tgt:FlowNode)
        WHERE src.deletedAt IS NULL AND tgt.deletedAt IS NULL
          AND edge.color IS NOT NULL
        RETURN edge.id AS id,
               src.id AS sourceId,
               tgt.id AS targetId,
               src.name AS sourceName,
               tgt.name AS targetName,
               edge.label AS label,
               edge.color AS color,
               edge.sourceHandle AS sourceHandle,
               edge.targetHandle AS targetHandle,
               edge.animated AS animated,
               edge.bidirectional AS bidirectional
        `,
        { fileId }
      );

      const edges: DiagramEdge[] = edgesResult.records.map((r) => ({
        id: r.get("id"),
        sourceId: r.get("sourceId"),
        targetId: r.get("targetId"),
        sourceName: r.get("sourceName"),
        targetName: r.get("targetName"),
        label: r.get("label") ?? "",
        color: r.get("color"),
        sourceHandle: r.get("sourceHandle"),
        targetHandle: r.get("targetHandle"),
        animated: r.get("animated") ?? false,
        bidirectional: r.get("bidirectional") ?? false,
      }));

      // ── 4. Fetch GroupNodes ───────────────────────────────────────────────
      const groupsResult = await session.run(
        `
        MATCH (file:File {id: $fileId})-[:HAS_GROUP_NODE]->(gn:GroupNode)
        WHERE gn.deletedAt IS NULL
        OPTIONAL MATCH (child:FlowNode)-[:BELONGS_TO_GROUP]->(gn)
        WHERE child.deletedAt IS NULL
        RETURN gn.id AS id,
               gn.name AS name,
               gn.posX AS posX,
               gn.posY AS posY,
               gn.width AS width,
               gn.height AS height,
               gn.color AS color,
               gn.layoutType AS layoutType,
               collect(child.id) AS childNodeIds
        `,
        { fileId }
      );

      const groups: DiagramGroup[] = groupsResult.records.map((r) => ({
        id: r.get("id"),
        name: r.get("name"),
        posX: r.get("posX"),
        posY: r.get("posY"),
        width: r.get("width"),
        height: r.get("height"),
        color: r.get("color"),
        layoutType: r.get("layoutType") ?? "HORIZONTAL",
        childNodeIds: r.get("childNodeIds") ?? [],
      }));

      return { fileId, fileName, nodes, edges, groups };
    } catch (error) {
      logger?.error("DiagramService.fetchDiagramData failed", {
        error,
        fileId,
      });
      throw error;
    } finally {
      await session.close();
    }
  }

  // ─── Serialization ─────────────────────────────────────────────────────

  /**
   * Serialize a diagram into Mermaid + structured text for LLM context.
   */
  serializeForLLM(data: DiagramData): string {
    const sections: string[] = [];
    const nodeIdMap = new Map<string, string>();

    // Build short IDs for Mermaid readability
    data.nodes.forEach((n, i) => {
      nodeIdMap.set(n.id, `N${i + 1}`);
    });

    // ── Header ──────────────────────────────────────────────────────────
    sections.push(
      `## Diagram: "${data.fileName}" (ID: ${data.fileId})\n`
    );

    // ── Mermaid ─────────────────────────────────────────────────────────
    const mermaidLines: string[] = ["graph TD"];

    for (const node of data.nodes) {
      const shortId = nodeIdMap.get(node.id) ?? node.id;
      const shape = this.mermaidShape(node.shape, node.name);
      mermaidLines.push(`    ${shortId}${shape}`);
    }

    for (const edge of data.edges) {
      const srcId = nodeIdMap.get(edge.sourceId) ?? edge.sourceId;
      const tgtId = nodeIdMap.get(edge.targetId) ?? edge.targetId;
      const label = edge.label ? `|"${edge.label}"|` : "";
      const arrow = edge.bidirectional ? "<-->" : "-->";
      mermaidLines.push(`    ${srcId} ${arrow}${label} ${tgtId}`);
    }

    sections.push("### Flowchart Structure (Mermaid):");
    sections.push("```mermaid");
    sections.push(mermaidLines.join("\n"));
    sections.push("```\n");

    // ── Groups ──────────────────────────────────────────────────────────
    if (data.groups.length > 0) {
      sections.push("### Groups:");
      for (const g of data.groups) {
        const childNames = g.childNodeIds
          .map((id) => {
            const node = data.nodes.find((n) => n.id === id);
            return node ? `"${node.name}"` : id;
          })
          .join(", ");
        sections.push(
          `- **${g.name}** (${g.layoutType}): contains [${childNames}]`
        );
      }
      sections.push("");
    }

    // ── Node Details ────────────────────────────────────────────────────
    sections.push("### Node Details:");
    for (const node of data.nodes) {
      const shortId = nodeIdMap.get(node.id) ?? node.id;
      const meta: string[] = [];
      meta.push(node.shape);
      if (node.childItemCount > 0)
        meta.push(`${node.childItemCount} backlog items`);
      if (node.fileLinksCount > 0)
        meta.push(`${node.fileLinksCount} file links`);
      if (node.commentsCount > 0)
        meta.push(`${node.commentsCount} comments`);
      if (node.description) meta.push(`desc: "${node.description}"`);

      const group = node.parentGroupId
        ? data.groups.find((g) => g.id === node.parentGroupId)
        : null;
      if (group) meta.push(`in group "${group.name}"`);

      sections.push(`- ${shortId}: "${node.name}" [${meta.join(", ")}]`);
    }
    sections.push("");

    // ── Connections Summary ─────────────────────────────────────────────
    if (data.edges.length > 0) {
      sections.push("### Connections:");
      for (const edge of data.edges) {
        const arrow = edge.bidirectional ? "↔" : "→";
        const label = edge.label ? ` (label: "${edge.label}")` : "";
        sections.push(
          `- "${edge.sourceName}" ${arrow} "${edge.targetName}"${label}`
        );
      }
      sections.push("");
    }

    return sections.join("\n");
  }

  /**
   * Produce a compact list of diagrams for the system prompt.
   */
  serializeDiagramList(diagrams: DiagramListItem[]): string {
    if (diagrams.length === 0) return "No diagrams found in this project.";

    const lines = ["Available diagrams in this project:"];
    for (const d of diagrams) {
      lines.push(
        `- "${d.fileName}" (fileId: ${d.fileId}) — ${d.nodeCount} nodes, ${d.edgeCount} edges, ${d.groupCount} groups`
      );
    }
    return lines.join("\n");
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  private mermaidShape(shape: string, name: string): string {
    const escaped = name.replace(/"/g, "'");
    switch (shape) {
      case "diamond":
        return `{"${escaped}"}`;
      case "circle":
        return `(("${escaped}"))`;
      case "ellipse":
        return `(["${escaped}"])`;
      case "parallelogram":
        return `[/"${escaped}"/]`;
      case "hexagon":
        return `{{"${escaped}"}}`;
      case "rectangle":
      default:
        return `["${escaped}"]`;
    }
  }
}
