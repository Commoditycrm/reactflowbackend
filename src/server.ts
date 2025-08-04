import dotenv from "dotenv";
import express from "express";
import logger from "./logger";
import { createServer } from "http";
import { apiRouter } from "./routers";

dotenv.config();

const PORT = Number(process.env.PORT || 4000)
const app = express();

const httpServer = createServer(app);

(async () => {
  try {
    const router = await apiRouter(httpServer);
    app.use("/api", router);

    httpServer.listen(PORT, () => {
      logger?.info(`🚀 GraphQL running at http://localhost:${PORT}/api/graphql`);
    })
  } catch (err) {
    logger?.error("❌ Server failed to start:", err);
    process.exit(1);
  }
})();
