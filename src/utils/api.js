const USER_KEY = "fs_user";
const ROLE_KEY = "fs_role";

let adminPin = null; // kept in memory only, never persisted

export function getAuth() {
  const user = localStorage.getItem(USER_KEY);
  if (!user) return null;
  return { user, role: localStorage.getItem(ROLE_KEY) || "staff" };
}

export function setAuth(user, role) {
  if (user) {
    localStorage.setItem(USER_KEY, user);
    localStorage.setItem(ROLE_KEY, role || "staff");
  } else {
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(ROLE_KEY);
    adminPin = null;
  }
}

export function setAdminPin(pin) { adminPin = pin; }
export function hasAdminPin() { return !!adminPin; }

// fetch wrapper that attaches the identity header (and admin PIN when opts.admin).
// Works transparently with FormData bodies (no content-type override).
export function apiFetch(path, opts = {}) {
  const headers = new Headers(opts.headers || {});
  const auth = getAuth();
  if (auth) headers.set("x-fs-user", auth.user);
  if (opts.admin && adminPin) headers.set("x-fs-admin-pin", adminPin);
  return fetch(path, { ...opts, headers });
}
