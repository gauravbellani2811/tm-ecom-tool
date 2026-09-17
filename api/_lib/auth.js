// Username gate + admin PIN. The username is identity only (no passwords);
// the ADMIN_PIN (server env) is the real gate for admin data.

function parseList(v, fallback) {
  return (v || fallback || "")
    .split(",")
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}

function allowedUsers() {
  return parseList(process.env.ALLOWED_USERS, "gaurav2811,bharatrm");
}
function adminUsers() {
  return parseList(process.env.ADMIN_USERS, "gaurav2811");
}

function normUser(name) {
  return (name || "").toString().trim().toLowerCase();
}

function isValidUsername(name) {
  return allowedUsers().includes(normUser(name));
}

// Identity from the request header (trust-based attribution).
function getUser(req) {
  const raw = normUser(req.headers["x-fs-user"]);
  if (!raw || !allowedUsers().includes(raw)) return { user: null, isAdmin: false, valid: false };
  return { user: raw, isAdmin: adminUsers().includes(raw), valid: true };
}

// Real gate for admin endpoints: must be an admin username AND present the PIN.
function requireAdmin(req) {
  const { user, isAdmin } = getUser(req);
  const expected = (process.env.ADMIN_PIN || "").toString();
  const pin = (req.headers["x-fs-admin-pin"] || "").toString();
  if (!isAdmin) return { ok: false, status: 403, error: "Not authorized" };
  if (!expected) return { ok: false, status: 403, error: "Admin PIN is not configured on the server (set ADMIN_PIN)." };
  if (pin !== expected) return { ok: false, status: 403, error: "Invalid admin PIN" };
  return { ok: true, user };
}

module.exports = { getUser, requireAdmin, isValidUsername, adminUsers, allowedUsers, normUser };
