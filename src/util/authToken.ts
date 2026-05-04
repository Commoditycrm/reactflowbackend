// utils/authToken.ts
import { Request } from "express";

export function getAuthTokens(req: Request) {
  const cookieHeader = req.get("cookie");
  const authHeader = req.get("authorization");

  const sessionToken = getCookieValue(cookieHeader ?? undefined, "session");
  const headerToken = getTokenFromHeader(authHeader ?? undefined);

  return {
    sessionToken,
    headerToken,
  };
}

// ---- helpers ----

function getTokenFromHeader(authHeader?: string): string | null {
  if (!authHeader) return null;

  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") return null;

  return parts[1] ?? null;
}

function getCookieValue(
  cookieHeader: string | undefined,
  name: string,
): string | null {
  if (!cookieHeader) return null;

  const cookies = cookieHeader.split(";");

  for (const cookie of cookies) {
    const [key, ...rest] = cookie.trim().split("=");

    if (key === name) {
      return decodeURIComponent(rest.join("="));
    }
  }

  return null;
}
