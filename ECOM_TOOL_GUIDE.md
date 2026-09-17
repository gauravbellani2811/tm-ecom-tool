# Ecom Tool — Complete Guide

The internal product-photography, captioning and catalogue tool for **T. Mangharam** (fabric store).
Live at **https://tmphotography.vercel.app**

This document describes everything about the system as it is currently deployed: what it does, every screen and button, how data flows, where it's hosted and stored, the AI prompts, the Shopify export format, the Google Sheets automations, the design system, limits, costs, known gaps, and how to operate it.

> Supersedes `PROJECT_OVERVIEW.txt`, which predates the move to Cloudflare R2, per-user templates, captions, Waitlist, History tools, Admin dashboard and Shopify export.

---

## Contents

1. [What the tool is for](#1-what-the-tool-is-for)
2. [Who uses it and how work flows](#2-who-uses-it-and-how-work-flows)
3. [Architecture at a glance](#3-architecture-at-a-glance)
4. [Hosting & deployment (Vercel)](#4-hosting--deployment-vercel)
5. [Storage (Cloudflare R2)](#5-storage-cloudflare-r2)
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
| `gaurav2811` | **admin** (owner) | Everything, plus the Admin dashboard and full History visibility |
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
| Backend | Vercel serverless functions, CommonJS Node, `multer` (multipart), `uuid` |
| AI | `@google/genai` — Gemini image and text models |
| Storage | Cloudflare R2 via `aws4fetch` (S3-compatible signing). **No database.** |
| Sheets | Google Apps Script web apps (no Google Cloud project or service account) |

---

## 4. Hosting & deployment (Vercel)

| Item | Value |
|---|---|
| Live URL | https://tmphotography.vercel.app |
| Vercel project | `tm_photography` (team `gaurav-tm-projects`) |
| Plan | Hobby |
| Build | `npm run build` → `vite build` → `dist/` |
| Functions | every file in `api/` not starting with `_` (the `api/_lib/` folder is shared code, not endpoints) |

### Deploying

Always deploy **from the `fabric-styler` folder**:

```bash
cd fabric-styler
vercel --prod --yes
```

A successful deploy ends with `Aliased https://tmphotography.vercel.app`.

> **Pitfall:** the parent folder (`ecom-photographer`) is linked to a *different* Vercel project, and a leftover link exists in `public/.vercel/`. Running `vercel --prod` from the wrong folder deploys to a stray project while the live site stays unchanged. The correct link lives in `fabric-styler/.vercel/project.json` (project `tm_photography`).

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
| `history`, `history/[id]`, `history-add`, `templates/[id]`, `template-image`, `waitlist`, `admin` | 30 s | varies (multipart routes disable it) |

### Function count — at the cap

There are **12** function files, which is Vercel Hobby's per-deployment limit:

`admin`, `generate`, `history`, `history/[id]`, `history-add`, `login`, `models`, `shopify-images`, `template-image`, `templates`, `templates/[id]`, `waitlist`.

A new endpoint therefore requires merging an existing one (e.g. folding `history-add` into `history`, or removing the debug `models` endpoint) or upgrading the plan.

### Local development

```bash
cd fabric-styler
npx vite --port 3000        # also configured in .claude/launch.json as "fabric-vite"
```

`vite.config.js` proxies every `/api` request to **production** (`https://tmphotography.vercel.app`).

> ⚠️ **Local dev reads and writes live data.** Anything you generate, delete or restore from `localhost:3000` happens to the real History, templates and Waitlist. Deploy backend changes *before* exercising destructive features locally — a delete sent to an older production backend once soft-hid a staff member's entire history.

`npm run dev` runs `vercel dev` instead (local functions), which needs the environment variables available locally; the sensitive ones can't be pulled from Vercel.

---

## 5. Storage (Cloudflare R2)

All persistent state lives in one R2 bucket. There is no database: each kind of state is a single JSON document, read, modified and written whole.

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
| `fs-candidates/{uuid}.jpg` | Retry variations not yet picked (picked ones are copied into `fs-history/`) | not cleaned up automatically |
| `waitlist/{user}/{id}.jpg`, `…/{id}-detail.jpg` | Waitlist photos | 7 days |
| `shopify/{SKU}_{Template}.jpg` | Clean-named copies made by the Shopify export | permanent (overwritten per SKU/template) |

Pruning is lazy: it happens when the relevant JSON is next read.

### Storage helpers (`api/_lib/storage.js`)

| Function | Purpose |
|---|---|
| `putImage(key, buffer)` | Upload JPEG with `Cache-Control: public, max-age=31536000, immutable` |
| `putJson(key, obj)` | Upload JSON state |
| `getJson(key)` | Authenticated read; `null` if missing |
| `copyObject(src, dest)` | Server-side copy (no bytes through the function) |
| `deleteKeys(keys)` | Parallel best-effort deletes |
| `urlToKey(url)` / `publicUrl(key)` | Convert between public URLs and keys |

Image keys are never overwritten with different bytes (retries get a new id), which is what makes the year-long immutable cache safe.

### History of the storage layer

The app originally used Vercel Blob with versioned manifest filenames to dodge CDN caching. It moved to R2; `scripts/migrate-to-r2.js` was the one-time copy. The `BLOB_*` variables in `.env.local` are leftovers from that era.

---

## 6. Environment variables

Set in Vercel → Project → Settings → Environment Variables (Production). Sensitive values are write-only in Vercel and cannot be pulled locally.

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

Changing a variable takes effect on the next deploy.

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
6. Saves to **History** (unless `skipHistory`): each generated image, the flat swatch, the **original** photo, the **detail** photo, the caption, and the typed facts. Runs are upserted by `runId`, and images by template, so retries replace in place.
7. Appends the caption to the **Google Sheet**, if configured.
8. Returns `{ results, caption }`.

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
4. Choosing swaps the tile at once and closes the modal; the image saves in the background (*Saving…*). If the save fails, the tile reverts and an error is shown.

Candidates are generated with `skipHistory`, so nothing reaches History until you choose; the choice is saved via `/api/history-add`, which replaces that template's image in the run.

**Fabric source for retries**
- Results panel: the in-memory fabric photo and detail photo.
- History: the run's stored **flat swatch** (the square crop) plus the stored detail photo if present.

Errored cards on the Results panel have no image to compare, so their **⟳** retries and replaces directly.

Retries in progress live in the open screen; closing History discards any unfinished ones.

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
- **Clear all** — admin: permanently deletes all history; staff: hides your own runs
- **Select all / Clear** — image selection
- **⤓ Captions (N)** — Captions CSV of every captioned run in view
- **⤓ Download selected** — one zip, a folder per SKU
- **Delete selected** — admin: permanent; staff: soft hide

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

All routes read the `x-fs-user` header. "Admin + PIN" also requires `x-fs-admin-pin`.

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
| `GET /api/history` | user | Your own runs · `?scope=all` (admin + PIN): every user's runs incl. hidden |
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

---

## 24. Known limitations & risks

1. **Identity is trust-based.** Anyone who knows a username can act as that user, and `/api/generate` doesn't reject requests without a valid username. Admin data is protected by the PIN only.
2. **Last write wins.** Each state file is read, modified and written whole. Two writes to the same file at the same moment (e.g. two people editing History simultaneously) can lose one change.
3. **Local development touches production data** (§4).
4. **At the function cap** — a new endpoint needs consolidation or a plan upgrade.
5. **Uncached `r2.dev` delivery** makes first History loads slow (§22).
6. **Originals and detail photos exist only for newer runs.** Older runs can't show ◉ Original or retry with the close-up; Gemini doesn't retain inputs, so they can't be recovered.
7. **History retries use the flat swatch**, a square crop, rather than the full original photo.
8. **Captions only on the first generate**, and only when facts are typed.
9. **The fabric queue lives in the browser tab** — reloading clears unsaved work (finished runs are in History).
10. **In-progress retries are lost** if History is closed before choosing.
11. **Apps Script code isn't version-controlled** here; it lives only in Google.
12. **AI output is stochastic** — the same inputs can give different images; retries and Pro exist for this.
13. **Estimated costs only** — the real Google balance isn't available by API.
14. **Soft-deleted history is easy to trigger in bulk** — the cause of a stranded batch that had to be restored by date.
15. **`GET /api/models` is unauthenticated** (lists model names; doesn't expose the key).

---

## 25. Operations runbook

### Deploy a change
```bash
cd fabric-styler
npm run build
vercel --prod --yes
```
Confirm `Aliased https://tmphotography.vercel.app`.

### Add or remove a team member
Edit `ALLOWED_USERS` (and `ADMIN_USERS` for admins) in Vercel, then redeploy. Usernames are lowercase.

### Change the admin PIN
Update `ADMIN_PIN` in Vercel and redeploy.

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
Replace the variable in Vercel and redeploy. For the weekly report, also update its `GEMINI_API_KEY` Script Property.

---

## 26. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Deploy "succeeds" but the site doesn't change | Deployed from the wrong folder | `cd fabric-styler` and redeploy |
| *Failed to fetch* when downloading | Cached non-CORS image reused | Already handled by cache-busting; hard refresh |
| A card errors after ~60 s | Gemini timeout | ⟳ on that card, or Retry failed |
| Result keeps the template's pattern, only recoloured | Model slipped past the guard | Retry, ×3 or Pro; tighten that template's prompt |
| Embroidery comes out looking printed | No close-up | Attach **＋ Detail** and regenerate |
| Staff member sees "0 images" on runs | Images soft-hidden | Admin → Restore hidden history (by date) |
| History slow to open | `r2.dev` delivery | Search by SKU to narrow; repeat opens are cached |
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
├── package.json                dependencies and scripts
├── vite.config.js              React plugin; /api proxy → production
├── vercel.json                 build output and cache headers
├── .vercelignore               excludes backend/ and frontend/
├── .claude/launch.json         local dev server config (port 3000)
│
├── api/                        Vercel serverless functions (12)
│   ├── login.js                username check
│   ├── templates.js            list, upload, reorder, backfill alt
│   ├── templates/[id].js       edit, activate, delete
│   ├── template-image.js       replace image after crop
│   ├── generate.js             image generation, captions, history, audit, sheet
│   ├── history.js              list, selective delete, clear all, restore
│   ├── history/[id].js         delete one run
│   ├── history-add.js          save a chosen retry
│   ├── waitlist.js             staging area
│   ├── shopify-images.js       clean-named image copies
│   ├── admin.js                dashboard data, caption settings
│   ├── models.js               debug model list
│   └── _lib/                   shared server code
│       ├── storage.js          R2 client
│       ├── auth.js             usernames, roles, admin PIN
│       ├── manifest.js         template library
│       ├── active.js           per-user active sets
│       ├── prompts.js          prompt builder, guard, detail clause
│       ├── captions.js         caption settings, generation, tags, description
│       ├── alttext.js          alt pattern generation and filling
│       ├── history.js          history storage, pruning, visibility
│       ├── audit.js            event log
│       ├── waitlist.js         waitlist storage
│       └── sheets.js           captions sheet webhook
│
├── src/                        React app
│   ├── main.jsx                entry
│   ├── App.jsx                 state, generation, retries, header, modals
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
│   │   └── FabricUploader.jsx, ResultsGrid.jsx   unused legacy
│   └── utils/
│       ├── api.js              identity header, admin PIN
│       ├── fabrics.js          queue entry factory
│       ├── compressImage.js    browser resize/encode
│       ├── cropImage.js        flat swatch, crop, rotate
│       ├── dataUrlToBlob.js
│       ├── zip.js              downloads and zips
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
