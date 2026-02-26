import { EmbeddingService } from "./EmbeddingService";
import type { EmbeddingResult, ToolCallResult } from "../types/rag.types";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

/**
 * Factory that returns the unified EmbeddingService
 * (ngrok embeddings + Groq chat completions)
 */
export class EmbeddingServiceFactory {
  private static instance: EmbeddingService;

  static getInstance(): EmbeddingService {
    if (!this.instance) {
      this.instance = EmbeddingService.getInstance();
    }
    return this.instance;
  }

  /**
   * Reset the singleton (useful for testing or switching providers)
   */
  static reset(): void {
    // @ts-ignore - accessing private property
    this.instance = undefined;
  }
}

/**
 * Universal embedding service interface
 */
export interface IEmbeddingService {
  generateEmbedding(text: string): Promise<EmbeddingResult>;
  generateEmbeddings(texts: string[]): Promise<EmbeddingResult[]>;
  generateChatCompletion(
    systemPrompt: string,
    userMessage: string,
    context: string
  ): Promise<{ content: string; tokensUsed: number }>;
  generateChatCompletionWithHistory(
    systemPrompt: string,
    messages: Array<{ role: "user" | "assistant"; content: string }>,
    context: string
  ): Promise<{ content: string; tokensUsed: number }>;
  chatWithTools(
    systemPrompt: string,
    messages: ChatCompletionMessageParam[],
    tools: ChatCompletionTool[]
  ): Promise<{
    content: string | null;
    toolCalls: Array<{ id: string; functionName: string; arguments: string }> | null;
    assistantMessage: ChatCompletionMessageParam;
    tokensUsed: number;
  }>;
  continueWithToolResults(
    systemPrompt: string,
    messages: ChatCompletionMessageParam[],
    assistantMessage: ChatCompletionMessageParam,
    toolResults: ToolCallResult[],
    toolCallIds: string[]
  ): Promise<{ content: string; tokensUsed: number }>;
  generateContent(prompt: string): Promise<string>;
  summarizeDiagram(
    fileName: string,
    nodes: Array<{ name: string; shape: string; description: string | null }>,
    edges: Array<{ sourceName: string; targetName: string; label: string }>,
    groups: Array<{ name: string; childNodeNames: string[] }>
  ): Promise<string>;
}
