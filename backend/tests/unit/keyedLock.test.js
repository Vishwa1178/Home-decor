"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { withKeyedLock, pendingKeys } = require("../../src/utils/keyedLock");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("withKeyedLock", () => {
  test("functions with the same key never overlap and run in arrival order", async () => {
    let running = 0;
    let maxRunning = 0;
    const order = [];
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        withKeyedLock("slot-a", async () => {
          running++;
          maxRunning = Math.max(maxRunning, running);
          await sleep(Math.random() * 5);
          order.push(i);
          running--;
        })
      )
    );
    assert.equal(maxRunning, 1, "never two at once for one key");
    assert.deepEqual(order, Array.from({ length: 20 }, (_, i) => i), "FIFO");
  });

  test("different keys run concurrently", async () => {
    let running = 0;
    let maxRunning = 0;
    await Promise.all(
      ["a", "b", "c", "d"].map((k) =>
        withKeyedLock(k, async () => {
          running++;
          maxRunning = Math.max(maxRunning, running);
          await sleep(20);
          running--;
        })
      )
    );
    assert.equal(maxRunning, 4);
  });

  test("returns the function's value", async () => {
    assert.equal(await withKeyedLock("v", async () => 42), 42);
  });

  test("a failing holder rejects its own caller but does not block or poison the queue", async () => {
    const results = await Promise.allSettled([
      withKeyedLock("err", async () => { await sleep(5); throw new Error("boom"); }),
      withKeyedLock("err", async () => "second"),
      withKeyedLock("err", async () => { throw new Error("boom again"); }),
      withKeyedLock("err", async () => "fourth"),
    ]);
    assert.deepEqual(results.map((r) => r.status), ["rejected", "fulfilled", "rejected", "fulfilled"]);
    assert.equal(results[1].value, "second");
    assert.equal(results[3].value, "fourth");
  });

  test("synchronous throws are handled too", async () => {
    await assert.rejects(withKeyedLock("sync", () => { throw new Error("sync boom"); }), /sync boom/);
    assert.equal(await withKeyedLock("sync", async () => "still works"), "still works");
  });

  test("entries are cleaned up once the queue drains (no memory growth)", async () => {
    const before = pendingKeys();
    await Promise.all(Array.from({ length: 50 }, (_, i) => withKeyedLock(`k${i % 5}`, async () => sleep(1))));
    await sleep(5);
    assert.equal(pendingKeys(), before);
  });

  test("a long queue behind one key drains completely", async () => {
    let done = 0;
    await Promise.all(Array.from({ length: 200 }, () => withKeyedLock("long", async () => { done++; })));
    assert.equal(done, 200);
    assert.equal(pendingKeys(), 0);
  });
});
