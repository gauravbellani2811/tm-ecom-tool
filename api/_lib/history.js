const { getJson, updateJson, deleteKeys, urlToKey } = require("./storage");
const { imageBlobUrls } = require("./thumbs");

// History stored as a single JSON object in R2 at a fixed key. Image objects live
// under fs-history/. Reads are plain; every change goes through updateHistory(),
// which uses ETag-guarded writes so simultaneous saves never overwrite each other.
const HISTORY_KEY = "fs-history.json";
const RETENTION_DAYS = 10;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

function isExpired(record) {
  const t = new Date(record.createdAt).getTime();
  return !Number.isFinite(t) || Date.now() - t > RETENTION_MS;
}

const newestFirst = records => records.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

// Read-only: live (unexpired) runs, newest first. Throws if R2 can't be read.
async function readHistory() {
  const data = await getJson(HISTORY_KEY);
  const arr = Array.isArray(data) ? data : [];
  return newestFirst(arr.filter(r => !isExpired(r)));
}

// Apply a change to History safely. `mutate(liveRecords)` returns
// { records, deleteUrls? } to save, or undefined for "nothing to change"; it may run
// more than once (on a conflicting save), so it must not have side effects — throw
// to abort. Expired runs are pruned on every save. Image blobs (from expired runs +
// deleteUrls) are deleted only after the write succeeded. Returns the saved records,
// newest first.
async function updateHistory(mutate) {
  let blobs = [];
  let saved = [];
  const { changed } = await updateJson(HISTORY_KEY, async raw => {
    if (raw != null && !Array.isArray(raw)) throw new Error("History file is not a list — refusing to overwrite it");
    const arr = raw || [];
    blobs = [];
    const live = [];
    for (const rec of arr) {
      if (isExpired(rec)) (rec.images || []).forEach(im => blobs.push(...imageBlobUrls(im)));
      else live.push(rec);
    }
    const result = await mutate(live);
    if (result === undefined) {
      saved = live;
      return live.length !== arr.length ? live : undefined; // still persist a prune
    }
    blobs.push(...(result.deleteUrls || []));
    saved = result.records;
    return result.records;
  });
  if (changed && blobs.length) { try { await deleteKeys(blobs.map(urlToKey)); } catch {} }
  return newestFirst(saved);
}

// Upsert a run by runId. New images replace any existing image with the same
// templateId (so retries/regenerates merge into one tidy per-fabric record).
// `facts` = the user-provided colour/adjective/material/tags for the product.
// Like `caption`, it's only written when supplied, so retries (which omit it)
// preserve the original facts via `...rec`.
async function appendRun({ runId, fabricName, images, user, caption, facts }) {
  if (!runId || !images || !images.length) return;
  await updateHistory(records => {
    const nowIso = new Date().toISOString();
    const idx = records.findIndex(r => r.id === runId);
    const next = records.slice();
    if (idx === -1) {
      next.unshift({
        id: runId,
        createdAt: nowIso,
        updatedAt: nowIso,
        fabricName: fabricName || "fabric",
        user: user || null,
        images,
        ...(caption ? { caption } : {}),
        ...(facts ? { facts } : {}),
      });
    } else {
      const rec = next[idx];
      const byTemplate = new Map((rec.images || []).map(im => [im.templateId, im]));
      for (const im of images) byTemplate.set(im.templateId, im);
      next[idx] = {
        ...rec,
        fabricName: fabricName || rec.fabricName,
        user: rec.user || user || null,
        updatedAt: nowIso,
        images: Array.from(byTemplate.values()),
        // Only overwrite caption/facts when freshly provided (retries omit them).
        ...(caption ? { caption } : {}),
        ...(facts ? { facts } : {}),
      };
    }
    return { records: next };
  });
}

// Records a request may see. By default EVERY user — admin included — sees only
// their own non-hidden runs, with individually-hidden images (selective delete)
// filtered out; runs left with zero visible images are dropped. Legacy runs (no
// user) belong to the legacy owner.
// { all: true } (admin + PIN, from the Admin menu) returns every user's runs,
// including hidden runs and images, for the combined audit view.
function visibleForUser(records, user, isAdmin, legacyOwner, { all = false } = {}) {
  if (all && isAdmin) return records;
  return records
    .filter(r => (r.user || legacyOwner) === user && !r.hidden)
    .map(r => ({ ...r, images: (r.images || []).filter(im => !im.hidden) }))
    .filter(r => r.images.length > 0);
}

module.exports = { readHistory, updateHistory, appendRun, visibleForUser, RETENTION_DAYS };
