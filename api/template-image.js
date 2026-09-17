const multer = require("multer");
const { putImage, deleteKeys, urlToKey } = require("./_lib/storage");
const { updateManifest } = require("./_lib/manifest");
const { getUser } = require("./_lib/auth");
const { getUserActive, userTemplatesView } = require("./_lib/active");

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
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    await runMiddleware(req, res, upload.single("image"));
    const id = req.body.id;
    if (!id) return res.status(400).json({ error: "Missing template id" });
    if (!req.file) return res.status(400).json({ error: "No image uploaded" });

    // New unique key so the cropped image is served immediately.
    const url = await putImage(`fs-templates/${id}-${Date.now()}.jpg`, req.file.buffer);

    let oldUrl = null;
    let found = false;
    const manifest = await updateManifest(current => {
      const t = current.find(x => x.id === id);
      found = !!t;
      if (!t) return undefined;
      oldUrl = t.url;
      return current.map(x => (x.id === id ? { ...x, url } : x));
    });
    if (!found) {
      try { await deleteKeys([urlToKey(url)]); } catch {}
      return res.status(404).json({ error: "Template not found" });
    }

    if (oldUrl) {
      try { await deleteKeys([urlToKey(oldUrl)]); } catch {}
    }

    const { user } = getUser(req);
    const activeIds = await getUserActive(user, manifest);
    return res.json(userTemplatesView(manifest, activeIds));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

module.exports.config = { api: { bodyParser: false }, maxDuration: 30 };
