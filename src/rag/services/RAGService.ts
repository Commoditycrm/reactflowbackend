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
  SUPPORTED_DOCUMENT_EXTENSIONS,
  SUPPORTED_DOCUMENT_MIME_HINTS,
  ToolCallResult,
} from "../types/rag.types";
import { DiagramIndexService } from "./DiagramIndexService";
import { DiagramService } from "./DiagramService";
import { EmbeddingServiceFactory } from "./EmbeddingServiceFactory";
import { EmbeddingService } from "./EmbeddingService";
import { PDFProcessor } from "./PDFProcessor";
import { VectorStore } from "./VectorStore";

// ─── System Prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT_TEMPLATE = `You are an intelligent project assistant. You help users understand their projects, documents, and diagrams in clear, natural language.

You have tools to retrieve information:
- **search_documents**: Search PDF documents for text-based information.
- **get_diagram_context**: Retrieve a diagram/flowchart's structure by its file ID. Returns the full process flow, nodes, and connections so you can explain it.

{SCOPE_DESCRIPTION}

AVAILABLE DIAGRAMS (internal reference — do NOT expose file IDs, node counts, or technical metadata to the user):
{DIAGRAM_LIST}

CRITICAL RULES:
- NEVER include file IDs, node counts, edge counts, group counts, or any raw technical metadata in your responses. The user does not know what these are.
- Always respond in clear, natural language. Describe diagrams by their business meaning and purpose, not by their internal graph structure.
- Treat diagrams as project knowledge artifacts (workflows, responsibilities, entities, and decisions), not as isolated files.
- Never frame answers as "only diagram-based" or "I can only infer from diagrams." Instead, state that the explanation is based on available project artifacts.
- When asked for a project summary/overview (e.g. "summarize this project", "overall summary"), you MUST call get_diagram_context for multiple relevant diagrams (minimum 2 when available, maximum 3) before answering.
- For project summaries, synthesize by project entity/workstream (teams, processes, systems, deliverables, dependencies) rather than listing diagram titles.
- When the user asks about a broad topic, call get_diagram_context on the most relevant diagrams (you can call it multiple times) to build a comprehensive answer.
- If a user mentions a diagram by name, use get_diagram_context with the matching file ID from the internal list above.
- When you have diagram data, explain the processes, workflows, actors, and relationships in plain English from the user's project perspective.
- Cite sources by name (e.g. "Based on the Application Architecture artifact...") and treat them as evidence for project behavior, never by file ID.
- Do NOT reveal internal workflow or tool usage. Never output "Step 1", "I will retrieve", "let's examine", or similar planning text. Provide the final answer directly.
- Avoid speculative wording like "appears", "likely", "probably", "seems" unless uncertainty is explicit and unavoidable.
- Do not pad with generic limitation sections. Only mention a limitation if it materially changes the conclusion, in one concise sentence.
- For overview requests, use this concise structure: 1) Overall project/org summary, 2) Key entities/workstreams, 3) Major workflows and dependencies, 4) Suggested next drill-downs (optional).
- Do not mention internal retrieval modality failures in final answers (e.g. "not found in documents" or "let's try diagrams"). Keep responses source-agnostic and user-focused.
- If nothing relevant is found, say that no relevant sources were found for the query and suggest one concise next step.
- If evidence is weak, ask one specific follow-up question instead of giving a long hedge.
- Be thorough but concise. If context is insufficient, say so — do not make up information.
- For greetings or clarifications, respond directly without tools.`;

// ─── Tool Definitions ─────────────────────────────────────────────────────────

const TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "search_documents",
      description:
        "Search project documents for text-based information. Supports indexed PDF, TXT, Markdown, DOCX, XLSX, CSV, and JSON content.",
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

type ToolExecutionContext = {
  intent: QueryIntent;
  isOverviewRequest: boolean;
  diagramCallsSeen: number;
  diagramContextChars: number;
  usedDiagramIds: Set<string>;
};

type QueryIntent = "org_overview" | "project_overview" | "specific_question";

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

  private isGreetingOrAck(message: string): boolean {
    const text = message.trim().toLowerCase();
    return /^(hi|hello|hey|thanks|thank you|ok|okay|cool|great|sure|yep|yes|no)$/.test(
      text
    );
  }

  private sanitizeFinalAnswer(
    content: string,
    sources: RAGSource[],
    userMessage: string
  ): string {
    const normalized = content
      .replace(
        /since\s+i\s+couldn't\s+find[^\n]*?(documents?|diagrams?)[^\n]*\.?/gi,
        ""
      )
      .replace(/let'?s\s+try\s+to\s+search[^\n]*\.?/gi, "")
      .replace(/i'?ll\s+use\s+[^\n]*\s+as\s+a\s+search\s+query[^\n]*\.?/gi, "")
      .replace(/let\s+me\s+retrieve[^\n]*\.?/gi, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    const pendingRetrievalCue =
      /(which\s+diagram|if\s+you\s+want\s+i\s+can|let'?s\s+try|let\s+me\s+retrieve|i'?ll\s+use\s+.*search\s+query)/i.test(
        normalized
      );

    if (sources.length === 0 && !this.isGreetingOrAck(userMessage)) {
      if (normalized.length > 120 && !pendingRetrievalCue) {
        return normalized;
      }
      return "I couldn't find relevant sources for this query in the currently indexed project artifacts. Try rephrasing your question or specify the project area you want to explore.";
    }

    return normalized;
  }

  private shouldAutoContinueRetrieval(
    content: string | null | undefined,
    userMessage: string
  ): boolean {
    if (!content || this.isGreetingOrAck(userMessage)) return false;

    return /(which\s+diagram|if\s+you\s+want\s+i\s+can|let'?s\s+try\s+to\s+search|let\s+me\s+retrieve|i'?ll\s+use\s+.*search\s+query|continue\s+searching)/i.test(
      content
    );
  }

  private buildSourcePreviewLines(snippet?: string): string[] {
    if (!snippet) return [];

    const cleaned = snippet.replace(/\.\.\.$/, "").trim();
    if (!cleaned) return [];

    const rawLines = cleaned
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (rawLines.length > 0) {
      return rawLines.slice(0, 3).map((line) => line.slice(0, 180));
    }

    return [cleaned.slice(0, 180)];
  }

  private isOverviewStyleRequest(message: string): boolean {
    const text = message.toLowerCase();
    return /(overall|overview|summary|summarize|high[-\s]?level|organization|portfolio|all projects|projects in|across projects)/.test(
      text
    );
  }

  private classifyIntent(message: string, projectId?: string): QueryIntent {
    const isOverview = this.isOverviewStyleRequest(message);
    if (!isOverview) return "specific_question";
    return projectId ? "project_overview" : "org_overview";
  }

  private getAdaptiveDiagramContextCharLimit(diagramCallsSeen: number): number {
    if (diagramCallsSeen <= 1) return 15000;
    if (diagramCallsSeen === 2) return 7000;
    return 5000;
  }

  private async buildOrgOverviewEvidence(
    message: string,
    orgId: string,
    userId: string,
    diagramList: DiagramListItem[]
  ): Promise<{ context: string; sources: RAGSource[] }> {
    const sources: RAGSource[] = [];
    const diagramMap = new Map<string, { fileName: string; score: number; summary: string }>();

    const candidateQueries = [
      message,
      "organization overview architecture workflows dependencies systems teams deliverables",
    ];

    for (const q of candidateQueries) {
      try {
        const hits = await this.diagramIndexService.searchDiagrams(
          q,
          orgId,
          userId,
          12
        );
        for (const hit of hits) {
          const existing = diagramMap.get(hit.fileId);
          if (!existing || hit.score > existing.score) {
            diagramMap.set(hit.fileId, {
              fileName: hit.fileName,
              score: hit.score,
              summary: hit.summary,
            });
          }
        }
      } catch (error) {
        logger?.warn("RAGService: org overview diagram summary search failed", {
          query: q,
          error,
        });
      }
    }

    const rankedDiagramSummaries = Array.from(diagramMap.entries())
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, 12);

    const diagramListMap = new Map(diagramList.map((d) => [d.fileId, d]));
    const diagramSummaryContext = rankedDiagramSummaries
      .map(([fileId, item], index) => {
        const meta = diagramListMap.get(fileId);
        sources.push({
          documentId: fileId,
          documentName: item.fileName,
          pageNumber: 0,
          relevanceScore: item.score,
          snippet: item.summary.slice(0, 240),
        });

        const projectSuffix = meta?.projectName ? ` [Project: ${meta.projectName}]` : "";
        return `[Diagram Summary ${index + 1}] ${item.fileName}${projectSuffix}\nRelevance: ${(item.score * 100).toFixed(1)}%\n${item.summary}`;
      })
      .join("\n\n---\n\n");

    const docResults = await this.vectorStore.searchSimilar(message, {
      orgId,
      userId,
      projectId: undefined,
      topK: 4,
    });

    const docContext = docResults
      .map((doc, index) => {
        sources.push({
          documentId: doc.documentId,
          documentName: doc.source,
          pageNumber: doc.pageNumber,
          relevanceScore: doc.score,
          snippet: doc.content.slice(0, 240),
        });
        return `[Document Evidence ${index + 1}] ${doc.source} (Page ${doc.pageNumber}, Relevance: ${(doc.score * 100).toFixed(1)}%)\n${doc.content}`;
      })
      .join("\n\n---\n\n");

    const sections: string[] = [];
    if (diagramSummaryContext) {
      sections.push(`## Diagram Summary Evidence\n${diagramSummaryContext}`);
    }
    if (docContext) {
      sections.push(`## Supporting Document Evidence\n${docContext}`);
    }

    const context = this.truncateContext(sections.join("\n\n"), 22000);
    return { context, sources };
  }

  private isToolUseFailedError(error: any): boolean {
    return (
      error?.status === 400 &&
      (error?.code === "tool_use_failed" ||
        error?.error?.code === "tool_use_failed")
    );
  }

  private isLikelyValidDiagramId(fileId?: string): boolean {
    if (!fileId) return false;
    const normalized = fileId.trim();
    if (!normalized) return false;
    if (/https?:\/\//i.test(normalized)) return false;
    if (/\s/.test(normalized)) return false;
    return /^[a-zA-Z0-9-]{8,}$/.test(normalized);
  }

  private truncateContext(content: string, maxChars: number): string {
    if (content.length <= maxChars) return content;
    return `${content.slice(0, maxChars)}\n\n[Context truncated to fit token budget]`;
  }

  private buildFallbackDiagramSummary(
    fileName: string,
    nodeCount: number,
    edgeCount: number,
    groupCount: number
  ): string {
    return [
      `## Diagram: "${fileName}"`,
      "",
      "### High-Level Structure:",
      `- Nodes: ${nodeCount}, Relationships: ${edgeCount}, Groups: ${groupCount}`,
      "- Detailed graph content omitted due to context budget limits.",
    ].join("\n");
  }

  private extractRequestedDiagramIds(
    toolCalls: Array<{ functionName: string; arguments: string }>
  ): Set<string> {
    const ids = new Set<string>();

    for (const tc of toolCalls) {
      if (tc.functionName !== "get_diagram_context") continue;
      try {
        const parsed = JSON.parse(tc.arguments ?? "{}");
        if (typeof parsed?.fileId === "string" && parsed.fileId.trim()) {
          ids.add(parsed.fileId.trim());
        }
      } catch {
        // Ignore malformed tool args here; tool execution path handles errors.
      }
    }

    return ids;
  }

  private looksLikeToolPlanOutput(content: string): boolean {
    const text = content.trim();
    if (!text) return false;

    return (
      /^\s*\[\s*\{[\s\S]*"name"\s*:\s*"[a-z_]+"[\s\S]*\}\s*\]\s*$/i.test(
        text
      ) ||
      /"parameters"\s*:\s*\{/i.test(text)
    );
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
          MATCH (ef:ExternalFile {id: $externalFileId})
          WHERE ef.deletedAt IS NULL
            AND (
              toLower(coalesce(ef.type, '')) IN $supportedExtensions
              OR any(mimeHint IN $supportedMimeHints WHERE toLower(coalesce(ef.type, '')) CONTAINS mimeHint)
              OR any(ext IN $supportedExtensions WHERE toLower(coalesce(ef.name, '')) ENDS WITH '.' + ext)
            )
            AND EXISTS {
            MATCH (org)-[:HAS_PROJECTS]->(p:Project)
            WHERE p.deletedAt IS NULL
            AND (
              EXISTS { MATCH (p)-[:HAS_CHILD_ITEM|HAS_CHILD_FILE|HAS_CHILD_FOLDER*1..10]->(parent)-[:HAS_ATTACHED_FILE]->(ef) }
              OR EXISTS { MATCH (p)<-[:ITEM_IN_PROJECT]-(bi:BacklogItem)-[:HAS_ATTACHED_FILE]->(ef) }
            )
          }
          RETURN ef.url AS url, ef.name AS name, ef.type AS type, org.id AS orgId
          `,
          {
            userId,
            externalFileId,
            supportedExtensions: [...SUPPORTED_DOCUMENT_EXTENSIONS],
            supportedMimeHints: [...SUPPORTED_DOCUMENT_MIME_HINTS],
          }
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

      const chunks = await this.pdfProcessor.processDocument(
        documentInfo.url,
        documentInfo.type,
        documentInfo.name
      );
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
    orgId: string,
    userId: string,
    projectId?: string,
    conversationId?: string,
    maxChunks?: number
  ): Promise<RAGChatResponse> {
    const startTime = Date.now();
    const effectiveMaxChunks = maxChunks ?? RAG_CONFIG.MAX_CONTEXT_CHUNKS;
    const requestIntent = this.classifyIntent(message, projectId);

    try {
      // ── 1. Build system prompt with diagram list injected directly ────
      const diagramList = await this.diagramService.listProjectDiagrams(
        userId,
        orgId,
        projectId
      );
      const diagramListText = this.diagramService.serializeDiagramList(
        diagramList
      );

      const scopeDescription = projectId
        ? "You are working within a single project. All searches and diagrams are scoped to that project."
        : "You are working across all projects in the user's organization. Documents and diagrams may come from different projects.";

      const systemPrompt = SYSTEM_PROMPT_TEMPLATE
        .replace("{DIAGRAM_LIST}", diagramListText)
        .replace("{SCOPE_DESCRIPTION}", scopeDescription);

      // ── 2. Manage conversation ───────────────────────────────────────
      const convId = conversationId || uuidv4();
      let conversation: Conversation = this.conversations.get(convId) ?? {
        id: convId,
        userId,
        orgId,
        projectId,
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      if (!this.conversations.has(convId)) {
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
      console.log("\n" + "-".repeat(80));
      console.log("RAG CHAT: Making LLM call with tools");
      console.log("-".repeat(80));
      console.log(`User Query: ${message}`);
      console.log(`Available Tools: ${TOOLS.map(t => t.function.name).join(", ")}`);
      console.log("-".repeat(80) + "\n");
      
      logger?.info("RAGService: Making first LLM call with tools", {
        requestIntent,
        systemPromptLength: systemPrompt.length,
        historyCount: historyMessages.length,
        toolsAvailable: TOOLS.map(t => t.function.name),
      });

      if (requestIntent === "org_overview") {
        const evidence = await this.buildOrgOverviewEvidence(
          message,
          orgId,
          userId,
          diagramList
        );

        if (evidence.context.trim().length > 0) {
          const overviewResponse = await this.service.generateChatCompletion(
            "You are an intelligent project assistant. Synthesize a broad organization-level overview using many diagram summaries as primary evidence and document excerpts as supporting evidence. Group insights by entities/workstreams, major workflows, and cross-project dependencies. Do not output JSON, internal IDs, or tool narration.",
            message,
            evidence.context
          );

          const finalContent = this.sanitizeFinalAnswer(
            overviewResponse.content,
            evidence.sources,
            message
          );

          conversation.messages.push({
            role: "assistant",
            content: finalContent,
            timestamp: new Date(),
          });
          conversation.updatedAt = new Date();

          console.log("\n" + "-".repeat(80));
          console.log("Final answer generated (org overview path)");
          console.log("-".repeat(80));
          console.log(finalContent);
          console.log("-".repeat(80));
          console.log(
            `Tokens used: ${overviewResponse.tokensUsed}, Processing time: ${Date.now() - startTime}ms`
          );
          console.log("-".repeat(80) + "\n");

          return {
            answer: finalContent,
            sources: evidence.sources,
            conversationId: convId,
            metadata: {
              model: RAG_CONFIG.CHAT_MODEL,
              chunksUsed: evidence.sources.length,
              processingTimeMs: Date.now() - startTime,
              tokensUsed: overviewResponse.tokensUsed,
            },
          };
        }
      }
      
      let activeSystemPrompt = systemPrompt;
      let firstResponse;

      try {
        firstResponse = await this.service.chatWithTools(
          systemPrompt,
          historyMessages,
          TOOLS
        );
      } catch (error: any) {
        if (!this.isToolUseFailedError(error)) {
          throw error;
        }

        const compactDiagramListText = this.diagramService.serializeDiagramList(
          diagramList.slice(0, 15)
        );
        const compactSystemPrompt = SYSTEM_PROMPT_TEMPLATE
          .replace("{DIAGRAM_LIST}", compactDiagramListText)
          .replace("{SCOPE_DESCRIPTION}", scopeDescription);

        const toolUseSafePrompt = `${compactSystemPrompt}\n\nFUNCTION CALLING REQUIREMENT:\n- If using tools, emit function calls directly with valid arguments.\n- Do not output planning prose before function calls.`;

        logger?.warn(
          "RAGService: First tool call failed; retrying with compact prompt",
          {
            originalPromptLength: systemPrompt.length,
            compactPromptLength: toolUseSafePrompt.length,
          }
        );

        try {
          firstResponse = await this.service.chatWithTools(
            toolUseSafePrompt,
            historyMessages,
            TOOLS
          );
          activeSystemPrompt = toolUseSafePrompt;
        } catch (retryError: any) {
          if (
            !this.isToolUseFailedError(retryError) ||
            !this.isOverviewStyleRequest(message)
          ) {
            throw retryError;
          }

          logger?.warn(
            "RAGService: Falling back to deterministic overview synthesis",
            {
              message,
              diagramCount: diagramList.length,
            }
          );

          const fallbackSources: RAGSource[] = [];
          const candidateIds = new Set<string>();
          const searchCandidates = await this.diagramIndexService.searchDiagrams(
            message,
            orgId,
            userId,
            3,
            projectId
          );

          for (const c of searchCandidates) {
            candidateIds.add(c.fileId);
            if (candidateIds.size >= 2) break;
          }

          for (const d of diagramList) {
            if (candidateIds.size >= 2) break;
            candidateIds.add(d.fileId);
          }

          const serializedContexts: string[] = [];
          for (const diagramId of candidateIds) {
            const diagramData = await this.diagramService.fetchDiagramData(
              diagramId,
              userId,
              orgId,
              projectId
            );

            if (!diagramData || diagramData.nodes.length === 0) continue;

            fallbackSources.push({
              documentId: diagramId,
              documentName: diagramData.fileName,
              pageNumber: 0,
              relevanceScore: 1.0,
              snippet: `Diagram: ${diagramData.fileName}`,
            });

            const serialized = this.diagramService.serializeForLLM(
              diagramData,
              "minimal"
            );
            serializedContexts.push(
              this.truncateContext(
                serialized,
                RAG_CONFIG.MAX_DIAGRAM_CONTEXT_CHARS_PER_RESULT
              )
            );
          }

          if (serializedContexts.length === 0) {
            throw retryError;
          }

          const fallbackContext = serializedContexts
            .map((ctx, i) => `[Diagram Source ${i + 1}]\n${ctx}`)
            .join("\n\n---\n\n");

          const fallbackResponse = await this.service.generateChatCompletion(
            "You are a project assistant. Generate a concise project summary from provided diagram sources. Return natural language only. Do not output JSON, function calls, or planning text.",
            message,
            fallbackContext
          );

          const finalContent = this.sanitizeFinalAnswer(
            fallbackResponse.content,
            fallbackSources,
            message
          );

          conversation.messages.push({
            role: "assistant",
            content: finalContent,
            timestamp: new Date(),
          });
          conversation.updatedAt = new Date();

          return {
            answer: finalContent,
            sources: fallbackSources,
            conversationId: convId,
            metadata: {
              model: RAG_CONFIG.CHAT_MODEL,
              chunksUsed: fallbackSources.length,
              processingTimeMs: Date.now() - startTime,
              tokensUsed: fallbackResponse.tokensUsed,
            },
          };
        }
      }

      let selectedResponse = firstResponse;
      let tokensUsed = firstResponse.tokensUsed;

      // If the model tries to answer an overview question without tools,
      // retry with stricter instructions so the answer is evidence-grounded.
      if (
        !firstResponse.toolCalls?.length &&
        this.isOverviewStyleRequest(message) &&
        diagramList.length > 0
      ) {
        const enforcedSystemPrompt = `${systemPrompt}\n\nMANDATORY OVERRIDE FOR OVERVIEW REQUESTS:\n- Before answering, call get_diagram_context for multiple relevant artifacts (minimum 2 when available, maximum 3).\n- Do not answer from diagram names alone.\n- Return only the final user-facing answer (no planning steps, no tool narration).`;

        const retryResponse = await this.service.chatWithTools(
          enforcedSystemPrompt,
          historyMessages,
          TOOLS
        );

        tokensUsed += retryResponse.tokensUsed;
        if (retryResponse.toolCalls?.length) {
          selectedResponse = retryResponse;
          activeSystemPrompt = enforcedSystemPrompt;
        }
      }

      // If model responds with "I can search diagrams/documents if you want",
      // auto-continue once so the user doesn't need to send "continue/okay".
      if (
        !selectedResponse.toolCalls?.length &&
        this.shouldAutoContinueRetrieval(selectedResponse.content, message)
      ) {
        const forcedContinuationPrompt = `${activeSystemPrompt}\n\nMANDATORY CONTINUATION:\n- Do not ask the user whether to continue searching.\n- If more context is needed, call the relevant tools now and then answer.\n- Return one complete final answer.`;

        const continuationResponse = await this.service.chatWithTools(
          forcedContinuationPrompt,
          historyMessages,
          TOOLS
        );

        tokensUsed += continuationResponse.tokensUsed;
        if (continuationResponse.toolCalls?.length) {
          selectedResponse = continuationResponse;
          activeSystemPrompt = forcedContinuationPrompt;
        }
      }

      console.log("\n" + "-".repeat(80));
      console.log("LLM response received");
      console.log("-".repeat(80));
      if (firstResponse.toolCalls && firstResponse.toolCalls.length > 0) {
        console.log(`Tool calls requested: ${firstResponse.toolCalls.length}`);
        firstResponse.toolCalls.forEach((tc, i) => {
          console.log(`   ${i + 1}. ${tc.functionName}`);
          console.log(`      Args: ${tc.arguments}`);
        });
      } else {
        console.log("Direct response (no tools used)");
        console.log(`   Content: ${firstResponse.content?.substring(0, 150)}...`);
      }
      console.log("-".repeat(80) + "\n");
      
      logger?.info("RAGService: First LLM response received", {
        hasToolCalls: !!firstResponse.toolCalls,
        toolCallsCount: firstResponse.toolCalls?.length ?? 0,
        toolNames: firstResponse.toolCalls?.map(tc => tc.functionName) ?? [],
        directContent: firstResponse.content?.substring(0, 100),
      });

      let finalContent: string;
      const allSources: RAGSource[] = [];
      let chunksUsed = 0;

      if (selectedResponse.toolCalls && selectedResponse.toolCalls.length > 0) {
        if (this.isOverviewStyleRequest(message)) {
          const requestedIds = this.extractRequestedDiagramIds(
            selectedResponse.toolCalls.map((tc) => ({
              functionName: tc.functionName,
              arguments: tc.arguments,
            }))
          );

          if (requestedIds.size < 2 && diagramList.length > 1) {
            const searchCandidates = await this.diagramIndexService.searchDiagrams(
              message,
              orgId,
              userId,
              3,
              projectId
            );

            for (const candidate of searchCandidates) {
              if (requestedIds.size >= 2) break;
              if (requestedIds.has(candidate.fileId)) continue;

              selectedResponse.toolCalls.push({
                id: `auto-diagram-${uuidv4()}`,
                functionName: "get_diagram_context",
                arguments: JSON.stringify({ fileId: candidate.fileId }),
              });
              requestedIds.add(candidate.fileId);
            }

            for (const d of diagramList) {
              if (requestedIds.size >= 2) break;
              if (requestedIds.has(d.fileId)) continue;

              selectedResponse.toolCalls.push({
                id: `auto-diagram-${uuidv4()}`,
                functionName: "get_diagram_context",
                arguments: JSON.stringify({ fileId: d.fileId }),
              });
              requestedIds.add(d.fileId);
            }

            logger?.info("RAGService: Enforced minimum overview diagram calls", {
              overviewQuery: true,
              totalToolCalls: selectedResponse.toolCalls.length,
              diagramCalls: requestedIds.size,
            });
          }
        }

        // ── 4. Execute tool calls in parallel ──────────────────────────
        const toolExecutionContext: ToolExecutionContext = {
          intent: requestIntent,
          isOverviewRequest: this.isOverviewStyleRequest(message),
          diagramCallsSeen: 0,
          diagramContextChars: 0,
          usedDiagramIds: new Set<string>(),
        };

        logger?.info("RAGService: Executing tool calls", {
          toolCalls: selectedResponse.toolCalls.map(tc => ({
            function: tc.functionName,
            arguments: tc.arguments,
          })),
        });
        
        const toolResults: ToolCallResult[] = [];
        for (const tc of selectedResponse.toolCalls) {
          const result = await this.executeToolCall(
            tc.functionName,
            tc.arguments,
            orgId,
            userId,
            effectiveMaxChunks,
            diagramList,
            allSources,
            projectId,
            toolExecutionContext
          );
          toolResults.push(result);
        }

        logger?.info("RAGService: Tool calls executed", {
          resultsCount: toolResults.length,
          sourcesFound: allSources.length,
          diagramCallsSeen: toolExecutionContext.diagramCallsSeen,
          diagramContextChars: toolExecutionContext.diagramContextChars,
        });

        console.log("\n" + "-".repeat(80));
        console.log("Tool execution completed");
        console.log("-".repeat(80));
        console.log(`Sources found: ${allSources.length}`);
        allSources.forEach((src, i) => {
          console.log(`   ${i + 1}. ${src.documentName} (score: ${(src.relevanceScore * 100).toFixed(1)}%)`);
          const previewLines = this.buildSourcePreviewLines(src.snippet);
          if (previewLines.length > 0) {
            console.log("      Preview:");
            previewLines.forEach((line) => {
              console.log(`         ${line}`);
            });
          }
        });
        console.log("-".repeat(80) + "\n");

        chunksUsed = allSources.length;

        // ── 5. Second LLM call — model produces answer with tool results
        const toolCallIds = selectedResponse.toolCalls.map((tc) => tc.id);
        const finalResponse =
          await this.service.continueWithToolResults(
            activeSystemPrompt,
            historyMessages,
            selectedResponse.assistantMessage,
            toolResults,
            toolCallIds
          );

        logger?.info("RAGService: Final LLM response received", {
          contentLength: finalResponse.content.length,
          contentPreview: finalResponse.content.substring(0, 200),
          tokensUsed: finalResponse.tokensUsed,
        });

        console.log("\n" + "-".repeat(80));
        console.log("Final answer generated");
        console.log("-".repeat(80));
        console.log(finalResponse.content);
        console.log("-".repeat(80));
        console.log(`Tokens used: ${tokensUsed}, Processing time: ${Date.now() - startTime}ms`);
        console.log("-".repeat(80) + "\n");

        let resolvedFinalContent = finalResponse.content;
        tokensUsed += finalResponse.tokensUsed;

        if (this.looksLikeToolPlanOutput(resolvedFinalContent)) {
          const groundedContext = toolResults
            .map(
              (tr, i) =>
                `[Tool Result ${i + 1}: ${tr.toolName}]\n${this.truncateContext(tr.content, 2400)}`
            )
            .join("\n\n---\n\n");

          const recovery = await this.service.generateChatCompletion(
            "You are a project assistant. Rewrite the provided context into a direct user-facing answer. Do not output JSON, tool calls, or code blocks. Synthesize clearly using concise natural language.",
            message,
            groundedContext
          );

          logger?.warn("RAGService: Recovered from tool-plan style final output", {
            originalLength: finalResponse.content.length,
            recoveredLength: recovery.content.length,
          });

          resolvedFinalContent = recovery.content;
          tokensUsed += recovery.tokensUsed;
        }

        finalContent = resolvedFinalContent;
      } else {
        // Model answered directly without tools
        logger?.info("RAGService: Model answered directly without tools", {
          contentLength: selectedResponse.content?.length ?? 0,
          contentPreview: selectedResponse.content?.substring(0, 200),
        });
        finalContent = selectedResponse.content ?? "";
      }

      finalContent = this.sanitizeFinalAnswer(finalContent, allSources, message);

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
    orgId: string,
    userId: string,
    maxChunks: number,
    diagramList: DiagramListItem[],
    sourcesAccumulator: RAGSource[],
    projectId?: string,
    executionContext?: ToolExecutionContext
  ): Promise<ToolCallResult> {
    try {
      const args = JSON.parse(argumentsJson);

      switch (functionName) {
        case "search_documents":
          return this.toolSearchDocuments(
            args.query,
            orgId,
            userId,
            args.topK ?? maxChunks,
            sourcesAccumulator,
            projectId
          );

        case "get_diagram_context":
          return this.toolGetDiagramContext(
            orgId,
            userId,
            diagramList,
            args.fileId,
            args.query,
            sourcesAccumulator,
            projectId,
            executionContext
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
    orgId: string,
    userId: string,
    topK: number,
    sourcesAccumulator: RAGSource[],
    projectId?: string
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
        content: "No relevant sources found for this query in indexed artifacts.",
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
    orgId: string,
    userId: string,
    diagramList: DiagramListItem[],
    fileId?: string,
    query?: string,
    sourcesAccumulator?: RAGSource[],
    projectId?: string,
    executionContext?: ToolExecutionContext
  ): Promise<ToolCallResult> {
    let targetFileId = this.isLikelyValidDiagramId(fileId) ? fileId : undefined;
    const normalizedQuery = query?.trim();

    if (executionContext) {
      executionContext.diagramCallsSeen += 1;
      if (
        executionContext.diagramCallsSeen >
        RAG_CONFIG.MAX_DIAGRAM_TOOL_CALLS_PER_TURN
      ) {
        return {
          toolName: "get_diagram_context",
          content:
            "Diagram context limit reached for this turn. Use the already retrieved diagrams to synthesize the answer.",
        };
      }
    }

    if (!targetFileId && fileId && !normalizedQuery) {
      logger?.warn("RAGService.toolGetDiagramContext rejected invalid fileId", {
        fileId,
      });
      return {
        toolName: "get_diagram_context",
        content:
          "No relevant sources found for this query in indexed artifacts.",
      };
    }

    // If no fileId, use query to search diagram summaries
    if (!targetFileId && normalizedQuery) {
      const searchResults = await this.diagramIndexService.searchDiagrams(
        normalizedQuery,
        orgId,
        userId,
        3,
        projectId
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

    // If fileId is present but not in the known list, fall back to query-mode using the same string.
    if (
      targetFileId &&
      !diagramList.some((d) => d.fileId === targetFileId) &&
      !normalizedQuery
    ) {
      const searchResults = await this.diagramIndexService.searchDiagrams(
        targetFileId,
        orgId,
        userId,
        3,
        projectId
      );
      if (searchResults.length > 0) {
        targetFileId = searchResults[0]!.fileId;
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
          "No relevant sources found for this query in indexed artifacts.",
      };
    }

    if (executionContext?.usedDiagramIds.has(targetFileId)) {
      const existing = diagramList.find((d) => d.fileId === targetFileId);
      return {
        toolName: "get_diagram_context",
        content: `Diagram already included in this turn: ${existing?.fileName ?? targetFileId}`,
      };
    }

    if (executionContext) {
      executionContext.usedDiagramIds.add(targetFileId);
    }

    // Fetch full diagram structure (always live from Neo4j)
    const diagramData = await this.diagramService.fetchDiagramData(
      targetFileId,
      userId,
      orgId,
      projectId
    );

    if (!diagramData || diagramData.nodes.length === 0) {
      return {
        toolName: "get_diagram_context",
        content: "No relevant sources found for this query in indexed artifacts.",
      };
    }

    const diagramMode: "full" | "minimal" =
      executionContext?.intent === "specific_question"
        ? "full"
        : RAG_CONFIG.OVERVIEW_DEFAULT_DIAGRAM_SERIALIZATION;

    const adaptivePerResultCap = this.getAdaptiveDiagramContextCharLimit(
      executionContext?.diagramCallsSeen ?? 1
    );

    let serialized = this.diagramService.serializeForLLM(diagramData, diagramMode);
    serialized = this.truncateContext(
      serialized,
      adaptivePerResultCap
    );

    if (executionContext) {
      const nextChars = executionContext.diagramContextChars + serialized.length;
      if (nextChars > RAG_CONFIG.MAX_DIAGRAM_CONTEXT_CHARS_PER_TURN) {
        serialized = this.buildFallbackDiagramSummary(
          diagramData.fileName,
          diagramData.nodes.length,
          diagramData.edges.length,
          diagramData.groups.length
        );
      }

      executionContext.diagramContextChars += serialized.length;
    }

    // Add diagram as a source
    sourcesAccumulator?.push({
      documentId: targetFileId,
      documentName: diagramData.fileName,
      pageNumber: 0,
      relevanceScore: 1.0,
      snippet: `Diagram: ${diagramData.fileName}`,
    });

    // Serialize to LLM-friendly format
    return { toolName: "get_diagram_context", content: serialized };
  }

  async searchDocuments(
    query: string,
    orgId: string,
    userId: string,
    topK?: number,
    projectId?: string
  ): Promise<RAGSource[]> {
    const effectiveTopK = topK ?? RAG_CONFIG.MAX_CONTEXT_CHUNKS;
    try {
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

  getConversations(
    orgId: string,
    userId: string,
    limit = 10,
    projectId?: string
  ): Conversation[] {
    const conversations: Conversation[] = [];

    for (const conv of this.conversations.values()) {
      const matchesOrg = conv.orgId === orgId;
      const matchesUser = conv.userId === userId;
      const matchesProject = !projectId || conv.projectId === projectId;
      if (matchesOrg && matchesUser && matchesProject) {
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

  async getDocumentStatuses(orgId: string, userId: string, projectId?: string) {
    return this.vectorStore.getProjectDocumentStatuses(userId, orgId, projectId);
  }

  /** REST convenience: resolve orgId from projectId automatically */
  async getDocumentStatusesForProject(projectId: string, userId: string) {
    const orgId = await this.resolveOrgIdForProject(projectId, userId);
    return this.getDocumentStatuses(orgId, userId, projectId);
  }

  /** REST convenience: resolve orgId from projectId automatically */
  async listProjectDiagramsForProject(projectId: string, userId: string) {
    const orgId = await this.resolveOrgIdForProject(projectId, userId);
    return this.listProjectDiagrams(userId, orgId, projectId);
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
  async listProjectDiagrams(userId: string, orgId: string, projectId?: string) {
    return this.diagramService.listProjectDiagrams(userId, orgId, projectId);
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
        WITH ef, count(chunk) AS chunkCount
        RETURN ef.id AS documentId, chunkCount > 0 AS isEmbedded
        `,
        {
          userId,
          projectId,
          supportedExtensions: [...SUPPORTED_DOCUMENT_EXTENSIONS],
          supportedMimeHints: [...SUPPORTED_DOCUMENT_MIME_HINTS],
        }
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
