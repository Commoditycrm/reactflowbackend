import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions";
import { EnvLoader } from "../../util/EnvLoader";
import logger from "../../logger";
import { EmbeddingResult, RAG_CONFIG, ToolCallResult } from "../types/rag.types";

/**
 * Unified EmbeddingService
 *
 * - **Embeddings** → local model via ngrok (EMBEDDING_BASE_URL / EMBEDDING_API_KEY)
 * - **Chat completions** → Groq API (CHAT_BASE_URL / GROQ_API_KEY) with Llama-4
 */
export class EmbeddingService {
  private static instance: EmbeddingService;
  private readonly embeddingClient: OpenAI;
  private readonly chatClient: OpenAI;

  private constructor() {
    // Separate client for embeddings (local model via ngrok)
    this.embeddingClient = new OpenAI({
      apiKey: EnvLoader.get("EMBEDDING_API_KEY") || "dummy-key", // Local model may not need auth
      baseURL: RAG_CONFIG.EMBEDDING_BASE_URL,
    });

    // Separate client for chat completions (Groq API)
    this.chatClient = new OpenAI({
      apiKey: EnvLoader.getOrThrow("GROQ_API_KEY"),
      baseURL: RAG_CONFIG.CHAT_BASE_URL,
    });
  }

  static getInstance(): EmbeddingService {
    if (!EmbeddingService.instance)
      EmbeddingService.instance = new EmbeddingService();
    return EmbeddingService.instance;
  }

  // ─── Embeddings (ngrok / local model) ─────────────────────────────────

  async generateEmbedding(text: string): Promise<EmbeddingResult> {
    try {
      const response = await this.embeddingClient.embeddings.create({
        model: RAG_CONFIG.EMBEDDING_MODEL,
        input: text.slice(0, 8000),
        encoding_format: "float",
      });

      const firstData = response.data[0];
      if (!firstData) {
        throw new Error("No embedding returned from embedding service");
      }

      return {
        embedding: firstData.embedding,
        model: RAG_CONFIG.EMBEDDING_MODEL,
        tokensUsed: response.usage?.total_tokens ?? 0,
      };
    } catch (error) {
      logger?.error("EmbeddingService.generateEmbedding failed", { error });
      throw error;
    }
  }

  async generateEmbeddings(texts: string[]): Promise<EmbeddingResult[]> {
    try {
      const truncatedTexts = texts.map((t) => t.slice(0, 8000));
      const response = await this.embeddingClient.embeddings.create({
        model: RAG_CONFIG.EMBEDDING_MODEL,
        input: truncatedTexts,
        encoding_format: "float",
      });

      const tokensPerText = Math.floor(
        (response.usage?.total_tokens ?? 0) / texts.length
      );

      // DEBUG: Check what the SDK actually returns
      const firstItem = response.data[0];
      if (firstItem) {
        logger?.info("EmbeddingService.generateEmbeddings dimension check", {
          firstEmbeddingLength: firstItem.embedding.length,
          isArray: Array.isArray(firstItem.embedding),
          type: typeof firstItem.embedding,
          firstValues: firstItem.embedding.slice(0, 3),
          totalItems: response.data.length,
        });
      }

      return response.data.map((item) => ({
        embedding: item.embedding,
        model: RAG_CONFIG.EMBEDDING_MODEL,
        tokensUsed: tokensPerText,
      }));
    } catch (error) {
      logger?.error("EmbeddingService.generateEmbeddings failed", { error });
      throw error;
    }
  }

  // ─── Chat Completions (Groq / Llama-4) ────────────────────────────────

  async generateChatCompletion(
    systemPrompt: string,
    userMessage: string,
    context: string
  ): Promise<{ content: string; tokensUsed: number }> {
    try {
      const response = await this.chatClient.chat.completions.create({
        model: RAG_CONFIG.CHAT_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: `Context:\n${context}\n\nQuestion: ${userMessage}`,
          },
        ],
        max_tokens: RAG_CONFIG.MAX_TOKENS,
        temperature: 0.7,
      });

