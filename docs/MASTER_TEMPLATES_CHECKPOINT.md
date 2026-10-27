# Checkpoint: Offer Templates (Text & Graphics masters) — 2026-10-20

Status of the "Complete Offer Creative Template Creation, Decomposition & Reuse System" work, written so the next
session can continue without redoing any of it. Design and API: `docs/MASTER_TEMPLATES.md`.

- Repo: `~/Documents/FrameFlow-template-studio` (git worktree), branch `template-studio-main`, HEAD `27d9575`.
- **Nothing committed, pushed, reset, cleaned or stashed.** The working tree also holds earlier sessions' uncommitted
  work (protected templates, style variations, Qwen alternative, Template Studio jobs); keep all of it.
- **No paid provider call was made.** Seedream was only the offline fixture's fake. OCR is local tesseract (free).

## Background artwork in objects — 2026-10-21, later (all uncommitted)

Send to Decomposition no longer leaves the background as one flat picture: `master/artworkObjects.ts` splits it locally into
a base (the field continued behind the objects), the border and each illustration / ornament, exact (base + objects = the
picture, max difference 0). A master with Seedream layers gives those layers (manual creatives) or cuts the AI creative's
own artwork along them. Real-data check `test-results/artwork-v1/check.mjs` (server 3342 + Vite 5187, copies, offline
provider): 10/10 steps, no page errors. Easy EMI (own size and 9:16): base + Border + boat + leaves; Tent-Card-1 "Tall
Tropic": the same plus its v1 pill and leftovers. Reconstruction vs the run's original: 0 for all three; vs the creative's
own rendering: max 2–3 levels (rounding). Fixed on the way: a plate's outline was clipped in its run layer (half the stroke
is outside the box). Evidence: `test-results/artwork-v1/{emi,tc1,story}-*.png`, `metrics.json`, `result.json`.

## Final quality fixes + Send to Decomposition — 2026-10-21 (all uncommitted)

Recipe v4 unchanged. Two features, verified offline (no paid call) and on copies of the user's real masters.

### Artifacts (Feature 1)

- **Root cause** (pixel crops `test-results/final-v1/artifact-*.png`, numbers `artifact-metrics.json`): baked into Tent-Card-1's
  approved clean background version 1 (local clean-up v1), so repeated in every creative; not the AI layers, Konva, preview
  or export. Marks above "available." = unremoved ascender tops / i-dot (its scan box starts below them): 1,482 dark pixels
  → 0. Two white squares in the pattern = a copy from one pattern repeat away landing in the white margin: 1,917 of 1,920
  pixels → 0. Smear at the top = a smooth fill of the empty "Text" placeholder box: mean difference from the poster 40.4 → 0.
- **Fix**: clean-up versioning (`MASTER_CLEANUP_VERSION = 2`) + warnings (Prepare & Save, AI cost check) + the existing safe
  workflow (Make it again → compare with "Saved background (version N)" → Approve → Save master = new version) + explicit
  per-creative **Use the newer background** (`rebase`, background-only guard; AI artwork re-derived with its recipe tint).
- **Data-loss bug found and fixed**: `protectedTemplates/service.ts` `referencedFiles` ignored `master-r<n>.json`, so making
  the background again after publishing deleted version 1's base file (its manual creatives would lose their background).
  Now every file a published version names is kept (regression test fails without the fix, passes with it). The user's real
  masters were checked: no file missing.
- Remaining: a faint 1–2 px seam inside the cleaned "E" of "EMI" (y ≈ 1183), covered by the creative's "EMI".
- The user's real Tent-Card-1 is still version 1 (older clean-up): the refresh is theirs to run.

### Send to Decomposition (Feature 2)

`master/creativeRun.ts` → a finished composed run (origin `master-creative`), one per creative revision, ₹0; client
`masterTemplates/creativeRun.ts` opens it with native text and shapes; `variant.sourceSize` keeps exports at the creative's
size when the editor canvas is scaled (Tent-Card-1: editor 1432 × 1904, export 1820 × 2420).

### Isolated real-data check (`test-results/final-v1/check.mjs`, server 3341 + Vite 5186, copies, offline provider)

14/14 steps, no page errors: older-clean-up warnings → Make it again → compare tabs → approve → version 2 → Tall Tropic updated
(content identical, artwork re-derived) → Send to Decomposition (18 layers: background, 12 logos, 5 text groups; ₹0) → 390 px
→ editor (native text) → edit text, move + replace a logo → export 1820 × 2420 → reload → reopen from Saved Runs (same design)
→ same run on a second request → Easy EMI 9:16 variation exported 1080 × 1920 → Easy EMI manual creative exported 1820 × 2420.
Provider calls: 1 (the offline mock for the 9:16 batch). Screenshots `test-results/final-v1/01-…19-*.png`.

### Checks (2026-10-21, final code)

- Lint and typecheck: clean.
- Focused unit: `masterAi.test.ts` 14/14, `master/` 8/8, `creativeRun.test.ts` 3/3.
- Full unit: 1551 passed / 11 failed / 10 skipped (before: 1545 / 12 / 10). The 11: the 8 Template Studio tests that fail at
  clean HEAD, and 3 load-sensitive ones (imageTemplates ×2, smartCreative ×1) that pass alone (70/70).
