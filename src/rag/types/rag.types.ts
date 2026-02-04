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
  EMBEDDING_MODEL: "text-embedding-3-small",
  EMBEDDING_DIMENSIONS: 1536,
  CHAT_MODEL: "gpt-4o-mini",
  MAX_CONTEXT_CHUNKS: 5,
  MIN_RELEVANCE_SCORE: 0.7,
  MAX_TOKENS: 4000,
  VECTOR_INDEX_NAME: "document_embeddings",
} as const;
