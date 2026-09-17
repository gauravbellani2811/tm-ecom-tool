import React from "react";

export default function ResultsGrid({ results, generating, templateCount }) {
  if (generating) {
    return (
      <div className="results-loading">
        <div style={{ width: "100%" }}>
          <div className="pulse-bar" />
        </div>
        <span>Applying your fabric to {templateCount} template{templateCount !== 1 ? "s" : ""}…</span>
      </div>
    );
  }

  if (!results.length) {
    return (
      <div className="results-empty">
        <span className="icon">🪡</span>
        <span>Your styled results will appear here.</span>
        <span>Add template scenes and upload your fabric to get started.</span>
      </div>
    );
  }

  function downloadImage(dataUrl, label) {
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = `fabric-styled-${label.replace(/\s+/g, "-").toLowerCase()}.jpg`;
    a.click();
  }

  return (
    <div className="results-grid">
      {results.map(result => {
        if (result.error) {
          return (
            <div key={result.templateId} className="result-error-card">
              <span className="error-label">{result.templateLabel || result.templateId}</span>
              <span>{result.error}</span>
            </div>
          );
        }
        return (
          <div key={result.templateId} className="result-card">
            <img src={result.imageDataUrl} alt={result.templateLabel} />
            <div className="result-card-footer">
              <span className="result-card-label">{result.templateLabel}</span>
              <button
                className="download-btn"
                onClick={() => downloadImage(result.imageDataUrl, result.templateLabel)}
              >
                Download JPG
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
