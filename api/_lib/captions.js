const { GoogleGenAI, Type } = require("@google/genai");
const { getJson, updateJson } = require("./storage");

// Caption settings live at a fixed R2 key (same pattern as the template manifest).
// The AI writes the CREATIVE parts (title, intro, key features); the app appends the
// FIXED sections (care instructions, details, lining link, sign-off) from these settings
// so they're byte-identical on every product. All fields are editable in Admin.
const SETTINGS_KEY = "fs-caption-settings.json";
const PROMPT_VERSION = 2; // bump when the creative-prompt contract changes

// The approved Shopify tag vocabulary. The AI may ONLY pick tags from this list;
// admin-editable (Captions tab). Colour + the team's manual tags are added on top.
const MASTER_TAGS = [
  "Abstract", "Ajrakh", "American Crepe", "Animal Print", "Art Silk", "Banaras", "Bandhini",
  "Batik", "Bead", "Bizzy Lizzy", "Block Print", "Border", "Brocade", "Butta", "Chanderi",
  "Checked", "Chiffon", "Chinnon", "Cotton", "Crepe", "Crochet", "Cutwork", "Denim", "Diamond",
  "Digital Print", "Dotted", "Embroidery", "Fabric", "Floral", "Foil", "Fur", "Georgette",
  "Hakoba", "Ikat", "Jacquard", "Jute", "Kalamkari", "Kids", "Lace", "Leaf", "Linen", "Lining",
  "Lurex", "Lycra", "Mirror Work", "Net", "Organza", "Paisley", "Plain", "Polka Dots", "Printed",
  "Rayon", "Satin", "Satin Georgette", "Semi Banaras", "Sequin", "Shibori", "Shimmer", "Silk",
  "Stone", "Stripes", "Thread Work", "Tie and Dye", "Tissue", "Tussar", "Two Toned", "Velvet",
  "Viscose", "Zari", "Gota",
];

// Normalize a whitelist input (array or newline/comma string) → clean, de-duped array.
function normalizeWhitelist(input) {
  let arr = [];
  if (Array.isArray(input)) arr = input;
  else if (typeof input === "string") arr = input.split(/[\n,]/);
  const seen = new Set(), out = [];
  for (const t of arr) {
    const v = (t == null ? "" : String(t)).trim();
    if (!v) continue;
    const k = v.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(v); }
  }
  return out;
}

// Creative-only instructions (title + 2-paragraph intro + key features). Must NOT
// mention care instructions, measurements, lining, or the sign-off — the app owns those.
const DEFAULT_CAPTION_INSTRUCTIONS = `You are writing e-commerce product copy for T.Mangharam, a fabric store, in its house style. Study the fabric photo and combine what you SEE with the provided facts.

TITLE: "{Colour} {Adjective} {Material} Fabric - {SKU}" (e.g. "Navy Vintage Satin Fabric - EA4363"). Use the given colour, adjective, and material in that exact order. SKIP any that are missing and keep the rest in the same order (e.g. if colour is missing: "{Adjective} {Material} Fabric - {SKU}"). Append " - {SKU}" only if an SKU is given. Title Case, short.

INTRO: two flowing paragraphs, each wrapped in <p>…</p> HTML tags:
- Paragraph 1: open with "Bring timeless elegance to your wardrobe with this <strong>{a descriptive product name}</strong>." Then describe the print/craft and the colour palette you ACTUALLY SEE in the image (motifs, colours, the base colour), note the fabric's finish, and close by saying it suits both contemporary and traditional fashion.
- Paragraph 2: begin "Ideal for crafting" and list suitable garments (dresses, gowns, kurtis, tops, skirts, sarees, kaftans, scarves, festive wear), then a closing line about the striking, premium look suitable for all occasions.
Base every visual detail on the image. Do NOT invent prices, care instructions, or measurements.

KEY FEATURES: 4-6 short bullet phrases tailored to THIS fabric and print — e.g. "Premium quality satin fabric", "Soft, smooth texture with a luxurious sheen", "Elegant vintage floral print", "Lightweight with a fluid drape", "Ideal for dresses, gowns, kurtis, tops, sarees and more". Vary them to fit the fabric type and design you see.

TAGS: 4-8 short tags — the colour(s), the craft/pattern, the fabric type, and the word "Fabric".

PRODUCT TYPE: "Fabric Lengths".`;

