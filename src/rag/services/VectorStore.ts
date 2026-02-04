import { Neo4JConnection } from "../../database/connection";
import logger from "../../logger";
import { RAG_CONFIG, RAGQueryResult, VectorSearchOptions } from "../types/rag.types";
import { EmbeddingService } from "./EmbeddingService";
import { ProcessedChunk } from "./PDFProcessor";
import neo4j from "neo4j-driver";

export class VectorStore {
  private static instance: VectorStore;
  private embeddingService: EmbeddingService;
  private initializedIndexes = new Set<string>();

  private constructor() {
    this.embeddingService = EmbeddingService.getInstance();
  }

  static getInstance(): VectorStore {
    if (!VectorStore.instance) VectorStore.instance = new VectorStore();
    return VectorStore.instance;
  }

  private buildOrgLabel(orgId: string): string {
    // Neo4j labels must start with a letter and contain only alphanumerics/underscore
    const safe = orgId.replace(/[^a-zA-Z0-9]/g, "_");
    return `OrgChunk_${safe}`;
  }

  private buildIndexName(orgId: string): string {
    const safe = orgId.replace(/[^a-zA-Z0-9]/g, "_");
    return `${RAG_CONFIG.VECTOR_INDEX_NAME}_org_${safe}`;
  }

  async ensureVectorIndex(orgId: string): Promise<{ indexName: string; label: string }> {
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
            \`vector.dimensions\`: ${RAG_CONFIG.EMBEDDING_DIMENSIONS},
            \`vector.similarity_function\`: 'cosine'
          }
        }
      `);

