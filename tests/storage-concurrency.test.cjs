// Shared JSON files must never lose a change when many saves happen at once.
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { installFakeR2 } = require("./helpers/fakeR2.cjs");

const root = path.join(__dirname, "..");
const fake = installFakeR2(root);
const history = require(path.join(root, "api/_lib/history.js"));
const waitlist = require(path.join(root, "api/_lib/waitlist.js"));
const audit = require(path.join(root, "api/_lib/audit.js"));
const manifest = require(path.join(root, "api/_lib/manifest.js"));
const active = require(path.join(root, "api/_lib/active.js"));

const RUN = "r_test";
const now = () => new Date().toISOString();
const img = i => ({ id: "i" + i, templateId: "tpl" + i, templateLabel: "T" + i, url: `https://pub.example.r2.dev/fs-history/${RUN}-${i}.jpg` });
// Pad the file past 1 KB so the fake answers with weak ETags, like real R2 does
// for the multi-MB history file.
const padding = Array.from({ length: 40 }, (_, i) => ({ id: "old" + i, createdAt: now(), fabricName: "PAD".repeat(20), user: "bharatrm", images: [] }));

test("simultaneous History saves all land (weak ETags from large files)", async () => {
  fake.seed("fs-history.json", [{ id: RUN, createdAt: now(), fabricName: "EC1", user: "gaurav2811", images: [] }, ...padding]);
  const N = 30;
  await Promise.all(Array.from({ length: N }, (_, i) =>
    history.appendRun({ runId: RUN, fabricName: "EC1", user: "gaurav2811", images: [img(i)] })));
  const run = fake.read("fs-history.json").find(r => r.id === RUN);
  assert.strictEqual(run.images.length, N);
  assert.ok(fake.counters.conflicts > 0, "test should actually have produced conflicts");
});

test("a retried image replaces the old one for the same template", async () => {
  fake.seed("fs-history.json", [{ id: RUN, createdAt: now(), fabricName: "EC1", user: "gaurav2811", images: [img(1)] }]);
  await history.appendRun({ runId: RUN, images: [{ ...img(1), url: "https://pub.example.r2.dev/fs-history/new.jpg" }] });
  const run = fake.read("fs-history.json").find(r => r.id === RUN);
  assert.strictEqual(run.images.length, 1);
  assert.match(run.images[0].url, /new\.jpg$/);
});

test("an unreadable History file is never overwritten", async () => {
  fake.store.set("fs-history.json", { body: "{not json", etag: '"x"' });
  await assert.rejects(history.appendRun({ runId: "x", images: [img(9)] }));
  assert.strictEqual(fake.store.get("fs-history.json").body, "{not json");
});

test("waitlist adds, audit appends, templates and active sets don't lose updates", async () => {
  await Promise.all(Array.from({ length: 20 }, (_, i) =>
    waitlist.addItem("bharatrm", { id: "w" + i, url: `https://pub.example.r2.dev/waitlist/bharatrm/${i}.jpg`, name: "S" + i, createdAt: now() })));
  assert.strictEqual(fake.read("waitlist/bharatrm.json").length, 20);

  await Promise.all(Array.from({ length: 20 }, (_, i) => audit.appendEvents([{ id: "e" + i, ts: now(), action: "generate" }])));
  assert.strictEqual(fake.read("fs-audit.json").length, 20);

  await Promise.all(Array.from({ length: 15 }, (_, i) =>
    manifest.updateManifest(m => [...m, { id: "t" + i, url: "u", label: "L" + i, active: false }])));
  const m = fake.read("fs-manifest.json");
  assert.strictEqual(m.length, 15);

  await Promise.all(Array.from({ length: 15 }, (_, i) => active.setUserActive("user" + i, ["t" + i], m)));
  assert.strictEqual(Object.keys(fake.read("fs-active.json")).length, 15);
});
