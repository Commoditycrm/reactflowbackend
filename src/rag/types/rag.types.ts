export interface DocumentChunk {
  id: string;
  content: string;
  embedding: number[];
  pageNumber: number;
  chunkIndex: number;
  metadata?: Record<string, any>;
  createdAt: Date;
}

export interface RAGQueryResult {
  content: string;
  score: number;
  source: string;
  pageNumber: number;
  documentId: string;
}

export interface RAGChatRequest {
  message: string;
  projectId: string;
  conversationId?: string;
  maxChunks?: number;
}

export interface RAGChatResponse {
  answer: string;
  sources: RAGSource[];
  conversationId: string;
  metadata: RAGResponseMetadata;
}

export interface RAGSource {
  documentId: string;
  documentName: string;
  pageNumber: number;
  relevanceScore: number;
  snippet: string;
}

export interface RAGResponseMetadata {
  model: string;
  chunksUsed: number;
  processingTimeMs: number;
  tokensUsed?: number;
}

export interface ConversationMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: Date;
}

export interface Conversation {
  id: string;
  userId: string;
  projectId: string;
  messages: ConversationMessage[];
  createdAt: Date;
  updatedAt: Date;
}

export interface PDFProcessingResult {
  documentId: string;
  totalPages: number;
  totalChunks: number;
  success: boolean;
  error?: string;
}

export interface IngestionRequest {
  externalFileId: string;
  projectId: string;
  forceReprocess?: boolean;
}

export interface IngestionResponse {
  success: boolean;
  documentId: string;
  chunksCreated: number;
  processingTimeMs: number;
  error?: string;
}

export interface VectorSearchOptions {
  topK?: number;
  minScore?: number;
  projectId: string;
  userId: string;
  orgId: string;
}

export interface EmbeddingResult {
  embedding: number[];
  model: string;
  tokensUsed: number;
}

export const RAG_CONFIG = {
  CHUNK_SIZE: 1000,
  CHUNK_OVERLAP: 200,
  
  // Embedding config (local Qwen model via ngrok)
  EMBEDDING_MODEL: "text-embedding-qwen3-embedding-0.6b",
  EMBEDDING_DIMENSIONS: 1024,
  EMBEDDING_BASE_URL: process.env.EMBEDDING_BASE_URL || "https://unmodelled-marquis-nonexpulsive.ngrok-free.dev/v1",
  
  // Chat/LLM config (Groq API with Llama-4)
  CHAT_MODEL: "meta-llama/llama-4-scout-17b-16e-instruct",
  CHAT_BASE_URL: process.env.CHAT_BASE_URL || "https://api.groq.com/openai/v1",
  SUMMARIZATION_MODEL: "meta-llama/llama-4-scout-17b-16e-instruct",
  
  MAX_CONTEXT_CHUNKS: 5,
  MIN_RELEVANCE_SCORE: 0.7,
  MAX_TOKENS: 4000,
  VECTOR_INDEX_NAME: "document_embeddings",
  DIAGRAM_SUMMARY_EMBEDDING_DIMENSIONS: 1024,
  DIAGRAM_SUMMARY_INDEX_NAME: "diagram_summary_embeddings",
} as const;

// ─── Diagram Types ───────────────────────────────────────────────────────────

export interface DiagramNode {
  id: string;
  name: string;
  shape: string;
  color: string;
  posX: number;
  posY: number;
  width: number;
  height: number;
  type: string;
  description: string | null;
  parentGroupId: string | null;
  childItemCount: number;
  fileLinksCount: number;
  commentsCount: number;
}

export interface DiagramEdge {
  id: string;
  sourceId: string;
  targetId: string;
  sourceName: string;
  targetName: string;
  label: string;
  color: string;
  sourceHandle: string;
  targetHandle: string;
  animated: boolean;
  bidirectional: boolean;
}

export interface DiagramGroup {
  id: string;
  name: string;
  posX: number;
  posY: number;
  width: number;
  height: number;
  color: string | null;
  layoutType: string;
  childNodeIds: string[];
}

export interface DiagramData {
  fileId: string;
  fileName: string;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  groups: DiagramGroup[];
}

export interface DiagramSummary {
  fileId: string;
  fileName: string;
  nodeCount: number;
  edgeCount: number;
  groupCount: number;
  summary: string;
}

export interface DiagramListItem {
  fileId: string;
  fileName: string;
  nodeCount: number;
  edgeCount: number;
  groupCount: number;
  hasSummaryEmbedding: boolean;
}

export interface ToolCallResult {
  toolName: string;
  content: string;
}

export interface DiagramSearchResult {
  fileId: string;
  fileName: string;
  score: number;
  summary: string;
}
