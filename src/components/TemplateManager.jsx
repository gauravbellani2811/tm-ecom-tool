import React, { useRef, useState } from "react";
import { compressImage } from "../utils/compressImage";
import { apiFetch } from "../utils/api";

const MAX_ACTIVE = 5;

export default function TemplateManager({ templates, onRefresh, onEdit, onOpenLibrary, onReorder }) {
  const fileInputRef = useRef();
  // "compressing" | "uploading" | "analyzing" | null  (only the add slot can be busy)
  const [addStatus, setAddStatus] = useState(null);
  const [deleting, setDeleting] = useState({});
  const [dragIndex, setDragIndex] = useState(null);
  const dragFrom = useRef(null); // logic uses the ref (timing-independent); state is for visuals

  function startDrag(i) { dragFrom.current = i; setDragIndex(i); }
  function endDrag() { dragFrom.current = null; setDragIndex(null); }
  function handleDrop(dropIndex) {
    const from = dragFrom.current;
    endDrag();
    if (from === null || from === dropIndex) return;
    const ids = activeTemplates.map(t => t.id);
    const [moved] = ids.splice(from, 1);
    ids.splice(dropIndex, 0, moved);
    onReorder(ids);
  }

  const activeTemplates = templates.filter(t => t.active);
  const libraryCount = templates.length;
  const canAddMore = activeTemplates.length < MAX_ACTIVE;
  const hasInactiveInLibrary = libraryCount > activeTemplates.length;

  async function handleFileSelect(e) {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = "";

    const label = window.prompt("Name this template scene:") || `Template ${templates.length + 1}`;

    setAddStatus("compressing");

    let prepared;
    try {
      prepared = await compressImage(file, 1400, 0.88);
    } catch (err) {
      setAddStatus(null);
      alert(`Could not process image: ${err.message}`);
      return;
    }

    const formData = new FormData();
    formData.append("image", prepared);
    formData.append("label", label);

    setAddStatus("uploading");
    const analyzingTimer = setTimeout(() => setAddStatus("analyzing"), 1500);

    try {
      const res = await apiFetch("/api/templates", { method: "POST", body: formData });
      clearTimeout(analyzingTimer);
      if (!res.ok) {
        const text = await res.text();
        let msg = text;
        try { msg = JSON.parse(text).error || text; } catch {}
        alert(`Upload failed (${res.status}): ${msg.slice(0, 300)}`);
        return;
      }
      onRefresh();
    } catch (err) {
      clearTimeout(analyzingTimer);
      alert(`Upload failed: ${err.message}`);
    } finally {
      setAddStatus(null);
    }
  }

  async function handleDeactivate(id, e) {
    e.stopPropagation();
    if (!window.confirm("Remove this template from the active set? (It stays in the library.)")) return;
    setDeleting(prev => ({ ...prev, [id]: true }));
    try {
      await apiFetch(`/api/templates/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: false }),
      });
      onRefresh();
    } catch {
      alert("Failed to deactivate template");
    } finally {
      setDeleting(prev => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  }

  function slotStatusText(status) {
    if (status === "compressing") return "Processing…";
    if (status === "uploading") return "Uploading…";
    if (status === "analyzing") return "Analyzing scene…";
    return "";
  }

  return (
    <section className="panel">
      <div className="panel-header">
        <h2>Active Templates</h2>
        <div className="panel-header-meta">
          <span className="counter">
            {activeTemplates.length} of {MAX_ACTIVE} active
            {libraryCount > activeTemplates.length && (
              <> · {libraryCount - activeTemplates.length} in library</>
            )}
          </span>
          <button className="btn btn-secondary btn-tiny" onClick={onOpenLibrary}>
            Open Library
          </button>
        </div>
      </div>
      <div className="template-slots">
        {activeTemplates.map((tpl, i) => (
          <div
            key={tpl.id}
            className="template-slot"
            draggable
            onDragStart={() => startDrag(i)}
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); handleDrop(i); }}
            onDragEnd={endDrag}
            style={{ opacity: dragIndex === i ? 0.4 : 1, cursor: "grab" }}
          >
            <div className="template-slot-filled" onClick={() => onEdit(tpl)}>
              <img src={tpl.url} alt={tpl.label} draggable={false} />
              <div className="template-slot-overlay">
                <span className="template-slot-edit-hint">✎ Edit · drag to reorder</span>
              </div>
              <div className="template-slot-label">{tpl.label}</div>
              <button
                className="template-delete-btn"
                onClick={e => handleDeactivate(tpl.id, e)}
                title="Remove from active (kept in library)"
                disabled={deleting[tpl.id]}
              >
                {deleting[tpl.id] ? "…" : "×"}
              </button>
            </div>
          </div>
        ))}

        {canAddMore && (
          addStatus ? (
            <div className="template-slot template-slot-loading">
              <span className="slot-spinner" />
              <span className="slot-status-text">{slotStatusText(addStatus)}</span>
            </div>
          ) : (
            <div className="template-slot">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                style={{ display: "none" }}
                onChange={handleFileSelect}
              />
              <div className="template-slot-empty">
                {hasInactiveInLibrary ? (
                  <>
                    <button
                      className="btn btn-tiny btn-secondary"
                      onClick={onOpenLibrary}
                    >
                      From library
                    </button>
                    <span className="slot-divider">or</span>
                    <button
                      className="btn btn-tiny btn-ghost"
                      onClick={() => fileInputRef.current.click()}
                    >
                      + Upload new
                    </button>
                  </>
                ) : (
                  <div
                    className="slot-upload-trigger"
                    onClick={() => fileInputRef.current.click()}
                  >
                    <span className="plus">+</span>
                    <span>Add scene</span>
                  </div>
                )}
              </div>
            </div>
          )
        )}
      </div>
    </section>
  );
}
