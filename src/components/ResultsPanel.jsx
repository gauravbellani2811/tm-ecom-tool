import React, { useEffect, useState } from "react";
import { downloadSingleResult, downloadAllResults, downloadFabricResults } from "../utils/zip";
import { downloadSessionCaptions, plainPreview } from "../utils/captionCsv";
import { retryFailedSaves } from "../utils/saveQueue";

const retryOverlayStyle = { position: "absolute", inset: 0, background: "rgba(42,33,24,0.6)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, borderRadius: 8 };
const chipSpinner = { width: 11, height: 11, borderWidth: 1.5 };

// entry: background-retry state for this card, or null. See App.jsx resultRetries.
function ResultCard({ fabric, result, entry, onEnlarge, onRegenerate, onStartRetry, onOpenCompare, onDismissRetry }) {
  const fabricName = fabric.name;
  if (result.pending) {
    return (
      <div className="result-card result-card-skeleton">
        <div className="skeleton-img" />
        <div className="result-card-footer">
          <span className="result-card-label">{result.templateLabel}</span>
          <span className="result-card-status">Generating…</span>
        </div>
      </div>
    );
  }
  if (result.error) {
    return (
      <div className="result-card result-card-error">
        <div className="result-error-body">
          <span className="result-error-icon">!</span>
          <span className="result-error-text">{result.error}</span>
        </div>
        <div className="result-card-footer">
          <span className="result-card-label">{result.templateLabel}</span>
          <button className="btn btn-tiny" onClick={onRegenerate} title="Retry this image">⟳</button>
        </div>
      </div>
    );
  }
  const canRetry = result.templateId && result.templateId !== "__flat__";
  const overlay = entry && (entry.status === "loading" || entry.status === "saving");
  return (
    <div className="result-card">
      <div style={{ position: "relative" }}>
        <button
          className="result-card-img-btn"
          onClick={() => onEnlarge({ src: result.imageDataUrl, label: result.templateLabel })}
          title="Click to enlarge"
        >
          <img src={result.imageDataUrl} alt={result.templateLabel} />
        </button>
        {overlay && (
          <div style={retryOverlayStyle}>
            <span className="slot-spinner" />
            <span style={{ fontSize: 11, color: "#fff", fontWeight: 600 }}>
              {entry.status === "saving" ? "Saving…" : (entry.kind === "three" ? "Generating 3…" : "Generating…")}
            </span>
          </div>
        )}
      </div>
      <div className="result-card-footer">
        <span className="result-card-label">{result.templateLabel}</span>
        <span className="result-card-actions">
          {canRetry && (
            entry && entry.status === "loading" ? (
              <span style={{ fontSize: 11, color: "#857a6c", display: "flex", alignItems: "center", gap: 4 }}>
                <span className="slot-spinner" style={chipSpinner} /> {entry.kind === "three" ? "Generating 3…" : "Generating…"}
              </span>
            ) : entry && entry.status === "saving" ? (
              <span style={{ fontSize: 11, color: "#857a6c" }}>Saving…</span>
            ) : entry && entry.status === "unsaved" ? (
              <>
                <span title={entry.error} style={{ fontSize: 11, fontWeight: 600, color: "#B33A1F" }}>⚠ Not saved</span>
                <button className="btn btn-tiny btn-primary" onClick={retryFailedSaves}
                  title="Try saving this replacement to History again (no regeneration)">Retry</button>
              </>
            ) : entry && entry.status === "ready" ? (
              <>
                <button className="btn btn-tiny btn-primary" onClick={onOpenCompare} title="Compare and choose whether to replace">
                  {entry.kind === "three" ? `✓ Choose (${entry.candidates.filter(c => c.status === "done").length})` : "✓ Compare"}
                </button>
                <button className="btn btn-tiny btn-ghost" onClick={onDismissRetry} title="Discard this retry">×</button>
              </>
            ) : (
              <>
                {entry && entry.status === "error" && <span title={entry.error} style={{ color: "#B33A1F" }}>⚠</span>}
                <button className="btn btn-tiny" onClick={() => onStartRetry("single")} title="Regenerate this image">⟳</button>
                <button className="btn btn-tiny" onClick={() => onStartRetry("three")} title="Generate 3 variations and pick one">⟳3</button>
                <button className="btn btn-tiny btn-pro" onClick={() => onStartRetry("pro")} title="Regenerate with the higher-quality Pro model (~2× cost, slower)">✦Pro</button>
              </>
            )
          )}
          <button
            className="btn btn-tiny"
            onClick={() => downloadSingleResult(fabricName, result.templateLabel, result.imageDataUrl).catch(e => alert(e.message))}
            title="Download JPG"
          >
            ⤓
          </button>
        </span>
      </div>
    </div>
  );
}

function Lightbox({ image, onClose }) {
  useEffect(() => {
    function onKey(e) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="lightbox-overlay" onClick={onClose}>
      <button className="lightbox-close" onClick={onClose} title="Close (Esc)">×</button>
      <figure className="lightbox-figure" onClick={e => e.stopPropagation()}>
        <img src={image.src} alt={image.label} className="lightbox-img" />
        {image.label && <figcaption className="lightbox-caption">{image.label}</figcaption>}
      </figure>
    </div>
  );
}

export default function ResultsPanel({ fabrics, templates, onRetryFabric, onRegenerateResult, onStartRetry, retries, onOpenCompare, onDismissRetry }) {
  const [lightbox, setLightbox] = useState(null);

  const fabricsWithResults = fabrics.filter(
    f => f.results && f.results.length > 0
  );

  const anyDone = fabrics.some(f => f.status === "done");
  const anyCaption = fabrics.some(f => f.caption && (f.caption.title || f.caption.description));

  if (!fabricsWithResults.length) {
    return (
      <section className="panel">
        <div className="panel-header">
          <h2>Results</h2>
        </div>
        <div className="results-empty">
          <span className="icon">🪡</span>
          <span>Your styled results will appear here.</span>
          <span className="hint">Add templates, queue some fabrics, and hit Generate.</span>
        </div>
      </section>
    );
  }

  return (
    <section className="panel">
      <div className="panel-header">
        <h2>Results</h2>
        <div className="panel-header-meta">
          {anyCaption && (
            <button
              className="btn btn-secondary"
              onClick={() => { try { downloadSessionCaptions(fabrics); } catch (e) { alert(e.message); } }}
              title="Download product titles & descriptions as a CSV for Shopify"
            >
              ⤓ Captions (CSV)
            </button>
          )}
          {anyDone && (
            <button
              className="btn btn-secondary"
              onClick={() => downloadAllResults(fabrics).catch(err => alert(err.message))}
            >
              ⤓ Download all
            </button>
          )}
        </div>
      </div>

      <div className="results-list">
        {fabricsWithResults.map(fabric => {
          const failedCount = fabric.results.filter(r => r.error).length;
          const succeededCount = fabric.results.filter(r => r.imageDataUrl).length;
          return (
            <div key={fabric.id} className="results-fabric-row">
              <div className="results-row-header">
                <div className="results-row-meta">
                  <span className="results-row-name">{fabric.name}</span>
                  <span className="results-row-status">
                    {fabric.status === "done" && `${succeededCount} of ${fabric.results.length} succeeded`}
                    {fabric.status === "generating" && "Generating…"}
                    {fabric.status === "error" && "Error during generation"}
                  </span>
                </div>
                {failedCount > 0 && fabric.status !== "generating" && onRetryFabric && (
                  <button
                    className="btn btn-tiny btn-secondary"
                    onClick={() => onRetryFabric(fabric)}
                    title="Re-run only the failed images"
                  >
                    ⟳ Retry failed ({failedCount})
                  </button>
                )}
                {succeededCount > 0 && (
                  <button
                    className="btn btn-tiny"
                    onClick={() => downloadFabricResults(fabric).catch(err => alert(err.message))}
                  >
                    ⤓ Download
                  </button>
                )}
              </div>
              {fabric.caption && (fabric.caption.title || fabric.caption.description) && (
                <div style={{ margin: "0 0 10px", padding: "8px 12px", background: "#faf7f2", border: "1px solid #eee3d3", borderRadius: 8, fontSize: 13, color: "#2a2118" }}>
                  {fabric.caption.title && <div style={{ fontWeight: 600 }}>{fabric.caption.title}</div>}
                  {fabric.caption.description && <div style={{ marginTop: 2, color: "#6b6152" }}>{plainPreview(fabric.caption.description)}</div>}
                  {fabric.caption.tags && fabric.caption.tags.length > 0 && (
                    <div style={{ marginTop: 4, fontSize: 11, color: "#a89e8d" }}>
                      Tags: {fabric.caption.tags.join(", ")}{fabric.caption.productType ? ` · ${fabric.caption.productType}` : ""}
                    </div>
                  )}
                  {fabric.caption.altTexts && fabric.caption.altTexts.length > 0 && (
                    <div style={{ marginTop: 4, fontSize: 11, color: "#857a6c" }}>
                      {fabric.caption.altTexts.map((a, i) => (
                        <div key={i}><strong>Alt {i + 1}</strong> ({a.label}): {a.alt}</div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <div className="results-strip">
                <div className="result-card result-card-source">
                  <button
                    className="result-card-img-btn"
                    onClick={() => setLightbox({ src: fabric.previewUrl, label: `${fabric.name} (uploaded fabric)` })}
                    title="Click to enlarge"
                  >
                    <img src={fabric.previewUrl} alt="" />
                  </button>
                  <div className="result-card-footer">
                    <span className="result-card-label">Uploaded fabric</span>
                  </div>
                </div>
                {fabric.results.map((r, i) => (
                  <ResultCard
                    key={r.templateId || i}
                    fabric={fabric}
                    result={r}
                    entry={r.templateId ? (retries || {})[`${fabric.id}:${r.templateId}`] : null}
                    onEnlarge={setLightbox}
                    onRegenerate={() => onRegenerateResult(fabric, r.templateId)}
                    onStartRetry={(kind) => onStartRetry(fabric, r.templateId, kind)}
                    onOpenCompare={() => onOpenCompare(`${fabric.id}:${r.templateId}`)}
                    onDismissRetry={() => onDismissRetry(`${fabric.id}:${r.templateId}`)}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {lightbox && <Lightbox image={lightbox} onClose={() => setLightbox(null)} />}
    </section>
  );
}
