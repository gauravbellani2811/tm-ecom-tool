import React, { useEffect, useState } from "react";
import { apiFetch, setAdminPin } from "../utils/api";
import HistoryModal from "./HistoryModal";

const TH = { textAlign: "left", padding: "6px 10px", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em", color: "#857a6c", borderBottom: "1px solid #e4ddd2", whiteSpace: "nowrap" };
const TD = { padding: "6px 10px", fontSize: 13, color: "#2a2118", borderBottom: "1px solid #f0ebe3", whiteSpace: "nowrap" };
const TABLE = { width: "100%", borderCollapse: "collapse" };

function formatWhen(iso) {
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export default function AdminDashboard({ onClose, templates }) {
  const [showAll, setShowAll] = useState(false); // combined every-user History
  const [pin, setPin] = useState("");
  const [authed, setAuthed] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState("templates");
  const [lightbox, setLightbox] = useState(null);
  const [capSettings, setCapSettings] = useState({ captionInstructions: "", careInstructions: "", measurement: "", liningLabel: "", liningUrl: "", signoff: "" });
  const [savingCap, setSavingCap] = useState(false);
  const [capMsg, setCapMsg] = useState(null);
  const setCap = (k, v) => setCapSettings(p => ({ ...p, [k]: v }));
  const [restoreUser, setRestoreUser] = useState("");
  const [restoreDate, setRestoreDate] = useState("");
  const [restoring, setRestoring] = useState(false);
  const [restoreMsg, setRestoreMsg] = useState(null);

  async function restoreHistory() {
    const owner = restoreUser.trim();
    if (!owner) return;
    const date = restoreDate.trim();
    setRestoring(true);
    setRestoreMsg(null);
    try {
      const res = await apiFetch("/api/history", {
        method: "PATCH", admin: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(date ? { restoreOwner: owner, restoreDate: date } : { restoreOwner: owner }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error((d && d.error) || "Restore failed");
      const restoredCount = Array.isArray(d) ? d.filter(r => (r.user || "").toLowerCase() === owner.toLowerCase()).length : 0;
      setRestoreMsg(`Restored ${restoredCount} run(s) for "${owner}".`);
    } catch (e) {
      setRestoreMsg(e.message);
    } finally {
      setRestoring(false);
    }
  }

  async function saveCaptions() {
    setSavingCap(true);
    setCapMsg(null);
    try {
      const res = await apiFetch("/api/admin", {
        method: "POST", admin: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(capSettings),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Save failed");
      if (d.captionSettings) setCapSettings(d.captionSettings);
      setCapMsg("Saved.");
    } catch (e) {
      setCapMsg(e.message);
    } finally {
      setSavingCap(false);
    }
  }

  useEffect(() => {
    function onKey(e) { if (e.key === "Escape" && !lightbox && !showAll) onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, lightbox, showAll]);

  async function unlock(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setAdminPin(pin);
    try {
      const res = await apiFetch("/api/admin", { admin: true });
      const d = await res.json();
      if (!res.ok) { setError(d.error || "Access denied"); return; }
      setData(d);
      if (d.captionSettings) setCapSettings(d.captionSettings);
      setAuthed(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel modal-panel-wide" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Admin Dashboard</h2>
          <button className="modal-close" onClick={onClose} title="Close (Esc)">×</button>
        </div>

        {!authed ? (
          <form onSubmit={unlock} style={{ padding: 28, display: "flex", flexDirection: "column", gap: 12, maxWidth: 360 }}>
            <span style={{ fontSize: 13, color: "#857a6c" }}>Enter the admin PIN to view logs.</span>
            <input
              type="password"
              className="login-input"
              value={pin}
              onChange={e => setPin(e.target.value)}
              placeholder="admin PIN"
              autoFocus
            />
            {error && <div className="login-error">{error}</div>}
            <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? "Checking…" : "Unlock"}</button>
          </form>
        ) : (
          <>
            <div style={{ display: "flex", gap: 8, padding: "12px 20px", borderBottom: "1px solid #e4ddd2", background: "#f3efe9" }}>
              {[["templates", "Template health"], ["cost", "Cost & usage"], ["activity", "Staff activity"], ["captions", "Captions"]].map(([k, label]) => (
                <button key={k} className={`btn btn-tiny ${tab === k ? "btn-primary" : "btn-secondary"}`} onClick={() => setTab(k)}>{label}</button>
              ))}
              <button className="btn btn-tiny btn-secondary" style={{ marginLeft: "auto" }} onClick={() => setShowAll(true)}
                title="Every user's generated products — search, download, retry and delete">
                All users' history
              </button>
            </div>

            <div style={{ overflowY: "auto", flex: "1 1 auto", minHeight: 0, padding: 20 }}>
              {tab === "templates" && (
                <table style={TABLE}>
                  <thead><tr>
                    <th style={TH}>Template</th><th style={TH}>Uses</th><th style={TH}>Retries</th><th style={TH}>Errors</th>
                  </tr></thead>
                  <tbody>
                    {data.templateHealth.map(t => (
                      <tr key={t.templateId}>
                        <td style={TD}>{t.label || t.templateId.slice(0, 8)}{t.total === 0 && <span style={{ color: "#b5862b", marginLeft: 6 }}>· unused</span>}</td>
                        <td style={TD}>{t.total}</td>
                        <td style={{ ...TD, fontWeight: t.retries > 0 ? 700 : 400, color: t.retries >= 5 ? "#B33A1F" : "#2a2118" }}>{t.retries}</td>
                        <td style={TD}>{t.errors} {t.total > 0 && <span style={{ color: "#857a6c" }}>({t.errorRate}%)</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {tab === "cost" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                  <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
                    <Stat label="Est. total spend" value={`₹${data.cost.estTotal}`} big />
                    <Stat label="Total images" value={data.cost.totalImages} />
                    <Stat label="Flash" value={data.cost.flash} />
                    <Stat label="Pro" value={data.cost.pro} />
                    <Stat label="Captions" value={data.cost.caption ?? 0} />
                  </div>
                  <div>
                    <h3 style={{ fontSize: 13, margin: "0 0 8px", color: "#857a6c" }}>By user</h3>
                    <table style={TABLE}>
                      <thead><tr><th style={TH}>User</th><th style={TH}>Flash</th><th style={TH}>Pro</th><th style={TH}>Captions</th><th style={TH}>Est. cost</th></tr></thead>
                      <tbody>{data.cost.byUser.map(u => (
                        <tr key={u.user}><td style={TD}>{u.user}</td><td style={TD}>{u.flash}</td><td style={TD}>{u.pro}</td><td style={TD}>{u.caption ?? 0}</td><td style={TD}>₹{u.cost}</td></tr>
                      ))}</tbody>
                    </table>
                  </div>
                  <div>
                    <h3 style={{ fontSize: 13, margin: "0 0 8px", color: "#857a6c" }}>By day</h3>
                    <table style={TABLE}>
                      <thead><tr><th style={TH}>Day</th><th style={TH}>Flash</th><th style={TH}>Pro</th><th style={TH}>Captions</th><th style={TH}>Est. cost</th></tr></thead>
                      <tbody>{data.cost.byDay.map(d => (
                        <tr key={d.day}><td style={TD}>{d.day}</td><td style={TD}>{d.flash}</td><td style={TD}>{d.pro}</td><td style={TD}>{d.caption ?? 0}</td><td style={TD}>₹{d.cost}</td></tr>
                      ))}</tbody>
                    </table>
                  </div>
                  <span style={{ fontSize: 11, color: "#857a6c" }}>Estimates at ₹{data.cost.prices?.flash ?? 5.76}/Flash &amp; ₹{data.cost.prices?.pro ?? 11.18}/Pro image, ₹{data.cost.prices?.caption ?? 0.09}/caption — converted at ₹{data.cost.usdToInr ?? 86}/USD.</span>
                </div>
              )}

              {tab === "activity" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", padding: 10, background: "#faf7f2", border: "1px solid #eee3d3", borderRadius: 8, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 12, color: "#6b6152" }}>Restore a user's history if it was accidentally hidden/cleared:</span>
                    <input
                      value={restoreUser}
                      onChange={e => setRestoreUser(e.target.value)}
                      placeholder="username, e.g. bharatrm"
                      style={{ fontSize: 13, padding: "6px 8px", border: "1px solid #e4ddd2", borderRadius: 6, width: 180 }}
                    />
                    <input
                      value={restoreDate}
                      onChange={e => setRestoreDate(e.target.value)}
                      placeholder="date (optional) YYYY-MM-DD"
                      title="Limit the restore to runs created on this day. Leave blank to restore all hidden history for the user."
                      style={{ fontSize: 13, padding: "6px 8px", border: "1px solid #e4ddd2", borderRadius: 6, width: 190 }}
                    />
                    <button className="btn btn-tiny btn-secondary" onClick={restoreHistory} disabled={restoring || !restoreUser.trim()}>
                      {restoring ? "Restoring…" : "Restore hidden history"}
                    </button>
                    {restoreMsg && <span style={{ fontSize: 12, color: "#4a7c59" }}>{restoreMsg}</span>}
                  </div>
                  {data.activity.length === 0 && <span style={{ color: "#857a6c" }}>No activity yet.</span>}
                  {data.activity.map(r => (
                    <div key={r.id} style={{ border: "1px solid #e4ddd2", borderRadius: 8, overflow: "hidden" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", background: "#f3efe9", flexWrap: "wrap" }}>
                        <strong style={{ fontSize: 13 }}>{r.user || "unknown"}</strong>
                        <span style={{ fontSize: 12, color: "#857a6c" }}>{r.fabricName} · {formatWhen(r.createdAt)} · {r.images.length} images</span>
                        {r.hidden && <span style={{ fontSize: 10, textTransform: "uppercase", background: "#FAEFD8", color: "#b5862b", padding: "2px 7px", borderRadius: 99 }}>deleted by staff</span>}
                      </div>
                      <div style={{ display: "flex", gap: 8, padding: 10, overflowX: "auto" }}>
                        {r.images.map((im, i) => (
                          <button key={i} onClick={() => setLightbox(im.url)} title={im.templateLabel} style={{ flex: "0 0 90px", padding: 0, border: "none", background: "none", cursor: "zoom-in" }}>
                            <img src={im.thumb || im.url} alt={im.templateLabel} loading="lazy" style={{ width: 90, height: 90, objectFit: "cover", borderRadius: 6, display: "block" }} />
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {tab === "captions" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 760 }}>
                  <div>
                    <h3 style={{ fontSize: 13, margin: "0 0 4px", color: "#2a2118" }}>Creative instructions (AI)</h3>
                    <span style={{ fontSize: 12, color: "#857a6c" }}>
                      How the AI writes the title, the two intro paragraphs, and the Key Features. Each product's SKU, fabric type, colour and tags are added automatically. The fixed sections below are appended by the app — don't describe them here.
                    </span>
                    <textarea
                      value={capSettings.captionInstructions || ""}
                      onChange={e => setCap("captionInstructions", e.target.value)}
                      rows={16}
                      style={{ width: "100%", marginTop: 8, fontFamily: "inherit", fontSize: 13, padding: 12, border: "1px solid #e4ddd2", borderRadius: 8, resize: "vertical", lineHeight: 1.5, boxSizing: "border-box" }}
                    />
                  </div>

                  <div style={{ borderTop: "1px solid #e4ddd2", paddingTop: 12 }}>
                    <h3 style={{ fontSize: 13, margin: "0 0 4px", color: "#2a2118" }}>Approved tags</h3>
                    <span style={{ fontSize: 12, color: "#857a6c" }}>
                      The AI may only assign tags from this list (one per line). “Fabric”, the product’s colour, and the tags your team types in the queue are always added automatically — no need to list those here. Embroidered pieces also get “Embroidery” plus each technique.
                    </span>
                    <textarea
                      value={(Array.isArray(capSettings.tagWhitelist) ? capSettings.tagWhitelist : []).join("\n")}
                      onChange={e => setCap("tagWhitelist", e.target.value.split("\n"))}
                      rows={12}
                      style={{ width: "100%", marginTop: 8, fontFamily: "inherit", fontSize: 13, padding: 12, border: "1px solid #e4ddd2", borderRadius: 8, resize: "vertical", lineHeight: 1.5, boxSizing: "border-box" }}
                    />
                  </div>

                  <div style={{ borderTop: "1px solid #e4ddd2", paddingTop: 12 }}>
                    <h3 style={{ fontSize: 13, margin: "0 0 4px", color: "#2a2118" }}>Fixed sections (same on every product)</h3>
                    <span style={{ fontSize: 12, color: "#857a6c" }}>Appended after the description, exactly as written.</span>

                    <label style={{ display: "block", fontSize: 12, color: "#857a6c", margin: "10px 0 4px" }}>Care Instructions — one bullet per line</label>
                    <textarea
                      value={capSettings.careInstructions || ""}
                      onChange={e => setCap("careInstructions", e.target.value)}
                      rows={3}
                      style={{ width: "100%", fontFamily: "inherit", fontSize: 13, padding: 10, border: "1px solid #e4ddd2", borderRadius: 8, resize: "vertical", boxSizing: "border-box" }}
                    />

                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
                      <label style={{ flex: "1 1 140px", fontSize: 12, color: "#857a6c" }}>Approximate Measurement
                        <input value={capSettings.measurement || ""} onChange={e => setCap("measurement", e.target.value)} style={{ width: "100%", marginTop: 4, fontSize: 13, padding: 8, border: "1px solid #e4ddd2", borderRadius: 8, boxSizing: "border-box" }} />
                      </label>
                    </div>

                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
                      <label style={{ flex: "1 1 200px", fontSize: 12, color: "#857a6c" }}>Lining link — label
                        <input value={capSettings.liningLabel || ""} onChange={e => setCap("liningLabel", e.target.value)} style={{ width: "100%", marginTop: 4, fontSize: 13, padding: 8, border: "1px solid #e4ddd2", borderRadius: 8, boxSizing: "border-box" }} />
                      </label>
                      <label style={{ flex: "2 1 280px", fontSize: 12, color: "#857a6c" }}>Lining link — URL
                        <input value={capSettings.liningUrl || ""} onChange={e => setCap("liningUrl", e.target.value)} style={{ width: "100%", marginTop: 4, fontSize: 13, padding: 8, border: "1px solid #e4ddd2", borderRadius: 8, boxSizing: "border-box" }} />
                      </label>
                    </div>

                    <label style={{ display: "block", fontSize: 12, color: "#857a6c", margin: "10px 0 4px" }}>Colour disclaimer</label>
                    <textarea
                      value={capSettings.disclaimer || ""}
                      onChange={e => setCap("disclaimer", e.target.value)}
                      rows={2}
                      style={{ width: "100%", fontFamily: "inherit", fontSize: 13, padding: 10, border: "1px solid #e4ddd2", borderRadius: 8, resize: "vertical", boxSizing: "border-box" }}
                    />
                  </div>

                  <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                    <button className="btn btn-primary" onClick={saveCaptions} disabled={savingCap}>
                      {savingCap ? "Saving…" : "Save caption settings"}
                    </button>
                    {capMsg && <span style={{ fontSize: 12, color: capMsg === "Saved." ? "#4a7c59" : "#B33A1F" }}>{capMsg}</span>}
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {lightbox && (
        <div className="lightbox-overlay" onClick={(e) => { e.stopPropagation(); setLightbox(null); }}>
          <button className="lightbox-close" onClick={(e) => { e.stopPropagation(); setLightbox(null); }}>×</button>
          <figure className="lightbox-figure" onClick={e => e.stopPropagation()}>
            <img src={lightbox} alt="" className="lightbox-img" />
          </figure>
        </div>
      )}
    </div>

    {showAll && (
      <HistoryModal scope="all" isAdmin templates={templates} onClose={() => setShowAll(false)} />
    )}
    </>
  );
}

function Stat({ label, value, big }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em", color: "#857a6c" }}>{label}</span>
      <span style={{ fontSize: big ? 26 : 18, fontWeight: 600, color: big ? "#C4552A" : "#2a2118" }}>{value}</span>
    </div>
  );
}
