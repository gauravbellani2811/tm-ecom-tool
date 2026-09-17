const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const { putImage, copyObject, urlToKey, isStoredImageKey } = require("./_lib/storage");
const { appendRun } = require("./_lib/history");
const { getUser } = require("./_lib/auth");
const { withThumb } = require("./_lib/thumbs");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});

function runMiddleware(req, res, fn) {
  return new Promise((resolve, reject) => {
    fn(req, res, result => {
      if (result instanceof Error) reject(result);
      else resolve(result);
    });
  });
}

// Save a single chosen image (e.g. the pick from "Retry ×3") into the history run.
// appendRun upserts by templateId, so it replaces the previous image for that template.
module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    await runMiddleware(req, res, upload.single("image"));
    const { runId, fabricName, templateId, templateLabel } = req.body || {};
    // Either an uploaded image, or sourceUrl = an image already in R2 (a generated
    // candidate), copied server-side — no image bytes through the function.
    const sourceKey = !req.file && req.body.sourceUrl ? urlToKey(req.body.sourceUrl) : null;
    if (!runId || !templateId || (!req.file && !sourceKey)) {
      return res.status(400).json({ error: "Missing runId, templateId, or image" });
    }
    if (sourceKey && !isStoredImageKey(sourceKey)) {
      return res.status(400).json({ error: "Invalid sourceUrl" });
    }

    const imgId = uuidv4();
    const destKey = `fs-history/${runId}-${imgId}.jpg`;
    const url = req.file ? await putImage(destKey, req.file.buffer) : await copyObject(sourceKey, destKey);
    const image = await withThumb({
      id: imgId,
      templateId,
      templateLabel: templateLabel || "",
      url,
      createdAt: new Date().toISOString(),
    }, req.file ? req.file.buffer : null);

    await appendRun({ runId, fabricName, user: getUser(req).user, images: [image] });

    // Return the saved image so the client can patch state in place (no full reload).
    return res.json({ ok: true, image });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

module.exports.config = { api: { bodyParser: false }, maxDuration: 30 };
