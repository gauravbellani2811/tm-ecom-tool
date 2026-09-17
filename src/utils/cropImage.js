// Mild unsharp-mask sharpen in place on a canvas (amount ~0.3–0.5 = subtle).
function sharpenCanvas(ctx, w, h, amount) {
  let src;
  try { src = ctx.getImageData(0, 0, w, h); } catch { return; }
  const dst = ctx.createImageData(w, h);
  const s = src.data, d = dst.data;
  const center = 1 + 4 * amount, rowBytes = w * 4;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const idx = i + c;
        const up = y > 0 ? s[idx - rowBytes] : s[idx];
        const down = y < h - 1 ? s[idx + rowBytes] : s[idx];
        const left = x > 0 ? s[idx - 4] : s[idx];
        const right = x < w - 1 ? s[idx + 4] : s[idx];
        const v = center * s[idx] - amount * (up + down + left + right);
        d[idx] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
      d[i + 3] = s[i + 3];
    }
  }
  ctx.putImageData(dst, 0, 0);
}

// Center-crop an image File to a square JPEG File (no AI — exact pixels).
// The flat swatch is lightly enhanced: +10% brightness and a mild sharpen.
export async function cropToSquare(file, size = 1400, quality = 0.9) {
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("Could not read image"));
      i.src = objectUrl;
    });

    const side = Math.min(img.width, img.height);
    const sx = Math.round((img.width - side) / 2);
    const sy = Math.round((img.height - side) / 2);
    const out = Math.min(size, side);

    const canvas = document.createElement("canvas");
    canvas.width = out;
    canvas.height = out;
    const ctx = canvas.getContext("2d");
    // +10% brightness (GPU filter, graceful no-op if unsupported)
    try { ctx.filter = "brightness(1.1)"; } catch {}
    ctx.drawImage(img, sx, sy, side, side, 0, 0, out, out);
    ctx.filter = "none";
    // subtle sharpen
    sharpenCanvas(ctx, out, out, 0.4);

    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", quality));
    if (!blob) throw new Error("Could not crop image");

    const base = (file.name || "fabric").replace(/\.[^.]+$/, "");
    return new File([blob], `${base}-flat.jpg`, { type: "image/jpeg" });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

// Crop a loaded <img> with an optional tilt/rotation baked in.
// `crop` = { x, y, width, height } in DISPLAYED pixels (react-image-crop completedCrop),
// `rotateDeg` rotates the image around its centre before cropping.
export async function cropRotatedToBlob(image, crop, rotateDeg = 0, quality = 0.92) {
  const scaleX = image.naturalWidth / image.width;
  const scaleY = image.naturalHeight / image.height;

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(crop.width * scaleX));
  canvas.height = Math.max(1, Math.floor(crop.height * scaleY));
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";

  // White backdrop so any corners exposed by the tilt aren't black.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const cropX = crop.x * scaleX;
  const cropY = crop.y * scaleY;
  const rotateRads = (rotateDeg * Math.PI) / 180;
  const centerX = image.naturalWidth / 2;
  const centerY = image.naturalHeight / 2;

  ctx.save();
  ctx.translate(-cropX, -cropY);
  ctx.translate(centerX, centerY);
  ctx.rotate(rotateRads);
  ctx.translate(-centerX, -centerY);
  ctx.drawImage(image, 0, 0, image.naturalWidth, image.naturalHeight);
  ctx.restore();

  return await new Promise((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error("Could not crop image"))), "image/jpeg", quality)
  );
}

// Rotate an image source 90° (dir: "cw" | "ccw") at full resolution and return a
// new object URL. Used by the fabric cropper's rotate buttons — baking the turn into
// the image keeps react-image-crop's crop box aligned (a CSS rotate would not).
export async function rotateImage90(src, dir = "cw") {
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error("Could not read image"));
    i.src = src;
  });
  const w = img.naturalWidth, h = img.naturalHeight;
  const canvas = document.createElement("canvas");
  canvas.width = h;   // dimensions swap on a quarter turn
  canvas.height = w;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  if (dir === "ccw") {
    ctx.translate(0, w);
    ctx.rotate(-Math.PI / 2);
  } else {
    ctx.translate(h, 0);
    ctx.rotate(Math.PI / 2);
  }
  ctx.drawImage(img, 0, 0);
  const blob = await new Promise((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error("Could not rotate image"))), "image/jpeg", 0.95)
  );
  return URL.createObjectURL(blob);
}

// Crop a loaded <img> element to a pixel rectangle (used by the template cropper).
// `cropPx` = { x, y, width, height } in natural-pixel coordinates.
export async function cropToBlob(imageEl, cropPx, quality = 0.92) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(cropPx.width);
  canvas.height = Math.round(cropPx.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(
    imageEl,
    cropPx.x, cropPx.y, cropPx.width, cropPx.height,
    0, 0, cropPx.width, cropPx.height
  );
  return await new Promise((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error("Could not crop image"))), "image/jpeg", quality)
  );
}