const DEFAULT_SETTINGS = {
  captionInstructions: DEFAULT_CAPTION_INSTRUCTIONS,
  careInstructions: "Gentle hand wash or dry clean recommended\nIron on low heat from the reverse side",
  measurement: '44"',
  liningLabel: "Lining Sold Separately",
  liningUrl: "https://tmangharam.com/collections/plain",
  disclaimer: "Please note: while we make every effort to display product colours as accurately as possible, actual colours may vary slightly due to differences in screen settings and lighting.",
  tagWhitelist: MASTER_TAGS,
  promptVersion: PROMPT_VERSION,
};

// Effective settings = saved fields merged over defaults.
function settingsFrom(saved) {
  saved = saved && typeof saved === "object" ? saved : {};

  // Merge saved fixed-section fields over defaults; the creative prompt is only
  // honored when it was saved under the current version (else use the new default).
  const s = { ...DEFAULT_SETTINGS };
  for (const k of ["careInstructions", "measurement", "liningLabel", "liningUrl", "disclaimer"]) {
    if (typeof saved[k] === "string" && saved[k].trim()) s[k] = saved[k];
  }
  if (saved.promptVersion === PROMPT_VERSION && typeof saved.captionInstructions === "string" && saved.captionInstructions.trim()) {
    s.captionInstructions = saved.captionInstructions;
  }
  const savedWl = normalizeWhitelist(saved.tagWhitelist);
  if (savedWl.length) s.tagWhitelist = savedWl;
  return s;
}

async function readCaptionSettings() {
  let saved = null;
  try { saved = await getJson(SETTINGS_KEY); } catch {}
  return settingsFrom(saved);
}

async function writeCaptionSettings(patch) {
  // ETag-guarded so two admins saving at once can't silently drop each other's edit.
  const { data } = await updateJson(SETTINGS_KEY, raw => {
    const next = { ...settingsFrom(raw) };
    for (const k of ["captionInstructions", "careInstructions", "measurement", "liningLabel", "liningUrl", "disclaimer"]) {
      if (patch && typeof patch[k] === "string") next[k] = patch[k];
    }
    if (patch && (Array.isArray(patch.tagWhitelist) || typeof patch.tagWhitelist === "string")) {
      const wl = normalizeWhitelist(patch.tagWhitelist);
      next.tagWhitelist = wl.length ? wl : MASTER_TAGS;
    }
    next.promptVersion = PROMPT_VERSION;
    return next;
  });
  return data;
}

