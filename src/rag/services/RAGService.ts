import { v4 as uuidv4 } from "uuid";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import { Neo4JConnection } from "../../database/connection";
import logger from "../../logger";
import {
  Conversation,
  ConversationMessage,
  DiagramListItem,
  IngestionResponse,
  RAG_CONFIG,
  RAGChatResponse,
  RAGSource,
  ToolCallResult,
} from "../types/rag.types";
import { DiagramIndexService } from "./DiagramIndexService";
import { DiagramService } from "./DiagramService";
import { EmbeddingServiceFactory } from "./EmbeddingServiceFactory";
import { EmbeddingService } from "./EmbeddingService";
import { PDFProcessor } from "./PDFProcessor";
import { VectorStore } from "./VectorStore";

// ─── System Prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT_TEMPLATE = `You are an intelligent project assistant with access to both project documents (PDFs) and project diagrams/flowcharts.

You have tools to retrieve information. Use them as needed:
- **search_documents**: Search PDF documents attached to the project for text-based information (specifications, reports, requirements, etc.)
- **get_diagram_context**: Retrieve the full structure of a specific diagram/flowchart by its file ID. Use when the user asks about processes, workflows, relationships between steps, or visual diagrams.

AVAILABLE DIAGRAMS IN THIS PROJECT:
{DIAGRAM_LIST}

