const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const { putImage } = require("./_lib/storage");
const { readWaitlist, addItem, updateItem, attachDetail, removeDetail, removeItem } = require("./_lib/waitlist");
const { getUser } = require("./_lib/auth");

function parseJsonBody(req) {
  return new Promise((resolve) => {
    let d = ""; req.on("data", c => d += c);
    req.on("end", () => { try { resolve(JSON.parse(d || "{}")); } catch { resolve({}); } });
    req.on("error", () => resolve({}));
  });
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

function runMiddleware(req, res, fn) {
  return new Promise((resolve, reject) => {
    fn(req, res, result => (result instanceof Error ? reject(result) : resolve(result)));
  });
}

module.exports = async function handler(req, res) {
  const { user } = getUser(req);
  if (!user) return res.status(401).json({ error: "Not signed in" });

  if (req.method === "GET") {
    return res.json(await readWaitlist(user));
  }

  if (req.method === "POST") {
    try {
      await runMiddleware(req, res, upload.single("image"));
      if (!req.file) return res.status(400).json({ error: "No image uploaded" });

      // Attach a close-up detail image to an existing item instead of creating one.
      const attachTo = req.body.attachTo;
      if (attachTo) {
        const detailUrl = await putImage(`waitlist/${user}/${attachTo}-detail.jpg`, req.file.buffer);
        const items = await attachDetail(user, attachTo, detailUrl);
        return res.json(items);
      }

      const id = uuidv4();
      const name = (req.body.name || "photo").slice(0, 120);
      const url = await putImage(`waitlist/${user}/${id}.jpg`, req.file.buffer);
      const items = await addItem(user, { id, url, name, createdAt: new Date().toISOString() });
      return res.json(items);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === "PATCH") {
    try {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: "Missing id" });
      const body = await parseJsonBody(req);
      const items = body.removeDetail
        ? await removeDetail(user, id)
        : await updateItem(user, id, body);
      return res.json(items);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === "DELETE") {
    try {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: "Missing id" });
      const items = await removeItem(user, id);
      return res.json(items);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  res.status(405).json({ error: "Method not allowed" });
};

module.exports.config = { api: { bodyParser: false }, maxDuration: 30 };
