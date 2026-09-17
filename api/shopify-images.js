const { copyObject, urlToKey } = require("./_lib/storage");
const { getUser } = require("./_lib/auth");

// Publish history images under clean, Shopify-friendly filenames.
// Shopify names an imported image after its URL, so `fs-history/r_ab12-uuid.jpg`
// would land in the media library as `r_ab12-uuid.jpg`. Copying to
// `shopify/EC17010_Tray.jpg` first makes Shopify store that tidy name instead.
//
// POST { images: [{ url, filename }] } -> { urls: { <originalUrl>: <cleanUrl> } }
// Best effort per image: a failed copy falls back to the original URL, so an
// export never breaks — it just keeps the uglier name for that one image.

function parseJsonBody(req) {
  if (req.body && typeof req.body === "object") return Promise.resolve(req.body);
  return new Promise(resolve => {
    let data = "";
    req.on("data", c => { data += c; });
    req.on("end", () => { try { resolve(JSON.parse(data || "{}")); } catch { resolve({}); } });
    req.on("error", () => resolve({}));
  });
}

// Keep only characters that are safe (and tidy) in a URL path / filename.
function safeName(s) {
  return (s == null ? "" : String(s))
    .replace(/\.jpe?g$/i, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 120);
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!getUser(req).valid) return res.status(403).json({ error: "Not authorized" });

  try {
    const body = await parseJsonBody(req);
    const images = Array.isArray(body.images) ? body.images.slice(0, 1000) : [];
    if (!images.length) return res.status(400).json({ error: "No images provided" });

    const urls = {};
    await Promise.all(images.map(async item => {
      const src = item && item.url;
      if (!src) return;
      urls[src] = src; // fallback: keep the original URL
      const name = safeName(item.filename);
      const srcKey = urlToKey(src);
      if (!name || !srcKey) return;
      try {
        urls[src] = await copyObject(srcKey, `shopify/${name}.jpg`);
      } catch (err) {
        console.error("shopify-images copy failed:", err.message);
      }
    }));

    return res.json({ urls });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

module.exports.config = { maxDuration: 60 };
