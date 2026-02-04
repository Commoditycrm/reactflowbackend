import express from "express";
import { GraphQLError } from "graphql";
import { getFirebaseAdminAuth } from "../graphql/firebase/admin";
import logger from "../logger";
import { RAGService } from "../rag";
import { getTokenFromHeader } from "../util/tokenExtractor";

const ragRouter = express.Router();
const ragService = RAGService.getInstance();

const authenticateRequest = async (
  req: express.Request
): Promise<{ userId: string }> => {
  const token = getTokenFromHeader(req.headers.authorization);

  if (!token) {
    throw new GraphQLError("Authentication token is required", {
      extensions: { code: "UNAUTHENTICATED" },
    });
  }

  try {
    const decodedToken = await getFirebaseAdminAuth()
      .auth()
      .verifyIdToken(token, true);

    if (!decodedToken?.email_verified) {
      throw new GraphQLError("Please verify your email first", {
        extensions: { code: "EMAIL_NOT_VERIFIED" },
      });
    }

    return { userId: decodedToken.sub };
  } catch (error: any) {
    if (
      error?.code === "auth/id-token-revoked" ||
      error?.code === "auth/user-disabled"
    ) {
      throw new GraphQLError("Account has been disabled", {
        extensions: { code: "ACCOUNT_DELETED" },
      });
    }
    throw error;
  }
};

ragRouter.post("/ingest", async (req, res) => {
  try {
    const { userId } = await authenticateRequest(req);
    const { externalFileId, forceReprocess } = req.body;

    if (!externalFileId) {
      return res.status(400).json({
        success: false,
        error: "externalFileId is required",
      });
    }

    const result = await ragService.ingestDocument(
      externalFileId,
      userId,
      forceReprocess ?? false
    );

    return res.status(result.success ? 200 : 500).json(result);
  } catch (error: any) {
    logger?.error("RAG ingest endpoint failed", { error });

    const statusCode =
      error?.extensions?.code === "UNAUTHENTICATED" ? 401 : 500;

    return res.status(statusCode).json({
      success: false,
      error: error.message || "Internal server error",
    });
  }
});

ragRouter.post("/ingest-project", async (req, res) => {
  try {
    const { userId } = await authenticateRequest(req);
    const { projectId } = req.body;

    if (!projectId) {
      return res.status(400).json({
        success: false,
        error: "projectId is required",
      });
    }

    const result = await ragService.ingestProjectDocuments(projectId, userId);

    return res.status(200).json({
      success: true,
      ...result,
    });
  } catch (error: any) {
    logger?.error("RAG ingest-project endpoint failed", { error });

    const statusCode =
      error?.extensions?.code === "UNAUTHENTICATED" ? 401 : 500;

    return res.status(statusCode).json({
      success: false,
      error: error.message || "Internal server error",
    });
  }
});

ragRouter.get("/status/:projectId", async (req, res) => {
  try {
    const { userId } = await authenticateRequest(req);
    const { projectId } = req.params;

    if (!projectId) {
      return res.status(400).json({
        success: false,
        error: "projectId is required",
      });
    }

    const statuses = await ragService.getDocumentStatuses(projectId, userId);

    return res.status(200).json({
      success: true,
      documents: statuses,
    });
  } catch (error: any) {
    logger?.error("RAG status endpoint failed", { error });

    const statusCode =
      error?.extensions?.code === "UNAUTHENTICATED" ? 401 : 500;

    return res.status(statusCode).json({
      success: false,
      error: error.message || "Internal server error",
    });
  }
});

ragRouter.delete("/conversation/:conversationId", async (req, res) => {
  try {
    const { userId } = await authenticateRequest(req);
    const { conversationId } = req.params;

    const conversation = ragService.getConversation(conversationId);

    if (!conversation) {
      return res.status(404).json({
        success: false,
        error: "Conversation not found",
      });
    }

    if (conversation.userId !== userId) {
      return res.status(403).json({
        success: false,
        error: "Access denied",
      });
    }

    const deleted = ragService.clearConversation(conversationId);

    return res.status(200).json({
      success: deleted,
    });
  } catch (error: any) {
    logger?.error("RAG delete conversation endpoint failed", { error });

    const statusCode =
      error?.extensions?.code === "UNAUTHENTICATED" ? 401 : 500;

    return res.status(statusCode).json({
      success: false,
      error: error.message || "Internal server error",
    });
  }
});

export default ragRouter;
