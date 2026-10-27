# Product with Text — complete feature: progress log and handoff (22 October 2026)

Living progress file. Earlier handoffs: `PRODUCT_VARIATIONS_HANDOFF.md` (variations → decomposition → editor, offline),
`PRODUCT_WORD_PIPELINE_FIX.md` (previous session). **The full feature is NOT complete** — see *Completion criteria*.

## Decomposition core: OpenAI planner → Seedream Layerize (thirteenth block, 23 Oct 2026) — built and verified offline, no paid call, nothing committed
Everything before and after decomposition is unchanged (upload → AI detection → review → choose → … → save → reuse →
Generate with AI → Decompose & Edit → editor). Only the decomposition step gained a primary engine:

- **`server/src/decomposition/protectedTemplates/product/aiDecompose.ts` (new):** `liveDecompositionPlanner` — one OpenAI
  Responses request (model `OPENAI_DECOMPOSITION_MODEL`, default gpt-5.6-sol; strict JSON) with the text/logo-free picture
  and the reviewed elements (id, kind, name, box, decompose or keep in background) plus counts and logo NAMES of what was
  removed (never a word); it returns the Seedream prompt (≤ 2000 characters, checked) and one planned layer per element.
  `seedreamLayerize` — one `bytedance/seedream/v5/pro/layerize` request through the existing fal transport, image contract
  check, adapter and 422 classifier (`prepareProviderImage`, `buildProviderInput`, `normalizeProviderOutput`,
  `classifySeedreamRejection`): upload, submit once, poll, read, download each layer. `createProductLayerizer` joins them;
  `standInProductLayerizer` is the OFFLINE STAND-IN (tests, demo server; labelled "not OpenAI, not Seedream" everywhere).
- **What is sent (enforced on the pixels, not by the prompt):** `prepare.ts aiLayers` builds the decomposition input from
  the picture without its text and overlay logos (the existing overlay removal and gate), then ALSO removes the logos the
  person kept in the picture (brand logo/badge "kept in the picture"; the saved background keeps them), at a size under
  Seedream's higher price tier (`sentSize`: < 1536² px). Before any request, every word box and every logo box (bank,
  payment, partner, QR, brand, badge) is checked: if more than 30 % of the original's ink (pixels unlike what is around the
  box) is still there, NOTHING is sent and preparing stops with a message naming them (`prepare-ai-input-check.json`).
- **How the layers are used:** each Seedream layer is given to the reviewed element it lies on (most of its pixels inside
  the element's box; the planner's name breaks ties); each pixel belongs to the front-most layer seen there; the labels go
  back to full size along the creative's own edges (`upsampleLabels`). The existing separation then runs with those masks
  (a second pass after the local one, so an element Seedream did not return keeps its local cut-out, flagged
  `ai-missing-<id>`); stands, checks, cut-outs and the editor files are made as before. Behind the elements Seedream
  returned, Seedream's background layer (its colours matched to a ring around them) replaces the local rebuild — marked as
  an AI estimate (violet in "Show estimated areas", warning `ai-background`). Cut-out method `seedream`; separation
  `{ method: 'seedream', requests: 2, costUsd, ai: { planner, engine, prompt, requestId, layers, matched, unmatched,
  backgroundPercent, sentSize, warnings } }`; files `prepare-ai-plan.json`, `prepare-ai-planner-request/response.json`,
  `prepare-seedream-request/response.json`, `prepare-ai-mapping.json`.
- **Cost and approval:** `GET …/prepare-estimate` → `ai { configured, elements, requests, expectedUsd, maxUsd, note }`
  (planner $0.08 estimate + Seedream $0.03375 per returned layer under 1536², at most 17). `POST …/prepare { engine: 'ai',
  approveUsd }` is refused (`APPROVAL_REQUIRED`) unless `approveUsd ≥ maxUsd`; `NOT_CONFIGURED` without OPENAI_API_KEY and
  FAL_KEY; `NOTHING_TO_SEND` when every element already has its own layer. Live wiring (`layerizeRouter.ts`): only when both
  keys are set. Each request is made once; a failure is reported, never retried.
- **Screens:** Choose what to decompose offers **Decompose with AI… (about $X)** first, with a cost confirmation, and keeps
  **Continue to Decomposition on this computer (free)**; Inspect shows "with AI: … → Seedream Layerize, $…", the planner's
  instructions, which elements came from Seedream's layers, and offers "Decompose again with AI…" after a local one.
- **Text and logos after decomposition:** unchanged — every word keeps its text, box, font, size, colour, rotation and
  style, every logo its original picture, box and place; the editor run of a creative restores each word as its own
  editable text and each overlay logo as its own picture layer, above the decomposed layers; none of them is in the
  background picture or in a decomposed layer (verified, below).
- **Generated variations:** Decompose & Edit goes through the same route. When every element still has the variation's own
  layer (composed variations), nothing is sent (`NOTHING_TO_SEND`; its layers are used as they are); an element without one
  — or a flat picture — goes to the AI decomposition like a master's.

**Verified offline (no paid call):** `tests/unit/productAiDecomposition.test.ts` — the LIVE planner and Seedream code with a
fake OpenAI client and a fake fal transport, on the drawn poster with its ACME brand logo kept in the picture: refused
without approval (no request made); then one planner request and one Seedream request with the planner's prompt; the
picture sent (identical pixels to planner and fal) has none of the 7 words' ink (< 10 %) nor any of the 4 logos (< 20 %),
the kept ACME logo included, while the saved background keeps it (> 80 %); 4 elements from Seedream's layers (`seedream`),
Seedream's background behind them; words (id, text, box, style) and logo slots (id, box, original picture) identical before
and after; the layers without text and logos show none of them; saved, reused: the editor run has every word as a text at
its place, font, size and colour, every overlay logo as its own picture at its slot's place (the template's picture), above
the 4 object layers, `textLayersSentToProviders: 0`. Two mutations: without removing the kept logo the pre-send check
refuses (nothing sent); without that check too the test finds the ACME logo in the picture sent. `variationTemplate.test.ts`:
a Decompose & Edit template with all its layers sends nothing. Browser `tests/e2e-image-templates/product-ai-decomposition.spec.ts`
(offline stand-in): Choose → Decompose with AI → Inspect (AI route and its instructions) → save → New creative → Send to
Decomposition → editor: every word an editable text, every logo and element its own layer; 0 outgoing requests.

**LG end-to-end, offline (23 Oct, isolated server `test-results/product-v16/lg-server.mts`, port 3371; a NEW template
from your real 4096 upload, detected by replaying its saved real OpenAI answer; your templates only read):**
- Detection checked by eye on every box (`test-results/product-v16/standin/A2-boxes.jpg`): Ganesha one character; 12
  products each with its own correct box (soundbar under the screen, subwoofer, both satellites included); 3 display
  podiums and the gold stage; flowers, bells, badge; 43 words; 18 logos (LG, pine labs, 16 bank). No correction needed
  except, possibly, the "welcome" word box clipping its last "e" (no remnant found in the picture sent).
- The planner's source of truth (`prepare-ai-elements.json`): the 13 elements to decompose (12 products + Ganesha) with
  their reviewed boxes, the 4 stands and 6 decorations as background, and only counts of the 5 text blocks / 43 words /
  18 logos. The picture that would be sent (`test-results/product-v16/standin/ai-input.png`, 1535×1535): every word and
  logo gone (`stillVisible: []`); product markings (LG OLED evo, the AC's sticker) kept as part of the products; faint pale
  ghost marks remain on the rays where the offer line was (text-removal residue, unreadable; under the overlay).
- The whole route in the browser with the stand-in (`test-results/product-v16/lg-journey.mts`, `standin/evidence.json`):
  review → choose → Decompose with AI → inspect → save → reopen → New creative → editor (Ganesha and the fridge moved, a
  word edited, reloaded, exported 4096²) → Generate with AI (3 recorded artworks) → Decompose & Edit → editor → export —
  every step passed; master revisions unchanged; 0 outgoing requests.
- Guard mode (looks paid, refuses): the app's own quote for this LG template — **about $0.55, at most $0.65** (planner
  ≈$0.08; Seedream $0.03375 per returned layer under 1536² — confirmed on fal's model page — at most 17), nothing sent.
- Found and fixed while preparing the live run (both from fal's published schema, both now tested): (1) Seedream returns
  each layer as a CROP at its own resolution with its box on the base image (a real earlier run: a 392×249 box came as a
  902×572 picture) — the layers were stretched over the canvas; they are now placed with the run pipeline's own
  `placeLayers`/`placedOverlay`; the unit test's fake returns such crops and fails with the old code. (2) Seedream's prompt
  takes `<bbox>l t r b</bbox>` tags (0–1000): the planner gets each element's tag and must use it; any it leaves out is
  added by code, so every reviewed element reaches Seedream with its reviewed place.

**Not verified (needs one approved paid run):** the real OpenAI planner's answer for a product creative, the real Seedream
Layerize answer (how many layers, their names, whether each product comes back on its own), the mapping and the background on
real Seedream layers, timing (the planner ~30–90 s, Seedream ~30–120 s). Smallest meaningful live test: the LG creative —
about $0.55 expected (planner $0.08 + ~14 layers × $0.03375), at most $0.65.

## Final continuation: regressions, typography, verification (twelfth block, 23 Oct 2026 12:50–16:30 IST) — offline, no paid call, nothing committed
**Report:** `test-results/product-v15/visual-report/index.html` (before = `test-results/product-v14/baseline` and the
unchanged `test-results/product-v13/visual-report`; after = the final code). Every defect there is labelled Fixed and
verified · Improved but imperfect · Still broken · Requires manual correction · Requires an approved AI-assisted operation.

**State found at the start** (the eleventh block stopped at the usage limit, 11:47 IST, undocumented): unit 1 product failure
(`productLiveDetection` 4096: `outline-…` of the dishwasher blocking, 76 %), browser `product-stands`, `product-generation`
(recorded) and `product-ai-detection` (recorded) failing, four specs edited but not re-run, this file not updated.

**Fixed in this block (each with a test that fails without it)**
1. Dark bar where the dishwasher's foot was at 4096 px (blocked the template): `backgroundGuide.ts podiumRows` took "the
   nearest seen stage pixel" of a row where only stray stage pixels were seen (an ornament 1800 px away). A row now needs
   a tenth of the stage's width seen. Bar gone, outline 42 % (warning). LG/Onam/Ganesh 4 backgrounds identical, Ganesh 2/3
   slightly better (pixel diffs, `test-results/product-v15/run-a`).
2. Prepare had become ~4× slower (LG 4096: 57 s; Onam 49 s): `inpaint.ts` made every pixel near an EXCLUDED source a fill
   target; the stand-local fill of the eleventh block excludes most of the picture. Only patches touching the hole are
   targets now: LG 20–39 s, Onam 12–23 s; the 4096 unit test no longer times out in the full run.
3. Soundbar handling in the recorded specs: the eleventh block's spec edits REMOVED the misplaced Soundbar box (the soundbar
   then stayed inside the TV layer). Review now has X / Y / Width / Height fields for every element (`ProductReview.tsx`);
   the specs draw the box where the soundbar is (607 px: 290, 345, 66 × 8; 4096 px: 1957, 2328, 445 × 54) and it is its
   own layer. Stand labels compared as name sets (front-to-back order changed); preview-vs-export compares everything except
   the edited word and the words that moved with it.
4. Editor reflow measured, not estimated: the store's reflow used `estimateTextWidth` (±15 %); edits now carry the edited
   words' widths as the canvas draws them (`client/src/features/text/measuredWords.ts`, `MeasuredWords` in
   `editorSlice.ts`) for word edits, phrase retyping and phrase-wide font/size changes (`textGroupUpdated` did not reflow at
   all). Browser: the next word lands within 1–2 px of the measured growth (`product-variations`, final journey).
