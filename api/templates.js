const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const { putImage } = require("./_lib/storage");
const { GoogleGenAI } = require("@google/genai");
const { readManifest, updateManifest } = require("./_lib/manifest");
const { buildDefaultPrompt } = require("./_lib/prompts");
const { getUser } = require("./_lib/auth");
const { getUserActive, setUserActive, userTemplatesView, MAX_ACTIVE } = require("./_lib/active");
const { generateAltPattern } = require("./_lib/alttext");

async function describeScene(imageBuffer, mimeType) {
  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const result = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{
        role: "user",
        parts: [
          { inlineData: { mimeType, data: imageBuffer.toString("base64") } },
          {
            text: `Describe this product photography scene in detail for a photo-styling tool. Focus on:
- All props visible (baskets, boxes, trays, plants, candles, decorative objects, etc.)
- Background and surface materials (wood, marble, linen, etc.)
- Lighting style and direction (soft natural light from the left, harsh studio, warm golden hour, etc.)
- Color palette of the scene (excluding the fabric)
- Camera angle and composition (overhead flatlay, 45-degree, eye-level, etc.)
- How any fabric or textile in the scene is styled (folded into thirds, draped, rolled, scrunched, etc.) — describe ONLY the form, not the pattern or color

Write as a single descriptive paragraph under 120 words. Do NOT describe the fabric's existing pattern or color since that will be swapped out.`
          }
        ]
      }]
    });
    const textPart = result.candidates?.[0]?.content?.parts?.find(p => p.text);
    return textPart?.text?.trim() || "";
  } catch (err) {
    console.error("Scene description failed:", err);
    return "";
  }
}

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

module.exports = async function handler(req, res) {
  if (req.method === "GET") {
    const { user } = getUser(req);
    const manifest = await readManifest();
    const activeIds = await getUserActive(user, manifest);
    return res.json(userTemplatesView(manifest, activeIds));
  }

  if (req.method === "POST") {
    try {
      await runMiddleware(req, res, upload.single("image"));

      const { user } = getUser(req);

      const id = uuidv4();
      const url = await putImage(`fs-templates/${id}.jpg`, req.file.buffer);

      const description = await describeScene(req.file.buffer, req.file.mimetype);
      const prompt = buildDefaultPrompt(description);
      // Auto-generate this template's SEO alt-text pattern from the scene.
      const altPattern = await generateAltPattern({ imageBuffer: req.file.buffer, mimeType: req.file.mimetype });

      const manifest = await updateManifest(current => [
        ...current,
        { id, url, label: req.body.label || `Template ${current.length + 1}`, description, prompt, altPattern },
      ]);

      // Auto-activate for the CREATING user only, if they have room.
      let activeIds = await getUserActive(user, manifest);
      if (user && activeIds.length < MAX_ACTIVE && !activeIds.includes(id)) {
        activeIds = await setUserActive(user, [...activeIds, id], manifest);
      }

      return res.json(userTemplatesView(manifest, activeIds));
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // Reorder the requesting user's active set. Body: { order: [templateId,...] }.
  if (req.method === "PUT") {
    try {
      const body = await new Promise((resolve) => {
        let d = ""; req.on("data", c => d += c);
        req.on("end", () => { try { resolve(JSON.parse(d || "{}")); } catch { resolve({}); } });
        req.on("error", () => resolve({}));
      });
      const { user } = getUser(req);
      if (!user) return res.status(401).json({ error: "Not signed in" });

      // Backfill: generate an alt-text pattern for any template missing one.
      if (body.action === "backfillAlt") {
        const missing = (await readManifest()).filter(t => !t.altPattern || (body.force && true));
        const patterns = new Map();
        await Promise.all(missing.map(async t => {
          try {
            const r = await fetch(t.url);
            const buf = Buffer.from(await r.arrayBuffer());
            patterns.set(t.id, await generateAltPattern({ imageBuffer: buf, mimeType: "image/jpeg" }));
          } catch { /* leave as-is */ }
        }));
        const manifest = await updateManifest(current =>
          current.map(t => (patterns.has(t.id) ? { ...t, altPattern: patterns.get(t.id) } : t)));
        const activeIds = await getUserActive(user, manifest);
        return res.json(userTemplatesView(manifest, activeIds));
      }

      const order = Array.isArray(body.order) ? body.order : [];
      const manifest = await readManifest();
      const activeIds = await setUserActive(user, order, manifest);
      return res.json(userTemplatesView(manifest, activeIds));
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  res.status(405).json({ error: "Method not allowed" });
};

module.exports.config = { api: { bodyParser: false }, maxDuration: 60 };
