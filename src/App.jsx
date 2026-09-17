import React, { useEffect, useRef, useState } from "react";
import TemplateManager from "./components/TemplateManager";
import TemplateEditor from "./components/TemplateEditor";
import TemplateLibrary from "./components/TemplateLibrary";
import FabricQueue from "./components/FabricQueue";
import ResultsPanel from "./components/ResultsPanel";
import StatusBar from "./components/StatusBar";
import HistoryModal from "./components/HistoryModal";
import TemplateCropper from "./components/TemplateCropper";
import RetryThreeModal from "./components/RetryThreeModal";
import CompareRetryModal from "./components/CompareRetryModal";
import Login from "./components/Login";
import AdminDashboard from "./components/AdminDashboard";
import Brand from "./components/Brand";
import WaitlistModal from "./components/WaitlistModal";
import ShopifyExportModal from "./components/ShopifyExportModal";
import { PRO_CONFIRM } from "./components/HistoryModal";
import { makeFabric } from "./utils/fabrics";
import { compressImage } from "./utils/compressImage";
import { cropToSquare } from "./utils/cropImage";
import { apiFetch, getAuth, setAuth } from "./utils/api";
import { preloadImage } from "./utils/preload";

const FLAT_ID = "__flat__";

function runUuid() {
  return "r_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export default function App() {
  const [auth, setAuthState] = useState(() => getAuth());
  const [adminOpen, setAdminOpen] = useState(false);
  const [templates, setTemplates] = useState([]);
  const [fabrics, setFabrics] = useState([]);
  const [generating, setGenerating] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [currentFabricName, setCurrentFabricName] = useState("");
  const [editingTemplate, setEditingTemplate] = useState(null);
  const [croppingTemplate, setCroppingTemplate] = useState(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [waitlistOpen, setWaitlistOpen] = useState(false);
  const [shopifyOpen, setShopifyOpen] = useState(false);
  // Background retries on result cards, keyed `${fabricId}:${templateId}`. Each:
  // { kind:"single"|"pro"|"three", status:"loading"|"ready"|"error"|"saving", ...compare data }.
  const [resultRetries, setResultRetries] = useState({});
  const [resultOpenKey, setResultOpenKey] = useState(null); // which ready retry is expanded into a modal
  const [error, setError] = useState(null);
  const cancelRef = useRef(false);

  const activeTemplates = templates.filter(t => t.active);
  const isAdmin = auth?.role === "admin";

  function handleLogin(user, role) {
    setAuth(user, role);
    setAuthState({ user, role });
    loadTemplates();
  }
  function handleLogout() {
    setAuth(null);
    setAuthState(null);
    setAdminOpen(false);
  }

  async function loadTemplates() {
    try {
      const res = await apiFetch("/api/templates");
      const data = await res.json();
      setTemplates(Array.isArray(data) ? data : []);
    } catch {
      // backend not ready yet
    }
  }

  useEffect(() => { loadTemplates(); }, []);

  // Cleanup objectURLs on unmount
  useEffect(() => () => {
    fabrics.forEach(f => f.previewUrl && URL.revokeObjectURL(f.previewUrl));
  }, []); // intentionally empty: capture once on unmount

  function addFabrics(items) {
    setFabrics(prev => [...prev, ...items]);
  }

  // Pull one waitlist item into the fabric generation queue.
  async function pullFromWaitlist(item) {
    const res = await fetch(item.url + (item.url.includes("?") ? "&" : "?") + "cb=" + Date.now());
    if (!res.ok) throw new Error("Could not fetch photo");
    const blob = await res.blob();
    const file = new File([blob], (item.name || "photo") + ".jpg", { type: "image/jpeg" });
    const fabric = await makeFabric(file, item.name);
    // Carry any caption metadata entered on the waitlist into the queue.
    fabric.colour = item.colour || "";
    fabric.adjective = item.adjective || "";
    fabric.fabricType = item.fabricType || "";
    const tags = (item.tags || []).filter(Boolean);
    fabric.tags = [tags[0] || "", tags[1] || "", tags[2] || ""];
    // Carry the close-up detail photo (if the floor manager attached one).
    if (item.detailUrl) {
      try {
        const dRes = await fetch(item.detailUrl + (item.detailUrl.includes("?") ? "&" : "?") + "cb=" + Date.now());
        if (dRes.ok) {
          const dBlob = await dRes.blob();
          fabric.detailFile = new File([dBlob], "detail.jpg", { type: "image/jpeg" });
          fabric.detailPreviewUrl = URL.createObjectURL(dBlob);
        }
      } catch { /* detail is best-effort; proceed without it */ }
    }
    addFabrics([fabric]);
  }

  function renameFabric(id, name) {
    setFabrics(prev => prev.map(f => f.id === id ? { ...f, name } : f));
  }

  function updateFabricMeta(id, patch) {
    setFabrics(prev => prev.map(f => f.id === id ? { ...f, ...patch } : f));
  }

  function removeFabric(id) {
    setFabrics(prev => {
      const f = prev.find(x => x.id === id);
      if (f && f.previewUrl) URL.revokeObjectURL(f.previewUrl);
      if (f && f.detailPreviewUrl) URL.revokeObjectURL(f.detailPreviewUrl);
      return prev.filter(x => x.id !== id);
    });
  }

  function clearDoneFabrics() {
    setFabrics(prev => {
      prev.filter(f => f.status === "done").forEach(f => {
        if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
        if (f.detailPreviewUrl) URL.revokeObjectURL(f.detailPreviewUrl);
      });
      return prev.filter(f => f.status !== "done");
    });
  }

  function updateFabric(id, updater) {
    setFabrics(prev => prev.map(f => f.id === id ? updater(f) : f));
  }

  function replaceFabricFile(id, newFile) {
    setFabrics(prev => prev.map(f => {
      if (f.id !== id) return f;
      if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
      // Reset status so a re-cropped fabric regenerates cleanly
      return { ...f, file: newFile, previewUrl: URL.createObjectURL(newFile), status: "pending", results: [], sourceUrls: null };
    }));
  }

  // Attach / replace a close-up detail photo (compressed) on a queued fabric.
  async function setFabricDetail(id, rawFile) {
    let compressed;
    try { compressed = await compressImage(rawFile, 1500, 0.85); }
    catch { compressed = rawFile; }
    setFabrics(prev => prev.map(f => {
      if (f.id !== id) return f;
      if (f.detailPreviewUrl) URL.revokeObjectURL(f.detailPreviewUrl);
      return { ...f, detailFile: compressed, detailPreviewUrl: URL.createObjectURL(compressed), sourceUrls: null };
    }));
  }
  function clearFabricDetail(id) {
    setFabrics(prev => prev.map(f => {
      if (f.id !== id) return f;
      if (f.detailPreviewUrl) URL.revokeObjectURL(f.detailPreviewUrl);
      return { ...f, detailFile: null, detailPreviewUrl: null, sourceUrls: null };
    }));
  }

  async function generateForFabric(fabric) {
    const runId = fabric.runId || runUuid();

    // Build the flat swatch locally (instant, no AI) — center square crop.
    let flatFile = null;
    let flatResult = null;
    try {
      flatFile = await cropToSquare(fabric.file, 1400, 0.9);
      flatResult = {
        templateId: FLAT_ID,
        templateLabel: "Flat fabric",
        imageDataUrl: URL.createObjectURL(flatFile),
      };
    } catch {
      // if cropping fails, just proceed without the flat
    }

    // Mark generating + show placeholder skeletons immediately (flat shown ready)
    const pendingResults = activeTemplates.map(t => ({
      templateId: t.id,
      templateLabel: t.label,
      pending: true,
    }));
    updateFabric(fabric.id, f => ({
      ...f,
      runId,
      status: "generating",
      results: flatResult ? [flatResult, ...pendingResults] : pendingResults,
      startedAt: Date.now(),
    }));

    try {
      const formData = new FormData();
      formData.append("fabric", fabric.file);
      if (fabric.detailFile) formData.append("detailImage", fabric.detailFile);
      formData.append("runId", runId);
      formData.append("fabricName", fabric.name);
      if (flatFile) formData.append("flatImage", flatFile);
      formData.append("action", "generate");
      // Optional caption facts — when any are present the backend writes a title/description.
      if (fabric.colour) formData.append("colour", fabric.colour);
      if (fabric.adjective) formData.append("adjective", fabric.adjective);
      if (fabric.fabricType) formData.append("fabricType", fabric.fabricType);
      (fabric.tags || []).filter(Boolean).forEach(t => formData.append("tags[]", t));
      activeTemplates.forEach(t => formData.append("templateIds[]", t.id));

      const res = await apiFetch("/api/generate", { method: "POST", body: formData });
      if (!res.ok) {
        const text = await res.text();
        let msg = text;
        try { msg = JSON.parse(text).error || text; } catch {}
        throw new Error(msg.slice(0, 300) || `HTTP ${res.status}`);
      }
      const data = await res.json();
      const styled = data.results || [];
      const results = flatResult ? [flatResult, ...styled] : styled;
      const sources = data.sources || {};

      // Status ignores the flat (its success shouldn't mask all-template failures)
      const allErrored = styled.length > 0 && styled.every(r => r.error);
      updateFabric(fabric.id, f => ({
        ...f,
        status: allErrored ? "error" : "done",
        results,
        ...(data.caption ? { caption: data.caption } : {}),
        ...(sources.fabricUrl ? { sourceUrls: sources } : {}),
        finishedAt: Date.now(),
      }));
    } catch (err) {
      updateFabric(fabric.id, f => ({
        ...f,
        status: "error",
        results: [
          ...(flatResult ? [flatResult] : []),
          ...activeTemplates.map(t => ({
            templateId: t.id,
            templateLabel: t.label,
            error: err.message,
          })),
        ],
        finishedAt: Date.now(),
      }));
    }
  }

  async function retryFailedForFabric(fabric) {
    const failed = (fabric.results || []).filter(r => r.error);
    if (!failed.length) return;
    const failedIds = failed.map(r => r.templateId);

    // Mark only the failed cards as pending; keep succeeded results intact
    updateFabric(fabric.id, f => ({
      ...f,
      status: "generating",
      results: f.results.map(r =>
        r.error
          ? { templateId: r.templateId, templateLabel: r.templateLabel, pending: true }
          : r
      ),
    }));

    const runId = fabric.runId || runUuid();
    try {
      const formData = new FormData();
      formData.append("fabric", fabric.file);
      if (fabric.detailFile) formData.append("detailImage", fabric.detailFile);
      formData.append("runId", runId);
      formData.append("fabricName", fabric.name);
      formData.append("action", "retry");
      failedIds.forEach(id => formData.append("templateIds[]", id));

      const res = await apiFetch("/api/generate", { method: "POST", body: formData });
      if (!res.ok) {
        const text = await res.text();
        let msg = text;
        try { msg = JSON.parse(text).error || text; } catch {}
        throw new Error(msg.slice(0, 300) || `HTTP ${res.status}`);
      }
      const data = await res.json();
      const fresh = data.results || [];

      updateFabric(fabric.id, f => {
        const merged = f.results.map(r => {
          const repl = fresh.find(x => x.templateId === r.templateId);
          return repl || r;
        });
        // Ignore the flat swatch when judging success/failure
        const styled = merged.filter(r => r.templateId !== FLAT_ID);
        const anySuccess = styled.some(r => r.imageDataUrl);
        return {
          ...f,
          results: merged,
          status: anySuccess ? "done" : "error",
          finishedAt: Date.now(),
        };
      });
    } catch (err) {
      updateFabric(fabric.id, f => ({
        ...f,
        status: f.results.some(r => r.imageDataUrl) ? "done" : "error",
        results: f.results.map(r =>
          r.pending
            ? { templateId: r.templateId, templateLabel: r.templateLabel, error: err.message }
            : r
        ),
        finishedAt: Date.now(),
      }));
    }
  }

  // Direct retry-and-replace, used only for ERRORED cards (no image to compare against).
  // Successful cards go through startResultRetry → background compare.
  async function regenerateResult(fabric, templateId, opts = {}) {
    if (!fabric.file) return;
    const runId = fabric.runId || runUuid();
    if (!fabric.runId) updateFabric(fabric.id, f => ({ ...f, runId }));
    const tplLabel = (fabric.results.find(r => r.templateId === templateId) || {}).templateLabel;

    // Flip only this card to pending; leave siblings untouched
    updateFabric(fabric.id, f => ({
      ...f,
      results: f.results.map(r =>
        r.templateId === templateId
          ? { templateId, templateLabel: tplLabel, pending: true }
          : r
      ),
    }));

    try {
      const formData = new FormData();
      formData.append("fabric", fabric.file);
      if (fabric.detailFile) formData.append("detailImage", fabric.detailFile);
      formData.append("runId", runId);
      formData.append("fabricName", fabric.name);
      formData.append("templateIds[]", templateId);
      formData.append("action", opts.model === "pro" ? "pro" : "regenerate");
      if (opts.model) formData.append("model", opts.model);

      const res = await apiFetch("/api/generate", { method: "POST", body: formData });
      if (!res.ok) {
        const text = await res.text();
        let msg = text;
        try { msg = JSON.parse(text).error || text; } catch {}
        throw new Error(msg.slice(0, 300) || `HTTP ${res.status}`);
      }
      const data = await res.json();
      const fresh = (data.results || [])[0];

      updateFabric(fabric.id, f => ({
        ...f,
        results: f.results.map(r => (r.templateId === templateId ? (fresh || r) : r)),
      }));
    } catch (err) {
      updateFabric(fabric.id, f => ({
        ...f,
        results: f.results.map(r =>
          r.templateId === templateId
            ? { templateId, templateLabel: tplLabel, error: err.message }
            : r
        ),
      }));
    }
  }

  // Generate one candidate for a single template (not saved to history).
  // opts.model → "pro"; opts.action tags the audit event (defaults to "retry3").
  async function generateCandidate(fabric, templateId, runId, opts = {}) {
    const { model, action = "retry3" } = opts;
    const formData = new FormData();
    // Reuse the photos stored by the first generation (no re-upload) when we have them.
    const src = fabric.sourceUrls || {};
    if (src.fabricUrl) formData.append("fabricUrl", src.fabricUrl);
    else formData.append("fabric", fabric.file);
    if (fabric.detailFile) {
      if (src.fabricUrl && src.detailUrl) formData.append("detailUrl", src.detailUrl);
      else formData.append("detailImage", fabric.detailFile);
    }
    formData.append("runId", runId);
    formData.append("fabricName", fabric.name);
    formData.append("templateIds[]", templateId);
    formData.append("skipHistory", "1");
    formData.append("action", action);
    if (model) formData.append("model", model);

    const res = await apiFetch("/api/generate", { method: "POST", body: formData });
    if (!res.ok) {
      const text = await res.text();
      let msg = text;
      try { msg = JSON.parse(text).error || text; } catch {}
      throw new Error(msg.slice(0, 200) || `HTTP ${res.status}`);
    }
    const data = await res.json();
    const r = (data.results || [])[0];
    if (!r || r.error || !r.imageDataUrl) throw new Error((r && r.error) || "No image returned");
    await preloadImage(r.imageDataUrl); // only report "ready" once it can actually be shown
    return r.imageDataUrl;
  }

  // --- Background result retries: no blocking modal; "Compare" button when ready. ---
  const setResultEntry = (key, patch) => setResultRetries(prev => {
    if (patch === null) { const next = { ...prev }; delete next[key]; return next; }
    const cur = prev[key];
    const val = typeof patch === "function" ? patch(cur) : { ...cur, ...patch };
    return val ? { ...prev, [key]: val } : prev;
  });
  const withCand = (candidates, i, val) => { const c = (candidates || []).slice(); c[i] = val; return c; };

  // Start a background retry on a successful card. kind: "single" | "pro" | "three".
  async function startResultRetry(fabric, templateId, kind) {
    if (!fabric.file) return;
    if (kind === "pro" && !window.confirm(PRO_CONFIRM)) return;
    const key = `${fabric.id}:${templateId}`;
    const cur = (fabric.results || []).find(r => r.templateId === templateId) || {};
    const runId = fabric.runId || runUuid();
    if (!fabric.runId) updateFabric(fabric.id, f => ({ ...f, runId }));
    setResultRetries(prev => ({
      ...prev,
      [key]: {
        kind, fabricId: fabric.id, templateId, templateLabel: cur.templateLabel || "",
        runId, fabricName: fabric.name, currentUrl: cur.imageDataUrl, status: "loading",
        candidates: kind === "three" ? [{ status: "loading" }, { status: "loading" }, { status: "loading" }] : undefined,
      },
    }));

    if (kind === "three") {
      const settle = (i, val) => setResultEntry(key, e => {
        if (!e) return e;
        const candidates = withCand(e.candidates, i, val);
        const anyDone = candidates.some(c => c.status === "done");
        const allSettled = candidates.every(c => c.status !== "loading");
        return { ...e, candidates, status: anyDone ? "ready" : (allSettled ? "error" : "loading") };
      });
      for (let i = 0; i < 3; i++) {
        generateCandidate(fabric, templateId, runId)
          .then(u => settle(i, { status: "done", imageDataUrl: u }))
          .catch(err => settle(i, { status: "error", error: err.message }));
      }
      return;
    }

    try {
      const action = kind === "pro" ? "pro" : "regenerate";
      const imageDataUrl = await generateCandidate(fabric, templateId, runId, { model: kind === "pro" ? "pro" : undefined, action });
      setResultEntry(key, e => e && { ...e, status: "ready", imageDataUrl });
    } catch (err) {
      setResultEntry(key, e => e && { ...e, status: "error", error: err.message });
    }
  }

  function dismissResultRetry(key) { setResultOpenKey(null); setResultEntry(key, null); }

  // Apply the chosen image to the card + persist to history in the background.
  async function applyResultRetry(key, imageDataUrl) {
    const e = resultRetries[key];
    if (!e) return;
    setResultOpenKey(null);
    setResultEntry(key, { status: "saving" });
    const swap = url => updateFabric(e.fabricId, f => ({
      ...f,
      results: f.results.map(r => r.templateId === e.templateId
        ? { templateId: e.templateId, templateLabel: e.templateLabel, imageDataUrl: url } : r),
    }));
    swap(imageDataUrl); // optimistic
    try {
      const fd = new FormData();
      fd.append("runId", e.runId); fd.append("fabricName", e.fabricName);
      fd.append("templateId", e.templateId); fd.append("templateLabel", e.templateLabel);
      if (/^https?:/.test(imageDataUrl)) fd.append("sourceUrl", imageDataUrl); // stored candidate → server-side copy
      else fd.append("image", await (await fetch(imageDataUrl)).blob(), "retry.jpg");
      const res = await apiFetch("/api/history-add", { method: "POST", body: fd });
      if (!res.ok) throw new Error("Save failed");
      setResultEntry(key, null);
    } catch (err) {
      if (e.currentUrl) swap(e.currentUrl); // revert
      setResultEntry(key, { status: "error", error: err.message });
      setError("Couldn't save the new image: " + err.message);
    }
  }

  async function runBatch(targetFabrics) {
    if (!targetFabrics.length || !activeTemplates.length) return;
    cancelRef.current = false;
    setGenerating(true);
    setTotalCount(targetFabrics.length);
    setError(null);

    for (let i = 0; i < targetFabrics.length; i++) {
      if (cancelRef.current) break;
      const fabric = targetFabrics[i];
      setCurrentIndex(i);
      setCurrentFabricName(fabric.name);
      // Re-read latest fabric state in case user renamed
      const live = await new Promise(resolve => {
        setFabrics(prev => {
          resolve(prev.find(f => f.id === fabric.id) || fabric);
          return prev;
        });
      });
      await generateForFabric(live);
    }

    setGenerating(false);
    setCurrentIndex(0);
    setTotalCount(0);
    setCurrentFabricName("");
  }

  function handleGenerateAll() {
    const pending = fabrics.filter(f => f.status === "pending");
    runBatch(pending);
  }

  async function handleRetryFailed() {
    const targets = fabrics.filter(f => (f.results || []).some(r => r.error));
    if (!targets.length) return;
    cancelRef.current = false;
    setGenerating(true);
    setTotalCount(targets.length);
    setError(null);

    for (let i = 0; i < targets.length; i++) {
      if (cancelRef.current) break;
      setCurrentIndex(i);
      setCurrentFabricName(targets[i].name);
      const live = await new Promise(resolve => {
        setFabrics(prev => {
          resolve(prev.find(f => f.id === targets[i].id) || targets[i]);
          return prev;
        });
      });
      await retryFailedForFabric(live);
    }

    setGenerating(false);
    setCurrentIndex(0);
    setTotalCount(0);
    setCurrentFabricName("");
  }

  function cancelBatch() {
    cancelRef.current = true;
  }

  function handleTemplateSaved(updatedManifest) {
    setTemplates(Array.isArray(updatedManifest) ? updatedManifest : []);
    setEditingTemplate(null);
  }

  function handleLibraryRefresh(updatedManifest) {
    if (Array.isArray(updatedManifest)) setTemplates(updatedManifest);
    else loadTemplates();
  }

  async function reorderActiveTemplates(orderedActiveIds) {
    // Optimistic: place reordered active templates into their existing slots.
    setTemplates(prev => {
      const activePositions = [];
      prev.forEach((t, i) => { if (t.active) activePositions.push(i); });
      const byId = new Map(prev.map(t => [t.id, t]));
      const ordered = orderedActiveIds.map(id => byId.get(id)).filter(t => t && t.active);
      const next = prev.slice();
      activePositions.forEach((pos, i) => { if (ordered[i]) next[pos] = ordered[i]; });
      return next;
    });
    try {
      const res = await apiFetch("/api/templates", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order: orderedActiveIds }),
      });
      if (res.ok) { const data = await res.json(); if (Array.isArray(data)) setTemplates(data); }
    } catch { /* optimistic order stays */ }
  }

  if (!auth) return <Login onLogin={handleLogin} />;

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header-inner">
          <Brand variant="header" />
          <h1>Ecom Tool</h1>
          <div className="app-header-right">
            {isAdmin && (
              <button className="btn btn-secondary btn-tiny" onClick={() => setAdminOpen(true)}>
                Admin
              </button>
            )}
            <button className="btn btn-secondary btn-tiny" onClick={() => window.open("/daily-checkout.html", "_blank", "noopener")}>
              Daily Checkout Sheet
            </button>
            <button className="btn btn-secondary btn-tiny" onClick={() => setWaitlistOpen(true)}>
              Waitlist
            </button>
            <button className="btn btn-secondary btn-tiny" onClick={() => setShopifyOpen(true)}
              title="Build a Shopify product-import CSV — pick the products next">
              Shopify CSV
            </button>
            <button className="btn btn-secondary btn-tiny" onClick={() => setHistoryOpen(true)}>
              History
            </button>
            <span className="app-user">{auth.user}</span>
            <button className="btn btn-ghost btn-tiny" onClick={handleLogout} title="Log out">Logout</button>
          </div>
        </div>
      </header>

      <StatusBar
        generating={generating}
        currentIndex={currentIndex}
        totalCount={totalCount}
        currentFabricName={currentFabricName}
        onCancel={cancelBatch}
      />

      {error && <div className="error-banner global-error">{error}</div>}

      <main className="app-stack">
        <TemplateManager
          templates={templates}
          onRefresh={loadTemplates}
          onEdit={tpl => setEditingTemplate(tpl)}
          onOpenLibrary={() => setLibraryOpen(true)}
          onReorder={reorderActiveTemplates}
        />

        <FabricQueue
          fabrics={fabrics}
          templateCount={activeTemplates.length}
          generating={generating}
          onAdd={addFabrics}
          onRename={renameFabric}
          onRemove={removeFabric}
          onReplaceFile={replaceFabricFile}
          onUpdateMeta={updateFabricMeta}
          onSetDetail={setFabricDetail}
          onClearDetail={clearFabricDetail}
          onGenerateAll={handleGenerateAll}
          onRetryFailed={handleRetryFailed}
          onClearDone={clearDoneFabrics}
        />

        <ResultsPanel
          fabrics={fabrics}
          templates={activeTemplates}
          onRetryFabric={retryFailedForFabric}
          onRegenerateResult={regenerateResult}
          onStartRetry={startResultRetry}
          retries={resultRetries}
          onOpenCompare={setResultOpenKey}
          onDismissRetry={dismissResultRetry}
        />
      </main>

      {libraryOpen && (
        <TemplateLibrary
          templates={templates}
          onClose={() => setLibraryOpen(false)}
          onRefresh={handleLibraryRefresh}
          onEdit={tpl => { setLibraryOpen(false); setEditingTemplate(tpl); }}
          onCrop={tpl => { setLibraryOpen(false); setCroppingTemplate(tpl); }}
        />
      )}

      {croppingTemplate && (
        <TemplateCropper
          template={croppingTemplate}
          onClose={() => setCroppingTemplate(null)}
          onSaved={updatedManifest => {
            if (Array.isArray(updatedManifest)) setTemplates(updatedManifest);
            else loadTemplates();
            setCroppingTemplate(null);
          }}
        />
      )}

      {editingTemplate && (
        <TemplateEditor
          template={editingTemplate}
          onClose={() => setEditingTemplate(null)}
          onSaved={handleTemplateSaved}
        />
      )}

      {waitlistOpen && <WaitlistModal onPull={pullFromWaitlist} onClose={() => setWaitlistOpen(false)} />}

      {shopifyOpen && <ShopifyExportModal onClose={() => setShopifyOpen(false)} />}

      {historyOpen && <HistoryModal isAdmin={isAdmin} templates={templates} onClose={() => setHistoryOpen(false)} />}

      {adminOpen && <AdminDashboard templates={templates} onClose={() => setAdminOpen(false)} />}

      {resultOpenKey && resultRetries[resultOpenKey] && resultRetries[resultOpenKey].kind === "three" && (
        <RetryThreeModal
          templateLabel={resultRetries[resultOpenKey].templateLabel}
          candidates={resultRetries[resultOpenKey].candidates}
          currentUrl={resultRetries[resultOpenKey].currentUrl}
          choosing={resultRetries[resultOpenKey].status === "saving"}
          onChoose={(i) => { const c = resultRetries[resultOpenKey].candidates[i]; if (c && c.status === "done") applyResultRetry(resultOpenKey, c.imageDataUrl); }}
          onClose={() => setResultOpenKey(null)}
        />
      )}

      {resultOpenKey && resultRetries[resultOpenKey] && resultRetries[resultOpenKey].kind !== "three" && (
        <CompareRetryModal
          templateLabel={resultRetries[resultOpenKey].templateLabel}
          originalUrl={resultRetries[resultOpenKey].currentUrl}
          state={{ status: "done", imageDataUrl: resultRetries[resultOpenKey].imageDataUrl, saving: resultRetries[resultOpenKey].status === "saving" }}
          onKeepNew={() => applyResultRetry(resultOpenKey, resultRetries[resultOpenKey].imageDataUrl)}
          onKeepOriginal={() => dismissResultRetry(resultOpenKey)}
          onClose={() => setResultOpenKey(null)}
        />
      )}
    </div>
  );
}