5. A word box corrected in the review re-fits the word (`detect.ts styleLine`, shared with detection; `service.ts`): before,
   the old style was only scaled, so a box drawn round "CHATURTHI"'s letters kept the thin Plus Jakarta 400 face at −14 px
   spacing; now Lexend 700, 76 px (unit `tests/unit/productWordRestyle.test.ts`). The prepare warning says how to correct.
6. Words that would be drawn over others are flagged in the review before decomposing (`service.ts overlappingWords`: boxes
   overlapping a third, or a word well off its line): Ganesh 3 "Accept"/"customer", Ganesh 4 "Ld", "On", "it)"; none on LG,
   Ganesh 2, Onam.
7. Decompose & Edit re-segmented two satellite speakers of a variation: layers were matched by exact NAME, and the scene
   parser cuts categories to 40 characters ("… · center 1" → "… · center · bottom 1"). Now by kind and box (IoU ≥ 0.85),
   the name only breaking ties (also survives a rename in the review) — `prepare.ts`, `variationTemplate.test.ts`.
8. "9" drawn like a subscript on the EMI line (regression of the eleventh block): "never wider than its own box" shrank a
   figure whose AI box was narrower than the glyph. A word is now limited by the next word of its line (a word space kept),
   only the last word by its own box (`fontMatch.ts`). LG→products 17 px, EMI→tenure 18 px, "9" at the line's size.

**Tried and reverted (no general rule; bounded):** splitting a word's ink into bands to drop the divider under "CHATURTHI"
(cut glyphs like a half "&" looked the same); flooring a word's shrink by its own ink height ("LG" in the LG line could not
be told from the cut "9"). Both left detection output byte-identical after the revert.

**Verified offline (exact):** typecheck all workspaces + tests, ESLint 0 warnings, `npm run build` — pass. Product, text
recognition, editor store and shared suites 555/555. Full Vitest: 1638 passed, 11 failed, 10 skipped — the documented 11:
Template Studio 8 (`pipeline` 6, `router`, `generator-costs`; code not touched) and `imageTemplates` 2 + `smartCreative` 1
(5 s timeouts / a state race under full load; 70/70 alone). Browser (offline fixture server, each in its mode; logs
`test-results/product-v15/final-e2e/`): plain 10/10 (`product-templates` 2, `product-full-workflow`, `master-templates` 7);
`FRAMEFLOW_PRODUCT_REFERENCE=1` 4/4 (`product-words`, `product-variations`, `product-reference`, `product-generation`);
`+FRAMEFLOW_PRODUCT_RECORDED=1` 4/4 (`product-final-journey` new, `product-review-words`, `product-stands`,
`product-generation`); `FRAMEFLOW_PRODUCT_AI_CLIENT=recorded` 1/1 and `=timeout` 1/1. `product-generation`'s preview-vs-export
comparison now ignores 1-px anti-aliasing (server SVG text vs browser canvas text): 0.48 % / 0.43 % differ (limit 3 %); it
had failed at 3.002 % on glyph edges only (checked on a zoom: same words, same places).

**Final journey** (`tests/e2e-image-templates/product-final-journey.spec.ts`, REFERENCE=1 RECORDED=1; evidence
`test-results/product-v15/final-journey/`): upload of the LG sheet → recorded real answer (12 products) → soundbar box
corrected → choose → decompose (13 layers, 6 stands, no blocking) → save → page reloaded, template reopened from the library
→ Generate AI Variations: 3 variations, 16:9 + 9:16 + 1:1, nothing typed → job planned from the template's saved
instructions (`briefSource: template`, no direction) → 3 results with different creative IDs, previews and artworks (the 3
DIFFERENT recorded real gpt-image-2 pictures of 22 Oct, replayed, $0 — not generated now) → Decompose & Edit of the 1:1 one
→ its own template (every element `layer`, 0 AI calls) → editor: TV moved (nothing else moved), "grand" → "EDITEDWORD"
(the next word moved 138 px = the growth measured on the canvas, 138 px) → reload: both kept → export 607×606, 0.64 % of
pixels differ from the decomposed picture away from the edits → master revisions and snapshot hash unchanged → 0 outgoing
requests. Last run: master `pt-1422fbf6bddd`, job `pv-3b4ae8d0`, variation template `pt-4d3dc90d9b52` (disposable, in the
fixture server's temporary folder).

**Still wrong (exact; see the report):** Onam dotted border not continued behind the leaves, bottom-right corner, boat
pieces (still broken). Behind Ganesha a flagged guess (AI inpainting would be the next step; not built). White/pale
products carry stand slivers (purifier, satellite speaker, microwave strip, POS terminal) — SAM-3 (paid) is the designed
fix. "CHATURTHI" is still detected in the wrong face (flagged; one review correction fixes it). "on all LG products.": the
words no longer overlap but the gap still reads tight and "LG" is drawn smaller and lighter than the original (matched
face wider than the creative's). On the 607 px crop, a few small-print glyphs whose AI boxes are narrower than the glyph
("&", the line's last word "months)") are drawn smaller. A much longer edited word pushes the rest of its line past the canvas edge (no
automatic wrap). Hand-made-answer creatives keep the local reader's misreadings (₹ as 2/£) until corrected in the review.

**Your templates:** nothing under `artifacts/` changed in this block (newest file 2026-10-22 23:51); the saved template
`pt-97537b6c7e5a` was only read, for the text "before" crops. It was prepared by older code: open it and use *Find the
elements again from the saved AI answer (free)*, then prepare again, to get this block's text and object fixes.

**Files (twelfth block):** `server/src/decomposition/protectedTemplates/product/{backgroundGuide.ts, inpaint.ts, prepare.ts,
detect.ts, service.ts, variationTemplate.test.ts}`, `server/src/textRecognition/fontMatch.ts`,
`client/src/features/productTemplates/{ProductReview.tsx, api.ts}`, `client/src/features/text/{measuredWords.ts (new),
useTextActions.ts, TextInspector.tsx}`, `client/src/store/{editorSlice.ts, wordReflow.test.ts}`,
`tests/unit/productWordRestyle.test.ts` (new), `tests/e2e-image-templates/{product-final-journey (new), product-stands,
product-generation, product-review-words, product-ai-detection, product-variations}.spec.ts`. Tools (not app code):
`test-results/product-v15/*.mts`, `test-results/product-v15/visual-report/build.mts`.

## Decomposition quality + typography (eleventh block, 23 Oct 2026 09:40–11:47 IST) — reconstructed from that session's transcript
Stopped by the usage limit before this file was updated; recorded here from its transcript. Five-creative runner
`test-results/product-v14/runner.mts` (LG: your 4096 upload + its real answer; Ganesh 2–4, Onam: hand-made answers),
baseline `test-results/product-v14/baseline`. Changes: a graph-cut mask refinement (`maxflow.ts` checked against a reference
max-flow on 300 random graphs; `segment.ts` colour models + per-object cut, front to back, hidden parts completed as marked
estimates); the order rule in `orderProductObjects` (one lying mostly over another is in front; supports behind what stands
on them) and a detection rule keeping separately advertised items apart (LG: 8 → 12 products — soundbar, subwoofer, two
satellites); a stand-local source fill inside display blocks; `empty-<id>` blocking again; word placement from exact glyph
ink (`fontMatch.ts`, `render.ts textInkExact`) and the prepare checks "run together" / "drawn quite differently"; the editor
reflow of a product template's line (`editorSlice.ts lineSnapshot / reflowLines`, `wordReflow.test.ts`); a service test for
a product the detection missed and the reviewer drew. Onam border dots were investigated without a change.

## Connected workflow + Test D (tenth block, 23 Oct 2026) — offline, no paid call, nothing committed
The FINAL brief's flow is built end to end: Upload → AI detection → review → **Choose what to decompose** (per element;
text and logos are always editable layers, never decomposed; a logo can be kept in the picture) → decomposition →
**Inspect the layers and the background** (tabs Original · Reconstructed full creative · Background only (+ *Show
estimated areas*) · Individual layers · Hide / Move test · Without text and logos; blocking problems apart from
warnings; one "I have looked" confirmation) → **Save master template** (or *Save as a draft with these warnings*) →
**Template details** (generation instructions written from the detection, marked "Written by FrameFlow", editable, kept
apart from the decomposition plan; both saved with each version) → **Generate with AI** (no prompt needed: 3/4/5/10,
Original/1:1/4:5/9:16/16:9, each size or in turn, ≤20 outputs, optional custom instructions, cost and approval for paid
artwork, outputs line) → **Decompose & Edit** on a variation (its own template, provenance noted; detection from its own
layers, exact, no AI request; review → choose → decompose with every element its own layer and the variation's real
background behind it, nothing estimated) → editor (move, edit, reload, export). Masters are never modified (hashes checked).

**Fixed in this round**
1. Variation text over products went unflagged ("Bold offer": headline across the TV and Ganesha, only "Needs a look"):
   `variationChecks` now measures each text block against the products' and characters' boxes together — ≥ 33 % of the
   block over them fails the card (Decompose & Edit disabled), ≥ 8 % asks for a look; what the template itself has is not
   counted. Cause also fixed: for products-above-text layouts the artwork's stage was searched down to the canvas bottom,
   so a stage drawn low seated the products on the headline; the search now stops at the next text zone (the footer for
   text-above layouts). Unit test added (`variations.test.ts`).
2. Recorded (replayed) artwork was called "test image model" on the form; now "gpt-image-2 artwork recorded earlier,
   replayed, free" / "Real gpt-image-2 artwork recorded earlier, replayed (free, nothing is sent)". Sizes say "(choose
   one or more)". The brief lists scenery, then decorations, then furniture.
3. **False display stands** (Ganesh creative 2): a dishwasher in front of a fridge's lower door (one smooth grey region
   over two boxes) became a "stand", cutting the lower halves out of both products. A product now stands on a region only
   when its feet are not below the region's bottom (`risers.ts standingOn`). The six real stands of the LG sheet creative
   are kept (unit tests).
4. **Sunburst found with the wrong colours** (creative 2: a ray colour paired with the mint side panel, centre off to
   the side → a mint wedge drawn behind the products): `findBurst` scores with half-degree bins (thin 3° rays straddled
   2° bins and fell under the purity bar), refines the best 3 coarse centres (fewer samples until the last round: 10 s →
   3 s on 606 px), and needs ≥ 16 stripes (a plain layout's blocks made a 12-stripe "burst" that took a mirror hole).
   New unit test `burst.test.ts` (fails on the old binning).
5. **A round podium's hidden top** was a dark flat box (patches from its gold bands): `podiumRows` gives each hidden
   pixel of a row where the podium is seen the nearest seen podium pixel of that row (its end mirrored about the box
   centre); rows where it is not seen are the wall's, so the rays run on above its rim. LG: the stage's hidden left end is
   now its own bands instead of a pink collage (some streaking); the mascot's outline warning dropped below its bar.
6. **Bands behind wide objects** (the terminal, Ganesha) were not continued: a straight run may be up to 3× the old limit
   when its colour runs on for half its length beyond each end, or to (a few px from) the creative's edge. LG unchanged
   (0 pixels differ).

**Tried and reverted (no visible gain)**: an elliptical rim fit as the burst's barrier; a mirror "symmetric around the
source too" check (the copied badge's mirror place is entirely hidden, so no pixel can tell); continuing border columns
upward (the column step does not recognise a dots-only border at all).

**Test D — four other creatives** (`test-results/product-v13/testD/`, sheets `*/sheet.png` original · background only ·
estimated areas · recombined · first element hidden, `*/layers.png`, `before-after/`, `report.json`). Ganesh sheet
creatives 2 (appliances, 606 px), 3 (portrait gadgets, 342×606), 4 (POS terminal), and the Onam tent card (two
decorations, 1820×2420). Detection used a **hand-made answer** (boxes placed by a person, words from the local reader;
labelled "hand-made answer (not a model)") on the isolated server; 0 outgoing requests. Each decomposed in 8–33 s.
Remaining defects there: the hidden temple half and mint panel behind Ganesha are amber estimates; product contact
shadows stay on the podium; small product remnants (a fridge edge, the white terminal's top strip and foot — the local
cut-out misses white-on-pale parts; SAM-3 is the designed fix, paid); creative 3's earbuds were dropped at detection;
the Onam card's right dotted border is not continued behind the leaves, the bottom-right corner is broken, flag/pole/dot
pieces of the boat remain. Text there is the local reader's (OCR errors, the terminal's screen text taken as an overlay)
— not representative of AI detection.

