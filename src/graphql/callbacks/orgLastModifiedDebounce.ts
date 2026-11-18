// Debounce orchestration for the Organization.lastModified "org-touch" that runs
// on every create/update of ~20 types. Pure + dependency-injected so the
// failure-safety guarantees are unit-testable without real Redis/Neo4j.
//
// Guarantees:
//  - Coalesces a user's rapid writes into at most one org-touch per window (NX lock).
//  - Fail-OPEN: if Redis is unavailable, the write still happens (no silent skip).
//  - A FAILED write is never masked by a held lock: the key is released on error
//    so the next write retries the touch.

export interface DebounceDeps {
  key: string;
  windowSec: number;
  /** SET key 1 EX windowSec NX → "OK" when acquired, null when already held. */
  redisSetNx: (key: string, windowSec: number) => Promise<string | null>;
  redisDel: (key: string) => Promise<unknown>;
  /** The actual org.lastModified write. */
  write: () => Promise<void>;
  onRedisError?: (e: unknown) => void;
}

export async function touchOrgLastModifiedDebounced(
  deps: DebounceDeps
): Promise<{ wrote: boolean }> {
  const { key, windowSec, redisSetNx, redisDel, write, onRedisError } = deps;

  let acquired: string | null = "OK"; // fail-open default
  try {
    acquired = await redisSetNx(key, windowSec);
  } catch (e) {
    onRedisError?.(e);
    acquired = "OK"; // Redis down → do the write anyway
  }

  if (acquired !== "OK") {
    return { wrote: false }; // debounced by a recent write in this window
  }

  try {
    await write();
    return { wrote: true };
  } catch (err) {
    // Release the lock so a failed write is not hidden until the window expires.
    try {
      await redisDel(key);
    } catch {
      /* best-effort release */
    }
    throw err;
  }
}
