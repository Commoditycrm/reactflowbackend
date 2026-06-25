import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import type { Request, Response, NextFunction } from "express";
import logger from "../../logger";

// Express computes req.ip from X-Forwarded-For according to the `trust proxy`
// setting (see server.ts). We rely on that instead of parsing the raw header
// ourselves -- reading the leftmost X-Forwarded-For entry directly is forgeable
// and lets an attacker get a fresh rate-limit bucket per request.
function getClientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

// Each call returns an independent limiter with its own in-memory bucket, so
// the GraphQL and REST limiters don't share/compound a single per-IP budget.
const buildLimiter = () =>
  rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,

    // Key by client IP only. We deliberately do NOT key off the JWT
    // `sub`/`uid`: this middleware runs before authentication, so the token is
    // unverified — trusting its claims would let an attacker forge a `sub` to
    // evade their own limit or get a victim rate-limited.
    keyGenerator: (req) => ipKeyGenerator(getClientIp(req)),

    message: {
      error: "Too many requests. Please try again!",
    },

    handler: (req: Request, res: Response, _next: NextFunction, options: any) => {
      logger.warn(
        `Blocked request by rate limiter: path=${req.path}, ip=${getClientIp(
          req,
        )}, max=${options.max}`,
      );
      res.status(options.statusCode).json(options.message);
    },
  });

// GraphQL limiter (mounted on the /graphql route in apollo.init).
const rateLimiter = buildLimiter();

// REST limiter (mounted on the REST sub-routers in apiRouters).
export const restRateLimiter = buildLimiter();

export default rateLimiter;
