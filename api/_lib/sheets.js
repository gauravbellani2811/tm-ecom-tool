// Best-effort append of a caption row to a Google Sheet via a Google Apps Script
// Web App webhook. No Google Cloud project or service account needed — the sheet's
// bound Apps Script exposes a doPost() that appends the row. Configured by env:
//   CAPTIONS_SHEET_WEBHOOK — the Apps Script Web App deployment URL
//   CAPTIONS_SHEET_TOKEN   — shared secret the script verifies
// If the webhook isn't configured, this is a no-op (feature simply off).

async function appendCaptionRow({ sku, title, description, tags, productType, altTexts, user }) {
  const url = process.env.CAPTIONS_SHEET_WEBHOOK;
  if (!url) return { skipped: true };

  const alts = Array.isArray(altTexts) ? altTexts.map(a => (a && a.alt) || "") : [];
  const payload = {
    token: process.env.CAPTIONS_SHEET_TOKEN || "",
    timestamp: new Date().toISOString(),
    sku: sku || "",
    title: title || "",
    description: description || "",
    tags: Array.isArray(tags) ? tags.join(", ") : (tags || ""),
    productType: productType || "",
    alt1: alts[0] || "", alt2: alts[1] || "", alt3: alts[2] || "",
    alt4: alts[3] || "", alt5: alts[4] || "",
    user: user || "",
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "follow", // Apps Script 302-redirects to script.googleusercontent.com
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Sheet webhook responded ${res.status}`);
    return { ok: true };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { appendCaptionRow };