**LG journey (the user's template, on a copy)** `test-results/product-v13/lg-final/` + `report.json`: re-saved master
(warnings only), brief derived, 3 × 1:1 on the recorded artwork (all "Needs a look", none over the products), Decompose &
Edit: detection exact (0 AI calls), 9 layers `layer`, no issues, 0 % reconstructed, editor move/edit/reload, export
4096²; revisions 1–5 byte-identical, 6 added; 0 outgoing requests.

**Tests (exact)**: typecheck all workspaces + tests clean; lint 0 warnings; build OK. Full vitest: 1624 passed, 11 failed,
10 skipped — 8 Template Studio (`pipeline` 6, `router`, `generator-costs`: untouched code, as before), `imageTemplates` 2 and
`smartCreative` 1 time out under full load and pass alone (70/70). Product/protected suites 97/97. Browser (offline,
each in its mode): plain 10 passed (incl. `product-full-workflow`, `product-templates` 2, `master-templates` 7; `product-words`
and `product-variations` fail in plain mode by design — they need `FRAMEFLOW_PRODUCT_REFERENCE=1` and have no skip guard);
reference: `product-words`, `product-variations`, `product-reference`, `product-generation` pass; recorded:
`product-review-words`, `product-stands`, `product-generation` pass; AI client recorded/timeout pass.

**Not verified**: any live provider (planner, gpt-image-2 generation per variation, SAM-3 cut-outs) in this flow.

## Quality fix + AI variations from the library (ninth block, 22 Oct 21:10–23:40 IST) — offline, no paid call
Tested template: the user's `pt-97537b6c7e5a` (live detection $0.249, saved revision 1). Every run used a COPY (scratchpad
`seed-9753-*`) on the isolated server `test-results/product-v5/live-server.mts` (all outgoing requests refused); the original
is untouched (`template.json` 21:08:41). Paid requests: **none**.

**Fixed (A background, B decomposition)**
1. Fractional AI boxes off by a systematic scale (x ≈ 0.96x + 40 px at 4096): `calibrateScene` (detect.ts) fits per-axis
   scale + shift from the text blocks against their pixel-accurate words, applied only when the fit is tight; logos still
   snap from the raw boxes (calibrated hints made snapping worse — reverted).
2. A held item (the modak) is merged into its holder (Ganesha) instead of becoming its own object; re-detection keeps
   accepted-only boxes by name + box (an object whose kind the detection now reads better follows it).
