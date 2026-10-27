# Template reuse implementation and offline verification — 2026-10-25

This continues the existing uncommitted work on `template-studio-main`. No live OpenAI or fal.ai requests were made, no credits were spent, and no credentials or saved user templates/runs/uploads were changed. Test data was stored in temporary directories. No commit, push, reset, stash, branch switch or worktree switch was performed.

## A. Implemented functionality

Generate with AI defaults to **Preserve structure · new AI products**, with three variations. It generates a fresh image for every product slot in every variation and fits each cutout inside that slot. Original character assets, background, decorations, logos, canvas and composition anchors remain unchanged. Headline and offer fields retain editable text; offer/legal invention is rejected by the existing planner validation. Typography-only is a separate explicit mode. Redesign remains explicit.

The UI names the image provider, number of requests and estimated cost. An unavailable image provider or text checker disables product generation and explains the dependency; it does not silently make typography-only outputs. Generation and regeneration require cost approval. Failed/duplicate images are reported and are not retried automatically. Attempts retain cost estimates even when the provider fails.

## B. Product-generation behavior

The existing OpenAI `liveArtworkGenerator` creates packshots through `images.generate`, using the repository's `OPENAI_IMAGE_MODEL` setting (code default `gpt-image-2`), with SDK retries disabled. No provider configuration was changed or tested live.

Reviewed product labels are classified conservatively into home appliances, electronics, vehicles, fashion or furniture. A deterministic mix planner ranks alternatives by typical silhouette ratio and advances through alternatives for each variation, avoiding repeated categories where possible. The image prompt specifies the chosen category, source families, finish and style, and excludes text/logos/scenery/characters. OCR checks generated images; background removal must succeed. Unknown categories retain their own identity instead of becoming interchangeable with unrelated products.

This is rule-based family/mix selection followed by AI image generation, not a claim that a vision model independently verifies the generated product's category. Original Ganesh Ji and scene artwork are composited from their saved assets; they are never requested from the product generator.

## C. Three-variation quality

The LG test created 24 independently requested product images across three eight-slot variations. Example mixes included:

1. Induction cooktop, washing machine, dishwasher, computer, phone, air fryer, mixer grinder, water purifier.
2. Microwave oven, washing machine, air fryer, subwoofer, computer, mixer grinder, water purifier, dishwasher.
3. Washing machine, dishwasher, mixer grinder, speaker, computer, water purifier, refrigerator, air fryer.

Tests assert three different category sets and preview hashes, generated asset ownership, fixed asset preservation, slot containment and unchanged source revision bytes. Exact repeated generated PNGs are rejected rather than relabelled. All AI concepts carry a visual-review notice. Near-duplicate appearance, catalogue accuracy and semantic correctness still require human review.

## D. Selected variation → paid decomposition

`POST /api/layerize-experiment/product-templates/:id/variations/:job/results/:index/decomposition` creates/reuses a child template from the exact selected composition and returns its `templateId`. This handoff itself is free.

The child follows Review → selection → estimate → explicit approval → `POST /:templateId/prepare` with `engine: "ai"` and `approveUsd`. The server rejects the local/SAM route with `AI_REQUIRED`, missing approval with `APPROVAL_REQUIRED`, and unavailable providers with a visible error. Completed preparation is reused without a second charge.

The production route calls the OpenAI decomposition planner, then `createProductLayerizer` / `seedreamLayerize` at **`bytedance/seedream/v5/pro/layerize`**. Native cutouts do not bypass segmentation. Missing AI matches produce blocking quality warnings; local masks retained for inspection are explicitly identified. They are not reported as successful Seedream matches.

Text/logo overlays are excluded when the composition is rendered; the clean artifact is hash-checked before use. The generic uploaded-image overlay gate remains active. The browser test compares the actual decomposition input pixels with the saved clean composition and asserts separate editable text and logo layers.

The original native background is used as reference beneath matching saved objects, including after names are normalized/renamed; it is explicitly labelled as reference, not newly generated Seedream output. Selected object masks still come through the AI adapter. Other reconstruction areas remain estimates with visible quality warnings.

