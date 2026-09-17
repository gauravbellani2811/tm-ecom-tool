import React, { useEffect } from "react";

// candidates: array of 3 slots, each { status: "loading"|"done"|"error", imageDataUrl?, error? }
// currentUrl (optional): the existing image, shown as a non-clickable reference to compare against.
export default function RetryThreeModal({ templateLabel, candidates, onChoose, onClose, choosing, currentUrl }) {
  useEffect(() => {
    function onKey(e) { if (e.key === "Escape" && !choosing) onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, choosing]);

  const anyDone = candidates.some(c => c.status === "done");

  return (
    <div className="modal-overlay" onClick={choosing ? undefined : onClose}>
      <div className="modal-panel modal-panel-wide" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Pick the best of 3 — {templateLabel}</h2>
          <button className="modal-close" onClick={onClose} title="Close (Esc)" disabled={choosing}>×</button>
        </div>

        <div className="retry3-body">
          <div className="retry3-hint">
            {anyDone ? "Compare against the current image, then click the version you want to keep." : "Generating 3 variations…"}
          </div>

          <div className="retry3-grid">
            {currentUrl && (
              <div className="retry3-card">
                <div style={{ position: "relative" }}>
                  <img src={currentUrl} alt="Current" style={{ width: "100%", display: "block" }} />
                  <span style={{ position: "absolute", top: 8, left: 8, background: "rgba(42,33,24,0.7)", color: "#fff", fontSize: 11, padding: "2px 8px", borderRadius: 99 }}>
                    Current
                  </span>
                </div>
              </div>
            )}
            {candidates.map((c, i) => (
              <div key={i} className={`retry3-card${c.status === "done" ? " retry3-card-clickable" : ""}`}>
                {c.status === "loading" && (
                  <div className="retry3-state">
                    <span className="slot-spinner" />
                    <span className="retry3-state-text">Generating #{i + 1}…</span>
                  </div>
                )}
                {c.status === "error" && (
                  <div className="retry3-state retry3-state-error">
                    <span className="result-error-icon">!</span>
                    <span className="retry3-state-text">{c.error || "Failed"}</span>
                  </div>
                )}
                {c.status === "done" && (
                  <button
                    className="retry3-img-btn"
                    onClick={() => !choosing && onChoose(i)}
                    disabled={choosing}
                    title="Keep this one"
                  >
                    <img src={c.imageDataUrl} alt={`Variation ${i + 1}`} />
                    <span className="retry3-choose-overlay">{choosing ? "…" : "✓ Keep this"}</span>
                  </button>
                )}
              </div>
            ))}
          </div>

          <div className="modal-actions">
            <button className="btn btn-secondary" onClick={onClose} disabled={choosing}>Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
}