      this.initializedIndexes.add(indexName);
      logger?.info("Vector index created/verified", { indexName, label });
    } catch (error: any) {
      if (!error.message?.includes("already exists")) {
        logger?.error("VectorStore.ensureVectorIndex failed", { error, indexName, label });
        throw error;
      }
      this.initializedIndexes.add(indexName);
    } finally {
      await session.close();
    }

    return { indexName, label };
  }

  async storeChunks(
    chunks: ProcessedChunk[],
    externalFileId: string,
    orgId: string
  ): Promise<number> {
    const { indexName, label } = await this.ensureVectorIndex(orgId);

    const conn = await Neo4JConnection.getInstance();
    const session = conn.driver.session();

    try {
      const embeddings = await this.embeddingService.generateEmbeddings(
        chunks.map((c) => c.content)
      );

      const tx = session.beginTransaction();
      let storedCount = 0;

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const embeddingResult = embeddings[i];
        if (!chunk || !embeddingResult) continue;

        const embedding = embeddingResult.embedding;

        await tx.run(
          `
          MATCH (ef:ExternalFile {id: $externalFileId})
          CREATE (c:DocumentChunk:${label} {
            id: randomUUID(),
            content: $content,
            embedding: $embedding,
            pageNumber: $pageNumber,
            chunkIndex: $chunkIndex,
            status: 'COMPLETED',
            metadata: $metadata,
            createdAt: datetime()
          })
          CREATE (c)-[:CHUNK_OF]->(ef)
          RETURN c.id AS chunkId
          `,
          {
            externalFileId,
            content: chunk.content,
            embedding,
            pageNumber: chunk.pageNumber,
            chunkIndex: chunk.chunkIndex,
            metadata: JSON.stringify(chunk.metadata ?? {}),
          }
        );
        storedCount++;
      }

      await tx.commit();
      logger?.info("VectorStore.storeChunks completed", {
        externalFileId,
        storedCount,
      });

      return storedCount;
    } catch (error) {
      logger?.error("VectorStore.storeChunks failed", { error, externalFileId });
      throw error;
    } finally {
      await session.close();
    }
  }

  async searchSimilar(
    query: string,
    options: VectorSearchOptions
  ): Promise<RAGQueryResult[]> {
    const conn = await Neo4JConnection.getInstance();
    const session = conn.driver.session();

    try {
      const { embedding } = await this.embeddingService.generateEmbedding(query);
      const topK = options.topK ?? RAG_CONFIG.MAX_CONTEXT_CHUNKS;
      const minScore = options.minScore ?? RAG_CONFIG.MIN_RELEVANCE_SCORE;

      const { indexName } = await this.ensureVectorIndex(options.orgId);

      // Ensure embedding is a plain array for Neo4j
      const embeddingArray: number[] = (Array.isArray(embedding)
        ? embedding
        : Array.from(embedding as Iterable<number>)).map((v) => Number(v));
      
      // Convert to Float64Array and then to regular array to ensure proper type
      const float64Embedding = new Float64Array(embeddingArray);
      const properEmbedding = Array.from(float64Embedding);
      
      logger?.info("VectorStore.searchSimilar executing", {
        embeddingLength: properEmbedding.length,
        embeddingType: typeof properEmbedding,
        isArray: Array.isArray(properEmbedding),
        firstValues: properEmbedding.slice(0, 3),
        indexName
      });

      // Simple vector search first, then filter
      // Note: indexName must be interpolated, not parameterized
      const result = await session.run(
        `
        CALL db.index.vector.queryNodes('${indexName}', toInteger($topK), $embedding)
        YIELD node AS chunk, score
        WHERE score >= $minScore
        
        MATCH (chunk)-[:CHUNK_OF]->(ef:ExternalFile)
        WHERE ef.deletedAt IS NULL
        
        // Verify access path: User -> Org -> Project -> BacklogItem -> ExternalFile
        MATCH (u:User {externalId: $userId})-[:OWNS|MEMBER_OF]->(org:Organization)
        MATCH (org)-[:HAS_PROJECTS]->(p:Project {id: $projectId})
        WHERE p.deletedAt IS NULL
        MATCH (bi:BacklogItem)-[:ITEM_IN_PROJECT]->(p)
        MATCH (bi)-[:HAS_ATTACHED_FILE]->(ef)

        RETURN chunk.content AS content,
               score,
               ef.name AS source,
               chunk.pageNumber AS pageNumber,
               ef.id AS documentId
        ORDER BY score DESC
        LIMIT toInteger($topK)
        `,
        {
          userId: options.userId,
          projectId: options.projectId,
          embedding: properEmbedding,
          topK,
          minScore,
        }
      );

      return result.records.map((record) => ({
        content: record.get("content"),
        score: record.get("score"),
        source: record.get("source"),
        pageNumber: record.get("pageNumber"),
        documentId: record.get("documentId"),
      }));
    } catch (error) {
      logger?.error("VectorStore.searchSimilar failed", { error });
      throw error;
    } finally {
      await session.close();
    }
  }

  async deleteChunksForDocument(externalFileId: string): Promise<number> {
    const conn = await Neo4JConnection.getInstance();
    const session = conn.driver.session();

    try {
      const result = await session.run(
        `
        MATCH (c:DocumentChunk)-[:CHUNK_OF]->(ef:ExternalFile {id: $externalFileId})
        WITH c, count(c) AS cnt
        DETACH DELETE c
        RETURN cnt
        `,
        { externalFileId }
      );

      const deletedCount = result.records[0]?.get("cnt") ?? 0;
      logger?.info("VectorStore.deleteChunksForDocument completed", {
        externalFileId,
        deletedCount,
      });

      return deletedCount;
    } catch (error) {
      logger?.error("VectorStore.deleteChunksForDocument failed", {
        error,
        externalFileId,
      });
      throw error;
    } finally {
      await session.close();
    }
  }

  async getDocumentChunkCount(externalFileId: string): Promise<number> {
    const conn = await Neo4JConnection.getInstance();
    const session = conn.driver.session();

    try {
      const result = await session.run(
        `
        MATCH (c:DocumentChunk)-[:CHUNK_OF]->(ef:ExternalFile {id: $externalFileId})
        RETURN count(c) AS cnt
        `,
        { externalFileId }
      );

      return result.records[0]?.get("cnt") ?? 0;
    } finally {
      await session.close();
    }
  }

  async getProjectDocumentStatuses(
    projectId: string,
    userId: string
  ): Promise<
    Array<{
      documentId: string;
      documentName: string;
      status: string;
      totalChunks: number;
      indexedChunks: number;
    }>
  > {
    const conn = await Neo4JConnection.getInstance();
    const session = conn.driver.session();

    try {
      const result = await session.run(
        `
        MATCH (u:User {externalId: $userId})-[:OWNS|MEMBER_OF]->(org:Organization)
        MATCH (org)-[:HAS_PROJECTS]->(p:Project {id: $projectId})
        WHERE p.deletedAt IS NULL

        CALL {
          WITH p
          MATCH (parent)-[:HAS_ATTACHED_FILE]->(ef:ExternalFile {type: 'PDF'})
          WHERE ef.deletedAt IS NULL
            AND (
              EXISTS { MATCH (p)-[:HAS_CHILD_ITEM|HAS_CHILD_FILE|HAS_CHILD_FOLDER*1..10]->(parent) }
              OR EXISTS { MATCH (p)<-[:ITEM_IN_PROJECT]-(parent:BacklogItem) }
            )
          RETURN ef
        }

        WITH DISTINCT ef
        OPTIONAL MATCH (chunk:DocumentChunk)-[:CHUNK_OF]->(ef)

        WITH ef,
             count(chunk) AS indexedChunks,
             CASE
               WHEN count(chunk) > 0 THEN 'COMPLETED'
               ELSE 'PENDING'
             END AS status

        RETURN ef.id AS documentId,
               ef.name AS documentName,
               status,
               indexedChunks AS totalChunks,
               indexedChunks
        ORDER BY ef.createdAt DESC
        `,
        { userId, projectId }
      );

      return result.records.map((record) => ({
        documentId: record.get("documentId"),
        documentName: record.get("documentName"),
        status: record.get("status"),
        totalChunks: record.get("totalChunks"),
        indexedChunks: record.get("indexedChunks"),
      }));
    } catch (error) {
      logger?.error("VectorStore.getProjectDocumentStatuses failed", { error });
      throw error;
    } finally {
      await session.close();
    }
  }
}
