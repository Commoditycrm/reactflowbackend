// src/util/EnvLoader.ts
import logger from "../logger";

/**
 * Minimal, safe helpers to read env values AFTER loadDotenv() is called
 * at application start (in server.ts).
 */
export class EnvLoader {
  /**
   * Get an environment variable or undefined (no throw).
   */
  static get(key: string): string | undefined {
    return process.env[key] ?? undefined;
  }

  /**
   * Get an environment variable or throw an error if not set.
   */
  static getOrThrow(key: string): string {
    const value = process.env[key];
    if (!value) {
      // keep your existing behavior; change to logger.warn if you prefer
      logger?.info(key);
      throw new Error(`Environment variable "${key}" is missing.`);
    }
    return value;
  }

  /**
   * Get an env var, parse as integer, or undefined.
   */
  static getInt(key: string): number | undefined {
    const v = process.env[key];
    if (v == null || v === "") return undefined;
    const n = Number.parseInt(v, 10);
    return Number.isNaN(n) ? undefined : n;
  }

  /**
   * Get an env var, parse as integer, or throw if missing/invalid.
   */
  static getIntOrThrow(key: string): number {
    const v = EnvLoader.getOrThrow(key);
    const n = Number.parseInt(v, 10);
    if (Number.isNaN(n)) {
      throw new Error(`Environment variable "${key}" must be an integer.`);
    }
    return n;
  }

  /**
   * Get an env var, parse as boolean.
   * Truthy: "1","true","yes","on" (case-insensitive)
   * Falsy:  "0","false","no","off"  (case-insensitive)
   * Returns undefined if missing or unparseable.
   */
  static getBool(key: string): boolean | undefined {
    const v = process.env[key];
    if (!v) return undefined;
    const s = v.toLowerCase().trim();
    if (["1", "true", "yes", "on"].includes(s)) return true;
    if (["0", "false", "no", "off"].includes(s)) return false;
    return undefined;
  }

  /**
   * Verify a list of required env vars are present (throws on first miss).
   */
  static verify(requiredKeys: string[]) {
    for (const k of requiredKeys) {
      if (!process.env[k]) {
        throw new Error(`Missing environment variable "${k}"`);
      }
    }
  }

  /**
   * Firebase private key helper: replace escaped \n with real newlines.
   */
  static getFirebasePrivateKey(): string {
    const privateKey = EnvLoader.getOrThrow("FIREBASE_PRIVATE_KEY");
    return privateKey.replace(/\\n/g, "\n");
  }
}