- Browser (`tests/e2e-image-templates` + `tests/e2e/export.spec.ts` + `tests/e2e/editor.spec.ts`, 174): 100 passed, 24 failed,
  47 skipped, 3 not run (serial files after their first failure). 23 failures are in specs that also failed on 2026-10-20
  15:59 (`test-results/master-exp/e2e-full.log`: legacy wizard journeys, smart-creative, template-studio, creative-templates,
  style-variations); 1 (master-ai, laptop size) was a save-timing wait under load: master-ai + master-decomposition alone
  10 passed, 2 skipped (the decomposition flow runs on one browser size by design).
- Real app on copies: `master-ai-v3/dev-check.mjs` 17/17, `final-v1/check.mjs` 14/14, no page errors. The user's real data
  (257 files of both masters and the runs folder) byte-identical before and after.

## AI Creative Variations — 2026-10-20 evening: style variations of the master (recipe v4)

**Status: complete at the mocked-integration level, as style variations of a saved master (the user's clarified
requirement). The current recipe was never run against a real model; real output quality, latency and cost are unverified.
No paid call was made by this work; no commit, push, reset, clean or stash.** Design and API: `docs/MASTER_TEMPLATES.md` →
AI Creative Variations.

### How it got here

1. Interrupted Codex work (recipe 1) was audited and preserved: job, routes, UI entry, editor round trip, mock tests.
2. Recipe 2 (this session): free composition with per-line typography, artwork placement/tint, logo-edge matching,
   partial results, honest mock labelling.
3. **The user ran one live generation themselves** (`job_d02d4011781fef445b6a`, Tent-Card-1, 3 options, recipe 2,
   `gpt-6-luna`, low effort; a correction was needed; usage-derived cost **$0.002535 + $0.002631 = $0.0052**, about ₹0.43;
   2 saved, 1 skipped for a white-edged logo on navy). They rejected it: white pages, "EM I", a stray "Text", missing offer
   numbers, empty space. Evidence: `test-results/master-ai-v3/compare-before.png`, `before-after.png`.
4. Root causes, all generic: the master's data (the scan split "EMI" into "EM" + a hand-added "I"; a review box left at its
   default "Text"; a blank hand-added picture; the numbers "3-6-9-12-18-24" never captured as text and still baked into the
   saved clean background), the rule that forced every group into the design, and a free-composition planner that let the
   model drop the artwork. A composition-check iteration (recipe 3) was started and abandoned when the user clarified:
5. **Requirement (user, 2026-10-20): style variations of the existing master, not new compositions** — keep artwork, borders,
   logos, text, coordinates, grouping and z-order; vary fonts, weights, colours, sizes, alignment within areas, accents and
   a subtle background tint; no relocated elements, no random bands or inflated text. Recipe 4 implements exactly that.

### Recipe 4 in short

- `content.ts`: split words joined with real font advances ("EM" + "I" → "EMI"); untouched "Text" placeholders and blank
  crops left out and reported; each line's saved geometry kept.
- `readiness.ts` (template check): Scan Again's reading run read only and compared with the published revision; Tent-Card-1
  → missing "3-6-9-12-18-24", still in the background (8.2 s, then cached); Easy EMI → nothing (7.5 s). The UI warns,
  offers **Edit master**, and generates only after "Generate anyway, without fixing the template" (server-enforced, 409).
- `plan.ts`: the AI returns styles only; FrameFlow fits every line on its saved baseline inside its saved area or plate,
  measured with the font file, and checks styles, contrast against the real colour behind each line (incl. an old pill in
  the artwork: dark "months" on it is rejected, 1.1:1), tint lightness, overlaps and look-alikes.
- `artwork.ts`: field tint, whole-master framing for other formats, per-cell colours, logo-edge matching.
- UI: plain copy for style variations, template-check panel, compare preview (template beside variation).
- Removed as no longer used: composition checks, open-area placement, automatic cards, bands.

### Files changed in this session (all uncommitted)

New: `server/src/templateStudio/masterCreatives/{artwork,content,readiness}.ts`. Modified: `server/src/templateStudio/
masterCreatives/{plan,service,routes,render,masterAi.test}.ts`, `server/src/templateStudio/jobs/kinds/generateMasterCreatives.ts`,
`server/src/templateStudio/testing/{masterCreativePlan,fakeProvider}.ts`, `server/src/templateStudio/ai/provider.ts` (optional
`offline`), `server/src/templateStudio/router.ts` (`offline`, `masterRecognizer`), `server/src/decomposition/protectedTemplates/
master/service.ts` (keeps the `artwork` flag), `shared/src/{masterAi,masterTemplates}.ts`, `client/src/features/masterTemplates/
{AiCreatives.tsx,CreativeStudio.tsx,OfferTemplates.tsx,creativeDocument.ts,offerTemplates.css}`, `tests/e2e-image-templates/
master-ai.spec.ts`, `tests/fixtures/imageTemplateOfflineServer.ts`, `docs/MASTER_TEMPLATES.md`, this file.

