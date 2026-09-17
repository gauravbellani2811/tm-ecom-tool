import React, { useRef, useState } from "react";
import { downloadFabricResults } from "../utils/zip";
import { makeFabric } from "../utils/fabrics";
import FabricCropper from "./FabricCropper";

const STATUS_PILLS = {
  pending: "Pending",
  preparing: "Preparing…",
  generating: "Generating…",
  done: "Done",
  error: "Error",
};

export default function FabricQueue({
  fabrics,
  onAdd,
  onRename,
  onRemove,
  onReplaceFile,
  onUpdateMeta,
  onSetDetail,
  onClearDetail,
  onGenerateAll,
  onRetryFailed,
  onClearDone,
  generating,
  templateCount,
}) {
  const inputRef = useRef();
  const detailInputRef = useRef();
  const [detailForId, setDetailForId] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [lightboxUrl, setLightboxUrl] = useState(null);
  const [croppingFabric, setCroppingFabric] = useState(null);

  function pickDetail(fabricId) {
    setDetailForId(fabricId);
    if (detailInputRef.current) { detailInputRef.current.value = ""; detailInputRef.current.click(); }
  }
  function onDetailSelected(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (file && detailForId && onSetDetail) onSetDetail(detailForId, file);
    setDetailForId(null);
  }

  function setTag(f, i, value) {
    const tags = [...(f.tags || ["", "", ""])];
    tags[i] = value;
    onUpdateMeta(f.id, { tags });
  }

  function handleCropped(blob) {
    const base = (croppingFabric.name || "fabric").replace(/[^a-z0-9\-_]+/gi, "-");
    const file = new File([blob], `${base}.jpg`, { type: "image/jpeg" });
    onReplaceFile(croppingFabric.id, file);
    setCroppingFabric(null);
  }

  async function handleFiles(files) {
    const arr = Array.from(files).filter(f =>
      ["image/jpeg", "image/png", "image/webp"].includes(f.type)
    );
    if (!arr.length) return;
    setProcessing(true);
    const prepared = [];
    for (const file of arr) {
      try { prepared.push(await makeFabric(file)); }
      catch { /* skip broken file */ }
    }
    setProcessing(false);
    if (prepared.length) onAdd(prepared);
  }

  function onDrop(e) {
    e.preventDefault();
    setDragOver(false);
    handleFiles(e.dataTransfer.files);
  }

  const pendingCount = fabrics.filter(f => f.status === "pending").length;
  const doneCount = fabrics.filter(f => f.status === "done").length;
  const errorCount = fabrics.filter(f => f.status === "error").length;
  const failedFabricCount = fabrics.filter(f => (f.results || []).some(r => r.error)).length;
  const hasAny = fabrics.length > 0;
  const hasGeneratable = pendingCount > 0 && templateCount > 0;
  const hasErrors = failedFabricCount > 0;

  return (
    <section className="panel">
      <div className="panel-header">
        <h2>Fabrics</h2>
        <div className="panel-header-meta">
          {hasAny && (
            <span className="counter">
              {fabrics.length} total · {pendingCount} pending · {doneCount} done
              {errorCount > 0 && <> · {errorCount} error</>}
            </span>
          )}
        </div>
      </div>

      <div
        className={`drop-zone${dragOver ? " drag-over" : ""}`}
        onClick={() => inputRef.current.click()}
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          style={{ display: "none" }}
          onChange={e => { handleFiles(e.target.files); e.target.value = ""; }}
        />
        <div className="drop-zone-content">
          <span className="drop-zone-icon">⬆</span>
          <span className="drop-zone-text">
            {processing ? "Processing images…" : "Drop fabric photos here or click to browse"}
          </span>
          <span className="drop-zone-hint">Multiple at once · jpg, png, webp</span>
        </div>
      </div>

      {hasAny && (
        <ul className="fabric-queue">
          {fabrics.map(f => {
            const editDisabled = f.status === "generating" || f.status === "preparing";
            return (
            <li key={f.id} className={`fabric-queue-row status-${f.status}`} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
              <button
                className="fabric-queue-thumb-btn"
                onClick={() => setLightboxUrl(f.previewUrl)}
                title="Click to enlarge"
              >
                <img src={f.previewUrl} alt="" className="fabric-queue-thumb" />
              </button>
              <input
                className="fabric-queue-name"
                style={{ flex: "0 0 120px", minWidth: 80 }}
                placeholder="SKU"
                title="Product name / SKU"
                value={f.name}
                onChange={e => onRename(f.id, e.target.value)}
                disabled={editDisabled}
              />
              <input
                className="fabric-queue-name"
                style={{ flex: "1 1 90px", minWidth: 75 }}
                placeholder="Colour"
                title="Colour (for the caption) — leave blank for social media"
                value={f.colour || ""}
                onChange={e => onUpdateMeta(f.id, { colour: e.target.value })}
                disabled={editDisabled}
              />
              <input
                className="fabric-queue-name"
                style={{ flex: "1 1 90px", minWidth: 75 }}
                placeholder="Adjective"
                title="Adjective, e.g. Vintage / Floral (for the caption)"
                value={f.adjective || ""}
                onChange={e => onUpdateMeta(f.id, { adjective: e.target.value })}
                disabled={editDisabled}
              />
              <input
                className="fabric-queue-name"
                style={{ flex: "1 1 90px", minWidth: 75 }}
                placeholder="Material"
                title="Material / fabric type, e.g. Satin (for the caption)"
                value={f.fabricType || ""}
                onChange={e => onUpdateMeta(f.id, { fabricType: e.target.value })}
                disabled={editDisabled}
              />
              {[0, 1, 2].map(i => (
                <input
                  key={i}
                  className="fabric-queue-name"
                  style={{ flex: "1 1 80px", minWidth: 65 }}
                  placeholder={`Tag ${i + 1}`}
                  title={`Tag ${i + 1} (craft / motif — for the caption)`}
                  value={(f.tags && f.tags[i]) || ""}
                  onChange={e => setTag(f, i, e.target.value)}
                  disabled={editDisabled}
                />
              ))}
              <span className={`status-pill status-pill-${f.status}`}>
                {f.status === "generating" || f.status === "preparing" ? (
                  <span className="pill-spinner" />
                ) : null}
                {STATUS_PILLS[f.status] || f.status}
              </span>
              <div className="fabric-queue-actions">
                {f.status === "done" && (
                  <button
                    className="btn btn-tiny"
                    onClick={() => downloadFabricResults(f).catch(err => alert(err.message))}
                    title="Download all images in this row"
                  >
                    ⤓ Download
                  </button>
                )}
                <button
                  className="btn btn-tiny btn-secondary"
                  onClick={() => setCroppingFabric(f)}
                  disabled={editDisabled}
                  title="Crop this fabric before generating"
                >
                  Crop
                </button>
                {f.detailPreviewUrl ? (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                    <button
                      className="btn btn-tiny btn-secondary"
                      onClick={() => setLightboxUrl(f.detailPreviewUrl)}
                      title="Close-up detail photo — sent to the AI to keep embroidery texture. Click to view."
                    >
                      🔍 Detail ✓
                    </button>
                    <button
                      className="btn btn-tiny btn-ghost"
                      onClick={() => onClearDetail(f.id)}
                      disabled={editDisabled}
                      title="Remove detail photo"
                    >
                      ×
                    </button>
                  </span>
                ) : (
                  <button
                    className="btn btn-tiny btn-ghost"
                    onClick={() => pickDetail(f.id)}
                    disabled={editDisabled}
                    title="Add a close-up of the embroidery/texture — sent to the AI so the result isn't rendered as a flat print"
                  >
                    ＋ Detail
                  </button>
                )}
                <button
                  className="btn btn-tiny btn-ghost"
                  onClick={() => onRemove(f.id)}
                  disabled={f.status === "generating"}
                  title="Remove from queue"
                >
                  ×
                </button>
              </div>
            </li>
            );
          })}
        </ul>
      )}

      <input
        ref={detailInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        style={{ display: "none" }}
        onChange={onDetailSelected}
      />

      <div className="panel-footer">
        <button
          className="btn btn-primary"
          onClick={onGenerateAll}
          disabled={!hasGeneratable || generating}
        >
          {generating ? "Generating…" : `Generate ${pendingCount > 0 ? `(${pendingCount})` : "All"}`}
        </button>
        {hasErrors && !generating && (
          <button className="btn btn-secondary" onClick={onRetryFailed}>
            Retry failed ({failedFabricCount})
          </button>
        )}
        {doneCount > 0 && !generating && (
          <button className="btn btn-ghost" onClick={onClearDone}>
            Clear completed
          </button>
        )}
        {templateCount === 0 && hasAny && (
          <span className="footer-hint">Add at least one template scene to generate.</span>
        )}
      </div>

      {lightboxUrl && (
        <div className="lightbox-overlay" onClick={() => setLightboxUrl(null)}>
          <button className="lightbox-close" onClick={() => setLightboxUrl(null)} title="Close (Esc)">×</button>
          <figure className="lightbox-figure" onClick={e => e.stopPropagation()}>
            <img src={lightboxUrl} alt="" className="lightbox-img" />
          </figure>
        </div>
      )}

      {croppingFabric && (
        <FabricCropper
          src={croppingFabric.previewUrl}
          name={croppingFabric.name}
          onClose={() => setCroppingFabric(null)}
          onCropped={handleCropped}
        />
      )}
    </section>
  );
}
