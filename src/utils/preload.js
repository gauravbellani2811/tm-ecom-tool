// Resolve once an image URL has been downloaded (so showing it is instant), or
// after `timeoutMs` / on error — a slow or failed preload never blocks the flow.
export function preloadImage(src, timeoutMs = 90000) {
  if (!src || src.startsWith("data:") || src.startsWith("blob:")) return Promise.resolve();
  return new Promise(resolve => {
    const img = new Image();
    const timer = setTimeout(resolve, timeoutMs);
    const done = () => { clearTimeout(timer); resolve(); };
    img.onload = done;
    img.onerror = done;
    img.src = src;
  });
}
