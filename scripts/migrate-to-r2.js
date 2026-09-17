/*
 One-time migration: copy templates + history + audit from Vercel Blob → Cloudflare R2.

 Requires env vars (set locally before running):
   BLOB_READ_WRITE_TOKEN          (existing Vercel Blob token — to read old data)
   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_BASE

 Run from the fabric-styler folder:
   node scripts/migrate-to-r2.js
*/
const { list } = require("@vercel/blob");
const { putImage, putJson, publicUrl } = require("../api/_lib/storage");

const TOKEN = process.env.BLOB_READ_WRITE_TOKEN;

function requireEnv() {
  const missing = ["BLOB_READ_WRITE_TOKEN", "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_PUBLIC_BASE"]
    .filter(k => !process.env[k]);
  if (missing.length) {
    console.error("Missing env vars:", missing.join(", "));
    process.exit(1);
  }
}

// Read the newest versioned JSON blob for a given prefix (the old scheme).
async function readNewest(prefix) {
  const { blobs } = await list({ prefix, token: TOKEN });
  if (!blobs.length) return null;
  const newest = blobs.reduce((a, b) => (new Date(b.uploadedAt) > new Date(a.uploadedAt) ? b : a));
  const res = await fetch(newest.url, { cache: "no-store" });
  if (!res.ok) return null;
  return res.json();
}

function keyFromUrl(url) {
  try { return decodeURIComponent(new URL(url).pathname.replace(/^\//, "")); } catch { return null; }
}

// Download a Vercel Blob image and re-upload to R2 at the same key; return new public URL.
async function moveImage(oldUrl) {
  const key = keyFromUrl(oldUrl);
  if (!key) return oldUrl;
  const res = await fetch(oldUrl);
  if (!res.ok) { console.warn("  ! could not fetch", oldUrl, res.status); return oldUrl; }
  const buf = Buffer.from(await res.arrayBuffer());
  await putImage(key, buf);
  return publicUrl(key);
}

(async () => {
  requireEnv();

  // ---- Templates (manifest) ----
  const manifest = (await readNewest("fs-manifest")) || [];
  console.log(`Templates: ${manifest.length}`);
  for (const t of manifest) {
    if (t.url) { process.stdout.write(`  · ${t.label || t.id} `); t.url = await moveImage(t.url); console.log("✓"); }
  }
  await putJson("fs-manifest.json", manifest);
  console.log("  manifest written to R2\n");

  // ---- History ----
  const history = (await readNewest("fs-history-manifest")) || [];
  console.log(`History runs: ${history.length}`);
  for (const run of history) {
    for (const im of run.images || []) {
      if (im.url) im.url = await moveImage(im.url);
    }
    console.log(`  · run ${run.fabricName || run.id} (${(run.images || []).length} images) ✓`);
  }
  await putJson("fs-history.json", history);
  console.log("  history written to R2\n");

  // ---- Audit (JSON only, no images) ----
  const audit = (await readNewest("fs-audit")) || [];
  await putJson("fs-audit.json", audit);
  console.log(`Audit events: ${audit.length} → written to R2\n`);

  console.log("Migration complete.");
})().catch(e => { console.error("Migration failed:", e); process.exit(1); });
