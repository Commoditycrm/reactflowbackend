import { test } from "node:test";
import assert from "node:assert/strict";
import { touchOrgLastModifiedDebounced } from "../../src/graphql/callbacks/orgLastModifiedDebounce";

// A fake Redis that models SET NX EX + ownership-checked compare-and-delete,
// so the "never delete a successor's lock" guarantee is exercised directly.
const makeRedis = () => {
  const store = new Map<string, string>();
  return {
    store,
    acquire: async (key: string, token: string, _sec: number) =>
      store.has(key) ? null : (store.set(key, token), "OK"),
    releaseIfOwner: async (key: string, token: string) => {
      if (store.get(key) === token) {
        store.delete(key);
        return 1;
      }
      return 0;
    },
  };
};

test("first write acquires the lock with its token and performs the touch", async () => {
  const r = makeRedis();
  let wrote = 0;
  const res = await touchOrgLastModifiedDebounced({
    key: "org-lastmod:u1",
    token: "tok-A",
    windowSec: 15,
    acquire: r.acquire,
    releaseIfOwner: r.releaseIfOwner,
    write: async () => { wrote++; },
  });
  assert.deepEqual(res, { wrote: true });
  assert.equal(wrote, 1);
  assert.equal(r.store.get("org-lastmod:u1"), "tok-A"); // lock held for the window
});

test("a second write within the window is debounced (no extra touch)", async () => {
  const r = makeRedis();
  r.store.set("org-lastmod:u1", "tok-A"); // already held
  let wrote = 0;
  const res = await touchOrgLastModifiedDebounced({
    key: "org-lastmod:u1",
    token: "tok-B",
    windowSec: 15,
    acquire: r.acquire,
    releaseIfOwner: r.releaseIfOwner,
    write: async () => { wrote++; },
  });
  assert.deepEqual(res, { wrote: false });
  assert.equal(wrote, 0);
});

test("a FAILED write releases OUR lock (failure not masked) and rethrows", async () => {
  const r = makeRedis();
  await assert.rejects(
    touchOrgLastModifiedDebounced({
      key: "org-lastmod:u1",
      token: "tok-A",
      windowSec: 15,
      acquire: r.acquire,
      releaseIfOwner: r.releaseIfOwner,
      write: async () => { throw new Error("neo4j down"); },
    }),
    /neo4j down/
  );
  assert.equal(r.store.has("org-lastmod:u1"), false); // released → next write retries
});

test("ownership-checked release does NOT delete a successor's lock (TTL-expiry race)", async () => {
  const r = makeRedis();
  // Writer A acquires, then (simulating TTL expiry) writer B takes the key.
  await assert.rejects(
    touchOrgLastModifiedDebounced({
      key: "org-lastmod:u1",
      token: "tok-A",
      windowSec: 15,
      acquire: r.acquire,
      releaseIfOwner: r.releaseIfOwner,
      write: async () => {
        r.store.set("org-lastmod:u1", "tok-B"); // B's lock now owns the key
        throw new Error("A's neo4j write failed");
      },
    }),
    /A's neo4j write failed/
  );
  // A's error handler must NOT delete B's lock.
  assert.equal(r.store.get("org-lastmod:u1"), "tok-B");
});

test("fail-open: if acquire throws, the write still happens", async () => {
  let wrote = 0;
  let redisErr: unknown = null;
  const res = await touchOrgLastModifiedDebounced({
    key: "org-lastmod:u1",
    token: "tok-A",
    windowSec: 15,
    acquire: async () => { throw new Error("redis down"); },
    releaseIfOwner: async () => 0,
    write: async () => { wrote++; },
    onRedisError: (e) => { redisErr = e; },
  });
  assert.deepEqual(res, { wrote: true });
  assert.equal(wrote, 1);
  assert.ok(redisErr instanceof Error);
});

test("a failing release during error handling still rethrows the original write error", async () => {
  await assert.rejects(
    touchOrgLastModifiedDebounced({
      key: "org-lastmod:u1",
      token: "tok-A",
      windowSec: 15,
      acquire: async () => "OK",
      releaseIfOwner: async () => { throw new Error("release failed"); },
      write: async () => { throw new Error("original write error"); },
    }),
    /original write error/
  );
});

test("concurrent writers in the same window: exactly one touches (shared Redis across instances)", async () => {
  const r = makeRedis();
  let touches = 0;
  const run = (token: string) =>
    touchOrgLastModifiedDebounced({
      key: "org-lastmod:u1",
      token,
      windowSec: 15,
      acquire: r.acquire,
      releaseIfOwner: r.releaseIfOwner,
      write: async () => { touches++; },
    });
  const results = await Promise.all([run("tok-A"), run("tok-B"), run("tok-C")]);
  assert.equal(touches, 1); // only the NX winner writes
  assert.equal(results.filter((x) => x.wrote).length, 1);
});
