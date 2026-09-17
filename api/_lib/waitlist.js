const { getJson, updateJson, deleteKeys, urlToKey } = require("./storage");

// Per-user upload staging area ("Waitlist"). Stored as one JSON per user in R2;
// images live under waitlist/{user}/. Items auto-expire after the retention window.
// Changes use ETag-guarded writes (see updateJson) so parallel uploads/edits
// never overwrite each other.
const RETENTION_DAYS = 7;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

function keyFor(user) {
  return `waitlist/${(user || "unknown").toLowerCase()}.json`;
}

function isExpired(item) {
  const t = new Date(item.createdAt).getTime();
  return !Number.isFinite(t) || Date.now() - t > RETENTION_MS;
}

const newestFirst = items => items.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

async function readWaitlist(user) {
  try {
    const data = await getJson(keyFor(user));
    return newestFirst((Array.isArray(data) ? data : []).filter(it => !isExpired(it)));
  } catch {
    return [];
  }
}

// Apply a change to one user's waitlist. `mutate(liveItems)` returns
// { items, deleteUrls? } or undefined (no change); it may run more than once, so no
// side effects. Expired items are pruned; blobs are deleted after a successful save.
async function updateWaitlist(user, mutate) {
  let blobs = [];
  let saved = [];
  const { changed } = await updateJson(keyFor(user), async raw => {
    if (raw != null && !Array.isArray(raw)) throw new Error("Waitlist file is not a list — refusing to overwrite it");
    const arr = raw || [];
    blobs = [];
    const live = [];
    for (const it of arr) {
      if (isExpired(it)) {
        if (it.url) blobs.push(it.url);
        if (it.detailUrl) blobs.push(it.detailUrl);
      } else live.push(it);
    }
    const result = await mutate(live);
    if (result === undefined) {
      saved = live;
      return live.length !== arr.length ? live : undefined;
    }
    blobs.push(...(result.deleteUrls || []));
    saved = result.items;
    return result.items;
  });
  if (changed && blobs.length) { try { await deleteKeys(blobs.map(urlToKey)); } catch {} }
  return newestFirst(saved);
}

async function addItem(user, item) {
  return updateWaitlist(user, items => ({ items: [item, ...items] }));
}

// Update an item's caption metadata (SKU/name, colour, adjective, material, tags).
async function updateItem(user, id, patch) {
  return updateWaitlist(user, items => {
    const idx = items.findIndex(i => i.id === id);
    if (idx === -1) return undefined;
    const next = { ...items[idx] };
    if (typeof patch.name === "string") next.name = patch.name.slice(0, 120);
    if (typeof patch.colour === "string") next.colour = patch.colour.slice(0, 80);
    if (typeof patch.adjective === "string") next.adjective = patch.adjective.slice(0, 80);
    if (typeof patch.fabricType === "string") next.fabricType = patch.fabricType.slice(0, 80);
    if (Array.isArray(patch.tags)) next.tags = patch.tags.map(t => (t || "").toString().slice(0, 80)).slice(0, 3);
    return { items: items.map((it, i) => (i === idx ? next : it)) };
  });
}

// Attach (or replace) a close-up detail image URL on an existing item.
async function attachDetail(user, id, detailUrl) {
  return updateWaitlist(user, items => {
    const idx = items.findIndex(i => i.id === id);
    if (idx === -1) return undefined;
    const prev = items[idx].detailUrl;
    return {
      items: items.map((it, i) => (i === idx ? { ...it, detailUrl } : it)),
      // If replacing, clean up the old blob (unless it's the same key).
      deleteUrls: prev && prev !== detailUrl ? [prev] : [],
    };
  });
}

// Remove an item's detail image (blob + field).
async function removeDetail(user, id) {
  return updateWaitlist(user, items => {
    const idx = items.findIndex(i => i.id === id);
    if (idx === -1 || !items[idx].detailUrl) return undefined;
    const next = { ...items[idx] };
    delete next.detailUrl;
    return { items: items.map((it, i) => (i === idx ? next : it)), deleteUrls: [items[idx].detailUrl] };
  });
}

async function removeItem(user, id) {
  return updateWaitlist(user, items => {
    const removed = items.find(i => i.id === id);
    if (!removed) return undefined;
    return {
      items: items.filter(i => i.id !== id),
      deleteUrls: [removed.url, removed.detailUrl].filter(Boolean),
    };
  });
}

module.exports = { readWaitlist, addItem, updateItem, attachDetail, removeDetail, removeItem, RETENTION_DAYS };
