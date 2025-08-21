import dotenv from "dotenv";
import express, { Response, Request, ErrorRequestHandler } from "express";
import logger from "./logger";
import { createServer } from "http";
import { apiRouter } from "./routers";
import cookieParser from "cookie-parser";
import cors from "cors";

dotenv.config();

const PORT = Number(process.env.PORT || 4000);
const app = express();

const httpServer = createServer(app);

// Middleware
app.use(cookieParser());
app.use(express.json());
app.use(
  cors({
    credentials: true,
    origin(requestOrigin, callback) {
      const allowOrigins = [
        process.env.CLIENT_URL,
        process.env.ADMIN_PANEL_API,
        process.env.API_URL,
      ].filter(Boolean);
      if (!requestOrigin || allowOrigins.includes(requestOrigin)) {
        return callback(null, requestOrigin || true);
      }
      logger?.warn(`Blocked by CORS: ${requestOrigin}`);
      return callback(new Error("Not allowed by CORS"), false);
    },
    methods: ["POST", "GET", "OPTIONS"],
    optionsSuccessStatus: 200,
  })
);

(async () => {
  try {
    const router = await apiRouter(httpServer);
    app.use("/api/v1", router);

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
