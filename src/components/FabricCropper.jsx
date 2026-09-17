import React, { useEffect, useRef, useState } from "react";
import ReactCrop, { centerCrop, makeAspectCrop } from "react-image-crop";
import "react-image-crop/dist/ReactCrop.css";
import { cropRotatedToBlob, rotateImage90 } from "../utils/cropImage";

const MODES = [
  { key: "free", label: "Freehand", aspect: undefined },
  { key: "1:1", label: "1:1", aspect: 1 },
  { key: "16:9", label: "16:9", aspect: 16 / 9 },
];

function makeDefaultCrop(width, height, aspect) {
  if (aspect) {
    return centerCrop(makeAspectCrop({ unit: "%", width: 90 }, aspect, width, height), width, height);
  }
  return centerCrop({ unit: "%", width: 90, height: 90 }, width, height);
}

// Convert a percent crop to a pixel crop against the displayed image size.
function percentToPx(c, w, h) {
  return { unit: "px", x: (c.x / 100) * w, y: (c.y / 100) * h, width: (c.width / 100) * w, height: (c.height / 100) * h };
}

// Client-side cropper for a local fabric image. Returns a cropped JPEG blob.
export default function FabricCropper({ src, name, onClose, onCropped }) {
  const imgRef = useRef(null);
  const [crop, setCrop] = useState();
  const [completedCrop, setCompletedCrop] = useState(null);
  const [aspect, setAspect] = useState(undefined);
  const [modeKey, setModeKey] = useState("free");
  const [rotate, setRotate] = useState(0);
  const [workingSrc, setWorkingSrc] = useState(src);
  const [rotating, setRotating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    function onKey(e) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Revoke any rotated object URL we created (never the original src).
  useEffect(() => {
    return () => { if (workingSrc && workingSrc !== src) URL.revokeObjectURL(workingSrc); };
  }, [workingSrc, src]);

  // Bake a 90° turn into the image so crop + tilt stay aligned.
  async function rotate90(dir) {
    if (rotating) return;
    setRotating(true);
    setError(null);
    try {
      const next = await rotateImage90(workingSrc, dir);
      setRotate(0);            // tilt is now relative to the re-oriented image
      setWorkingSrc(next);     // reloads the img → onImageLoad resets the crop
    } catch (err) {
      setError(err.message);
    } finally {
      setRotating(false);
    }
  }

  function onImageLoad(e) {
    const { width, height } = e.currentTarget;
    const c = makeDefaultCrop(width, height, aspect);
    setCrop(c);
    setCompletedCrop(percentToPx(c, width, height));
  }

  function selectMode(m) {
    setModeKey(m.key);
    setAspect(m.aspect);
    const img = imgRef.current;
    if (img) {
      const c = makeDefaultCrop(img.width, img.height, m.aspect);
      setCrop(c);
      setCompletedCrop(percentToPx(c, img.width, img.height));
    }
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
      const blob = await cropRotatedToBlob(img, completedCrop, rotate);
      onCropped(blob);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Crop Fabric</h2>
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

          <div className="cropper-tilt">
            <span className="cropper-modes-label">Rotate</span>
            <button className="btn btn-tiny btn-secondary" onClick={() => rotate90("ccw")} disabled={rotating || saving} title="Rotate 90° anticlockwise">
              ⟲ 90°
            </button>
            <button className="btn btn-tiny btn-secondary" onClick={() => rotate90("cw")} disabled={rotating || saving} title="Rotate 90° clockwise">
              ⟳ 90°
            </button>
          </div>

          <div className="cropper-tilt">
            <span className="cropper-modes-label">Tilt</span>
            <input
              type="range"
              min={-45}
              max={45}
              step={1}
              value={rotate}
              onChange={e => setRotate(Number(e.target.value))}
              className="cropper-tilt-slider"
            />
            <span className="cropper-tilt-value">{rotate}°</span>
            <button className="btn btn-tiny btn-ghost" onClick={() => setRotate(0)} disabled={rotate === 0}>
              Reset
            </button>
          </div>

          <div className="cropper-stage">
            <ReactCrop
              crop={crop}
              onChange={c => setCrop(c)}
              onComplete={c => setCompletedCrop(c)}
              aspect={aspect}
            >
              <img
                ref={imgRef}
                src={workingSrc}
                onLoad={onImageLoad}
                alt={name}
                style={{ maxHeight: "44vh", maxWidth: "100%", display: "block", transform: `rotate(${rotate}deg)` }}
              />
            </ReactCrop>
          </div>

          {error && <div className="error-banner">{error}</div>}

          <div className="modal-actions">
            <button className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? "Saving…" : "Apply crop"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
