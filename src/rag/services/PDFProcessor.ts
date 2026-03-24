import logger from "../../logger";
import { RAG_CONFIG } from "../types/rag.types";
import * as XLSX from "xlsx";

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

  private detectDocumentType(url: string, fileType?: string, fileName?: string): string {
    const type = (fileType ?? "").toLowerCase();
    const extFromName = (fileName ?? "").split(".").pop()?.toLowerCase();

    let extFromUrl: string | undefined;
    try {
      const pathname = new URL(url).pathname;
      extFromUrl = pathname.split(".").pop()?.toLowerCase();
    } catch {
      extFromUrl = undefined;
    }

    if (type.includes("pdf") || extFromName === "pdf" || extFromUrl === "pdf") return "pdf";
    if (
      type.includes("wordprocessingml") ||
      type.includes("docx") ||
      extFromName === "docx" ||
      extFromUrl === "docx"
    ) {
      return "docx";
    }
    if (type.includes("msword") || extFromName === "doc" || extFromUrl === "doc") return "doc";
    if (
      type.includes("spreadsheetml") ||
      type.includes("excel") ||
      extFromName === "xlsx" ||
      extFromUrl === "xlsx"
    ) {
      return "xlsx";
    }
    if (type.includes("markdown") || extFromName === "md" || extFromUrl === "md") return "md";
    if (type.includes("csv") || extFromName === "csv" || extFromUrl === "csv") return "csv";
    if (type.includes("json") || extFromName === "json" || extFromUrl === "json") return "json";
    if (type.startsWith("text/") || extFromName === "txt" || extFromUrl === "txt") return "txt";

    return extFromName ?? extFromUrl ?? "txt";
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

  async extractTextFromTextLikeUrl(url: string): Promise<PDFExtractionResult> {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch text document: ${response.statusText}`);
      }

      const text = await response.text();
      return {
        text,
        pageTexts: [text],
        totalPages: 1,
      };
    } catch (error) {
      logger?.error("PDFProcessor.extractTextFromTextLikeUrl failed", { error, url });
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

  async extractDocxFromBuffer(buffer: Buffer): Promise<PDFExtractionResult> {
    try {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({ buffer });
      const text = (result.value ?? "").trim();

      if (!text) {
        throw new Error("DOCX extraction produced empty text");
      }

      return {
        text,
        pageTexts: [text],
        totalPages: 1,
        metadata: result.messages?.length
          ? { warnings: result.messages.map((m) => m.message) }
          : undefined,
      };
    } catch (error) {
      logger?.error("PDFProcessor.extractDocxFromBuffer failed", { error });
      throw error;
    }
  }

  async extractXlsxFromBuffer(buffer: Buffer): Promise<PDFExtractionResult> {
    try {
      const workbook = XLSX.read(buffer, { type: "buffer" });
      const pageTexts = workbook.SheetNames.map((sheetName) => {
        const sheet = workbook.Sheets[sheetName];
        if (!sheet) return "";
        const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false }).trim();
        if (!csv) return "";
        return `Sheet: ${sheetName}\n${csv}`;
      }).filter((t) => t.length > 0);

      if (pageTexts.length === 0) {
        throw new Error("XLSX extraction produced empty text");
      }

      return {
        text: pageTexts.join("\n\n"),
        pageTexts,
        totalPages: pageTexts.length,
      };
    } catch (error) {
      logger?.error("PDFProcessor.extractXlsxFromBuffer failed", { error });
      throw error;
    }
  }

  async extractLegacyDocFromBuffer(buffer: Buffer): Promise<PDFExtractionResult> {
    // Best-effort fallback for legacy .doc without external converters.
    const text = buffer
      .toString("utf8")
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (text.length < 100) {
      throw new Error("Legacy .doc parsing is not fully supported. Convert to DOCX for best results.");
    }

    return {
      text,
      pageTexts: [text],
      totalPages: 1,
      metadata: { parser: "legacy-doc-fallback" },
    };
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

  async processDocument(
    url: string,
    fileType?: string,
    fileName?: string
  ): Promise<ProcessedChunk[]> {
    const docType = this.detectDocumentType(url, fileType, fileName);
    let extraction: PDFExtractionResult;

    if (docType === "pdf") {
      extraction = await this.extractTextFromUrl(url);
    } else if (docType === "docx" || docType === "xlsx" || docType === "doc") {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch document: ${response.statusText}`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());

      if (docType === "docx") {
        extraction = await this.extractDocxFromBuffer(buffer);
      } else if (docType === "xlsx") {
        extraction = await this.extractXlsxFromBuffer(buffer);
      } else {
        extraction = await this.extractLegacyDocFromBuffer(buffer);
      }
    } else {
      extraction = await this.extractTextFromTextLikeUrl(url);
    }

    return this.chunkText(extraction.pageTexts);
  }
}
