const { GoogleGenAI } = require("@google/genai");

// SEO alt-text patterns. Each TEMPLATE carries a `altPattern` — a single-line
// string with placeholders — generated once from the template scene. Per product
// the pattern is filled deterministically from the caption fields (no AI).
//
// Placeholders: {colour}, {adjective}, {material}, {fabric} (= adjective+material),
// {pattern} / {tags} (= tags joined by space).

const DEFAULT_ALT_PATTERN = "{colour} {fabric} Fabric with {pattern}";

const ALT_PATTERN_PROMPT = `You are creating an SEO ALT-TEXT PATTERN for ONE product-photography template used by a fabric store. Look at how the fabric is presented in this scene (e.g. flat / on a tray, swirled, folded, draped as a saree on a mannequin, etc.) and output ONE single-line alt-text pattern in the store's house style.

Use ONLY these placeholders, exactly as written: {colour} (the fabric's colour), {fabric} (the fabric type), {pattern} (the pattern/design). Do NOT add other placeholders and do NOT put any real colours/fabrics/values.

House-style patterns by presentation — pick the closest and adapt the wording to what you actually see:
- Flat / main / on a tray: {colour} {fabric} Fabric with {pattern}
- Swirled: Swirled {colour} {fabric} Fabric Showing {pattern} and Drape
- Folded: Folded {colour} {fabric} Fabric Highlighting {pattern} and Texture
- Draped as a saree (on a mannequin/model): {colour} {fabric} Fabric Draped as a Saree Showing Elegant Fall and Design

Output ONLY the single pattern line — no quotes, no explanation.`;

// One-time, best-effort: derive a template's alt-text pattern from its scene.
async function generateAltPattern({ imageBuffer, mimeType }) {
  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const result = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{
        role: "user",
        parts: [
          { inlineData: { mimeType: mimeType || "image/jpeg", data: imageBuffer.toString("base64") } },
          { text: ALT_PATTERN_PROMPT },
        ],
      }],
    });
    const textPart = result.candidates?.[0]?.content?.parts?.find(p => p.text);
    let pat = (textPart?.text || "").trim().replace(/^```.*?\n?|\n?```$/gs, "").trim();
    // Take the first non-empty line; must contain a placeholder to be usable.
    pat = pat.split("\n").map(s => s.trim()).find(Boolean) || "";
    if (!pat || !/\{[a-z]+\}/i.test(pat)) return DEFAULT_ALT_PATTERN;
    return pat.slice(0, 300);
  } catch (err) {
    console.error("Alt-pattern generation failed:", err);
    return DEFAULT_ALT_PATTERN;
  }
}

// Deterministically fill a pattern from the product's caption facts.
function fillAlt(pattern, { colour, adjective, material, tags } = {}) {
  if (!pattern) return "";
  const clean = s => (s == null ? "" : String(s)).trim();
  const fabric = [clean(adjective), clean(material)].filter(Boolean).join(" ");
  const pat = (Array.isArray(tags) ? tags.map(clean).filter(Boolean).join(" ") : clean(tags));
  const map = {
    colour: clean(colour), color: clean(colour),
    adjective: clean(adjective), material: clean(material),
    fabric, pattern: pat, tags: pat,
  };
  return pattern
    .replace(/\{(\w+)\}/g, (_, k) => (k.toLowerCase() in map ? map[k.toLowerCase()] : ""))
    .replace(/\s+/g, " ")
    .replace(/\s+([,.])/g, "$1")
    .trim();
}

module.exports = { generateAltPattern, fillAlt, DEFAULT_ALT_PATTERN };