The run dashboard distinguishes **Editor conversion AI cost** from prior template preparation costs, provider operations and Seedream request ID. Opening the editor does not charge preparation again.

## E. Executed checks

Final focused suite: **7 files, 15 tests passed**, 0 failures (75.76 s).

```sh
npx vitest run server/src/decomposition/protectedTemplates/product/reuse.test.ts server/src/decomposition/protectedTemplates/product/variations.test.ts server/src/decomposition/protectedTemplates/product/generation.test.ts server/src/decomposition/protectedTemplates/product/variationTemplate.test.ts server/src/decomposition/protectedTemplates/product/prepare.test.ts server/src/decomposition/protectedTemplates/product/prepareGate.test.ts server/src/decomposition/protectedTemplates/product/creatives.test.ts --maxWorkers=2 --reporter=verbose
```

Final strengthened browser journey: **1 passed**, 0 failed, 0 skipped (23.1 s including fixture startup; test 20.7 s).

```sh
FRAMEFLOW_PRODUCT_REFERENCE=1 FRAMEFLOW_PRODUCT_REUSE_PROOF=1 FRAMEFLOW_OFFLINE_E2E_PORT=3387 npx playwright test -c playwright.offline.config.ts tests/e2e-image-templates/product-reuse.spec.ts --project=desktop --workers=1
```

It uses the real LG image and handmade detection manifest, synthetic packshots, a fake planner and fake fal transport. The real Seedream adapter performs upload/submit/status/result/download normalization against that fake transport. The test asserts exactly one Seedream endpoint submission, all selected product/character masks matched, explicit approval gates, preserved background pixels, separate text/logos, independent move/resize/hide, text editing, creative save/reopen and PNG export. Test-provider cost values are simulated; no actual money was spent.

Static checks and build pass:

```sh
npm run typecheck
npm run build
npx eslint server/src/decomposition/protectedTemplates/product/{reuse,reuse.test,variations,variations.test,generation.test,variationTemplate.test,service,prepare,variationTemplate,creativeRun,routes}.ts client/src/features/productTemplates/{ProductTemplatePage,ProductSelect,ProductTemplates}.tsx client/src/features/productTemplates/api.ts client/src/features/decomposition/RunDashboard.tsx shared/src/productTemplates.ts tests/e2e-image-templates/product-reuse.spec.ts tests/fixtures/{productReuseProviders,imageTemplateOfflineServer}.ts --max-warnings 0
git diff --check
```

Build has the existing Vite large-chunk warning. The whole repository test/browser suite was not run. One intermediate browser failure was a missing expected-revision precondition in the test's direct API request; it was corrected and the full journey rerun successfully. Type errors encountered during editing were fixed before the passing checks.

Evidence: `test-results/product-reuse/evidence.json`, generation/decomposition cost screenshots, three-variation screenshot, Inspect screenshot, exported PNG and reopened-editor screenshot. These are synthetic-provider integration evidence, not examples of live model quality.

## F. Files changed for this work

Paths below distinguish this work from the many pre-existing uncommitted changes.

