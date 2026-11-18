import { test } from "node:test";
import assert from "node:assert/strict";
import { touchOrgLastModifiedDebounced } from "../../src/graphql/callbacks/orgLastModifiedDebounce";

const base = () => {
  const calls = { setNx: 0, del: 0, write: 0 };
  return { calls };
};

test("first write in a window acquires the lock and performs the touch", async () => {
  const { calls } = base();
  const res = await touchOrgLastModifiedDebounced({
    key: "org-lastmod:u1",
    windowSec: 15,
    redisSetNx: async () => { calls.setNx++; return "OK"; },
    redisDel: async () => { calls.del++; },
    write: async () => { calls.write++; },
  });
  assert.deepEqual(res, { wrote: true });
  assert.equal(calls.write, 1);
  assert.equal(calls.del, 0); // lock kept for the window on success
});

test("a second write within the window is debounced (no extra touch)", async () => {
  const { calls } = base();
  const res = await touchOrgLastModifiedDebounced({
    key: "org-lastmod:u1",
    windowSec: 15,
    redisSetNx: async () => { calls.setNx++; return null; }, // key already held
    redisDel: async () => { calls.del++; },
    write: async () => { calls.write++; },
  });
  assert.deepEqual(res, { wrote: false });
  assert.equal(calls.write, 0); // redundant write skipped
});

test("a FAILED write releases the lock (failure is not masked) and rethrows", async () => {
  const { calls } = base();
  await assert.rejects(
    touchOrgLastModifiedDebounced({
      key: "org-lastmod:u1",
      windowSec: 15,
      redisSetNx: async () => { calls.setNx++; return "OK"; },
      redisDel: async () => { calls.del++; },
      write: async () => { calls.write++; throw new Error("neo4j down"); },
    }),
    /neo4j down/
  );
  assert.equal(calls.write, 1);
  assert.equal(calls.del, 1); // lock released so the next write retries
});

test("fail-open: if Redis SET throws, the write still happens", async () => {
  const { calls } = base();
  let redisErr: unknown = null;
  const res = await touchOrgLastModifiedDebounced({
    key: "org-lastmod:u1",
    windowSec: 15,
    redisSetNx: async () => { calls.setNx++; throw new Error("redis down"); },
    redisDel: async () => { calls.del++; },
    write: async () => { calls.write++; },
    onRedisError: (e) => { redisErr = e; },
  });
  assert.deepEqual(res, { wrote: true });
  assert.equal(calls.write, 1); // not silently skipped when Redis is unavailable
  assert.ok(redisErr instanceof Error);
});

test("a failing redisDel during error handling still rethrows the original write error", async () => {
  await assert.rejects(
    touchOrgLastModifiedDebounced({
      key: "org-lastmod:u1",
      windowSec: 15,
      redisSetNx: async () => "OK",
      redisDel: async () => { throw new Error("del failed"); },
      write: async () => { throw new Error("original write error"); },
    }),
    /original write error/
  );
});