### Checks (fresh runs on the final code)

| Check | Result |
| --- | --- |
| `npm run typecheck` (all workspaces + tests), `npm run lint` (zero warnings), shared/client/server builds | passed |
| `masterAi.test.ts` (3/4/5 with every logo at its saved box, every word on a saved baseline, all text, plates; every format; rejections; fitting; split-word join; placeholders/blank pictures; missing text needs explicit choice; correction; partial; empty; refusal; resumed save) | **13/13** |
| Full unit suite (`vitest run`, 1567) | **1545 passed, 12 failed, 10 skipped**: the 8 Template Studio failures that also fail at clean HEAD (17 there) + 4 load-related time-outs/races in `imageTemplates.test.ts` (3) and `smartCreative.test.ts` (1), files unchanged from HEAD, which pass **70/70** run on their own |
| Offline browser `master-ai.spec.ts`, port 3327, desktop/laptop/wide | **9/9** (also asserts logos at their saved boxes, locked whole artwork, compare preview, no AI request while editing, exact-size export) |
| Offline browser `master-templates.spec.ts` (type selector, manual reuse journey, Easy EMI teal→black, Tent-Card-1, narrow, Scan Again) | **13 passed, 0 failed, 8 skipped by design** |
| Real Vite client (5185) + production routers/worker (3340) on **copies** of Easy EMI and Tent-Card-1, offline test provider, outside network blocked (`test-results/master-ai-v3/dev-check.mjs`) | **17/17 steps, no page errors** |
| Mock styles on both real masters, 4 formats each, real request/checks/build/render (`style-eval.mts`) | 8/8 pass every check; wide faces fit at 70–100% of asked size |
| User data | all 130 protected-store files present at the session start byte-identical; the 26 files added since are the user's own live run and manual reuse |

### Visual comparison (inspected)

`test-results/master-ai-v3/before-after.png`: references / before (the live run) / after (Easy EMI and Tent-Card-1, the
real-app batches). Per-format sheets `styles-<master>-<format>.png`, full-size `style-emi-<n>.png`, `09-export-full.png`
(1820 × 2420 export), `zoom-emi.png` (peach field, matched bank pills, crisp condensed caps), `01-…16-*.png` (the journey).

