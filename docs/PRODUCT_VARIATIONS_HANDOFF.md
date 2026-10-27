# Product with Text: Generate with AI → Decomposition Layers → Editor (handoff, 22 October 2026)

**Status:** the priority integration **Generate with AI → choose a variation → Send to Decomposition → run dashboard →
Open in editor → edit → save/reopen → export PNG** works end to end in the browser, on the real LG Ganesh creative, offline.
Detection in that test is the **handmade fixture manifest** (not model output), the variation styles are **local rules**
(no AI planner request), and every provider is a fake. **No paid call was made ($0.00).** Nothing was committed or pushed.
The system is **not production-ready**: live AI detection, the live AI planner and background reconstruction behind
objects remain unverified or incomplete (see *Remaining issues*).

## 1. Audit summary (before this session's changes)

| Capability | Found | Now |
|---|---|---|
| Upload / sheet crop / original kept | worked | unchanged |
| AI word-level detection, error handling, no OCR-only "success" | built, never run live | unchanged (live run still needs approval) |
| Review UI (groups, boxes, undo/redo) | worked | unchanged |
| Provider input limited to isolated characters/products | worked (unit-tested bytes) | unchanged |
| Clean template: text remnants on plates ("i :'" in the validity pill) | **broken** | **fixed** (plain-plate sweep, see §3) |
| Background behind products | transparent holes | **unchanged** (open) |
| Reuse: replace product/character, edit text/logos | worked | creative preview now draws a creative's own background/canvas |
| Variations: aspect ratios | **missing** (renderer stretched the base) | **built** |
| Variations: plan = render | **broken** (draft headlines shown, original drawn) | **fixed** (no drafts) |
| Variations: typed headline/offer, character choice | missing | **built** |
| Variation quality gate | missing | **built** |
| **Variation → Send to Decomposition → run dashboard** | **missing** ("Open & edit" skipped it) | **built and browser-verified** |
| Editor: word edits, logo/product moves, save/reopen/export | worked for creatives | verified for a 9:16 variation |

## 2. What was built

