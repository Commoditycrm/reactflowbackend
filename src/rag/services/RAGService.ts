import { v4 as uuidv4 } from "uuid";
import { Neo4JConnection } from "../../database/connection";
import logger from "../../logger";
import {
  Conversation,
  ConversationMessage,
  IngestionResponse,
  RAG_CONFIG,
  RAGChatResponse,
  RAGSource,
} from "../types/rag.types";
import { EmbeddingService } from "./EmbeddingService";
import { PDFProcessor } from "./PDFProcessor";
import { VectorStore } from "./VectorStore";

const RAG_SYSTEM_PROMPT = `You are a helpful assistant that answers questions based on the provided document context.
Follow these guidelines:
1. Only answer based on the provided context. If the context doesn't contain relevant information, say so.
2. Be concise and accurate.
3. If you reference specific information, mention the source document when possible.
4. If the question is unclear, ask for clarification.
5. Do not make up information that is not in the context.`;

export class RAGService {
  private static instance: RAGService;
  private embeddingService: EmbeddingService;
  private pdfProcessor: PDFProcessor;
  private vectorStore: VectorStore;
  private conversations: Map<string, Conversation> = new Map();

  private constructor() {
    this.embeddingService = EmbeddingService.getInstance();
    this.pdfProcessor = PDFProcessor.getInstance();
    this.vectorStore = VectorStore.getInstance();
  }

  static getInstance(): RAGService {
    if (!RAGService.instance) RAGService.instance = new RAGService();
    return RAGService.instance;
  }

  private async resolveOrgIdForProject(
    projectId: string,
    userId: string
  ): Promise<string> {
    const conn = await Neo4JConnection.getInstance();
    const session = conn.driver.session();

    try {
      const res = await session.run(
        `
        MATCH (u:User {externalId: $userId})-[:OWNS|MEMBER_OF]->(org:Organization)
        MATCH (org)-[:HAS_PROJECTS]->(p:Project {id: $projectId})
        WHERE p.deletedAt IS NULL
        RETURN org.id AS orgId
        `,
        { projectId, userId }
      );

      const orgId = res.records[0]?.get("orgId") as string | undefined;
      if (!orgId) {
        throw new Error("Project not found or access denied");
      }
      return orgId;
    } finally {
      await session.close();
    }
  }

  async ingestDocument(
    externalFileId: string,
    userId: string,
    forceReprocess = false
  ): Promise<IngestionResponse> {
    const startTime = Date.now();

    try {
      const conn = await Neo4JConnection.getInstance();
      const session = conn.driver.session();

      let documentInfo: { url: string; name: string; type: string; orgId: string } | null =
        null;

      try {
        const result = await session.run(
          `
          MATCH (u:User {externalId: $userId})-[:OWNS|MEMBER_OF]->(org:Organization)
          MATCH (ef:ExternalFile {id: $externalFileId, type: 'PDF'})
          WHERE EXISTS {
            MATCH (org)-[:HAS_PROJECTS]->(p:Project)
            WHERE p.deletedAt IS NULL
            AND (
              EXISTS { MATCH (p)-[:HAS_CHILD_ITEM|HAS_CHILD_FILE|HAS_CHILD_FOLDER*1..10]->(parent)-[:HAS_ATTACHED_FILE]->(ef) }
              OR EXISTS { MATCH (p)<-[:ITEM_IN_PROJECT]-(bi:BacklogItem)-[:HAS_ATTACHED_FILE]->(ef) }
            )
          }
          RETURN ef.url AS url, ef.name AS name, ef.type AS type, org.id AS orgId
          `,
          { userId, externalFileId }
        );

        if (result.records.length === 0) {
          throw new Error("Document not found or access denied");
        }

        const record = result.records[0];
        if (!record) {
          throw new Error("Document not found or access denied");
        }

        documentInfo = {
          url: record.get("url") as string,
          name: record.get("name") as string,
          type: record.get("type") as string,
          orgId: record.get("orgId") as string,
        };
      } finally {
        await session.close();
      }

      if (forceReprocess) {
        await this.vectorStore.deleteChunksForDocument(externalFileId);
      } else {
        const existingChunks =
          await this.vectorStore.getDocumentChunkCount(externalFileId);
        if (existingChunks > 0) {
          return {
            success: true,
            documentId: externalFileId,
            chunksCreated: existingChunks,
            processingTimeMs: Date.now() - startTime,
          };
        }
      }

      const chunks = await this.pdfProcessor.processDocument(documentInfo.url);
      const storedCount = await this.vectorStore.storeChunks(
        chunks,
        externalFileId,
        documentInfo.orgId
      );

      logger?.info("RAGService.ingestDocument completed", {
        externalFileId,
        chunksCreated: storedCount,
        processingTimeMs: Date.now() - startTime,
      });

      return {
        success: true,
        documentId: externalFileId,
        chunksCreated: storedCount,
        processingTimeMs: Date.now() - startTime,
      };
    } catch (error: any) {
      logger?.error("RAGService.ingestDocument failed", {
        error,
        externalFileId,
      });

      return {
        success: false,
        documentId: externalFileId,
        chunksCreated: 0,
        processingTimeMs: Date.now() - startTime,
        error: error.message,
      };
    }
  }

