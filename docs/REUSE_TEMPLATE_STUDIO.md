# Reuse Template studio — 2026-10-26

A saved Product with Text master template reused with the person's own product set, copy, logos and output formats, then
saved as creatives that open in the editor or go on to the separately approved OpenAI + Seedream decomposition.
Separate from Generate AI Variations (unchanged). Built and verified offline only: no OpenAI or fal request, no commit.

## Where

**Offer Templates → Product templates → card → Reuse Template** (beside Use template, Generate AI Variations, Edit master).
It opens the template's reuse drafts (Continue editing) or **Start a new reuse**, which loads the saved reviewed revision
(products, characters, words, logos, background, podium) without any new detection.

## Create a New Creative (the simple flow, default since 26 Oct evening)

**Reuse Template** now opens **Create a New Creative**: (1) **+ Upload Products** or drag photos (several at once;
thumbnails, select/deselect, rename, Make main product, remove, add more; a "What is it?" choice only when a photo's kind
isn't recognised); every product of the template is left out of the new creative automatically (the template is never
changed; Ganesh Ji, the festive art, text and logos stay); (2) **Generate My Creative** — one confirmation when AI
arranging costs money (about $0.08 per size, OpenAI), "Arrange automatically (free)" otherwise; the status messages
("Preparing your products…", "Finding the best arrangement…", "Creating your design…") each follow a real request;
(3) the finished poster with **Regenerate Layout** (another automatic layout free, or ask AI again with approval),
**Edit Creative** (the detailed studio on the same draft: drag, corner handles, Size +/−/Reset, replace, add, remove,
text, sizes) and **Save Creative**, then **Decompose & Edit** or **Open in Editor**. The draft saves as it changes and a
reload continues it. Hierarchy: the main product is the person's choice or the one with the most presence, in the
middle, never under 80 % of the tallest; others alternate beside it by size; clearly shorter ones stand in front beside
it (never in front of it); products clear of the character, logos, text and decorations. Regenerate Layout cycles
mirrored sides, then the next main product. The detailed studio and all drafts stay one click away.

Evidence: `test-results/simple-reuse/` (01 start, 02 uploaded, 03 result + 03b 390 px, 04 customise, 05 inspect,
06 editor, 07 export, 08 five products) and `test-results/simple-reuse/real-template/` (a safe copy of the real
"Ganesh ji" template with realistic product cut-outs from the user's own live batch: A two products at original and
4:9, B five products at original and 16:9; arranged automatically, as no AI provider was used).

## What it does

