// Debounce orchestration for the Organization.lastModified "org-touch" that runs
// on every create/update of ~20 types. Pure + dependency-injected so the
// failure-safety guarantees are unit-testable without real Redis/Neo4j.
//
// Guarantees:
//  - Coalesces a user's rapid writes into at most one org-touch per window (NX lock).
//  - Fail-OPEN: if Redis is unavailable, the write still happens (no silent skip).
//  - A FAILED write is never masked by a held lock: the lock is released on error
//    so the next write retries the touch.
//  - OWNERSHIP-checked release: only the holder of the current token releases the
//    lock, so a successor's lock (acquired after a TTL-expiry race) is never
//    deleted by this writer's error handler.

export interface DebounceDeps {
  key: string;
  /** Unique per attempt; stored as the lock value so release can verify ownership. */
  token: string;
  windowSec: number;
  /** SET key token EX windowSec NX → "OK" when acquired, null when already held. */
  acquire: (key: string, token: string, windowSec: number) => Promise<string | null>;
  /** Compare-and-delete: remove the key only if it still holds `token`. */
  releaseIfOwner: (key: string, token: string) => Promise<unknown>;
  /** The actual org.lastModified write. */
  write: () => Promise<void>;
  onRedisError?: (e: unknown) => void;
}

export async function touchOrgLastModifiedDebounced(
  deps: DebounceDeps
): Promise<{ wrote: boolean }> {
  const { key, token, windowSec, acquire, releaseIfOwner, write, onRedisError } =
    deps;

  let acquired: string | null = "OK"; // fail-open default
  try {
    acquired = await acquire(key, token, windowSec);
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
    // Release OUR lock so a failed write is not hidden until the window expires,
    // but only if we still own it (never delete a successor's lock).
    try {
      await releaseIfOwner(key, token);
    } catch {
      /* best-effort release */
    }
    throw err;
  }
}