3. An appliance taken for a podium: `objectKindOf` reads the category and name, not the description ("air conditioner …
   above the stepped podium" made it a podium, left in the background). Now 8 products, the AC a product.
4. Ghost letters on the rays / smeared badge text: two-tone surroundings are continued by patches (`refillPatterned`),
   text masks widened by 8 % of the word height. Regression found and fixed: on the small creative the validity pill's
   ring reached the white page, so the pill was taken for a pattern (a "6" copied back) or filled white — words on a
   plain plate (the line sweep's `plain`) now take the plate's colour, judged inside it.
5. Product places painted in stand colour up to row 2440: the floor fill now reaches only a little behind the farthest
   stand seen standing (`floorTop` from stand bottoms; the floor's first row was a stand top joined to the stage).
6. Gold stage bands stacked up the wall where Ganesha stood: patches fill what is outside the stage's box without taking
   anything from the stage, then the stage's own part (`BackgroundGuide.stage`, two-pass inpaint).
7. Temporary `SEP_DEBUG` instrumentation removed.

**Built (C, D, E)** — Product Templates library cards: **Use template · Generate AI Variations · Edit master** on saved
templates, **Continue setup** on unfinished ones (same words as the Text & Graphics cards). Generate AI Variations opens
the template straight on its existing *Generate with AI* tab (3/4/5 variations, Original/1:1/4:5/9:16/16:9, template
artwork / simple backdrop / new AI artwork with the cost confirmation; nothing new invented). Long names no longer push
the buttons off the card (`.ot-card-body` min-width 0, names wrap). Recorded artwork is labelled as recorded and replayed
(it was called "Test artwork (offline image model)" in the summary line and the check).

**Evidence** (`test-results/product-v12/`): `final-overview.png`, `final-cutouts.png`, `final-hide-move.png` (original ·
Ganesha hidden · Ganesha and fridge moved · background); `guard/` (cost confirmation, cancelled; server refuses an
unapproved request 400 `APPROVAL_REQUIRED`; 0 jobs, 0 requests); `recorded/` (library card → 4 variations 1:1 4096²,
4:5 4096×5120, 9:16 4096×7282, 16:9 7282×4096 on the recorded real gpt-image-2 artwork, each 43 words + 18 logos as
overlays → Send to Decomposition → Run Dashboard (35 layers, $0) → editor → word edited → export 4096×4096 → reload, edit
kept; master revision and snapshot hash identical before/after; 0 outgoing requests). Prepare on the copy: 1 character,
8 products, 43 words, 18 logos, 3 stands, nothing blocking, 25.9 s.

**Still wrong (exact)**
- Behind Ganesha 66 % is guessed (flagged): its mirror side is covered by the badge, so the left temple's lower half and
  the frame column there become a flat pale fill; specks and a shawl tip of Ganesha stay in the background where his gold
  border touches the gold stage (his local mask misses them).
- Local cut-outs carry stand slivers where light products touch light stands (water purifier: cream stand pieces;
  dishwasher, fridge, washer: thin slivers; microwave mask 59 % of its box). The designed fix is the paid segmenter
  (SAM-3 via fal) — needs approval.
- Stand layers: "Stand under the OLED television" is a 410×41 sliver (the pink platform stays in the background); the
  microwave/purifier stand has an odd outline. Pink stand edges behind products are blurry in the background estimate.
- J&K Bank icon tip left in the clean picture.
- The saved revision 1 was prepared by older code: variations use its cut-outs (the fridge carries a piece of the badge
  ribbon) until the template is prepared again and saved as revision 2.

**Tests**: product unit suites 98/98; browser, each in its documented mode — plain: `product-templates` 2 (incl. the new
card check), `master-templates` 7; handmade: `product-variations`, `product-words`, `product-reference` 3; recorded:
`product-generation`, `product-review-words`, `product-stands` 3; AI client recorded/timeout: `product-ai-detection` 2.
Lint 0 warnings; typecheck shared/server/client/tests clean. Full vitest suite: 1623 passed, 9 failed, 10 skipped — 8 in Template Studio (`pipeline`, `router`, `generator-costs`: assertion failures in code not touched in this block, recorded earlier as failing before it) and 1 `imageTemplates` 5 s timeout under full-suite load (passes alone); no product test failed.

**Files (ninth block)**: `…/product/{detect.ts, service.ts, prepare.ts, backgroundGuide.ts, analyzer.ts, variations.ts}`,
`shared/src/creativeTemplates/scene.ts`, `client/src/features/productTemplates/{ProductTemplates.tsx, ProductTemplatePage.tsx,
ProductReview.tsx, api.ts}`, `client/src/features/masterTemplates/{OfferTemplates.tsx, offerTemplates.css}`,
`tests/unit/{productLiveDetection,productBackground,productStands}.test.ts`, `tests/e2e-image-templates/product-templates.spec.ts`,
fixtures `tests/fixtures/recorded/ganesh-lg-4096-{,b-,c-}gpt-5.6-sol-2026-10-22.response.json`; tools (not app code)
`test-results/product-v5/live-server.mts` (`FF_ARTWORK=recorded|guard`), `test-results/product-v11/*`, `test-results/product-v12/*`.

## Prepare refused: "2 text or logo area(s) are still in the picture" (eighth block, 22 Oct 20:30 IST) — FIXED offline
Template `pt-12f644cf4f58` (uploaded 20:09, live detection done, $0.223; reviewed twice: all 22 objects accepted, no word
or logo edited). Reproduced offline on a copy (`test-results/product-v10/gate-check.mts`): the two areas were logos —
`pl-97b0798bbf` "IDFC FIRST Bank logo" box (3113, 3625, 430, 82): 68 % of its own pixels unchanged; `pl-ca67047507`
"BOBCARD logo" (2052, 3629, 373, 78): 78 % unchanged.
**Root cause: incorrect detection boxes** (not the removal, not the gate): the model's fractional logo boxes for the bank
rows were ~1.2 % of the height too low and 1–2 % too far right (IDFC drawn at y 3625, the logo is at 3578–3650) — the
mask covered the lower half of each logo and white below it, the upper half stayed in the picture, so the gate was right
to refuse; and each logo's editable overlay was a crop of half a logo. Same offset on every bank logo; the two failed
the gate's 50 % rule.
**Fixes:** `detect.ts` `snapLogoBoxes`: logos side by side share the model's offset, found per row jointly (all boxes
holding the most of what stands out from their background and cutting the least at their edges), then each refined by
itself never onto a neighbour's middle, then grown to its card's edge where the logo goes on (an icon before the name);
the logo crop is taken from the placed box; provider exclusions cover both boxes. Found on the way (each would have
blocked the demo): (1) the same live answer type failed detection at 20:06 (`pt-05322911c671`, $0.209) — a relation naming
an unlisted object ("Ganesha holds decor_modak_implied") rejected the whole answer, then `PARTIAL_WORDS` (the EMI block's
box ~25 px off its words, the coverage check allowed ±8 px): relations to unknown/self objects or of unknown kinds are
dropped, the word-to-block tolerance follows the block's height (`analyzer.ts`); (2) after the gate passed, 3 blocking
checks "Nothing of “Microwave oven” / “Satellite speaker · center 1/2” was found inside its box": their boxes lie wholly
inside others' (Ganesha's over-wide box; the TV's), so they had no colour model and got no pixels — an object with no
pixels of its own now takes its colours from its whole box (`localMasks`); (3) every review save marked every logo
"corrected" (it sends each logo's box, label, category), so detecting again kept the 19 wrongly placed logos beside the
new ones (36): only real changes mark a logo corrected now, and a "corrected" logo still exactly where the AI put it,
same name, no picture of its own, gives way to the newly placed one (`service.ts`). Review screen: **Find the elements
again from the saved AI answer (free; your corrections are kept)** when a paid answer exists.
**Verified offline (no paid call):** all three saved live answers complete detection (21/22/21 elements, 43 words). On an
isolated server (port 3364, every outgoing request refused) with a COPY of `pt-12f644cf4f58`: saved-answer re-detection
(22 accepted objects kept, 19 logos, $0, AI calls unchanged) → prepare 12.1 s, **no blocking check** → approve → publish:
stage **ready**. Tests: typecheck, eslint (changed files), build **pass**; unit **206 passed / 36 files** (new in
`productLiveDetection.test.ts`: the 20:06 answer accepted; the 20:26 answer's bank logos not cut by their boxes and
prepare without blocking checks on the creative at 4096 px; a no-change review marks no logo corrected); browser
`product-review-words`, `product-stands`, `product-generation` (recorded) **3 passed**, `product-ai-detection` **2 passed**.
Fixtures: `tests/fixtures/recorded/ganesh-lg-4096-{b,c}-gpt-5.6-sol-2026-10-22.response.json`. The user's templates were
not changed. Residue in the clean picture only (hidden under the overlays): a 1 px tip of the J&K icon, a faint grey
gradient where the CREDIT CARDS card was.

## Live detection of the user's 4096 upload (seventh block, 22 Oct 19:40 IST) — FIXED, verified offline (no new paid call)
**What happened:** the user uploaded the LG Ganesh creative (4096×4096 JPEG) in the app twice-detected it live (template
`pt-6a76ffe87122`, created 14:04:45 UTC; retry 14:08:37 UTC, both approved by the user in the UI). Both OpenAI requests
**completed** (HTTP OK, `status: completed`, no error; 97 s and 105 s; sent a 2048×2048 PNG, 2.8 MB; timeout 300 s;
$0.2234 + $0.2091 = **$0.4326**), and both were thrown away by FrameFlow: `INVALID_RESPONSE: The analysis must list 1–24
objects.` A different failure from the earlier `pt-0b57d0765fb6` (a 120 s SDK timeout on a 9.4 MB PNG, fixed in the fifth block).
**Root cause:** the product analyzer reused the shared scene parser's general limit (`SCENE_LIMITS.objects` = 24); at
2048 px the model listed **27 objects** (12 products, 6 decorations, 4 furniture, 4 scenery, 1 character; the 607 px picture
had given 21). Reproduced offline by replaying the saved answer through the same code.
**Fix:** `parseSceneDescription(value, { objects })` (shared; default 24 unchanged for other flows); the product analyzer
uses the template's own limit (`PRODUCT_LIMITS.maxObjects` = 60) and, past it, keeps the most important objects
(characters, products, then by confidence) with their relations and logo owners — never discards the answer
(`trimProductObjects`). **Recovery without paying again:** `POST …/:id/detect { force, savedAnswer: true }` reads the answer
already received (saved with every request as `analysis-product-response.json`) again with today's checks — no network,
$0, not counted as an AI call; refused when none was received or it was for another version of the picture. The failure
panel now says "OpenAI did answer (this request was billed, about $0.21), but FrameFlow could not use the answer: …" and
offers **Use the answer already received (free)**.
**Verified offline:** the user's live answer replayed → detection done (27 objects). On an isolated server (port 3360, every
outgoing request refused) with a COPY of `pt-6a76ffe87122`: saved-answer detection → done (1 character, 10 products, 43
words, 18 logos, $0 added, AI calls unchanged, 0 outgoing requests) → review → prepare **13.5 s** (11 cut-outs, 3 stands, no
blocking check). Tests: typecheck, eslint (changed files), build **pass**; unit product + protectedTemplates + shared
creativeTemplates **194 passed / 35 files** (new `tests/unit/productLiveDetection.test.ts`, 3; the real answer saved as
`tests/fixtures/recorded/ganesh-lg-4096-gpt-5.6-sol-2026-10-22.response.json`); browser `product-ai-detection` recorded +
timeout **2 passed**. The user's own template was **not** changed (only the copy).
**Still to confirm live:** in the app, open `pt-6a76ffe87122` and press *Use the answer already received (free)* (no paid
call); a NEW live detection after this fix has not been made (one request ≈ $0.21–0.23, needs approval).

## The seven background defects (sixth block, 22 Oct night) — 4 fixed, 1 fixed by a review correction, 2 improved and flagged (offline, no paid call)
Harness (fast, offline, recorded answer): `node --conditions=development --import tsx test-results/product-v8/defects.mts`
(607 px crop, ≈ 2 s; `SRC=real` the 4096 upload, ≈ 15 s; `WALL=x,y,w,h` adds a drawn background box) writes
`montage.png`: Ganesha hidden | dishwasher hidden | TV hidden / washer's stand moved | Ganesha's cut-out | TV's cut-out.
Before/after of the whole background: `test-results/product-v8/background-before-after.png` (top before, bottom after).

| # | Defect | Root cause | Fix (general, no creative-specific values) | Status |
|---|---|---|---|---|
| 3 | Striped gap behind the dishwasher | The AC's pink cylinder's bottom is seen in one column only; its hidden bottom was drawn flat at that row (380), 12 px above the base it stands behind | `risers.ts`: a stand whose bottom is hardly seen (< 10 % of columns) continues down behind the products and nearer stands hiding it, to the first pixel not in front of it — never through a character. Stands are layered by their lowest seen row (`seenBottom`), not their completed box | **fixed** |
| 5 | Orange smear after moving the washer's stand | Behind the stand the patches copied the back wall's rays and the podium's gold rim | `backgroundGuide.ts` floor rule: a hole straight above the floor (the podium top `findRisers` found) is floor up to a little behind the farthest stand seen standing on it, coloured from the nearest floor pixel of its row; also sideways along floor rows (a stand covering the floor down to the rim) | **fixed** |
| 4 | Thin white line where the TV was | The TV panel's 2 px light top border lay just past the TV's mask and rim | `prepare.ts` outline rule (run on the analysed picture): walking out up to 3 px from an object's edge, pixels that stand out from the background 4 px out and are of the object's own edge colour (± 24) go with the object | **fixed** (607 and 4096) |
| 6 | Podium piece on Ganesha's hip | The podium's ornamented bands run into his box from the podium's side; not one smooth region, so the scenery rule missed them | `prepare.ts`: on the podium's rows, from the side facing the podium's middle, the walk in from the mask's end removes pixels of the band's colours (sampled past the character's own soft edge); capped at 30 % of the box width; undone if it would take > 1/8 of the character or cut parts off (it ate Ganesha's legs at 4096 before the caps; a colour-typicality and a column-profile variant were tried and rejected: one kept the piece, the other cut the fixture mascot's rounded edge) | **fixed** (a 1–2 px gold line can remain) |
| 7 | White wall inside the TV cut-out | The AI's TV box includes the wall; a flat white wall cannot be told from a white product (measured: the air purifier's white body is flatter than the wall) | **Review correction**: draw a *Frame or border* (or *Decoration*) box over the wall. `prepare.ts`: such a user box over a product takes out of it the colour its border runs through (the wall), as large patches or ones reaching the box edge; the screen, a small white logo, and what stands in front (sound bar, speakers) stay — they are kept even when no longer touching the rest. Such boxes do not compete for pixels in the local masks. Review copy for frames/decorations now says what happens (they stay in the background; they never became layers of their own) | **fixed with the correction** (not automatic, by design); a thin light outline of the wall's shaded edge can stay with the TV |
| 1, 2 | Behind Ganesha: podium band distorted, left temple washed out | Patches only: the region mixes temple, frame column, lotus band, podium | `backgroundGuide.ts` mirror rule: the poster's symmetry axis is measured (93–97 % of known pixels agree; refined to the exact axis); a hole pixel takes its mirror image where the known pixels around it agree with theirs (structure, lightly blurred, ±0.5 % slack); decorations (the badge) are never copied (also excluded as patch sources). Then straight continuation (a run between two known pixels of one structure, same colour and continuing beyond both ends: frame column). The floor rule continues the podium's top under him | **improved**: frame column, lotus band, orange band, upper temple and podium top rebuilt from the creative; **not recoverable**: the temple's lower part (its mirror is hidden by the badge) and the podium's left end (the podium is off-centre: its own axis ≈ 318 vs the poster's 303; the lotus band visible between his legs shows the podium ends between x≈108 and 140) — patch estimates, now **flagged**: a new non-blocking check `guessed-<id>` ("Behind “…”, 65 % of the background could only be guessed…"), only for large guessed areas (≥ 40 % of the object and ≥ 2.5 % of the canvas; here only Ganesha) |

Also: the `base-estimate` message no longer offers "a clean background or the AI reconstruction (paid)" — neither exists in
the product flow; it now says what the rebuild uses. A same-row bias in the patches was tried again (with the badge
excluded): it smeared the podium into a beige band; removed.

**Measured (offline):** 607 crop: recombined vs original **4.008 %** visibly different (was 4.006 %), 6 stands, 0
transparent pixels, 0 pixels changed outside any layer when each is hidden. Real 4096 upload: prepare **12.4 s**
(`bench-real/summary.json`), 5 stands, 0 transparent, 0 changed outside; browser full route: server prepare **8.1 s**,
export 4096×4089.

**Tests (final code, exact):** typecheck server + client **pass**; eslint (changed files) **pass**; `npm run build` **pass**.
Unit: product suites + protectedTemplates + runtimeAssets **103 passed / 24 files** — new `tests/unit/productBackground.test.ts`
(4: mirror on a drawn symmetric layout within mean error < 3 and the exact axis, a one-off badge never copied; no mirror
on an asymmetric layout; floor continued under a stand and not above its reach; a drawn wall over a TV leaves screen,
sound bar and both speakers in the TV and the wall in the background). Browser (offline, isolated ports): recorded
`product-stands`, `product-review-words`, `product-generation` **3 passed**; `product-ai-detection` **2 passed** (full
4096 route, timeout case); `product-templates` + Text `master-templates` **9 passed**. Not run: handmade-mode specs, the
full unit suite. Failures met on the way and fixed (none by loosening an assertion): `prepare.test` mascot colour in its
background (the band walk cut its rounded edge → samples past the soft edge), `productStands` stand below the podium
line (a stand extended through Ganesha → never through characters), placements off by 3 px (outline rule too loose →
own edge colour only).

**Files:** `server/src/decomposition/protectedTemplates/product/{backgroundGuide.ts (new), prepare.ts, risers.ts, inpaint.ts
(source exclusion)}`, `client/src/features/productTemplates/ProductReview.tsx` (copy), `tests/unit/productBackground.test.ts`
(new). Harnesses: `test-results/product-v8/{defects,zoom,flat-stats,podium-axis,fixture-check,objects}.mts`.

**Still open (exact):** the lower temple and the podium's end behind Ganesha are guesses (flagged); two neighbouring stands of
different colours join on the real upload (purifier riser + dishwasher base), making that stand look tall when the
dishwasher is hidden; Ganesha's foot-shadow specks stay in the background; the TV wall needs the review correction.
A paid AI inpainting of the guessed areas would be the next step for #1/#2 (not built; needs approval).

## Full-size uploads (fifth block, 22 Oct evening) — FIXED, verified offline (no paid call)
**Note:** this file was found truncated to 5 bytes (`claud`, 17:40 IST) and was rebuilt exactly by replaying the previous
session's recorded edits (its transcript); the broken copy is not needed.

The user's real upload (`artifacts/…/pt-0b57d0765fb6/source.jpg`, 4096×4096 JPEG, 7.4 MB) failed AI detection with a
misleading `PROVIDER_ERROR` (previous session: 9.4 MB PNG sent, SDK timeout at 120 s unclassified; fixed then: 2048 px
analysis copy, timeout classified, honest UI). Preparing at that size then never finished. Root causes found and fixed:

| # | Defect at 4096 px | Root cause | Fix |
|---|---|---|---|
| 1 | Prepare crashed (`RangeError: Maximum call stack`) | `risers.ts` `Math.max(...px)` on a stand's millions of pixels | loop; also O(regions×pairs) border scan and `pending.includes` (quadratic) made linear |
| 2 | Prepare took **270 s** (190 s in one function) | `fillOverlayPixels` appended each sample with `[...old, c]` (O(m²) per colour bucket) and rescanned each masked run per pixel | push; one scan per run (identical output) |
| 3 | Objects/stands came out differently by size (6 stands at 607 px, 4 at 1024, **1 at 2048/4096**) and patch inpainting took ~40 s | the analysis' thresholds are in pixels (tuned on ~600 px) | **`product/multiscale.ts`**: masks, stands and the background rebuild run on an area-averaged working copy (long side 768); each layer is then taken from the full-size pixels: labels upsampled by a colour-guided (joint bilateral) vote so edges follow the 4096 px picture; the rebuild sampled only inside the hole; text/logos never scaled. Pictures ≤ 768 px take the old path unchanged |
| 4 | On the real upload the floor (podium top) became a "stand" and the purifier's stand vanished | at working size the purifier's cream stand and the cream floor meet along a weak edge (steps ≤ 6): one region whose top is above the podium band, so the floor test rejected it | `risers.ts`: such a wide floor candidate is split again with finer steps (3): the largest part is the floor; parts reaching above the band in another colour are regions of their own (only runs when the old floor test fails) |
| 5 | Text ends left in the clean picture ("calls **lls**", "savings. **gs.**", stray `)` `3`) | word boxes are fractional at full size (scaled AI coordinates); `sweepPlainLines` started its letter search at `x0 − 2·lh` (fractional) so every pixel index was fractional → `undefined` → no components | band edges floored/ceiled |
| 6 | Small print matched serif/display faces (Lora, Abril Fatface) at 4096 | "small print = under 16 px → sans only" was absolute; the EMI line is 11 px at 607, 74 px at 4096 | threshold relative: `max(16, 2.6 % of the long side)` (`detect.ts`; unchanged at 607) |
| 7 | Editor: the 4096×4089 background layer did not show and **Export PNG failed** ("Layer "Background" could not load") | `decodeImage` capped pictures at the AI image limit (16,000,000 px) | editor decode limit = max(AI limit, 4096²) (`client/src/lib/assets/runtimeAssets.ts`) |

**Measured (offline, recorded answer, no network; `test-results/product-v7/`):**
- 4096×4089 (the crop enlarged, as the browser test uploads): prepare **270.2 s → 13.1 s** server-side in the browser run
  (`ai-detection/recorded-evidence.json`; before: `prepare-fullsize-4096.json` of product-v6, crash fixed only); peak memory
  2.3 GB → 1.66 GB.
- The user's real 4096×4096 JPEG (a copy in `input/`): prepare **12.0 s**, detection 5.2 s (`bench-real-final/summary.json`;
  never finished before). 5 stands, 9 cut-outs, 0 transparent background pixels, **0 pixels changed outside any layer** when
  each is hidden, recombined vs original 2.9 % visibly different (607 px: 4.0 %).