| Reference difference | Status |
| --- | --- |
| Same artwork, border, leaves, boat in every poster | kept exactly (the artwork is the master's clean background) |
| Field colour (mint → peach → lime) | implemented: subtle tint of the main field, pattern kept |
| Headline face/weight/colour (teal grotesque, black, serif italic accents, condensed caps) | implemented: per-line faces from 16 bundled families (not the poster's own commercial fonts) |
| Alignment, sizes, letter spacing, plate colours | implemented within each element's saved area |
| New copy ("Golden days… CASHBACK", "Ask for NO-COST EMI") | not a style change: edit text afterwards (free) or make a master from that poster; facts are never invented |
| "Golden Onam Days" badge, QR code, dropping bank logos | content/asset changes: **Add picture** / hide in Creative Studio, or another master; not generated |
| New illustrations | would need a paid image model; not built |

Remaining visible defects come from Tent-Card-1's saved master, not the generator: the old "3-6-9-12-18-24" pill (reported),
a few stray dots (one is the period of "available.", which the scan dropped from the text) and a faint smudge where the
unfilled "Text" box was cleaned. Fix: Edit master → Scan Again → apply → make the clean background → Save master.

### Resume / owed

1. **Live validation of recipe 4 (paid, needs the user's approval):** Easy EMI, 3 options, same size; check typography
   quality, how often a correction or partial result happens, the real cost (the estimate quotes up to ₹1.57), latency.
2. Fix Tent-Card-1 with Scan Again before using it for AI variations.

```sh
node test-results/master-exp/idle-check.mjs     # before editing server/src or shared/src (tsx watch restarts the API)
node node_modules/vitest/vitest.mjs run server/src/templateStudio/masterCreatives
npm run build -w @frameflow/shared && npm run build -w @frameflow/client
FRAMEFLOW_OFFLINE_E2E_PORT=3327 node node_modules/@playwright/test/cli.js test -c playwright.offline.config.ts --workers=1 tests/e2e-image-templates/master-ai.spec.ts
node --conditions=development --import tsx test-results/master-ai-v3/style-eval.mts   # mock styles on the saved masters (read only)
# Isolated test mode on copies of the real masters (offline test provider, no outside requests):
node --conditions=development --import tsx test-results/master-ai-v3/dev-server.mts &
FRAMEFLOW_CLIENT_PORT=5185 FRAMEFLOW_API_URL=http://127.0.0.1:3340 npm run dev -w @frameflow/client &
node test-results/master-ai-v3/dev-check.mjs
```

## Continuation verification — 2026-10-20, after the 17:59 handoff

**Tent-Card-1's reported fragments are resolved in the tested regenerated output, but local reconstruction is not
pixel-perfect. Tent-Card-3/4 still have visual defects. Passing browser tests must not be read as proof that every
poster is clean.** This section supersedes the older blanket “nothing is failing” statement below.

On arrival: branch/HEAD matched the above; no dev/test server was active. Claude's latest `e2e-clean.log` had
13 passed / 8 skipped, and the real-master Cancel screenshots had already been written at 17:59. The implementation
already included ink-edge removal, pattern-source filtering, light-on-dark number recovery, a reusable pill,
selectable new rescan findings, and removal-preview loading/error/ready states. These were preserved.

This continuation changed only `client/src/features/masterTemplates/MasterSetup.tsx` and these two master documents
among application/documentation files. The UI no longer describes local pattern copying as “continued exactly”:
it explains that green areas also need inspection for seams, smudges and leftover text, and directs the user to
correct detections or upload their own clean background. No scan/removal algorithm was replaced.

### Real saved master and preservation

- Exact master: **Tent-Card-1 `pt-d974dae2d503`**, source `T1.jpg`, published revision 1.
- Used the real Vite client on 5173 and production master routes/store on 3001. A temporary verification wrapper
  blocked paid providers and all writes except this master's local rescan/cancel; no main server or Studio worker
  was started. This was actual local OCR against saved data, not generated mock suggestions.
  Both temporary verification servers were stopped afterwards; 5173/3001 are not being left as a restricted demo.
- Scan Again found **“3-6-9-12-18-24”** and **“A shape behind months”**. Desktop review, 390px review, confirmation,
  Back and Cancel succeeded. No sideways overflow at 390px.
- Before/after: analysis, elements, background, master revisions and stage were unchanged; stage remained `ready`.
  Local scan activity moved **2 → 3 scans, 19 → 30 OCR reads**. Both AI counters stayed zero.
- SHA-256 inventory of all **130 pre-existing files** in the protected store: no missing/added files; 129 byte-identical.
  Only this master's `template.json` changed, and only record revision/time plus local activity counters.
  Existing source assets, clean backgrounds, immutable published snapshots and saved creative files remained byte-identical.
- One browser console 404 was traced to the workspace's unrelated provenance lookup
  `/api/template-studio/decompositions/2026-10-19T13-07-13-436Z-a88b76`; the restricted wrapper does not mount Studio.
  It was not a master API failure. The copied-master journey had zero page exceptions.

### Actual output and limitations

Applied the two findings through the UI on a **disposable copy of the real saved master**, then prepared its background.
The copy's background was **not approved or published**. Original data was not used for this experiment's writes.
Also ran fresh scan/analysis/removal on the four supplied original posters.

| Poster / check | Observed result |
| --- | --- |
| Tent-Card-1, fresh scan and saved-master copy | Numbers, black pill, visible “months” ghost, black fragments, white squares and top-margin smear removed. Pink preview includes replaceable content and excludes the frame/leaves/mandala/boat. Six sampled artwork rectangles were pixel-identical to source. Small joins in diamond lines and faint fill bands remain; review at full size before approving. |
| Easy EMI | Text, numbers, pill and logos removed; decorative artwork retained visually. Small pattern joins remain. |
| Tent-Card-3 | Text removed, but faint pattern is washed out in repaired areas, QR white backing remains, badge fragments/top-border gap remain. **Not acceptable as a finished clean master without correction or an uploaded background.** |
| Tent-Card-4 | Main repeating pattern retained; QR white backing and badge fragments/top-border gap remain. **Needs correction or an uploaded background.** |

TC3/4's detected QR box covers the code but not its whole backing; badge bounds miss part of its decoration.
Do not widen removal blindly outside a reviewed crop, since that can erase permanent artwork and would not be restored
by the saved graphic. TC3's low-contrast pattern can also be classified as plain. The near-100% “trusted” score on these
two posters is **not a completeness or visual-quality guarantee**; the new warning is shown even for green repairs.
These limitations are recorded, not claimed fixed by this continuation.

The real saved Tent-Card-1 intentionally still has its old background. To update it after review:
**Edit master → Scan Again → Start scan → select numbers and shape → Continue → Apply selected changes →
check What will be cleaned → Make the clean background → inspect → Approve background → Save master.**
Existing creatives continue to use their existing revision.

### Current checks (fresh runs, not historical counts)

| Check | Result |
| --- | --- |
| Related unit + API integration tests, 40 files | **453 passed, 0 failed, 0 skipped**; includes master scan/rescan/cancel/selected findings and clean-background tests |
| `npm run typecheck` (all workspaces + tests) | passed |
| `npm run lint` | passed, zero warnings |
| Shared + client builds | passed |
| `master-templates.spec.ts`, port 3327 | **13 passed, 0 failed, 8 skipped**; desktop/laptop/wide; four expensive/real-poster flows intentionally run on desktop only; includes 390px checks |
| Real saved-master review/Cancel journey | passed |
| Copied saved-master selected findings → prepare, desktop + 390px | passed; no approval/publish |
| Four real-poster visual sanity checks | completed; limitations above, not four clean-output passes |

Reproducible evidence is under ignored `test-results/master-continuation/`:

- `worktree-before.json`, `assets-before.json`, `preservation.json`, `tent-card-1-before.json`.
- `real-cancel.mts`, `dev-server.mts`, `real-cancel.log`, `real-cancel-result.json`,
  `real-tc1-3-review.png`, `real-tc1-4-review-390.png`, `real-tc1-5-confirm-390.png`, `real-tc1-6-cancelled-390.png`.
- `copied-master.mts`, `copied.log`, `copied-result.json`, **`copied-clean-comparison.png`** (old left/new right),
  `copied-before-clean.png`, `copied-after-clean.png`, `copied-removal-desktop.png`, `copied-removal-390.png`,
  `copied-clean-desktop.png`, `copied-clean-390.png`.
- `clean-eval.mts`, `visual.log`, `eval-<poster>-{side,clean,areas,mask}.png`,
  `eval-<poster>-analysis.json`, `verified-{pill,fragments,top}.png`, `artwork-pixels.json`.
- `unit.log`, `browser.log`, `typecheck.log`, `lint.log`, `build.log`.

Commands used (run browser suite after builds and other suites have finished):

```sh
node node_modules/vitest/vitest.mjs run shared/src server/src/decomposition/protectedTemplates server/src/textRecognition client/src/features/export client/src/features/fonts client/src/lib/persistence client/src/features/templateStudio/editorImport.test.ts client/src/features/decomposition/ExperimentNavigation.test.ts
npm run typecheck
npm run lint
npm run build -w @frameflow/shared
npm run build -w @frameflow/client
FRAMEFLOW_OFFLINE_E2E_PORT=3327 node node_modules/@playwright/test/cli.js test -c playwright.offline.config.ts tests/e2e-image-templates/master-templates.spec.ts
node --conditions=development --import tsx test-results/master-continuation/clean-eval.mts
node --conditions=development --import tsx test-results/master-continuation/copied-master.mts
```

No paid APIs, AI Creative implementation, commit, push, reset, clean or stash. Earlier unrelated test failures in the
historical sections were not rerun or claimed fixed.

## Done

### Phase 1: creating a master (one time per source)
- Type choice first: **Template Studio → Create Template** shows *Text & Graphics* / *Product + Text*; the Product + Text
  form is only rendered after it is chosen ("change type" link goes back). Text & Graphics → Offer Templates → new master.
  Also the new workspace tab **Offer Templates** (2nd tab) and "Use as a Text & Graphics template" on a Studio result.
- Upload → scan: one whole-poster OCR + per-line re-reads, saved per source sha (a second scan reads nothing); logo
  cards, QR codes, badges, header brand marks, text plates, font match against 16 bundled offer fonts, categories.
- Review workspace: SVG overlay; select/move/resize/draw; edit text; split/join/delete; reclassify; bulk approve;
  approving stays on the Review step.
- Prepare: local clean background (plain fill, measured lattice pattern copy, seams flagged amber, smooth fallback
  flagged as estimate); upload a designer background instead; admin approves (always an estimate). Optional Seedream of
  the clean base only, priced and confirmed (never run live).
- Publish: immutable `master-r<n>.json` snapshot.

### Phase 2: reuse (zero OCR, zero Seedream, zero AI — verified by request counters)
- Creative from a snapshot: each word its own text at its saved origin/baseline; logos as images; plates as shapes.
- Creative Studio (Konva preview, autosave): recolour by colour cluster (teal → black follows the pill), rewrite a group
  (fits by shrinking to ≥55% with warnings), fix spacing, align/move group, logo replace/restore/hide, add text/picture,
  typography presets, layout checks, duplicate.
- Open in Editor: separate Konva texts at exact source coordinates on the clean background; offer fonts only; **Save
  creative** writes back; **Export PNG** at the master's own size (1820×2420 for Easy EMI); reopen restores the state.
  The master is never written by a creative.
- Easy EMI teal → black (Image A → like Image B) verified at full resolution in the offline E2E and on the dev app.

## Files

New (untracked): `shared/src/masterTemplates.ts`, `shared/src/masterTemplates.test.ts`, `shared/src/offerFonts.ts`,
`server/src/decomposition/protectedTemplates/master/` (scan, analysis, patternFill, removal, service, routes, fixture,
master.test), `server/src/textRecognition/fontMatch.ts`, `client/src/features/masterTemplates/` (api, creativeText,
creativeDocument, CreativeSaveButton, CreativeCanvas, CreativeStudio, ReviewWorkspace, MasterSetup, OfferTemplates,
offerTemplates.css), `tests/e2e-image-templates/master-templates.spec.ts`, `docs/MASTER_TEMPLATES.md`, this file.

Modified for this work: `shared/src/{index,protectedWords,protectedContent}.ts`;
`server/src/decomposition/protectedTemplates/{service,store,words}.ts`, `server/src/decomposition/layerizeRouter.ts`;
`client/src/features/fonts/fontLoader.ts`, `client/src/features/text/{fonts.ts,TextInspector.tsx}`,
`client/src/features/export/{exportPng.ts,ExportButton.tsx}`, `client/src/features/editor/EditorShell.tsx`,
`client/src/store/editorSlice.ts`, `client/src/lib/persistence/schema.ts`,
`client/src/features/decomposition/{ExperimentNavigation.tsx,ExperimentNavigation.test.ts,LayerizeExperimentPanel.tsx}`,
`client/src/features/templateStudio/{TemplateStudio.tsx,PosterResult.tsx}`;
`tests/fixtures/imageTemplateOfflineServer.ts`, `playwright.offline.config.ts` (port from `FRAMEFLOW_OFFLINE_E2E_PORT`);
specs updated for the type selector / new tab: `protected-templates`, `template-studio`, `template-studio-layout`,
`workspace`; origin header follows `FRAMEFLOW_OFFLINE_E2E_PORT` in all 13 image-template specs that set it.
Inspector regression fix (approved): `client/src/features/fonts/FontPicker.tsx`, `client/src/features/text/AutoLayoutControl.tsx`,
`client/src/styles.css` (`.properties-panel`, `.auto-layout-control`), `TextInspector.tsx` (`heading={null}`).
Verification fixes: `client/src/features/masterTemplates/{CreativeStudio.tsx,offerTemplates.css}`;
`tests/e2e-image-templates/master-templates.spec.ts` (per-master activity counters instead of the fixture's global ones;
the synthetic journey opens its own master's card by name, as its desktop and laptop runs overlap).
Font matching fix: `server/src/textRecognition/fontMatch.ts`, new `server/src/textRecognition/fontMatch.test.ts`,
`master/master.test.ts` (font assertions), `master/masterPoster.fixture.ts` ("Super" box widened to the whole word).
Scan Again: shared `masterTemplates.ts` (`MasterRescan`, `rescanChanges`, `applyRescanFonts`) and its tests;
`master/service.ts` (start/result/apply/discard, `referencedFiles` clean-up guard also used by the forced scan),
`master/routes.ts`, `master/master.test.ts` (rescan flow); client `masterTemplates/{RescanPanel.tsx (new), MasterSetup.tsx,
api.ts, offerTemplates.css}`; `tests/e2e-image-templates/master-templates.spec.ts` (Scan Again test; the synthetic journey
now uses its own creative and waits longer for background approval under load).

## Final verification status (2026-10-20, 16:25)

**The offer-template feature passes every check; nothing in it is failing.** The remaining red tests are in other
features and were failing before this work, or fail only from shared fixture state (listed below).

| Check | Result |
| --- | --- |
| Related vitest (39 files) after all fixes | 454/454 pass |
| `npm run typecheck`, `npx eslint . --max-warnings 0` after all fixes | clean |
| Live dev app `ui4.mts` (5173/3001) | 24/24 |
| Final targeted reruns on the last build (sequential, port 3327) | `auto-layout` + `text`: 24/24 (`e2e-verify-1.log`); `master-templates`: 11 passed, 4 skipped by design (`e2e-verify-2.log`); `style-variations` with one worker: 3/3 (`e2e-verify-3b.log`) |
| Editor + related rerun (305 tests, `e2e-rerun.log`, build before the scroll-margin and spec fixes) | 289 passed, 12 failed, 4 skipped |

The 12 rerun failures: `auto-layout` ×4 (the warning scrolled into view 0.19 px past the edge; fixed with
`scroll-margin-block`, then 24/24 above); Easy EMI and Tent-Card master tests ×2 (they compared the fixture's **global**
OCR/Seedream counters while other tests ran in the other worker; now per-master, then 11/11 above); `style-variations`
×3 (same global-counter design, older spec, not changed: its desktop and laptop copies running together add each
other's prompts; passes 3/3 with one worker); `workspace` ×3 (the Legacy tab shows a second "Create New Template" button
when the legacy library is empty — this subset run had no spec that fills it; component and step unchanged from HEAD;
the same test passed on all viewports in the full run).

Still needing attention (outside this feature, not changed): the 22 HEAD-baseline failures (legacy wizard,
smart-creative, backdrop/protected-interactions/recursive "Template saved" step, Template Studio cost table and Match
mode); `style-variations` and `workspace` specs depend on global fixture state.

## Tests (history)

| Check | Result |
| --- | --- |
| `npm run typecheck` (all workspaces + tests) | clean |
| `npx eslint . --max-warnings 0` | clean |
| Related vitest (39 files: shared, protected templates incl. `master.test.ts`, textRecognition, export, fonts, persistence, editorImport, navigation) | 454/454 pass |
| Offline E2E `master-templates.spec.ts` (selector, synthetic journey, Easy EMI teal→black, Tent-Card-3, narrow) | 11 passed, 0 failed; 4 skipped by design (the two real-poster tests run once, on desktop) |
| Full offline E2E (383 tests, port 3327, 19.4 min, `test-results/master-exp/e2e-full.log`) | 311 passed, 28 failed, 41 skipped, 3 did not run |
| Live dev app (5173/3001), `test-results/master-exp/ui4.mts` | 24/24 passed (after the fixes below) |

The 28 full-run failures, classified against the clean-HEAD baseline from the 2026-10-19 session:
- **22 already failed at HEAD**: legacy creative-template wizard (`creative-templates` :22, :272, :303 laptop/wide,
  :344 ×3, :394), `backdrop-layers:32`, `protected-interactions:32`, `recursive-decomposition:30`, `smart-creative` ×5,
  `template-studio` :23 ×3 (cost table expects 8 rows, has 10) and :122 ×3 (Match mode). Untouched by this work.
- **6 were new versus HEAD** (`auto-layout:42`, `:75` desktop+laptop, `text:34` desktop+laptop), caused by the text
  inspector's font-search row and style row (earlier uncommitted work, not this feature): the inspector grew ~107 px,
  pushing its Duplicate/Delete footer under the fixed workspace launchers and the auto-layout warning out of view.
  **Fixed 2026-10-20 with the user's approval** (see below); verified 24/24 (`e2e-verify-1.log`).

Earlier partial regression failures were caused by the specs' hard-coded origin `127.0.0.1:3317` while running on 3327
(`ORIGIN_DENIED`) and the old tab list; both fixed.

### Fixes made during verification (2026-10-20)
- Inspector: the duplicated "Font Family" heading is dropped from the text inspector's font search
  (`FontPicker` `heading={null}`; other uses keep it); the properties panel keeps a 64 px strip at the bottom for the
  fixed launchers (`styles.css`); a new auto-layout warning or result scrolls into view with 12 px room
  (`AutoLayoutControl.tsx`, `scroll-margin-block`; never on selecting a text).
- Creative Studio at 390 px overflowed with a long creative name: the preview column could not shrink below the last
  preview width (`1fr` → `minmax(0, 1fr)`), and the name field had no maximum width (`offerTemplates.css`,
  `CreativeStudio.tsx`).
- Open in Editor saved the creative even with no changes (a new revision each time): saves now happen only with unsaved
  changes (`CreativeStudio.tsx` `dirty`).

### Live dev-app check (`ui4.mts`, screenshots `test-results/master-exp/ui4-*.png`)
Type choice first; Product + Text form only after choosing; "change type"; Text & Graphics → master upload; saved
creative reopened with its colours and no writes; Open in Editor with no writes; 12 saved words → 12 Konva texts at the
saved x (±0.5 source px), size, colour and font; export 1820×2420; a font change saved (one revision), other words
unchanged, reload + reopen shows it, then restored; 390 px library, studio and type choice without horizontal overflow;
master activity unchanged (scans 1, OCR reads 8, Seedream 0, generations 0), master revision unchanged, no
scan/prepare/decompose/Seedream requests. (The old `export-black.png` is 1819 wide — made before the size fix.)
Known pre-existing flaky unit tests (not from this work): legacy router/repository/reviewFlow, imageTemplates/extract
time-outs under full-suite load.

## Screenshots / evidence (`test-results/master-exp/`, not committed)
`ui-01-library` … `ui-10-editor.png` (dev-app journey: library, new, review, clean background, changed areas, saved,
reuse, black, editor), `export-black.png` (1820×2420 export), `compare-AEB.png` (A / export / B), `scan-*.png`,
`clean-*.png` (Easy EMI and Tent-Card-3/4 scans and clean backgrounds). Offline E2E artefacts: `test-results/offline/`.

## Visual fidelity: Easy EMI export vs Image A / Image B (full-resolution crops)

Crops (A / export / B, same source pixels, export made **before** the font-matching fix below):
`test-results/master-exp/fidelity-{easy,pill,legal,cards}.png`. Positions, sizes, colours and the artwork match; the
differences were font matching.

### Font weight and italic matching fixed (2026-10-20, later)
Cause: the poster's word mask came out of sharp with three channels while the drawn face had one, so the shape overlap
compared misaligned pixels (scores 0.05–0.18, close to noise) and weight/family were decided mostly by chance and the
width penalty; the two widest words were sampled, so a figure string ("3-6-9-12-18-24") steered a line. Fix
(`server/src/textRecognition/fontMatch.ts`): one-channel mask (and a size check), words sampled by their letters,
each family taken at its own best weight (shape and stroke weight together), then the best family. Italic was already
detected for "Easy" (Lora 700 italic, drawn italic in preview, editor and export — the earlier "upright" reading of the
crop was wrong; Lora's italic is just much less slanted than the poster's).

| Easy EMI line (real local OCR) | Before | After |
| --- | --- | --- |
| "Easy" | Lora 700 italic | Lora 700 italic |
| "EMI" | Bricolage Grotesque 600 | Bricolage Grotesque 700 |
| "available." | Outfit 700 | Rubik 700 |
| Tenure pill | Bricolage Grotesque 700 | Poppins 600 (the poster's is a Medium; nearest bundled weight) |
| "On 25+ credit/ debit cards." | Manrope 700 | Manrope 700 |
| "T&Cs apply" | Bricolage Grotesque 700 | Poppins 400 |

Measured in the Easy EMI E2E export (desktop): top-half mean difference from Image B 21.6 → **13.4**; "EMI" ink share
56.4% → 65.9% (B 74.9%). Tent-Card-3/4: regular copy (Scan the QR…, *T&Cs apply) now Poppins 400, italic serif lines Lora
700 italic. Strips (poster line | chosen face): `test-results/master-exp/fonts-v2-*.png`; evaluation script
`test-results/master-exp/font-eval.mts` (local OCR only). Tests: `server/src/textRecognition/fontMatch.test.ts` (regular vs
bold, italic serif, figures do not decide the family); `master.test.ts` asserts the synthetic poster's italic "Super",
bold copy and regular T&C line (its fixture box for "Super" was too narrow and cut the word; widened).

Remaining fidelity limits: no bundled Medium (500) weights; Lora is the only italic (a gentle slant; posters often use
steeper italics); Image B keeps "T&Cs" teal while the cluster recolour turns it black (change that word's colour);
Image B's boat differs (a creative keeps the master's artwork). Masters scanned before this fix — including the dev test
master `pt-998ca54a2fdf` and its creative — keep their old fonts until updated with **Scan Again** (below); the dev
test master's suggestions were reviewed and cancelled, not applied, so applying them is left to the user.

## Scan Again (2026-10-20, latest)

A **Scan Again** button on a saved template (template page header) reads the original upload again (local, free) and
shows suggestions in one panel with three steps — Scan again → Review results → Apply changes. Nothing changes until
Apply; Cancel leaves everything as it was. Each suggested line shows the line cut from the original design beside the
current and the suggested font, drawn with the real fonts; fonts picked by hand are offered but not ticked; text and logo
differences are listed, not applied (only an explicit "Start over with the new scan" replaces everything). Published
revisions and creatives never change; Save master publishes. Plain-language copy (no OCR/revision/provider terms in the
flow), focus moves to each step's heading, works at 390 px. Design and guarantees: `docs/MASTER_TEMPLATES.md` → Scan Again.

Also fixed while building it: clean-up after a scan deleted logo crops no longer named by the *current* analysis, even
when a published revision or a creative still used them (reachable through the API's forced scan); now nothing a
revision, creative or pending scan names is deleted.

| Check | Result |
| --- | --- |
| Shared unit (`masterTemplates.test.ts`: changes, apply) | 10/10 |
| Server flow (`master.test.ts`: suggestions only, chosen font only, hand corrections kept, creative and r1 byte-identical, stale apply refused, cancel, start over keeps r1 crops, no fal/planner call) | 2/2 |
| Related unit suites (40 files) | 460/460 |
| `npm run typecheck`, `npx eslint . --max-warnings 0` | clean |
| Offline E2E `master-templates.spec.ts` (all viewports, twice) | 12 passed, 6 skipped by design, 0 failed |
| Dev app (`ui5.mts`, Easy EMI test master) | 4 real suggestions (EMI → Bricolage Bold, available. → Rubik Bold, pill → Poppins Semibold, T&Cs → Poppins Regular); 390 px fits; results wait across navigation; Cancel → analysis, stage, revision, creatives unchanged; no rescan file left; Seedream 0; no console errors |

Screenshots: `test-results/master-exp/rescan-shots/` (`rescan-1…6` offline flow incl. 390 px; `dev-1…6` real poster).
Dev data note: the two dev-app runs added 2 local scans to the test master's counters (scans 3, reads 24).

## Remaining / known issues
- Local OCR misses some light-on-dark small text (e.g. the lime-on-teal pill line in the synthetic poster); review's
  manual add covers it.
- Fonts are the closest bundled faces, not the poster's own font (weight/italic matching fixed, see above; no Medium
  weights, one gentle italic). Clean background seams are estimates (amber).
- Image B's boat artwork differs from Image A; a creative keeps the master's artwork.
- Not done (deliberately): persisting a `templateType` on Studio templates (they are Product + Text by definition).
- Never run live: the optional Seedream decomposition of a master's clean background (needs explicit approval).
- Test data on the user's dev store: master "Easy EMI · Berkowits (master test)" `pt-998ca54a2fdf`, creative
  `cr-f164c4e09d18`.

## Resume
```sh
cd ~/Documents/FrameFlow-template-studio
node test-results/master-exp/idle-check.mjs     # before editing server/src or shared/src (tsx watch restarts the API)
npm run typecheck && npx eslint . --max-warnings 0
npx vitest run shared/src server/src/decomposition/protectedTemplates server/src/textRecognition
npm run build -w @frameflow/shared && npm run build -w @frameflow/client   # before any offline E2E
FRAMEFLOW_OFFLINE_E2E_PORT=3327 npx playwright test -c playwright.offline.config.ts tests/e2e-image-templates/master-templates.spec.ts
FRAMEFLOW_OFFLINE_E2E_PORT=3327 npx playwright test -c playwright.offline.config.ts   # full suite (~383 tests)
```
Reference posters: `~/Downloads/pL-Templates` (`ec78f…jpg` = Image A teal, `T1.jpg` = Image B black, `Tent-Card-3/4.jpg`).
Never start `server/src/index.ts` for checks; never `rm -r`; no paid calls without approval.
