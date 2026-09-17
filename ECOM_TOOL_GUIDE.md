# Ecom Tool — Complete Guide

The internal product-photography, captioning and catalogue tool for **T. Mangharam** (fabric store).
Live at **https://tmphotography.vercel.app**

This document describes everything about the system as it is currently deployed: what it does, every screen and button, how data flows, where it's hosted and stored, how changes are developed, tested on staging and released, how saves are kept safe, the AI prompts, the Shopify export format, the Google Sheets automations, the design system, limits, costs, known gaps, and how to operate it.

*Last updated: 17 September 2026.*

> Supersedes `PROJECT_OVERVIEW.txt`, which predates the move to Cloudflare R2, per-user templates, captions, Waitlist, History tools, Admin dashboard and Shopify export.

---

## Contents

1. [What the tool is for](#1-what-the-tool-is-for)
2. [Who uses it and how work flows](#2-who-uses-it-and-how-work-flows)
3. [Architecture at a glance](#3-architecture-at-a-glance)
4. [Hosting, environments & releases](#4-hosting-environments--releases)
5. [Storage & safe saving (Cloudflare R2)](#5-storage--safe-saving-cloudflare-r2)
6. [Environment variables](#6-environment-variables)
7. [Sign-in, identity & roles](#7-sign-in-identity--roles)
8. [AI models, prompts & costs](#8-ai-models-prompts--costs)
9. [The home screen, feature by feature](#9-the-home-screen-feature-by-feature)
10. [How a generation run works](#10-how-a-generation-run-works)
11. [Captions, titles, tags & alt text](#11-captions-titles-tags--alt-text)
12. [Retrying images (single, ×3, Pro)](#12-retrying-images-single-3-pro)
13. [Waitlist](#13-waitlist)
14. [History](#14-history)
15. [Shopify CSV export](#15-shopify-csv-export)
16. [Admin dashboard](#16-admin-dashboard)
17. [Google Sheets & Apps Script automations](#17-google-sheets--apps-script-automations)
18. [Downloads & file naming](#18-downloads--file-naming)
19. [Data models](#19-data-models)
20. [API reference](#20-api-reference)
21. [Design system](#21-design-system)
22. [Performance & caching](#22-performance--caching)
23. [Limits & retention](#23-limits--retention)
24. [Known limitations & risks](#24-known-limitations--risks)
25. [Operations runbook](#25-operations-runbook)
26. [Troubleshooting](#26-troubleshooting)
27. [File map](#27-file-map)
28. [Feature history](#28-feature-history)

---

## 1. What the tool is for

Getting a fabric onto the website used to mean staging photoshoots, writing copy and hand-building a Shopify import file. The tool automates that pipeline:

1. **Photograph** a fabric flat (on the shop floor, from a phone).
2. **Generate** photorealistic product shots by re-skinning the textile in saved *template scenes* (tray, swirl, folds, saree drape …) using Google Gemini.
3. **Caption** it automatically — Shopify title, HTML description, approved tags, product type and per-image SEO alt text.
4. **Review** results, retry weak images, compare and choose.
5. **Export** a ready-to-import Shopify product CSV, including colour-variant grouping.
6. **Track** daily operations (orders, returns, uploads) via a checkout form that feeds a Google Sheet and a weekly emailed report.

It is also used for social-media imagery, where products are generated without caption details and captioning is skipped.

Volume: roughly 300–400 products a month.

---

## 2. Who uses it and how work flows

| Username | Role | Typical use |
|---|---|---|
| `gaurav2811` | **admin** (owner) | Everything, plus the Admin dashboard (and, through it, every user's History) |
| `bharatrm` | **staff** | Generating products, captions, exports |

The usernames are an allowlist, not accounts (see §7).

**The two-building workflow**

```
Shop floor (building A)                     Ecom desk (building B)
───────────────────────                     ──────────────────────
Floor manager on a phone                    Ecom manager on a laptop
  │                                           │
  ├─ Photographs fabric                       │
  ├─ Waitlist → upload photo                  │
  ├─ Types SKU, colour, material, tags        │
  └─ Adds close-up detail photo (optional) ──►├─ Waitlist → Add to queue
                                              ├─ Generate
                                              ├─ Review / retry / compare
                                              ├─ Shopify CSV → group & price → download
                                              └─ Import into Shopify (as draft)

End of day: Daily Checkout Sheet form → Google Sheet → weekly email every Monday
```

---

## 3. Architecture at a glance

```
                 ┌────────────────────────────────────────────┐
 Browser         │  React 18 single-page app (Vite build)     │
 (laptop/phone)  │  + static public/daily-checkout.html       │
                 └───────────────┬────────────────────────────┘
                                 │  fetch  /api/*   (x-fs-user header)
                 ┌───────────────▼────────────────────────────┐
 Vercel          │  12 Node.js serverless functions (api/)    │
                 └──┬───────────────┬──────────────────┬──────┘
                    │               │                  │
        S3 API (aws4fetch)   @google/genai SDK   HTTPS POST (webhook)
                    │               │                  │
          ┌─────────▼──────┐ ┌──────▼────────┐ ┌──────▼────────────────┐
          │ Cloudflare R2  │ │ Google Gemini │ │ Google Apps Script     │
          │ JSON state +   │ │ image + text  │ │ → Captions Google Sheet│
          │ all images     │ │ models        │ └───────────────────────┘
          └────────────────┘ └───────────────┘

 Separately:  daily-checkout.html ──POST──► Apps Script doPost ──► "Ecom Tracker" sheet
              Weekly Report Apps Script (time trigger) ──► reads sheet ──► Gemini ──► email
```

| Layer | Technology |
|---|---|
| Frontend | React 18.2, Vite 5, `react-image-crop` 11, `jszip` 3 |
| Backend | Vercel serverless functions, CommonJS Node, `multer` (multipart), `uuid`, `sharp` (thumbnails) |
| AI | `@google/genai` — Gemini image and text models |
| Storage | Cloudflare R2 via `aws4fetch` (S3-compatible signing). **No database.** Two buckets: live and staging |
| Sheets | Google Apps Script web apps (no Google Cloud project or service account) |
| Code & releases | Git, private GitHub repo `gauravbellani2811/tm-ecom-tool`, Vercel Git integration |
| Tests | Node's built-in test runner (`npm test`) with an in-memory fake R2 |

**How code reaches the site**

```
 Laptop (fabric-styler/)          GitHub (private)              Vercel
 ───────────────────────          ────────────────              ──────
 edit → npm test → commit
   │
   ├─ git push <branch> ────────► branch  ─────────────────────► Preview build
   │                                                              tmphotography-git-<branch>-….vercel.app
   │                                                              uses the STAGING bucket (tm-ecom-staging)
   │
   └─ git push main ────────────► main    ─────────────────────► Production build
                                                                  tmphotography.vercel.app
                                                                  uses the LIVE bucket
```

---

## 4. Hosting, environments & releases

| Item | Value |
|---|---|
| Live URL | https://tmphotography.vercel.app |
| Vercel project | `tm_photography` (team `gaurav-tm-projects`) |
| Plan | Hobby |
| Build | `npm run build` → `vite build` → `dist/` |
| Functions | every file in `api/` not starting with `_` (the `api/_lib/` folder is shared code, not endpoints) |

### Environments

| Environment | Address | Built from | Storage | Who uses it |
|---|---|---|---|---|
| **Production** (live) | https://tmphotography.vercel.app | the `main` branch | live R2 bucket (real History, templates, Waitlist) | the team, every day |
| **Preview** (staging) | `https://tmphotography-git-<branch>-gaurav-tm-projects.vercel.app` (e.g. `…-git-staging-check-…`) plus a unique address per build | any other branch | **staging** bucket `tm-ecom-staging` — completely separate, starts empty | testing changes before release |
| Development | `localhost:3000` | the laptop | **live** data via the proxy (see *Local development*) | quick UI work only |

**The rule: nothing goes to `main` (and so to the live site) until it has worked on a Preview.**

Preview sites are protected by **Vercel Authentication** — a browser must be logged in to the Vercel account to open them. Scripts and Claude reach them with the header `x-vercel-protection-bypass: <secret>` (see *Automation bypass secret*).

Staging starts with **no templates and no History**. Copy templates across when needed (§25 *Copy live templates to staging*).

### Git & GitHub

| Item | Value |
|---|---|
| Repository | private `https://github.com/gauravbellani2811/tm-ecom-tool` (GitHub account `gauravbellani2811`) |
| Local folder | `C:\Projects\ecom-photographer\fabric-styler` (the repo root) |
| Branches | `main` = live · `staging-check` (or any other name) = work in progress / staging · `docs-guide-update` etc. for documentation |
| Commit identity | set **for this repo only**: name `gauravbellani2811`, email the work address. The laptop's global Git identity belongs to a different project and must not be used here |
| Sign-in | Git Credential Manager; this repo is pinned to the `gauravbellani2811` GitHub login (`credential.https://github.com.username`), so the other GitHub account on the laptop is never used |
| Line endings | `.gitattributes` forces LF (the site is built on Linux) |
| Not committed (`.gitignore`) | `node_modules/`, `dist/`, `.vercel`, every `.env*` file (secrets), legacy `backend/` and `frontend/`, `.claude/settings.local.json` |

Vercel is connected to the repository (**Settings → Git**): a push to `main` builds and publishes Production automatically; a push to any other branch builds a Preview. **Production Branch** is `main` (**Settings → Environments**).

Claude is allowed to run `git push` for this repo (rule in `.claude/settings.local.json`), but only pushes `main` when explicitly asked.

### Release process (checklist)

1. **Branch** — work on a branch, never directly on `main` (`git switch -c <name>`, or reuse `staging-check`).
2. **Test locally** — `npm test` (all must pass) and `npm run build` (must be clean).
3. **Commit & push the branch** — `git push` → Vercel builds a Preview in about a minute (Deployments tab shows **Preview**, not Production).
4. **Check staging** — the Preview loads, the affected screens work, and any risky behaviour is exercised against the staging bucket (for saving: many simultaneous saves, then confirm every one landed).
5. **You try it** on the branch address and approve.
6. **Pick a quiet moment** — don't release while someone is mid-batch (a release replaces the backend under an open page).
7. **Release** — fast-forward `main` to the tested branch (`git switch main` → `git merge --ff-only <branch>`), run `npm test` again, then `git push origin main`.
8. **Verify live** — the Deployments tab shows a new **Production** build as *Ready*; History and templates load; do one real action of the kind that changed.
9. **Tell users to refresh** any open tab once, so they get the new version.
10. **If anything is wrong: roll back** — Vercel → Deployments → the previous Production deployment → **⋯ → Promote**. The old version is live again within seconds; then fix on a branch.

> ⚠️ **Never use Vercel's "Redeploy" button to rebuild staging.** Its dialog defaults to **Production** and to whichever deployment it considers current — pressing it once nearly re-released a broken build. To rebuild a Preview (e.g. after changing Preview environment variables), push a commit to the branch instead; an empty one is fine: `git commit --allow-empty -m "Rebuild staging"` then `git push`.

> 💡 The terminal in the desktop app is Windows PowerShell 5.1, which does not understand `&&`. Run commands one per line.

### The Vercel CLI

Direct CLI deploys (`vercel --prod`) bypass GitHub and staging and are **no longer used for releases**. The CLI is still handy for read-only checks, which must be run **from the `fabric-styler` folder**:

```bash
vercel ls              # recent deployments (Preview and Production)
vercel inspect tmphotography.vercel.app   # which deployment is live, its aliases
vercel env ls          # variable names and which environments they apply to (never values)
```

> **Pitfall:** the parent folder (`ecom-photographer`) is linked to a *different* Vercel project, and a leftover link exists in `public/.vercel/`. CLI commands from the wrong folder act on a stray project. The correct link lives in `fabric-styler/.vercel/project.json` (project `tm_photography`).

`.vercelignore` excludes the legacy `backend/` and `frontend/` folders from uploads.

### `vercel.json`

| Path | Cache header | Why |
|---|---|---|
| `/`, `/index.html` | `no-store, must-revalidate` | New deploys show up immediately |
| `/assets/*` | `public, max-age=31536000, immutable` | Vite fingerprints asset filenames, so they can cache forever |

### Function settings

| Function | `maxDuration` | Body parser |
|---|---|---|
| `generate`, `templates` | 60 s | disabled (multer reads multipart) |
| `shopify-images` | 60 s | JSON |
| `history` | 60 s | JSON (thumbnail backfill can take a while) |
| `history/[id]`, `history-add`, `templates/[id]`, `template-image`, `waitlist`, `admin` | 30 s | varies (multipart routes disable it) |

Every save to a shared JSON file retries for at most **20 seconds** (§5), which stays inside the shortest 30 s limit.

### Function count — at the cap

There are **12** function files, which is Vercel Hobby's per-deployment limit:

`admin`, `generate`, `history`, `history/[id]`, `history-add`, `login`, `models`, `shopify-images`, `template-image`, `templates`, `templates/[id]`, `waitlist`.

A new endpoint therefore requires merging an existing one (e.g. folding `history-add` into `history`, or removing the debug `models` endpoint) or upgrading the plan. Occasional maintenance actions are added to an existing endpoint instead (e.g. `POST /api/history` `{ action: "backfillThumbs" }`). Files in `api/_lib/` and `tests/` don't count.

### Plan limits & the Fast Origin Transfer incident

The project is on Vercel's free **Hobby** plan. Its most relevant allowance is **Fast Origin Transfer: 10 GB per 30 days** — every byte sent *into or out of* a serverless function (uploads, API responses). If exceeded, Vercel can pause the feature for the rest of the 30-day window, which would take the tool's backend down.

In September 2026 the allowance hit 100%. Measured causes and fixes:

| Cause | Before | After |
|---|---|---|
| Generated images returned to the browser as base64 inside the API response | ~0.9 MB per image (~4 GB/month) | images saved to R2 in the function and returned as links (~250 bytes per result) |
| Retries re-uploaded the fabric and detail photos, returned the image, then uploaded it again on save | ~1.8 MB per retry | fabric/detail read from R2 by URL (`fabricUrl`/`detailUrl`); picking copies inside R2 (`sourceUrl`) |
| Opening History downloaded the whole list uncompressed | 4.9 MB per open | gzip-compressed by the function (~0.5 MB), shorter retention (10 days) |

The first upload of each new fabric still passes through a function (~0.6 MB), which is small by comparison.

Two further notes about the Hobby plan: it is Vercel's *non-commercial* tier (their definition of commercial use is broad), and it has no pay-as-you-go overage. **Pro** ($20/month) removes the pause risk.

### Local development

```bash
cd fabric-styler
npm install
npm test                    # automated tests (no network, no real storage)
npx vite --port 3000        # also configured in .claude/launch.json as "fabric-vite"
```

`vite.config.js` proxies every `/api` request to **production** (`https://tmphotography.vercel.app`).

> ⚠️ **Local dev reads and writes live data.** Anything you generate, delete or restore from `localhost:3000` happens to the real History, templates and Waitlist. Use it only for layout work; test behaviour on a **Preview** (staging) instead. A delete sent from local dev to an older production backend once soft-hid a staff member's entire history.

### Automation bypass secret

Scripts (and Claude) reach the protected Preview sites with Vercel's **Protection Bypass for Automation** secret (Vercel → Settings → Deployment Protection). It is stored only on the laptop, in `fabric-styler/.env.staging.local` — the file holds just the secret value, is covered by `.gitignore`, and must never be pasted into chat or committed. Send it as the header `x-vercel-protection-bypass`. To open a Preview in a browser without logging in to Vercel, add `?x-vercel-protection-bypass=<secret>&x-vercel-set-bypass-cookie=samesitenone` to the address once.

### Automated tests

`npm test` runs `node --test "tests/*.test.*"`:

| File | What it proves |
|---|---|
| `tests/storage-concurrency.test.cjs` | 30 simultaneous History saves all land (with weak ETags, like real R2 for large files); a retried image replaces the old one for its template; an unreadable History file is never overwritten; simultaneous Waitlist adds, audit appends, template-library adds and active-set saves lose nothing |
| `tests/saveQueue.test.mjs` | the browser save queue runs saves strictly one at a time and in order; a save that can't succeed doesn't block the next and is kept for Retry; Retry re-sends the same save |
| `tests/helpers/fakeR2.cjs` | an in-memory stand-in for R2 that honours `If-Match` / `If-None-Match`, returns **weak** ETags for bodies over 1 KB, and adds random latency |

Removing the weak-ETag fix makes three of the storage tests fail — the tests catch the bug that once broke live saving.

`npm run dev` runs `vercel dev` instead (local functions), which needs the environment variables available locally; the sensitive ones can't be pulled from Vercel.

---

## 5. Storage & safe saving (Cloudflare R2)

All persistent state lives in R2. There is no database: each kind of state is a single JSON document, read, modified and written whole — safely, using the conditional-write check described below.

| Bucket | Used by | Keys (env vars) |
|---|---|---|
| live bucket | Production (tmphotography.vercel.app) | Production-scoped `R2_*` variables |
| `tm-ecom-staging` | every Preview build | Preview-scoped `R2_*` variables; its API token is limited to this bucket only (Object Read & Write) |

The staging bucket has its own public `r2.dev` URL and the same CORS policy as the live bucket (needed for downloads and zips).

- **Writes and JSON reads** use the authenticated S3 endpoint `https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com/{R2_BUCKET}`. Authenticated reads are never CDN-cached, so state is always fresh.
- **Images** are served publicly from `R2_PUBLIC_BASE` (currently an `*.r2.dev` URL).

### Keys

| Key | Contents | Retention |
|---|---|---|
| `fs-manifest.json` | Shared template library | permanent |
| `fs-active.json` | Each user's active template set and order | permanent |
| `fs-history.json` | All history runs | runs older than **10 days** pruned (images deleted) |
| `fs-audit.json` | Generation/caption events for analytics | **90 days** |
| `fs-caption-settings.json` | Caption instructions, fixed sections, approved tags | permanent |
| `waitlist/{user}.json` | A user's waitlist items | items older than **7 days** pruned |
| `fs-templates/{id}.jpg` | Template image (`{id}-{timestamp}.jpg` after a crop) | until deleted |
| `fs-history/{runId}-{imageId}.jpg` | Generated image | with its run |
| `fs-history/{runId}-flat.jpg` | Flat swatch | with its run |
| `fs-history/{runId}-original.jpg` | Original uploaded photo | with its run |
| `fs-history/{runId}-detail.jpg` | Close-up detail photo | with its run |
| `fs-history/…{id}.thumb.jpg` | 320 px thumbnail (~10 KB) of a grid image (styled or flat), used by History, Shopify CSV and Admin grids | with its image |
| `fs-candidates/{uuid}.jpg` | Retry variations (⟳, ⟳3, ✦) waiting to be picked; the picked one is copied into `fs-history/` | deleted **24 hours** after upload (swept whenever a retry runs) |
| `waitlist/{user}/{id}.jpg`, `…/{id}-detail.jpg` | Waitlist photos | 7 days |
| `shopify/{SKU}_{Template}.jpg` | Clean-named copies made by the Shopify export | permanent (overwritten per SKU/template) |

Pruning is lazy. Reads simply leave out expired entries; the expired entries (and their image files) are actually removed the next time that file is **saved** — for History, that's the next generation, pick or delete. Retry candidates are swept by age during retries, up to 300 per sweep.

### Storage helpers (`api/_lib/storage.js`)

| Function | Purpose |
|---|---|
| `putImage(key, buffer)` | Upload JPEG with `Cache-Control: public, max-age=31536000, immutable` |
| `putJson(key, obj)` | Unconditional JSON upload (used internally; writers use `updateJson`) |
| `getJson(key)` | Authenticated read; `null` if missing — for display only |
| `getJsonVersioned(key)` | Read JSON **with its ETag**; throws on read errors or unreadable JSON (never pretends a file is empty) |
| `putJsonIfMatch(key, obj, {etag, exists})` | Conditional write: `If-Match` (or `If-None-Match: *` for a new file); `false` on 412 |
| `updateJson(key, mutate)` | The safe read → change → conditional write loop (below) |
| `getObjectBuffer(key)` | Read an image's bytes inside a function (e.g. a stored fabric photo for a retry, or to make a thumbnail) |
| `copyObject(src, dest)` | Server-side copy (no bytes through the function) |
| `listObjects(prefix)` | One page (≤1000) of keys with last-modified times (used by the candidate sweep) |
| `deleteKeys(keys)` | Parallel best-effort deletes |
| `isStoredImageKey(key)` | Allows only `fs-history/*.jpg` and `fs-candidates/*.jpg` to be referenced by URL from the browser |
| `urlToKey(url)` / `publicUrl(key)` | Convert between public URLs and keys |

Other storage-related modules: `api/_lib/thumbs.js` (makes 320 px thumbnails with `sharp`; `imageBlobUrls` lists an image's full + thumbnail files for deletion) and `api/_lib/respond.js` (`sendJson` — gzip-compresses large JSON responses).

Image keys are never overwritten with different bytes (retries get a new id), which is what makes the year-long immutable cache safe.

### Safe saving: why and how

**The problem it solves.** Every save of History used to *read the whole file → change one entry → write the whole file back*, taking a few seconds for a multi-MB file. When two saves overlapped (typically several retry replacements picked in quick succession, or a pick landing while a batch generation saved), the one that finished second wrote back a copy that didn't contain the first one's change — so some picked replacements silently reverted to the old image.

**Layer 1 — the server check (optimistic concurrency).** All shared JSON files are changed only through `updateJson(key, mutate)`:

1. Read the file together with its **ETag** (R2's version ID for that exact content).
2. Apply the change in memory (`mutate`).
3. Write it back with `If-Match: <ETag>` — R2 accepts the write only if nobody has saved the file since step 1; otherwise it answers **412 Precondition Failed**.
4. On 412: wait a random, growing delay ("full jitter", up to 1.5 s), re-read and re-apply the change. Keep going for up to **20 seconds**, then fail with *"Too many simultaneous saves … please try again"* — an honest error, never a silent loss.

Details that matter:
- **Weak ETags.** Cloudflare compresses larger responses and then labels the ETag weak (`W/"…"`). R2 only accepts the strong form in `If-Match`, so a weak tag made *every* conditional save fail — which is exactly what broke saving on the live site during the first rollout. `getJsonVersioned` strips the `W/` prefix; the value inside is the object's real ETag.
- **Blob deletions happen only after the winning write**, using the list from the attempt that actually succeeded (the change function may run several times).
- **Never overwrite what can't be read.** If a file exists but can't be parsed, the save is refused instead of replacing it with a fresh list.
- **Switch.** `USE_CONDITIONAL_WRITES` in `api/_lib/storage.js` turns the check off (plain read-change-write) in an emergency.
- **Throughput.** R2 allows roughly **one rewrite of the same file per second**. Measured on staging with a 2.5 MB file: 5 simultaneous saves all land (~10 s), 10 all land (~18 s), 15 → 14 land within the budget, 25 → 15. Beyond ~10 truly simultaneous saves, some return the "too many" error. Layer 2 keeps a single browser well below that.

Files that use it: `fs-history.json` (`updateHistory`, which also prunes), `fs-audit.json` (`appendEvents`), `waitlist/{user}.json` (`updateWaitlist`), `fs-manifest.json` (`updateManifest`), `fs-active.json` (`setUserActive`, `removeFromAllActive`), `fs-caption-settings.json` (`writeCaptionSettings`).

**Layer 2 — the browser save queue** (`src/utils/saveQueue.js`). Every History write from the app (picking a retry replacement on the Results panel or in History, deleting selected images, deleting a run, clearing History) goes into a queue that sends **one save at a time**, starting the next only when the previous has finished. So a person's own burst of picks never competes on the server; Layer 1 only has to handle the rarer clashes the browser can't see (another person saving, a second tab, a batch generation's own save).

| Queue behaviour | Detail |
|---|---|
| Order | strict, first in first out |
| Automatic retry | network errors, 5xx, 408 and 429 retry after **2 s, 5 s, 10 s**; if the browser is offline it first waits for the connection to return |
| Not retried | answers like 400/403/404 (a retry wouldn't change them) |
| Final failure | the save moves to a **not saved** list; the chosen image stays on its tile marked **⚠ Not saved** with **Retry**, and the header pill turns red with **Retry** — nothing is reverted or discarded silently |
| Retry | re-sends the same save (the same stored image, copied server-side) — no regeneration, no cost |
| Leaving the page | while anything is queued or not saved, closing or refreshing the tab triggers the browser's *"changes may not be saved"* warning |
| Indicator | `SaveIndicator` pill, top centre, above every modal: **Saving N… keep this tab open** / **⚠ N not saved · Retry** |

The queue lives in the open tab; it isn't shared between tabs or people.

### History of the storage layer

The app originally used Vercel Blob with versioned manifest filenames to dodge CDN caching. It moved to R2; `scripts/migrate-to-r2.js` was the one-time copy. The `BLOB_*` variables in `.env.local` are leftovers from that era.

---

## 6. Environment variables

Set in Vercel → Project → Settings → Environment Variables. Each variable can have **different values per environment** (Production, Preview, Development) under the same name. Sensitive values are write-only in Vercel and cannot be pulled locally.

> When adding a staging value, click **Add**, type the same key name, and tick **only Preview**. Never edit the existing Production rows to do this.

| Variable | Required | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | yes | All Gemini calls |
| `R2_ACCOUNT_ID` | yes | R2 endpoint |
| `R2_ACCESS_KEY_ID` | yes | R2 signing |
| `R2_SECRET_ACCESS_KEY` | yes | R2 signing |
| `R2_BUCKET` | yes | Bucket name |
| `R2_PUBLIC_BASE` | yes | Public image base URL (no trailing slash) |
| `ALLOWED_USERS` | no | Comma list of usernames. Default `gaurav2811,bharatrm` |
| `ADMIN_USERS` | no | Comma list of admins. Default `gaurav2811` |
| `ADMIN_PIN` | for Admin | Required for the Admin dashboard and history restore |
| `CAPTIONS_SHEET_WEBHOOK` | no | Apps Script URL for the captions sheet; unset = feature off |
| `CAPTIONS_SHEET_TOKEN` | no | Shared secret the captions script checks |
| `BLOB_READ_WRITE_TOKEN` | no | Legacy; only the migration script uses it |

**Which environments have which variables**

| Variable | Production | Preview (staging) |
|---|---|---|
| `GEMINI_API_KEY` | ✓ | ✓ (same key — staging generations cost real money) |
| `R2_ACCOUNT_ID` | ✓ | ✓ (same Cloudflare account) |
| `R2_BUCKET`, `R2_PUBLIC_BASE` | live bucket | `tm-ecom-staging` and its r2.dev URL |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | live token | a separate token limited to the staging bucket |
| `ADMIN_PIN` | ✓ | ✓ (may differ from the live PIN) |
| `ALLOWED_USERS`, `ADMIN_USERS` | ✓ | not set — the code defaults (`gaurav2811,bharatrm` / `gaurav2811`) apply |
| `CAPTIONS_SHEET_WEBHOOK`, `CAPTIONS_SHEET_TOKEN` | ✓ | **deliberately not set**, so test runs never write captions into the real Google Sheet |

Changing a variable takes effect only on the **next build** of that environment (push a commit to rebuild a Preview; see §4).

---

## 7. Sign-in, identity & roles

### How sign-in works

1. The login screen asks for a username (no password).
2. `POST /api/login` checks it against `ALLOWED_USERS` and returns `{ user, role }`.
3. The browser stores `fs_user` and `fs_role` in `localStorage`, so the session survives reloads.
4. Every API call adds the header `x-fs-user: <username>` (`src/utils/api.js → apiFetch`).
5. **Logout** clears storage.

The login page says so plainly: *this is an identity check for the team, not a password.*

### Admin PIN

Admin-only operations (`/api/admin`, and restoring hidden history) require **both** an admin username **and** the header `x-fs-admin-pin` matching `ADMIN_PIN`. The PIN is typed into the Admin dashboard and kept **in memory only** — never saved — so it's asked for again after a reload.

### What each role can do

| Capability | Admin | Staff |
|---|---|---|
| Generate, caption, retry, Waitlist, Shopify CSV | ✓ | ✓ |
| Active templates | own set | own set |
| Template library edits (label, prompt, alt pattern, crop, delete) | ✓ shared | ✓ shared |
| History (header button) & Shopify CSV picker | own runs only, hidden items filtered out | own runs only, hidden items filtered out |
| Combined all-users history | ✓ Admin → **All users' history** (with PIN), including hidden runs and images | — |
| Delete from History | **permanent** — removes images from storage | **soft hide** — kept for admin audit |
| Admin dashboard | ✓ (with PIN) | — |
| Restore a user's hidden history | ✓ (with PIN) | — |

Runs created before per-user tracking have no `user` and belong to the first admin.

---

## 8. AI models, prompts & costs

### Models

| Model | Used for | Where |
|---|---|---|
| `gemini-3.1-flash-image` | Default image generation | `api/generate.js` (`FLASH_MODEL`) |
| `gemini-3-pro-image` | "Pro" retries only (opt-in) | `api/generate.js` (`PRO_MODEL`) |
| `gemini-2.5-flash` | Scene descriptions, alt-text patterns, captions | `templates.js`, `alttext.js`, `captions.js` |

`GET /api/models` is a debug endpoint listing models available to the key.

### What an image request contains

`callGemini` sends one request per template, with parts in this exact order:

1. **IMAGE 1** — the template scene
2. **IMAGE 2** — the fabric photo
3. **IMAGE 3** — the close-up detail photo (only if attached)
4. **Text** — the composed prompt

Config: `responseModalities: ["IMAGE"]`, and an `aspectRatio` matched to the template. The server reads the template JPEG's pixel size and picks the nearest supported ratio from `1:1, 2:3, 3:2, 3:4, 4:3, 9:16, 16:9, 21:9`. Each call has a hard **60-second** timeout.

### How the prompt is built

```
[ template.prompt ]          ← stored per template, fully editable in Template Editor
        +
[ FABRIC_TRANSFER_GUARD ]    ← fixed, added to every generation
        +
[ FABRIC_DETAIL_CLAUSE ]     ← only when a close-up detail photo is attached
```

**Template prompt** — written automatically when a template is uploaded:
- `gemini-2.5-flash` describes the scene (props, surfaces, lighting, colour palette excluding the fabric, camera angle, and how the textile is folded — explicitly *not* its pattern or colour), under 120 words.
- `buildDefaultPrompt(description)` wraps that into instructions to recreate the scene exactly and re-skin the draped textile with the second image's pattern.

**Fabric transfer guard** — defines IMAGE 1 as the scene and IMAGE 2 as the sole source of motifs, print, weave, scale and colourway; says the template's textile is a stand-in to discard completely; and explicitly forbids the common failure of keeping the template's pattern and merely tinting it. It's applied at generation time, so every template benefits without being re-saved.

**Detail clause** — tells the model IMAGE 3 shows the fabric's true surface (raised embroidery, thread relief, sheen, depth), that the fabric is embroidered not printed, and that IMAGE 2 stays the source of pattern and colour while IMAGE 3 refines only texture.

### Costs

Estimated per unit in `api/admin.js`, converted at ₹86/USD:

| Unit | USD | INR |
|---|---|---|
| Flash image | $0.067 | ₹5.76 |
| Pro image | $0.13 | ₹11.18 |
| Caption | $0.001 | ₹0.09 |

Input images cost roughly $0.0011 each, so attaching a detail photo adds about ₹0.09 per image (~1.6%). A normal product with 4 templates plus a caption costs about ₹23. These figures are estimates; Google doesn't expose the AI Studio credit balance through any API, so the real balance is only visible in Google's billing console.

---

## 9. The home screen, feature by feature

### Header

| Control | Who | What it does |
|---|---|---|
| Logo + **Ecom Tool** | all | Branding |
| **Admin** | admin | Opens the Admin dashboard (§16) |
| **Daily Checkout Sheet** | all | Opens `/daily-checkout.html` in a new tab (§17) |
| **Waitlist** | all | Phone-to-laptop photo staging (§13) |
| **Shopify CSV** | all | Product picker and Shopify export (§15) |
| **History** | all | 10-day archive (§14) |
| username | all | Who is signed in |
| **Logout** | all | Signs out |

A floating **save pill** appears at the top centre (above every screen and modal) whenever History changes are being saved — *"Saving 2… keep this tab open"* — and disappears when done. If a save still fails after automatic retries it turns red — *"⚠ 1 not saved"* with **Retry** (§5).

A sticky **status bar** appears while generating: *"Generating fabric 2 of 5 — EC17010"*, a progress bar, and **Cancel after current**. Cancelling lets the current fabric finish and stops the rest.

### Active Templates panel

Your personal set of up to **5** templates used for generation. Each user has their own set and order (so the owner can keep creative social-media scenes active while staff keep standard website scenes). The template library itself is shared.

- Counter: *"4 of 5 active · 3 in library"*
- **Click** a template → Template Editor
- **Drag** templates to reorder — output order follows it
- **×** removes from your active set (stays in the library, after confirmation)
- **Open Library** → Template Library
- **Add slot** (while under 5): **From library** or **+ Upload new**
  - Upload asks for a name, compresses to 1400 px, then shows *Processing… → Uploading… → Analyzing scene…* while Gemini writes the scene description and alt pattern
  - New templates auto-activate for the uploader if there's room

### Template Library (modal)

Every template. Each card shows the image, an **Active** badge, and a download button, plus:

| Button | Effect |
|---|---|
| **Activate / Deactivate** | Add to or remove from *your* set (blocked past 5) |
| **Crop** | Template Cropper — ratios **1:1**, **Freehand**, **16:9**; saves a new image |
| **Edit** | Template Editor |
| **Delete** | Removes it from the library, deletes the image, and removes it from every user's active set |
| **+ Add new template** | Upload (same as above) |
| **Auto-fill alt patterns** | Generates SEO alt-text patterns for templates missing one |

### Template Editor (modal)

- Preview, short ID, and the collapsible **auto-generated scene description**
- **Label**
- **Prompt sent to Gemini** — the full scene prompt; edit freely (the guard is added automatically)
- **SEO alt-text pattern** — e.g. `Swirled {colour} {fabric} Fabric Showing {pattern} and Drape`, with placeholders `{colour}`, `{fabric}` (adjective + material), `{pattern}` (tags)

Label, prompt and alt pattern are shared across users.

### Fabrics panel (the queue)

Drop or browse **multiple** photos (jpg, png, webp). Each is compressed in the browser to 1600 px / 90% JPEG before upload to stay under Vercel's 4.5 MB request limit.

Each row:

| Element | Purpose |
|---|---|
| Thumbnail | Click to enlarge |
| **SKU** | Product name; becomes the SKU everywhere |
| **Colour**, **Adjective**, **Material** | Caption facts (e.g. Pink / Floral / Crepe) |
| **Tag 1–3** | Craft or motif tags (e.g. Thread Work, Stone) |
| Status pill | Pending · Preparing · Generating · Done · Error |
| **⤓ Download** | When done: zip of that fabric's images |
| **Crop** | Fabric Cropper — Freehand / 1:1 / 16:9, **⟲ 90° / ⟳ 90°** rotate, **Tilt** slider ±45°; resets the fabric to pending |
| **＋ Detail** / **🔍 Detail ✓ ×** | Attach, view or remove a close-up (opens the camera on phones) |
| **×** | Remove from queue |

Leaving Colour, Adjective, Material and all tags blank marks the product as social-media only: images are generated but **no caption** is written.

Footer: **Generate (N)** for pending fabrics, **Retry failed (N)**, **Clear completed**, and a hint if no templates are active.

Fabrics live only in the browser tab; reloading the page clears the queue (finished results are already in History).

### Results panel

One row per fabric, scrolling horizontally:

1. **Uploaded fabric** card
2. **Flat fabric** card (made locally, instantly — see §10)
3. One card per template, in active order

Above the images, when a caption exists: title, description preview, tags and product type, and each image's alt text.

Each result card:
- Click to **enlarge**
- **⟳** regenerate · **⟳3** three variations · **✦Pro** Pro model — all run in the background (§12)
- After picking a replacement: *Saving…* while it's queued/saving; **⚠ Not saved** + **Retry** if it couldn't be saved
- **⤓** download the single JPG
- Shimmer placeholder while generating; errored cards show the message and a **⟳** that retries in place

Panel header: **⤓ Captions (CSV)** and **⤓ Download all**. Row header: **⟳ Retry failed (N)** and **⤓ Download**.

---

## 10. How a generation run works

**In the browser (`App.jsx`)**

1. **Generate** collects every pending fabric and processes them **one at a time**, so each server call stays under 60 seconds regardless of queue length.
2. For each fabric:
   - A `runId` is created (reused for later retries so everything lands in one History record).
   - The **flat swatch** is built locally with no AI: a centre square crop at up to 1400 px, +10% brightness and a light sharpen.
   - Placeholder cards appear.
   - One `POST /api/generate` is sent with: the fabric, optional detail, flat swatch, `runId`, SKU, caption facts, and every active template id.

**On the server (`api/generate.js`)**

1. Parses the upload (fabric, flat, detail).
2. If any caption fact is present and this is a normal generate, **starts the caption in parallel**.
3. Generates **all templates in parallel**. Each template fetches its image, picks the aspect ratio, composes the prompt and calls Gemini. One template failing or timing out affects only its own card.
4. Waits for the caption and fills per-image alt texts from each template's pattern.
5. Writes **audit events** (one per template, one for the caption).
6. **Stores every generated image in R2 straight away** — under `fs-history/` for a normal run, or `fs-candidates/` for retry candidates (`skipHistory`) — so the response carries links, not image bytes.
7. Saves to **History** (unless `skipHistory`): each generated image with a **320 px thumbnail**, the flat swatch (also with a thumbnail), the **original** photo, the **detail** photo, the caption, and the typed facts. Runs are upserted by `runId`, and images by template, so retries replace in place. The save uses the safe `updateHistory` (§5).
8. For retry calls, **sweeps retry candidates older than 24 hours**.
9. Appends the caption to the **Google Sheet**, if configured.
10. Returns `{ results, caption, sources }`: each result's `imageDataUrl` is an R2 link; `sources` holds the stored original/detail links so later retries from the Results panel can reuse them instead of re-uploading.

Every step after generation is best-effort: a History, audit or sheet failure never breaks the response.

**Audit `action` values:** `generate`, `retry`, `regenerate`, `pro`, `retry3`, `caption`.

---

## 11. Captions, titles, tags & alt text

Captions are written only when a product has at least one of Colour, Adjective, Material or a tag, and only on the initial generate (not retries).

### Title — deterministic, no AI

`{Colour} {Adjective} {Material} Fabric - {SKU}`, Title Case, skipping any missing part in order (e.g. `Floral Crepe Fabric - EC17010` without a colour). If none of the three are given, the AI's title is used.

### Description — AI writes the creative part, the app adds fixed sections

`gemini-2.5-flash` receives the flat swatch (or original) and the facts, and returns structured JSON: title, intro, key features, tags, product type. The final HTML is assembled in this order:

1. **Intro** — two paragraphs in house style (AI)
2. **Key Features** — 4–6 bullets tailored to the fabric (AI)
3. **Care Instructions** — fixed bullets
4. **Details** — Approximate Measurement, Fabric (material), Type: Fabric
5. **Lining link** — bold, blue (`#0000EE`), linking to the plain linings collection
6. **Disclaimer** — italic colour-accuracy note

Defaults, all editable in Admin → Captions:

| Section | Default |
|---|---|
| Care | Gentle hand wash or dry clean recommended / Iron on low heat from the reverse side |
| Measurement | 44" |
| Lining label / URL | Lining Sold Separately → `https://tmangharam.com/collections/plain` |
| Disclaimer | Colours may vary slightly due to screen settings and lighting |

The creative instructions carry a `promptVersion` (currently 2). If the code's version changes, a previously saved custom prompt is replaced by the new default.

### Tags — constrained to an approved list

The final tag set is assembled in code, not left to the AI:

1. **`Fabric`** — always
2. **Colour** — from the Colour field (colours aren't in the list; always allowed)
3. **Manual Tag 1–3** — always included, with correction:
   - exact match (case-insensitive) → the approved spelling
   - singular/plural → `sequins` → `Sequin`
   - unique whole word or prefix → `thread` → `Thread Work`, `mirror` → `Mirror Work`
   - 1–2 character typo (1 for short words, 2 for 8+ letters) → `embordery` → `Embroidery`, `slik` → `Silk`
   - no confident or unique match → **kept exactly as typed** (`bridal` stays `Bridal`; ambiguous `print` isn't forced; `gold` is never turned into `Gota`)
4. **`Embroidery`** — added when the title contains "embroider"; each technique stays a separate tag (e.g. Embroidery, Stone, Thread Work)
5. **AI tags** — the same matching, but anything without a confident approved match is **dropped**
6. Case-insensitive de-duplication; no cap on count

The AI is told to pick only from the approved list and to include every applicable print pattern and embroidery technique.

**Approved list (70, editable in Admin → Captions):** Abstract, Ajrakh, American Crepe, Animal Print, Art Silk, Banaras, Bandhini, Batik, Bead, Bizzy Lizzy, Block Print, Border, Brocade, Butta, Chanderi, Checked, Chiffon, Chinnon, Cotton, Crepe, Crochet, Cutwork, Denim, Diamond, Digital Print, Dotted, Embroidery, Fabric, Floral, Foil, Fur, Georgette, Hakoba, Ikat, Jacquard, Jute, Kalamkari, Kids, Lace, Leaf, Linen, Lining, Lurex, Lycra, Mirror Work, Net, Organza, Paisley, Plain, Polka Dots, Printed, Rayon, Satin, Satin Georgette, Semi Banaras, Sequin, Shibori, Shimmer, Silk, Stone, Stripes, Thread Work, Tie and Dye, Tissue, Tussar, Two Toned, Velvet, Viscose, Zari, Gota.

### Alt text — one pattern per template, filled per product

Each template carries an `altPattern`, generated once from its scene by `gemini-2.5-flash` in house style:

| Presentation | Pattern |
|---|---|
| Flat / tray | `{colour} {fabric} Fabric with {pattern}` |
| Swirled | `Swirled {colour} {fabric} Fabric Showing {pattern} and Drape` |
| Folded | `Folded {colour} {fabric} Fabric Highlighting {pattern} and Texture` |
| Saree drape | `{colour} {fabric} Fabric Draped as a Saree Showing Elegant Fall and Design` |

Per product the pattern is filled with no AI: `{fabric}` = adjective + material, `{pattern}` = tags joined with spaces. If generation fails the fallback is `{colour} {fabric} Fabric with {pattern}`.

### Where captions end up

- Results panel and History caption blocks
- **Captions CSV** — columns `SKU, Title, Description, Tags, Product type, Alt 1…N` (tags joined with `; `, UTF-8 with BOM)
- **Captions Google Sheet** — one row per caption (§17)
- **Shopify CSV** (§15)

---

## 12. Retrying images (single, ×3, Pro)

Retries work the same way on the Results panel and in History, and never block the screen.

| Button | What happens |
|---|---|
| **⟳** | One new candidate with the Flash model |
| **⟳3** | Three candidates in parallel |
| **✦ / ✦Pro** | One candidate with the Pro model (asks to confirm the ~2× cost first) |

**The flow**

1. Click a retry button. **No modal opens.** The tile shows *Generating…* (or *Generating 3…*); everything else stays usable, including retries on other tiles.
2. When ready, the tile shows **✓ Compare** (or **✓ Choose (n)**), plus **×** to discard.
3. Opening it shows the finished result immediately:
   - Single / Pro: **Current** beside **New** — **Keep current** or **Use new image**
   - ×3: the **Current** image plus up to three variations — click one to keep
   - Closing with **×** keeps the result ready to reopen later
4. Choosing swaps the tile at once and closes the modal. The save joins the **save queue** (§5): the tile shows *Saving…* and the pill at the top shows *Saving N… keep this tab open*. You can pick several replacements in a row — they save one after another.
5. If a save fails it is retried automatically (2 s, 5 s, 10 s). Only if it still fails does the tile show **⚠ Not saved** with **Retry** (the chosen image stays on the tile) and the pill turns red. **Retry** re-sends the same image; nothing is regenerated.
6. After a refresh, History shows exactly what was saved.

Candidates are generated with `skipHistory` and stored under `fs-candidates/`; nothing reaches History until you choose. A candidate only shows as ready once its image has actually downloaded in the browser, so the Compare / Choose view never opens blank. The choice is saved via `/api/history-add` with `sourceUrl` — the server copies the candidate into `fs-history/` inside R2 and makes its thumbnail. Unpicked candidates are deleted after 24 hours.

**Fabric source for retries** (sent as stored links, not re-uploaded)
- Results panel: the original and detail photos stored by the first generation (`fabricUrl` / `detailUrl`). If none are stored yet (e.g. the fabric was re-cropped), the in-memory photos are uploaded instead.
- History: the run's stored **flat swatch** (the square crop) plus the stored detail photo if present.

Errored cards on the Results panel have no image to compare, so their **⟳** retries and replaces directly.

Retries still *generating* live in the open screen; closing History discards unfinished ones. **Saves** that have already been picked continue in the queue even if History is closed.

---

## 13. Waitlist

A per-user staging area so the floor manager can shoot and label on a phone, and the ecom manager can pull items into the queue on a laptop.

- **Tap to add photos** — multiple uploads, compressed to 1600 px
- Items are kept **7 days**
- One row per item:
  - Thumbnail — click to enlarge
  - **SKU**, **Colour**, **Adjective**, **Material**, **Tag 1–3** — saved when a field loses focus
  - **＋ Close-up detail** — opens the phone camera; once attached shows **🔍 Close-up ✓** (click to view) and **×** to remove
  - **Add to queue** — moves the item into the Fabrics queue with its metadata and detail photo, then removes it from the Waitlist
  - **×** — delete the item and its photos
- **Add all to queue (N)** in the header

Each user has their own Waitlist; items aren't shared between usernames.

---

## 14. History

Every generated product for **10 days**, newest first.

### Header & toolbar

- **Search SKU…** — filters runs; the counter shows *"8 of 546 runs"*
- Counter: *"546 runs · 2684 images · kept 10 days"*
- **Clear all** — admin: permanently deletes your own runs (every user's, in the Admin combined view); staff: hides your own runs
- **Select all / Clear** — image selection
- **⤓ Captions (N)** — Captions CSV of every captioned run in view
- **⤓ Download selected** — one zip, a folder per SKU
- **Delete selected** — admin: permanent; staff: soft hide

Deletes and clears go through the same **save queue** as picks (§5), so they never collide with a replacement that's still saving; the button shows its busy state until the queue reaches it.

### Each run

Header: SKU, image count, date and time, then:

| Button | Effect |
|---|---|
| **◉ Original** | The originally uploaded photo in a lightbox, with the typed facts beneath it (e.g. *Gold · Zardozi · Silk — Tags: floral, embroidery*). Only on runs generated after this feature existed. |
| **Select all** | Select this run's images |
| **⤓ Caption** | This run's caption as CSV |
| **⤓ Download** | Zip of this run's images |
| **Delete** | Admin: permanent; staff: soft hide |

Caption block: title, **▸ Description** toggle (full text and alt texts), tags and product type.

Image grid: the Flat fabric plus each template image. Each tile has a checkbox, click-to-enlarge, the background retries **⟳ / ⟳3 / ✦** (not on the flat swatch), and **⤓**. Original and detail photos are hidden from the grid, counts, selection and downloads. Tiles show small thumbnails (about 10 KB instead of ~500 KB); enlarge, download and Shopify export always use the full-size image. Retry variations only show as ready once their image has finished downloading.

### Visibility and deletion rules

- History is **per user**. Everyone — admin included — sees only their own runs in **History** and in the **Shopify CSV** picker, with hidden images removed; runs left with no visible image disappear.
- The **combined history** (every user's runs, including hidden runs and images, each tagged with its owner) opens only from **Admin → All users' history**, after the PIN. It is the same screen with the same tools; retries saved there keep the run's original owner.
- **Clear all** in your own History clears only your runs (admin: permanently; staff: hidden). Clear all inside the combined view permanently wipes every user's history.
- Staff deletions are **soft**: images get a `hidden` flag and stay in storage for the admin audit. They can be restored from Admin → Staff activity.
- Admin deletions **remove images from storage** and can't be undone.
- Clear-all only runs with an explicit confirmation flag — a malformed delete request can never fall through to wiping history.

---

## 15. Shopify CSV export

**Header → Shopify CSV.** Builds a file that imports straight into Shopify, reverse-engineered from the store's own working import file and matching it column for column.

### Step 1 — choose products

- The full History list (products with images only), one row per product: checkbox, thumbnail (click to enlarge without ticking the row), SKU, title, image count, and a **no caption** badge where relevant
- **Search SKU…**; **Select all** respects the search; **Clear**
- *"8 of 578 selected"* → **Next: group & price (8) →**

### Step 2 — group & price

- **← Back to selection** keeps your picks
- Tick 2+ products of the same design → **Group selected as colour variants**
  - Group header: **VARIANT PRODUCT**, editable shared title (auto `{Adjective} {Material} Fabric`), one **Price /m**, colour count, **Ungroup**
  - Each member: thumbnail, SKU, editable **Colour**
- Ungrouped products: **Price /m** each
- Counter: *"6 products · 40 rows"*
- **⤓ Download CSV** is disabled until every product or group has a price
- A warning appears above ~150 products per file

On download, each image is copied in R2 to a clean key (`shopify/EC17010_Tray.jpg`) so Shopify names it tidily, then `shopify-import-{timestamp}.csv` downloads (UTF-8 with BOM). Shopify downloads every `Image Src` at import and re-hosts it on its own CDN; the R2 link is only the pickup point.

### Row layout

A product occupies several rows sharing one Handle:

- **Product row** (first row) — every product-level field plus the first variant
- **Variant rows** — one per SKU, carrying that SKU's first image
- **Image rows** — remaining images, only Handle, Title, Image Src, Image Position, Image Alt Text

Example, 3 colours × 5 images = 15 rows: rows 1–3 are the variants (image positions 1, 6, 11), rows 4–15 the remaining images (2–5, 7–10, 12–15).

### Every filled column (34 of 72)

| Column | Rows | Rule |
|---|---|---|
| Handle | all | `fabric-lengths-{first SKU, lowercase}` |
| Title | all | Single: `{Colour} {Adjective} {Material} Fabric - {SKU}` · Group: `{Adjective} {Material} Fabric` |
| Body (HTML) | product | Generated description |
| Vendor | product | `T Mangharam` |
| Product Category | product | `Arts & Entertainment > Hobbies & Creative Arts > Arts & Crafts > Art & Crafting Materials > Textiles > Fabric` |
| Type | product | `Fabric Lengths` |
| Tags | product | Approved tags, comma-separated, **plus every variant colour** |
| Published | product | `TRUE` |
| Option1 Name | variant (groups only) | `Color` |
| Option1 Value | variant (groups only) | Typed colour; repeats numbered `Green`, `Green 1` |
| Variant SKU | variant | SKU |
| Variant Grams | variant | `100` |
| Variant Inventory Tracker | variant | `shopify` |
| Variant Inventory Qty | variant | `20` |
| Variant Inventory Policy | variant | `deny` |
| Variant Fulfillment Service | variant | `manual` |
| Variant Price | variant | **Half the typed per-metre price** (store lists 0.5 m): 200 → `100`, 45 → `22.5` |
| Variant Requires Shipping | variant | `TRUE` |
| Variant Taxable | variant | `TRUE` |
| Image Src | all | Clean-named R2 URL |
| Image Position | all | `variantIndex × imagesPerVariant + imageIndex + 1` |
| Image Alt Text | all | Our SEO alt; fallback `{Title} - {SKU} - {Template}` |
| Gift Card | variant | `FALSE` |
| SEO Title | product | = Title |
| SEO Description | product | Description as plain text, first 320 characters |
| Color (custom.color) | product | **Every variant colour, one per line** (no commas) |
| Craft (custom.craft) | variant | `Embroidery` if an embroidery tag is present, else `Printed` |
| Fabric (custom.fabric) | variant | Material |
| Pattern (custom.pattern) | variant | Adjective |
| Variant Image | variant | That SKU's first image |
| Variant Weight Unit | variant | `g` |
| Included / India | variant | `TRUE` |
| Price / India | variant | Same halved price |
| Status | variant | `draft` |

`Published TRUE` with `Status draft` means the product is already on the Online Store channel but stays hidden until its status is set to active.

Image order per SKU: styled templates in stored order, Flat fabric last.

### The 38 blank columns

Option1 Linked To; Option2 and Option3 name/value/linked; Variant Compare At Price; Variant Barcode; Variant Tax Code; Cost per item; the four Unit Price fields; all eleven Google Shopping fields; Workmanship, Color (shopify.color-pattern), Google Custom Product, rating count, complementary/related products, related settings and search boosts metafields; Compare At Price / India; Included, Price and Compare At Price / International.

### Importing

Test-import a 2-product file first. Measured against real R2 URLs, fetches only throttled when hammered at 100 concurrent requests (816 images, then `429 Retry-After: 10`, fully recovered in 20 s). **Up to ~100 products per file** is comfortably safe.

---

## 16. Admin dashboard

**Header → Admin** (admin username), then enter the **admin PIN**.

| Tab | Contents |
|---|---|
| **Template health** | Every template: uses, retries (bold, red at 5+), errors and error rate, *unused* flag. Sorted by retries — surfaces templates that need a better prompt. |
| **Cost & usage** | Estimated total spend (₹), total images, Flash / Pro / caption counts; tables by user and by day (last 30 days); the unit prices used. From the 90-day audit log. |
| **Staff activity** | The latest 120 runs from every user, including *deleted by staff* ones, with thumbnails. **Restore hidden history**: username plus an optional date (`YYYY-MM-DD`) to restore only that day. |
| **All users' history** (button, right of the tabs) | Opens the combined History of every user — owner badge on each run, *deleted by staff* marker on hidden runs, plus all the normal History tools (search, download, retry, delete). |
| **Captions** | **Creative instructions** (the AI prompt), **Approved tags** (one per line), and the fixed sections: care instructions, measurement, lining label and URL, colour disclaimer. **Save caption settings**. |

---

## 17. Google Sheets & Apps Script automations

These run in Google Apps Script, not on Vercel. Their source is not stored in this repo; each lives in its own Apps Script project, and changing one means editing it there and, for web apps, publishing a **new deployment version** (the `/exec` URL stays the same).

### A. Captions sheet

- Called from `api/_lib/sheets.js` after every caption when `CAPTIONS_SHEET_WEBHOOK` is set
- JSON body: `token, timestamp, sku, title, description, tags, productType, alt1…alt5, user`
- The script checks the token and appends a row; 8-second timeout; failures are logged, never shown

### B. Daily Checkout Sheet

**Page:** `public/daily-checkout.html` at `/daily-checkout.html`, a standalone page with its own styling (not part of the React app).

| Section | Fields |
|---|---|
| General | Date (defaults to today) |
| Order fulfilment | Orders received, orders packed & ready |
| Returns | Repeatable rows: order number, amount (₹), reason |
| Refunds | Repeatable rows: order number, amount (₹), reason |
| Cancelled orders | Repeatable rows: order number, amount (₹), reason |
| Production line | Fabric images taken, products generated, products uploaded |
| Stock reconciliation | Online stock reconciliation done? Yes / No |
| Additional work | Free text (inventory tasks) |

**Submit** posts JSON (`mode: no-cors`) to the Apps Script web app, then clears the form. Each entry also carries old field aliases (`id`, `sku`) so older scripts keep working.

**Webhook (`doPost`)** appends one row to the *Ecom Tracker* sheet, matching columns **by header name** so column order doesn't matter: Date, Orders Received, Orders Packed, Returns, Refunds, Photos Taken, Products Generated, Products Uploaded, Stock Update, Other Work, Cancelled Orders (created automatically if missing). Returns, refunds and cancellations are written one per line as `Order: 9036 | ₹500 | Reason: wrong pricing`.

### C. Weekly Ecom Report

A standalone, time-triggered Apps Script that reads the Ecom Tracker sheet and emails a report.

| Setting | Value |
|---|---|
| Schedule | Every **Monday, 10:00 IST** (project time zone must be India Standard Time) |
| Recipients | The owner's Gmail and `askus@tmangharam.com` |
| Subject | `Automated Weekly Ecom Report — {Mon d MMM – Sun d MMM}` |
| Narrative | `gemini-2.5-flash`, key stored in Script Properties as `GEMINI_API_KEY` |

**Email contents**
1. **Summary** — Gemini's review: week-over-week and month-over-month changes, funnel health, fulfilment, reconciliation, returns/refunds, best and slowest day
2. **Last week totals** — images, generated, uploaded, orders received/packed, returns/refunds, working days
3. **Efficiency** — fulfilment % (packed ÷ received), photo→upload %, generation→upload %, reconciliation days
4. **Day by day** — Monday–Sunday; days with no entry show *(off)*
5. **Trends** — last week vs prior week, last 30 days vs prior 30, with ▲/▼ %
6. **Other work noted** — dated

"Last week" is the seven days ending yesterday. Columns are matched by keyword; returns and refunds are counted per `Reason:` entry.

Functions: `setupWeeklyTrigger` (installs the Monday trigger and removes any older daily one), `sendWeeklyReport` (trigger target), `sendTestReport` (send now).

---

## 18. Downloads & file naming

| Action | Result |
|---|---|
| Single image (Results or History) | `{SKU}_{Template}.jpg`, not zipped |
| One fabric / one History run | `{SKU}.zip` |
| Download all (Results) | `fabric-styler-{timestamp}.zip`, a folder per SKU |
| Download selected (History) | `history-{timestamp}.zip`, a folder per SKU |
| Template image | `{label}.jpg` |
| Captions | `captions-{timestamp}.csv` or `captions-{SKU}.csv` |
| Shopify | `shopify-import-{timestamp}.csv` |

Zips are built in the browser with JSZip. Browsers can't create real subfolders from plain downloads, which is why multi-item downloads are zipped.

Every download fetch adds a `?cb=` cache-buster. Without it, a thumbnail already cached by an `<img>` tag (which `r2.dev` serves without CORS headers because of `Vary: Origin`) would be reused and the download would fail with *Failed to fetch*.

---

## 19. Data models

### Template (`fs-manifest.json`, array)

```json
{
  "id": "uuid",
  "url": "https://…/fs-templates/uuid.jpg",
  "label": "Tray",
  "description": "auto-generated scene description",
  "prompt": "full scene prompt (editable)",
  "altPattern": "{colour} {fabric} Fabric with {pattern}",
  "active": true
}
```

`active` is the legacy shared flag, still used as the default for users with no saved set.

### Active sets (`fs-active.json`)

```json
{ "gaurav2811": ["tplId1", "tplId2"], "bharatrm": ["tplId3"] }
```

Ordered, at most 5 per user. `GET /api/templates` returns that user's active templates first (`active: true`), then the rest of the library (`active: false`).

### History run (`fs-history.json`, array)

```json
{
  "id": "r_ab12cd34…",
  "createdAt": "ISO", "updatedAt": "ISO",
  "fabricName": "EC17010",
  "user": "bharatrm",
  "hidden": false,
  "images": [
    { "id": "original", "templateId": "__original__", "templateLabel": "Original upload", "url": "…" },
    { "id": "detail",   "templateId": "__detail__",   "templateLabel": "Close-up detail", "url": "…" },
    { "id": "flat",     "templateId": "__flat__",     "templateLabel": "Flat fabric",     "url": "…", "thumb": "…" },
    { "id": "uuid", "templateId": "tplId", "templateLabel": "Tray", "url": "…", "thumb": "…", "alt": "…", "hidden": false }
  ],
  "caption": { "title": "…", "description": "<p>…</p>", "tags": ["Fabric", "…"], "productType": "…",
               "altTexts": [{ "label": "Tray", "alt": "…" }] },
  "facts": { "colour": "Pink", "adjective": "Floral", "material": "Crepe", "tags": ["…"] }
}
```

Reserved template ids: `__flat__` (shown in grid), `__original__` and `__detail__` (hidden from grid, counts, selection, downloads).

### Waitlist item (`waitlist/{user}.json`, array)

```json
{ "id": "uuid", "url": "…", "detailUrl": "…", "name": "EC17010",
  "colour": "", "adjective": "", "fabricType": "", "tags": ["", "", ""], "createdAt": "ISO" }
```

### Audit event (`fs-audit.json`, array)

```json
{ "id": "uuid", "ts": "ISO", "user": "gaurav2811", "action": "generate",
  "templateId": "tplId", "templateLabel": "Tray", "model": "flash", "status": "ok" }
```

`model` is `flash`, `pro` or `caption`; caption events use `templateId: "__caption__"`.

### Caption settings (`fs-caption-settings.json`)

`captionInstructions, careInstructions, measurement, liningLabel, liningUrl, disclaimer, tagWhitelist[], promptVersion`.

### Fabric in the browser queue

`id, file, previewUrl, name, status, results[], runId, colour, adjective, fabricType, tags[3], detailFile, detailPreviewUrl, caption`. Not persisted.

---

## 20. API reference

All routes read the `x-fs-user` header. "Admin + PIN" also requires `x-fs-admin-pin`. Every endpoint that changes a JSON file uses the conditional-write loop (§5); if it gives up after 20 s it answers 500 with *"Too many simultaneous saves … please try again"*.

| Method & path | Auth | Purpose |
|---|---|---|
| `POST /api/login` | none | `{ username }` → `{ user, role }` or 403 |
| `GET /api/templates` | user | Library with your active set first |
| `POST /api/templates` | user | Multipart `image`, `label` → store, describe scene, alt pattern, auto-activate |
| `PUT /api/templates` | user | `{ order: [ids] }` save your active order · `{ action: "backfillAlt", force? }` fill alt patterns |
| `PATCH /api/templates/:id` | user | `label`, `prompt`, `description`, `altPattern` (shared) and/or `active` (yours; max 5) |
| `DELETE /api/templates/:id` | user | Delete template + image, remove from every active set |
| `POST /api/template-image` | user | Multipart `id`, `image` → replace a template's image (crop) |
| `POST /api/generate` | — | Multipart `fabric`, optional `flatImage`, `detailImage`; fields `templateIds[]`, `runId`, `fabricName`, `action`, `model=pro`, `skipHistory`, `colour`, `adjective`, `fabricType`, `tags[]`; retries may send `fabricUrl` / `detailUrl` (stored R2 images) instead of files → `{ results, caption, sources }`. Each result’s `imageDataUrl` is an R2 URL (history key, or `fs-candidates/` when `skipHistory`), not base64, to keep Vercel Fast Origin Transfer low |
| `POST /api/history-add` | user | Multipart `runId`, `fabricName`, `templateId`, `templateLabel`, and `image` (upload) **or** `sourceUrl` (a stored candidate, copied server-side) → `{ ok, image }` |
| `GET /api/history` | user | Your own runs, gzip-compressed · `?scope=all` (admin + PIN): every user's runs incl. hidden |
| `POST /api/history` | user | `{ action: "backfillThumbs", limit? }` — create thumbnails for up to `limit` (≤80) grid images lacking one; repeat until `remaining` is 0 → `{ processed, failed, remaining }` |
| `DELETE /api/history` | user | `{ urls: [] }` selective delete · `{ confirmClearAll: true }` clear all — limited to your own runs; with `?scope=all` (admin + PIN) applies across all users |
| `PATCH /api/history` | admin + PIN | `{ restoreOwner, restoreDate? }` un-hide a user's runs and images; returns the all-users list |
| `DELETE /api/history/:id` | user | Delete one of your runs (admin permanent, staff soft) · `?scope=all` (admin + PIN): any run |
| `GET /api/waitlist` | user | Your items (prunes expired) |
| `POST /api/waitlist` | user | Multipart `image`, `name` → new item · with `attachTo` → attach detail |
| `PATCH /api/waitlist?id=` | user | Update metadata · `{ removeDetail: true }` |
| `DELETE /api/waitlist?id=` | user | Remove item and photos |
| `POST /api/shopify-images` | user | `{ images: [{ url, filename }] }` (max 1000) → `{ urls: { original: clean } }` |
| `GET /api/admin` | admin + PIN | Template health, cost, activity, caption settings |
| `POST /api/admin` | admin + PIN | Save caption settings |
| `GET /api/models` | none | Debug list of Gemini models |

---

## 21. Design system

### Direction

Warm, quiet and craft-shop — a working tool for a fabric house, not a flashy app. Soft paper grounds, a terracotta accent for primary actions, a sage green for the premium Pro action, and an elegant serif for headings.

### Colour tokens (`src/index.css`)

| Token | Hex | Use |
|---|---|---|
| `--bg` | `#FAF8F5` | Page and modal background |
| `--surface` | `#F2EDE6` | Panels, previews |
| `--surface-2` | `#ECE5DA` | Deeper surfaces |
| `--accent` | `#C4552A` | Primary buttons, selection, focus |
| `--accent-hover` | `#A8451F` | Primary hover |
| `--accent-soft` | `#FDF0EC` | Accent tints |
| `--sage` / `--sage-soft` | `#7A8C6E` / `#E8EDE2` | Pro button, success |
| `--warn` / `--warn-soft` | `#B5862B` / `#FAEFD8` | Warnings, "deleted by staff", "no caption" |
| `--error` | `#B33A1F` | Errors, danger |
| `--text` | `#2A2118` | Body text |
| `--text-muted` / `--text-faint` | `#8A7D6F` / `#B7AB9C` | Secondary text |
| `--border` / `--border-strong` | `#DDD5C8` / `#C9BFAE` | Hairlines |
| `--radius` / `--radius-lg` | 6px / 10px | Corners |
| `--shadow-sm` / `--shadow-lg` | soft brown-tinted | Cards / modals |

The app has a single light theme.

### Typography

| Role | Face |
|---|---|
| Headings (`h1–h3`), brand wordmark fallback | **Cormorant Garamond** 600 |
| Body, buttons, inputs | **DM Sans** 400/500, 14px base |
| Prompts and code-like text | system monospace |

Loaded from Google Fonts in `index.html`.

### Components

- **Shell** — max width 1400px, stacked panels with serif headers and a small uppercase counter on the right
- **Buttons** — `.btn-primary` (terracotta), `.btn-secondary` (outlined surface), `.btn-ghost` (text), `.btn-danger` (error red), `.btn-pro` (sage), `.btn-tiny` (compact)
- **Status pills** — Pending, Preparing/Generating (with spinner), Done (sage), Error (red)
- **Modals** — dimmed overlay, 900px panel (`.modal-panel-wide` for History, Waitlist, Admin, Shopify), sticky footers where actions could scroll away, Esc to close
- **Lightbox** — full-screen dark overlay, image and caption, ✕, click outside or Esc; used everywhere an image can be enlarged
- **Loading** — spinner (`@keyframes spin`) and shimmer skeleton cards (`@keyframes shimmer`)
- **Template slots** — square tiles with label bar, hover edit hint, drag to reorder
- **Rows** — Fabrics queue, Waitlist and Shopify screens share one wrapping row layout (thumbnail, inputs, actions)

Some modals (History, Waitlist, Shopify, Admin) use inline style objects for layout so they render correctly regardless of stylesheet caching.

The Template Editor collapses to one column below 720px; rows wrap on phones, and the Waitlist was verified at 375px.

### Brand assets

`public/tm-logo.png` (monogram; also the favicon) and `public/tm-wordmark.png` (login screen). If the wordmark is missing, styled text *T. MANGHARAM* appears; a missing logo is simply hidden. The browser tab title is **T. Mangharam · Ecom Tool**.

The Daily Checkout page uses its own simpler styling (Segoe UI, blue and green buttons).

---

## 22. Performance & caching

| Measure | Effect |
|---|---|
| Browser-side compression before upload | Keeps requests under Vercel's 4.5 MB limit; faster uploads |
| One `/generate` call per fabric, templates in parallel | Each call under 60 s regardless of batch size |
| Immutable `Cache-Control` on every stored image | Repeat History opens load from the browser cache |
| `loading="lazy"` on History and Waitlist images | Only on-screen images download |
| Retries update the tile in place | No full-history reload after choosing (was a multi-second freeze) |
| Fingerprinted assets cached for a year; `index.html` never cached | Fast loads, instant deploys |
| **Thumbnails** (320 px, ~10 KB) in History, Shopify CSV picker and Admin grids | ~50× less image data when browsing; full-size only on enlarge/download/export. Before this, scrolling History queued dozens of 500 KB images and new retry images waited behind them (a pick screen once stayed blank ~2 minutes) |
| Generated images returned as R2 links, not base64 | Tiny API responses; far less Vercel Fast Origin Transfer (§4) |
| Retries reference stored photos by URL; picks copy inside R2 | No repeated uploads |
| History JSON gzip-compressed by the function | 4.9 MB → ~0.5 MB per open (before the 10-day retention shrank it further) |
| Retry candidates preloaded before showing *ready* | Compare / Choose opens with the image already loaded |
| Browser save queue | One save at a time — no server-side contention from your own burst of picks |

**Known bottleneck:** images are served from Cloudflare's `*.r2.dev` URL, which isn't CDN-cached and is rate-limited — the main reason a first History load can take a few seconds. The fix is binding a custom domain to the bucket, but that requires the domain's DNS on Cloudflare; `tmangharam.com` is registered with **eNom**, and moving its nameservers would affect the live store, so it hasn't been done.

---

## 23. Limits & retention

| Limit | Value |
|---|---|
| Active templates per user | 5 |
| Function request body (Vercel) | 4.5 MB |
| Upload size (multer) | 4 MB (Waitlist 5 MB) |
| Compression | Fabric 1600px/0.90 · Template 1400px/0.88 · Detail 1500px/0.85 · Flat 1400px square/0.90 · skipped for JPEGs under 1.5 MB |
| Gemini call timeout | 60 s |
| Function duration | 60 s (generate, templates, shopify-images) · 30 s others |
| Serverless functions | 12 of 12 (Hobby cap) |
| History | 10 days |
| Waitlist | 7 days |
| Audit log | 90 days |
| Admin cost table | last 30 days · activity feed last 120 runs |
| Shopify image copies | kept; up to 1000 per export call |
| Tag fields per product | 3 manual (plus unlimited from AI) |
| SEO description | 320 characters |
| r2.dev burst | ~816 image fetches, then `429`, recovers in ~20 s |
| Vercel Fast Origin Transfer (Hobby) | 10 GB per 30 days |
| Rewrites of one R2 file | ~1 per second (R2) — ~10 truly simultaneous History saves is the practical ceiling |
| Conditional save retry budget | 20 s per save (then "too many simultaneous saves") |
| Browser save queue retries | 3 automatic (2 s, 5 s, 10 s), then **Not saved · Retry** |
| Retry candidates (`fs-candidates/`) | deleted after 24 h; ≤300 per sweep |
| Thumbnails | 320 px on the short side, JPEG q72 (~10 KB) |
| Thumbnail backfill | ≤80 images per call |

---

## 24. Known limitations & risks

1. **Identity is trust-based.** Anyone who knows a username can act as that user, and `/api/generate` doesn't reject requests without a valid username. Admin data is protected by the PIN only.
2. **One shared file per kind of state.** Simultaneous saves no longer overwrite each other (§5), but R2 allows only about one rewrite of a file per second, so a very large burst of truly simultaneous saves (more than ~10, e.g. several people picking at once) can make some fail with a visible error. The browser queue keeps one person's saves well below that. Splitting History into per-run files would remove the ceiling if it's ever needed.
3. **Local development touches production data** (§4) — test on a Preview instead.
4. **At the function cap** — a new endpoint needs consolidation or a plan upgrade.
5. **Uncached `r2.dev` delivery** makes first History loads slow (§22).
6. **Originals and detail photos exist only for newer runs.** Older runs can't show ◉ Original or retry with the close-up; Gemini doesn't retain inputs, so they can't be recovered.
7. **History retries use the flat swatch**, a square crop, rather than the full original photo.
8. **Captions only on the first generate**, and only when facts are typed.
9. **The fabric queue lives in the browser tab** — reloading clears unsaved work (finished runs are in History).
10. **Generating retries are lost** if History is closed before choosing (picked saves continue in the queue). The save queue itself lives in the tab — closing the tab while saves are pending loses them (the browser warns first).
11. **Apps Script code isn't version-controlled** here; it lives only in Google.
12. **AI output is stochastic** — the same inputs can give different images; retries and Pro exist for this.
13. **Estimated costs only** — the real Google balance isn't available by API.
14. **Soft-deleted history is easy to trigger in bulk** — the cause of a stranded batch that had to be restored by date.
15. **`GET /api/models` is unauthenticated** (lists model names; doesn't expose the key).
16. **Hobby plan** — 10 GB/month Fast Origin Transfer with a pause (not a bill) when exceeded, and a non-commercial-use clause (§4).
17. **Staging isn't a copy of live data.** It starts empty; templates must be copied across, and it shares the real Gemini key (staging generations cost money).
18. **Preview automation secret** is a local file on one laptop (`.env.staging.local`); if lost, create a new one in Vercel.
19. **Vercel "Redeploy" defaults to Production** — see §4; rebuild staging with a push instead.
20. **Candidate sweep only runs during retries.** If no one retries for a while, unpicked candidates wait until the next retry to be deleted.

---

## 25. Operations runbook

### Release a change
Follow the **release checklist** in §4: branch → `npm test` + `npm run build` → push the branch → check the Preview on staging → approve → merge into `main` at a quiet moment → `git push origin main` → verify live → ask users to refresh. You can simply ask Claude: *"push to main"* once staging is approved.

### Roll back a bad release
Vercel → **Deployments** → the previous **Production** deployment → **⋯ → Promote**. Live again within seconds. Then fix the problem on a branch and release normally.

### Rebuild staging (e.g. after changing Preview variables)
Push a commit to the branch — an empty one works:
```bash
git commit --allow-empty -m "Rebuild staging"
```
```bash
git push
```
Don't use the Redeploy button (it defaults to Production).

### Copy live templates to staging
Read the live templates (`GET /api/templates` as a user on the live site), download each template image, then on the Preview: `POST /api/templates` (multipart `image`, `label`, with the bypass header) and `PATCH /api/templates/:id` with the live `prompt`, `description` and `altPattern` so they're exact copies. Live data is only read. Each upload makes one small Gemini call to describe the scene. (Claude can do this on request.)

### Emergency: turn off the conditional-write check
If saves start failing with "too many simultaneous saves" or 412-related errors after an R2 change: set `USE_CONDITIONAL_WRITES = false` in `api/_lib/storage.js` on a branch, verify on staging, release. Saves then behave like the old read-change-write (with the old risk of lost updates) until fixed.

### Backfill thumbnails
Only needed if images were saved without thumbnails (e.g. after restoring old data). Call `POST /api/history` `{ "action": "backfillThumbs", "limit": 60 }` with an `x-fs-user` header repeatedly until `remaining` is 0 (~60 images per 13 s).

### Rotate the staging R2 key
Cloudflare → R2 → **Manage API tokens** → delete and recreate `tm-ecom-staging` (Object Read & Write, *specific bucket* `tm-ecom-staging`) → in Vercel edit the **Preview** rows of `R2_ACCESS_KEY_ID` (Access Key ID) and `R2_SECRET_ACCESS_KEY` (**Secret Access Key**, not the "Token value") → push a commit to rebuild staging.

### Run the automated tests
```bash
npm test
```
All must pass before any push to `main`.

### Add or remove a team member
Edit `ALLOWED_USERS` (and `ADMIN_USERS` for admins) in Vercel, then rebuild Production. Usernames are lowercase.

### Change the admin PIN
Update `ADMIN_PIN` in Vercel (Production row) and rebuild Production.

### Improve a template that keeps needing retries
Admin → **Template health** to find it → Library → **Edit** its prompt, or **Crop** the scene.

### Change caption wording, fixed sections or allowed tags
Admin → **Captions** → edit → **Save caption settings**. Applies to new generations.

### Restore history a staff member lost
Admin → **Staff activity** → username (+ optional `YYYY-MM-DD`) → **Restore hidden history**.

### Check spend
Admin → **Cost & usage** for estimates; Google AI Studio billing for the real balance.

### Export products to Shopify
Header → **Shopify CSV** → pick → group & price → download → import into Shopify, up to ~100 products per file. Products arrive as drafts.

### Update the Daily Checkout webhook or weekly report
Edit in the Apps Script project → save → for the webhook, **Deploy → Manage deployments → Edit → New version**. For the weekly report, run `sendTestReport` to check; `setupWeeklyTrigger` reinstalls the schedule.

### Rotate R2 or Gemini keys
Replace the variable in Vercel (the right environment row), then rebuild that environment: push a commit to `main` for Production (or Promote the current deployment to rebuild with new variables), push to a branch for Preview. For the weekly report, also update its `GEMINI_API_KEY` Script Property.

---

## 26. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Pushed to `main` but the site didn't change | Build still running, failed, or the push went to another branch | Vercel → Deployments: look for a **Production** build; check `git status` shows `main...origin/main` |
| Pushed a branch but no Preview appeared | Vercel wasn't connected to GitHub when it was pushed | Settings → Git shows the repo; push a new (even empty) commit |
| Red pill **⚠ N not saved** / tile **⚠ Not saved** | A save failed after 3 automatic retries (offline, server error, or a very large burst of simultaneous saves) | Click **Retry** (pill or tile); no regeneration needed |
| Error *"Too many simultaneous saves to fs-history.json"* | More than ~10 truly simultaneous saves (e.g. several people/tabs at once) | Retry a moment later |
| Browser warns *"changes may not be saved"* when closing | Saves still queued or not saved | Wait for the pill to disappear, or click Retry |
| A picked replacement shows the old image after refresh | A save didn't complete (tab closed mid-save) — or, before Sept 2026, lost to overlapping saves | Pick again; watch the pill finish |
| Every save fails with 412 after an R2 change | Conditional writes rejected (e.g. ETag format change) | Emergency switch in §25; investigate on staging |
| Staging: History/Templates error *"R2 get failed (403)"*, *SignatureDoesNotMatch* | Wrong Preview R2 keys (often the "Token value" pasted as the secret) | §25 *Rotate the staging R2 key* |
| Staging site asks for a Vercel login | Preview protection (expected) | Log in to Vercel, or use the bypass secret |
| Vercel's Redeploy dialog shows **Production** | Its default | Cancel; rebuild staging by pushing a commit |
| Terminal: *"The token '&&' is not a valid statement separator"* | Windows PowerShell 5.1 | Run the commands one per line |
| Email: *Fast Origin Transfer at 100%* | Too much data through functions | Check §4 measures are live; consider Pro |
| *Failed to fetch* when downloading | Cached non-CORS image reused | Already handled by cache-busting; hard refresh |
| A card errors after ~60 s | Gemini timeout | ⟳ on that card, or Retry failed |
| Result keeps the template's pattern, only recoloured | Model slipped past the guard | Retry, ×3 or Pro; tighten that template's prompt |
| Embroidery comes out looking printed | No close-up | Attach **＋ Detail** and regenerate |
| Staff member sees "0 images" on runs | Images soft-hidden | Admin → Restore hidden history (by date) |
| History slow to open | `r2.dev` delivery (thumbnails make this much lighter) | Search by SKU to narrow; repeat opens are cached |
| Retry Compare/Choose opened blank | (Fixed) candidates now preload before showing ready | Wait a moment; if persistent, check the network |
| Upload rejected | File over the size limit or wrong type | Use jpg/png/webp; the app compresses automatically |
| "Maximum 5 templates" | Active set full | Deactivate one first |
| Some Shopify images missing after import | Throttling on very large imports | Split into files of ≤100 products and re-import |
| No caption written | No Colour/Adjective/Material/tags typed | Fill at least one field before generating |
| Admin says "Invalid admin PIN" or "not configured" | Wrong PIN, or `ADMIN_PIN` unset | Re-enter, or set it in Vercel and redeploy |
| Captions not reaching the sheet | Webhook unset, wrong token, or script not redeployed | Check the two variables and the Apps Script deployment |
| Weekly email didn't arrive | Trigger missing or wrong time zone | Set time zone to IST, run `setupWeeklyTrigger`, test with `sendTestReport` |

---

## 27. File map

```
fabric-styler/
├── ECOM_TOOL_GUIDE.md          this document
├── PROJECT_OVERVIEW.txt        older overview (out of date)
├── README.md                   original prototype readme (out of date)
├── index.html                  app shell, fonts, favicon, title
├── package.json                dependencies and scripts (build, test)
├── package-lock.json           exact dependency versions
├── vite.config.js              React plugin; /api proxy → production
├── vercel.json                 build output and cache headers
├── .vercelignore               excludes backend/ and frontend/
├── .gitignore                  what never goes to GitHub (secrets, builds, legacy)
├── .gitattributes              LF line endings
├── .claude/launch.json         local dev server config (port 3000)
├── .claude/settings.local.json Claude permission to git push (local only, not committed)
├── .env.staging.local          Preview bypass secret (local only, not committed)
│
├── tests/                      npm test
│   ├── storage-concurrency.test.cjs   simultaneous saves never lose data
│   ├── saveQueue.test.mjs             browser save queue behaviour
│   └── helpers/fakeR2.cjs             in-memory R2 with ETags (weak for >1 KB)
│
├── api/                        Vercel serverless functions (12)
│   ├── login.js                username check
│   ├── templates.js            list, upload, reorder, backfill alt
│   ├── templates/[id].js       edit, activate, delete
│   ├── template-image.js       replace image after crop
│   ├── generate.js             image generation, captions, history, audit, sheet; stores images in R2, returns links; candidate sweep
│   ├── history.js              list (gzip), selective delete, clear all, restore, thumbnail backfill
│   ├── history/[id].js         delete one run
│   ├── history-add.js          save a chosen retry (upload or server-side copy of a candidate) + thumbnail
│   ├── waitlist.js             staging area
│   ├── shopify-images.js       clean-named image copies
│   ├── admin.js                dashboard data, caption settings
│   ├── models.js               debug model list
│   └── _lib/                   shared server code
│       ├── storage.js          R2 client; conditional writes (updateJson), weak-ETag fix, listing
│       ├── thumbs.js           320 px thumbnails (sharp); blob lists for deletes
│       ├── respond.js          gzip JSON responses
│       ├── auth.js             usernames, roles, admin PIN
│       ├── manifest.js         template library (updateManifest)
│       ├── active.js           per-user active sets
│       ├── prompts.js          prompt builder, guard, detail clause
│       ├── captions.js         caption settings, generation, tags, description
│       ├── alttext.js          alt pattern generation and filling
│       ├── history.js          history read, updateHistory (safe save + pruning), visibility
│       ├── audit.js            event log (safe appends)
│       ├── waitlist.js         waitlist storage (safe updates)
│       └── sheets.js           captions sheet webhook
│
├── src/                        React app
│   ├── main.jsx                entry
│   ├── App.jsx                 state, generation, retries, header, modals, save pill
│   ├── index.css               design system and all styles
│   ├── components/
│   │   ├── Login.jsx, Brand.jsx, StatusBar.jsx
│   │   ├── TemplateManager.jsx     active templates strip
│   │   ├── TemplateLibrary.jsx     library modal
│   │   ├── TemplateEditor.jsx      label, prompt, alt pattern
│   │   ├── TemplateCropper.jsx     template crop
│   │   ├── FabricQueue.jsx         fabrics panel
│   │   ├── FabricCropper.jsx       crop, rotate, tilt
│   │   ├── ResultsPanel.jsx        results and captions
│   │   ├── CompareRetryModal.jsx   current vs new
│   │   ├── RetryThreeModal.jsx     pick one of three
│   │   ├── WaitlistModal.jsx
│   │   ├── HistoryModal.jsx
│   │   ├── ShopifyExportModal.jsx
│   │   ├── AdminDashboard.jsx
│   │   ├── SaveIndicator.jsx       "Saving N…" / "N not saved · Retry" pill
│   │   └── FabricUploader.jsx, ResultsGrid.jsx   unused legacy
│   └── utils/
│       ├── api.js              identity header, admin PIN
│       ├── fabrics.js          queue entry factory
│       ├── compressImage.js    browser resize/encode
│       ├── cropImage.js        flat swatch, crop, rotate
│       ├── dataUrlToBlob.js
│       ├── zip.js              downloads and zips
│       ├── saveQueue.js        one-at-a-time History save queue, auto-retry, tab-close warning
│       ├── preload.js          wait for an image to download before showing it
│       ├── captionCsv.js       captions CSV, CSV helpers
│       └── shopifyCsv.js       Shopify CSV builder and rules
│
├── public/
│   ├── daily-checkout.html     daily operations form
│   ├── tm-logo.png, tm-wordmark.png, README-branding.txt
│   └── .vercel/                stray project link (not used)
│
├── scripts/migrate-to-r2.js    one-time Blob → R2 migration
├── backend/, frontend/         original Express prototype (not deployed)
└── .env.local                  legacy Vercel Blob variables (not committed)
```

---

## 28. Feature history

In roughly the order they were built:

1. Template scenes + Gemini re-skinning; per-card regenerate; retry failed; zipped downloads
2. Move from Vercel Blob to Cloudflare R2
3. Local flat swatch; aspect ratio matched to each template; ×3 variations; Pro model
4. Usernames, roles and admin PIN; Admin dashboard (template health, cost, activity)
5. History (30 days, later 10) with per-user visibility and soft deletes
6. Template Library, cropping, drag-to-reorder; **per-user active templates**
7. Fabric cropper with rotate and tilt
8. Waitlist for phone-to-laptop staging
9. Captions: deterministic titles, hybrid descriptions, editable fixed sections, costs in INR, Captions CSV, Google Sheet
10. Per-template SEO alt text
11. Daily Checkout Sheet page; rename to "Ecom Tool"
12. History multi-select delete; restore hidden history (later by date)
13. Compare view for retries; retry indicators
14. Downloads as one zip with a folder per SKU
15. Close-up detail photo (IMAGE 3), captured on the Waitlist and carried through
16. History SKU search; stored originals with ◉ Original view and typed facts
17. Immutable image caching and lazy loading
18. Detail photos saved to History for retries
19. Waitlist row layout with enlargeable images
20. Weekly report email (Apps Script + Gemini)
21. Approved-tag whitelist with rule-based tags and typo correction
22. Daily checkout: cancelled orders, amounts, order numbers
23. Non-blocking background retries with Compare / Choose, on both screens
24. Shopify CSV export: product picker, colour-variant grouping, half pricing, clean image filenames, full field rules
25. Per-user History; combined all-users History only in the PIN-locked Admin dashboard
26. Fast Origin Transfer reductions: images returned as R2 links, retries by stored URL, server-side copies on pick, gzip History
27. History retention cut from 30 to 10 days
28. Thumbnails for History, Shopify picker and Admin grids (existing images backfilled); retry candidates preloaded before *ready*
29. Automatic cleanup of unpicked retry candidates after 24 hours
30. Git version control, private GitHub repo, Vercel Git integration, separate staging bucket and Preview environment, release checklist
31. Safe saving: conditional writes (ETag / If-Match) for every shared JSON file, including the weak-ETag fix
32. Browser save queue with the *Saving…* pill, automatic retries, **Not saved · Retry**, and tab-close warning
33. Automated tests (`npm test`) for concurrent saving and the save queue
