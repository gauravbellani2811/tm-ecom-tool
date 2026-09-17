const { AwsClient } = require("aws4fetch");

// Cloudflare R2 storage adapter (S3-compatible) via aws4fetch.
// JSON state is read with authenticated GET (never CDN-cached → always fresh),
// so we use fixed keys with no versioning. Images are stored with public read.

const ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const BUCKET = process.env.R2_BUCKET;
const PUBLIC_BASE = (process.env.R2_PUBLIC_BASE || "").replace(/\/$/, "");
const ENDPOINT = `https://${ACCOUNT_ID}.r2.cloudflarestorage.com/${BUCKET}`;

let _client;
function client() {
  if (!_client) {
    _client = new AwsClient({
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      region: "auto",
      service: "s3",
    });
  }
  return _client;
}

function publicUrl(key) {
  return `${PUBLIC_BASE}/${key}`;
}

async function putObject(key, body, contentType, cacheControl) {
  const headers = { "Content-Type": contentType };
  if (cacheControl) headers["Cache-Control"] = cacheControl;
  const res = await client().fetch(`${ENDPOINT}/${encodeURI(key)}`, {
    method: "PUT",
    body,
    headers,
  });
  if (!res.ok) throw new Error(`R2 put failed (${res.status}) for ${key}`);
  return publicUrl(key);
}

// Images are content-addressed by unique key (retries mint a new id; flat/original
// use fixed per-run keys written once) → no key is ever rewritten with new bytes,
// so a long immutable cache is safe and makes repeat History opens near-instant.
async function putImage(key, buffer) {
  return putObject(key, buffer, "image/jpeg", "public, max-age=31536000, immutable");
}

async function putJson(key, obj) {
  return putObject(key, JSON.stringify(obj), "application/json");
}