      return {
        content: response.choices[0]?.message?.content ?? "",
        tokensUsed: response.usage?.total_tokens ?? 0,
      };
    } catch (error) {
      logger?.error("EmbeddingService.generateChatCompletion failed", {
        error,
      });
      throw error;
    }
  }

  async generateChatCompletionWithHistory(
    systemPrompt: string,
    messages: Array<{ role: "user" | "assistant"; content: string }>,
    context: string
  ): Promise<{ content: string; tokensUsed: number }> {
    try {
      const formattedMessages: Array<{
        role: "system" | "user" | "assistant";
        content: string;
      }> = [
        { role: "system", content: systemPrompt },
        ...messages.slice(-10),
      ];

      if (context) {
        const lastUserIdx = formattedMessages.findLastIndex(
          (m) => m.role === "user"
        );
        if (lastUserIdx !== -1) {
          const lastUserMessage = formattedMessages[lastUserIdx];
          if (lastUserMessage) {
            lastUserMessage.content =
              `Context from documents:\n${context}\n\nUser question: ${lastUserMessage.content}`;
          }
        }
      }

      const response = await this.chatClient.chat.completions.create({
        model: RAG_CONFIG.CHAT_MODEL,
        messages: formattedMessages,
        max_tokens: RAG_CONFIG.MAX_TOKENS,
        temperature: 0.7,
      });

      return {
        content: response.choices[0]?.message?.content ?? "",
        tokensUsed: response.usage?.total_tokens ?? 0,
      };
    } catch (error) {
      logger?.error(
        "EmbeddingService.generateChatCompletionWithHistory failed",
        { error }
      );
      throw error;
    }
  }

  // ─── Tool-calling (Groq / Llama-4) ───────────────────────────────────

  /**
   * Chat completion with Groq tool-calling support.
   *
   * Flow:
   *  1. Send messages + tool definitions to the model
   *  2. If model decides to call tools, return the tool calls for the caller to execute
   *  3. Caller executes tools, passes results back via continueWithToolResults()
   *  4. Model produces final answer
   */
  async chatWithTools(
    systemPrompt: string,
    messages: ChatCompletionMessageParam[],
    tools: ChatCompletionTool[]
  ): Promise<{
    /** Non-null when the model responded with text directly (no tool calls) */
    content: string | null;
    /** Non-null when the model wants to call tools */
    toolCalls:
      | Array<{
          id: string;
          functionName: string;
          arguments: string;
        }>
      | null;
    /** The assistant message to append to the conversation */
    assistantMessage: ChatCompletionMessageParam;
    tokensUsed: number;
  }> {
    try {
      logger?.info("EmbeddingService.chatWithTools called", {
        model: RAG_CONFIG.CHAT_MODEL,
        toolCount: tools.length,
        messageCount: messages.length,
      });

      const response = await this.chatClient.chat.completions.create({
        model: RAG_CONFIG.CHAT_MODEL,
        messages: [{ role: "system", content: systemPrompt }, ...messages],
        tools,
        tool_choice: "auto",
        max_tokens: RAG_CONFIG.MAX_TOKENS,
        temperature: 0.7,
      });

      const choice = response.choices[0];
      const message = choice?.message;
      const tokensUsed = response.usage?.total_tokens ?? 0;

      if (message?.tool_calls && message.tool_calls.length > 0) {
        return {
          content: null,
          toolCalls: message.tool_calls.map((tc) => ({
            id: tc.id,
            functionName: tc.function.name,
            arguments: tc.function.arguments,
          })),
          assistantMessage: message as ChatCompletionMessageParam,
          tokensUsed,
        };
      }

      return {
        content: message?.content ?? "",
        toolCalls: null,
        assistantMessage: message as ChatCompletionMessageParam,
        tokensUsed,
      };
    } catch (error) {
      logger?.error("EmbeddingService.chatWithTools failed", { error });
      throw error;
    }
  }

  /**
   * Continue a tool-calling conversation after tools have been executed.
   * Sends tool results back to the model to produce the final answer.
   */
  async continueWithToolResults(
    systemPrompt: string,
    messages: ChatCompletionMessageParam[],
    assistantMessage: ChatCompletionMessageParam,
    toolResults: ToolCallResult[],
    toolCallIds: string[]
  ): Promise<{ content: string; tokensUsed: number }> {
    try {
      const toolMessages: ChatCompletionToolMessageParam[] = toolResults.map(
        (result, index) => ({
          role: "tool" as const,
          tool_call_id: toolCallIds[index]!,
          content: result.content,
        })
      );

      const response = await this.chatClient.chat.completions.create({
        model: RAG_CONFIG.CHAT_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          ...messages,
          assistantMessage,
          ...toolMessages,
        ],
        max_tokens: RAG_CONFIG.MAX_TOKENS,
        temperature: 0.7,
      });

      return {
        content: response.choices[0]?.message?.content ?? "",
        tokensUsed: response.usage?.total_tokens ?? 0,
      };
    } catch (error) {
      logger?.error("EmbeddingService.continueWithToolResults failed", {
        error,
      });
      throw error;
    }
  }

  // ─── Summarization (Groq / Llama-4) ──────────────────────────────────

  /**
   * Generate content using Groq Llama-4 (replaces Gemini).
   */
  async generateContent(prompt: string): Promise<string> {
    try {
      const response = await this.chatClient.chat.completions.create({
        model: RAG_CONFIG.SUMMARIZATION_MODEL,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
        max_tokens: 1024,
        top_p: 0.8,
      });

      const text = response.choices[0]?.message?.content;
      if (!text) {
        throw new Error("No text returned from Groq API");
      }

      return text.trim();
    } catch (error) {
      logger?.error("EmbeddingService.generateContent failed", { error });
      throw error;
    }
  }

  /**
   * Summarize a diagram's structure into a concise text description.
   * This summary is used as a lightweight embedding for diagram discovery.
   */
  async summarizeDiagram(
    fileName: string,
    nodes: Array<{ name: string; shape: string; description: string | null }>,
    edges: Array<{
      sourceName: string;
      targetName: string;
      label: string;
    }>,
    groups: Array<{ name: string; childNodeNames: string[] }>
  ): Promise<string> {
    const nodeList = nodes
      .map(
        (n) =>
          `- "${n.name}" (${n.shape})${n.description ? `: ${n.description}` : ""}`
      )
      .join("\n");

    const edgeList = edges
      .map(
        (e) =>
          `- "${e.sourceName}" → "${e.targetName}"${e.label ? ` [${e.label}]` : ""}`
      )
      .join("\n");

    const groupList = groups
      .map((g) => `- Group "${g.name}": contains [${g.childNodeNames.join(", ")}]`)
      .join("\n");

    const prompt = `You are a technical analyst. Summarize this diagram/flowchart into a concise paragraph (3-5 sentences) that captures its purpose, the key processes/steps, and how they connect. Focus on WHAT the diagram represents, not visual layout.

Diagram: "${fileName}"

Nodes:
${nodeList || "(none)"}

Connections:
${edgeList || "(none)"}

Groups:
${groupList || "(none)"}

Write a clear, searchable summary paragraph:`;

    return this.generateContent(prompt);
  }
}
