# Offer templates: Text & Graphics masters and their creatives

Create one **master** from an existing offer creative, analysed and prepared once; then make any number of **creatives**
from it: new copy, logos, fonts, colours and positions on the master's saved artwork, with **no new OCR, decomposition or
image generation** through manual reuse. **Generate AI Variations** is a separate, explicitly priced style request:
one saved master becomes 3, 4 or 5 independently editable style variations of itself (same layout, artwork, logos and
text; other fonts, colours, sizes and background tint).

Workspace: **OpenAI + Seedream test → Offer Templates** (also reached from **Template Studio → Create Template → Text &
Graphics**). Product with Text templates (products, characters, text and logos as layers) have their own flow: see
[PRODUCT_TEMPLATES.md](PRODUCT_TEMPLATES.md); Template Studio's generated posters stay on its own tab.

```
Template creation   Upload ─► Scan & Review ─► Prepare & Save
                    (local OCR + pixel analysis)   (clean background, local; optional Seedream layers, paid, confirmed;
                                                    an immutable published revision)
Template reuse      Choose template ─► Edit content ─► Open in Editor ─► Save creative / Export PNG
                    (saved files only: no OCR, no Seedream, no AI)
AI variations       Choose saved master ─► Count + format ─► Check template and cost ─► Generate
                    (one structured AI style request; at most one correction; the layout stays the master's)
                    ─► Preview / Open creative ─► Edit / Save / Reopen / Export PNG
                    (all subsequent editing uses saved objects; no further AI or OCR)
Decomposition       Any saved creative ─► Send to Decomposition ─► run dashboard ─► Open in editor ─► Edit / Export PNG
                    (a decomposition run made from the creative's own elements: free, no OCR, Seedream or AI)
Background repair   Edit master ─► Make it again ─► compare with the saved version ─► Approve ─► Save master (new version)
                    ─► each creative: Use the newer background (explicit; only when nothing but the background changed)
```

## What runs where

| Step | What runs | Cost |
| --- | --- | --- |
| Scan | tesseract.js on this server (model from `node_modules`, no network): one read of the whole poster, then one read per text line; pixel analysis for logo cards, QR codes, badges, brand marks and text plates; font matching against the bundled offer fonts | free; once per source (saved; asking again reads nothing) |
| Review | corrections in the browser, saved to the server | free |
| Clean background | local: text ink, plates and logo slots removed; plain fields continued, repeating patterns copied from one repeat away (the lattice is measured from the artwork), anything else a smooth estimate | free; always an estimate the administrator approves |
| Artwork layers (optional) | the protected template's own Seedream 5.0 Pro Layerize request, with the **clean background only** (never the text or logos), priced and confirmed | paid, explicit |
| Reuse, edit, editor, save, export | stored files and JSON only | free |
| Generate AI Variations | existing OpenAI structured provider and Studio worker; one design request, at most one bounded correction; local font measurement and PNG rendering | paid, explicit estimate and confirmation; no image-generation call |

## AI Creative Variations: style variations of a saved master (2026-10-20, recipe v4)

**What it is:** 3, 4 or 5 *style variations of the master itself*, the way the reference tent cards vary one design: the
same artwork, borders, decoration, logos, QR codes, text and positions, with different fonts and weights, text colours,
sizes, alignment within each text area, shape colours and a subtle background tint. It is **not** a new composition: no
element is moved, no text is rewritten, nothing is added or removed, and no new picture is drawn.

Open **OpenAI + Seedream test → Offer Templates**. Each published master's card offers **Reuse Template** (manual, free,
unchanged) and **Generate AI Variations**. The AI screen has three plain steps:

1. **Choose your options**: 3, 4 or 5; **Aspect ratio**, defaulting to **Same as this template** (e.g. 1820 × 2420, "about
   3:4"), with every standard format after it (another format shows the whole template fitted inside with a margin:
   nothing is moved or cropped); an optional style direction ("bold and festive", "calm and premium"). A short list says
   what stays exactly as it is, what changes, that editing afterwards never uses AI and that the template is not changed.
2. **Check your template and the cost**: free, no provider call. It reports what is left out and why (a text box drawn in
   review and never filled in; a blank picture) and runs the **template check** below. On a server with the offline
   test provider a **Test mode** notice says that no real AI runs and nothing is charged.