// Server-side copy within the bucket (S3 CopyObject) — no image bytes pass through
// this function. Used to publish history images under clean, Shopify-friendly names.
async function copyObject(srcKey, destKey) {
  const res = await client().fetch(`${ENDPOINT}/${encodeURI(destKey)}`, {
    method: "PUT",
    headers: {
      "x-amz-copy-source": `/${BUCKET}/${encodeURI(srcKey)}`,
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
  if (!res.ok) throw new Error(`R2 copy failed (${res.status}) ${srcKey} -> ${destKey}`);
  return publicUrl(destKey);
}

async function getObjectText(key) {
  const res = await client().fetch(`${ENDPOINT}/${encodeURI(key)}`, { method: "GET" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`R2 get failed (${res.status}) for ${key}`);
  return await res.text();
}

async function getObjectBuffer(key) {
  const res = await client().fetch(`${ENDPOINT}/${encodeURI(key)}`, { method: "GET" });
  if (!res.ok) throw new Error(`R2 get failed (${res.status}) for ${key}`);
  return Buffer.from(await res.arrayBuffer());
}

// Keys a client may reference by URL (instead of re-uploading the bytes).
function isStoredImageKey(key) {
  return typeof key === "string" && /^fs-(history|candidates)\/[^/]+\.jpg$/.test(key);
}

async function getJson(key) {
  const text = await getObjectText(key);
  if (text == null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

// ---- Safe concurrent JSON updates -------------------------------------------
// Shared state files (history, audit log, waitlists, templates…) are read, changed
// and written back by many requests at once. A plain write would silently discard
// any change another request saved in between ("last write wins"). Instead every
// writer reads the file together with its ETag and writes with If-Match; if someone
// else saved first R2 answers 412, and we re-read and re-apply the change.

// { data, etag, exists }. Throws on read errors or unparseable JSON — callers must
// never mistake a failed read for an empty file (writing that back would wipe it).
async function getJsonVersioned(key) {
  const res = await client().fetch(`${ENDPOINT}/${encodeURI(key)}`, { method: "GET" });
  if (res.status === 404) return { data: null, etag: null, exists: false };
  if (!res.ok) throw new Error(`R2 get failed (${res.status}) for ${key}`);
  // Cloudflare compresses larger responses on the way out and then labels the ETag
  // "weak" (W/"…"). R2 only accepts the strong form in If-Match, so a weak tag would
  // make every conditional save fail. The value inside is the object’s real ETag.
  const rawEtag = res.headers.get("etag");
  const etag = rawEtag ? rawEtag.replace(/^W\//, "") : rawEtag;
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`Unreadable JSON in ${key}`); }
  return { data, etag, exists: true };
}

// Write only if the object is unchanged since it was read (or, when it didn't exist,
// still doesn't). Returns false on 412 (someone else wrote first).
async function putJsonIfMatch(key, obj, { etag, exists }) {
  const headers = { "Content-Type": "application/json" };
  if (exists && etag) headers["If-Match"] = etag;
  else if (!exists) headers["If-None-Match"] = "*";
  const res = await client().fetch(`${ENDPOINT}/${encodeURI(key)}`, {
    method: "PUT",
    body: JSON.stringify(obj),
    headers,
  });
  if (res.status === 412) return false;
  if (!res.ok) throw new Error(`R2 put failed (${res.status}) for ${key}`);
  return true;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// OFF until R2's conditional-write behaviour is verified live (the first rollout
// refused every save). While off, updateJson does a plain read → change → write,
// exactly like before — but still never treats a failed read as an empty file.
const USE_CONDITIONAL_WRITES = false;

// Read → mutate(data) → conditional write, retried on conflict. `mutate` gets the
// freshly parsed file (null if missing) and returns the new value, or undefined for
// "no change". It may run several times, so it must not have side effects.
// Retries until `budgetMs` has passed (not a fixed attempt count), sleeping a random
// "full jitter" delay that grows with each conflict — so a burst of simultaneous
// saves spreads out instead of colliding in lockstep. The budget stays well inside
// the 30 s limit of the shortest endpoint that saves.
async function updateJson(key, mutate, { budgetMs = 20000, conditional = USE_CONDITIONAL_WRITES, stats } = {}) {
  const deadline = Date.now() + budgetMs;
  for (let attempt = 1; ; attempt++) {
    if (stats) stats.attempts = attempt;
    const { data, etag, exists } = await getJsonVersioned(key);
    const next = await mutate(data);
    if (next === undefined) return { data, changed: false };
    if (!conditional) { await putJson(key, next); return { data: next, changed: true }; }
    if (await putJsonIfMatch(key, next, { etag, exists })) return { data: next, changed: true };
    if (stats) stats.conflicts = (stats.conflicts || 0) + 1;
    const wait = Math.random() * Math.min(1500, 100 * 2 ** Math.min(attempt, 6));
    if (Date.now() + wait >= deadline) break;
    await sleep(wait);
  }
  throw new Error(`Too many simultaneous saves to ${key} — please try again`);
}

// Diagnostic: N simultaneous conditional updates to a throwaway file padded to
// `padKB` (to mimic the multi-MB history file). Reports how many landed.
async function probeConcurrentUpdates({ n = 25, padKB = 1 } = {}) {
  const key = "zz-concurrency-probe.json";
  await putJson(key, { pad: "x".repeat(padKB * 1024), items: [] });
  const t0 = Date.now();
  const results = await Promise.all(Array.from({ length: n }, async (_, i) => {
    const stats = { attempts: 0, conflicts: 0 };
    try {
      await updateJson(key, d => ({ ...d, items: [...((d && d.items) || []), i] }), { conditional: true, stats });
      return { ok: true, ...stats };
    } catch (e) {
      return { ok: false, error: e.message, ...stats };
    }
  }));
  const final = (await getJsonVersioned(key)).data;
  await deleteKeys([key]);
  return {
    n, padKB, ms: Date.now() - t0,
    succeeded: results.filter(r => r.ok).length,
    itemsInFile: ((final && final.items) || []).length,
    attemptsPerSave: results.map(r => r.attempts),
    errors: [...new Set(results.filter(r => !r.ok).map(r => r.error))],
  };
}

// Diagnostic: exercise R2 conditional writes on a throwaway key and report exactly
// what R2 answers (statuses, ETag headers, error bodies). Touches nothing else.
async function probeConditionalWrites() {
  const key = "zz-etag-probe.json";
  const url = `${ENDPOINT}/${encodeURI(key)}`;
  const call = async (label, opts) => {
    const res = await client().fetch(url, opts);
    const body = await res.text().catch(() => "");
    const headers = {};
    res.headers.forEach((v, k) => { if (/etag|content-length|content-type|cf-|x-amz/i.test(k)) headers[k] = v; });
    return { label, status: res.status, etag: res.headers.get("etag"), headers, body: res.ok && opts.method === "GET" ? body.slice(0, 60) : body.slice(0, 400) };
  };
  const put = (label, n, extra = {}) => call(label, {
    method: "PUT", body: JSON.stringify({ n }), headers: { "Content-Type": "application/json", ...extra },
  });
  const steps = [];
  steps.push(await put("1 plain PUT", 1));
  const g1 = await call("2 GET", { method: "GET" }); steps.push(g1);
  const h1 = await call("3 HEAD", { method: "HEAD" }); steps.push(h1);
  steps.push(await put("4 PUT If-Match <etag from GET> (expect 200)", 2, g1.etag ? { "If-Match": g1.etag } : {}));
  const g2 = await call("5 GET", { method: "GET" }); steps.push(g2);
  steps.push(await put("6 PUT If-Match <stale etag> (expect 412)", 3, g1.etag ? { "If-Match": g1.etag } : {}));
  const bare = (g2.etag || "").replace(/^W\//, "").replace(/"/g, "");
  steps.push(await put("7 PUT If-Match <unquoted etag> (expect 200)", 4, bare ? { "If-Match": bare } : {}));
  steps.push(await put("8 PUT If-None-Match * on existing (expect 412)", 5, { "If-None-Match": "*" }));
  await call("9 DELETE", { method: "DELETE" });
  steps.push(await put("10 PUT If-None-Match * on missing (expect 200)", 6, { "If-None-Match": "*" }));
  steps.push(await call("11 DELETE (cleanup)", { method: "DELETE" }));
  return steps;
}

// One page (up to 1000) of objects under a prefix: [{ key, lastModified }].
async function listObjects(prefix) {
  const res = await client().fetch(`${ENDPOINT}?list-type=2&max-keys=1000&prefix=${encodeURIComponent(prefix)}`, { method: "GET" });
  if (!res.ok) throw new Error(`R2 list failed (${res.status}) for ${prefix}`);
  const xml = await res.text();
  const decode = s => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
  return [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map(m => ({
    key: decode((m[1].match(/<Key>([\s\S]*?)<\/Key>/) || [])[1] || ""),
    lastModified: Date.parse((m[1].match(/<LastModified>([^<]*)<\/LastModified>/) || [])[1] || ""),
  })).filter(o => o.key);
}

// Map a stored public URL back to its object key (for deletes).
function urlToKey(url) {
  if (!url) return null;
  if (PUBLIC_BASE && url.startsWith(PUBLIC_BASE + "/")) {
    return decodeURI(url.slice(PUBLIC_BASE.length + 1));
  }
  try { return decodeURI(new URL(url).pathname.replace(/^\//, "")); } catch { return null; }
}

async function deleteKeys(keys) {
  const valid = (keys || []).filter(Boolean);
  await Promise.all(valid.map(k =>
    client().fetch(`${ENDPOINT}/${encodeURI(k)}`, { method: "DELETE" }).catch(() => {})
  ));
}

module.exports = { putObject, putImage, putJson, copyObject, getObjectText, getObjectBuffer, isStoredImageKey, listObjects, probeConditionalWrites, probeConcurrentUpdates, getJsonVersioned, putJsonIfMatch, updateJson, getJson, urlToKey, deleteKeys, publicUrl };
