import { Neo4JConnection } from "../../database/connection";
import logger from "../../logger";
import {
  DiagramSearchResult,
  DiagramSummary,
  RAG_CONFIG,
} from "../types/rag.types";
import { DiagramService } from "./DiagramService";
import { EmbeddingServiceFactory, IEmbeddingService } from "./EmbeddingServiceFactory";

// Utility function to add delay between API calls
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Manages lightweight diagram summary embeddings.
 *
 * Each diagram file gets a single DiagramSummaryNode in Neo4j containing:
 *   - A Groq Llama-4 generated text summary of the diagram's content
 *   - An embedding of that summary (via ngrok local model) for vector search
 *
 * This allows semantic search over diagrams ("find the order flow")
 * without embedding the full graph structure.
 * The actual diagram data is always fetched live from Neo4j at query time.
 */
export class DiagramIndexService {
  private static instance: DiagramIndexService;
  private embeddingService: IEmbeddingService;
  private diagramService: DiagramService;
  private initializedIndexes = new Set<string>();

  private constructor() {
    this.embeddingService = EmbeddingServiceFactory.getInstance();
    this.diagramService = DiagramService.getInstance();
  }

  static getInstance(): DiagramIndexService {
    if (!DiagramIndexService.instance)
      DiagramIndexService.instance = new DiagramIndexService();
    return DiagramIndexService.instance;
  }

  // ─── Index Management ─────────────────────────────────────────────────

  private buildOrgLabel(orgId: string): string {
    const safe = orgId.replace(/[^a-zA-Z0-9]/g, "_");
    return `OrgDiagramSummary_${safe}`;
  }

  private buildIndexName(orgId: string): string {
    const safe = orgId.replace(/[^a-zA-Z0-9]/g, "_");
    return `${RAG_CONFIG.DIAGRAM_SUMMARY_INDEX_NAME}_org_${safe}`;
  }

  async ensureVectorIndex(
    orgId: string
  ): Promise<{ indexName: string; label: string }> {
    const label = this.buildOrgLabel(orgId);
    const indexName = this.buildIndexName(orgId);

    if (this.initializedIndexes.has(indexName)) return { indexName, label };

    const conn = await Neo4JConnection.getInstance();
    const session = conn.driver.session();

    try {
      await session.run(`
        CREATE VECTOR INDEX ${indexName} IF NOT EXISTS
        FOR (c:${label})
        ON c.embedding
        OPTIONS {
          indexConfig: {
            \`vector.dimensions\`: ${RAG_CONFIG.DIAGRAM_SUMMARY_EMBEDDING_DIMENSIONS},
            \`vector.similarity_function\`: 'cosine'
          }
        }
      `);

      this.initializedIndexes.add(indexName);
      logger?.info("DiagramIndexService: vector index created/verified", {
        indexName,
        label,
      });
    } catch (error: any) {
      if (!error.message?.includes("already exists")) {
        logger?.error("DiagramIndexService.ensureVectorIndex failed", {
          error,
          indexName,
          label,
        });
        throw error;
      }
      this.initializedIndexes.add(indexName);
    } finally {
      await session.close();
    }

    return { indexName, label };
  }

  // ─── Summary Generation & Storage ─────────────────────────────────────

