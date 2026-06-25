import Redis from "ioredis";
import { EnvLoader } from "../util/EnvLoader";
import logger from "../logger";

const REDIS_URL = EnvLoader.getOrThrow("REDIS_URL");

export const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 2,
  enableReadyCheck: true,
  lazyConnect: false,
});

// ioredis emits transport-level "error" events independently of command
// rejections; without a listener an unhandled error here can crash the process.
redis.on("error", (err) => {
  logger?.error("Redis client error", { error: err });
});
