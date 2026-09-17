import React, { useEffect } from "react";

// state: { status: "loading"|"done"|"error", imageDataUrl?, error?, saving }
export default function CompareRetryModal({ templateLabel, originalUrl, state, onKeepNew, onKeepOriginal, onClose }) {
  useEffect(() => {
    function onKey(e) { if (e.key === "Escape" && !state.saving) onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, state.saving]);

  return (
    <div className="modal-overlay" onClick={state.saving ? undefined : onClose}>
      <div className="modal-panel modal-panel-wide" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Compare — {templateLabel}</h2>
          <button className="modal-close" onClick={onClose} title="Close (Esc)" disabled={state.saving}>×</button>
        </div>

        <div className="retry3-body">
          <div className="retry3-hint">
            {state.status === "loading" && "Generating new version…"}
            {state.status === "done" && "Compare, then choose which one to keep."}
            {state.status === "error" && (state.error || "Retry failed.")}
          </div>

          <div className="retry3-grid" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
            <div className="retry3-card">
              <div style={{ position: "relative" }}>
                <img src={originalUrl} alt="Current" style={{ maxHeight: "48vh", maxWidth: "100%", width: "auto", height: "auto", display: "block", margin: "0 auto" }} />
                <span style={{ position: "absolute", top: 8, left: 8, background: "rgba(42,33,24,0.7)", color: "#fff", fontSize: 11, padding: "2px 8px", borderRadius: 99 }}>
                  Current
                </span>
              </div>
            </div>
            <div className="retry3-card">
              {state.status === "loading" && (
                <div className="retry3-state">
                  <span className="slot-spinner" />
                  <span className="retry3-state-text">Generating…</span>
                </div>
              )}
              {state.status === "error" && (
                <div className="retry3-state retry3-state-error">
                  <span className="result-error-icon">!</span>
                  <span className="retry3-state-text">{state.error || "Failed"}</span>
                </div>
              )}
              {state.status === "done" && (
                <div style={{ position: "relative" }}>
                  <img src={state.imageDataUrl} alt="New" style={{ maxHeight: "48vh", maxWidth: "100%", width: "auto", height: "auto", display: "block", margin: "0 auto" }} />
                  <span style={{ position: "absolute", top: 8, left: 8, background: "rgba(196,85,42,0.9)", color: "#fff", fontSize: 11, padding: "2px 8px", borderRadius: 99 }}>
                    New
                  </span>
                </div>
              )}
            </div>
          </div>

          <div className="modal-actions">
            <button className="btn btn-secondary" onClick={onKeepOriginal} disabled={state.saving}>
              Keep current
            </button>
            <button className="btn btn-primary" onClick={onKeepNew} disabled={state.status !== "done" || state.saving}>
              {state.saving ? "Saving…" : "Use new image"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