  /**
   * Generate and store a summary embedding for a single diagram file.
   * If a summary already exists, it is replaced (for diagram update scenarios).
   */
  async indexDiagram(
    fileId: string,
    projectId: string,
    userId: string,
    orgId: string
  ): Promise<DiagramSummary | null> {
    const { label } = await this.ensureVectorIndex(orgId);

    // 1. Fetch full diagram data
    const diagramData = await this.diagramService.fetchDiagramData(
      fileId,
      projectId,
      userId,
      orgId
    );
    if (!diagramData || diagramData.nodes.length === 0) {
      logger?.info(
        "DiagramIndexService.indexDiagram: no nodes found, skipping",
        { fileId }
      );
      return null;
    }

    // 2. Generate summary via Groq Llama-4
    const nodeInfos = diagramData.nodes.map((n) => ({
      name: n.name,
      shape: n.shape,
      description: n.description,
    }));
    const edgeInfos = diagramData.edges.map((e) => ({
      sourceName: e.sourceName,
      targetName: e.targetName,
      label: e.label,
    }));
    const groupInfos = diagramData.groups.map((g) => ({
      name: g.name,
      childNodeNames: g.childNodeIds
        .map((id) => diagramData.nodes.find((n) => n.id === id)?.name ?? id)
        .filter(Boolean),
    }));

    const summaryText = await this.embeddingService.summarizeDiagram(
      diagramData.fileName,
      nodeInfos,
      edgeInfos,
      groupInfos
    );

    // Log the Groq-generated summary
    logger?.info("DiagramIndexService: Summary generated", {
      fileId,
      fileName: diagramData.fileName,
      summaryLength: summaryText.length,
      summary: summaryText,
    });
    console.log("\n" + "-".repeat(80));
    console.log(`Diagram: ${diagramData.fileName}`);
    console.log("-".repeat(80));
    console.log(summaryText);
    console.log("-".repeat(80) + "\n");

    // 3. Embed the summary using local model (ngrok)
    const { embedding } =
      await this.embeddingService.generateEmbedding(summaryText);

    // 4. Upsert DiagramSummaryNode in Neo4j
    const conn = await Neo4JConnection.getInstance();
    const session = conn.driver.session();

    try {
      // Delete existing summary for this file
      await session.run(
        `
        MATCH (ds:DiagramSummaryNode)-[:SUMMARY_OF]->(file:File {id: $fileId})
        DETACH DELETE ds
        `,
        { fileId }
      );

      // Create new summary node
      await session.run(
        `
        MATCH (file:File {id: $fileId})
        CREATE (ds:DiagramSummaryNode:${label} {
          id: randomUUID(),
          summary: $summary,
          embedding: $embedding,
          nodeCount: $nodeCount,
          edgeCount: $edgeCount,
          groupCount: $groupCount,
          createdAt: datetime()
        })
        CREATE (ds)-[:SUMMARY_OF]->(file)
        `,
        {
          fileId,
          summary: summaryText,
          embedding,
          nodeCount: diagramData.nodes.length,
          edgeCount: diagramData.edges.length,
          groupCount: diagramData.groups.length,
        }
      );

      logger?.info("DiagramIndexService.indexDiagram completed", {
        fileId,
        fileName: diagramData.fileName,
        summaryLength: summaryText.length,
        embeddingDimension: embedding.length,
        nodeCount: diagramData.nodes.length,
        edgeCount: diagramData.edges.length,
        groupCount: diagramData.groups.length,
      });
      console.log(`Stored in Neo4j with ${embedding.length}-dim embedding\n`);

      return {
        fileId,
        fileName: diagramData.fileName,
        nodeCount: diagramData.nodes.length,
        edgeCount: diagramData.edges.length,
        groupCount: diagramData.groups.length,
        summary: summaryText,
      };
    } catch (error) {
      logger?.error("DiagramIndexService.indexDiagram storage failed", {
        error,
        fileId,
      });
      throw error;
    } finally {
      await session.close();
    }
  }

  /**
   * Index all diagrams in a project that don't have summaries yet.
   */
  async indexProjectDiagrams(
    projectId: string,
    userId: string,
    orgId: string
  ): Promise<{
    total: number;
    indexed: number;
    skipped: number;
    failed: number;
  }> {
    const diagrams = await this.diagramService.listProjectDiagrams(
      projectId,
      userId,
      orgId
    );

    let indexed = 0;
    let skipped = 0;
    let failed = 0;

    for (const d of diagrams) {
      if (d.hasSummaryEmbedding) {
        skipped++;
        continue;
      }

      try {
        const result = await this.indexDiagram(
          d.fileId,
          projectId,
          userId,
          orgId
        );
        if (result) indexed++;
        else skipped++;
        
        // Add delay between API calls to avoid rate limiting
        await sleep(2000);
      } catch (error) {
        logger?.error(
          "DiagramIndexService.indexProjectDiagrams: failed for diagram",
          { fileId: d.fileId, error }
        );
        failed++;
        
        // Add delay even on failure to respect rate limits
        await sleep(2000);
      }
    }

    logger?.info("DiagramIndexService.indexProjectDiagrams completed", {
      projectId,
      total: diagrams.length,
      indexed,
      skipped,
      failed,
    });

    return { total: diagrams.length, indexed, skipped, failed };
  }