| File | Change |
| --- | --- |
| `server/src/decomposition/protectedTemplates/product/reuse.ts` | Category/family taxonomy, slot-aware mix planning, packshot prompts. |
| `server/src/decomposition/protectedTemplates/product/variations.ts` | Preserve mode, generated products, approval/accounting, duplicate/quality gates, paid handoff and mutation guard during generation. |
| `server/src/decomposition/protectedTemplates/product/routes.ts` | AI decomposition handoff; explicit existing-layer endpoint; regeneration approval. |
| `server/src/decomposition/protectedTemplates/product/variationTemplate.ts` | Exact composition handoff, complete background and overlay-free rendering. |
| `server/src/decomposition/protectedTemplates/product/service.ts` | AI engine enforcement, cost approval, clean-image hash verification and preparation references. |
| `server/src/decomposition/protectedTemplates/product/prepare.ts` | Actual AI mask requests despite native references, missing-match checks, overlay gate proof, original background reference. |
| `server/src/decomposition/protectedTemplates/product/creativeRun.ts` | Upstream preparation provenance; conversion version 6 to avoid stale cached provenance. |
| `shared/src/productTemplates.ts` | Reuse mode and variation preparation/clean-hash metadata. |
| `server/src/decomposition/layerizeExperiment.ts` | Preparation provenance type. |
| `client/src/features/decomposition/layerizeExperiment.ts` | Corresponding client provenance type. |
| `client/src/features/productTemplates/ProductTemplatePage.tsx` | Default AI products, separate typography/redesign modes, provider availability/cost UI and correct handoff. |
| `client/src/features/productTemplates/ProductSelect.tsx` | Explicit approval, no local fallback for selected variations, refreshed-estimate/revision handling. |
| `client/src/features/productTemplates/ProductTemplates.tsx` | Handoff navigation and cost wording. |
| `client/src/features/productTemplates/api.ts` | Updated request/response contracts. |
| `client/src/features/decomposition/RunDashboard.tsx` | Conversion versus upstream preparation costs. |
| `server/src/decomposition/protectedTemplates/product/reuse.test.ts` | Family/asset preservation, generated mixes, approval, duplicate/failure accounting. |
| `server/src/decomposition/protectedTemplates/product/{variations,generation,variationTemplate}.test.ts` | Explicit redesign/native-layer contracts and AI handoff regression coverage. |
| `tests/fixtures/productReuseProviders.ts` | Synthetic images and fake transport exercising real Seedream adapter. |
| `tests/fixtures/imageTemplateOfflineServer.ts` | Opt-in isolated reuse-proof providers and evidence endpoints. |
| `tests/e2e-image-templates/product-reuse.spec.ts` | Real-LG full browser journey with no live calls. |
| `docs/PRODUCT_FEATURE_PROGRESS.md`, `docs/TEMPLATE_REUSE_VERIFICATION.md` | Current implementation, commands, evidence and limits. |

## G. Remaining limitations

- Live product-image quality and real OpenAI/fal availability, latency, billing and segmentation quality are unverified. No live paid operation was authorized or attempted.
- Product categories depend on reviewed source labels and the conservative taxonomy. Unknown categories need review; generated products are concepts, not verified brand/SKU catalogue assets.
- Exact duplicate images are blocked; near duplicates and semantic category errors still need visual review. A provider failure can leave fewer than three usable outputs, visibly marked failed, without a paid retry.
- Existing master background/cutout defects are inherited; preserving the original assets does not repair them. Mask edges, overlaps and newly hidden areas can still need manual work. The synthetic transport cannot measure live segmentation quality.
- Estimates are estimates, not a guarantee of final provider billing. Editor conversion remains free even when upstream preparation was paid.

## H. Manual local test

1. Run `npm run dev`. Open **OpenAI + Seedream test → Offer Templates**, then the saved LG Master Template and the intended revision. Use its existing saved assets; no re-upload is required.
2. Open **Generate with AI**. Keep **Preserve structure · new AI products**, count **3**. Verify the displayed provider and product families. Enter only approved headline/offer copy, or leave them empty.
3. Click **Generate 3 variations**. The first approval shows image count and estimated generation cost. Clicking **Yes, spend … and generate** in a configured live app makes paid calls; only proceed when you choose to authorize that spend.
4. Compare the three results: original Ganesh Ji, scene, logos and layout; changed product mixes. Inspect warnings and choose one result.
5. Click **Decompose & Edit**. Review its elements, save the review, and choose the objects to separate. Local preparation is disabled for this handoff.
6. Click **Decompose with AI…**. Review the OpenAI + fal expected/max estimate. **Yes, decompose with AI** is the separate paid decomposition approval. It submits only the selected variation.
7. Inspect layers and background warnings. Open in Editor, move/resize/hide a product, edit a word, then **Save creative**. Reload and reopen from Saved Runs; verify edits and export PNG.
8. On the run dashboard, compare free editor conversion with the separately recorded upstream preparation cost and request ID.

## I. Verdict

Category-aware product generation and three-variation reuse are implemented for the supported families, with conservative unknown-category handling and explicit failure states. Fixed original assets are preserved. Selected-variation decomposition enforces the AI route and opens the result in the existing editor. The full offline integration is verified. Live provider quality, actual billing and real segmentation remain unverified and need a separately authorized paid test.