  async chat(
    message: string,
    projectId: string,
    userId: string,
    conversationId?: string,
    maxChunks?: number
  ): Promise<RAGChatResponse> {
    const startTime = Date.now();
    const effectiveMaxChunks = maxChunks ?? RAG_CONFIG.MAX_CONTEXT_CHUNKS;

    try {
      const orgId = await this.resolveOrgIdForProject(projectId, userId);
      const searchResults = await this.vectorStore.searchSimilar(message, {
        projectId,
        userId,
        orgId,
        topK: effectiveMaxChunks,
      });

      const context = searchResults
        .map(
          (r, i) =>
            `[Source ${i + 1}: ${r.source}, Page ${r.pageNumber}]\n${r.content}`
        )
        .join("\n\n---\n\n");

      const convId = conversationId || uuidv4();
      let conversation = this.conversations.get(convId);

      if (!conversation) {
        conversation = {
          id: convId,
          userId,
          projectId,
          messages: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        this.conversations.set(convId, conversation);
      }

      conversation.messages.push({
        role: "user",
        content: message,
        timestamp: new Date(),
      });

      const historyMessages = conversation.messages.slice(-10).map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

      const { content, tokensUsed } =
        await this.embeddingService.generateChatCompletionWithHistory(
          RAG_SYSTEM_PROMPT,
          historyMessages,
          context
        );

      conversation.messages.push({
        role: "assistant",
        content,
        timestamp: new Date(),
      });
      conversation.updatedAt = new Date();

      const sources: RAGSource[] = searchResults.map((r) => ({
        documentId: r.documentId,
        documentName: r.source,
        pageNumber: r.pageNumber,
        relevanceScore: r.score,
        snippet: r.content.slice(0, 200) + "...",
      }));

      return {
        answer: content,
        sources,
        conversationId: convId,
        metadata: {
          model: RAG_CONFIG.CHAT_MODEL,
          chunksUsed: searchResults.length,
          processingTimeMs: Date.now() - startTime,
          tokensUsed,
        },
      };
    } catch (error) {
      logger?.error("RAGService.chat failed", { error, projectId, userId });
      throw error;
    }
  }

  async searchDocuments(
    query: string,
    projectId: string,
    userId: string,
    topK?: number
  ): Promise<RAGSource[]> {
    const effectiveTopK = topK ?? RAG_CONFIG.MAX_CONTEXT_CHUNKS;
    try {
      const orgId = await this.resolveOrgIdForProject(projectId, userId);
      const results = await this.vectorStore.searchSimilar(query, {
        projectId,
        userId,
        orgId,
        topK: effectiveTopK,
      });

      return results.map((r) => ({
        documentId: r.documentId,
        documentName: r.source,
        pageNumber: r.pageNumber,
        relevanceScore: r.score,
        snippet: r.content.slice(0, 300) + "...",
      }));
    } catch (error) {
      logger?.error("RAGService.searchDocuments failed", { error });
      throw error;
    }
  }

  getConversation(conversationId: string): Conversation | undefined {
    return this.conversations.get(conversationId);
  }

  getConversationsForProject(
    projectId: string,
    userId: string,
    limit = 10
  ): Conversation[] {
    const conversations: Conversation[] = [];

    for (const conv of this.conversations.values()) {
      if (conv.projectId === projectId && conv.userId === userId) {
        conversations.push(conv);
      }
    }

    return conversations
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, limit);
  }

