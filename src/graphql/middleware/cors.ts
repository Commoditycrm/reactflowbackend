import cors from "cors";
import { EnvLoader } from "../../util/EnvLoader";
import logger from "../../logger";

// Build allowlist once
const ALLOW_ORIGINS = new Set(
  [
    EnvLoader.get("CLIENT_URL"),
    EnvLoader.get("ADMIN_PANEL_API"),
    EnvLoader.get("API_URL"),
  ].filter(Boolean) as string[]
);


export const corsMiddleware = cors({
  credentials: true,
  methods: ["GET", "POST", "OPTIONS"],
  optionsSuccessStatus: 204,

  origin(origin, callback) {
    try {
      if (!origin) return callback(null, true);

      if (ALLOW_ORIGINS.has(origin)) {
        return callback(null, true);
      }

      logger?.warn(`Blocked by CORS: ${origin}`);
      return callback(new Error("Not allowed by CORS"));
    } catch (e) {
      return callback(new Error("Internal CORS check error"));
    }
  },
});
