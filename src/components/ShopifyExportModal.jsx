import React, { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../utils/api";
import {
  downloadShopifyCsv, productFromRecord, groupTitle, imageFileName, orderedImages,
} from "../utils/shopifyCsv";

// Build the Shopify import CSV from selected history runs.
// Each SKU starts as its own product; selecting several and grouping them makes
// one product with colour variants (matching how the store's real import file works).

const S = {
  body: { padding: "12px 20px", overflowY: "auto", flex: "1 1 auto", minHeight: 0 },
  bar: { display: "flex", alignItems: "center", gap: 8, padding: "10px 20px", background: "#f3efe9", borderBottom: "1px solid #e4ddd2", flexWrap: "wrap" },
  group: { border: "1px solid #e4ddd2", borderRadius: 10, marginBottom: 12, overflow: "hidden", background: "#fff" },
  groupHead: { display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "#faf7f2", borderBottom: "1px solid #eee3d3", flexWrap: "wrap" },
  row: { display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderBottom: "1px solid #f0ebe3", flexWrap: "wrap" },
  thumb: { width: 44, height: 44, objectFit: "cover", borderRadius: 6, border: "1px solid #e4ddd2", flexShrink: 0, display: "block" },
  thumbBtn: { padding: 0, border: "none", background: "none", cursor: "zoom-in", lineHeight: 0, flexShrink: 0 },
  sku: { fontWeight: 600, fontSize: 13, minWidth: 90 },
  inp: { fontSize: 13, padding: "6px 8px", border: "1px solid #e4ddd2", borderRadius: 6, boxSizing: "border-box" },
  meta: { fontSize: 11, color: "#857a6c" },
  foot: { display: "flex", alignItems: "center", gap: 10, padding: "12px 20px", borderTop: "1px solid #e4ddd2", flexWrap: "wrap" },
};

let gidSeq = 0;

// Defined at module scope (not inside the modal) so React keeps the same element
// identity across renders — otherwise every keystroke remounts the row and the
// price/colour inputs lose focus mid-typing.
function Row({ it, inGroup, picked, onTogglePick, onChange, onEnlarge }) {
  return (
    <div style={S.row}>
      {!inGroup && (
        <input type="checkbox" checked={picked} onChange={() => onTogglePick(it.id)}
          style={{ width: 16, height: 16, accentColor: "#C4552A" }} title="Select to group as colour variants" />
      )}
      {it.images[0] && (
        <button type="button" style={S.thumbBtn} title="Click to enlarge"
          onClick={() => onEnlarge(it.images[0].url, it.sku)}>
          <img src={it.images[0].thumb || it.images[0].url} alt="" style={S.thumb} loading="lazy" />
        </button>
      )}
      <span style={S.sku}>{it.sku}</span>
      {inGroup ? (
        <label style={S.meta}>Colour
          <input style={{ ...S.inp, width: 130, marginLeft: 6 }} value={it.colour || ""}
            onChange={e => onChange(it.id, { colour: e.target.value })} placeholder="Colour" />
        </label>
      ) : (
        <span style={{ ...S.meta, flex: 1, minWidth: 160 }}>{it.title}</span>
      )}
      {!inGroup && (
        <label style={S.meta}>Price /m
          <input
            style={{ ...S.inp, width: 80, marginLeft: 6, border: `1px solid ${String(it.price || "").trim() ? "#e4ddd2" : "#C4552A"}` }}
            value={it.price || ""} onChange={e => onChange(it.id, { price: e.target.value })} placeholder="200" inputMode="decimal" />
        </label>
      )}
      <span style={S.meta}>{it.images.length} images</span>
    </div>
  );
}

// One selectable product in the "choose what to export" step.
function PickRow({ rec, checked, onToggle, onEnlarge }) {
  const imgs = orderedImages(rec);
  const title = (rec.caption && rec.caption.title) || rec.fabricName;
  return (
    <label style={{ ...S.row, cursor: "pointer", background: checked ? "#faf5f0" : "transparent" }}>
      <input type="checkbox" checked={checked} onChange={() => onToggle(rec.id)}
        style={{ width: 16, height: 16, accentColor: "#C4552A" }} />
      {imgs[0] && (
        <button type="button" style={S.thumbBtn} title="Click to enlarge"
          onClick={e => { e.preventDefault(); e.stopPropagation(); onEnlarge(imgs[0].url, rec.fabricName); }}>
          <img src={imgs[0].thumb || imgs[0].url} alt="" style={S.thumb} loading="lazy" />
        </button>
      )}
      <span style={S.sku}>{rec.fabricName}</span>
      <span style={{ ...S.meta, flex: 1, minWidth: 160 }}>{title}</span>
      <span style={S.meta}>{imgs.length} images</span>
      {!(rec.caption && rec.caption.title) && (
        <span style={{ fontSize: 10, color: "#b5862b", background: "#FAEFD8", padding: "2px 6px", borderRadius: 99 }}>no caption</span>
      )}
    </label>
  );
}

export default function ShopifyExportModal({ records, onClose }) {
  // Step 1 = choose products from history, step 2 = group / price / download.
  const [step, setStep] = useState("select");
  const [chosen, setChosen] = useState(() => new Set());
  const [search, setSearch] = useState("");
  const [items, setItems] = useState([]);
  const [groups, setGroups] = useState({});      // gid -> { title }
  const [picked, setPicked] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [lightbox, setLightbox] = useState(null);   // { src, label }
  const enlarge = (src, label) => setLightbox({ src, label });
  // Opened from the home page there's no history to hand in, so fetch it here.
  const [loaded, setLoaded] = useState(records || null);

  useEffect(() => {
    if (records) { setLoaded(records); return; }
    let alive = true;
    apiFetch("/api/history")
      .then(r => r.json())
      .then(d => { if (alive) setLoaded(Array.isArray(d) ? d : []); })
      .catch(e => { if (alive) { setError(e.message); setLoaded([]); } });
    return () => { alive = false; };
  }, [records]);

  // Only runs that actually have exportable images.
  const exportable = useMemo(
    () => (loaded || []).filter(r => orderedImages(r).length > 0),
    [loaded]
  );
  const q = search.trim().toLowerCase();
  const listed = q
    ? exportable.filter(r => (r.fabricName || "").toLowerCase().includes(q))
    : exportable;

  const toggleChosen = id => setChosen(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  // Build the editable product list from whatever was ticked, then move to step 2.
  function goConfigure() {
    const picks = exportable.filter(r => chosen.has(r.id));
    if (!picks.length) return;
    setItems(picks.map(r => {
      const p = productFromRecord(r);
      const v = p.variants[0];
      return {
        id: r.id, sku: v.sku, colour: v.colour, material: v.material, adjective: v.adjective,
        title: p.title, bodyHtml: p.bodyHtml, tags: p.tags, images: orderedImages(r),
        price: "", groupId: null,
      };
    }));
    setGroups({});
    setPicked(new Set());
    setStep("configure");
  }

  useEffect(() => {
    function onKey(e) {
      if (e.key !== "Escape" || busy) return;
      if (lightbox) setLightbox(null);
      else onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy, lightbox]);

  const setItem = (id, patch) => setItems(prev => prev.map(it => it.id === id ? { ...it, ...patch } : it));
  const togglePick = id => setPicked(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  function groupSelected() {
    const ids = [...picked];
    if (ids.length < 2) return;
    const gid = `g${++gidSeq}`;
    const members = items.filter(it => ids.includes(it.id));
    setGroups(prev => ({ ...prev, [gid]: { title: groupTitle(members), price: "" } }));
    setItems(prev => prev.map(it => ids.includes(it.id) ? { ...it, groupId: gid } : it));
    setPicked(new Set());
  }

  function ungroup(gid) {
    setItems(prev => prev.map(it => it.groupId === gid ? { ...it, groupId: null } : it));
    setGroups(prev => { const n = { ...prev }; delete n[gid]; return n; });
  }

  // Ordered render list: groups (in first-member order) and singles.
  const blocks = useMemo(() => {
    const out = [], seen = new Set();
    for (const it of items) {
      if (it.groupId) {
        if (seen.has(it.groupId)) continue;
        seen.add(it.groupId);
        out.push({ type: "group", gid: it.groupId, members: items.filter(x => x.groupId === it.groupId) });
      } else out.push({ type: "single", item: it });
    }
    return out;
  }, [items]);

  const productCount = blocks.length;
  const rowCount = blocks.reduce((n, b) => {
    const members = b.type === "group" ? b.members : [b.item];
    return n + members.reduce((m, x) => m + Math.max(x.images.length, 1), 0);
  }, 0);
  const priceOf = b => b.type === "group" ? ((groups[b.gid] || {}).price || "") : (b.item.price || "");
  const missingPrice = blocks.filter(b => !String(priceOf(b)).trim()).length;

  function toProducts() {
    return blocks.map(b => {
      const members = b.type === "group" ? b.members : [b.item];
      const head = members[0];
      return {
        title: b.type === "group" ? (groups[b.gid] || {}).title || groupTitle(members) : head.title,
        price: b.type === "group" ? (groups[b.gid] || {}).price : head.price,
        bodyHtml: head.bodyHtml,
        tags: head.tags,
        variants: members.map(m => ({
          sku: m.sku, colour: m.colour, material: m.material, adjective: m.adjective, images: m.images,
        })),
      };
    });
  }

  // Copy each image to a clean, Shopify-friendly filename so the media library
  // shows EC17010_Tray.jpg instead of a UUID. Falls back to the original URL.
  async function cleanUrls(products) {
    const payload = [];
    products.forEach(p => p.variants.forEach(v => v.images.forEach(im => {
      payload.push({ url: im.url, filename: imageFileName(v.sku, im.templateLabel) });
    })));
    if (!payload.length) return {};
    try {
      const res = await apiFetch("/api/shopify-images", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ images: payload }),
      });
      const d = await res.json();
      return (d && d.urls) || {};
    } catch { return {}; }
  }

  async function download() {
    setBusy(true); setError(null);
    try {
      const products = toProducts();
      const map = await cleanUrls(products);
      products.forEach(p => p.variants.forEach(v => {
        v.images = v.images.map(im => ({ ...im, url: map[im.url] || im.url }));
      }));
      downloadShopifyCsv(products);
      onClose();
    } catch (e) {
      setError(e.message);
    } finally { setBusy(false); }
  }

  return (
    <div className="modal-overlay" onClick={busy ? undefined : onClose}>
      <div className="modal-panel modal-panel-wide" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{step === "select" ? "Shopify CSV — choose products" : "Shopify CSV"}</h2>
          <div className="modal-header-meta">
            {step === "select"
              ? <span className="counter">{chosen.size} of {exportable.length} selected</span>
              : <span className="counter">{productCount} products · {rowCount} rows</span>}
            <button className="modal-close" onClick={onClose} title="Close (Esc)" disabled={busy}>×</button>
          </div>
        </div>

        {step === "select" ? (
          <div style={S.bar}>
            <input
              type="text" value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search SKU…" style={{ ...S.inp, width: 160 }}
            />
            <button className="btn btn-tiny btn-ghost" onClick={() => setChosen(new Set(listed.map(r => r.id)))}>
              Select all{q ? ` (${listed.length})` : ""}
            </button>
            <button className="btn btn-tiny btn-ghost" onClick={() => setChosen(new Set())} disabled={!chosen.size}>Clear</button>
            <span style={{ fontSize: 12, color: "#6b6152" }}>Pick the products to include in the CSV.</span>
          </div>
        ) : (
          <div style={S.bar}>
            <button className="btn btn-tiny btn-ghost" onClick={() => setStep("select")}>← Back to selection</button>
            <span style={{ fontSize: 12, color: "#6b6152" }}>
              Tick two or more SKUs of the same design, then group them as colour variants.
            </span>
            <button className="btn btn-tiny btn-secondary" onClick={groupSelected} disabled={picked.size < 2}>
              Group selected as colour variants ({picked.size})
            </button>
          </div>
        )}

        {error && <div className="error-banner library-error">{error}</div>}

        {step === "select" && (
          <div style={S.body}>
            {!loaded && <div className="history-empty">Loading products…</div>}
            {loaded && !listed.length && (
              <div className="history-empty">
                <span className="icon">🗂</span>
                <span>{q ? `No products match “${search}”.` : "No products with images to export."}</span>
              </div>
            )}
            {listed.map(r => (
              <div key={r.id} style={{ ...S.group, marginBottom: 6 }}>
                <PickRow rec={r} checked={chosen.has(r.id)} onToggle={toggleChosen} onEnlarge={enlarge} />
              </div>
            ))}
          </div>
        )}

        {step === "configure" && <div style={S.body}>
          {blocks.map(b => b.type === "group" ? (
            <div key={b.gid} style={S.group}>
              <div style={S.groupHead}>
                <strong style={{ fontSize: 12, color: "#857a6c" }}>VARIANT PRODUCT</strong>
                <input style={{ ...S.inp, flex: 1, minWidth: 200, fontWeight: 600 }}
                  value={(groups[b.gid] || {}).title || ""}
                  onChange={e => setGroups(p => ({ ...p, [b.gid]: { ...(p[b.gid] || {}), title: e.target.value } }))}
                  placeholder="Shared product title" />
                <label style={S.meta}>Price /m
                  <input
                    style={{ ...S.inp, width: 80, marginLeft: 6, border: `1px solid ${String((groups[b.gid] || {}).price || "").trim() ? "#e4ddd2" : "#C4552A"}` }}
                    value={(groups[b.gid] || {}).price || ""}
                    onChange={e => setGroups(p => ({ ...p, [b.gid]: { ...(p[b.gid] || {}), price: e.target.value } }))}
                    placeholder="200" inputMode="decimal" />
                </label>
                <span style={S.meta}>{b.members.length} colours · one price</span>
                <button className="btn btn-tiny btn-ghost" onClick={() => ungroup(b.gid)}>Ungroup</button>
              </div>
              {b.members.map(m => (
                <Row key={m.id} it={m} inGroup picked={false} onTogglePick={togglePick} onChange={setItem} onEnlarge={enlarge} />
              ))}
            </div>
          ) : (
            <div key={b.item.id} style={S.group}>
              <Row it={b.item} picked={picked.has(b.item.id)} onTogglePick={togglePick} onChange={setItem} onEnlarge={enlarge} />
            </div>
          ))}
        </div>}

        <div style={S.foot}>
          {step === "select" ? (
            <>
              <button className="btn btn-primary" onClick={goConfigure} disabled={!chosen.size}>
                Next: group &amp; price ({chosen.size}) →
              </button>
              {!chosen.size && (
                <span style={{ fontSize: 12, color: "#857a6c" }}>Select at least one product.</span>
              )}
            </>
          ) : (
            <>
              <button className="btn btn-primary" onClick={download} disabled={busy || missingPrice > 0 || !productCount}>
                {busy ? "Preparing…" : "⤓ Download CSV"}
              </button>
              {missingPrice > 0 && (
                <span style={{ fontSize: 12, color: "#B33A1F" }}>
                  Enter a price for {missingPrice} product{missingPrice === 1 ? "" : "s"} to continue.
                </span>
              )}
            </>
          )}
          {productCount > 150 && step === "configure" && (
            <span style={{ fontSize: 12, color: "#b5862b" }}>
              Large export — consider splitting into files of ~100 products.
            </span>
          )}
          <span style={{ fontSize: 11, color: "#857a6c", marginLeft: "auto" }}>
            Enter the price per metre — the sheet carries half (the 0.5 m price) · imports as <strong>draft</strong>
          </span>
        </div>

        {lightbox && (
          <div className="lightbox-overlay" onClick={() => setLightbox(null)}>
            <button className="lightbox-close" onClick={() => setLightbox(null)} title="Close (Esc)">&times;</button>
            <figure className="lightbox-figure" onClick={e => e.stopPropagation()}>
              <img src={lightbox.src} alt="" className="lightbox-img" />
              {lightbox.label && <figcaption className="lightbox-caption">{lightbox.label}</figcaption>}
            </figure>
          </div>
        )}
      </div>
    </div>
  );
}
