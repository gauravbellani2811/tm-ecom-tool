import React, { useEffect, useRef, useState } from "react";
import ReactCrop, { centerCrop, makeAspectCrop } from "react-image-crop";
import "react-image-crop/dist/ReactCrop.css";
import { cropToBlob } from "../utils/cropImage";
import { apiFetch } from "../utils/api";

const MODES = [
  { key: "1:1", label: "1:1", aspect: 1 },
  { key: "free", label: "Freehand", aspect: undefined },
  { key: "16:9", label: "16:9", aspect: 16 / 9 },
];

// Cache-bust so the CORS fetch never reuses a cached non-CORS <img> response
// (r2.dev sends `Vary: Origin`; the template thumbnail loads via <img> with no
// Origin, poisoning the cache and tainting the export canvas).
function bust(url) {
  return url + (url.includes("?") ? "&" : "?") + "cb=" + Date.now();
}

function makeDefaultCrop(width, height, aspect) {
  if (aspect) {
    return centerCrop(makeAspectCrop({ unit: "%", width: 80 }, aspect, width, height), width, height);
  }
  return centerCrop({ unit: "%", width: 80, height: 80 }, width, height);
}

export default function TemplateCropper({ template, onClose, onSaved }) {
  const imgRef = useRef(null);
  const [imgSrc, setImgSrc] = useState(null);
  const [crop, setCrop] = useState();
  const [completedCrop, setCompletedCrop] = useState(null);
  const [aspect, setAspect] = useState(1);
  const [modeKey, setModeKey] = useState("1:1");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    function onKey(e) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Load via a fetched object URL so the export canvas isn't CORS-tainted.
  useEffect(() => {
    let objectUrl = null;
    (async () => {
      try {
        const res = await fetch(bust(template.url));
        if (!res.ok) throw new Error("fetch failed");
        const blob = await res.blob();
        objectUrl = URL.createObjectURL(blob);
        setImgSrc(objectUrl);
      } catch {
        // Fallback: load the (cache-busted) URL directly with CORS so the canvas
        // still isn't tainted.
        setImgSrc(bust(template.url));
      }
    })();
    return () => { if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [template.url]);

  function onImageLoad(e) {
    const { width, height } = e.currentTarget;
    setCrop(makeDefaultCrop(width, height, aspect));
  }

  function selectMode(m) {
    setModeKey(m.key);
    setAspect(m.aspect);
    const img = imgRef.current;
    if (img) setCrop(makeDefaultCrop(img.width, img.height, m.aspect));
  }

  async function handleSave() {
    const img = imgRef.current;
    if (!img || !completedCrop || !completedCrop.width || !completedCrop.height) {
      setError("Draw a crop area first.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const scaleX = img.naturalWidth / img.width;
      const scaleY = img.naturalHeight / img.height;
      const blob = await cropToBlob(img, {
        x: completedCrop.x * scaleX,
        y: completedCrop.y * scaleY,
        width: completedCrop.width * scaleX,
        height: completedCrop.height * scaleY,
      });
      const fd = new FormData();
      fd.append("id", template.id);
      fd.append("image", blob, "crop.jpg");
      const res = await apiFetch("/api/template-image", { method: "POST", body: fd });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = null; }
      if (!res.ok) { setError((data && data.error) || "Crop save failed"); return; }
      onSaved(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Crop Template</h2>
          <button className="modal-close" onClick={onClose} title="Close (Esc)">×</button>
        </div>

        <div className="cropper-body">
          <div className="cropper-modes">
            <span className="cropper-modes-label">Ratio</span>
            {MODES.map(m => (
              <button
                key={m.key}
                className={`btn btn-tiny ${modeKey === m.key ? "btn-primary" : "btn-secondary"}`}
                onClick={() => selectMode(m)}
              >
                {m.label}
              </button>
            ))}
          </div>

          <div className="cropper-stage">
            {imgSrc ? (
              <ReactCrop
                crop={crop}
                onChange={c => setCrop(c)}
                onComplete={c => setCompletedCrop(c)}
                aspect={aspect}
              >
                <img
                  ref={imgRef}
                  src={imgSrc}
                  crossOrigin="anonymous"
                  onLoad={onImageLoad}
                  alt={template.label}
                  style={{ maxHeight: "58vh", maxWidth: "100%", display: "block" }}
                />
              </ReactCrop>
            ) : (
              <div className="cropper-loading">Loading image…</div>
            )}
          </div>

          {error && <div className="error-banner">{error}</div>}

          <div className="modal-actions">
            <button className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="btn btn-primary" onClick={handleSave} disabled={saving || !imgSrc}>
              {saving ? "Saving…" : "Save crop"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
