const { requireAdmin } = require("./_lib/auth");
const { readEvents } = require("./_lib/audit");
const { readHistory } = require("./_lib/history");
const { readManifest } = require("./_lib/manifest");
const { readCaptionSettings, writeCaptionSettings } = require("./_lib/captions");

// Estimated per-unit price in USD — Flash/Pro image (1K) + one text caption
// (gemini-2.5-flash: ~1 image + short prompt in, short JSON out ≈ $0.001).
const PRICE = { flash: 0.067, pro: 0.13, caption: 0.001 };
const USD_TO_INR = 86; // display-only conversion; adjust if the rate drifts.
const RETRY_ACTIONS = new Set(["retry", "retry3", "regenerate", "pro"]);

module.exports = async function handler(req, res) {
  const auth = requireAdmin(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  // Save the editable caption settings (creative prompt + fixed sections).
  if (req.method === "POST") {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const saved = await writeCaptionSettings(body);
    return res.json({ ok: true, captionSettings: saved });
  }

  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const [events, history, manifest, captionSettings] = await Promise.all([
    readEvents(), readHistory().catch(() => []), readManifest(), readCaptionSettings(),
  ]);

  // ----- Template health / retry ranking -----
  const tpl = new Map();
  for (const e of events) {
    if (e.templateId === "__flat__" || e.templateId === "__caption__") continue;
    let t = tpl.get(e.templateId);
    if (!t) { t = { templateId: e.templateId, label: e.templateLabel || "", total: 0, errors: 0, retries: 0 }; tpl.set(e.templateId, t); }
    if (e.templateLabel) t.label = e.templateLabel;
    t.total++;
    if (e.status === "error") t.errors++;
    if (RETRY_ACTIONS.has(e.action)) t.retries++;
  }
  for (const m of manifest) {
    if (!tpl.has(m.id)) tpl.set(m.id, { templateId: m.id, label: m.label || "", total: 0, errors: 0, retries: 0 });
    else if (m.label) tpl.get(m.id).label = m.label;
  }
  const templateHealth = [...tpl.values()]
    .map(t => ({ ...t, errorRate: t.total ? +((t.errors / t.total) * 100).toFixed(1) : 0 }))
    .sort((a, b) => b.retries - a.retries || b.total - a.total);

  // ----- Cost & usage (returned in INR) -----
  const inr = usd => +(usd * USD_TO_INR).toFixed(2);
  let flash = 0, pro = 0, caption = 0;
  const byUser = {}, byDay = {};
  for (const e of events) {
    const m = (e.model === "caption" || e.action === "caption") ? "caption" : (e.model === "pro" ? "pro" : "flash");
    if (m === "caption") caption++; else if (m === "pro") pro++; else flash++;
    const u = (byUser[e.user || "unknown"] = byUser[e.user || "unknown"] || { user: e.user || "unknown", flash: 0, pro: 0, caption: 0, cost: 0 });
    u[m]++; u.cost += PRICE[m];
    const day = (e.ts || "").slice(0, 10);
    const d = (byDay[day] = byDay[day] || { day, flash: 0, pro: 0, caption: 0, cost: 0 });
    d[m]++; d.cost += PRICE[m];
  }
  const cost = {
    flash, pro, caption, totalImages: flash + pro,
    estTotal: inr(flash * PRICE.flash + pro * PRICE.pro + caption * PRICE.caption),
    byUser: Object.values(byUser).map(u => ({ ...u, cost: inr(u.cost) })).sort((a, b) => b.cost - a.cost),
    byDay: Object.values(byDay).map(d => ({ ...d, cost: inr(d.cost) })).sort((a, b) => (a.day < b.day ? 1 : -1)).slice(0, 30),
    prices: { flash: inr(PRICE.flash), pro: inr(PRICE.pro), caption: inr(PRICE.caption) },
    currency: "INR",
    usdToInr: USD_TO_INR,
  };

  // ----- Staff activity (history incl. hidden) -----
  const activity = history
    .slice()
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 120)
    .map(r => ({
      id: r.id,
      user: r.user || null,
      fabricName: r.fabricName,
      createdAt: r.createdAt,
      hidden: !!r.hidden,
      images: (r.images || []).map(im => ({ url: im.url, thumb: im.thumb, templateLabel: im.templateLabel })),
    }));

  return res.json({ templateHealth, cost, activity, captionSettings });
};

module.exports.config = { maxDuration: 30 };