  // ─── Search ───────────────────────────────────────────────────────────

  /**
   * Semantic search over diagram summaries to find relevant diagrams.
   */
  async searchDiagrams(
    query: string,
    orgId: string,
    projectId: string,
    userId: string,
    topK = 3
  ): Promise<DiagramSearchResult[]> {
    const { indexName } = await this.ensureVectorIndex(orgId);

    const conn = await Neo4JConnection.getInstance();
    const session = conn.driver.session();

    try {
      const { embedding } =
        await this.embeddingService.generateEmbedding(query);

      const embeddingArray: number[] = (
        Array.isArray(embedding)
          ? embedding
          : Array.from(embedding as Iterable<number>)
      ).map((v) => Number(v));

      const float64Embedding = new Float64Array(embeddingArray);
      const properEmbedding = Array.from(float64Embedding);

      const result = await session.run(
        `
        CALL db.index.vector.queryNodes('${indexName}', toInteger($topK), $embedding)
        YIELD node AS ds, score
        WHERE score >= $minScore

        MATCH (ds)-[:SUMMARY_OF]->(file:File)
        WHERE file.deletedAt IS NULL

        // Verify the file belongs to the requested project
        MATCH (u:User {externalId: $userId})-[:OWNS|MEMBER_OF]->(org:Organization {id: $orgId})
        MATCH (org)-[:HAS_PROJECTS]->(p:Project {id: $projectId})
        WHERE p.deletedAt IS NULL
          AND (
            EXISTS { MATCH (p)-[:HAS_CHILD_FILE]->(file) }
            OR EXISTS { MATCH (p)-[:HAS_CHILD_FOLDER*1..5]->(:Folder)-[:HAS_CHILD_FILE]->(file) }
          )

        RETURN file.id AS fileId,
               file.name AS fileName,
               score,
               ds.summary AS summary
        ORDER BY score DESC
        LIMIT toInteger($topK)
        `,
        {
          embedding: properEmbedding,
          topK,
          minScore: RAG_CONFIG.MIN_RELEVANCE_SCORE,
          userId,
          orgId,
          projectId,
        }
      );

      return result.records.map((r) => ({
        fileId: r.get("fileId"),
        fileName: r.get("fileName"),
        score: r.get("score"),
        summary: r.get("summary"),
      }));
    } catch (error) {
      logger?.error("DiagramIndexService.searchDiagrams failed", { error });
      throw error;
    } finally {
      await session.close();
    }
  }

  // ─── Cleanup ──────────────────────────────────────────────────────────

  /**
   * Delete summary embedding for a diagram file.
   */
  async deleteDiagramSummary(fileId: string): Promise<number> {
    const conn = await Neo4JConnection.getInstance();
    const session = conn.driver.session();

    try {
      const result = await session.run(
        `
        MATCH (ds:DiagramSummaryNode)-[:SUMMARY_OF]->(file:File {id: $fileId})
        WITH ds, count(ds) AS cnt
        DETACH DELETE ds
        RETURN cnt
        `,
        { fileId }
      );

      return result.records[0]?.get("cnt") ?? 0;
    } catch (error) {
      logger?.error("DiagramIndexService.deleteDiagramSummary failed", {
        error,
        fileId,
      });
      throw error;
    } finally {
      await session.close();
    }
  }
}
