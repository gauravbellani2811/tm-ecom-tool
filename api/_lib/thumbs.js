// sharp is loaded lazily so modules that only need imageBlobUrls stay light.
let sharp;
const { putImage, getObjectBuffer, urlToKey } = require("./storage");

// Small preview images for History / export grids. Grid tiles are ~150 CSS px,
// so 320 px on the short side stays sharp on 2× screens at ~10 KB instead of
// the ~500 KB full image. Full size is still used to enlarge, download, export.
const THUMB_PX = 320;

function thumbKeyFor(key) {
  return key.replace(/\.jpg$/i, "") + ".thumb.jpg";
}

async function makeThumb(buffer) {
  sharp = sharp || require("sharp");
  return sharp(buffer)
    .rotate()
    .resize(THUMB_PX, THUMB_PX, { fit: "outside", withoutEnlargement: true })
    .jpeg({ quality: 72, mozjpeg: true })
    .toBuffer();
}

// Returns the image with a `thumb` URL added. Best-effort: on failure the image
// is returned unchanged and the UI falls back to the full-size url.
async function withThumb(image, buffer) {
  try {
    const key = urlToKey(image.url);
    if (!key) return image;
    const buf = buffer || await getObjectBuffer(key);
    const thumb = await putImage(thumbKeyFor(key), await makeThumb(buf));
    return { ...image, thumb };
  } catch (e) {
    console.error("Thumbnail failed:", image.url, e.message);
    return image;
  }
}

// Every stored blob belonging to a history image (for deletes and pruning).
function imageBlobUrls(im) {
  return [im && im.url, im && im.thumb].filter(Boolean);
}

module.exports = { withThumb, imageBlobUrls, thumbKeyFor };
