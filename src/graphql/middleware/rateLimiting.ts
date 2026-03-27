import { rateLimit } from "express-rate-limit";
import type { Request, Response, NextFunction } from "express";
import logger from "../../logger";

const rateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;

    if (token) {
      try {
        const payload = JSON.parse(
          Buffer.from(token.split(".")[1] ?? "", "base64").toString(),
        );
        const key = payload.sub ?? payload.uid ?? req.ip ?? "unknown";
        logger.info(`Rate limit key: ${key}`);
        return key;
      } catch (err) {
        logger.warn(
          `Rate limit keyGenerator JWT parse failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    const ip = req.ip ?? "unknown";
    logger.info(`Rate limit key (IP fallback): ${ip}`);
    return ip;
  },
  message: {
    error: "Too many requests. Please try again!",
  },
  handler: (req: Request, res: Response, next: NextFunction, options: any) => {
    logger.warn(
      `Blocked request by rate limiter: path=${req.path}, ip=${req.ip}, max=${options.max}`,
    );
    res.status(options.statusCode).json(options.message);
  },
});

export default rateLimiter;