function esc(s) {
  return (s == null ? "" : String(s)).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Assemble the final Shopify description HTML: AI creative parts + fixed sections.
function assembleDescription({ intro, keyFeatures, fabricType }, settings) {
  const s = { ...DEFAULT_SETTINGS, ...(settings || {}) };

  // intro is trusted LLM HTML; if it came back without <p>, wrap on blank lines.
  let introHtml = (intro || "").trim();
  if (introHtml && !/<p[\s>]/i.test(introHtml)) {
    introHtml = introHtml.split(/\n{2,}/).map(p => `<p>${esc(p.trim())}</p>`).join("\n");
  }

  const features = (Array.isArray(keyFeatures) ? keyFeatures : [])
    .map(f => (f || "").toString().trim()).filter(Boolean);
  const featuresHtml = features.length
    ? `<p><strong>Key Features:</strong></p>\n<ul>\n${features.map(f => `<li>${esc(f)}</li>`).join("\n")}\n</ul>`
    : "";

  const careLines = (s.careInstructions || "").split("\n").map(l => l.trim()).filter(Boolean);
  const careHtml = careLines.length
    ? `<p><strong>Care Instructions:</strong></p>\n<ul>\n${careLines.map(l => `<li>${esc(l)}</li>`).join("\n")}\n</ul>`
    : "";

  const detailsHtml = `<p><strong>Approximate Measurement:</strong> ${esc(s.measurement)}<br>\n<strong>Fabric:</strong> ${esc(fabricType || "")}<br>\n<strong>Type:</strong> Fabric</p>`;

  const liningHtml = (s.liningLabel && s.liningUrl)
    ? `<p><a href="${esc(s.liningUrl)}" style="color:#0000EE; text-decoration:underline;"><strong style="color:#0000EE;">${esc(s.liningLabel)}</strong></a></p>`
    : "";

  const disclaimerHtml = s.disclaimer ? `<p><em>${esc(s.disclaimer)}</em></p>` : "";

  return [introHtml, featuresHtml, careHtml, detailsHtml, liningHtml, disclaimerHtml]
    .filter(Boolean).join("\n\n");
}

// Build the title deterministically from the PROVIDED facts (not what the model
// sees), so it's always "{Colour} {Adjective} {Material} Fabric - {SKU}" with any
// missing part skipped in order. Returns "" if no colour/adjective/material given.
function buildTitle({ colour, adjective, fabricType, sku }) {
  const tc = s => s.trim().replace(/\s+/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  const parts = [colour, adjective, fabricType].map(x => (x || "").trim()).filter(Boolean).map(tc);
  if (!parts.length) return "";
  let t = parts.join(" ") + " Fabric";
  if (sku && sku.trim()) t += " - " + sku.trim();
  return t;
}

// The approved-list constraint is enforced two ways that don't depend on schema
// enum support: the prompt lists the exact approved spellings, and enforceTags()
// hard-filters the result. So the schema keeps tags as plain strings (safe across
// all Gemini versions — an unsupported enum would fail the whole caption call).
const CAPTION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    title: { type: Type.STRING },
    intro: { type: Type.STRING },
    keyFeatures: { type: Type.ARRAY, items: { type: Type.STRING } },
    tags: { type: Type.ARRAY, items: { type: Type.STRING } },
    productType: { type: Type.STRING },
  },
  required: ["title", "intro", "keyFeatures", "tags", "productType"],
};

