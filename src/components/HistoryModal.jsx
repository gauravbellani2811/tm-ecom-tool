import React, { useEffect, useMemo, useState } from "react";
import { downloadUrl, downloadRunImages, downloadImages } from "../utils/zip";
import { downloadRunCaptions, plainPreview } from "../utils/captionCsv";
import { apiFetch } from "../utils/api";
import RetryThreeModal from "./RetryThreeModal";
import { preloadImage } from "../utils/preload";
import CompareRetryModal from "./CompareRetryModal";

export const PRO_CONFIRM = "Regenerate with the Pro model? Pro is higher quality but costs about 2× a normal image.";
const FLAT_ID = "__flat__";
// Reference images hidden from the grid/counts/downloads (shown on demand instead).
const HIDDEN_META = new Set(["__original__", "__detail__"]);

// One-line summary of the user-provided facts, shown beside the original image.
function factsSummary(facts) {
  if (!facts) return null;
  const desc = [facts.colour, facts.adjective, facts.material].map(s => (s || "").trim()).filter(Boolean).join(" · ");
  const tags = (facts.tags || []).map(t => (t || "").trim()).filter(Boolean);
  const parts = [];
  if (desc) parts.push(desc);
  if (tags.length) parts.push("Tags: " + tags.join(", "));
  return parts.length ? parts.join("  —  ") : null;
}

