import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { EnvLoader } from "../../util/EnvLoader";
import logger from "../../logger";

/**
 * Header carrying the shared secret for internal-only endpoints
 * (cron jobs and the GraphQL warm-up bypass).
 */
export const INTERNAL_SECRET_HEADER = "x-internal-secret";

/**
 * Constant-time comparison that never throws and is safe against
 * length-based timing leaks.
 */
const safeEqual = (a?: string, b?: string): boolean => {
  if (!a || !b) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
};

/**
 * Validates a provided secret against INTERNAL_API_SECRET.
 *
 * Fails closed: if INTERNAL_API_SECRET is not configured, no value is
 * ever accepted, so the protected behaviour stays disabled rather than
 * silently opening up.
 */
export const isValidInternalSecret = (
  provided: string | string[] | undefined
): boolean => {
  const expected = EnvLoader.get("INTERNAL_API_SECRET");
  if (!expected) return false;
  if (Array.isArray(provided)) return false;
  return safeEqual(provided, expected);
};

/**
 * Express middleware that rejects any request not carrying a valid
 * internal secret. Use to protect internal-only routers (e.g. cron).
 */
export const requireInternalSecret = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  if (isValidInternalSecret(req.headers[INTERNAL_SECRET_HEADER])) {
    next();
    return;
  }

  logger?.warn("Rejected internal endpoint request: invalid/missing secret", {
    path: req.originalUrl,
    ip: req.ip,
  });
  res.status(401).json({ message: "Unauthorized" });
};