Guidelines:
1. Use tools when the user's question requires information from documents or diagrams. You may call both tools if the question spans both.
2. If the user mentions a specific diagram by name, use get_diagram_context with the matching file ID from the list above.
3. If the question is about a process/workflow and you're not sure which diagram, use get_diagram_context with a search query to find the right one.
4. When you have diagram data, explain the flowchart structure, relationships, and processes clearly.
5. Be concise and accurate. Cite sources (document names, diagram names) when possible.
6. If context is insufficient, say so — do not make up information.
7. For conversational messages (greetings, clarifications), respond directly without tools.`;

// ─── Tool Definitions ─────────────────────────────────────────────────────────

const TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "search_documents",
      description:
        "Search project PDF documents for text-based information. Use for specifications, reports, requirements, meeting notes, or any textual content in attached documents.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "The search query describing what information you need from the documents.",
          },
          topK: {
            type: "number",
            description:
              "Maximum number of relevant chunks to retrieve (default: 5).",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_diagram_context",
      description:
        "Retrieve the full structure of a project diagram/flowchart. Returns nodes, connections, groups, and a Mermaid representation. Use when the user asks about processes, workflows, flowcharts, or relationships between steps. You can provide either a fileId (from the diagram list) or a search query to find the most relevant diagram.",
      parameters: {
        type: "object",
        properties: {
          fileId: {
            type: "string",
            description:
              "The exact file ID of the diagram to retrieve (from the available diagrams list). Use when you know which diagram the user is referring to.",
          },
          query: {
            type: "string",
            description:
              "A search query to find the most relevant diagram (e.g. 'order processing flow'). Used when the user's question doesn't reference a specific diagram by name.",
          },
        },
      },
    },
  },
];

export class RAGService {
  private static instance: RAGService;
  private service: EmbeddingService; // Unified: ngrok embeddings + Groq chat
  private pdfProcessor: PDFProcessor;
  private vectorStore: VectorStore;
  private diagramService: DiagramService;
  private diagramIndexService: DiagramIndexService;
  private conversations: Map<string, Conversation> = new Map();

  private constructor() {
    this.service = EmbeddingService.getInstance();
    this.pdfProcessor = PDFProcessor.getInstance();
    this.vectorStore = VectorStore.getInstance();
    this.diagramService = DiagramService.getInstance();
    this.diagramIndexService = DiagramIndexService.getInstance();
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

      // ── 1. Build system prompt with diagram list injected directly ────
      const diagramList = await this.diagramService.listProjectDiagrams(
        projectId,
        userId,
        orgId
      );
      const diagramListText =
        this.diagramService.serializeDiagramList(diagramList);
      const systemPrompt = SYSTEM_PROMPT_TEMPLATE.replace(
        "{DIAGRAM_LIST}",
        diagramListText
      );

      // ── 2. Manage conversation ───────────────────────────────────────
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

      // Build message history for Groq
      const historyMessages: ChatCompletionMessageParam[] = conversation.messages
        .slice(-10)
        .map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        }));

      // ── 3. First LLM call — let model decide which tools to call ─────
      console.log("\n" + "=".repeat(80));
      console.log("🤖 RAG CHAT: Making LLM call with tools");
      console.log("=".repeat(80));
      console.log(`User Query: ${message}`);
      console.log(`Available Tools: ${TOOLS.map(t => t.function.name).join(", ")}`);
      console.log("=".repeat(80) + "\n");
      
      logger?.info("RAGService: Making first LLM call with tools", {
        systemPromptLength: systemPrompt.length,
        historyCount: historyMessages.length,
        toolsAvailable: TOOLS.map(t => t.function.name),
      });
      
      const firstResponse = await this.service.chatWithTools(
        systemPrompt,
        historyMessages,
        TOOLS
      );

      console.log("\n" + "=".repeat(80));
      console.log("✅ LLM RESPONSE RECEIVED");
      console.log("=".repeat(80));
      if (firstResponse.toolCalls && firstResponse.toolCalls.length > 0) {
        console.log(`🛠️  Tool Calls Requested: ${firstResponse.toolCalls.length}`);
        firstResponse.toolCalls.forEach((tc, i) => {
          console.log(`   ${i + 1}. ${tc.functionName}`);
          console.log(`      Args: ${tc.arguments}`);
        });
      } else {
        console.log("💬 Direct response (no tools used)");
        console.log(`   Content: ${firstResponse.content?.substring(0, 150)}...`);
      }
      console.log("=".repeat(80) + "\n");
      
      logger?.info("RAGService: First LLM response received", {
        hasToolCalls: !!firstResponse.toolCalls,
        toolCallsCount: firstResponse.toolCalls?.length ?? 0,
        toolNames: firstResponse.toolCalls?.map(tc => tc.functionName) ?? [],
        directContent: firstResponse.content?.substring(0, 100),
      });

      let finalContent: string;
      let tokensUsed = firstResponse.tokensUsed;
      const allSources: RAGSource[] = [];
      let chunksUsed = 0;

      if (firstResponse.toolCalls && firstResponse.toolCalls.length > 0) {
        // ── 4. Execute tool calls in parallel ──────────────────────────
        logger?.info("RAGService: Executing tool calls", {
          toolCalls: firstResponse.toolCalls.map(tc => ({
            function: tc.functionName,
            arguments: tc.arguments,
          })),
        });
        
        const toolResults = await Promise.all(
          firstResponse.toolCalls.map((tc) =>
            this.executeToolCall(
              tc.functionName,
              tc.arguments,
              projectId,
              userId,
              orgId,
              effectiveMaxChunks,
              diagramList,
              allSources
            )
          )
        );

        logger?.info("RAGService: Tool calls executed", {
          resultsCount: toolResults.length,
          sourcesFound: allSources.length,
        });

        console.log("\n" + "=".repeat(80));
        console.log("✅ TOOL EXECUTION COMPLETED");
        console.log("=".repeat(80));
        console.log(`Sources Found: ${allSources.length}`);
        allSources.forEach((src, i) => {
          console.log(`   ${i + 1}. ${src.documentName} (score: ${(src.relevanceScore * 100).toFixed(1)}%)`);
        });
        console.log("=".repeat(80) + "\n");

        chunksUsed = allSources.length;

        // ── 5. Second LLM call — model produces answer with tool results
        const toolCallIds = firstResponse.toolCalls.map((tc) => tc.id);
        const finalResponse =
          await this.service.continueWithToolResults(
            systemPrompt,
            historyMessages,
            firstResponse.assistantMessage,
            toolResults,
            toolCallIds
          );

        logger?.info("RAGService: Final LLM response received", {
          contentLength: finalResponse.content.length,
          contentPreview: finalResponse.content.substring(0, 200),
          tokensUsed: finalResponse.tokensUsed,
        });

        console.log("\n" + "=".repeat(80));
        console.log("🎯 FINAL ANSWER GENERATED");
        console.log("=".repeat(80));
        console.log(finalResponse.content);
        console.log("=".repeat(80));
        console.log(`Tokens Used: ${tokensUsed}, Processing Time: ${Date.now() - startTime}ms`);
        console.log("=".repeat(80) + "\n");

        finalContent = finalResponse.content;
        tokensUsed += finalResponse.tokensUsed;
      } else {
        // Model answered directly without tools
        logger?.info("RAGService: Model answered directly without tools", {
          contentLength: firstResponse.content?.length ?? 0,
          contentPreview: firstResponse.content?.substring(0, 200),
        });
        finalContent = firstResponse.content ?? "";
      }

      // ── 6. Store response & return ───────────────────────────────────
      conversation.messages.push({
        role: "assistant",
        content: finalContent,
        timestamp: new Date(),
      });
      conversation.updatedAt = new Date();

      logger?.info("RAGService.chat completed successfully", {
        answerLength: finalContent.length,
        sourcesCount: allSources.length,
        tokensUsed,
        processingTimeMs: Date.now() - startTime,
      });

      return {
        answer: finalContent,
        sources: allSources,
        conversationId: convId,
        metadata: {
          model: RAG_CONFIG.CHAT_MODEL,
          chunksUsed,
          processingTimeMs: Date.now() - startTime,
          tokensUsed,
        },
      };
    } catch (error) {
      logger?.error("RAGService.chat failed", { error, projectId, userId });
      throw error;
    }
  }

  // ─── Tool Execution ──────────────────────────────────────────────────────

  private async executeToolCall(
    functionName: string,
    argumentsJson: string,
    projectId: string,
    userId: string,
    orgId: string,
    maxChunks: number,
    diagramList: DiagramListItem[],
    sourcesAccumulator: RAGSource[]
  ): Promise<ToolCallResult> {
    try {
      const args = JSON.parse(argumentsJson);

      switch (functionName) {
        case "search_documents":
          return this.toolSearchDocuments(
            args.query,
            projectId,
            userId,
            orgId,
            args.topK ?? maxChunks,
            sourcesAccumulator
          );

        case "get_diagram_context":
          return this.toolGetDiagramContext(
            projectId,
            userId,
            orgId,
            diagramList,
            args.fileId,
            args.query,
            sourcesAccumulator
          );

        default:
          return {
            toolName: functionName,
            content: `Unknown tool: ${functionName}`,
          };
      }
    } catch (error: any) {
      logger?.error("RAGService.executeToolCall failed", {
        functionName,
        error,
      });
      return {
        toolName: functionName,
        content: `Error executing ${functionName}: ${error.message}`,
      };
    }
  }

  private async toolSearchDocuments(
    query: string,
    projectId: string,
    userId: string,
    orgId: string,
    topK: number,
    sourcesAccumulator: RAGSource[]
  ): Promise<ToolCallResult> {
    const searchResults = await this.vectorStore.searchSimilar(query, {
      projectId,
      userId,
      orgId,
      topK,
    });

    // Accumulate sources for the response
    for (const r of searchResults) {
      sourcesAccumulator.push({
        documentId: r.documentId,
        documentName: r.source,
        pageNumber: r.pageNumber,
        relevanceScore: r.score,
        snippet: r.content.slice(0, 200) + "...",
      });
    }

    if (searchResults.length === 0) {
      return {
        toolName: "search_documents",
        content:
          "No relevant document chunks found for this query. The project may not have any PDF documents ingested yet, or the query may not match any content.",
      };
    }

    const context = searchResults
      .map(
        (r, i) =>
          `[Document Source ${i + 1}: "${r.source}", Page ${r.pageNumber}, Relevance: ${(r.score * 100).toFixed(1)}%]\n${r.content}`
      )
      .join("\n\n---\n\n");

    return { toolName: "search_documents", content: context };
  }

  private async toolGetDiagramContext(
    projectId: string,
    userId: string,
    orgId: string,
    diagramList: DiagramListItem[],
    fileId?: string,
    query?: string,
    sourcesAccumulator?: RAGSource[]
  ): Promise<ToolCallResult> {
    let targetFileId = fileId;

    // If no fileId, use query to search diagram summaries
    if (!targetFileId && query) {
      const searchResults = await this.diagramIndexService.searchDiagrams(
        query,
        orgId,
        projectId,
        userId,
        3
      );

      if (searchResults.length > 0) {
        targetFileId = searchResults[0]!.fileId;

        // If multiple diagrams are relevant, include that info
        if (searchResults.length > 1) {
          const otherMatches = searchResults
            .slice(1)
            .map(
              (r) =>
                `"${r.fileName}" (fileId: ${r.fileId}, relevance: ${(r.score * 100).toFixed(1)}%)`
            )
            .join(", ");

          logger?.info(
            "DiagramService: multiple diagrams matched, using best match",
            { targetFileId, otherMatches }
          );
        }
      }
    }

    // If still no fileId and there's only 1 diagram, use it
    if (!targetFileId && diagramList.length === 1) {
      targetFileId = diagramList[0]!.fileId;
    }

    if (!targetFileId) {
      return {
        toolName: "get_diagram_context",
        content:
          "Could not determine which diagram to retrieve. Please specify the diagram name or try a more specific query. Available diagrams are listed in the system prompt.",
      };
    }

    // Fetch full diagram structure (always live from Neo4j)
    const diagramData = await this.diagramService.fetchDiagramData(
      targetFileId,
      projectId,
      userId,
      orgId
    );

    if (!diagramData || diagramData.nodes.length === 0) {
      return {
        toolName: "get_diagram_context",
        content: `Diagram with fileId "${targetFileId}" not found or has no nodes.`,
      };
    }

    // Add diagram as a source
    sourcesAccumulator?.push({
      documentId: targetFileId,
      documentName: diagramData.fileName,
      pageNumber: 0,
      relevanceScore: 1.0,
      snippet: `Diagram: ${diagramData.nodes.length} nodes, ${diagramData.edges.length} edges, ${diagramData.groups.length} groups`,
    });

    // Serialize to LLM-friendly format
    const serialized = this.diagramService.serializeForLLM(diagramData);
    return { toolName: "get_diagram_context", content: serialized };
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

  // ─── Diagram Indexing ────────────────────────────────────────────────────

  /**
   * Index a single diagram's summary for semantic search.
   */
  async indexDiagram(
    fileId: string,
    projectId: string,
    userId: string
  ) {
    const orgId = await this.resolveOrgIdForProject(projectId, userId);
    return this.diagramIndexService.indexDiagram(
      fileId,
      projectId,
      userId,
      orgId
    );
  }

  /**
   * Index all un-indexed diagrams in a project.
   */
  async indexProjectDiagrams(
    projectId: string,
    userId: string
  ) {
    const orgId = await this.resolveOrgIdForProject(projectId, userId);
    return this.diagramIndexService.indexProjectDiagrams(
      projectId,
      userId,
      orgId
    );
  }

  /**
   * Delete diagram summary embedding (e.g. when diagram file is deleted).
   */
  async deleteDiagramIndex(fileId: string) {
    return this.diagramIndexService.deleteDiagramSummary(fileId);
  }

  /**
   * List all diagrams in a project with their indexing status.
   */
  async listProjectDiagrams(projectId: string, userId: string) {
    const orgId = await this.resolveOrgIdForProject(projectId, userId);
    return this.diagramService.listProjectDiagrams(projectId, userId, orgId);
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
