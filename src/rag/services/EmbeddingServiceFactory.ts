import { EmbeddingService } from "./EmbeddingService";
import { LocalEmbeddingService } from "./LocalEmbeddingService";
import { EnvLoader } from "../../util/EnvLoader";
import type { EmbeddingResult, ToolCallResult } from "../types/rag.types";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

/**
 * Factory that returns either OpenAI or Local embedding service
 * based on environment configuration
 */
export class EmbeddingServiceFactory {
  private static instance: EmbeddingService | LocalEmbeddingService;

  static getInstance(): EmbeddingService | LocalEmbeddingService {
    if (!this.instance) {
      const useLocal = EnvLoader.get("USE_LOCAL_MODELS") === "true";
      
      if (useLocal) {
        this.instance = LocalEmbeddingService.getInstance();
      } else {
        this.instance = EmbeddingService.getInstance();
      }
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
 * Use this in your code instead of directly importing EmbeddingService or LocalEmbeddingService
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
}
