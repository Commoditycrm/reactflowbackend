import dotenv from "dotenv";
import express from "express";
import logger from "./logger";
import { createServer } from "http";
import { apiRouter } from "./routers";
import cookieParser from "cookie-parser";
import bodyParser from 'body-parser'
import cors from 'cors'

dotenv.config();

const PORT = Number(process.env.PORT || 4000)
const app = express();

const httpServer = createServer(app);

(async () => {
  try {
    const router = await apiRouter(httpServer);
    app.use(cookieParser())
    app.use(bodyParser.json())
    app.use(cors({
      credentials: true,
      origin(requestOrigin, callback) {
        const allowOrigins = [process.env.CLIENT_URL, process.env.ADMIN_PANEL_API].filter(Boolean);
        if (!requestOrigin || allowOrigins.includes(requestOrigin)) {
          return callback(null, requestOrigin);
        } else {
          logger?.warn(`Blocked by CORS: ${requestOrigin}`);
          return callback(new Error("Not allowed by CORS"), false);
        }
      },
      methods: ["GET", "POST", "OPTIONS"],
      optionsSuccessStatus: 200
    }))
    app.use("/api", router);

    httpServer.listen(PORT, () => {
      logger?.info(`🚀 GraphQL running at http://localhost:${PORT}/api/graphql`);
    })
  } catch (err) {
    logger?.error(`Server failed to start:${err}`);
    process.exit(1);
  }
})();
