const { getJson, updateJson } = require("./storage");

// Template catalog stored as a single JSON object in R2 at a fixed key.
// Changes go through updateManifest (ETag-guarded) so simultaneous edits don't
// overwrite each other.
const MANIFEST_KEY = "fs-manifest.json";
const MAX_ACTIVE = 5;

// Deterministically give every entry an explicit `active` boolean.
// Legacy entries (missing `active`) fill the remaining active slots up to MAX_ACTIVE,
// in order, after accounting for entries that already opted in explicitly.
function normalizeActive(arr) {
  const explicitActiveCount = arr.filter(t => t.active === true).length;
  let availableSlots = Math.max(0, MAX_ACTIVE - explicitActiveCount);
  let changed = false;
  const normalized = arr.map(t => {
    if (typeof t.active === "boolean") return t;
    const shouldBeActive = availableSlots > 0;
    if (shouldBeActive) availableSlots--;
    changed = true;
    return { ...t, active: shouldBeActive };
  });
  return { normalized, changed };
}

async function readManifest() {
  try {
    const data = await getJson(MANIFEST_KEY);
    const { normalized, changed } = normalizeActive(Array.isArray(data) ? data : []);
    // One-time migration: persist explicit booleans so the backfill never
    // re-runs (otherwise toggling one entry could flip legacy entries).
    if (changed) { try { await updateManifest(() => undefined); } catch {} }
    return normalized;
  } catch {
    return [];
  }
}

// Apply a change to the catalog. `mutate(normalizedManifest)` returns the new array,
// or undefined for no change; it may run more than once, so no side effects (throw to
// abort). Returns the saved manifest.
async function updateManifest(mutate) {
  let saved = [];
  await updateJson(MANIFEST_KEY, async raw => {
    if (raw != null && !Array.isArray(raw)) throw new Error("Template manifest is not a list — refusing to overwrite it");
    const { normalized, changed } = normalizeActive(raw || []);
    const next = await mutate(normalized);
    if (next === undefined) {
      saved = normalized;
      return changed ? normalized : undefined;
    }
    saved = next;
    return next;
  });
  return saved;
}

module.exports = { readManifest, updateManifest, MAX_ACTIVE };
