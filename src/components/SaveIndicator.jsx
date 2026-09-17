import React from "react";
import { useSaveQueue, retryFailedSaves } from "../utils/saveQueue";

// Small floating pill, shown only while History saves are in progress or failed.
// Sits above every modal so it's visible from History too.
export default function SaveIndicator() {
  const { pending, failed } = useSaveQueue();
  if (!pending && !failed) return null;

  if (failed && !pending) {
    return (
      <div className="save-indicator save-indicator-error" role="alert">
        <span>⚠ {failed} not saved</span>
        <button className="btn btn-tiny btn-primary" onClick={retryFailedSaves}>Retry</button>
      </div>
    );
  }

  return (
    <div className="save-indicator" role="status" aria-live="polite"
      title="Saving to History — please keep this tab open until it finishes">
      <span className="slot-spinner save-indicator-spinner" />
      <span>Saving {pending}… keep this tab open</span>
      {failed > 0 && <span className="save-indicator-failed">· {failed} not saved</span>}
    </div>
  );
}