function titleCase(s) {
  return (s == null ? "" : String(s)).trim().replace(/\s+/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

// Optimal string alignment (Damerau-Levenshtein with adjacent transpositions) — used
// for conservative typo matching so a single slip like "embordery" maps to "Embroidery".
function osa(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const d = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[m][n];
}

// Assemble the final product tags from the AI's picks + the user's deterministic rules.
// - Fabric always; colour (Title-cased); every manual tag; Embroidery when the title says so.
// - Manual & AI tags are matched to the approved list by exact/plural/partial/1-2 char typo
//   (matchApproved). Manual tags with no confident match are KEPT as typed; AI tags with no
//   match are DROPPED. Case-insensitive de-dupe; no cap.
function enforceTags({ aiTags, colour, manualTags, title, whitelist }) {
  const list = (whitelist && whitelist.length) ? whitelist : MASTER_TAGS;
  const cands = list.map(t => ({ tag: t, low: t.toLowerCase() }));
  const canonMap = new Map(cands.map(c => [c.low, c.tag]));
  const deplural = s => s.replace(/s$/, "");

  // Best confident approved tag for a raw value, or null. Order: exact → singular/plural
  // → whole-word/prefix (unique) → small typo distance (unique). Conservative: ambiguous
  // or distant inputs return null so unrelated words (e.g. a colour) aren't mis-mapped.
  function matchApproved(v) {
    const q = (v == null ? "" : String(v)).trim().toLowerCase();
    if (!q) return null;
    if (canonMap.has(q)) return canonMap.get(q);
    let m = cands.filter(c => deplural(c.low) === deplural(q));
    if (m.length === 1) return m[0].tag;
    m = cands.filter(c => c.low.startsWith(q + " ") || c.low.split(" ").indexOf(q) !== -1);
    if (m.length === 1) return m[0].tag;
    let best = null, bestD = Infinity, tie = false;
    for (const c of cands) {
      const thr = Math.max(q.length, c.low.length) >= 8 ? 2 : 1;
      const dd = osa(q, c.low);
      if (dd <= thr) {
        if (dd < bestD) { bestD = dd; best = c.tag; tie = false; }
        else if (dd === bestD) tie = true;
      }
    }
    return (best && !tie) ? best : null;
  }

  const seen = new Set(), out = [];
  const add = v => {
    const t = (v == null ? "" : String(v)).trim();
    if (!t) return;
    const k = t.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(t); }
  };

  add(canonMap.get("fabric") || "Fabric");                     // rule 1
  if (colour && String(colour).trim()) add(titleCase(colour)); // rule 2 (colours aren't on the list)
  for (const mt of (manualTags || [])) add(matchApproved(mt) || titleCase(mt)); // rule 3 (correct, else keep)
  if (/embroider/i.test(title || "")) add(canonMap.get("embroidery") || "Embroidery"); // rule 4
  for (const at of (aiTags || [])) { const a = matchApproved(at); if (a) add(a); }     // rules 5-7 (correct, else drop)

  return out;
}

// Generate one product caption from the fabric image + facts. Best-effort:
// returns null on any failure so it never breaks image generation.
async function generateCaption({ imageBuffer, mimeType, sku, fabricType, colour, adjective, tags, settings }) {
  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const s = { ...DEFAULT_SETTINGS, ...(settings || {}) };
    const facts = [
      sku ? `SKU: ${sku}` : null,
      colour ? `Colour: ${colour}` : null,
      adjective ? `Adjective: ${adjective}` : null,
      fabricType ? `Material (fabric type): ${fabricType}` : null,
      (tags && tags.length) ? `Extra tags / craft: ${tags.join(", ")}` : null,
    ].filter(Boolean).join("\n");

    const whitelist = (Array.isArray(s.tagWhitelist) && s.tagWhitelist.length) ? s.tagWhitelist : MASTER_TAGS;
    const tagsDirective =
      `\n\nAPPROVED TAGS — for the "tags" field ONLY, ignore any earlier tag instruction and follow this exactly: ` +
      `pick tags strictly from the approved list below, using their exact spelling, and NOTHING else. There is no limit — ` +
      `include EVERY tag that accurately applies. Identify the fabric type; if the fabric is printed, include each print ` +
      `pattern you can see; if it is embroidered, include "Embroidery" PLUS each distinct embroidery technique present ` +
      `(e.g. Thread Work, Sequin, Stone) as SEPARATE tags — never merge them. Do NOT output the colour, SKU, or adjective ` +
      `as tags (the app adds those automatically). Approved list: ${whitelist.join(", ")}.`;

    const prompt = `${s.captionInstructions || DEFAULT_CAPTION_INSTRUCTIONS}\n\nProduct facts:\n${facts || "(none provided)"}${tagsDirective}\n\nReturn ONLY the JSON object.`;

    const result = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{
        role: "user",
        parts: [
          { inlineData: { mimeType: mimeType || "image/jpeg", data: imageBuffer.toString("base64") } },
          { text: prompt },
        ],
      }],
      config: { responseMimeType: "application/json", responseSchema: CAPTION_SCHEMA },
    });

    const textPart = result.candidates?.[0]?.content?.parts?.find(p => p.text);
    let raw = (textPart?.text || "").trim();
    if (!raw) return null;
    raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    const obj = JSON.parse(raw);
    const aiTitle = (obj.title || "").toString().trim();
    const intro = (obj.intro || "").toString().trim();
    if (!aiTitle && !intro) return null;
    // Deterministic title from the provided facts; fall back to the AI title only
    // when no colour/adjective/material were given.
    const title = buildTitle({ colour, adjective, fabricType, sku }) || aiTitle;
    const description = assembleDescription({ intro, keyFeatures: obj.keyFeatures, fabricType }, s);
    return {
      title,
      description,
      tags: enforceTags({
        aiTags: Array.isArray(obj.tags) ? obj.tags : [],
        colour, manualTags: tags, title, whitelist,
      }),
      productType: (obj.productType || "").toString().trim(),
    };
  } catch (err) {
    console.error("Caption generation failed:", err);
    return null;
  }
}

module.exports = {
  readCaptionSettings, writeCaptionSettings, generateCaption, assembleDescription, buildTitle,
  enforceTags, MASTER_TAGS,
  DEFAULT_CAPTION_INSTRUCTIONS, DEFAULT_SETTINGS, PROMPT_VERSION,
};