  clearConversation(conversationId: string): boolean {
    return this.conversations.delete(conversationId);
  }

  async getDocumentStatuses(projectId: string, userId: string) {
    return this.vectorStore.getProjectDocumentStatuses(projectId, userId);
  }

  async ingestProjectDocuments(
    projectId: string,
    userId: string
  ): Promise<{ total: number; successful: number; failed: number; skipped: number }> {
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
        WITH ef, count(chunk) AS chunkCount
        RETURN ef.id AS documentId, chunkCount > 0 AS isEmbedded
        `,
        { userId, projectId }
      );

      let successful = 0;
      let failed = 0;
      let skipped = 0;
      const totalDocs = result.records.length;

      for (const record of result.records) {
        const docId = record.get("documentId");
        const isEmbedded = record.get("isEmbedded");

        if (isEmbedded) {
          skipped++;
          logger?.info("RAGService.ingestProjectDocuments: Skipping already embedded document", { documentId: docId });
          continue;
        }

        const response = await this.ingestDocument(docId, userId);
        if (response.success) {
          successful++;
        } else {
          failed++;
        }
      }

      logger?.info("RAGService.ingestProjectDocuments completed", {
        projectId,
        total: totalDocs,
        successful,
        failed,
        skipped,
      });

      return { total: totalDocs, successful, failed, skipped };
    } finally {
      await session.close();
    }
  }

  /**
   * TODO: Triggering it.
   * Possible trigger points:
   * - When ExternalFile.deletedAt is set (soft delete)
   * - When attachment is removed from BacklogItem
   * - Manual 
   * - Scheduled cleanup job for orphaned chunks
   * Accidental deletion = costly re-embedding
   */
  async deleteDocumentEmbeddings(
    externalFileId: string,
    userId: string
  ): Promise<{ success: boolean; chunksDeleted: number; error?: string }> {
    try {
      const conn = await Neo4JConnection.getInstance();
      const session = conn.driver.session();

      try {
        const accessCheck = await session.run(
          `
          MATCH (u:User {externalId: $userId})-[:OWNS|MEMBER_OF]->(org:Organization)
          MATCH (org)-[:HAS_PROJECTS]->(p:Project)
          MATCH (ef:ExternalFile {id: $externalFileId})
          WHERE p.deletedAt IS NULL
            AND (
              EXISTS { MATCH (p)-[:HAS_CHILD_ITEM|HAS_CHILD_FILE|HAS_CHILD_FOLDER*1..10]->(parent)-[:HAS_ATTACHED_FILE]->(ef) }
              OR EXISTS { MATCH (p)<-[:ITEM_IN_PROJECT]-(bi:BacklogItem)-[:HAS_ATTACHED_FILE]->(ef) }
            )
          RETURN ef.id AS fileId
          `,
          { userId, externalFileId }
        );

        if (accessCheck.records.length === 0) {
          throw new Error("Document not found or access denied");
        }
      } finally {
        await session.close();
      }

      const chunksDeleted = await this.vectorStore.deleteChunksForDocument(externalFileId);

      logger?.info("RAGService.deleteDocumentEmbeddings completed", {
        externalFileId,
        chunksDeleted,
      });

      return { success: true, chunksDeleted };
    } catch (error: any) {
      logger?.error("RAGService.deleteDocumentEmbeddings failed", {
        error,
        externalFileId,
      });

      return {
        success: false,
        chunksDeleted: 0,
        error: error.message,
      };
    }
  }
}
