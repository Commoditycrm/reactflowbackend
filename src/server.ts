import { loadDotenv, NODE_ENV } from "./env/detector";
const loadedEnvFile = loadDotenv();

import express from "express";
import helmet from "helmet";
import logger from "./logger";
import { createServer } from "http";
import cookieParser from "cookie-parser";
import initRoutes from "./routers";
import { EnvLoader } from "./util/EnvLoader";
import { corsMiddleware } from "./graphql/middleware/cors";

const PORT = EnvLoader.getInt("PORT") ?? 4000;

const ALLOW_ORIGINS = [
  EnvLoader.get("CLIENT_URL"),
  EnvLoader.get("ADMIN_PANEL_API"),
  EnvLoader.get("API_URL"),
].filter(Boolean) as string[];

logger?.info(
  `Env initialized: NODE_ENV=${NODE_ENV}` +
    (loadedEnvFile ? `, file=${loadedEnvFile}` : ", file=<process env / .env>")
);
logger?.info(`CORS allowlist: ${ALLOW_ORIGINS.join(", ") || "<empty>"}`);
const app = express();

// Number of reverse-proxy hops in front of us (Caddy/nginx/CDN). Without this,
// req.ip is the proxy's address and X-Forwarded-For is fully client-controlled,
// which makes the IP-based rate limiter trivially bypassable. Defaults to 1.
app.set("trust proxy", EnvLoader.getInt("TRUST_PROXY_HOPS") ?? 1);

const httpServer = createServer(app);

httpServer.keepAliveTimeout = 65_000;
httpServer.headersTimeout = 66_000;

// Middleware
// CSP is disabled so it doesn't block the (dev-only) Apollo sandbox; all other
// security headers (HSTS, X-Frame-Options, noSniff, etc.) stay on.
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cookieParser());
app.use(express.json());
app.use(corsMiddleware);

(async () => {
  try {
    const router = await initRoutes(httpServer);
    app.use("/api", router);

    httpServer.listen(PORT, () => {
      logger?.info(
        `🚀 GraphQL running at http://localhost:${PORT}/api/v1/graphql`
      );
    });

    const shutdown = () => {
      logger?.info("Shutting down server...");
      httpServer.close(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (err) {
    logger?.error(
      `Server failed to start: ${
        err instanceof Error ? err.stack || err.message : String(err)
      }`
    );
    process.exit(1);
  }
})();
