import { Neo4JConnection } from "../../database/connection";
import logger from "../../logger";
import {
  RAG_CONFIG,
  RAGQueryResult,
  SUPPORTED_DOCUMENT_EXTENSIONS,
  SUPPORTED_DOCUMENT_MIME_HINTS,
  VectorSearchOptions,
} from "../types/rag.types";
import { EmbeddingServiceFactory, IEmbeddingService } from "./EmbeddingServiceFactory";
import { ProcessedChunk } from "./PDFProcessor";

export class VectorStore {
  private static instance: VectorStore;
  private embeddingService: IEmbeddingService;
  private initializedIndexes = new Set<string>();
  private initializedFullTextIndexes = new Set<string>();

  private constructor() {
    this.embeddingService = EmbeddingServiceFactory.getInstance();
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

  private buildFullTextIndexName(orgId: string): string {
    const safe = orgId.replace(/[^a-zA-Z0-9]/g, "_");
    return `${RAG_CONFIG.FULLTEXT_INDEX_NAME}_org_${safe}`;
  }

  private buildSupportedTypeQueryParams() {
    return {
      supportedExtensions: [...SUPPORTED_DOCUMENT_EXTENSIONS],
      supportedMimeHints: [...SUPPORTED_DOCUMENT_MIME_HINTS],
    };
  }

  private buildHybridFullTextQuery(query: string): string {
    const cleaned = query.replace(/["~*?:\\/+\-&|!(){}\[\]^]/g, " ").trim();
    const tokens = cleaned
      .toLowerCase()
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 2)
      .slice(0, 12);

    if (tokens.length === 0) return cleaned || query;

    const fuzzy = tokens.map((t) => `${t}~1`).join(" OR ");
    return cleaned ? `"${cleaned}" OR ${fuzzy}` : fuzzy;
  }

  private computeHybridScore(
    query: string,
    content: string,
    vectorScore: number,
    normalizedKeywordScore: number
  ): number {
    const q = query.toLowerCase().trim();
    const c = content.toLowerCase();
    const exactPhraseBoost = q && c.includes(q) ? 0.15 : 0;

    const queryTerms = q.split(/\s+/).filter((t) => t.length >= 2);
    const termMatches = queryTerms.filter((term) => c.includes(term)).length;
    const termCoverageBoost =
      queryTerms.length > 0 ? 0.1 * (termMatches / queryTerms.length) : 0;

    const fused =
      RAG_CONFIG.HYBRID_VECTOR_WEIGHT * vectorScore +
      RAG_CONFIG.HYBRID_KEYWORD_WEIGHT * normalizedKeywordScore +
      exactPhraseBoost +
      termCoverageBoost;

    return Math.min(1, fused);
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

  async ensureFullTextIndex(orgId: string): Promise<{ indexName: string; label: string }> {
    const label = this.buildOrgLabel(orgId);
    const indexName = this.buildFullTextIndexName(orgId);

    if (this.initializedFullTextIndexes.has(indexName)) return { indexName, label };

    const conn = await Neo4JConnection.getInstance();
    const session = conn.driver.session();

    try {
      await session.run(`
        CREATE FULLTEXT INDEX ${indexName} IF NOT EXISTS
        FOR (c:${label})
        ON EACH [c.content]
      `);

      this.initializedFullTextIndexes.add(indexName);
      logger?.info("Fulltext index created/verified", { indexName, label });
    } catch (error: any) {
      if (!error.message?.includes("already exists")) {
        logger?.error("VectorStore.ensureFullTextIndex failed", {
          error,
          indexName,
          label,
        });
        throw error;
      }
      this.initializedFullTextIndexes.add(indexName);
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
    const { label } = await this.ensureVectorIndex(orgId);
    await this.ensureFullTextIndex(orgId);

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
      const candidateK = Math.max(
        topK * RAG_CONFIG.HYBRID_CANDIDATE_MULTIPLIER,
        topK + 8
      );

      const { indexName } = await this.ensureVectorIndex(options.orgId);
      const { indexName: fullTextIndexName } = await this.ensureFullTextIndex(
        options.orgId
      );

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
        indexName,
        fullTextIndexName,
        topK,
        candidateK,
      });

      const sharedParams = {
        userId: options.userId,
        orgId: options.orgId,
        projectId: options.projectId ?? null,
        ...this.buildSupportedTypeQueryParams(),
      };

      const vectorResult = await session.run(
        `
        CALL db.index.vector.queryNodes('${indexName}', toInteger($candidateK), $embedding)
        YIELD node AS chunk, score
        
        MATCH (chunk)-[:CHUNK_OF]->(ef:ExternalFile)
        WHERE ef.deletedAt IS NULL
          AND (
            toLower(coalesce(ef.type, '')) IN $supportedExtensions
            OR any(mimeHint IN $supportedMimeHints WHERE toLower(coalesce(ef.type, '')) CONTAINS mimeHint)
            OR any(ext IN $supportedExtensions WHERE toLower(coalesce(ef.name, '')) ENDS WITH '.' + ext)
          )
        
        MATCH (u:User {externalId: $userId})-[:OWNS|MEMBER_OF]->(org:Organization {id: $orgId})
        MATCH (org)-[:HAS_PROJECTS]->(p:Project)
        WHERE p.deletedAt IS NULL
          AND ($projectId IS NULL OR p.id = $projectId)
          AND (
            EXISTS { MATCH (p)-[:HAS_CHILD_ITEM|HAS_CHILD_FILE|HAS_CHILD_FOLDER*1..10]->(parent)-[:HAS_ATTACHED_FILE]->(ef) }
            OR EXISTS { MATCH (p)<-[:ITEM_IN_PROJECT]-(bi:BacklogItem)-[:HAS_ATTACHED_FILE]->(ef) }
          )

        RETURN chunk.id AS chunkId,
               chunk.content AS content,
               score AS vectorScore,
               ef.name AS source,
               chunk.pageNumber AS pageNumber,
               ef.id AS documentId
        ORDER BY vectorScore DESC
        LIMIT toInteger($candidateK)
        `,
        {
          ...sharedParams,
          embedding: properEmbedding,
          candidateK,
        }
      );

      let keywordResult;
      try {
        keywordResult = await session.run(
          `
        CALL db.index.fulltext.queryNodes('${fullTextIndexName}', $fullTextQuery, {limit: toInteger($candidateK)})
        YIELD node AS chunk, score AS keywordScore

        MATCH (chunk)-[:CHUNK_OF]->(ef:ExternalFile)
        WHERE ef.deletedAt IS NULL
          AND (
            toLower(coalesce(ef.type, '')) IN $supportedExtensions
            OR any(mimeHint IN $supportedMimeHints WHERE toLower(coalesce(ef.type, '')) CONTAINS mimeHint)
            OR any(ext IN $supportedExtensions WHERE toLower(coalesce(ef.name, '')) ENDS WITH '.' + ext)
          )

        MATCH (u:User {externalId: $userId})-[:OWNS|MEMBER_OF]->(org:Organization {id: $orgId})
        MATCH (org)-[:HAS_PROJECTS]->(p:Project)
        WHERE p.deletedAt IS NULL
          AND ($projectId IS NULL OR p.id = $projectId)
          AND (
            EXISTS { MATCH (p)-[:HAS_CHILD_ITEM|HAS_CHILD_FILE|HAS_CHILD_FOLDER*1..10]->(parent)-[:HAS_ATTACHED_FILE]->(ef) }
            OR EXISTS { MATCH (p)<-[:ITEM_IN_PROJECT]-(bi:BacklogItem)-[:HAS_ATTACHED_FILE]->(ef) }
          )

        RETURN chunk.id AS chunkId,
               chunk.content AS content,
               keywordScore,
               ef.name AS source,
               chunk.pageNumber AS pageNumber,
               ef.id AS documentId
        ORDER BY keywordScore DESC
        LIMIT toInteger($candidateK)
        `,
          {
            ...sharedParams,
            fullTextQuery: this.buildHybridFullTextQuery(query),
            candidateK,
          }
        );
      } catch (keywordError) {
        logger?.warn("VectorStore.searchSimilar keyword search failed, falling back to vector-only", {
          error: keywordError,
        });
        keywordResult = { records: [] };
      }

      type HybridCandidate = {
        chunkId: string;
        content: string;
        source: string;
        pageNumber: number;
        documentId: string;
        vectorScore: number;
        keywordScore: number;
      };

      const candidates = new Map<string, HybridCandidate>();

      for (const record of vectorResult.records) {
        const chunkId = record.get("chunkId") as string;
        candidates.set(chunkId, {
          chunkId,
          content: record.get("content"),
          source: record.get("source"),
          pageNumber: record.get("pageNumber"),
          documentId: record.get("documentId"),
          vectorScore: Number(record.get("vectorScore") ?? 0),
          keywordScore: 0,
        });
      }

      for (const record of keywordResult.records) {
        const chunkId = record.get("chunkId") as string;
        const existing = candidates.get(chunkId);
        const keywordScore = Number(record.get("keywordScore") ?? 0);
        if (existing) {
          existing.keywordScore = Math.max(existing.keywordScore, keywordScore);
          continue;
        }

        candidates.set(chunkId, {
          chunkId,
          content: record.get("content"),
          source: record.get("source"),
          pageNumber: record.get("pageNumber"),
          documentId: record.get("documentId"),
          vectorScore: 0,
          keywordScore,
        });
      }

      const maxKeywordScore = Math.max(
        1,
        ...Array.from(candidates.values()).map((c) => c.keywordScore)
      );

      const fused = Array.from(candidates.values())
        .map((candidate) => {
          const normalizedKeywordScore = candidate.keywordScore / maxKeywordScore;
          const score = this.computeHybridScore(
            query,
            candidate.content,
            candidate.vectorScore,
            normalizedKeywordScore
          );

          return {
            content: candidate.content,
            score,
            source: candidate.source,
            pageNumber: candidate.pageNumber,
            documentId: candidate.documentId,
          };
        })
        .sort((a, b) => b.score - a.score);

      const filtered = fused.filter((r) => r.score >= minScore);
      const finalResults = (filtered.length > 0 ? filtered : fused).slice(0, topK);

      logger?.info("VectorStore.searchSimilar hybrid results", {
        vectorCandidates: vectorResult.records.length,
        keywordCandidates: keywordResult.records.length,
        mergedCandidates: fused.length,
        returnedResults: finalResults.length,
      });

      return finalResults.map((record) => ({
        content: record.content,
        score: record.score,
        source: record.source,
        pageNumber: record.pageNumber,
        documentId: record.documentId,
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
    userId: string,
    orgId: string,
    projectId?: string
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
        MATCH (u:User {externalId: $userId})-[:OWNS|MEMBER_OF]->(org:Organization {id: $orgId})
        MATCH (org)-[:HAS_PROJECTS]->(p:Project)
        WHERE p.deletedAt IS NULL AND ($projectId IS NULL OR p.id = $projectId)

        CALL {
          WITH p
          MATCH (parent)-[:HAS_ATTACHED_FILE]->(ef:ExternalFile)
          WHERE ef.deletedAt IS NULL
            AND (
              toLower(coalesce(ef.type, '')) IN $supportedExtensions
              OR any(mimeHint IN $supportedMimeHints WHERE toLower(coalesce(ef.type, '')) CONTAINS mimeHint)
              OR any(ext IN $supportedExtensions WHERE toLower(coalesce(ef.name, '')) ENDS WITH '.' + ext)
            )
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
        {
          userId,
          orgId,
          projectId: projectId ?? null,
          ...this.buildSupportedTypeQueryParams(),
        }
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
