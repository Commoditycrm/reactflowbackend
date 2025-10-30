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
  return envFile;
}
