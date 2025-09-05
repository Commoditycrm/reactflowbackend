import dotenv from "dotenv";
import express from "express";
import logger from "./logger";
import { createServer } from "http";
import cookieParser from "cookie-parser";
import cors from "cors";
import initRoutes from "./routers";

dotenv.config();

const PORT = Number(process.env.PORT || 4000);
const app = express();

const httpServer = createServer(app);

httpServer.keepAliveTimeout = 65_000;
httpServer.headersTimeout = 66_000;

// Middleware
app.use(cookieParser());
app.use(express.json());
app.use(cors());

(async () => {
  try {
    const router = await initRoutes(httpServer);
    app.use("/api", router);

    httpServer.listen(PORT, () => {
      logger?.info(
        `🚀 GraphQL running at http://localhost:${PORT}/api/v1/graphql`
      );
    });

    process.on("SIGINT", () => {
      logger?.info("Shutting down server...");
      httpServer.close(() => process.exit(0));
    });
  } catch (err) {
    logger?.error(`Server failed to start: ${err}`);
    process.exit(1);
  }
})();
