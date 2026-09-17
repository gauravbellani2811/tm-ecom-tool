const { deleteKeys, urlToKey } = require("../_lib/storage");
const { updateManifest } = require("../_lib/manifest");

const notFound = () => Object.assign(new Error("Template not found"), { status: 404 });
const { getUser } = require("../_lib/auth");
const { getUserActive, setUserActive, removeFromAllActive, userTemplatesView, MAX_ACTIVE } = require("../_lib/active");

async function parseJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  return await new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => { data += chunk; });
    req.on("end", () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

module.exports = async function handler(req, res) {
  const { id } = req.query;

  if (req.method === "DELETE") {
    const { user } = getUser(req);
    try {
      let removed = null;
      const manifest = await updateManifest(current => {
        removed = current.find(t => t.id === id);
        if (!removed) throw notFound();
        return current.filter(t => t.id !== id);
      });
      try { await deleteKeys([urlToKey(removed.url)]); } catch {}
      // Drop it from every user's active set (the library entry is shared).
      await removeFromAllActive(id);
      const activeIds = await getUserActive(user, manifest);
      return res.json(userTemplatesView(manifest, activeIds));
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }
  }

  if (req.method === "PATCH") {
    try {
      const body = await parseJsonBody(req);
      const { user } = getUser(req);
      // Content edits (label/prompt/description) are SHARED across users.
      const updates = {};
      if (typeof body.label === "string" && body.label.trim()) updates.label = body.label.trim();
      if (typeof body.prompt === "string") updates.prompt = body.prompt;
      if (typeof body.description === "string") updates.description = body.description;
      if (typeof body.altPattern === "string") updates.altPattern = body.altPattern;
      const manifest = await updateManifest(current => {
        if (!current.some(t => t.id === id)) throw notFound();
        if (!Object.keys(updates).length) return undefined;
        return current.map(t => (t.id === id ? { ...t, ...updates } : t));
      });

      // Active membership is PER-USER.
      let activeIds = await getUserActive(user, manifest);
      if (typeof body.active === "boolean") {
        if (!user) return res.status(401).json({ error: "Not signed in" });
        if (body.active) {
          if (!activeIds.includes(id)) {
            if (activeIds.length >= MAX_ACTIVE) {
              return res.status(400).json({ error: `Maximum ${MAX_ACTIVE} templates can be active at once. Deactivate one first.` });
            }
            activeIds = await setUserActive(user, [...activeIds, id], manifest);
          }
        } else {
          activeIds = await setUserActive(user, activeIds.filter(x => x !== id), manifest);
        }
      }

      return res.json(userTemplatesView(manifest, activeIds));
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }
  }

  res.status(405).json({ error: "Method not allowed" });
};

module.exports.config = { maxDuration: 30 };
