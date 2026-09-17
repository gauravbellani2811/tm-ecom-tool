// In-memory stand-in for Cloudflare R2, installed in place of aws4fetch's AwsClient.
// Mirrors the real behaviours the storage code depends on:
//  - GET returns an ETag; bodies over 1 KB come back with a WEAK ETag (W/"…"),
//    as Cloudflare does when it compresses a response.
//  - PUT honours If-Match (strong comparison only — a weak tag never matches)
//    and If-None-Match: *, answering 412 PreconditionFailed otherwise.
//  - Random latency, so concurrent requests overlap.
const path = require("path");

function installFakeR2(root) {
  process.env.R2_ACCOUNT_ID = "acct";
  process.env.R2_BUCKET = "bucket";
  process.env.R2_PUBLIC_BASE = "https://pub.example.r2.dev";

  const store = new Map(); // key -> { body, etag }
  const counters = { conflicts: 0 };
  let seq = 0;
  const latency = () => new Promise(r => setTimeout(r, Math.random() * 15));
  const response = (status, body = "", headers = {}) =>
    new Response(status === 204 ? null : body, { status, headers });

  class FakeAwsClient {
    async fetch(url, opts = {}) {
      await latency();
      const key = decodeURI(new URL(url).pathname.replace(/^\/bucket\//, ""));
      const method = opts.method || "GET";
      const h = opts.headers || {};
      const obj = store.get(key);
      if (method === "GET") {
        await latency();
        if (!obj) return response(404);
        const etag = obj.body.length > 1024 ? `W/${obj.etag}` : obj.etag;
        return response(200, obj.body, { etag });
      }
      if (method === "PUT") {
        const ifMatch = h["If-Match"];
        if (ifMatch !== undefined && (!obj || ifMatch !== obj.etag)) { counters.conflicts++; return response(412); }
        if (h["If-None-Match"] === "*" && obj) { counters.conflicts++; return response(412); }
        store.set(key, { body: String(opts.body), etag: `"${++seq}"` });
        return response(200, "", { etag: `"${seq}"` });
      }
      if (method === "DELETE") { store.delete(key); return response(204); }
      return response(400);
    }
  }

  const awsPath = require.resolve("aws4fetch", { paths: [root] });
  require.cache[awsPath] = { id: awsPath, filename: awsPath, loaded: true, exports: { AwsClient: FakeAwsClient } };
  // Make sure storage-dependent modules pick up the fake on next require.
  for (const k of Object.keys(require.cache)) if (k.startsWith(path.join(root, "api"))) delete require.cache[k];

  return {
    store,
    counters,
    seed(key, value) { store.set(key, { body: JSON.stringify(value), etag: `"${++seq}"` }); },
    read(key) { const o = store.get(key); return o ? JSON.parse(o.body) : null; },
  };
}

module.exports = { installFakeR2 };
