import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import type { Request, Response, NextFunction } from "express";
import logger from "../../logger";

function getClientIp(req: Request): string {
  const forwardedFor = req.headers["x-forwarded-for"];
  const realIp = req.headers["x-real-ip"];

  if (typeof forwardedFor === "string" && forwardedFor.trim()) {
    return forwardedFor.split(",")[0]?.trim() as string;
  }

  if (typeof realIp === "string" && realIp.trim()) {
    return realIp.trim();
  }

  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

const rateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
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

        const key = payload.sub ?? payload.uid;

        if (key) {
          return String(key);
        }
      } catch (err) {
        logger.warn(
          `Rate limit keyGenerator JWT parse failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    const rawIp = getClientIp(req);
    const ip = ipKeyGenerator(rawIp);

    logger.info(`Rate limit key (IP fallback): ${ip}`);

    return ip;
  },

  message: {
    error: "Too many requests. Please try again!",
  },

  handler: (req: Request, res: Response, next: NextFunction, options: any) => {
    const rawIp = getClientIp(req);

    logger.warn(
      `Blocked request by rate limiter: path=${req.path}, ip=${rawIp}, max=${options.max}`,
    );

    res.status(options.statusCode).json(options.message);
  },
});

export default rateLimiter;
