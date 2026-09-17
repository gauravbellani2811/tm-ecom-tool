export function dataUrlToBlob(dataUrl) {
  const [meta, b64] = dataUrl.split(",");
  const mimeMatch = /:(.*?);/.exec(meta);
  const mime = mimeMatch ? mimeMatch[1] : "image/jpeg";
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}
