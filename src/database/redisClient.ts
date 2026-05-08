import Redis from "ioredis";
import { EnvLoader } from "../util/EnvLoader";

const REDIS_URL = EnvLoader.getOrThrow("REDIS_URL");

export const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 2,
  enableReadyCheck: true,
  lazyConnect: false,
});
