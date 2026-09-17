import JSZip from "jszip";
import { dataUrlToBlob } from "./dataUrlToBlob";

function safeName(s) {
  return (s || "untitled").replace(/[^a-z0-9\-_]+/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// SKU_templatename.jpg — used both for a standalone single-image download and
// as the filename inside each SKU's subfolder within a multi-image zip.
function fileNameFor(fabricName, templateLabel) {
  return `${safeName(fabricName)}_${safeName(templateLabel)}.jpg`;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

// Cache-bust remote URLs so a cross-origin fetch never reuses a cached <img>
// response that lacks CORS headers (r2.dev sends `Vary: Origin`, and <img> loads
// send no Origin → the cached copy has no Access-Control-Allow-Origin, which makes
// a later fetch() fail with "Failed to fetch"). Leaves data:/blob: URLs untouched.
function bust(url) {
  if (typeof url !== "string" || url.startsWith("data:") || url.startsWith("blob:")) return url;
  return url + (url.includes("?") ? "&" : "?") + "cb=" + Date.now();
}

// Results can carry a base64 data: URL (styled images) OR a blob:/http URL
// (e.g. the Flat fabric swatch). Resolve any of them to a Blob.
async function srcToBlob(src) {
  if (typeof src === "string" && src.startsWith("data:")) return dataUrlToBlob(src);
  const res = await fetch(bust(src));
  if (!res.ok) throw new Error("Could not read image");
  return await res.blob();
}

// Build & download ONE zip from items = [{ fabricName, templateLabel, src }].
// Every item goes inside a subfolder named after its SKU (fabricName); the
// file inside that folder is named "{sku}_{templateLabel}.jpg".
async function downloadZip(items, zipName) {
  if (!items.length) throw new Error("Nothing to download");
  const zip = new JSZip();
  for (const it of items) {
    const blob = await srcToBlob(it.src);
    const folder = zip.folder(safeName(it.fabricName));
    folder.file(fileNameFor(it.fabricName, it.templateLabel), blob);
  }
  const blob = await zip.generateAsync({ type: "blob" });
  triggerDownload(blob, zipName);
}

// ===== Session results (main page) — images are data:/blob: URLs =====

// Single image — no zip.
export async function downloadSingleResult(fabricName, templateLabel, imageDataUrl) {
  triggerDownload(await srcToBlob(imageDataUrl), fileNameFor(fabricName, templateLabel));
}

// One zip for a single fabric's results (one SKU subfolder inside).
export async function downloadFabricResults(fabric) {
  const items = (fabric.results || [])
    .filter(r => r.imageDataUrl)
    .map(r => ({ fabricName: fabric.name, templateLabel: r.templateLabel, src: r.imageDataUrl }));
  await downloadZip(items, `${safeName(fabric.name)}.zip`);
}

// One zip across all fabrics — one subfolder per SKU.
export async function downloadAllResults(fabrics) {
  const items = [];
  for (const f of fabrics || []) {
    for (const r of (f.results || [])) {
      if (r.imageDataUrl) items.push({ fabricName: f.name, templateLabel: r.templateLabel, src: r.imageDataUrl });
    }
  }
  await downloadZip(items, `fabric-styler-${stamp()}.zip`);
}

// ===== History downloads — images are public R2 URLs =====

// Single image — no zip.
export async function downloadUrl(url, fabricName, templateLabel) {
  const res = await fetch(bust(url));
  if (!res.ok) throw new Error("Could not fetch image");
  triggerDownload(await res.blob(), fileNameFor(fabricName, templateLabel));
}

// Download any image URL as {baseName}.jpg (used for template images) — single, no zip.
export async function downloadFromUrl(url, baseName) {
  const res = await fetch(bust(url));
  if (!res.ok) throw new Error("Could not fetch image");
  triggerDownload(await res.blob(), `${safeName(baseName)}.jpg`);
}

// One zip for arbitrary history images ({url, fabricName, templateLabel}) —
// one subfolder per SKU, used by the multi-select "Download selected".
export async function downloadImages(items) {
  const list = (items || [])
    .filter(it => it.url)
    .map(it => ({ fabricName: it.fabricName, templateLabel: it.templateLabel, src: it.url }));
  await downloadZip(list, `history-${stamp()}.zip`);
}

// One zip for a single history run (one SKU subfolder inside). The stored
// original-upload reference is excluded — downloads are the generated outputs.
export async function downloadRunImages(record) {
  const items = (record.images || [])
    .filter(im => im.url && im.templateId !== "__original__" && im.templateId !== "__detail__")
    .map(im => ({ fabricName: record.fabricName, templateLabel: im.templateLabel, src: im.url }));
  await downloadZip(items, `${safeName(record.fabricName)}.zip`);
}
