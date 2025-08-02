import dotenv from "dotenv";
import express from "express";
import { initializeApolloServer } from "./graphql/init/apollo.init";
import logger from "./logger";

dotenv.config();

const HEALTH_PORT = Number(process.env.HEALTH_PORT || 8080);

(async () => {
  try {
    await initializeApolloServer();

    const app = express();

    app.get("/health", (_, res) => {
      res.status(200).json({ status: "ok" });
    });

    app.listen(HEALTH_PORT, () =>
      logger?.info(
        `✅ Health check running on http://localhost:${HEALTH_PORT}/health`
      )
    );
  } catch (err) {
    logger?.error("❌ Server failed to start:", err);
    process.exit(1);
  }
})();
