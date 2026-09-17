const { getJson, updateJson } = require("./storage");

// Per-user "active template" selection: which templates are active, and their order.
// The template catalog (manifest) is SHARED; only the active SET is per-user, so the
// owner can keep creative templates active for social media while staff keeps standard
// ones for the website — neither overrides the other.
const ACTIVE_KEY = "fs-active.json";
const MAX_ACTIVE = 5;

const asSets = data => (data && typeof data === "object" && !Array.isArray(data) ? data : {});

async function readActiveSets() {
  return asSets(await getJson(ACTIVE_KEY));
}

// Ordered active template ids for a user. Users (and unsigned requests) who haven't
// customized yet inherit the manifest's legacy shared active flags — the migration
// default — so nothing looks empty on first use.
async function getUserActive(user, manifest) {
  const legacy = () => manifest.filter(t => t.active).map(t => t.id).slice(0, MAX_ACTIVE);
  if (!user) return legacy();
  const sets = await readActiveSets();
  if (!Array.isArray(sets[user])) return legacy();
  const valid = new Set(manifest.map(t => t.id));
  return sets[user].filter(id => valid.has(id)).slice(0, MAX_ACTIVE);
}

async function setUserActive(user, ids, manifest) {
  const valid = new Set(manifest.map(t => t.id));
  const cleaned = [];
  for (const id of ids) if (valid.has(id) && !cleaned.includes(id)) cleaned.push(id);
  const mine = cleaned.slice(0, MAX_ACTIVE);
  // ETag-guarded: other users' sets saved at the same moment are kept.
  await updateJson(ACTIVE_KEY, raw => ({ ...asSets(raw), [user]: mine }));
  return mine;
}

// Drop a template id from every user's saved active set (used when a template is deleted).
async function removeFromAllActive(id) {
  await updateJson(ACTIVE_KEY, raw => {
    const sets = { ...asSets(raw) };
    let changed = false;
    for (const u of Object.keys(sets)) {
      if (!Array.isArray(sets[u])) continue;
      const next = sets[u].filter(x => x !== id);
      if (next.length !== sets[u].length) { sets[u] = next; changed = true; }
    }
    return changed ? sets : undefined;
  });
}

// Build the per-user templates response: the user's active templates first (in their
// chosen order, active:true), then the rest of the shared library (active:false).
function userTemplatesView(manifest, activeIds) {
  const activeSet = new Set(activeIds);
  const byId = new Map(manifest.map(t => [t.id, t]));
  const active = activeIds.map(id => byId.get(id)).filter(Boolean).map(t => ({ ...t, active: true }));
  const inactive = manifest.filter(t => !activeSet.has(t.id)).map(t => ({ ...t, active: false }));
  return [...active, ...inactive];
}

module.exports = { getUserActive, setUserActive, removeFromAllActive, userTemplatesView, MAX_ACTIVE };
