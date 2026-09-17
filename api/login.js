const { isValidUsername, adminUsers, normUser } = require("./_lib/auth");

// Validates a username against the server allowlist (kept off the client).
function parseJsonBody(req) {
  if (req.body && typeof req.body === "object") return Promise.resolve(req.body);
  return new Promise((resolve) => {
    let data = "";
    req.on("data", c => { data += c; });
    req.on("end", () => { try { resolve(JSON.parse(data || "{}")); } catch { resolve({}); } });
    req.on("error", () => resolve({}));
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const body = await parseJsonBody(req);
  const username = normUser(body.username);
  if (!isValidUsername(username)) {
    return res.status(403).json({ error: "Unknown username. Ask the admin for access." });
  }
  const role = adminUsers().includes(username) ? "admin" : "staff";
  return res.json({ user: username, role });
};
