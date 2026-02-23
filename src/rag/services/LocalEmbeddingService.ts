import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions";
import { EnvLoader } from "../../util/EnvLoader";
import logger from "../../logger";
import { EmbeddingResult, RAG_CONFIG, ToolCallResult } from "../types/rag.types";
import https from "https";
import http from "http";

/**
 * LocalEmbeddingService - Uses local models instead of OpenAI
 * 
 * Supports:
 * 1. Ollama (recommended - easy setup, GPU support)
 * 2. Custom embedding endpoint (for HuggingFace models via Python service)
 * 
 * Setup Ollama:
 *   1. Download from https://ollama.ai
 *   2. Run: ollama pull nomic-embed-text (for embeddings)
 *   3. Run: ollama pull qwen2.5:7b (for chat)
 */
export class LocalEmbeddingService {
  private static instance: LocalEmbeddingService;
  private readonly ollamaBaseUrl: string;
  private readonly useOllama: boolean;
  private readonly embeddingEndpoint: string | undefined;

  private constructor() {
    this.ollamaBaseUrl = EnvLoader.get("OLLAMA_BASE_URL") ?? "http://localhost:11434";
    this.useOllama = EnvLoader.get("USE_OLLAMA") === "true";
    this.embeddingEndpoint = EnvLoader.get("EMBEDDING_SERVICE_URL") ?? undefined;
  }

  static getInstance(): LocalEmbeddingService {
    if (!LocalEmbeddingService.instance)
      LocalEmbeddingService.instance = new LocalEmbeddingService();
    return LocalEmbeddingService.instance;
  }

