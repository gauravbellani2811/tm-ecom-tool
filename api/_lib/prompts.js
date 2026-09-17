// Fixed guard appended to every template prompt at generation time. It pins
// down the two image roles and explicitly forbids the common failure mode where
// the model keeps IMAGE 1's existing textile pattern and merely recolors it.
const FABRIC_TRANSFER_GUARD = `IMAGE ROLES (read carefully):
- IMAGE 1 = the SCENE TEMPLATE. Reproduce its composition, props, surface, background, lighting direction and quality, shadows, camera angle, and the exact way the textile is folded, rolled, or draped.
- IMAGE 2 = the SOURCE FABRIC. It is the ONLY source for the textile's surface design: its motifs, print style, weave, pattern scale, and colorway.

The textile visible in IMAGE 1 is a stand-in. Discard its pattern AND its colors completely. Re-skin that same draped textile so its surface shows the print from IMAGE 2, mapped naturally onto the folds with correct perspective, highlights, and shadows.

Do NOT keep IMAGE 1's original pattern and merely tint it toward IMAGE 2's colors — that is the wrong result. The motifs, print, and colors must all come from IMAGE 2.

Output a single photorealistic product photograph.`;

// Appended only when a close-up detail photo (IMAGE 3) is supplied. It tells the
// model the fabric is genuinely embroidered/textured — not a flat print — and to
// reproduce that raised, light-catching surface using the macro as ground truth.
const FABRIC_DETAIL_CLAUSE = `IMAGE 3 = a CLOSE-UP of the same fabric showing its TRUE surface: raised embroidery and threadwork, sheen, and weave dimensionality. This fabric is embroidered/textured, NOT a flat print. On the re-skinned textile, reproduce this real surface — the raised stitches, thread relief, light-catching sheen, and depth — so it reads as genuine embroidery rather than a printed motif. IMAGE 2 remains the source of the pattern, motifs, colour, and layout; IMAGE 3 refines only the material and surface texture.`;

function buildDefaultPrompt(description) {
  const sceneInstructions = description
    ? `The first image is the reference scene to recreate. For context, here is a detailed description of that scene: ${description}`
    : `The first image is the reference scene to recreate exactly — preserve every prop, surface, lighting cue, shadow, camera angle, and how the fabric is folded or draped.`;

  return `${sceneInstructions}

The second image shows a flat photo of a fabric pattern. Recreate the first scene as a photorealistic product photograph, but re-skin the draped textile with the pattern from the second image. Keep the fabric folded and positioned exactly as in the original scene; every other element (props, background, surface, lighting direction and quality, shadows, composition, camera angle) must remain identical to the first image.`;
}

// Wrap a scene-specific prompt (stored, edited, or freshly built) with the
// shared image-role guard. Applied in generate.js so all templates benefit.
// When a close-up detail photo is supplied, append the IMAGE 3 texture clause.
function composePrompt(scenePrompt, { hasDetail } = {}) {
  const base = `${scenePrompt}\n\n${FABRIC_TRANSFER_GUARD}`;
  return hasDetail ? `${base}\n\n${FABRIC_DETAIL_CLAUSE}` : base;
}

module.exports = { buildDefaultPrompt, composePrompt };
