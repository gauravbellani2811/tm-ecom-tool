const { readHistory, updateHistory, visibleForUser } = require("./_lib/history");
const { getUser, adminUsers, requireAdmin } = require("./_lib/auth");
const { sendJson } = require("./_lib/respond");
const { withThumb, imageBlobUrls } = require("./_lib/thumbs");

const NO_THUMB = new Set(["__original__", "__detail__"]); // never shown in grids

async function parseJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  return await new Promise((resolve) => {
    let data = "";
    req.on("data", chunk => { data += chunk; });
    req.on("end", () => { try { resolve(JSON.parse(data || "{}")); } catch { resolve({}); } });
    req.on("error", () => resolve({}));
  });
}

// History is per user: every request (admin included) sees only its own runs.
// `?scope=all` is the combined every-user view opened from the PIN-locked Admin
// menu — it requires an admin username AND the admin PIN.
// All changes go through updateHistory (ETag-guarded, retried on conflict), so
// simultaneous saves and deletes never undo each other.
module.exports = async function handler(req, res) {
  const { user, isAdmin } = getUser(req);
  const legacyOwner = adminUsers()[0];
  const all = (req.query && req.query.scope) === "all";

  if (all) {
    const auth = requireAdmin(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  }
  const view = records => visibleForUser(records, user, isAdmin, legacyOwner, { all });

  if (req.method === "GET") {
    try {
      return sendJson(req, res, view(await readHistory()));
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // One-off backfill: create thumbnails for grid images that don't have one yet.
  // Body { action: "backfillThumbs", limit? }. Idempotent; call repeatedly until
  // remaining is 0. Works in R2 only (no image bytes returned to the client).
  if (req.method === "POST") {
    const body = await parseJsonBody(req);
    if (!user) return res.status(401).json({ error: "Not signed in" });
    if (body.action !== "backfillThumbs") return res.status(400).json({ error: "Unknown action" });
    const limit = Math.min(Math.max(parseInt(body.limit, 10) || 40, 1), 80);
    const needs = im => im.url && !im.thumb && !im.thumbFailed && !NO_THUMB.has(im.templateId);
    try {
      const todo = (await readHistory()).flatMap(r => (r.images || []).filter(needs)).slice(0, limit);
      const made = new Map(); // url -> thumb url | null (failed)
      for (let i = 0; i < todo.length; i += 8) {
        await Promise.all(todo.slice(i, i + 8).map(async im => {
          const out = await withThumb(im);
          made.set(im.url, out.thumb || null);
        }));
      }
      const next = !made.size ? await readHistory() : await updateHistory(records => ({
        records: records.map(r => ({
          ...r,
          images: (r.images || []).map(im => {
            if (!made.has(im.url) || im.thumb) return im;
            const t = made.get(im.url);
            return t ? { ...im, thumb: t } : { ...im, thumbFailed: true };
          }),
        })),
      }));
      const remaining = next.reduce((a, r) => a + (r.images || []).filter(needs).length, 0);
      const failed = [...made.values()].filter(v => !v).length;
      return res.json({ processed: made.size, failed, remaining });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === "DELETE") {
    const body = await parseJsonBody(req);
    const urls = Array.isArray(body.urls) ? body.urls.filter(Boolean) : null;

    // Selective delete: body { urls: [...] } removes just those specific
    // images (from the multi-select checkboxes), possibly across several runs.
    // Only images inside the caller's current view are touched.
    // Admin: hard-deletes the images (+ R2 blobs).
    // Staff: soft-hides their selected images (kept for the admin audit).
    if (urls && urls.length) {
      const urlSet = new Set(urls);
      try {
        const next = await updateHistory(records => {
          const allowedIds = new Set(view(records).map(r => r.id));
          let changed = false;

          if (isAdmin) {
            const deleteUrls = [];
            const out = [];
            for (const rec of records) {
              if (!allowedIds.has(rec.id)) { out.push(rec); continue; }
              const keep = [];
              for (const im of (rec.images || [])) {
                if (im.url && urlSet.has(im.url)) { deleteUrls.push(...imageBlobUrls(im)); changed = true; }
                else keep.push(im);
              }
              if (keep.length) out.push(keep.length === (rec.images || []).length ? rec : { ...rec, images: keep });
              // runs left with zero images are dropped
            }
            return changed ? { records: out, deleteUrls } : undefined;
          }

          const out = records.map(rec => {
            if (!allowedIds.has(rec.id)) return rec;
            let recChanged = false;
            const images = (rec.images || []).map(im => {
              if (im.url && urlSet.has(im.url) && !im.hidden) { recChanged = true; return { ...im, hidden: true }; }
              return im;
            });
            if (recChanged) changed = true;
            return recChanged ? { ...rec, images } : rec;
          });
          return changed ? { records: out } : undefined;
        });
        return sendJson(req, res, view(next));
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    // Clear all is the most destructive path, so it requires an explicit
    // confirmation flag in the body — never a fallback default. This prevents
    // any body-parsing hiccup (missing/garbled `urls`) from silently wiping
    // everything instead of erroring out.
    if (body.confirmClearAll !== true) {
      return res.status(400).json({ error: "Missing urls[] or confirmClearAll" });
    }

    try {
      const own = r => (r.user || legacyOwner) === user;
      const blobsOf = recs => recs.flatMap(r => (r.images || []).flatMap(imageBlobUrls));

      const next = await updateHistory(records => {
        // Admin in the combined view (PIN already checked): wipe every user's history.
        if (isAdmin && all) return { records: [], deleteUrls: blobsOf(records) };
        // Admin in their own History: hard-delete only their own runs.
        if (isAdmin) return { records: records.filter(r => !own(r)), deleteUrls: blobsOf(records.filter(own)) };
        // Staff: hide own runs, keep data for the admin audit.
        return { records: records.map(r => (own(r) ? { ...r, hidden: true } : r)) };
      });
      return sendJson(req, res, isAdmin && all ? [] : view(next));
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // Admin-only recovery: undo an accidental "clear all" / hide for one user.
  // Body: { restoreOwner: "username", restoreDate?: "YYYY-MM-DD" } — clears record-
  // and image-level hidden flags on that user's runs. An optional restoreDate scopes
  // it to runs created on that day. Requires the admin PIN. Returns the combined
  // (all users) view, since it's called from the Admin menu.
  if (req.method === "PATCH") {
    const auth = requireAdmin(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
    const body = await parseJsonBody(req);
    const owner = (body.restoreOwner || "").toString().trim().toLowerCase();
    const date = (body.restoreDate || "").toString().trim(); // optional YYYY-MM-DD
    if (!owner) return res.status(400).json({ error: "Missing restoreOwner" });
    try {
      const next = await updateHistory(records => ({
        records: records.map(rec => {
          if ((rec.user || legacyOwner) !== owner) return rec;
          if (date && (rec.createdAt || "").slice(0, 10) !== date) return rec;
          const images = (rec.images || []).map(im => im.hidden ? { ...im, hidden: false } : im);
          return { ...rec, hidden: false, images };
        }),
      }));
      return sendJson(req, res, visibleForUser(next, user, isAdmin, legacyOwner, { all: true }));
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  res.status(405).json({ error: "Method not allowed" });
};

module.exports.config = { maxDuration: 60 };
