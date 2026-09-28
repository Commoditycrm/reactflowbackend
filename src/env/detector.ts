import fs from "fs";
import path from "path";
import * as dotenv from "dotenv";

export enum EnvState {
  PROD = "production",
  DEV = "development",
  STAGE = "staging",
}

export const NODE_ENV: EnvState | "test" =
  (process.env.NODE_ENV as EnvState | "test") ?? EnvState.DEV;

export const isProduction = () => NODE_ENV === EnvState.PROD;
export const isDevelopment = () => NODE_ENV === EnvState.DEV;
export const isLocal = () => !isProduction() && !isDevelopment();

let _resolvedPath: string | null | undefined;

export function getEnvFileName(): string | null {
  if (_resolvedPath !== undefined) return _resolvedPath;
  const candidate = `.env.${NODE_ENV || "development"}`;
  const full = path.resolve(process.cwd(), candidate);
  _resolvedPath = fs.existsSync(full) ? candidate : null;
  return _resolvedPath;
}

export function loadDotenv(): string | null {
  const envFile = getEnvFileName();
  if (envFile) dotenv.config({ path: envFile });
  else dotenv.config(); // fallback to .env if present
  sanitizeProcessEnv();
  return envFile;
}

// Docker's `--env-file` passes values verbatim — surrounding quotes and stray
// whitespace that dotenv would have stripped survive into process.env. That
// breaks strict consumers: Twilio rejects a `"AC..."` SID, and the session
// secret must match the frontend byte-for-byte or every GraphQL auth fails.
// Normalise once at boot so it no longer matters how the .env was written.
export function sanitizeProcessEnv(): void {
  for (const key of Object.keys(process.env)) {
    const raw = process.env[key];
    if (raw == null) continue;
    let v = raw.trim();
    if (v.length >= 2) {
      const first = v[0];
      const last = v[v.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        v = v.slice(1, -1);
      }
    }
    if (v !== raw) process.env[key] = v;
  }
}
