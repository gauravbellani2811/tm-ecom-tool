import React, { useEffect, useRef, useState } from "react";
import { apiFetch } from "../utils/api";
import { compressImage } from "../utils/compressImage";

const S = {
  list: { listStyle: "none", margin: 0, padding: "12px 20px", overflowY: "auto", flex: "1 1 auto", minHeight: 0 },
  uploadZone: { margin: "14px 20px", padding: "18px", border: "1.5px dashed #c9bfae", borderRadius: 10, background: "#faf7f2", textAlign: "center", cursor: "pointer", color: "#6b6152" },
};

export default function WaitlistModal({ onClose, onPull }) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  const [uploading, setUploading] = useState(0); // count remaining
  const [busyId, setBusyId] = useState(null);
  const [pullingAll, setPullingAll] = useState(false);
  const [attachingId, setAttachingId] = useState(null);
  const [lightboxUrl, setLightboxUrl] = useState(null);
  const inputRef = useRef();
  const detailInputRef = useRef();
  const detailForIdRef = useRef(null);
  const itemsRef = useRef([]);
  useEffect(() => { itemsRef.current = items || []; }, [items]);

  useEffect(() => {
    function onKey(e) {
      if (e.key !== "Escape") return;
      if (lightboxUrl) setLightboxUrl(null);
      else onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, lightboxUrl]);

  // Local metadata edits (instant), persisted to the server on blur.
  function setField(id, patch) {
    setItems(prev => (prev || []).map(it => (it.id === id ? { ...it, ...patch } : it)));
  }
  function setTag(id, i, val) {
    setItems(prev => (prev || []).map(it => {
      if (it.id !== id) return it;
      const tags = [...(it.tags || ["", "", ""])];
      tags[i] = val;
      return { ...it, tags };
    }));
  }
  async function persist(id) {
    const it = itemsRef.current.find(x => x.id === id);
    if (!it) return;
    try {
      await apiFetch(`/api/waitlist?id=${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: it.name, colour: it.colour, adjective: it.adjective, fabricType: it.fabricType, tags: it.tags || [] }),
      });
    } catch (err) { /* keep local; retries on next blur */ }
  }

  // Attach a close-up detail photo to an existing item (uploaded from the phone).
  function pickDetail(id) {
    detailForIdRef.current = id;
    if (detailInputRef.current) { detailInputRef.current.value = ""; detailInputRef.current.click(); }
  }
  async function onDetailSelected(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    const id = detailForIdRef.current;
    detailForIdRef.current = null;
    if (!file || !id) return;
    setAttachingId(id); setError(null);
    try {
      const compressed = await compressImage(file, 1500, 0.85);
      const fd = new FormData();
      fd.append("image", compressed);
      fd.append("attachTo", id);
      const res = await apiFetch("/api/waitlist", { method: "POST", body: fd });
      if (!res.ok) { const t = await res.text(); let m=t; try{m=JSON.parse(t).error||t}catch{}; throw new Error(m.slice(0,160)); }
      const data = await res.json();
      setItems(Array.isArray(data) ? data : []);
    } catch (err) { setError(err.message); }
    finally { setAttachingId(null); }
  }
  async function removeDetail(id) {
    setAttachingId(id); setError(null);
    try {
      const res = await apiFetch(`/api/waitlist?id=${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ removeDetail: true }),
      });
      const data = await res.json();
      setItems(Array.isArray(data) ? data : []);
    } catch (err) { setError(err.message); }
    finally { setAttachingId(null); }
  }

  async function load() {
    try {
      const res = await apiFetch("/api/waitlist");
      const data = await res.json();
      setItems(Array.isArray(data) ? data : []);
    } catch (err) { setError(err.message); setItems([]); }
  }
  useEffect(() => { load(); }, []);

  async function handleUpload(e) {
    const files = Array.from(e.target.files || []).filter(f => f.type.startsWith("image/"));
    e.target.value = "";
    if (!files.length) return;
    setError(null);
    setUploading(files.length);
    let last = null;
    for (const file of files) {
      try {
        const compressed = await compressImage(file, 1600, 0.9);
        const fd = new FormData();
        fd.append("image", compressed);
        fd.append("name", (file.name || "photo").replace(/\.[^.]+$/, ""));
        const res = await apiFetch("/api/waitlist", { method: "POST", body: fd });
        if (!res.ok) { const t = await res.text(); let m=t; try{m=JSON.parse(t).error||t}catch{}; throw new Error(m.slice(0,160)); }
        last = await res.json();
      } catch (err) { setError(err.message); }
      finally { setUploading(n => n - 1); }
    }
    if (last) setItems(last);
    else load();
  }

  async function removeItem(item) {
    setBusyId(item.id);
    try {
      const res = await apiFetch(`/api/waitlist?id=${item.id}`, { method: "DELETE" });
      const data = await res.json();
      setItems(Array.isArray(data) ? data : []);
    } catch (err) { setError(err.message); }
    finally { setBusyId(null); }
  }

  async function pull(item) {
    const current = itemsRef.current.find(x => x.id === item.id) || item; // carry latest metadata
    setBusyId(item.id);
    setError(null);
    try {
      await onPull(current);                                 // add to fabric queue (with tags)
      const res = await apiFetch(`/api/waitlist?id=${item.id}`, { method: "DELETE" }); // move (remove from waitlist)
      const data = await res.json();
      setItems(Array.isArray(data) ? data : []);
    } catch (err) { setError(err.message); }
    finally { setBusyId(null); }
  }

  async function pullAll() {
    if (!items || !items.length) return;
    setPullingAll(true);
    setError(null);
    for (const item of [...itemsRef.current]) {
      try {
        await onPull(item);
        await apiFetch(`/api/waitlist?id=${item.id}`, { method: "DELETE" });
      } catch (err) { setError(err.message); }
    }
    setPullingAll(false);
    load();
  }

  const count = items ? items.length : 0;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel modal-panel-wide" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Waitlist</h2>
          <div className="modal-header-meta">
            <span className="counter">
              {items ? `${count} photo${count === 1 ? "" : "s"} · kept 7 days` : "Loading…"}
            </span>
            {count > 0 && (
              <button className="btn btn-tiny btn-primary" onClick={pullAll} disabled={pullingAll}>
                {pullingAll ? "Adding…" : `Add all to queue (${count})`}
              </button>
            )}
            <button className="modal-close" onClick={onClose} title="Close (Esc)">×</button>
          </div>
        </div>

        <label style={S.uploadZone}>
          <input ref={inputRef} type="file" accept="image/*" multiple style={{ display: "none" }} onChange={handleUpload} disabled={uploading > 0} />
          {uploading > 0 ? (
            <><span className="slot-spinner" /> <span> Uploading {uploading}…</span></>
          ) : (
            <>
              <div style={{ fontSize: 22, lineHeight: 1 }}>⬆</div>
              <div style={{ marginTop: 6 }}>Tap to add photos from this device</div>
              <div style={{ fontSize: 11, color: "#a89e8d", marginTop: 2 }}>Upload from your phone here, then pull to the queue on your laptop</div>
            </>
          )}
        </label>

        {error && <div className="error-banner library-error">{error}</div>}

        {!items && <div className="history-empty">Loading…</div>}
        {items && items.length === 0 && (
          <div className="history-empty">
            <span className="icon">📥</span>
            <span>Your waitlist is empty.</span>
            <span className="hint">Add photos above (from your phone), then open this on your laptop to pull them into the generation queue.</span>
          </div>
        )}

        <input
          ref={detailInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          style={{ display: "none" }}
          onChange={onDetailSelected}
        />

        {items && items.length > 0 && (
          <ul className="fabric-queue" style={S.list}>
            {items.map(item => {
              const busy = busyId === item.id;
              const attaching = attachingId === item.id;
              return (
                <li key={item.id} className="fabric-queue-row" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                  <button className="fabric-queue-thumb-btn" onClick={() => setLightboxUrl(item.url)} title="Click to enlarge">
                    <img src={item.url} alt={item.name} className="fabric-queue-thumb" loading="lazy" />
                  </button>
                  <input className="fabric-queue-name" style={{ flex: "0 0 110px", minWidth: 80 }}
                    placeholder="SKU" title="Product SKU / name" value={item.name || ""} disabled={busy}
                    onChange={e => setField(item.id, { name: e.target.value })} onBlur={() => persist(item.id)} />
                  <input className="fabric-queue-name" style={{ flex: "1 1 90px", minWidth: 75 }}
                    placeholder="Colour" title="Colour (for the caption)" value={item.colour || ""} disabled={busy}
                    onChange={e => setField(item.id, { colour: e.target.value })} onBlur={() => persist(item.id)} />
                  <input className="fabric-queue-name" style={{ flex: "1 1 90px", minWidth: 75 }}
                    placeholder="Adjective" title="Adjective (for the caption)" value={item.adjective || ""} disabled={busy}
                    onChange={e => setField(item.id, { adjective: e.target.value })} onBlur={() => persist(item.id)} />
                  <input className="fabric-queue-name" style={{ flex: "1 1 90px", minWidth: 75 }}
                    placeholder="Material" title="Material / fabric type (for the caption)" value={item.fabricType || ""} disabled={busy}
                    onChange={e => setField(item.id, { fabricType: e.target.value })} onBlur={() => persist(item.id)} />
                  {[0, 1, 2].map(i => (
                    <input key={i} className="fabric-queue-name" style={{ flex: "1 1 80px", minWidth: 65 }}
                      placeholder={`Tag ${i + 1}`} title={`Tag ${i + 1} (craft / motif)`} value={(item.tags && item.tags[i]) || ""} disabled={busy}
                      onChange={e => setTag(item.id, i, e.target.value)} onBlur={() => persist(item.id)} />
                  ))}
                  <div className="fabric-queue-actions">
                    {item.detailUrl ? (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                        <button className="btn btn-tiny btn-secondary" onClick={() => setLightboxUrl(item.detailUrl)}
                          title="Close-up detail photo — travels with this fabric into the queue. Click to view.">
                          🔍 Close-up ✓
                        </button>
                        <button className="btn btn-tiny btn-ghost" disabled={busy || attaching}
                          onClick={() => removeDetail(item.id)} title="Remove close-up detail photo">×</button>
                      </span>
                    ) : (
                      <button className="btn btn-tiny btn-secondary" disabled={busy || attaching}
                        onClick={() => pickDetail(item.id)}
                        title="Add a close-up of the embroidery/texture — it travels with this fabric into the queue so the result keeps the real texture">
                        {attaching ? "Uploading…" : "＋ Close-up detail"}
                      </button>
                    )}
                    <button className="btn btn-tiny btn-primary" disabled={busy} onClick={() => pull(item)}>
                      {busy ? "…" : "Add to queue"}
                    </button>
                    <button className="btn btn-tiny btn-ghost" disabled={busy} onClick={() => removeItem(item)} title="Remove">×</button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {lightboxUrl && (
          <div className="lightbox-overlay" onClick={() => setLightboxUrl(null)}>
            <button className="lightbox-close" onClick={() => setLightboxUrl(null)} title="Close (Esc)">×</button>
            <figure className="lightbox-figure" onClick={e => e.stopPropagation()}>
              <img src={lightboxUrl} alt="" className="lightbox-img" />
            </figure>
          </div>
        )}
      </div>
    </div>
  );
}