3. **Generate N editable creatives**: queues one paid job (explicit cost confirmation, approved maximum, master revision,
   idempotency key; one active batch per master; if the template check found missing text, also the explicit "Generate
   anyway, without fixing the template" choice, enforced by the server).

Results: "N of M creatives ready", each with its first-version preview, its style idea, **Open creative** and **Preview**
(your template beside the variation). Designs that fail FrameFlow's checks are listed with the reason ("Some designs did not
pass FrameFlow's checks, so they were not saved"); a failed job saves nothing and says so; the recorded cost (or "no charge
(test mode)") is shown.

### The template check (before any cost is approved)

`server/src/templateStudio/masterCreatives/readiness.ts` runs Scan Again's own reading of the original poster read only (local
OCR; crops discarded; nothing written; the master's counters untouched; cached per published revision; about 8 s the first
time) and compares it with the published revision. Text the poster has and the master lacks is reported, with whether it
is still part of the clean background (the pixels there are the poster's own). On the user's Tent-Card-1 it finds
**“3-6-9-12-18-24”**, still in the background; on Easy EMI nothing. The screen then says what is missing and how to fix it
(**Edit master → Scan Again**, tick the new text, apply, make the clean background, save the master) and only generates on
the explicit choice. Baked-in text is shown as it is in the artwork (not editable, not restyled).

`content.ts` prepares what the request uses: words of a line are joined as the poster draws them, measured with each word's
own font file ("EM" + "I", split by the scan and a review edit, is **"EMI"**); a review text box still reading its default
"Text" and a crop of one plain colour are left out and reported. Every remaining group and picture appears in every option.

### What the AI decides and what FrameFlow guarantees

`server/src/templateStudio/masterCreatives/plan.ts`. The live path uses the configured `STUDIO_PLANNER_MODEL` (strict
structured output, schema `editable_offer_style_variations`). The request carries the original poster and its clean artwork
(both at low detail); every text group with its category, alignment, area and lines (text, face, size, colour and what is
behind each line: `field`, its plate's colour, or the artwork's own colour there); the plates; the bundled fonts with their
faces; the field colour. Per option the AI returns only a name, a one-sentence idea, a field tint and, per group, alignment,
upper case, letter spacing and per line a face, colour and size scale (0.8–1.25), plus plate colours.

FrameFlow then lays out every line itself on its **saved baseline inside its saved area** (or inside its plate), measured
with the real font file exactly as Konva draws; a wider or taller face shrinks as little as needed so it never leaves its
area, rises at most a little above its original ink and never reaches the line above or below. Checks, applied before
anything is saved: every group styled exactly once with one style per line; legal text keeps its letter case; plates exist;
exact font faces (a missing face is asked to be corrected, else the nearest is drawn and noted); no line shrunk below 62%
of its asked size; no glyph missing; no line running into another group's line or a logo; WCAG contrast at least 3:1
(4.5:1 for small text) against the real colour behind each line (the tint, the plate, or drawn artwork such as an old pill);
the tint within 0.2 relative luminance of the original field; and options that look different (each its own headline face
or case; not the same tint with the same headline colour). All problems go into one bounded correction; if it still fails,
the options of the better paid answer that pass are saved and the rest reported; with none, the job fails.

### Editable data and persistence

Each option is a normal `CreativeInstance` (`creative-cr-<hash>.json`): its canvas, the master's own groups (same ids and
alignment as chosen), one text per word on its saved baseline with font, weight, style, size, letter spacing and colour
(`wordId` kept where a word maps 1:1), the plates as shapes at their saved boxes, every logo at its saved box, the artwork
as a locked image flagged `artwork` (`cra-<creative>-art-<sha>.png`, its field tinted), logo copies whose field edge follows
the tint (`cra-<creative>-logo<n>-<sha>.png`, the logo itself unchanged), the order back to front artwork → shapes →
pictures → words, the master id and revision, and immutable `generation` provenance (job, format, count, model, provider
`openai` or `offline-mock`, recipe and preview files). Creative Studio and the Konva editor (Open in Editor → Save creative →
Export PNG at the creative's own size) edit it with no AI or OCR call.

Routes (Template Studio access guard): `GET /api/template-studio/master-creatives/:masterId` (batches: progress, errors,
provider, canvas, saved creatives with preview and idea, skipped designs), `POST …/:masterId/estimate` (validation, the
template check, cost, provider; no provider request), `POST …/:masterId` (queue after `confirmCost`, approved estimate, master
revision, idempotency key and, when text is missing, `acknowledgeMissingText`). Jobs: `generate_master_creatives` (stages
`design_master_creatives`, paid, and `save_master_creatives`, free) on the existing Studio DB, worker, usage ledger and
budget reservations. The job snapshot records the master revision, source hash, canvas, options, model, reasoning effort,
token limit, exact system/user prompts, image count, recipe version `4`, provider and the template check's result; the
worker never reads the poster again. `ai-<job-hash>.json` stores the recipe, input, styles, correction, usage, counts,
creative ids and skipped designs; `ai-<job-hash>-<index>.png` the first version. Everything is validated and rendered before
any file is written; deterministic ids mean a resumed save never overwrites a creative or its edits; uncertain paid work is
never resent. Existing masters, revisions, manual creatives and their assets are never written.

### What it cannot do (by design or not built)

- New copy, a new offer, new graphics (the reference's "Golden days… CASHBACK", "Ask for NO-COST EMI", the "Golden Onam Days"
  badge, a QR code): content changes, not styles. Do them after generating, for free, in Creative Studio (rewrite a group,
  **Add picture**), or make a master from such a poster. Drawing new illustrations would need an image model (paid, not built).
- Other formats do not re-lay out the master: it is fitted whole, with a margin (re-arranging would break "keep every
  element in place").
- Artwork leftovers that are not text (stray dots, a smudge where a box was cleaned) are not detected in the picture itself;
  they show as in the approved clean background. A background made by an older clean-up is reported (see "Background
  repair"); fix it in the master (Make it again, approve, save) and update each creative.
- Never run against a real model with this recipe (offline test provider only). The one earlier live run (recipe 2, free
  composition) is the "before" in the checkpoint.

## Send to Decomposition (2026-10-21)

Every saved creative (manual or AI, any format) has **Send to Decomposition**: in the creative (next to Open in Editor) and on
each AI result card. The server (`master/creativeRun.ts`) builds an ordinary decomposition run from what the creative
already knows, with `createComposedRun` (the same finished-run writer the creative variants use), so the run dashboard,
Saved Runs, layer previews, the artifacts download and the editor treat it like any other run:

- **Layers**, back to front in the creative's own order, each at its saved place on the creative's own canvas: the
  background artwork **in its objects** (see below: a base, the border, each illustration or ornament), every visible
  shape, every visible logo / QR / picture, and one layer per text group. The layers over each other equal the creative as
  it is drawn (reconstruction checked pixel for pixel in the tests).
- **No paid or OCR call**: diagnostics show ₹0, 0 calls; planner and Seedream say "Not used". Never labelled as a provider
  decomposition (eyebrow "Saved creative · no AI", origin `master-creative`, `composed.source: 'master-creative'`).
- **Editor import** (`client/src/features/masterTemplates/creativeRun.ts`): the background and pictures open as image layers
  (the background locked; pictures keep their proportions when replaced), every text as **native editable text** (from the
  run's `creative` record, not its text pictures) and every plate as a native shape. It is a design of its own
  (`importedFrom: { templateId: master, resultId: 'run-<runId>', runId }`), not linked to the creative: saving it never
  writes to the creative or the master. Opening the same run again switches back to that design (edits kept).
- **Size**: when the creative's largest text is beyond the editor's 512 px font limit (Tent-Card-1's "EMI"), the design opens
  scaled down and records `variant.sourceSize`; **Export PNG** still writes the creative's own size (1820 × 2420). Resizing
  the canvas removes `sourceSize` (the export then has the new canvas size).
- **Idempotent**: one run per creative revision (`run.creative.creativeRevision`); asking again (double click, retry, reload)
  returns it (`created: false`); a later revision gets its own run; earlier runs stay.
- **Finer splitting** (a flower apart from the leaves it lies on) is image decomposition (Seedream, paid): the master's own
  optional, confirmed decomposition (Edit master → 2 · Artwork layers). Once a master has those layers, its creatives' runs
  are cut along them (below); nothing is sent to a provider by Send to Decomposition.

### The background artwork in objects (`master/artworkObjects.ts` + `master/artworkRebuild.ts`, local, free)

**Version 3 (runs carry `creative.version: 3`; version 1–2 runs are kept but never reused):**

- **Base rebuilt from the template's structure** (`levelsOf`, `fillLevels`): nested rectangles: the plain page (judged on the
  picture's edge), the panel (its rows and columns where it covers most of the row; edges pushed out ≤ 16 px to the strip
  between border dots), its pattern's two repeats measured on the panel itself (`measureRepeat`, a lightly softened
  comparison, so faint or slightly noisy lattices count); every hidden pixel is the page's colour or copied from the nearest
  exact repeat of the panel (along a side when beside it, so edges stay straight). What is not like that falls back to the
  clean background's fill. A second pass (`residualsOf`) gives an object the pixels next to it that are neither the pattern
  nor the page (its white strokes over the panel, its soft edge); a pixel between two parts of one object is the object's
  unless the panel's pattern shows there (`patternShows`).
- **Border made whole** (`borderGrid`): its dots along the four sides at their spacing and in their order of colours
  (lime/teal alternating); hidden ones are drawn again from a visible dot of the same colour, only where an illustration
  covers them; dots touching an illustration (≥ 70 % of their shape visible) go back to the border; off-grid dots go to the
  illustration beside them.
- **Edges** (`unmix`): each object's rim pixel is its own colour over the rebuilt background at an opacity worked out from
  both colours, so no field colour stays as a halo. Recombined layers: 0.006–0.007 % of pixels visibly different from the
  creative (rims), mean 0.03–0.05 levels.

Earlier (version 2):

Before, the whole background was one flat "Background artwork" layer: the run builder drew it as one picture (and even a
master decomposed with Seedream had its layers merged back into one). Now:

1. **Ground**: the colours that fill areas of the picture (present in a cell and the four cells around it, in a tenth of
   the picture: the page, the panel's field, the lattice's lines) and the blends between them. For an AI creative they are
   measured where its artwork is drawn, plus the colour around it. Thin outlines (a ring of dots) are never ground.
2. **Objects**: everything else, in connected pieces; ground enclosed by a drawing (a ring's inside, white dots on a boat)
   belongs to it. Pieces of one repeated small shape along the four sides of a rectangle are the **Border** (other repeated
   pieces: "Repeated ornaments"); other pieces close together are one object (leaves, flower and vine at the top right).
   Names say where each is ("Artwork · top right").
3. **Cut**: each object keeps the picture's exact pixels (with a 1 px edge and any soft fringe); the **base** is the picture
   with the objects taken out and the field continued behind them by the clean background's own fill (plain fields exactly,
   the lattice from one repeat away, else a smooth estimate). Outside the objects the base is the picture's own pixels, so
   base + objects = the picture, pixel for pixel.
4. **A decomposed master** (Seedream layers): a manual creative gets those layers as they are; an AI creative's own artwork
   is cut along their shapes (mapped onto its canvas), so tints and other formats stay exact (`splitByLayers`).

Results on the saved masters (copies): Easy EMI → base, Border, "Artwork · bottom right" (boat + umbrella + flag),
"Artwork · top right" (leaves + flower + vine); the same in 9:16. Tent-Card-1 (version 1) → the same plus its baked-in
"3-6-9-12-18-24" pill and four version-1 leftovers (the "Text" smear's lower half, the marks above "available"), each its own
layer (hide or delete them in the editor; a repaired version 2 has none). About 10 s (Easy EMI) to 19 s (Tent-Card-1) the
first time, kept per picture for the server's lifetime; it runs in a worker thread (`master/artworkWorker.ts`), so the
server keeps answering other requests (longest main-thread stall measured: 36 ms), and in the same process when a worker
cannot start. Runs carry `creative.version` (2); a run made before the split (version 1, one flat background) is not reused:
sending that creative again makes a new run beside it. In the editor the base is locked; each object is a free picture
layer (move, hide, replace, delete) between the base and the creative's elements.

## Background repair: clean-up versions (2026-10-21)

The approved clean background is baked into a published version and every creative of it, so a leftover there repeats in
every creative. The local clean-up is versioned (`MASTER_CLEANUP_VERSION`, now 2): `prepare` stamps it on the cleanup
record and `publish` copies it to the snapshot (`background.cleanupVersion`; absent = version 1). A local clean background
made by an older version is reported (`background.olderCleanup` on the master view, `readiness.olderCleanup` on the AI cost
check) with what to do: **Edit master → Make it again** (free, local) → compare **New clean background** with **Saved
background (version N)** → **Approve background** → **Save master** (a new version; the old one stays, with its files).
Nothing is regenerated automatically and no published version or creative is overwritten.

Creatives keep their version until **Use the newer background** in the creative (`POST …/creatives/:cid/rebase`). It moves
the creative to the newest version only when that version has the same words, logo slots and plates (otherwise
`NOT_BACKGROUND_ONLY`, 422, nothing changed); text, fonts, logos, shapes and positions stay; an AI creative's artwork is made
again from the new background with its own recipe tint (a new `cra-…-art-…` file; the old file stays). The creative's
revision goes up and its history says what changed.

Version 1 of Tent-Card-1 (made by clean-up version 1) had three leftovers, measured on its saved background: marks of the
ascenders and i-dot of "available." above the scanned box (1,482 dark pixels; 0 after), two white squares copied from the
white margin into the pattern (1,917 of 1,920 pixels white; 0 after), and a smooth smear filled into the empty "Text"
placeholder box (mean difference from the poster 40.4; 0 after). Current clean-up v2 produces none of them.

## Decomposition policy

| Operation | OCR | Seedream |
| --- | --- | --- |
| First analysis of a master | once | no |
| Preparing the master | reuses the saved scan | once, only if the administrator confirms it |
| Reuse, text / font / colour / position change, logo replacement, save, reopen, export | no | no |
| Asking for the scan again on the same source | no (saved result) | no |
| **Scan Again** (the administrator asks for it) | yes, local, once per request | no |
| New source image | its own scan | its own optional decomposition |
| **Send to Decomposition** of a creative | no | no (its own elements become the layers) |
| **Make it again** / **Use the newer background** | no | no |

## Data

All under the protected template store (`artifacts/decomposition/protected-templates/<id>/`); see
`shared/src/masterTemplates.ts`.

- **Master** = a protected template with `master` set (`type: 'text-graphics'`, scan record, cleanup quality, artwork choice,
  published revisions, activity counters). Its `textAnalysis` holds every word (`DetectedWord`: text, OCR evidence, box in
  source pixels, style with font/size/weight/colour/baseline/text origin, group/line, role, review), every logo slot
  (`LogoSlot`: exact crop, box, category), every text plate (`TextPlate`) and the groups with their categories. `elements`
  are the regions holding them (derived from the content). `base` is the clean background.
- **Published revision** `master-r<n>.json` (`MasterSnapshot`, sha256 recorded): background, Seedream layers (if chosen),
  words, groups, logo slots, plates. Immutable; creatives refer to one.
- **Creative** `creative-<id>.json` (`CreativeInstance`): its master and revision, and its own elements — texts (one per word,
  origin + baseline in source pixels, style), images (master crops or uploaded files `cra-…`), shapes (plates), groups —
  plus editor link, exports and history. The master is never written by a creative.
- **Editor**: a creative opens as its own design (`variant.creative` links it back; `importedFrom` identifies it); **Save
  creative** in the editor writes the version's texts, logos and shapes back to the creative. Export renders at the
  creative's own size (the master's size for manual reuse; the selected standard format for AI variations).

Coordinates are the creative canvas's pixels; previews, the editor (scaled so the largest word fits the editor's font
limit) and exports scale from them.

## Fonts

`shared/src/offerFonts.ts`: 16 open-licensed families with real files (Template Studio's bundled `.ttf`, the editor's
fontsource Inter and Lora): Inter, Poppins, Outfit, Manrope, Plus Jakarta Sans, Sora, Urbanist, Lexend, Rubik, Bricolage
Grotesque, Archivo Black, Anton, Bebas Neue, Lora (with italics), DM Serif Display, Abril Fatface. The server matches a
scanned run of lines (`server/src/textRecognition/fontMatch.ts`) by drawing its words with each file at the poster's ink
height: the words with the most letters are compared (figure strings such as "3-6-9-12" barely count), each family is
taken at its own best weight — the face whose overlap with the letters and whose stroke weight (the share of the word's
box that is ink) are closest — and the family whose face matches the letters best wins. A slant measured from the
letters (8° or more) favours the italic faces. The browser loads the same files (`client/src/features/fonts/fontLoader.ts`),
so preview, editor and export draw identically. Only the weights a family has files for are offered; nothing is
synthesised or silently replaced. The original poster's own font is not available, so letter shapes are close, not exact
(a Medium is drawn in the nearest of 400/600/700; Lora is the only italic, with a gentler slant than many posters').
Matching runs at scan time: masters scanned before a matcher change keep their fonts until scanned again
(`POST /:id/scan` with `force`); published revisions and creatives keep theirs.

## API (`/api/layerize-experiment/master-templates`, the experiment's access guard)

| Route | Purpose |
| --- | --- |
| `GET /`, `POST /` (multipart, `name`, optional `origin`) | list masters; create one (its scan starts) |
| `GET /:id`, `PATCH /:id` | the master view (stage, review counts, background, revisions, activity); rename |
| `POST /:id/scan` | the scan (saved per source; `force` reads again) |
| `POST /:id/rescan`, `GET /:id/rescan`, `POST /:id/rescan/apply`, `DELETE /:id/rescan` | Scan Again: read the upload again into suggestions; compare them with the current elements; apply chosen fonts (`mode: 'fonts'`, `wordIds`) or everything (`mode: 'replace'`); discard |
| `PUT /:id/review`, `POST /:id/review/approve-all` | corrections (words, groups, logo slots, plates, categories); bulk approval |
| `POST /:id/prepare`, `POST /:id/background` (multipart), `POST /:id/background/approve` | clean background: local, or uploaded; approval |
| `POST /:id/artwork` | the background as one picture, or a finished decomposition's layers |
| `POST /:id/publish`, `GET /:id/revisions/:n` | save the master; a published revision |
| `GET/POST /:id/creatives`, `GET/PUT/DELETE /:id/creatives/:cid`, `POST …/assets`, `…/duplicate`, `…/exports` | creatives |
| `POST /:id/creatives/:cid/decomposition` | Send to Decomposition: `{ runId, created }` (one run per creative revision; free) |
| `POST /:id/creatives/:cid/rebase` (`expectedRevision`) | move the creative to the newest version when only the background changed |

The optional decomposition uses the protected template routes (`/protected-templates/:id/preflight`, `/decompose`).
Files: `/protected-templates/:id/files/:name`.

## Scan Again

For a saved master, **Scan Again** (template page header) reads the original upload again with the current local text
reading and font matching, typically to pick up improved font matching. Three steps in one panel: *Scan again* (what it
does, then a progress state; the results wait if the page is left), *Review results* (one row per text line with a new
font: the line cut from the original design beside the current and the suggested font, each drawn with the real font;
everything ticked except fonts the administrator picked by hand; other differences — new text, text read differently,
text not found, logo changes — listed but not applied), *Apply changes* (a summary of exactly what changes and what
stays).

- Nothing changes until Apply. The new reading is kept in its own file (`rescan-<id>.json`, `master.rescan`); Cancel
  deletes it and the crops only it wrote.
- Applying fonts changes only the chosen words' font, size, letter spacing and where the text starts and sits (the same
  place on the poster, measured from the current box): text, box, colour, review, group and category stay. "Start over
  with the new scan" (explicit, behind a warning) replaces the whole analysis; the elements are reviewed again.
- Published revisions and creatives never change: a new revision is published by **Save master**; creatives keep the
  revision they were made from. Clean-up never deletes a file a revision, a creative or a pending scan still names
  (this also guards the older `force` scan).
- Applying is refused if the elements changed after the results were shown (`STALE_REVISION`); a scan the server was
  running when it stopped shows as failed (try again or close).

## Code

| Part | Path |
| --- | --- |
| Shared model, categories, layout (rewrite, reflow, checks), presets | `shared/src/masterTemplates.ts`, `shared/src/offerFonts.ts` |
| Scan, analysis, clean background, service, routes | `server/src/decomposition/protectedTemplates/master/` |
| Font matching | `server/src/textRecognition/fontMatch.ts` |
| UI | `client/src/features/masterTemplates/` (OfferTemplates, MasterSetup, RescanPanel, ReviewWorkspace, CreativeStudio, CreativeCanvas, creativeDocument, CreativeSaveButton) |
| Editor hooks | `TextInspector.tsx` (offer fonts for creatives), `ExportButton.tsx` / `exportPng.ts` (full-size export, also for `sourceSize`), `EditorShell.tsx` (Save creative) |
| Send to Decomposition | `master/creativeRun.ts` (run), `master/artworkObjects.ts` (the artwork in objects), `master/service.ts` `decomposeCreative`; client `masterTemplates/creativeRun.ts` (editor import), `LayerizeExperimentPanel.tsx`, `RunDashboard.tsx`, `ExperimentNavigation.tsx` |
| Background repair | `MASTER_CLEANUP_VERSION` / `olderCleanup` (shared), `master/service.ts` `rebaseCreative`, `master/artwork.ts` (moved from templateStudio), `protectedTemplates/service.ts` (files a published version names are kept) |

## Tests

- `server/src/decomposition/protectedTemplates/master/master.test.ts`: the whole journey on a synthetic poster with a fake
  OCR (counted) and a fake Seedream: scan, saved scan, review with additions, clean background (no ink left), publish,
  creatives (recolour, logo replacement, stale and font refusals, duplicates), zero OCR/Seedream during reuse, master
  bytes unchanged, optional decomposition → revision 2.
- `tests/e2e-image-templates/master-templates.spec.ts` (offline fixture; real local OCR, fake Seedream, request counters):
  type choice first; a full synthetic journey to the editor and back after a reload; the Easy EMI teal master recreated
  in black at 1820×2420 (artwork, ink and no-teal checks; skipped when the posters are not on this machine:
  `FRAMEFLOW_MASTER_REFERENCE_DIR`, default `~/Downloads/pL-Templates`); a structurally different poster (QR code, badge);
  a narrow window.
- `server/src/templateStudio/masterCreatives/masterAi.test.ts` (AI style variations, offline test provider): 3/4/5 options through
  the production routes, queue and persistence, every element at its saved place (logo boxes, baselines, plates, all text);
  every format; style, case, shape, tint, contrast and look-alike rejections; fitting inside each place; split words joined
  and placeholders/blank pictures left out; missing text reported and generated only on an explicit choice; the bounded
  correction; partial results; empty answers and refusals; a resumed save keeps edits.
- `masterAi.test.ts` also: an AI variation sent to decomposition (one run for a double click, layers per element, native
  text record, reconstruction pixel-equal, ₹0 and no provider/OCR call, creative and master bytes unchanged, a new revision
  gets a new run); clean-up version recorded and an older one reported; a repaired background published as version 2 keeps
  every file version 1 names; rebase of a manual and an AI creative (artwork made again, content unchanged), stale and
  non-background revisions refused.
- `master/clean.test.ts` also: an empty placeholder box removes and fills nothing.
- `master/artworkObjects.test.ts`: a drawn tent card (lattice panel, dotted border, leaves + flower over the border, a boat
  with white dots, a star) → base, Border, three named objects, exact reconstruction, no object colour left in the base,
  enclosed white kept with the boat; a decomposition's shapes split the flower from the leaves; a plain picture stays whole.
- `master/creativeRun.test.ts`: the run builder: an AI creative in 9:16 split locally; an AI creative of a decomposed master
  cut along its layers (placed on the 9:16 canvas); a manual creative given the master's layers; all exact.
- `client/src/features/masterTemplates/creativeRun.test.ts`: the editor import (pictures fetched, native text and shapes,
  order, no creative link, reopen source), editing text and moving/replacing a logo in the store, a scaled design keeps the
  export size, a failed layer read leaves no stored asset.
- `tests/e2e-image-templates/master-decomposition.spec.ts`: generate (mock) → Send to Decomposition → dashboard (layers, ₹0,
  390 px) → Open in editor → edit text, move and replace a logo → export at the creative's size → reload → reopen from Saved
  Runs (same design) → a 9:16 variation exported at 1080 × 1920; creative, master and request counters unchanged. A second
  test uses a decorative poster (`/__test__/master-art-poster.png`): its run shows the base, Border and each illustration as
  "Artwork object" layers; in the editor each is its own layer (one moved, kept after reload and reopen); exact-size export.
- `tests/e2e-image-templates/master-ai.spec.ts`: 3/4/5 options in the browser: test-mode notice, generate, edit a word, replace
  and move a logo, change a font in the editor, save, exact-size export, reload, no further AI request, master unchanged.

Run (when port 3317 is taken by a fixture demo, pick another):

```sh
npm run build -w @frameflow/shared && npm run build -w @frameflow/client
FRAMEFLOW_OFFLINE_E2E_PORT=3327 npx playwright test -c playwright.offline.config.ts tests/e2e-image-templates/master-templates.spec.ts
npx vitest run server/src/decomposition/protectedTemplates/master/master.test.ts
```

## Manual test

1. `npm run dev` (client 5173, API 3001 with `LAYERIZE_EXPERIMENT=1`). Open **OpenAI + Seedream test → Offer Templates →
   New template** (or Template Studio → Create Template → **Text & Graphics**).
2. Upload the Easy EMI poster, name it, **Upload and scan** (about 8 s). Check the boxes: click a word or logo in the list
   or on the poster; correct, add, split/join, reclassify if needed. **Approve all confident**, look at the uncertain ones
   (orange), **Approve all**. **Continue**.
3. **Make the clean background** (about 10–20 s). Look at it and at **Changed areas** (amber = estimate). Tick the check box,
   **Approve background**. Optionally decompose (paid, confirmed). **Save master**.
4. **Reuse Template**: the saved artwork with every word and logo. Change the teal swatch under **Colours** to black (the
   tenure pill follows). Rewrite a group, replace a bank logo, add text or a picture as needed; changes save by themselves.
5. **Open in Editor**: every word is its own text; change a font or move a word; **Save creative**; **Export PNG** (master
   size). Reopen the creative from **Offer Templates → Creatives**: the same state. The master keeps its original values.
6. **Scan Again** (Offer Templates → a template → **Edit master** → **Scan Again** → **Start scan**): compare each
   suggested font and newly found text/shape with the original design, tick the ones to use, **Continue**, **Apply selected
   changes**. Adding missing text or a shape requires making and reviewing the clean background again before **Save master**.
   Font-only changes can be published directly. **Cancel** discards suggestions; local scan counters can increase, but
   analysis, background, published revisions and saved creatives stay unchanged.

7. **Generate AI Variations** (Offer Templates → a saved template → **Generate AI Variations**): pick 3, 4 or 5 and a size
   (**Same as this template** first), optionally a style direction, **Check generation cost** (free; reads the template
   once, about 10 s), read what is left out or missing, then **Generate N editable creatives** (the paid step on a server
   with a real AI key). Results appear below as "N of M creatives ready"; **Preview** shows your template beside it;
   **Open creative** edits one like any creative (no AI), **Open in Editor** → **Save creative** / **Export PNG**. Without
   approval for paid calls, use the isolated test mode in the checkpoint (copies of the masters, test designer only).
8. **Send to Decomposition** (a creative → **Send to Decomposition**, or the button on an AI result card): the run dashboard
   opens with every element as its own layer and ₹0. **Open in editor**: texts are editable text; edit one, move or replace a
   logo (Layers → the logo → X / **Replace image**); **Export PNG** (the creative's size). Close and reopen it from **Saved
   Runs → View run → Open in editor**: the same design. The creative itself is unchanged.
9. **Background repair** (when the AI cost check or Prepare & Save says the background was made with an older clean-up):
   **Edit master → Make it again**, compare with **Saved background (version N)**, **Approve background**, **Save master**.
   Then in each creative that should use it: **Use the newer background**.

## Limits

- Recognition is local OCR: stylised, very small or light-on-dark text can be missed or misread; review corrects it (add,
  split, join, edit). Brand marks are recognised by their place (a short line in the header band); badges by lettering on
  busy artwork; both are suggestions to check.
- The clean background is an estimate. Repeating patterns are copied from nearby matching areas; small joins and faint
  fill bands can remain. Amber areas need closer review, but green areas and the “matching” percentage do not guarantee
  perfect artwork or complete element detection. Check the pink removal preview first, then inspect the result at full
  size. Correct missed text/graphic bounds in Scan & Review or upload the designer's clean background.
- Real-poster verification on 2026-10-20: Tent-Card-1's missed numbers, black pill, visible letter ghosts, white squares
  and fragments were removed after applying the new scan findings; small pattern seams remain. Easy EMI has similar
  seams. Tent-Card-3/4 still retain QR backing and badge fragments; TC3 also loses faint pattern detail in repaired areas.
  Those outputs need correction or a clean-background upload before approval. See the checkpoint's continuation section
  for comparisons and exact test counts. Saved masters are not automatically regenerated when the code changes.
- Fonts are the closest bundled faces, measured against the poster's letters; the poster's own commercial font is not
  available, so letter shapes differ slightly from the original.
- Artwork that differs between two posters (Image B's boat) is not something a recolour can reproduce; creatives keep the
  master's artwork.
- AI variations are style variations only (see "What it cannot do"); the current recipe has run only against the offline
  test provider. They show the approved clean background as it is, including leftovers.
- Version 3 rebuilds the base only for the page + rectangular patterned panel structure (most offer templates); anything else
  (a gradient, a photo, a non-rectangular field) still uses the clean background's fill behind objects. A white stroke of an
  illustration that lies on the white page is told apart only when it lies between two parts of it; very faint traces of an
  illustration's outline can stay on the page. An object cut by the canvas edge has a straight edge there.
- The artwork split is local and visual, not semantic: objects that touch stay one layer (the flower on its leaves, the
  umbrella on the boat, border dots that touch an illustration go with it); names say where an object is, not what it is.
  The master's optional Seedream split (paid) gives finer layers. What the base shows behind an object is an estimate:
  where a corner illustration covered the panel's edge, the continued edge can be stepped or show a faint pattern, visible
  only when the object is moved or hidden. Leftovers baked into a clean background become their own layers.
- Send to Decomposition keeps each word its own text (as when a creative opens in the editor): a longer replacement wraps
  inside the old word's box until the box is widened. The background artwork stays one picture (splitting it is the
  master's paid decomposition). The editor shows its working canvas size (e.g. 1432 × 1904 for Tent-Card-1); the export has
  the creative's size.
- Tent-Card-1's background made again (clean-up v2) still has a faint 1–2 px lighter seam inside where the large "E" of "EMI"
  was cleaned out (about y 1183); the creative's own "EMI" covers it, so it shows only if that text is moved or hidden.
