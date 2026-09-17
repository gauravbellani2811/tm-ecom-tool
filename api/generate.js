const multer = require("multer");
const { putImage, getObjectBuffer, isStoredImageKey, urlToKey, listObjects, deleteKeys } = require("./_lib/storage");

// Retry variations nobody picked are useless after a day — picked ones are copied
// into fs-history/ by history-add, so fs-candidates/ is only a short-lived scratch area.
const CANDIDATE_TTL_MS = 24 * 60 * 60 * 1000;
async function sweepOldCandidates() {
  try {
    const cutoff = Date.now() - CANDIDATE_TTL_MS;
    const old = (await listObjects("fs-candidates/"))
      .filter(o => Number.isFinite(o.lastModified) && o.lastModified < cutoff)
      .slice(0, 300)
      .map(o => o.key);
    if (old.length) await deleteKeys(old);
  } catch (e) {
    console.error("Candidate sweep failed:", e.message);
  }
}
const { v4: uuidv4 } = require("uuid");
const { GoogleGenAI } = require("@google/genai");
const { readManifest } = require("./_lib/manifest");
const { buildDefaultPrompt, composePrompt } = require("./_lib/prompts");
const { appendRun } = require("./_lib/history");
const { appendEvents } = require("./_lib/audit");
const { getUser } = require("./_lib/auth");
const { readCaptionSettings, generateCaption } = require("./_lib/captions");
const { appendCaptionRow } = require("./_lib/sheets");
const { fillAlt } = require("./_lib/alttext");
const { withThumb } = require("./_lib/thumbs");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (["image/jpeg", "image/png", "image/webp"].includes(file.mimetype)) cb(null, true);
    else cb(new Error("Only jpg, png, webp allowed"));
  },
});

function runMiddleware(req, res, fn) {
  return new Promise((resolve, reject) => {
    fn(req, res, result => {
      if (result instanceof Error) reject(result);
      else resolve(result);
    });
  });
}

const FLASH_MODEL = "gemini-3.1-flash-image";
const PRO_MODEL = "gemini-3-pro-image";

// Aspect ratios the image models accept. We match the template to the nearest.
const SUPPORTED_RATIOS = [
  ["1:1", 1 / 1], ["2:3", 2 / 3], ["3:2", 3 / 2], ["3:4", 3 / 4],
  ["4:3", 4 / 3], ["9:16", 9 / 16], ["16:9", 16 / 9], ["21:9", 21 / 9],
];

// Read width/height from a JPEG buffer (templates are always stored as JPEG).
function jpegSize(buf) {
  if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let off = 2;
  while (off + 9 < buf.length) {
    if (buf[off] !== 0xff) { off++; continue; }
    const marker = buf[off + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
    }
    off += 2 + buf.readUInt16BE(off + 2);
  }
  return null;
}

function nearestAspectRatio(buf) {
  const size = jpegSize(buf);
  if (!size || !size.width || !size.height) return null;
  const r = size.width / size.height;
  let best = null, bestDiff = Infinity;
  for (const [name, val] of SUPPORTED_RATIOS) {
    const diff = Math.abs(Math.log(r / val));
    if (diff < bestDiff) { bestDiff = diff; best = name; }
  }
  return best;
}

