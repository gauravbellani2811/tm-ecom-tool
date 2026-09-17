// Build & download a CSV of product captions for copy-paste into Shopify.
// One row per product: SKU, Title, Description, Tags, Product type.

export function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Strip HTML to readable text for on-screen previews (the CSV keeps the full HTML).
export function plainPreview(html, max = 280) {
  const text = (html == null ? "" : String(html))
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<\/(p|li|ul|div)>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
  return max && text.length > max ? text.slice(0, max).trimEnd() + "…" : text;
}

// RFC-4180: quote every field, double internal quotes.
export function csvCell(v) {
  return `"${(v == null ? "" : String(v)).replace(/"/g, '""')}"`;
}

const HEADER = ["SKU", "Title", "Description", "Tags", "Product type"];

// rows: [{ sku, title, description, tags: string[], productType, altTexts: [{label, alt}] }]
// Alt texts become position columns "Alt 1 … Alt N" (N = max across rows).
export function buildCaptionsCsv(rows) {
  const maxAlt = rows.reduce((m, r) => Math.max(m, Array.isArray(r.altTexts) ? r.altTexts.length : 0), 0);
  const altHeaders = Array.from({ length: maxAlt }, (_, i) => `Alt ${i + 1}`);
  const lines = [[...HEADER, ...altHeaders].map(csvCell).join(",")];
  for (const r of rows) {
    const alts = Array.isArray(r.altTexts) ? r.altTexts : [];
    const cells = [
      csvCell(r.sku),
      csvCell(r.title),
      csvCell(r.description),
      csvCell(Array.isArray(r.tags) ? r.tags.filter(Boolean).join("; ") : (r.tags || "")),
      csvCell(r.productType),
    ];
    for (let i = 0; i < maxAlt; i++) cells.push(csvCell((alts[i] && alts[i].alt) || ""));
    lines.push(cells.join(","));
  }
  return lines.join("\r\n");
}

function downloadRows(rows, filename) {
  if (!rows.length) throw new Error("No captions to download");
  const csv = buildCaptionsCsv(rows);
  // Leading BOM so Excel/Sheets read UTF-8 correctly.
  triggerDownload(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }), filename);
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

// Session results: each fabric may carry a `caption` set during generation.
export function downloadSessionCaptions(fabrics) {
  const rows = (fabrics || [])
    .filter(f => f.caption && (f.caption.title || f.caption.description))
    .map(f => ({ sku: f.name, ...f.caption }));
  downloadRows(rows, `captions-${stamp()}.csv`);
}

// History: one run or an array of runs, each with a stored `caption`.
export function downloadRunCaptions(runOrRuns) {
  const runs = Array.isArray(runOrRuns) ? runOrRuns : [runOrRuns];
  const rows = runs
    .filter(r => r && r.caption && (r.caption.title || r.caption.description))
    .map(r => ({ sku: r.fabricName, ...r.caption }));
  const name = runs.length === 1 && runs[0]
    ? `captions-${(runs[0].fabricName || "product").replace(/[^a-z0-9\-_]+/gi, "-")}.csv`
    : `captions-${stamp()}.csv`;
  downloadRows(rows, name);
}