- 607 px: identical to before (6 stands, 4.006 %, every unit test unchanged).
- Targeted harnesses (seconds, not minutes): `prepare-bench.mts` (SRC=real|crop|work, WIDTH, WORK), `overlay-check.mts`
  (detection + text removal only, writes the headline's source/mask/clean), `make-work-copy.mts` (the 768 px working copy).

**Tests run on the final code (exact):** typecheck server + client **pass**; eslint on changed files **pass**; `npm run build`
**pass**. Unit: product suites + protectedTemplates + runtimeAssets **99 passed / 23 files** (incl. new
`productStands.test.ts` "a large picture (the scene at 4×, 2400×1600)…": same 2 stands, edges at full size within 2 px
(one working pixel where two same-coloured products meet), hidden objects change nothing outside, stand behind within mean
error < 14, prepare < 60 s — it takes ~1.5 s). Browser (offline fixture server, isolated ports): `product-ai-detection`
**2 passed** (recorded: **upload 4096 → detection → review → prepare → save → creative → Run Dashboard → editor (33 layers) →
Export PNG 4096×4089**, 28 s in all; timeout case); regression `product-stands`, `product-review-words`, `product-generation`
(recorded) **3 passed**; `product-templates` + Text `master-templates` **9 passed**. Not run: handmade-mode specs
(`product-variations`, `product-words`, `product-reference`), the full unit suite, `laptop`/`wide` projects.

**Limitations left (exact):**
- On the real upload two neighbouring stands (purifier's cream riser and the dishwasher's mint base) are joined into one
  stand by the existing "shading bands" join (median step ≤ 14); correct with the review's "Podium or stand → Its own layer".
  On the enlarged-crop test image the floor still splits as a wide "stand" (5 stands listed; "Keep in background" fixes it).
- Working-copy limits: where two objects of the same colour touch, their shared edge is decided at working size (±5 px at
  4096); a stand's completed (hidden) part and the rebuilt background are working-size estimates, softer than the photo.
- An artificially enlarged (blurred) upload leaves faint text outlines on plain plates (soft edges wider than the plate
  test's ±16); the real 4096 upload is clean.
- Preparation runs on the server's main thread (~12–13 s at 4096 px; requests wait meanwhile). A worker thread is the next
  step if uploads grow.
- The user's own template `pt-0b57d0765fb6` still shows its failed detection; detecting it for real is **one paid call**
  (gpt-5.6-sol, ≈ $0.14–0.36) — needs approval. The recorded answer only replays in tests.
- The seven visual defects of the background estimate (behind Ganesha, dishwasher strip, TV line, orange smear, hip piece,
  wall in the TV) are **not addressed** in this block.

Files: `server/src/decomposition/protectedTemplates/product/{multiscale.ts (new), prepare.ts, risers.ts, detect.ts}`,
`client/src/lib/assets/runtimeAssets.ts`, `tests/unit/productStands.test.ts`, `tests/e2e-image-templates/product-ai-detection.spec.ts`
(evidence now to `test-results/product-v7/ai-detection/`), harnesses in `test-results/product-v7/`. No commit, no paid call;
the dev server was idle before each backend edit (it reloaded on them).

## Paid AI requests (all with explicit approval)
| When (UTC) | Provider / model | Purpose | Requests | Actual cost | Result |
|---|---|---|---|---|---|
| 2026-10-22 08:36 | OpenAI Responses, gpt-5.6-sol (vision, high detail, strict schema, 16k output cap, no retry) | Live detection of the LG Ganesh creative through the app's real upload UI (isolated server, hard cap 1 call, every other outgoing request refused) | 1 | **$0.2177** (1,632 input / 10,561 output tokens, from the response's `usage`) | Model answer complete and good; **our validator rejected it** (fixed; replayed offline since) |

| 2026-10-22 09:42 | OpenAI Images, gpt-image-2 (medium, no retry) | 3 artworks for recomposed variations (16:9, 9:16, 1:1), see P3 | 3 | **$0.1205** | Text-free, followed the layout; recorded in `tests/fixtures/recorded/gpt-image-2-ganesh-*.png` |

Total spent: **$0.3382**. The fourth block (display stands) made **no paid request**.

Free, non-billable check: `GET /v1/models/{id}` → gpt-5.6-sol, gpt-image-2, gpt-5.6-luna available to the account (credits
are only proven by the one call above). Approved budget left: **none**. Nothing else was sent.

**Outstanding provider tests awaiting approval:** (a) a second creative (e.g. "Golden days", 3 appliances) — 1 call,
≈ $0.14–$0.36; (b) optional AI reconstruction of the background behind objects (gpt-image-2 masked `images.edit`, 1 image,
≈ $0.04–$0.20 at 1024², not wired in the product flow yet); (c) the AI variation planner (≈ $0.08) and AI artwork
generation (not built, see P3).

## What the real answer showed (and what was fixed)
The recorded answer (`tests/fixtures/recorded/ganesh-lg-gpt-5.6-sol-2026-10-22.*`, also in
`test-results/product-v5/live-store/pt-2979464593c0/`) lists 42 words in 5 groups with pixel boxes, 19 marks (LG, Pine Labs,
16 bank/payment logos, the TV's own "LG OLED evo" mark, one "Unclear red-and-black bank logo"), Ganesha, 12 products and
the background structure (podium, headline arch, bell garlands, badge, temples, backdrop).

1. **Validator discarded the whole answer** — `refers_to` of a text block may name ≤ 8 objects; the headline named 9 and the
   offer 12. Fix (`shared/src/creativeTemplates/scene.ts`): unknown or extra references are dropped, never the analysis.
2. **The LG logo was dropped** — the model marked the LG mark on the artwork as `product_brand` with `overlay: true`; the
   detector skipped every `product_brand`. Fix (`detect.ts`): any overlay mark is a logo overlay (brand or partner); only
   marks on a product stay with it. "Unclear/unknown …" logos (and `other_logo`) need review instead of auto-approval.
3. **12 products instead of 8** — not a model error: it listed the TV's soundbar, subwoofer and two satellite speakers
   separately; all four lie inside the TV's box. In the reference they are one product ("OLED TV with sound system"), and
   as separate boxes they produced the only 4 **blocking** checks ("nothing found inside its box": the TV's layer claims
   those pixels). Fix (`detect.ts`): a product ≥ 70 % inside a product at least 4× larger is kept in that product's layer;
   the host's review note names them ("Includes Soundbar, … found inside it … Draw a box to make one its own product").
   Result: Ganesha + **8 products**. (Labels differ from the fixture: "air purifier" for the water purifier, "refrigerator or
   tall kitchen appliance" for the dishwasher — correctable in the review.)
4. **46 review checks → 15, none blocking** — 30 were one "estimated fill" note per word and 18 per logo; now one per text
   block plus one for all logos (`prepare.ts`). Remaining: per-object cutout notes (9), the background estimate (1), text
   blocks on busy artwork, overlaps.
5. **Replay without network** (`replayProductAnalyzer` in `analyzer.ts`): the stored answer goes through exactly the same
   post-network checks (`productSceneFromResponse`); labelled "gpt-5.6-sol (recorded answer, replayed)", cost 0, refused
   for any other image (sha256 check). Regression test: `tests/unit/productLiveReplay.test.ts`.

## Background behind objects (P2, partly done)
- **Fixed: transparent holes.** `inpaint.ts` — local multi-scale PatchMatch (exemplar) inpainting, deterministic, free.
  Prepare (`PRODUCT_PREPARE_VERSION` 4) now rebuilds what was behind every character/product from the surrounding
  artwork's own patches; the base is opaque; `quality.reconstructedPercent` (14.5 % on the LG creative) and a check say it
  is an estimate. Real-data result: `test-results/product-v5/evidence/02-…AFTER-inpaint.png` (before: `01-…`).
  Sunburst rays and the podium top continue; **still visible:** faint pink/grey strips where product bases stood (pixels
  not in the cutouts), the partly hidden left temple comes back washed out, smear where Ganesha's feet crossed the bands.
- **Tried and rejected:** inpainting under letter-shaped text holes — it drew ghost letters on the badge and copied podium
  colours into the white footer (`03-rejected-…png`). Text removal keeps the narrow fill + plain-plate sweep.
- Open: badge ribbon "g" remnant; faint streaks under the offer on the sunburst; optional paid AI reconstruction action.

## P1 word-by-word review — DONE (verified on the recorded real answer)
- Server (`service.ts`): `ReviewInput.words` (a word's text, box, removal, block; 'new' = a block of its own),
  `newTexts` (text the detection missed: own block, words laid across the drawn box, colour measured, pixels removed),
  `logos[].replacement` (picture uploaded via `POST /product-templates/:id/review-assets`, `prl-*` files), block view
  with `wordList`. Corrections are marked (`DetectedWord.corrected`, `LogoSlot.corrected`) and **kept when detection runs
  again** (`keepCorrections`: corrected/added/removed words, changed/added logos and user objects win over what is found
  again at their place; `detection.kept` counts them).
- Client (`ProductReview.tsx`): every text block opens into its words (list + boxes on the picture); a word's text, X/Y/
  width/height, block and removal; drag/resize/nudge words; "Add → Text the detection missed"; logo "Replace the picture"
  / "Use the original"; "Preview corrections" (replaced logos, corrected/added text, removed words greyed); the block's
  wording is locked once its words were edited one by one; button "Approve & Prepare Template".
- Tests: `tests/unit/productReviewWords.test.ts` (recorded answer → corrections → prepare → master → creative → run →
  detection again, corrections kept) and browser `product-review-words.spec.ts` (`FRAMEFLOW_PRODUCT_REFERENCE=1
  FRAMEFLOW_PRODUCT_RECORDED=1`): review → preview → prepare → save → creative → Run Dashboard → editor → export, all pass.
  Evidence: `test-results/product-v5/review-words/`.

## P2 background, text and cutouts — DONE for the listed defects (real-data checks)
- Behind objects: `inpaint.ts` (local PatchMatch), base opaque, `reconstructedPercent`; text-hole inpainting rejected (ghost letters).
- Word rendering (`detect.ts`): faces must draw every character of a line (the "₹" tofu box), small print (< 16 px) only
  among sans families (no serif EMI line), words kept inside their measured boxes by tightening letter spacing first, then
  ≤ 10 % size ("equallygrand" fixed).
- Text removal (`prepare.ts` `sweepPlainLines`): on artwork too, marks in the text's ink colour joined letter by letter to
  the line are removed (the badge's leftover "g"); on plain plates everything not the plate's colour around the words.
- Cutouts: disconnected stray parts of a local mask (< 15 % of its largest part) go back to the background.
- Visual regression on the real replay (`tests/unit/productLiveReplay.test.ts`): no transparent pixel, no object ghost
  behind any of the 9 cutouts, a clean validity pill, every glyph present, no word running into the next.
  Evidence: `test-results/product-v5/evidence/04-text-…png`, `05-ganesha-cutout-…png`.
- Still visible (estimates): product-base strips on the podium (pixels not in the local cutouts), a washed-out left
  temple behind Ganesha, smear near his feet; fragments still attached to Ganesha's cutout. Optional paid AI
  reconstruction is not wired into the product flow yet.

## P3 recomposed variations on new artwork — BUILT, verified offline; image model validated live once (3 images)
- `composition.ts`: real relayout per canvas — archetypes `stage-top` / `stage-bottom` (square and tall) and `split-left` /
  `split-right` (wide): products moved as one group (arrangement and overlaps kept, never stretched) onto a floor, the
  character beside them, every text block reflowed word by word into its zone (sizes fitted, ids kept), brand logos in a
  top band, partner logos in a centred footer grid, legal text at the bottom; old artwork decorations hidden.
- `artwork.ts`: background modes `template` (the existing behaviour), `local` (a free preset backdrop in the template's
  colours, labelled "no AI") and `ai` (one `gpt-image-2` `images.generate` per variation, medium quality, no retry; prompt
  asks for artwork only and room for the layout; generated at 1536×864 / 864×1536 / 1024² / 1216×1520, then cropped).
  Every AI artwork is read back by the local word reader (`artwork-check`): text drawn into it **fails** the variation
  (`AI_TEXT`, cannot be sent on). Logos cut from a white page are knocked out on new artwork (coloured tiles kept).
  Text colours fixed for readability on what is actually behind them; low contrast is flagged.
- Cost safety: `artwork: 'ai'` with a paid model is refused (`APPROVAL_REQUIRED`, estimate in the error) unless the request
  carries `approveArtworkUsd` ≥ the estimate ($0.06 × count); regenerating one AI-artwork variation likewise (one image).
  The UI shows the total and asks "Yes, spend $…". Job records `artwork: { mode, model, offline, requests, costUsd }`.
- The AI planner's schema (`liveVariationPlanner`) now also returns `composition` and an `artwork` description per
  variation (sanitised: no figures); the offline planner leaves both to the app.
- Checks now say what kind they are (`PRODUCT_CHECK_KIND`: Automatic / Picture / Your eyes); AI artwork always adds
  "Your eyes" (`AI_CONTENT`), so an AI variation is never shown as plainly passed. Cards say "Automatic checks passed",
  and label the background ("Test artwork (offline)", "AI artwork", "Simple backdrop · no AI").
- Tests: `product/generation.test.ts` (4 ratios on test artwork: canvases, archetypes, everything inside the canvas, no
  overlaps, products not stretched, typed headline drawn, AI_CONTENT; local preset makes no image request; "text drill"
  artwork fails and is refused by decomposition; a paid model is never called without the approved amount) and browser
  `product-generation.spec.ts` on the recorded Ganesh data (16:9 / 9:16 / 1:1 → cards → Run Dashboard → editor 1077×606
  → word edited → export 1077×606). Evidence: `test-results/product-v5/generation/`, `evidence/06-…png`.
- **Validated live (approved, $0.1205):** 3 real `gpt-image-2` artworks → 3 composed variations → the 16:9 one sent to the
  existing Run Dashboard → editor → export (`test-results/product-v6/live-artwork/`: form, cost confirmation, cards, each
  artwork and variation, dashboard, editor, export, `result.json` with prompts, request ids and costs, montages 08/09).
  The artwork was text-free and followed the requested composition. Findings: (1) the local text check read "FON" in the
  9:16 artwork's mandala (false positive) — fixed and locked by `tests/unit/productArtworkText.test.ts` on that real
  picture; (2) the products' floor line does not always meet the AI-drawn stage (16:9 most visibly) — the model does not
  place the stage exactly where asked; open (stage detection or a stricter prompt). 1216×1520 (4:5) was not part of this run.
- Not validated live: the live planner's composition/artwork fields (≈ $0.08, needs approval).

## Display stands on their own layers (fourth block, 22 Oct) — BUILT, verified offline (no paid call)
The "product-base remnants" were **display stands** (risers): a tall mint cylinder under the microwave, a cream one under the
purifier, a tall pink cylinder under the AC, mint bases under the dishwasher and under the washer + fridge, a pink platform
shared by the TV's sound set. Before, the product masks took pieces of them and the base kept cut-off stubs.
- **Detection** (`product/risers.ts`, general, no AI): the display area is split into smooth regions (neighbours joined
  while colours step ≤ 6); a region ≥ 85 % inside one object's box is that object's; the **floor** is the widest region resting
  on the podium's front band (kept with the podium); a **stand** is any other region of some size touching a product's lower
  half, not in the podium's box nor in a decoration's, with a product standing on it. Shaded bands of one stand are joined
  where the colour runs on across their edge; slivers between bands and thin stand-coloured edges left in a product's mask go
  with the stand. **Completion:** a stand's sides are upright, so each hidden column continues to the stand's top and bottom
  lines (followed from where they are seen, outliers ignored), coloured from the nearest clear pixel seen in that column. A
  stand more completed than seen is flagged "Mostly hidden: check it".
- **Layers** (`prepare.ts`, `PRODUCT_PREPARE_VERSION` 5): stands are taken out of the products' and characters' masks and out
  of the background (rebuilt behind them); each stand gets its own cut-out (seen pixels + completed part); products are
  blended against the stand behind them. The shared podium is never a stand and stays in the background. One check
  ("N display stands were made their own layers…") lists the mostly hidden ones.
- **Characters:** a smooth region that mostly continues outside a character's box and never reaches its middle is scenery
  (Ganesha lost the stand rectangle, the frame line above his head and the podium's long stripes under his feet).
- **Manual correction** (beginner-friendly): in the review, a "Podium or stand" box has *How should it be kept?* — **Its own
  layer** (a stand that was missed; the smooth regions mostly inside the box, in any colour) or **Part of the background**
  (a found stand inside it stays in the background). In Prepare, each stand has **Keep in background** (asks first, then
  prepares again). New boxes drawn as "Podium or stand" default to their own layer; the AI's big podium to the background.
- **Downstream:** `ProductPrepared.stands` (kind `podium`, `layer: 'own'`, `stand: {under, visiblePixels, completedPixels,
  uncertain}`); saved revisions include them; creatives draw them under the products (z below every product) and list them
  under *Display stands* (show/hide, drag on the canvas); a decomposition run makes each an **object** layer (`layer-NN-stand.png`)
  that the editor opens as its own image layer. Recomposed variations on new artwork hide them (existing podium rule).
- **Real creative (recorded answer, replayed, `test-results/product-v6/stands/`):** 6 stands, each under the right products;
  2 flagged mostly hidden (AC cylinder 67 % completed, microwave cylinder 68 %). Recombined vs original: 4.006 % of pixels
  visibly different (was 4.001 %); rebuilt background 15.44 % of the canvas (was 14.46 %). Product cut-outs no longer carry
  stand pieces (`stands-cutouts.png` vs `cutouts-sheet.png`); scene with every product hidden: `stands-noobj.png`; each
  product hidden: `stands-hidden-montage.png`.
- **Verified (offline):** hiding or moving any product, Ganesha or any stand changes **0 pixels** outside its own old/new
  place, never leaves a transparent pixel, leaves no copy of a stand in the background (< 35 % alike) and no copy of a
  product; the podium band is the original's own pixels everywhere nothing was taken out (100 % of > 15,000 pixels). On a
  drawn scene whose truth is known, the stand behind a hidden product is within a mean error < 14 of the truth.
- **Browser (recorded answer):** Prepare lists 6 stands; with every product hidden the stands stay; the washer dragged → its
  stand stays; the stand dragged → washer and fridge stay; 390 px without sideways scrolling; one stand kept in the
  background → prepared again with 5; saved → creative lists 5 stands → Run Dashboard → editor: each stand its own layer;
  a stand moved 20 px in the editor changed **1,345 export pixels inside its old/new place and 0 outside**; after a reload
  and reopen from Saved Runs it is still moved and the export is **pixel-identical** (0 pixels changed). Screens:
  `test-results/product-v6/stands-browser/`.
- **Tried and rejected:** a same-row preference in the inpainting (to stop podium bands piling up behind Ganesha): weak
  settings changed nothing visible, strong ones copied the badge into the hole (`rowprior-compare.png`). Reverted.

### Unresolved (stands and background), exact
- Behind Ganesha the rebuilt background still shows the podium band piled up and the left temple washed out (an estimate,
  flagged by the existing `base-estimate` check).
- Behind the dishwasher, an ~8 px strip of the striped background shows between the pink cylinder's bottom and the mint base
  (should be the podium's top surface); a thin white line is left above where the TV was; moving the washer's stand reveals a
  small orange smear (gold rim patches) where it stood.
- The white wall behind the TV is inside the TV's detected box and stays with the TV (by design: a region inside one
  object's box is that object's). A user can draw it as "Podium or stand → Its own layer" to separate it (not tried live).
- Ganesha's cut-out keeps one textured podium piece at his right hip (ornamented band, not a smooth region).
- Stand detection needs a detected podium (or the administrator's own boxes); a wide platform taken for the floor when the
  real floor is in the background's colour stays in the background (corrected by drawing it as its own layer).
- Completed parts are estimates: rounded corners behind products come back square; a shadow seen on a stand is continued.

## Not done / not verified (exact, after the third block of work)
- **Live validation owed (needs approval):** `gpt-image-2` artwork for recomposed variations (≈ $0.06/image), the live
  planner's composition/artwork fields (≈ $0.08), live detection on a second creative (≈ $0.14–$0.36). No paid call was made
  in this block.
- P2 leftovers (all estimates, flagged): ~~product-base strips~~ (fourth block: the stands are now layers of their own),
  the washed-out left temple behind Ganesha, smear near his feet, one podium piece on Ganesha's local cutout, the small
  background defects listed under *Display stands → Unresolved*; optional paid AI reconstruction of the background behind
  objects is not wired into the product flow (the app has `cleanBackground.ts` for it).
- Recomposition design limits: one floor line per layout; the old artwork's badge text becomes a plain supporting line;
  brand logo order follows the template's; no shadows under relocated products.
- The full unit suite was run in the fourth block (see its tests): 11 failures that pre-date the product work remain;
  not run: the full offline E2E suite and the `laptop`/`wide` Playwright projects.
- Stage seating on new artwork (third block, P1): `stage.ts` finds the podium's top surface in the artwork (ellipse search;
  `tests/unit/productStage.test.ts` on the 3 real gpt-image-2 artworks, within tolerance, and none on a plain gradient)
  and seats the product group and the character on it with contact shadows; a `STAGE` warning when none is found.

## Completion criteria (from the brief), honestly
1 live detection: **1 creative tested live** ($0.2177); a second needs approval. 2 correct every word, logo, product,
character: **yes** (verified on the recorded real answer). 3 masters saved/reused: **yes**. 4 objects move without holes:
**no holes; display stands are separate layers and stay whole (fourth block); the rebuilt background is an estimate with
visible imperfections**. 5 genuine AI generation: **built and validated live once**
(3 gpt-image-2 artworks, text-free, followed the layout; stage alignment imperfect; planner fields not live-tested). 6 aspect ratios: **real relayout for all four** (new artwork) or
lengthened margins (template artwork). 7–10 editable elements through variation → Run Dashboard → editor → save/reopen/
export: **yes**. 11 browser tests + visual inspection: **yes, offline**. 12 existing Product and Text features: see tests.
**Not complete yet:** live detection is proven on one creative only, the background estimate behind moved objects shows
visible imperfections, the AI stage does not always meet the products' floor, and the live planner fields are unverified.
**Update 23 Oct (twelfth block):** the whole offline route Master Template → Generate with AI (no prompt) → Decompose &
Edit → editor → save/reopen → export is verified in one browser journey on the LG creative (recorded real answer and
artworks). Still not verified live: detection on a second creative, per-variation gpt-image-2 generation today, the AI
planner, SAM-3 cut-outs. Still broken: the Onam dotted border behind removed decorations; a much longer edited word is not
wrapped at the canvas edge.

## Tests — fourth block, display stands (`test-results/product-v6/`), exact
- `npm run typecheck`: **pass**. `npm run lint` (whole repository, `--max-warnings 0`): **pass**. `npm run build`: **pass**.
- New unit tests `tests/unit/productStands.test.ts`: **4 passed** (drawn scene with known truth; administrator's boxes;
  real LG creative — products, Ganesha and every stand hidden/moved, ghosts, podium band; through the service — prepared,
  saved, creative, corrected in the review).
- **Full unit suite** (`npx vitest run`, 166 files), final code: **13 failed, 1603 passed, 10 skipped** (`unit-final.log`).
  Then, without rerunning the whole suite: `tests/unit/productReviewWords.test.ts` **1 passed** after its layer count was made
  stricter (it counted 9 object layers; the run now has 9 product/character layers **and** 6 stand layers — it now checks
  both numbers and the total 15); `imageTemplates` + `smartCreative` in isolation: **70 passed, 0 failed**, twice
  (`unit-isolated-1.log`, `-2.log`), and once before (`unit-others.log`).
- **The other 11 failures were there before this work** (checked, not assumed): the same 11 tests fail with **identical
  messages** in `test-results/artwork-v1/unit-full.log` (2026-10-21 03:15) and `test-results/final-v1/unit-full.log`
  (2026-10-21 02:10) — before the Product with Text work began (`test-results/product-v1/` created 2026-10-22 08:59).
  The 8 Template Studio ones (`generator-costs` ×1, `pipeline` ×6, `router` ×1) also fail in `test-results/recovery/
  vitest-baseline.log` (2026-10-20 12:11) and at HEAD in `test-results/master-ai-v2/baseline-head-studio.log`; the files
  they exercise (`server/src/templateStudio/*`) carry uncommitted changes dated 2026-10-20, none made in this work. They do
  import modules changed here (through `shared/src/index.ts` and `layerizeRouter.ts`; esbuild import trace), so the
  conclusion rests on the baselines, not on imports. The 3 others (`imageTemplates` ×2, `smartCreative` ×1) are timeouts
  /timing under full-suite load (5 s test timeout; `smartCreative` took 140 s in the full run) and pass in isolation; a
  third `imageTemplates` test ("shows what a stopped server left behind…") timed out the same way in the final full run only.
- **Browser** (offline fixture server on isolated ports 3351/3352, client built from this code):
  recorded real answer (`FRAMEFLOW_PRODUCT_REFERENCE=1 FRAMEFLOW_PRODUCT_RECORDED=1`): `product-stands` (new) **1 passed**,
  `product-review-words` **1 passed**, `product-generation` **1 passed**; handmade Ganesh (`FRAMEFLOW_PRODUCT_REFERENCE=1`):
  `product-variations` **1 passed**, `product-words` **1 passed**, `product-reference` **1 passed**; plain fixture:
  `product-templates` **2 passed**, Text `master-templates` **7 passed**. Total **15 passed, 0 failed** on the final code.
- Failures found on the way and how they were resolved (no assertion weakened): `product-variations` — stands were sent to
  the run as "artwork" layers, so the run had 9 object layers for 12 creative objects: **code fixed** (a stand is an object
  layer); `product-words` — counted exactly 9 object layers: **made stricter** (9 product/character layers + exactly the
  prepared stands by id); `product-templates` — first run by mistake with `FRAMEFLOW_PRODUCT_REFERENCE=1` (real OCR), which
  that spec is not written for: in its own fixture mode **2 passed**.
- Safety: 747/747 files of the safety snapshot unchanged (`safety-after-stands.json`); no test server or test process left
  running; the dev server (PID 27662) never stopped (backend edits made after idle checks; it reloads on them). No commit,
  push, reset or stash. Paid calls: **none**.

## Tests — final run of the third block (`test-results/product-v6/`)
- `npm run typecheck`: **pass**. ESLint (`--max-warnings 0`) on every changed file: **pass**. `npm run build`: **pass**.
- Unit: `server/src/decomposition/protectedTemplates`, `tests/unit`, `client/src/features/{masterTemplates,protectedTemplates,
  decomposition,productTemplates}`, `shared/src`: **58 files, 533 passed, 1 skipped, 0 failed**.
- Browser, recorded real answer (`FRAMEFLOW_PRODUCT_RECORDED=1`): `product-review-words`, `product-generation`: **2 passed**.
- Browser, handmade fixture: `product-variations`, `product-words`, `product-reference`: **3 passed**.
- Browser: `product-templates` (create + reuse → variations → Send to Decomposition → editor): **2 passed**;
  Text `master-templates`: **7 passed**.
- Two failures in the first pass were test issues, fixed and re-run: `product-reference` had been run in recorded mode
  (it is written for the handmade fixture's "Ganesha" label; passes in its own mode), and `product-templates` looked for
  the old "Checks passed" label (now "Automatic checks passed"; the assertion still fails on "Failed checks").
- Safety: 747/747 snapshot files unchanged; no test server left running; the dev server (PID 27662) never stopped.
  Paid calls in this block: **none**.

## Tests (this session) — see `test-results/product-v5/`
- Unit: `server/src/decomposition/protectedTemplates/product`, `tests/unit`, `shared/src/creativeTemplates`: **20 files, 132 passed**
  (incl. the new recorded-answer replay test).
- `npm run typecheck`: **pass**. `npm run build`: **pass**. ESLint on every file changed this session: **pass**.
- Browser (offline, fakes, isolated ports): Ganesh specs `product-variations` (Variations → Send to Decomposition → Run
  Dashboard → editor → edit → export → reload/reopen), `product-words`, `product-reference`: **3 passed**;
  `product-templates` (2) + Text `master-templates` (7): **9 passed**. Logs: `browser-reference.log`, `browser-regression.log`.
- Real answer through the real upload UI (replayed, free): `test-results/product-v5/replay-ui/02-after-detection.png` —
  1 character, 8 products, 42 words, 5 groups, 18 logos, 9 items to look at. (That screenshot's template name still says
  "live AI detection": the driver's name was fixed after it was taken; the stored detection says "recorded answer, replayed".
  The UI notice for replays was added after the build used for it.)
- Safety: all 747 files of the earlier safety snapshot (user artifacts + reference images) re-hashed **unchanged**; no test
  server left running; the user's `tsx watch` dev server (PID 27662) was never stopped (it reloads on backend edits; every
  backend edit followed an idle check). No commit, push, reset or stash.

## How to continue
1. `node --conditions=development --import tsx test-results/product-v5/replay-detect.mts` (+ `PREPARE=1 OUT=<dir>`) replays the
   real answer and prepares it offline (no network) — the fastest loop for detection/background work.
2. Isolated UI server on the real data (no paid calls): `FF_PORT=3360 FF_SEED=test-results/product-v5/live-store node
   --conditions=development --import tsx test-results/product-v5/live-server.mts` (analyzer off; `npm run build` first).
   `FF_LIVE_ANALYZER=1 FF_LIVE_CAP=1` enables ONE live call — only with new approval.
3. Browser tests on the recorded real answer: `npm run build`, then `FRAMEFLOW_PRODUCT_REFERENCE=1 FRAMEFLOW_PRODUCT_RECORDED=1
   FRAMEFLOW_OFFLINE_E2E_PORT=3351 npx playwright test -c playwright.offline.config.ts tests/e2e-image-templates/product-review-words.spec.ts
   tests/e2e-image-templates/product-generation.spec.ts --project=desktop --workers=1`.
4. Stands, offline and free: `node --conditions=development --import tsx test-results/product-v6/stands-replay.mts` (the
   recorded answer prepared with stands; writes layers, each product hidden, everything hidden, `checks.json`) and
   `npx vitest run tests/unit/productStands.test.ts`; browser: `tests/e2e-image-templates/product-stands.spec.ts` (recorded mode).
5. Full-size uploads (fifth block): `SRC=real node --conditions=development --import tsx test-results/product-v7/prepare-bench.mts`
   (≈ 20 s, real 4096 upload, writes checks/evidence); for stand work use `SRC=work` (the 768 px working copy, ≈ 3 s).
   Browser: `FRAMEFLOW_PRODUCT_AI_CLIENT=recorded FRAMEFLOW_OFFLINE_E2E_PORT=3361 npx playwright test -c playwright.offline.config.ts
   tests/e2e-image-templates/product-ai-detection.spec.ts --project=desktop --workers=1` (after `npm run build`).
6. Next tasks: (a) the background-estimate defects (section 7 of the brief); (b) stands joined across colours (hue check in
   the band join); (c) prepare in a worker thread; (d) align products to the AI stage (find the stage's top edge in the artwork, or a stricter prompt);
   (b) P2 leftovers; (c) with approval: live detection on a second creative, the live planner, a 4:5 artwork.

## Files changed in this session (on top of the earlier handoff's list)
- `shared/src/creativeTemplates/scene.ts` — `refers_to` no longer discards a whole analysis.
- `shared/src/productTemplates.ts` — `PRODUCT_PREPARE_VERSION` 4, `quality.reconstructedPercent`.
- `server/src/decomposition/protectedTemplates/product/analyzer.ts` — `productSceneFromResponse`, `replayProductAnalyzer`.
- `server/src/decomposition/protectedTemplates/product/detect.ts` — overlay marks → logos, unsure logos flagged, nested products merged.
- `server/src/decomposition/protectedTemplates/product/prepare.ts` — inpainting behind objects, opaque base, grouped checks.
- `server/src/decomposition/protectedTemplates/product/inpaint.ts` — **new** (local multi-scale PatchMatch).
- `client/src/features/productTemplates/{ProductPrepare.tsx, ProductTemplates.tsx}` — reconstruction wording; replay notice.
- `tests/unit/productLiveReplay.test.ts`, `tests/fixtures/recorded/ganesh-lg-gpt-5.6-sol-2026-10-22.{request,response,usage}.json` — **new**.
- `test-results/product-v5/{live-server.mts, live-detect.mts, replay-detect.mts}` — isolated verification tools (not app code).

## Files changed in the third block (word review, P2 fixes, recomposed variations)
- `shared/src/protectedWords.ts` — `DetectedWord.corrected`, `LogoSlot.corrected`.
- `shared/src/productTemplates.ts` — `detection.kept`, background `ai-artwork`/`local-backdrop` + `artwork`, `layout.composition`,
  check codes `AI_TEXT`/`AI_CONTENT`/`LOW_CONTRAST`, `PRODUCT_CHECK_KIND`, `PRODUCT_ARTWORK_MODES`.
- `server/src/decomposition/protectedTemplates/product/service.ts` — word edits, regrouping, added text, review assets,
  logo replacement, `keepCorrections` on re-detection.
- `…/product/routes.ts` — `POST /:id/review-assets`, regenerate approval amount.
- `…/product/detect.ts` — glyph-complete faces, sans for small print, words kept inside their boxes.
- `…/product/prepare.ts` — ink-colour letter sweep on artwork, stray mask parts dropped.
- `…/product/composition.ts`, `…/product/artwork.ts` — **new**.
- `…/product/variations.ts` — artwork modes, composition, artwork checks, approval gate, planner schema fields.
- `…/product/productPoster.fixture.ts`, `productServer.fixture.ts` — fake image model, custom analyzer/artwork options.
- `server/src/decomposition/layerizeRouter.ts` — `productArtwork` option (live: `liveArtworkGenerator` with an OpenAI key).
- `client/src/features/productTemplates/{api.ts, ProductReview.tsx, ProductTemplatePage.tsx, productTemplates.css}`.
- Tests: `tests/unit/productReviewWords.test.ts`, `…/product/generation.test.ts`, `tests/e2e-image-templates/product-review-words.spec.ts`,
  `product-generation.spec.ts` (new); `tests/unit/productLiveReplay.test.ts`, `productLayoutSweep.test.ts` (extended/rewritten
  intent); `tests/fixtures/imageTemplateOfflineServer.ts` (recorded-answer mode, offline image model).

## Files changed in the fourth block (display stands)
- `server/src/decomposition/protectedTemplates/product/risers.ts` — **new** (stands: regions, kinds, hints, completion).
- `…/product/prepare.ts` — stands out of the masks and the base, their cut-outs, products blended against them; scenery
  regions out of a character's mask; the cut-out code shared by objects and stands.
- `…/product/service.ts` — `ProductPrepared.stands` (ids `po-…` from the template and the stand's place), saved in revisions;
  review keeps a podium's `layer`.
- `…/product/creativeRun.ts` — a stand is an object layer (`layer-NN-stand.png`) with its own description.
- `shared/src/productTemplates.ts` — `PRODUCT_PREPARE_VERSION` 5, `ProductObject.layer`, `ProductPrepared.stands`.
- `client/src/features/productTemplates/{api.ts, ProductReview.tsx, ProductPrepare.tsx, ProductTemplatePage.tsx, productTemplates.css}`
  — the own-layer choice, the stands list with *Keep in background*, stands in the creative editor.
- Tests: `tests/unit/productStands.test.ts`, `tests/e2e-image-templates/product-stands.spec.ts` (new);
  `tests/unit/productReviewWords.test.ts`, `tests/e2e-image-templates/product-words.spec.ts` (layer counts made stricter).
- Evidence scripts (not part of the app): `test-results/product-v6/{stands-replay,risers-try,synthetic-try,grid,sheet}.mts`.

## 2026-10-23 continuation — source changes, runtime-unverified

Resumed the interrupted implementation and retained the existing uncommitted work. Source inspection and file edits only; no saved templates, credentials, or generated artifacts were changed during this continuation.

- Detection: kept the configured model and 300-second wait. Stored background Responses jobs use retrieval with zero SDK retries. Pending, unknown submission, rejection and unavailable response states are distinguished. Recovery verifies the original image hash and uses recorded analysis dimensions. Repeated uploads share a pending request instead of silently submitting again; a new request requires explicit approval.
- Editor handoff: Inspect and saved templates open the existing Konva editor, preserving draft warnings and independent objects, words and logos. Original approved revision files remain immutable.
- Persistence: creative saves use optimistic revisions; master saves append a separate draft revision and clear current approval. A master-save conflict after a successful creative save is reported explicitly. Duplicates do not retain master-save authority.
- Coordinates: source dimensions survive editor rounding. Product canvas resize uniformly fits and centres the composition. Rotated text uses reversible baseline/origin conversion. Raw backgrounds, hidden states, transforms, canvas fill and common layer order survive serialization; preview runs now use version 5.
- Reuse: the chosen master revision supplies native assets, text and object metadata. Default generation makes three typography variations without image generation or Seedream calls. Explicit redesign retains its cost approval and quality gates; failed results cannot bypass checks through previously saved IDs.
- Native import accepts the product manifest's 400-word/201-layer bounds while ordinary designs retain their existing limits.

Manual verification still required: (1) recover the matching LG answer and confirm original-pixel boxes; (2) decompose, Inspect, then open a draft and move Ganesh Ji, one product and one bank logo independently; (3) edit/rotate/hide/reorder, resize, save a master draft, reopen from the library in a fresh browser context and export; (4) save conflicting edits from two tabs and confirm refusal without losing local edits; (5) select the edited revision, generate the default three native variations, save/reopen/export one and confirm the parent revision is unchanged; (6) explicitly approve a fresh detection/redesign only when ready to test paid paths, including timeout retrieval and blocking raster-text checks. Legacy preparations may require preparation with the current all-logo exclusion rules. Actual provider availability, segmentation quality, visual fidelity and end-to-end operation remain unverified.

No commands, tests, builds, servers, browser automation, or external API calls were executed during this continuation. Changes remain runtime-unverified.

## 2026-10-25 — AI product reuse and selected-variation decomposition verified offline

This supersedes the 2026-10-23 runtime-unverified reuse status above. Generate with AI now defaults to three preserved-composition variants with new product packshots and different mixes within supported product families. Ganesh Ji, background, decorations, logos, canvas and layout anchors remain original assets. Typography-only and redesign are explicit separate modes. Provider availability, image count, approval and failed/duplicate outputs are visible.

Selected variation → Review → selection → explicit OpenAI + fal cost approval → Seedream adapter → Inspect → editor is implemented. A selected variation cannot silently use local preparation. Native backgrounds are labelled references, object masks use the AI path, overlays are excluded from the input, and the dashboard separates editor conversion from upstream preparation cost.

Executed: 7 focused Vitest files / 15 tests passed; strengthened real-LG Playwright journey / 1 passed. The browser checks generated assets and distinct mixes, both cost approvals, denied local/unapproved calls, the actual Seedream adapter through a fake transport, overlay-free input pixels, original background position, independent move/resize/hide, editable text, save/reopen/export and cost provenance. Typecheck, targeted ESLint and build pass; Vite reports the existing large-chunk warning.

No live paid calls or credit use. Temporary stores and injected test providers only; saved user templates, runs, uploads, credentials and unrelated work were preserved. Offline synthetic visuals do not establish live product image or segmentation quality. Full commands, file inventory, evidence, limitations and manual steps: [TEMPLATE_REUSE_VERIFICATION.md](TEMPLATE_REUSE_VERIFICATION.md).


## 2026-10-26 — generation recovery verified; real LG master remains blocked

Continued the existing implementation. Added durable per-image attempts/raw outputs/cutouts, retained plans, sanitized request diagnostics, bounded waits, no automatic paid retry, one-image explicit recovery, orphaned/legacy-failed status projection, source-quality preflight and an optional one-image smoke test. Three full variations remain the primary workflow. Completed images and variations survive later transport/credit failures.

The two live-job failures are separate: older transport causes remain unknown because original details were not saved; the newer job explicitly exhausted OpenAI credit. Neither explains the saved source's Water purifier residual. Both LG revisions retain the same defective background, with a 49% residual blocking check. New generation/recovery from that revision is blocked. Temporary offline reconstruction was attempted and rejected for conspicuous silhouettes, damaged stand geometry and an empty speaker extraction. No repair was promoted; clean supplied artwork or separately approved AI repair and inspection are still required. Raw provider backgrounds and all-object residual/provenance diagnostics will now be retained for new preparations; existing quality thresholds are unchanged.

Final verification: 11 targeted Vitest files / 28 tests passed; 2 Playwright journeys passed (three variations → selection → separately approved mock Seedream → editor → edit/save/reopen/export, and interrupted generation → explicitly approved one-image recovery). Typecheck, targeted ESLint and production build passed; existing Vite chunk warning only. Background-specific tests reject a provider that leaves products behind and verify exact native background provenance while object masks still use the AI path. Offline synthetic images do not prove live realism or quality.

All 226 files in the saved LG template directory matched their pre-edit SHA-256 hashes; no saved records or images changed. No paid calls were initiated, no active server was restarted, and no commit/push occurred. Live end-to-end readiness is **blocked by source repair and account credit**. Legacy jobs do not silently rebase to a repaired revision. Full findings, exact file inventory/test commands, visual evidence, recovery limitations and manual approvals: [LIVE_PRODUCT_GENERATION_FIX.md](LIVE_PRODUCT_GENERATION_FIX.md).


## 2026-10-26 (afternoon) — one approved generation batch; smoke test pauses honestly

Normal generation now runs every image of the three variations under one recorded approval (image count + estimated
spend, enforced right before each request), two requests at a time, composing each variation as soon as its images
exist. The smoke test generates one image and reports "Smoke test completed …"; one continuation approval finishes the
rest, reusing saved images. Failed or unknown-outcome images are retried only when explicitly ticked. States are
distinct (paused, stopped, completed, credits exhausted, provider failure, connection interrupted, interrupted, source
blocked). The user's job `pv-ec8c6243` reads as a paused smoke test with 3 of 36 saved; continuing it costs about $1.98 for
33 images. Verified offline: 11 Vitest files / 31 tests, 3 Playwright journeys, typecheck, build. Five older product
specs fail identically on the pre-change code (stale default mode). Details: [GENERATION_BATCH_APPROVAL.md](GENERATION_BATCH_APPROVAL.md).

## 2026-10-26 (evening) — Reuse Template studio (new, separate from variations)

Offer Templates → Product templates → **Reuse Template**: the saved revision reused with the person's own product set
(select / deselect / add / replace / remove / restore / reorder, uploads composited as layers), copy and logos, products
placed on the podium (template places, free fixed rules, or approved AI placement with every box checked), formats
original / 3:9 / 4:9 / 16:9 recomposed without stretching (slice / mirrored clean side strips, flagged), complete-poster
previews with checks, saved as creatives, reopened drafts, Decompose & Edit through the existing approved Seedream route,
and the editor. Offline only. The real template's painted display risers remain a visual limitation. Details:
[REUSE_TEMPLATE_STUDIO.md](REUSE_TEMPLATE_STUDIO.md). A live 36-image batch (pv-cc404718, 15:17–15:26 IST, by the user)
completed all three variations under one approval ($1.92 usage-derived estimate).

