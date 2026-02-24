import OpenAI from "openai";
import { EnvLoader } from "../../util/EnvLoader";
import logger from "../../logger";
import { EmbeddingResult, RAG_CONFIG } from "../types/rag.types";

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

  async generateEmbedding(text: string): Promise<EmbeddingResult> {
    try {
      const response = await this.embeddingClient.embeddings.create({
        model: RAG_CONFIG.EMBEDDING_MODEL,
        input: text.slice(0, 8000),
        encoding_format: "float",
      });

      const firstData = response.data[0];
      if (!firstData) {
        throw new Error("No embedding returned from OpenAI");
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
}
