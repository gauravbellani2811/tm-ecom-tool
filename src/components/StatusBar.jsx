import React from "react";

export default function StatusBar({ generating, currentIndex, totalCount, currentFabricName, onCancel }) {
  if (!generating) return null;
  const pct = totalCount > 0 ? Math.round(((currentIndex) / totalCount) * 100) : 0;
  return (
    <div className="status-bar">
      <div className="status-bar-text">
        Generating fabric <strong>{currentIndex + 1}</strong> of <strong>{totalCount}</strong>
        {currentFabricName ? <> — <em>{currentFabricName}</em></> : null}
      </div>
      <div className="status-bar-progress">
        <div className="status-bar-progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <button className="btn btn-ghost btn-tiny" onClick={onCancel}>
        Cancel after current
      </button>
    </div>
  );
}
