import React, { useEffect, useState } from "react";
import { apiFetch } from "../utils/api";

export default function TemplateEditor({ template, onClose, onSaved }) {
  const [label, setLabel] = useState(template.label || "");
  const [prompt, setPrompt] = useState(template.prompt || "");
  const [altPattern, setAltPattern] = useState(template.altPattern || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    function onKey(e) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/templates/${template.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label, prompt, altPattern }),
      });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = null; }
      if (!res.ok) {
        setError((data && data.error) || text || "Save failed");
        return;
      }
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
          <h2>Edit Template</h2>
          <button className="modal-close" onClick={onClose} title="Close (Esc)">×</button>
        </div>

        <div className="modal-body">
          <div className="modal-preview">
            <img src={template.url} alt={template.label} />
            <div className="modal-meta">
              <div className="modal-meta-row">
                <span className="modal-meta-key">ID</span>
                <span className="modal-meta-val">{template.id.slice(0, 8)}…</span>
              </div>
              {template.description && (
                <details className="modal-description">
                  <summary>Auto-generated scene description</summary>
                  <p>{template.description}</p>
                </details>
              )}
            </div>
          </div>

          <div className="modal-form">
            <label className="form-label">
              <span>Label</span>
              <input
                type="text"
                value={label}
                onChange={e => setLabel(e.target.value)}
                placeholder="e.g. Marble flatlay"
              />
            </label>

            <label className="form-label">
              <span>Prompt sent to Gemini</span>
              <textarea
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                rows={14}
                spellCheck={false}
                placeholder="Full prompt text…"
              />
              <span className="form-hint">
                This is the exact text Gemini receives along with the template + fabric images. Edit freely.
              </span>
            </label>

            <label className="form-label">
              <span>SEO alt-text pattern</span>
              <input
                type="text"
                value={altPattern}
                onChange={e => setAltPattern(e.target.value)}
                placeholder="{colour} {fabric} Fabric with {pattern}"
                spellCheck={false}
              />
              <span className="form-hint">
                Auto-generated for this scene. Placeholders: {"{colour}"}, {"{fabric}"} (adjective+material), {"{pattern}"} (tags). Filled per product for image alt text.
              </span>
            </label>

            {error && <div className="error-banner">{error}</div>}

            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
                {saving ? "Saving…" : "Save changes"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