  /**
   * Simple HTTP POST helper to replace fetch
   */
  private async httpPost(url: string, body: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const client = urlObj.protocol === "https:" ? https : http;
      const postData = JSON.stringify(body);

      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === "https:" ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData),
        },
      };

      const req = client.request(options, (res) => {
        let data = "";

        res.on("data", (chunk) => {
          data += chunk;
        });

        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error(`Failed to parse response: ${e}`));
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        });
      });

      req.on("error", reject);
      req.write(postData);
      req.end();
    });
  }

  /**
   * Generate embedding using Ollama or custom endpoint
   */
  async generateEmbedding(text: string): Promise<EmbeddingResult> {
    try {
      if (this.useOllama) {
        return await this.generateEmbeddingOllama(text);
      } else if (this.embeddingEndpoint) {
        return await this.generateEmbeddingCustom(text);
      } else {
        throw new Error("No embedding service configured. Set USE_OLLAMA=true or EMBEDDING_SERVICE_URL");
      }
    } catch (error) {
      logger?.error("LocalEmbeddingService.generateEmbedding failed", { error });
      throw error;
    }
  }

  private async generateEmbeddingOllama(text: string): Promise<EmbeddingResult> {
    const model = EnvLoader.get("OLLAMA_EMBEDDING_MODEL") ?? "qwen3-embedding:0.6b";
    const data = await this.httpPost(`${this.ollamaBaseUrl}/api/embeddings`, {
      model,
      prompt: text.slice(0, 8000),
    }) as { embedding: number[] };
    
    return {
      embedding: data.embedding,
      model,
      tokensUsed: 0, // Ollama doesn't return token count
    };
  }

  private async generateEmbeddingCustom(text: string): Promise<EmbeddingResult> {
    const data = await this.httpPost(this.embeddingEndpoint!, {
      text: text.slice(0, 8000),
    }) as { embedding: number[]; model: string };
    
    return {
      embedding: data.embedding,
      model: data.model ?? "custom-model",
      tokensUsed: 0,
    };
  }

  async generateEmbeddings(texts: string[]): Promise<EmbeddingResult[]> {
    try {
      // Process in parallel with a limit to avoid overwhelming the GPU
      const batchSize = 5;
      const results: EmbeddingResult[] = [];

      for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        const batchResults = await Promise.all(
          batch.map((text) => this.generateEmbedding(text))
        );
        results.push(...batchResults);
      }

      return results;
    } catch (error) {
      logger?.error("LocalEmbeddingService.generateEmbeddings failed", { error });
      throw error;
    }
  }

  async generateChatCompletion(
    systemPrompt: string,
    userMessage: string,
    context: string
  ): Promise<{ content: string; tokensUsed: number }> {
    try {
      const model = EnvLoader.get("OLLAMA_CHAT_MODEL") ?? "qwen2.5:7b";
      
      const data = await this.httpPost(`${this.ollamaBaseUrl}/api/chat`, {
        model,
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: `Context:\n${context}\n\nQuestion: ${userMessage}`,
          },
        ],
        stream: false,
        options: {
          temperature: 0.7,
          num_predict: RAG_CONFIG.MAX_TOKENS,
        },
      }) as { 
        message: { content: string }; 
        eval_count?: number;
      };

      return {
        content: data.message.content,
        tokensUsed: data.eval_count ?? 0,
      };
    } catch (error) {
      logger?.error("LocalEmbeddingService.generateChatCompletion failed", { error });
      throw error;
    }
  }

  async generateChatCompletionWithHistory(
    systemPrompt: string,
    messages: Array<{ role: "user" | "assistant"; content: string }>,
    context: string
  ): Promise<{ content: string; tokensUsed: number }> {
    try {
      const model = EnvLoader.get("OLLAMA_CHAT_MODEL") ?? "qwen2.5:7b";
      
      const formattedMessages: Array<{
        role: "system" | "user" | "assistant";
        content: string;
      }> = [
        { role: "system", content: systemPrompt },
        ...messages.slice(-10),
      ];

      if (context) {
        const lastUserIdx = formattedMessages.findLastIndex((m) => m.role === "user");
        if (lastUserIdx !== -1) {
          const lastUserMessage = formattedMessages[lastUserIdx];
          if (lastUserMessage) {
            lastUserMessage.content =
              `Context from documents:\n${context}\n\nUser question: ${lastUserMessage.content}`;
          }
        }
      }

      const data = await this.httpPost(`${this.ollamaBaseUrl}/api/chat`, {
        model,
        messages: formattedMessages,
        stream: false,
        options: {
          temperature: 0.7,
          num_predict: RAG_CONFIG.MAX_TOKENS,
        },
      }) as { 
        message: { content: string }; 
        eval_count?: number;
      };

      return {
        content: data.message.content,
        tokensUsed: data.eval_count ?? 0,
      };
    } catch (error) {
      logger?.error("LocalEmbeddingService.generateChatCompletionWithHistory failed", { error });
      throw error;
    }
  }

  /**
   * Tool calling with local models (limited support - Ollama doesn't natively support OpenAI-style tools)
   * This is a simplified implementation that uses structured prompting
   */
  async chatWithTools(
    systemPrompt: string,
    messages: ChatCompletionMessageParam[],
    tools: ChatCompletionTool[]
  ): Promise<{
    content: string | null;
    toolCalls: Array<{ id: string; functionName: string; arguments: string }> | null;
    assistantMessage: ChatCompletionMessageParam;
    tokensUsed: number;
  }> {
    // Note: Most local models don't support OpenAI-style function calling
    // This is a fallback that returns a regular chat response
    logger?.warn("LocalEmbeddingService: Tool calling not fully supported with local models, falling back to regular chat");
    
    const model = EnvLoader.get("OLLAMA_CHAT_MODEL") ?? "qwen2.5:7b";
    
    const toolDescriptions = tools.map((t) => 
      `- ${t.function.name}: ${t.function.description}`
    ).join("\n");

    const enhancedSystemPrompt = `${systemPrompt}\n\nAvailable tools:\n${toolDescriptions}`;
    
    const data = await this.httpPost(`${this.ollamaBaseUrl}/api/chat`, {
      model,
      messages: [
        { role: "system", content: enhancedSystemPrompt },
        ...messages,
      ],
      stream: false,
      options: {
        temperature: 0.7,
        num_predict: RAG_CONFIG.MAX_TOKENS,
      },
    }) as { 
      message: { content: string; role: string }; 
      eval_count?: number;
    };

    const assistantMessage: ChatCompletionMessageParam = {
      role: "assistant",
      content: data.message.content,
    };

    return {
      content: data.message.content,
      toolCalls: null,
      assistantMessage,
      tokensUsed: data.eval_count ?? 0,
    };
  }

  async continueWithToolResults(
    systemPrompt: string,
    messages: ChatCompletionMessageParam[],
    assistantMessage: ChatCompletionMessageParam,
    toolResults: ToolCallResult[],
    toolCallIds: string[]
  ): Promise<{ content: string; tokensUsed: number }> {
    // Simplified version for local models
    const toolResultsText = toolResults
      .map((r) => `Tool ${r.toolName} result: ${r.content}`)
      .join("\n\n");

    return this.generateChatCompletion(
      systemPrompt,
      "Continue based on the tool results",
      toolResultsText
    );
  }
}
