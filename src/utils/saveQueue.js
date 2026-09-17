import { useEffect, useState } from "react";

// One-at-a-time queue for everything that writes to History.
//
// All of History is one shared file on the server, so two saves sent at the same
// moment compete for it. Sending this browser's saves strictly one after another
// removes that (the server's conditional-write check covers clashes with other
// people / tabs). Failed saves retry automatically; if they still fail they are
// kept in a "not saved" list the user can retry — never silently dropped.
//
// Job: { label, run: async () => result, onSuccess?(result), onFailure?(error), onRetry?() }.
// `run` should throw an Error with `.status` for HTTP failures (see httpError).

const RETRY_DELAYS_MS = [2000, 5000, 10000];

const queue = [];   // waiting + the one currently running (queue[0])
const failed = [];  // gave up after automatic retries; user can retry
const listeners = new Set();
let running = false;
let nextId = 1;

function snapshot() {
  return { pending: queue.length, failed: failed.length };
}
function notify() {
  const s = snapshot();
  listeners.forEach(fn => { try { fn(s); } catch {} });
}
function safeCall(fn, arg) {
  if (typeof fn === "function") { try { fn(arg); } catch (e) { console.error(e); } }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function waitUntilOnline() {
  if (typeof navigator === "undefined" || navigator.onLine !== false) return Promise.resolve();
  return new Promise(resolve => window.addEventListener("online", resolve, { once: true }));
}

// Network errors (no status), server errors and rate limits are worth retrying;
// 4xx answers like "not found" / "not allowed" won't change on a retry.
function isRetryable(err) {
  const s = err && err.status;
  return !s || s >= 500 || s === 429 || s === 408;
}

async function runJob(job) {
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await job.run();
      safeCall(job.onSuccess, result);
      return;
    } catch (err) {
      if (!isRetryable(err) || attempt >= RETRY_DELAYS_MS.length) {
        job.error = err;
        failed.push(job);
        safeCall(job.onFailure, err);
        return;
      }
      await waitUntilOnline();
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
}

async function pump() {
  if (running) return;
  running = true;
  notify();
  while (queue.length) {
    await runJob(queue[0]);
    queue.shift();
    notify();
  }
  running = false;
  notify();
}

export function enqueueSave(job) {
  queue.push({ ...job, id: nextId++ });
  notify();
  pump();
}

// Put every failed save back in the queue (same data — nothing is regenerated).
export function retryFailedSaves() {
  if (!failed.length) return;
  const jobs = failed.splice(0).map(j => ({ ...j, error: undefined }));
  jobs.forEach(j => safeCall(j.onRetry));
  queue.push(...jobs);
  notify();
  pump();
}

export function getSaveState() {
  return snapshot();
}

export function subscribeSaves(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSaveQueue() {
  const [state, setState] = useState(snapshot);
  useEffect(() => subscribeSaves(setState), []);
  return state;
}

// Error carrying the HTTP status, so the queue can tell retryable failures apart.
export function httpError(res, message) {
  return Object.assign(new Error(message || `Save failed (${res.status})`), { status: res.status });
}

// Warn before closing / refreshing the tab while saves are waiting or unsaved.
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", e => {
    if (queue.length || failed.length) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
}

// Test hook: clear all state (used by tests only).
export function __resetSaveQueueForTests() {
  queue.length = 0;
  failed.length = 0;
  running = false;
  listeners.clear();
}
