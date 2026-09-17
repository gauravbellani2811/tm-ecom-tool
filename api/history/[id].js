const { updateHistory, visibleForUser } = require("../_lib/history");
const { getUser, adminUsers, requireAdmin } = require("../_lib/auth");
const { sendJson } = require("../_lib/respond");
const { imageBlobUrls } = require("../_lib/thumbs");

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// Delete one run. Without `?scope=all` everyone (admin included) may only delete
// their own runs; the combined view (`?scope=all`, admin + PIN) may delete any run.
module.exports = async function handler(req, res) {
  const { id } = req.query;
  const { user, isAdmin } = getUser(req);
  const legacyOwner = adminUsers()[0];
  const all = req.query.scope === "all";

  if (all) {
    const auth = requireAdmin(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  }

  if (req.method === "DELETE") {
    try {
      // Checked against the freshly read file inside the (ETag-guarded) update.
      const records = await updateHistory(current => {
        const rec = current.find(r => r.id === id);
        if (!rec) throw httpError(404, "Record not found");
        if (!all && (rec.user || legacyOwner) !== user) throw httpError(403, "Not your record");

        // admin: hard delete (record + blobs); staff: soft hide, kept for the admin audit
        if (isAdmin) return { records: current.filter(r => r.id !== id), deleteUrls: (rec.images || []).flatMap(imageBlobUrls) };
        return { records: current.map(r => (r.id === id ? { ...r, hidden: true } : r)) };
      });
      return sendJson(req, res, visibleForUser(records, user, isAdmin, legacyOwner, { all }));
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }
  }

  res.status(405).json({ error: "Method not allowed" });
};

module.exports.config = { maxDuration: 30 };
