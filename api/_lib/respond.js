const zlib = require("zlib");

// JSON response, gzip-compressed when the client accepts it. Vercel meters
// Fast Origin Transfer on the bytes the function sends, so large payloads
// (History is several MB of JSON) are compressed here rather than at the CDN.
function sendJson(req, res, data) {
  const body = Buffer.from(JSON.stringify(data));
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Vary", "Accept-Encoding");
  const accepts = /\bgzip\b/.test(String(req.headers["accept-encoding"] || ""));
  if (accepts && body.length > 1024) {
    const gz = zlib.gzipSync(body, { level: 6 });
    res.setHeader("Content-Encoding", "gzip");
    res.setHeader("Content-Length", gz.length);
    return res.end(gz);
  }
  res.setHeader("Content-Length", body.length);
  return res.end(body);
}

module.exports = { sendJson };