| Area | Behaviour |
| --- | --- |
| Products | Thumbnail list; select / deselect each or all; show / hide; move up / down; **Replace** with an uploaded picture; **Restore** the template's picture; **Remove** from this draft (a "Removed" section restores it); **+ Add Product** (name and kind; any number, no slot needed). "Show the empty stage" hides every product in the preview. |
| Uploads | PNG / JPEG / WebP, cut out on this computer (`cutOutUpload`: own transparency kept, plain backdrop removed, a photo's scene kept and reported). Composited as layers: the product's own pixels are never redrawn. |
| Placement | **Keep the template's places** (its own product set, original size only); **Arrange on this computer** (free fixed rules: compressed real heights per category, tallest in the middle, a lone product as the hero, a front row only for clearly shorter products, on the podium's top surface, below the text, beside the character, clear of badges/logos/text); **AI Smart Placement** (one approved OpenAI request per format with a picture of the composition without products and its geometry; every box checked — canvas, stage, size, text/logo/decoration cover, hiding — and a refused box replaced by the rule's box with the reason; never retried; cost recorded as an estimate). Drag in the preview to correct; Smaller / Larger; undo or reset corrections per format. |
| Formats | Original, Portrait 3:9, Portrait 4:9, Landscape 16:9, with exact pixel sizes (4096 template: 4096², 1365×4096, 1820×4096, 4096×2304). Narrower: a full-height **slice** of the artwork at its own size, decorations wholly in or out (reported). Wider: the artwork scaled to the height with **mirrored side strips** taken only from clean outer artwork (never a badge, logo or text area; flagged as an estimate). Elements re-anchored: header logos to their corners in the white band, partner logos re-flowed in reading order, text re-wrapped in its own area, the character smaller at its side in a slice, extras outside a slice hidden and reported. |
| Text & logos | Per group: text (fitted into the template's area for it), font, weight, colour, size, alignment, show/hide, back to the template's. Logos: show/hide, replace, restore. Offers are only what the person types. |
| Output | **Generate Reused Creative** draws every chosen format as one complete poster with its checks (blocking: products off the canvas or over text, missing pictures, source defects; needs a look: slice/mirror notes, stage note, small text, AI boxes refused). **Save reused creatives** makes each format a creative of the template (new revision when saved again; uploads/background/shadows copied as the creative's own files). Failed formats cannot be saved. |
| Next | Per saved format: **Decompose & Edit** (variationComposition → the existing handoff → review → choose → separate OpenAI + Seedream approval → Inspect → editor) or **Open in editor (its own layers, free)**. |
| Persistence | `prd-<id>.json` per draft (optimistic revisions): items, uploads, text/logo edits, formats, placement mode, AI plans (operation/response ids, items they were made for, rejected boxes), corrections per format, outputs (previews, checks, creative ids/revisions). The master revision is only read. |

## Files

| File | Change |
| --- | --- |
| `shared/src/productTemplates.ts` | `REUSE_ASPECT_RATIOS`, labels, `reuseCanvasFor`, draft/item/output/plan types; creative origin `reuse`; background methods `slice`, `mirror-extend`. |
| `server/src/decomposition/protectedTemplates/product/reuseLayout.ts` (new) | Frames, backgrounds, element mapping and re-anchoring, art rows. |
| `server/src/decomposition/protectedTemplates/product/reusePlacement.ts` (new) | Geometry placement, AI box checks, live OpenAI placement planner, `reuseCategory`. |
| `server/src/decomposition/protectedTemplates/product/reuseStudio.ts` (new) | Drafts, uploads, compose, checks, generate, AI placement, save, open, decompose. |
| `.../product/creatives.ts` | `replaceWith` (a server-made next revision). |
| `.../product/service.ts`, `.../product/routes.ts`, `server/src/decomposition/layerizeRouter.ts` | Studio wiring, `/product-templates/:id/reuse…` routes, `productPlacement` option (live planner only with an OpenAI key). |
| `client/src/features/productTemplates/ReuseStudio.tsx` (new), `api.ts`, `ProductTemplates.tsx`, `ProductTemplatePage.tsx` (exports two helpers), `productTemplates.css`, `client/src/features/masterTemplates/OfferTemplates.tsx` | UI and entry points. |
| `.../product/productServer.fixture.ts`, `tests/fixtures/imageTemplateOfflineServer.ts` | Fake placement planner injection (no network). |
| `.../product/reuseStudio.test.ts` (new), `tests/e2e-image-templates/reuse-studio.spec.ts` (new) | Tests. |

## Verification (offline)

- `npx vitest run …/reuseStudio.test.ts` plus the 11 earlier product test files (`--maxWorkers=2`): 12 files, 35 tests passed. `npm run typecheck` and `npm run build` passed; ESLint `--max-warnings 0` on every changed file passed.
- `FRAMEFLOW_PRODUCT_REFERENCE=1 FRAMEFLOW_PRODUCT_REUSE_PROOF=1 FRAMEFLOW_OFFLINE_E2E_PORT=3387 npx playwright test -c playwright.offline.config.ts tests/e2e-image-templates/reuse-studio.spec.ts tests/e2e-image-templates/product-reuse.spec.ts --project=desktop --workers=1`: 4 passed (the reuse journey and the 3 variation journeys).
- Screenshots: `test-results/reuse-studio/` (01 studio, 02 the four posters, 03 results, 04 reopened, 04b 390 px, 05 inspect, 06 export).
- A copy of the real "Ganesh ji" template (`pt-c533f7a238e7`) was reused read-only in a scratch store: four complete formats, no blocking check.

## Limitations

- The real template's background still has the pastel display risers painted on the podium (not separated when it was prepared). They remain behind re-arranged products (partly covered). Every re-arranged output carries a "check the stage" note. Removing them needs the risers marked as stand layers in Review and a new preparation, or an approved AI background cleanup (not built).
- Formats are recomposed from the template's own artwork: a slice shows the middle of the artwork; a wider format continues its sides by mirroring. A redrawn frame for each format (as a designer would) needs paid AI outpainting (not built; flagged).
- AI placement is verified only with a test double; the live planner (OpenAI, about $0.08 per format, estimate) is unverified.
- Text is re-wrapped by rules; very long copy in 3:9 is set smaller (flagged). AI copy suggestions are not part of the studio.
