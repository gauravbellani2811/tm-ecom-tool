const { getJson, updateJson } = require("./storage");

// Append-only event log powering admin analytics. Single JSON object in R2 at a
// fixed key; appends use ETag-guarded writes so simultaneous generations don't
// drop each other's events.
const AUDIT_KEY = "fs-audit.json";
const RETENTION_DAYS = 90;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

function withinRetention(arr) {
  const cutoff = Date.now() - RETENTION_MS;
  return arr.filter(e => {
    const t = new Date(e.ts).getTime();
    return Number.isFinite(t) && t >= cutoff;
  });
}

async function readEvents() {
  try {
    const data = await getJson(AUDIT_KEY);
    return withinRetention(Array.isArray(data) ? data : []);
  } catch {
    return [];
  }
}

async function appendEvents(newEvents) {
  if (!newEvents || !newEvents.length) return;
  await updateJson(AUDIT_KEY, raw => {
    if (raw != null && !Array.isArray(raw)) throw new Error("Audit log is not a list — refusing to overwrite it");
    return [...withinRetention(raw || []), ...newEvents];
  });
}

module.exports = { readEvents, appendEvents, RETENTION_DAYS };
