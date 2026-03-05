import { GraphQLError } from "graphql";
import logger from "../../logger";
import { RAGService } from "../../rag";

const ragService = RAGService.getInstance();

const ragChat = async (
  _source: Record<string, any>,
  {
    message,
    orgId,
    projectId,
    conversationId,
    maxChunks,
  }: {
    message: string;
    orgId: string;
    projectId?: string;
    conversationId?: string;
    maxChunks?: number;
  },
  context: Record<string, any>
) => {
  const userId = context?.jwt?.sub;
  if (!userId) {
    throw new GraphQLError("Authentication required", {
      extensions: { code: "UNAUTHENTICATED" },
    });
  }

  try {
    const response = await ragService.chat(
      message,
      orgId,
      userId,
      projectId,
      conversationId,
      maxChunks
    );

    logger?.info("ragChat resolver: returning response", {
      answerLength: response.answer?.length,
      sourcesCount: response.sources?.length,
      conversationId: response.conversationId,
    });

    return {
      answer: response.answer,
      sources: response.sources,
      conversationId: response.conversationId,
      metadata: {
        model: response.metadata.model,
        chunksUsed: response.metadata.chunksUsed,
        processingTimeMs: response.metadata.processingTimeMs,
        tokensUsed: response.metadata.tokensUsed,
      },
    };
  } catch (error) {
    logger?.error("ragChat resolver failed", { error, orgId, projectId, userId });
    throw new GraphQLError("Failed to process RAG chat request", {
      extensions: { code: "INTERNAL_SERVER_ERROR" },
    });
  }
};

const ragGetConversation = async (
  _source: Record<string, any>,
  { conversationId }: { conversationId: string },
  context: Record<string, any>
) => {
  const userId = context?.jwt?.sub;
  if (!userId) {
    throw new GraphQLError("Authentication required", {
      extensions: { code: "UNAUTHENTICATED" },
    });
  }

  const conversation = ragService.getConversation(conversationId);

  if (!conversation) return null;

  if (conversation.userId !== userId) {
    throw new GraphQLError("Access denied to this conversation", {
      extensions: { code: "FORBIDDEN" },
    });
  }

  return {
    id: conversation.id,
    orgId: conversation.orgId,
    projectId: conversation.projectId ?? null,
    messages: conversation.messages.map((m) => ({
      role: m.role,
      content: m.content,
      timestamp: m.timestamp.toISOString(),
    })),
    createdAt: conversation.createdAt.toISOString(),
    updatedAt: conversation.updatedAt?.toISOString(),
  };
};

const ragGetConversations = async (
  _source: Record<string, any>,
  { orgId, projectId, limit }: { orgId: string; projectId?: string; limit?: number },
  context: Record<string, any>
) => {
  const userId = context?.jwt?.sub;
  if (!userId) {
    throw new GraphQLError("Authentication required", {
      extensions: { code: "UNAUTHENTICATED" },
    });
  }

  const conversations = ragService.getConversations(
    orgId,
    userId,
    limit,
    projectId
  );

  return conversations.map((conv) => ({
    id: conv.id,
    orgId: conv.orgId,
    projectId: conv.projectId ?? null,
    messages: conv.messages.map((m) => ({
      role: m.role,
      content: m.content,
      timestamp: m.timestamp.toISOString(),
    })),
    createdAt: conv.createdAt.toISOString(),
    updatedAt: conv.updatedAt?.toISOString(),
  }));
};

const ragGetDocumentStatus = async (
  _source: Record<string, any>,
  { orgId, projectId }: { orgId: string; projectId?: string },
  context: Record<string, any>
) => {
  const userId = context?.jwt?.sub;
  if (!userId) {
    throw new GraphQLError("Authentication required", {
      extensions: { code: "UNAUTHENTICATED" },
    });
  }

  try {
    const statuses = await ragService.getDocumentStatuses(orgId, userId, projectId);

    return statuses.map((s) => ({
      documentId: s.documentId,
      documentName: s.documentName,
      status: s.status,
      totalChunks: s.totalChunks,
      indexedChunks: s.indexedChunks,
    }));
  } catch (error) {
    logger?.error("ragGetDocumentStatus resolver failed", {
      error,
      orgId,
      projectId,
      userId,
    });
    throw new GraphQLError("Failed to fetch document statuses", {
      extensions: { code: "INTERNAL_SERVER_ERROR" },
    });
  }
};

const ragSearchDocuments = async (
  _source: Record<string, any>,
  { query, orgId, projectId, topK }: { query: string; orgId: string; projectId?: string; topK?: number },
  context: Record<string, any>
) => {
  const userId = context?.jwt?.sub;
  if (!userId) {
    throw new GraphQLError("Authentication required", {
      extensions: { code: "UNAUTHENTICATED" },
    });
  }

  try {
    const results = await ragService.searchDocuments(
      query,
      orgId,
      userId,
      topK,
      projectId
    );

    return results.map((r) => ({
      documentId: r.documentId,
      documentName: r.documentName,
      pageNumber: r.pageNumber,
      relevanceScore: r.relevanceScore,
      snippet: r.snippet,
    }));
  } catch (error) {
    logger?.error("ragSearchDocuments resolver failed", {
      error,
      orgId,
      projectId,
      userId,
    });
    throw new GraphQLError("Failed to search documents", {
      extensions: { code: "INTERNAL_SERVER_ERROR" },
    });
  }
};

export const ragResolvers = {
  Query: {
    ragChat,
    ragGetConversation,
    ragGetConversations,
    ragGetDocumentStatus,
    ragSearchDocuments,
  },
};
