import React, { useEffect, useRef, useState } from "react";
import { compressImage } from "../utils/compressImage";
import { downloadFromUrl } from "../utils/zip";
import { apiFetch } from "../utils/api";

const MAX_ACTIVE = 5;

export default function TemplateLibrary({ templates, onClose, onRefresh, onEdit, onCrop }) {
  const inputRef = useRef();
  const [uploading, setUploading] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    function onKey(e) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const [alting, setAlting] = useState(false);
  const activeCount = templates.filter(t => t.active).length;
  const canActivateMore = activeCount < MAX_ACTIVE;

  async function backfillAlt() {
    setAlting(true);
    setError(null);
    try {
      const res = await apiFetch("/api/templates", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "backfillAlt" }),
      });
      if (!res.ok) { setError("Could not generate alt patterns"); return; }
      const updated = await res.json();
      onRefresh(updated);
    } catch (err) {
      setError(err.message);
    } finally {
      setAlting(false);
    }
  }

  async function handleNewUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = "";

    const label = window.prompt("Name this template scene:") || `Template ${templates.length + 1}`;

    setUploading(true);
    setError(null);
    try {
      const prepared = await compressImage(file, 1400, 0.88);
      const formData = new FormData();
      formData.append("image", prepared);
      formData.append("label", label);
      const res = await apiFetch("/api/templates", { method: "POST", body: formData });
      if (!res.ok) {
        const text = await res.text();
        let msg = text;
        try { msg = JSON.parse(text).error || text; } catch {}
        setError(`Upload failed (${res.status}): ${msg.slice(0, 200)}`);
        return;
      }
      const updated = await res.json();
      onRefresh(updated);
    } catch (err) {
      setError(`Upload failed: ${err.message}`);
    } finally {
      setUploading(false);
    }
  }

  async function toggleActive(tpl) {
    if (!tpl.active && !canActivateMore) {
      setError(`You can have at most ${MAX_ACTIVE} active templates. Deactivate one first.`);
      return;
    }
    setBusyId(tpl.id);
    setError(null);
    try {
      const res = await apiFetch(`/api/templates/${tpl.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !tpl.active }),
      });
      if (!res.ok) {
        const text = await res.text();
        let msg = text;
        try { msg = JSON.parse(text).error || text; } catch {}
        setError(msg.slice(0, 200));
        return;
      }
      const updated = await res.json();
      onRefresh(updated);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  async function deleteTemplate(tpl) {
    if (!window.confirm(`Delete "${tpl.label}"? This removes it from the library entirely.`)) return;
    setBusyId(tpl.id);
    setError(null);
    try {
      const res = await apiFetch(`/api/templates/${tpl.id}`, { method: "DELETE" });
      if (!res.ok) {
        setError("Failed to delete template");
        return;
      }
      const updated = await res.json();
      onRefresh(updated);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel modal-panel-wide" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Template Library</h2>
          <div className="modal-header-meta">
            <span className="counter">
              {activeCount} active · {templates.length} total
            </span>
            <button className="btn btn-tiny btn-secondary" onClick={backfillAlt} disabled={alting}
              title="Auto-generate the SEO alt-text pattern for any template missing one">
              {alting ? "Generating…" : "Auto-fill alt patterns"}
            </button>
            <button className="modal-close" onClick={onClose} title="Close (Esc)">×</button>
          </div>
        </div>

        {error && <div className="error-banner library-error">{error}</div>}

        <div className="library-grid">
          {templates.map(tpl => (
            <div key={tpl.id} className={`library-card${tpl.active ? " library-card-active" : ""}`}>
              <div className="library-card-thumb-wrap">
                <img src={tpl.url} alt={tpl.label} className="library-card-thumb" />
                {tpl.active && <span className="library-active-badge">Active</span>}
                <button
                  className="library-card-download"
                  onClick={() => downloadFromUrl(tpl.url, tpl.label).catch(e => alert(e.message))}
                  title="Download this template image"
                >
                  ⤓
                </button>
              </div>
              <div className="library-card-body">
                <div className="library-card-label" title={tpl.label}>{tpl.label}</div>
                <div className="library-card-actions">
                  <button
                    className={`btn btn-tiny ${tpl.active ? "btn-secondary" : "btn-primary"}`}
                    onClick={() => toggleActive(tpl)}
                    disabled={busyId === tpl.id || (!tpl.active && !canActivateMore)}
                    title={tpl.active ? "Remove from active set" : "Add to active set"}
                  >
                    {busyId === tpl.id ? "…" : tpl.active ? "Deactivate" : "Activate"}
                  </button>
                </div>
                <div className="library-card-actions library-card-actions-secondary">
                  <button
                    className="btn btn-tiny btn-secondary"
                    onClick={() => onCrop(tpl)}
                    disabled={busyId === tpl.id}
                    title="Crop this template image"
                  >
                    Crop
                  </button>
                  <button
                    className="btn btn-tiny btn-secondary"
                    onClick={() => onEdit(tpl)}
                    disabled={busyId === tpl.id}
                    title="Edit label and prompt"
                  >
                    Edit
                  </button>
                  <button
                    className="btn btn-tiny btn-danger"
                    onClick={() => deleteTemplate(tpl)}
                    disabled={busyId === tpl.id}
                    title="Permanently delete from library"
                  >
                    {busyId === tpl.id ? "…" : "Delete"}
                  </button>
                </div>
              </div>
            </div>
          ))}

          <label className={`library-card library-card-upload${uploading ? " uploading" : ""}`}>
            <input
              ref={inputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={handleNewUpload}
              style={{ display: "none" }}
              disabled={uploading}
            />
            <div className="library-card-thumb-wrap library-card-upload-inner">
              {uploading ? (
                <>
                  <span className="slot-spinner" />
                  <span className="library-upload-status">Uploading & analyzing…</span>
                </>
              ) : (
                <>
                  <span className="library-upload-plus">+</span>
                  <span className="library-upload-text">Add new template</span>
                </>
              )}
            </div>
          </label>
        </div>
      </div>
    </div>
  );
}
