// The browser save queue: one save at a time, in order, and no pick is ever dropped.
import test from "node:test";
import assert from "node:assert";
import { enqueueSave, retryFailedSaves, getSaveState, __resetSaveQueueForTests } from "../src/utils/saveQueue.js";

const tick = ms => new Promise(r => setTimeout(r, ms));
const until = async (cond, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error("timed out"); await tick(5); }
};

test("runs saves strictly one at a time, in order", async () => {
  __resetSaveQueueForTests();
  let inFlight = 0, maxInFlight = 0;
  const order = [];
  for (let i = 0; i < 6; i++) {
    enqueueSave({
      run: async () => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await tick(10 + Math.random() * 10); inFlight--; return i; },
      onSuccess: r => order.push(r),
    });
  }
  assert.strictEqual(getSaveState().pending, 6);
  await until(() => order.length === 6);
  assert.deepStrictEqual(order, [0, 1, 2, 3, 4, 5]);
  assert.strictEqual(maxInFlight, 1);
  assert.strictEqual(getSaveState().pending, 0);
});

test("a save that can't succeed doesn't block the next one, and is kept for Retry", async () => {
  __resetSaveQueueForTests();
  const done = [];
  let failures = 0;
  enqueueSave({
    run: async () => { throw Object.assign(new Error("not found"), { status: 404 }); }, // not retryable
    onFailure: () => failures++,
    onSuccess: () => done.push("first"),
  });
  enqueueSave({ run: async () => "ok", onSuccess: () => done.push("second") });
  await until(() => done.includes("second"));
  assert.strictEqual(failures, 1);
  assert.strictEqual(getSaveState().failed, 1);
});

test("Retry re-sends a failed save with the same data", async () => {
  __resetSaveQueueForTests();
  let attempts = 0, succeeded = false, retried = false;
  enqueueSave({
    run: async () => { attempts++; if (attempts === 1) throw Object.assign(new Error("forbidden"), { status: 403 }); return "saved"; },
    onSuccess: () => { succeeded = true; },
    onRetry: () => { retried = true; },
  });
  await until(() => getSaveState().failed === 1);
  retryFailedSaves();
  await until(() => succeeded);
  assert.ok(retried);
  assert.strictEqual(attempts, 2);
  assert.deepStrictEqual(getSaveState(), { pending: 0, failed: 0 });
});