async function callGemini(templateBase64, fabricBase64, promptText, model, aspectRatio, detailBase64) {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Gemini timed out after 60s")), 60000)
  );

  const config = { responseModalities: ["IMAGE"] };
  if (aspectRatio) config.imageConfig = { aspectRatio };

  // Order matters: template (IMAGE 1), fabric (IMAGE 2), optional close-up (IMAGE 3), then text.
  const parts = [
    { inlineData: { mimeType: "image/jpeg", data: templateBase64 } },
    { inlineData: { mimeType: "image/jpeg", data: fabricBase64 } },
  ];
  if (detailBase64) parts.push({ inlineData: { mimeType: "image/jpeg", data: detailBase64 } });
  parts.push({ text: promptText });

  const generatePromise = ai.models.generateContent({
    model: model || FLASH_MODEL,
    contents: [{ role: "user", parts }],
    config,
  });

  const result = await Promise.race([generatePromise, timeoutPromise]);
  const imagePart = result.candidates[0].content.parts.find(p => p.inlineData);
  if (!imagePart) throw new Error("No image returned from Gemini");
  return `data:image/jpeg;base64,${imagePart.inlineData.data}`;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    await runMiddleware(req, res, upload.fields([
      { name: "fabric", maxCount: 1 },
      { name: "flatImage", maxCount: 1 },
      { name: "detailImage", maxCount: 1 },
    ]));

    // Retries may reference photos already stored in R2 (fabricUrl / detailUrl)
    // instead of re-uploading them — request bodies count toward Vercel's
    // Fast Origin Transfer; R2 reads from inside the function don't.
    const stored = async (url) => {
      const key = urlToKey(url);
      if (!isStoredImageKey(key)) throw new Error("Invalid stored image reference");
      return { buffer: await getObjectBuffer(key), mimetype: "image/jpeg" };
    };
    let fabricFile = req.files && req.files.fabric && req.files.fabric[0];
    const flatFile = req.files && req.files.flatImage && req.files.flatImage[0];
    let detailFile = req.files && req.files.detailImage && req.files.detailImage[0];
    if (!fabricFile && req.body.fabricUrl) fabricFile = await stored(req.body.fabricUrl);
    if (!detailFile && req.body.detailUrl) {
      try { detailFile = await stored(req.body.detailUrl); } catch { detailFile = null; }
    }
    if (!fabricFile) return res.status(400).json({ error: "No fabric image uploaded" });

    let templateIds = req.body["templateIds[]"] || req.body.templateIds || [];
    if (typeof templateIds === "string") templateIds = [templateIds];
    if (!templateIds.length) return res.status(400).json({ error: "No template IDs provided" });

    const manifest = await readManifest();
    const fabricBase64 = fabricFile.buffer.toString("base64");
    const detailBase64 = detailFile ? detailFile.buffer.toString("base64") : null;

    // Higher-quality Pro model, opt-in per request (used by the "Pro" retry button).
    const model = req.body.model === "pro" ? PRO_MODEL : FLASH_MODEL;

    const action = req.body.action || "generate";
    const skipHistory = req.body.skipHistory === "1" || req.body.skipHistory === "true";

    // Caption facts (optional). Products with none of these skip captioning entirely.
    const fabricType = (req.body.fabricType || "").toString().trim();
    const colour = (req.body.colour || "").toString().trim();
    const adjective = (req.body.adjective || "").toString().trim();
    let tags = req.body["tags[]"] || req.body.tags || [];
    if (typeof tags === "string") tags = [tags];
    tags = tags.map(t => (t || "").toString().trim()).filter(Boolean).slice(0, 3);
    const wantCaption = action === "generate" && !skipHistory && !!(fabricType || colour || adjective || tags.length);

    // Kick off caption generation in parallel with the images (best-effort). Uses the
    // flat swatch when available (cleaner top-down view), else the raw fabric photo.
    let captionPromise = Promise.resolve(null);
    if (wantCaption) {
      const capBuf = (flatFile && flatFile.buffer) || fabricFile.buffer;
      const capMime = (flatFile && flatFile.mimetype) || fabricFile.mimetype;
      captionPromise = readCaptionSettings()
        .then(settings => generateCaption({
          imageBuffer: capBuf, mimeType: capMime, sku: req.body.fabricName,
          fabricType, colour, adjective, tags, settings,
        }))
        .catch(() => null);
    }

    const tasks = templateIds.map(async templateId => {
      const tpl = manifest.find(t => t.id === templateId);
      if (!tpl) return { templateId, error: "Template not found" };
      try {
        const tplRes = await fetch(tpl.url);
        const tplBuf = Buffer.from(await tplRes.arrayBuffer());
        const tplBase64 = tplBuf.toString("base64");
        const aspectRatio = nearestAspectRatio(tplBuf); // match output to template framing
        const promptText = composePrompt(tpl.prompt || buildDefaultPrompt(tpl.description || ""), { hasDetail: !!detailBase64 });
        const imageDataUrl = await callGemini(tplBase64, fabricBase64, promptText, model, aspectRatio, detailBase64);
        return { templateId, templateLabel: tpl.label, imageDataUrl };
      } catch (err) {
        return { templateId, templateLabel: tpl.label, error: err.message };
      }
    });

    const results = await Promise.all(tasks);
    const caption = await captionPromise;

    // Store every generated image in R2 right away and send back its URL, not the
    // base64 bytes (~0.9 MB per image through the function — the main driver of
    // Fast Origin Transfer). History runs keep their usual key; retry candidates
    // go under fs-candidates/ until one is picked (history-add copies it).
    const keepInHistory = !skipHistory && !!req.body.runId;
    await Promise.all(results.map(async r => {
      if (!r.imageDataUrl) return;
      const imgId = uuidv4();
      const key = keepInHistory ? `fs-history/${req.body.runId}-${imgId}.jpg` : `fs-candidates/${imgId}.jpg`;
      try {
        r.url = await putImage(key, Buffer.from(r.imageDataUrl.split(",")[1], "base64"));
        r.imgId = imgId;
      } catch (e) {
        console.error("Image store failed (falling back to inline data):", e);
      }
    }));

    // Deterministic per-image SEO alt text (ordered by templateIds = image position).
    if (caption && wantCaption) {
      caption.altTexts = templateIds.map(tid => {
        const tpl = manifest.find(t => t.id === tid);
        return {
          label: (tpl && tpl.label) || "",
          alt: fillAlt(tpl && tpl.altPattern, { colour, adjective, material: fabricType, tags }),
        };
      }).filter(a => a.alt);
    }

    const currentUser = getUser(req).user;

    // Admin audit: one event per template result — runs for EVERY call (incl.
    // retry3 candidates and skipHistory) so cost + retry tracking is complete.
    try {
      const nowIso = new Date().toISOString();
      const events = results.map(r => ({
        id: uuidv4(),
        ts: nowIso,
        user: currentUser,
        action,
        templateId: r.templateId,
        templateLabel: r.templateLabel || "",
        model: model === PRO_MODEL ? "pro" : "flash",
        status: r.imageDataUrl ? "ok" : "error",
      }));
      // One event per caption attempt so its (small) cost shows in the admin panel.
      if (wantCaption) {
        events.push({
          id: uuidv4(),
          ts: nowIso,
          user: currentUser,
          action: "caption",
          templateId: "__caption__",
          templateLabel: "Caption",
          model: "caption",
          status: caption ? "ok" : "error",
        });
      }
      await appendEvents(events);
    } catch (auditErr) {
      console.error("Audit log failed:", auditErr);
    }

    const sources = {}; // stored original/detail URLs so later retries needn't re-upload

    // Best-effort: persist successful images to the 10-day history log.
    // Never let a history failure break the generation response.
    // skipHistory is used by the "Retry ×3" chooser so candidates don't pollute history.
    try {
      const runId = req.body.runId;
      const fabricName = req.body.fabricName;
      const succeeded = results.filter(r => r.imageDataUrl);
      if (!skipHistory && runId && (succeeded.length || flatFile)) {
        const altFor = (tid) => {
          if (!wantCaption) return "";
          const tpl = manifest.find(t => t.id === tid);
          return fillAlt(tpl && tpl.altPattern, { colour, adjective, material: fabricType, tags });
        };
        const images = await Promise.all(succeeded.map(async r => {
          const imgId = r.imgId || uuidv4();
          const buffer = Buffer.from(r.imageDataUrl.split(",")[1], "base64");
          const url = r.url || await putImage(`fs-history/${runId}-${imgId}.jpg`, buffer);
          const alt = altFor(r.templateId);
          return withThumb({
            id: imgId,
            templateId: r.templateId,
            templateLabel: r.templateLabel,
            url,
            createdAt: new Date().toISOString(),
            ...(alt ? { alt } : {}),
          }, buffer);
        }));

        // The flat swatch (only sent on the main generate call) — store it too.
        if (flatFile) {
          const flatUrl = await putImage(`fs-history/${runId}-flat.jpg`, flatFile.buffer);
          images.unshift(await withThumb({
            id: "flat",
            templateId: "__flat__",
            templateLabel: "Flat fabric",
            url: flatUrl,
            createdAt: new Date().toISOString(),
          }, flatFile.buffer));
        }

        // Store the ORIGINAL uploaded fabric photo (the raw frame, not the flat
        // crop) so the user can spot-check generations for hallucination. Hidden
        // from the grid; shown on demand via "Original". Fixed key = idempotent
        // across retries; cleaned up with the run by the existing image pruning.
        try {
          const originalUrl = await putImage(`fs-history/${runId}-original.jpg`, fabricFile.buffer);
          sources.fabricUrl = originalUrl;
          images.unshift({
            id: "original",
            templateId: "__original__",
            templateLabel: "Original upload",
            url: originalUrl,
            createdAt: new Date().toISOString(),
          });
        } catch (e) { console.error("Original save failed:", e); }

        // Store the close-up DETAIL photo (IMAGE 3) so History retries can re-send
        // it — otherwise a retried embroidery fabric loses its texture reference.
        // Hidden from the grid like the original; cleaned up with the run.
        if (detailFile) {
          try {
            const detailUrl = await putImage(`fs-history/${runId}-detail.jpg`, detailFile.buffer);
            sources.detailUrl = detailUrl;
            images.unshift({
              id: "detail",
              templateId: "__detail__",
              templateLabel: "Close-up detail",
              url: detailUrl,
              createdAt: new Date().toISOString(),
            });
          } catch (e) { console.error("Detail save failed:", e); }
        }

        // Persist the user-provided facts/tags so they show next to the original.
        const factsProvided = colour || adjective || fabricType || (tags && tags.length);
        const facts = factsProvided ? { colour, adjective, material: fabricType, tags } : null;
        await appendRun({ runId, fabricName, images, user: currentUser, caption, ...(facts ? { facts } : {}) });
      }
    } catch (histErr) {
      console.error("History save failed:", histErr);
    }

    // Best-effort: append the caption to the Google Sheet (no-op if not configured).
    if (caption) {
      try {
        await appendCaptionRow({
          sku: req.body.fabricName,
          title: caption.title,
          description: caption.description,
          tags: caption.tags,
          productType: caption.productType,
          altTexts: caption.altTexts,
          user: currentUser,
        });
      } catch (sheetErr) {
        console.error("Sheet append failed:", sheetErr);
      }
    }

    // Retry calls create new candidates, so tidy up expired ones at the same time.
    if (skipHistory) await sweepOldCandidates();

    const out = results.map(({ imgId, url, imageDataUrl, ...rest }) =>
      (imageDataUrl ? { ...rest, imageDataUrl: url || imageDataUrl } : rest));
    res.json({ results: out, caption, sources });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports.config = { api: { bodyParser: false }, maxDuration: 60 };