### Generate with AI (Product template page → "Generate with AI" tab)
- **Form:** 3/4/5 variations; styles (Festive original, Bold offer, Premium spotlight, Minimal brand-forward, Different
  products); **sizes** (Original, 1:1, 4:5, 9:16, 16:9; several can be chosen and the variations take them in turn);
  **headline** and **offer** text typed by the person (empty = keep the template's); a product picker per product slot and
  a **character picker** per character slot, each with "Add a … picture" (cut out locally); optional AI planner (paid,
  confirmed with its cost, unchanged) and, only with it, "Let the AI write headlines" (marked on the card).
- **What a card says is what is drawn.** The offline planner never writes copy. Typed text is applied with
  `rewriteGroup`, wrapped to the group's width over its own number of lines (`wrapToGroup`) and anchored where the group's
  lines were (a centred headline stays centred, `inferAlign`). The card lists every text written (typed / AI-written).
- **Styles are visible, local and structural:** headline font per style (Poppins, Archivo Black, DM Serif Display,
  Manrope), the offer set larger/bolder for Bold offer (capped to the safe width), body font for Premium/Minimal, and an
  artwork colour treatment (saturation/brightness of the whole background, never a part of it). Lines are re-laid where
  they were anchored after a font change (`restyleGroup`). Text colours are applied only when readable on what is behind
  them (contrast ≥ 3 measured on the variation's own background).
- **Aspect ratios without stretching** (`ratioLayout.ts`): scale 1 (the template's width kept for taller ratios, height
  for wider). Where the design has plain margins along the growing axis (rows/columns of one colour, ≥ 4 % of the side,
  e.g. the LG creative's white header and footer), they are lengthened: **exact**. Elements in a lengthened margin are
  spread so the extra space is shared evenly between their rows (header logos end up centred; footer rows spread). The
  artwork block moves as one with everything on it. Without plain margins the artwork is centred and **plain colour
  margins** are added — reported (`filledPercent`) and flagged on the card (`FILLED_MARGINS`), never presented as artwork.
  Each variation records `layout` (ratio, source canvas, scale, axis, extra space, bands) and keeps every element's
  template id (`wordId`, `slotId`, `objectId`), so template coordinates stay recoverable.
- **Every variation is structured:** its background is its own file (`pvarb-…`, then `pca-<creative>-…` when saved), each
  word a native text, each logo a picture, each product/character a cut-out. The preview, the saved creative, the run,
  the editor and the export are all made from that same record.
- **Quality gate** (`variationChecks`) per card: **failed** (blocking) for anything off the canvas, a missing picture, a
  requested product/character/headline/offer not drawn, an unusable font; **needs a look** for new text overlaps, safe-area
  issues, filled margins, a product photo whose background could not be removed, and duplicates (identical preview
  hashes). Issues the template already had are not counted. Failed cards cannot be sent on.
- **Send to Decomposition** (primary card action): `POST /product-templates/:id/variations/:jid/results/:n/decomposition`
  saves the variation as a creative (once) and makes an ordinary decomposition run of its own layers with
  `createComposedRun` — **locally, $0, no provider, nothing segmented again** (the cut-outs it was made with are reused).
  One run per creative revision (asking again returns it). The client then shows the **existing run dashboard**, which
  now says which variation it is, its ratio and size, and that the cut-outs were reused at no cost. **Open in editor** on
  the dashboard opens the existing Konva editor at the variation's canvas size.
- **Run provenance** (`run.creative.provenance`, `PRODUCT_CREATIVE_RUN_VERSION` 3): processing version, every picture
  layer's source file and SHA-256, cost `{ usd: 0, providerRequests: 0, segmentation: 'reused' }`,
  `textLayersSentToProviders: 0`, the layout and the variation (job, index, kind, ratio, check status).

### Clean template (prepare.ts)
- `sweepPlainLines`: around each line of AI-measured words, when the strips above and below the line are one colour
  (a plate: banner, pill, white page), pixels within each padded word box that differ from the plate are removed with
  the text (anti-aliased edges, punctuation, i-dots); letters a box missed at the line's ends are added letter by letter
  (connected marks no wider than ~1.5 line heights and inside the line's band, chained to the text). Rules, dividers and
  ornaments (wider, taller than the line, or apart from the text) stay. Lines on busy artwork are left to the ink mask.

## 3. Visual evidence (real Ganesh crop, handmade detection fixture)

`test-results/product-v4/screens/`:
`00-original` · `01-clean` (text/logos out) · `02-background` (behind objects; transparent holes remain) ·
`03-reconstructed` · `10-generate-form` · `11-variation-cards` · `11b-variation-cards-390` · `12-variation-{0-original,1-9x16,2-16x9}` (+ each
background) · `13-inspect-selected` · `14-run-dashboard` (the existing Run Dashboard, top) · `14b-run-dashboard-layers` · `15-editor-opened` · `16-editor-edited` · `17-export`
(607 × 1079) · `18-reopened`. Machine-readable: `test-results/product-v4/variation-evidence.json`.

Checked by eye at full resolution:
- Validity pill: the old clean template kept "i :'" marks; the new one is plain teal. The "|" divider on the EMI line,
  the banner's ornamental lines and the badge are unchanged.
- Variation headlines wrap to three centred lines on the banner (before this fix a typed headline ran off the banner).
- 9:16: the white header/footer are lengthened (exact white); 16:9 of this square creative is a pillarbox (flagged).

## 4. Tests
See §7 for the exact results and logs.

## 5. Remaining issues (honest)
1. **Live AI is unverified.** Detection quality (words, logos, Ganesha, each appliance) has only been exercised with the
   handmade manifest. The prepared single-request plan is in `test-results/product-v3/live-analysis/` (gpt-5.6-sol, one
   `POST /v1/responses`, max 16k output tokens, est. $0.14–$0.36, no retry); it needs your explicit approval.
2. **Background behind objects** is still transparent where nothing was visible (`02-background.png`, magenta in the
   montages). Moving or hiding a product or Ganesha shows the editor's white canvas there. Not fixed this session.
   Options: an exemplar (PatchMatch-style) local fill flagged as an estimate, an approved AI inpainting request, or an
   uploaded clean background.
3. **Text on busy artwork** (the offer line on the sunburst) leaves faint scanline streaks in the clean background.
4. **Font matching on tiny text** (8–12 px EMI/validity lines) is unreliable; with the handmade boxes some words sit too
   close ("Till30th"). Real AI word boxes may differ.
5. **Landscape from a portrait/square design** can only centre the artwork (plain margins or flagged fills); a true
   landscape recomposition needs new artwork (an AI background, paid) — not built.
6. **Ganesha cutout** (local estimate) still carries a few background fragments at its left and feet.
7. Review: word-by-word expansion inside a text group and the exact label "Approve & Prepare Template" are not done;
   "Try again (free)" after a failed detection still retries without AI (it cannot complete detection).
8. Variation uploads whose background could not be removed are flagged but not segmented (a paid SAM-3 path for them
   with cost confirmation is not built).

## 6. Files changed this session
- `shared/src/productTemplates.ts` — aspect ratios (`PRODUCT_ASPECT_RATIOS`, `productCanvasFor`), creative `background`
  and `layout`, variation `aspectRatio`/`requested`/`checks`, copy `source`, style labels.
- `server/src/decomposition/protectedTemplates/product/ratioLayout.ts` — **new**: plain margins, layout, background, element placement.
- `server/src/decomposition/protectedTemplates/product/variations.ts` — rewritten (version 2), `decompose`.
- `server/src/decomposition/protectedTemplates/product/creativeRun.ts` — creative background, provenance, run version 3.
- `server/src/decomposition/protectedTemplates/product/creatives.ts` — duplicates copy the background.
- `server/src/decomposition/protectedTemplates/product/routes.ts` — decomposition route, picture `kind`.
- `server/src/decomposition/protectedTemplates/product/prepare.ts` — `sweepPlainLines`.
- `server/src/decomposition/layerizeExperiment.ts` — run `creative.provenance` type.
- `client/src/features/productTemplates/{api.ts, ProductTemplatePage.tsx, productTemplates.css}` — Generate with AI UI, Send to Decomposition, creative background preview.
- `client/src/features/decomposition/{layerizeExperiment.ts, RunDashboard.tsx}` — provenance type, variation note.
- `server/src/decomposition/protectedTemplates/product/variations.test.ts` — updated to the new semantics + decomposition test.
- `tests/unit/productLayoutSweep.test.ts` — **new**. `tests/e2e-image-templates/product-variations.spec.ts` — **new**.
- `tests/e2e-image-templates/product-words.spec.ts` — output folder configurable (`PRODUCT_WORDS_OUT`) so the earlier evidence is not overwritten.
- `tests/e2e-image-templates/{product-templates,product-reference}.spec.ts` — stale expectations updated; `PRODUCT_SHOTS_OUT`.
- `client/src/features/productTemplates/{ProductReview.tsx, ProductTemplates.tsx}` — "Approve & Prepare Template"; AI retry after a failed detection.

## 7. Test results (22 October 2026, this worktree)
| Check | Result | Log |
|---|---|---|
| `npm run typecheck` (client, server, shared, tests) | **pass** | `test-results/product-v4/typecheck.log`, `typecheck-tests.log` |
| Focused unit suite: `server/src/decomposition/protectedTemplates`, `tests/unit`, `client/src/features/{masterTemplates,protectedTemplates,decomposition}`, `shared/src` | **55 files, 529 passed, 1 skipped, 0 failed** | `unit.log` |
| New: variations (3 tests incl. **Variation → Send to Decomposition**: run once per revision, provenance hashes verified, 0 provider calls) | pass | in `unit.log` |
| New: `tests/unit/productLayoutSweep.test.ts` (5: plate sweep keeps divider/ornament, busy art untouched, 9:16 plain bands exact, letterbox flagged, thin border never stretched, headline wrap) | pass | in `unit.log` |
| ESLint (`--max-warnings 0`) on every changed file | **pass** | `lint.log` |
| `npm run build` | **pass** (Vite's existing large-bundle advisory) | `build.log` |
| Browser: **`product-variations.spec.ts`** (Generate with AI → cards (390 px checked) → Send to Decomposition → **existing Run Dashboard** (Overview tab, "Image to editor layers", Final editor layers, Pipeline; variations panel gone) → its Open in editor → word changed + moved, neighbours unchanged → product and LG logo moved → Export PNG 607 × 1079 → reload → Saved Runs → reopened with every edit) | **pass** | `browser-product-reference.log` |
| Browser: `product-words.spec.ts` (previous session's creative flow) | pass | same |
| Browser: `product-reference.spec.ts` | pass (after updating its stale heading) | same |
| Browser: `product-templates.spec.ts` create + reuse (reuse now ends with Send to Decomposition → dashboard → editor → export → reopen) | **2 passed** | `browser-product-templates.log` |
| Browser: Text & Graphics `master-templates.spec.ts` (7 tests) | **7 passed** | `browser-regression.log` |

Stale tests updated (their expectations predated the previous session's UI, not this session's code): the old variation
unit test (podium/brand-logo objects, draft copy), `product-templates.spec.ts` and `product-reference.spec.ts` (old review
heading "Check what was found", prepare without accepting detections, the editor's new word-group text panel, the old
first variation title). Spec screenshots now go to `PRODUCT_SHOTS_OUT` / `PRODUCT_WORDS_OUT` when set (defaults unchanged),
so the earlier `product-v1`/`product-v2` evidence was not overwritten.

Not run: the full repository unit suite and the full offline E2E suite (earlier sessions recorded unrelated flaky/failing
Template Studio and legacy tests); the `laptop`/`wide` Playwright projects.

Also fixed this session (client): the review's main button reads **Approve & Prepare Template**; after a failed
detection, **Try again with AI…** asks for cost approval (the free retry is now labelled "Read the text only" and
explains it cannot find products).

## 8. Cost and safety
- Paid calls: **none** ($0.00). Unit tests use fakes; browser tests block every non-loopback request, blank provider keys
  and run on isolated ports (3351, 3352) with temporary stores.
- Your running dev server (`npm run dev` from this worktree) was never stopped. Backend edits were made only after an
  idle check (no active run, detection, preparation or variation job); its `tsx watch` reloaded on those edits.
- No reset, stash, clean, commit or push. No user template, run or reference image was modified: all **747** files of the previous session's safety snapshot (`test-results/product-v3/safety-before.json`: user artifacts + references) re-hashed **unchanged** (
  `Ganesh-Chaturthi.png` sha256 `cf91d56c…ac64e`, `Tent-Card.png` `a726b83f…80b2b03`).
- An unused scratch copy of the worktree exists under the session scratchpad (never edited; delete it whenever you like).

## 9. Manual acceptance guide
1. Open the app → **OpenAI + Seedream test** → **Offer Templates** → a saved Product template → **Use template**
   (or create one: New product template → upload → review → prepare → approve and save).
2. Open **Generate with AI**. Pick 3 variations, keep the four styles, choose **Story 9:16** and **Landscape 16:9** in
   addition to Original, type a headline, optionally pick a product for one slot (or add a product picture).
3. Click **Generate 3 variations**. Each card shows the rendered creative, its style, size and checks. Click a preview
   to inspect it; cards with plain-colour margins say so.
4. On the 9:16 card click **Send to Decomposition**. The **run dashboard** opens with "Decomposition layers of your
   selected variation …" and every word group, logo, product and character as its own layer (cost $0).
5. Click **Open in editor**. The canvas is 607 × 1079 (for the LG creative). In **Text**, expand the headline, select one
   word, change it and its X; the other words stay. Select a product and the LG logo in Layers and move them.
6. Wait for "Saved on this device", **Export PNG** (full size), reload the page, **Saved Runs → View run → Open in
   editor**: the edits are still there.