function formatWhen(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return d.toLocaleString(undefined, {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}

// Inline styles for layout-critical parts so the History view renders correctly
// regardless of external stylesheet caching.
const S = {
  run: { border: "1px solid #e4ddd2", borderRadius: 10, background: "#fff", overflow: "hidden", marginBottom: 16 },
  runHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "10px 14px", background: "#f3efe9", borderBottom: "1px solid #e4ddd2", flexWrap: "wrap" },
  runMeta: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 },
  runName: { fontWeight: 600, fontSize: 14, color: "#2a2118", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 380 },
  runSub: { fontSize: 12, color: "#857a6c" },
  runActions: { display: "flex", gap: 6, flexShrink: 0, alignItems: "center" },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 10, padding: "12px 14px" },
  thumb: { position: "relative", border: "1px solid #e4ddd2", borderRadius: 8, overflow: "hidden", background: "#f3efe9" },
  thumbSel: { border: "1px solid #C4552A", boxShadow: "0 0 0 2px #C4552A" },
  imgBtn: { display: "block", width: "100%", height: 150, padding: 0, border: "none", background: "#f3efe9", cursor: "zoom-in" },
  img: { width: "100%", height: "100%", objectFit: "cover", display: "block" },
  check: { position: "absolute", top: 6, left: 6, zIndex: 2, background: "rgba(255,255,255,0.92)", borderRadius: 5, width: 24, height: 24, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", boxShadow: "0 1px 3px rgba(0,0,0,0.2)" },
  checkInput: { width: 16, height: 16, accentColor: "#C4552A", cursor: "pointer" },
  footer: { display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", borderTop: "1px solid #e4ddd2" },
  retryOverlay: { position: "absolute", inset: 0, zIndex: 1, background: "rgba(42,33,24,0.6)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6 },
  retryOverlayText: { fontSize: 11, color: "#fff", fontWeight: 600 },
  btnSpinner: { width: 11, height: 11, borderWidth: 1.5 },
  label: { fontSize: 11, color: "#857a6c", flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
};

function Lightbox({ image, onClose }) {
  useEffect(() => {
    function onKey(e) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const close = (e) => { e.stopPropagation(); onClose(); };
  return (
    <div className="lightbox-overlay" onClick={close}>
      <button className="lightbox-close" onClick={close} title="Close (Esc)">×</button>
      <figure className="lightbox-figure" onClick={e => e.stopPropagation()}>
        <img src={image.src} alt={image.label} className="lightbox-img" />
        {image.label && <figcaption className="lightbox-caption">{image.label}</figcaption>}
        {factsSummary(image.facts) && (
          <figcaption className="lightbox-caption" style={{ marginTop: 4, fontSize: 12, opacity: 0.85 }}>
            {factsSummary(image.facts)}
          </figcaption>
        )}
      </figure>
    </div>
  );
}

export default function HistoryModal({ onClose, isAdmin, templates, scope = "mine" }) {
  // "mine" = the signed-in user's own runs (everyone, admin included).
  // "all"  = every user's runs — only opened from the PIN-locked Admin menu.
  const allUsers = scope === "all";
  const scopeQs = allUsers ? "?scope=all" : "";
  const [records, setRecords] = useState(null);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [lightbox, setLightbox] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [downloading, setDownloading] = useState(false);
  const [deletingSelected, setDeletingSelected] = useState(false);
  // Background retries, keyed `${runId}:${templateId}`. Each: { kind:"single"|"pro"|"three",
  // status:"loading"|"ready"|"error"|"saving", run, image, currentUrl, imageDataUrl?, candidates?, error? }.
  const [retries, setRetries] = useState({});
  const [openKey, setOpenKey] = useState(null);  // which ready retry is expanded into a modal
  const [capOpen, setCapOpen] = useState({});    // runId -> caption description expanded
  const [search, setSearch] = useState("");      // filter runs by SKU / fabric name

  useEffect(() => {
    function onKey(e) { if (e.key === "Escape" && !lightbox && !openKey) onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, lightbox, openKey]);

  // Retries reuse the run's flat swatch as the source fabric (a faithful crop of the
  // original), plus the stored close-up detail photo if the run had one — so
  // embroidery/texture fabrics regenerate with the same reference. Both go to the
  // server as R2 URLs it reads directly, so nothing is re-uploaded.
  function sourcesForRun(run) {
    const flat = (run.images || []).find(im => im.templateId === FLAT_ID);
    const fabricUrl = (flat && flat.url) || (run.images || [])[0]?.url;
    if (!fabricUrl) throw new Error("No fabric source available for this run.");
    const detail = (run.images || []).find(im => im.templateId === "__detail__");
    return { fabricUrl, detailUrl: (detail && detail.url) || null };
  }

  // Map a history image's (possibly stale) template to a CURRENT one — by id,
  // falling back to label (deleted/recreated templates get a new id).
  function resolveTemplate(image) {
    return (templates || []).find(t => t.id === image.templateId)
      || (templates || []).find(t => t.label === image.templateLabel)
      || null;
  }

  // Generate one image for the current template (not saved to history).
  async function genOne(sources, run, currentTemplateId, model) {
    const fd = new FormData();
    fd.append("fabricUrl", sources.fabricUrl);
    if (sources.detailUrl) fd.append("detailUrl", sources.detailUrl);
    fd.append("runId", run.id);
    fd.append("fabricName", run.fabricName || "");
    fd.append("templateIds[]", currentTemplateId);
    fd.append("skipHistory", "1");
    fd.append("action", model === "pro" ? "pro" : "regenerate");
    if (model) fd.append("model", model);
    const res = await apiFetch("/api/generate", { method: "POST", body: fd });
    if (!res.ok) {
      const t = await res.text(); let msg = t; try { msg = JSON.parse(t).error || t; } catch {}
      throw new Error(msg.slice(0, 200));
    }
    const r = (await res.json()).results?.[0];
    if (!r || r.error || !r.imageDataUrl) throw new Error((r && r.error) || "No image returned");
    await preloadImage(r.imageDataUrl); // only report "ready" once it can actually be shown
    return r.imageDataUrl;
  }

  // Save a generated image into the run under the ORIGINAL templateId → rewrites in
  // place. Returns the saved image ({ url, ... }) so we can patch state without a reload.
  async function saveToHistory(run, image, imageDataUrl) {
    const fd = new FormData();
    fd.append("runId", run.id);
    fd.append("fabricName", run.fabricName || "");
    fd.append("templateId", image.templateId);
    fd.append("templateLabel", image.templateLabel || "");
    if (/^https?:/.test(imageDataUrl)) fd.append("sourceUrl", imageDataUrl); // stored candidate → server-side copy
    else fd.append("image", await (await fetch(imageDataUrl)).blob(), "retry.jpg");
    const res = await apiFetch("/api/history-add", { method: "POST", body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data && data.error) || "Save failed");
    return data.image || null;
  }

  // --- Background retries: no blocking modal; a "Compare" button appears when ready. ---
  const setEntry = (key, patch) => setRetries(prev => {
    if (patch === null) { const next = { ...prev }; delete next[key]; return next; }
    const cur = prev[key];
    const val = typeof patch === "function" ? patch(cur) : { ...cur, ...patch };
    return val ? { ...prev, [key]: val } : prev;
  });
  const withCand = (candidates, i, val) => { const c = (candidates || []).slice(); c[i] = val; return c; };

  // Swap an image's URL in local state (optimistic new image, then the persisted R2 url).
  function patchImageUrl(runId, templateId, newUrl, newThumb) {
    setRecords(prev => (prev || []).map(r => r.id !== runId ? r : {
      ...r,
      images: (r.images || []).map(im => im.templateId === templateId ? { ...im, url: newUrl, thumb: newThumb } : im),
    }));
  }

  // Start a background retry. kind: "single" | "pro" | "three". Tile shows progress.
  async function startRetry(run, image, kind) {
    if (kind === "pro" && !window.confirm(PRO_CONFIRM)) return;
    const cur = resolveTemplate(image);
    if (!cur) { setError(`"${image.templateLabel}" is no longer in the library, so it can't be retried.`); return; }
    const key = `${run.id}:${image.templateId}`;
    setError(null);
    setRetries(prev => ({
      ...prev,
      [key]: {
        kind, run, image, templateLabel: image.templateLabel, currentUrl: image.url, status: "loading",
        candidates: kind === "three" ? [{ status: "loading" }, { status: "loading" }, { status: "loading" }] : undefined,
      },
    }));

    let sources;
    try { sources = sourcesForRun(run); }
    catch (e) { setEntry(key, { status: "error", error: e.message }); return; }

    if (kind === "three") {
      const settle = (i, val) => setEntry(key, e => {
        if (!e) return e;
        const candidates = withCand(e.candidates, i, val);
        const anyDone = candidates.some(c => c.status === "done");
        const allSettled = candidates.every(c => c.status !== "loading");
        return { ...e, candidates, status: anyDone ? "ready" : (allSettled ? "error" : "loading") };
      });
      for (let i = 0; i < 3; i++) {
        genOne(sources, run, cur.id)
          .then(imageDataUrl => settle(i, { status: "done", imageDataUrl }))
          .catch(err => settle(i, { status: "error", error: err.message }));
      }
      return;
    }

    try {
      const imageDataUrl = await genOne(sources, run, cur.id, kind === "pro" ? "pro" : undefined);
      setEntry(key, e => e && { ...e, status: "ready", imageDataUrl });
    } catch (err) {
      setEntry(key, e => e && { ...e, status: "error", error: err.message });
    }
  }

  function dismissRetry(key) { setOpenKey(null); setEntry(key, null); }

  // Persist the chosen image + swap the tile in place (no full history reload).
  async function applyRetry(key, imageDataUrl) {
    const entry = retries[key];
    if (!entry) return;
    const { run, image } = entry;
    setOpenKey(null);
    setEntry(key, { status: "saving" });
    patchImageUrl(run.id, image.templateId, imageDataUrl); // optimistic
    try {
      const saved = await saveToHistory(run, image, imageDataUrl);
      if (saved && saved.url) patchImageUrl(run.id, image.templateId, saved.url, saved.thumb);
      setEntry(key, null);
    } catch (err) {
      patchImageUrl(run.id, image.templateId, image.url, image.thumb); // revert
      setEntry(key, { status: "error", error: err.message });
      setError("Couldn't save the new image: " + err.message);
    }
  }

  async function load() {
    try {
      const res = await apiFetch("/api/history" + scopeQs, { admin: allUsers });
      const data = await res.json();
      setRecords(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err.message);
      setRecords([]);
    }
  }
  useEffect(() => { load(); }, []);

  const imageIndex = useMemo(() => {
    const m = new Map();
    (records || []).forEach(r =>
      (r.images || []).forEach(im => im.url && !HIDDEN_META.has(im.templateId) && m.set(im.url, {
        url: im.url, fabricName: r.fabricName, templateLabel: im.templateLabel,
      }))
    );
    return m;
  }, [records]);

  function toggle(url) {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(url) ? next.delete(url) : next.add(url);
      return next;
    });
  }
  function toggleRun(rec) {
    const urls = (rec.images || []).filter(im => !HIDDEN_META.has(im.templateId)).map(im => im.url).filter(Boolean);
    const allSelected = urls.every(u => selected.has(u));
    setSelected(prev => {
      const next = new Set(prev);
      urls.forEach(u => allSelected ? next.delete(u) : next.add(u));
      return next;
    });
  }
  function selectAll() { setSelected(new Set(imageIndex.keys())); }
  function clearSelection() { setSelected(new Set()); }

  async function downloadSelected() {
    const items = [...selected].map(u => imageIndex.get(u)).filter(Boolean);
    if (!items.length) return;
    setDownloading(true);
    setError(null);
    try { await downloadImages(items); }
    catch (err) { setError(err.message); }
    finally { setDownloading(false); }
  }

  async function deleteSelected() {
    const urls = [...selected];
    if (!urls.length) return;
    const n = urls.length;
    const msg = isAdmin
      ? `Permanently delete ${n} selected image${n === 1 ? "" : "s"}? This deletes the stored images.`
      : `Remove ${n} selected image${n === 1 ? "" : "s"} from your history?`;
    if (!window.confirm(msg)) return;
    setDeletingSelected(true);
    setError(null);
    try {
      const res = await apiFetch("/api/history" + scopeQs, {
        method: "DELETE", admin: allUsers,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls }),
      });
      if (!res.ok) { setError("Failed to delete selected images"); return; }
      const updated = await res.json();
      setRecords(Array.isArray(updated) ? updated : []);
      setSelected(new Set());
    } catch (err) {
      setError(err.message);
    } finally {
      setDeletingSelected(false);
    }
  }

  async function deleteRun(rec) {
    const msg = isAdmin
      ? `Permanently delete this run (“${rec.fabricName}”, ${rec.images.length} images)?`
      : `Remove this run (“${rec.fabricName}”) from your history?`;
    if (!window.confirm(msg)) return;
    setBusyId(rec.id);
    setError(null);
    try {
      const res = await apiFetch(`/api/history/${rec.id}` + scopeQs, { method: "DELETE", admin: allUsers });
      if (!res.ok) { setError("Failed to delete record"); return; }
      const updated = await res.json();
      setRecords(Array.isArray(updated) ? updated : []);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  async function clearAll() {
    const msg = isAdmin
      ? (allUsers
        ? "Permanently clear ALL history for EVERY user? This deletes the stored images."
        : "Permanently clear your history? This deletes your stored images.")
      : "Clear your history? (Removes it from your view.)";
    if (!window.confirm(msg)) return;
    setBusyId("__all__");
    setError(null);
    try {
      const res = await apiFetch("/api/history" + scopeQs, {
        method: "DELETE", admin: allUsers,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmClearAll: true }),
      });
      if (!res.ok) { setError("Failed to clear history"); return; }
      setRecords([]);
      setSelected(new Set());
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  const totalImages = (records || []).reduce((n, r) => n + (r.images || []).filter(im => !HIDDEN_META.has(im.templateId)).length, 0);
  const selCount = selected.size;
  const captionedRecords = (records || []).filter(r => r.caption && (r.caption.title || r.caption.description));

  const q = search.trim().toLowerCase();
  const visibleRecords = q
    ? (records || []).filter(r => (r.fabricName || "").toLowerCase().includes(q))
    : (records || []);

  function showOriginal(rec) {
    const orig = (rec.images || []).find(im => im.templateId === "__original__");
    if (!orig || !orig.url) return;
    setLightbox({ src: orig.url, label: `${rec.fabricName} — original upload`, facts: rec.facts });
  }

  return (
    <>
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel modal-panel-wide" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{allUsers ? "All users' history" : "History"}</h2>
          <div className="modal-header-meta">
            {records && records.length > 0 && (
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search SKU…"
                style={{ fontSize: 13, padding: "6px 10px", border: "1px solid #d9d0c2", borderRadius: 6, width: 160, boxSizing: "border-box" }}
              />
            )}
            <span className="counter">
              {records
                ? (q ? `${visibleRecords.length} of ${records.length} runs` : `${records.length} runs · ${totalImages} images · kept 10 days`)
                : "Loading…"}
            </span>
            {records && records.length > 0 && (
              <button className="btn btn-tiny btn-danger" onClick={clearAll} disabled={busyId === "__all__"}>
                {busyId === "__all__" ? "…" : "Clear all"}
              </button>
            )}
            <button className="modal-close" onClick={onClose} title="Close (Esc)">×</button>
          </div>
        </div>

        {records && records.length > 0 && (
          <div className="history-toolbar">
            <span className="history-toolbar-count">
              {selCount > 0 ? `${selCount} selected` : "Select images to download together"}
            </span>
            <div className="history-toolbar-actions">
              <button className="btn btn-tiny btn-ghost" onClick={selectAll}>Select all</button>
              <button className="btn btn-tiny btn-ghost" onClick={clearSelection} disabled={!selCount}>Clear</button>
              {captionedRecords.length > 0 && (
                <button className="btn btn-tiny btn-secondary"
                  onClick={() => { try { downloadRunCaptions(captionedRecords); } catch (e) { alert(e.message); } }}
                  title="Download all captions in view as a CSV">
                  ⤓ Captions ({captionedRecords.length})
                </button>
              )}
              <button className="btn btn-tiny btn-primary" onClick={downloadSelected} disabled={!selCount || downloading}>
                {downloading ? "Downloading…" : `⤓ Download selected${selCount ? ` (${selCount})` : ""}`}
              </button>
              <button className="btn btn-tiny btn-danger" onClick={deleteSelected} disabled={!selCount || deletingSelected}>
                {deletingSelected ? "Deleting…" : `Delete selected${selCount ? ` (${selCount})` : ""}`}
              </button>
            </div>
          </div>
        )}

        {error && <div className="error-banner library-error">{error}</div>}

        {!records && <div className="history-empty">Loading history…</div>}

        {records && records.length === 0 && (
          <div className="history-empty">
            <span className="icon">🗂</span>
            <span>No history yet.</span>
            <span className="hint">Generated images are saved here automatically and kept for 10 days.</span>
          </div>
        )}

        {records && records.length > 0 && q && visibleRecords.length === 0 && (
          <div className="history-empty">
            <span className="icon">🔎</span>
            <span>No products match “{search}”.</span>
          </div>
        )}

        {records && visibleRecords.length > 0 && (
          <div className="history-list" style={{ display: "block", overflowY: "auto", flex: "1 1 auto", minHeight: 0, padding: 20 }}>
            {visibleRecords.map(rec => {
              const gridImages = (rec.images || []).filter(im => !HIDDEN_META.has(im.templateId));
              const hasOriginal = (rec.images || []).some(im => im.templateId === "__original__" && im.url);
              const urls = gridImages.map(im => im.url).filter(Boolean);
              const allSel = urls.length > 0 && urls.every(u => selected.has(u));
              return (
                <div key={rec.id} style={S.run}>
                  <div style={S.runHeader}>
                    <div style={S.runMeta}>
                      <span style={S.runName}>
                        {rec.fabricName}
                        {allUsers && (
                          <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 500, color: "#6b6152", background: "#f3efe9", border: "1px solid #e4ddd2", borderRadius: 99, padding: "1px 8px" }}>
                            {rec.user || "unassigned"}{rec.hidden ? " · deleted by staff" : ""}
                          </span>
                        )}
                      </span>
                      <span style={S.runSub}>
                        {gridImages.length} image{gridImages.length === 1 ? "" : "s"} · {formatWhen(rec.createdAt)}
                      </span>
                    </div>
                    <div style={S.runActions}>
                      {hasOriginal && (
                        <button className="btn btn-tiny btn-secondary" onClick={() => showOriginal(rec)}
                          title="Show the original uploaded photo for this fabric (to check for hallucination)">
                          ◉ Original
                        </button>
                      )}
                      <button className="btn btn-tiny btn-ghost" onClick={() => toggleRun(rec)}>
                        {allSel ? "Deselect all" : "Select all"}
                      </button>
                      {rec.caption && (rec.caption.title || rec.caption.description) && (
                        <button className="btn btn-tiny btn-secondary"
                          onClick={() => { try { downloadRunCaptions(rec); } catch (e) { alert(e.message); } }}
                          title="Download this product's caption as CSV">
                          ⤓ Caption
                        </button>
                      )}
                      <button className="btn btn-tiny btn-secondary" onClick={() => downloadRunImages(rec).catch(e => alert(e.message))}>
                        ⤓ Download
                      </button>
                      <button className="btn btn-tiny btn-danger" onClick={() => deleteRun(rec)} disabled={busyId === rec.id}>
                        {busyId === rec.id ? "…" : "Delete"}
                      </button>
                    </div>
                  </div>

                  {rec.caption && (rec.caption.title || rec.caption.description) && (
                    <div style={{ margin: "10px 14px 0", padding: "8px 12px", background: "#faf7f2", border: "1px solid #eee3d3", borderRadius: 8, fontSize: 13, color: "#2a2118" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        {rec.caption.title && <div style={{ fontWeight: 600, flex: 1, minWidth: 0 }}>{rec.caption.title}</div>}
                        {rec.caption.description && (
                          <button
                            className="btn btn-tiny btn-ghost"
                            style={{ flexShrink: 0 }}
                            onClick={() => setCapOpen(p => ({ ...p, [rec.id]: !p[rec.id] }))}
                          >
                            {capOpen[rec.id] ? "▾ Description" : "▸ Description"}
                          </button>
                        )}
                      </div>
                      {capOpen[rec.id] && rec.caption.description && (
                        <div style={{ marginTop: 6, color: "#6b6152", whiteSpace: "pre-wrap" }}>{plainPreview(rec.caption.description, 0)}</div>
                      )}
                      {rec.caption.tags && rec.caption.tags.length > 0 && (
                        <div style={{ marginTop: 4, fontSize: 11, color: "#a89e8d" }}>
                          Tags: {rec.caption.tags.join(", ")}{rec.caption.productType ? ` · ${rec.caption.productType}` : ""}
                        </div>
                      )}
                      {capOpen[rec.id] && rec.caption.altTexts && rec.caption.altTexts.length > 0 && (
                        <div style={{ marginTop: 4, fontSize: 11, color: "#857a6c" }}>
                          {rec.caption.altTexts.map((a, i) => (
                            <div key={i}><strong>Alt {i + 1}</strong> ({a.label}): {a.alt}</div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  <div style={S.grid}>
                    {gridImages.map(im => {
                      const isSel = selected.has(im.url);
                      const rk = `${rec.id}:${im.templateId}`;
                      const entry = retries[rk];
                      const overlay = entry && (entry.status === "loading" || entry.status === "saving");
                      return (
                        <div key={rk} style={isSel ? { ...S.thumb, ...S.thumbSel } : S.thumb}>
                          <label style={S.check} onClick={e => e.stopPropagation()}>
                            <input type="checkbox" style={S.checkInput} checked={isSel} onChange={() => toggle(im.url)} />
                          </label>
                          <div style={{ position: "relative" }}>
                            <button
                              style={S.imgBtn}
                              onClick={() => setLightbox({ src: im.url, label: `${rec.fabricName} — ${im.templateLabel}` })}
                              title="Click to enlarge"
                            >
                              <img src={im.thumb || im.url} alt={im.templateLabel} style={S.img} loading="lazy" decoding="async" />
                            </button>
                            {overlay && (
                              <div style={S.retryOverlay}>
                                <span className="slot-spinner" />
                                <span style={S.retryOverlayText}>
                                  {entry.status === "saving" ? "Saving…" : (entry.kind === "three" ? "Generating 3…" : "Generating…")}
                                </span>
                              </div>
                            )}
                          </div>
                          <div style={{ ...S.footer, flexDirection: "column", alignItems: "stretch", gap: 4 }}>
                            <span style={S.label} title={im.templateLabel}>{im.templateLabel}</span>
                            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                              {im.templateId !== FLAT_ID && (
                                entry && entry.status === "loading" ? (
                                  <span style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 11, color: "#857a6c" }}>
                                    <span className="slot-spinner" style={S.btnSpinner} /> {entry.kind === "three" ? "Generating 3…" : "Generating…"}
                                  </span>
                                ) : entry && entry.status === "saving" ? (
                                  <span style={{ flex: 1, textAlign: "center", fontSize: 11, color: "#857a6c" }}>Saving…</span>
                                ) : entry && entry.status === "ready" ? (
                                  <>
                                    <button className="btn btn-tiny btn-primary" style={{ flex: 1 }} onClick={() => setOpenKey(rk)}
                                      title="Compare and choose whether to replace">
                                      {entry.kind === "three" ? `✓ Choose (${entry.candidates.filter(c => c.status === "done").length})` : "✓ Compare"}
                                    </button>
                                    <button className="btn btn-tiny btn-ghost" onClick={() => setEntry(rk, null)} title="Discard this retry">×</button>
                                  </>
                                ) : (
                                  <>
                                    {entry && entry.status === "error" && <span title={entry.error} style={{ color: "#B33A1F", fontSize: 12 }}>⚠</span>}
                                    <button className="btn btn-tiny" style={{ flex: 1 }} onClick={() => startRetry(rec, im, "single")} title="Regenerate this image">⟳</button>
                                    <button className="btn btn-tiny" style={{ flex: 1 }} onClick={() => startRetry(rec, im, "three")} title="Generate 3 variations and pick one">⟳3</button>
                                    <button className="btn btn-tiny btn-pro" style={{ flex: 1 }} onClick={() => startRetry(rec, im, "pro")} title="Regenerate with the Pro model (~2× cost)">✦</button>
                                  </>
                                )
                              )}
                              <button className="btn btn-tiny" style={{ flex: 1 }}
                                onClick={() => downloadUrl(im.url, rec.fabricName, im.templateLabel).catch(e => alert(e.message))}
                                title="Download this image">
                                ⤓
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {lightbox && <Lightbox image={lightbox} onClose={() => setLightbox(null)} />}
    </div>

    {openKey && retries[openKey] && retries[openKey].kind === "three" && (
      <RetryThreeModal
        templateLabel={retries[openKey].templateLabel}
        candidates={retries[openKey].candidates}
        currentUrl={retries[openKey].currentUrl}
        choosing={retries[openKey].status === "saving"}
        onChoose={(i) => { const c = retries[openKey].candidates[i]; if (c && c.status === "done") applyRetry(openKey, c.imageDataUrl); }}
        onClose={() => setOpenKey(null)}
      />
    )}

    {openKey && retries[openKey] && retries[openKey].kind !== "three" && (
      <CompareRetryModal
        templateLabel={retries[openKey].templateLabel}
        originalUrl={retries[openKey].currentUrl}
        state={{ status: "done", imageDataUrl: retries[openKey].imageDataUrl, saving: retries[openKey].status === "saving" }}
        onKeepNew={() => applyRetry(openKey, retries[openKey].imageDataUrl)}
        onKeepOriginal={() => dismissRetry(openKey)}
        onClose={() => setOpenKey(null)}
      />
    )}
    </>
  );
}
