import logger from "../../logger";
import { EnvLoader } from "../../util/EnvLoader";
import { RAG_CONFIG } from "../types/rag.types";

/**
 * Lightweight Gemini API client for diagram summarization.
 * Uses the REST API directly to avoid adding a heavy SDK dependency.
 * Gemini Flash is free-tier and ideal for fast summarizations.
 */
export class GeminiService {
  private static instance: GeminiService;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl = "https://generativelanguage.googleapis.com/v1beta";

  private constructor() {
    this.apiKey = EnvLoader.getOrThrow("GEMINI_API_KEY");
    this.model = RAG_CONFIG.GEMINI_SUMMARIZATION_MODEL;
  }

  static getInstance(): GeminiService {
    if (!GeminiService.instance) GeminiService.instance = new GeminiService();
    return GeminiService.instance;
  }

  /**
   * Generate content using Gemini Flash.
   */
  async generateContent(prompt: string): Promise<string> {
    const url = `${this.baseUrl}/models/${this.model}:generateContent?key=${this.apiKey}`;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: prompt }],
            },
          ],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 1024,
            topP: 0.8,
          },
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(
          `Gemini API error ${response.status}: ${errorBody}`
        );
      }

      const data = (await response.json()) as {
        candidates?: Array<{
          content?: { parts?: Array<{ text?: string }> };
        }>;
      };

      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        throw new Error("No text returned from Gemini API");
      }

      return text.trim();
    } catch (error) {
      logger?.error("GeminiService.generateContent failed", { error });
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
