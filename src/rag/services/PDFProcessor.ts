import logger from "../../logger";
import { RAG_CONFIG } from "../types/rag.types";

export interface ProcessedChunk {
  content: string;
  pageNumber: number;
  chunkIndex: number;
  metadata?: Record<string, any>;
}

export interface PDFExtractionResult {
  text: string;
  pageTexts: string[];
  totalPages: number;
  metadata?: Record<string, any> | undefined;
}

export class PDFProcessor {
  private static instance: PDFProcessor;

  private constructor() {}

  static getInstance(): PDFProcessor {
    if (!PDFProcessor.instance) PDFProcessor.instance = new PDFProcessor();
    return PDFProcessor.instance;
  }

  async extractTextFromUrl(url: string): Promise<PDFExtractionResult> {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch PDF: ${response.statusText}`);
      }

      const buffer = await response.arrayBuffer();
      return this.extractTextFromBuffer(Buffer.from(buffer));
    } catch (error) {
      logger?.error("PDFProcessor.extractTextFromUrl failed", { error, url });
      throw error;
    }
  }

  async extractTextFromBuffer(buffer: Buffer): Promise<PDFExtractionResult> {
    let parser: any;
    try {
      // New pdf-parse (v2.x) exposes a PDFParse class instead of a default function
      const pdfParseModule = await import("pdf-parse");
      const PDFParseCtor =
        (pdfParseModule as any).PDFParse ??
        (pdfParseModule as any).default ??
        (pdfParseModule as any);

      if (typeof PDFParseCtor !== "function") {
        throw new Error("Unable to load pdf-parse parser constructor");
      }

      parser = new PDFParseCtor({ data: buffer });

      const textResult = await parser.getText();

      // Metadata is nice-to-have; do not fail the request if unavailable
      let infoResult: any;
      try {
        infoResult = await parser.getInfo();
      } catch (infoError) {
        logger?.warn?.("PDFProcessor.extractTextFromBuffer metadata fetch failed", {
          error: infoError,
        });
      }

      const pageTexts = textResult.pages?.map((p: any) => p?.text ?? "") ?? [];

      return {
        text: textResult.text ?? pageTexts.join("\n"),
        pageTexts,
        totalPages: textResult.total ?? pageTexts.length,
        metadata: infoResult
          ? {
              info: infoResult.info,
              metadata: infoResult.metadata,
            }
          : undefined,
      };
    } catch (error) {
      logger?.error("PDFProcessor.extractTextFromBuffer failed", { error });
      throw error;
    } finally {
      try {
        if (parser?.destroy) await parser.destroy();
      } catch (destroyError) {
        logger?.warn?.("PDFProcessor.extractTextFromBuffer destroy failed", {
          error: destroyError,
        });
      }
    }
  }

  private splitByPages(text: string, numPages: number): string[] {
    const lines = text.split("\n");
    const avgLinesPerPage = Math.ceil(lines.length / numPages);
    const pages: string[] = [];

    for (let i = 0; i < numPages; i++) {
      const start = i * avgLinesPerPage;
      const end = Math.min(start + avgLinesPerPage, lines.length);
      pages.push(lines.slice(start, end).join("\n"));
    }

    return pages;
  }

  chunkText(
    pageTexts: string[],
    chunkSize = RAG_CONFIG.CHUNK_SIZE,
    chunkOverlap = RAG_CONFIG.CHUNK_OVERLAP
  ): ProcessedChunk[] {
    const chunks: ProcessedChunk[] = [];
    let globalChunkIndex = 0;

    for (let pageNum = 0; pageNum < pageTexts.length; pageNum++) {
      const pageText = pageTexts[pageNum] ?? "";
      const pageChunks = this.chunkSingleText(
        pageText,
        chunkSize,
        chunkOverlap
      );

      for (const chunk of pageChunks) {
        chunks.push({
          content: chunk,
          pageNumber: pageNum + 1,
          chunkIndex: globalChunkIndex++,
          metadata: { pageNumber: pageNum + 1 },
        });
      }
    }

    return chunks;
  }

  private chunkSingleText(
    text: string,
    chunkSize: number,
    chunkOverlap: number
  ): string[] {
    const chunks: string[] = [];
    const sentences = this.splitIntoSentences(text);

    let currentChunk = "";

    for (const sentence of sentences) {
      if (
        currentChunk.length + sentence.length > chunkSize &&
        currentChunk.length > 0
      ) {
        chunks.push(currentChunk.trim());

        const words = currentChunk.split(" ");
        const overlapWords = words.slice(-Math.floor(chunkOverlap / 5));
        currentChunk = overlapWords.join(" ") + " " + sentence;
      } else {
        currentChunk += (currentChunk ? " " : "") + sentence;
      }
    }

    if (currentChunk.trim()) {
      chunks.push(currentChunk.trim());
    }

    return chunks.filter((c) => c.length > 50);
  }

  private splitIntoSentences(text: string): string[] {
    return text
      .replace(/\n+/g, " ")
      .replace(/\s+/g, " ")
      .split(/(?<=[.!?])\s+/)
      .filter((s) => s.trim().length > 0);
  }

  async processDocument(url: string): Promise<ProcessedChunk[]> {
    const extraction = await this.extractTextFromUrl(url);
    return this.chunkText(extraction.pageTexts);
  }
}
