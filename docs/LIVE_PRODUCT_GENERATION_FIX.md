# AI product reuse, recovery and background verification — 2026-10-26

## A. Implementation status

Continued the existing implementation on `template-studio-main`; no reset, branch change, commit or push. Existing uncommitted work was preserved. The generation/decomposition/editor path and most reliability changes were already present. This continuation finished source-quality preflight, bounded one-image smoke testing, legacy status correction, failure-in-variation-two coverage, background provenance diagnostics and verification.

**Offline implementation is verified; the actual LG master remains blocked.** Adding OpenAI credit alone does not make it usable. The saved Water purifier residual must be repaired and inspected in a new revision. An offline reconstruction was attempted on temporary copies and rejected. No live OpenAI/fal request or paid retry was initiated by this work. During the original investigation, the user's already-running job was allowed to finish before source changes were applied.

## B. Separate root causes and evidence

Saved template: `pt-6119001cdc81`, in `artifacts/decomposition/protected-templates/pt-6119001cdc81/`.

| Job | UTC interval | Recorded attempts / successful saved images | Finding |
| --- | --- | --- | --- |
| `pv-d1077345` | 04:39:24.917–04:43:47.858 | 10 / 7 | Two reported transport failures (`Connection error.`, `terminated`), then an abandoned executor. Three submissions have no completed response record. Original socket causes, HTTP status and failed-request IDs were not saved. |
| `pv-c3601515` | 04:44:55.400–04:53:21.770 | 19 / 17 | First variation composed; later requests explicitly returned HTTP 429, “You have no credits remaining.” Two rejected submissions. First variation inherits the source quality failure and is not usable. |

IST is UTC + 05:30. The older job stopped updating at 10:13:47.858 IST; the observed replacement backend process started at 10:13:53 IST. The stored job said running but its executor was absent. This establishes interrupted execution, not who restarted it or why. GET now reports an interrupted job without rewriting its evidence. Legacy `done` batches containing failed variations are also reported as failed, without a storage migration.

The actual workload was 12 slots × 3 variations = 36 image requests, sequential within each job, using `gpt-image-2`, `1024x1024`, `n=1`, medium PNG, base64 response bodies. There was no separate provider image download. SDK retries were already disabled and the timeout was already 240 seconds. The recorded transport failures occurred substantially earlier than that timeout; there is no evidence that increasing it would fix them. Exact network/proxy/provider causes cannot be reconstructed from the old generic messages. Credit exhaustion is confirmed for the newer job only. The model successfully returned 24 images across the two jobs.

Planner response IDs: `resp_01a4ce58b64e1d46016aded97e55e087d184445fbb81af234d` (older) and `resp_01a2a91946880677016adedac8efa087d1a27f511c5213455a` (newer). The older planner counter was zero because accounting was formerly written at batch completion. Planner attempts and validated plans are now persisted before image work.

### Background defect

Both published revisions reference `pbase-9cfba16c206b.png`, SHA-256 `9cfba16c206b9bd74b64b53d9f3146a69d6fd2c3bb48bdc4595d754fd34db263`. Revision 2's `editorCreative.backgroundSource` also references that same file at `(0,0)`, 4096×4096. Preserved-layout generation retains it. `pclean-1a9922a1306e.png` is the overlay-free composition and intentionally still contains products; it is not a replacement background.

Original preparation: 2026-10-23 16:54:24.905 UTC, OpenAI planner plus `bytedance/seedream/v5/pro/layerize`, request `01a169ad-5630-7473-ad36-3ee55f06c841`, input 1535×1535, 14 returned layers. The algorithm reconstructs the base locally, then uses the returned AI background under matched object masks, with local colour matching. It reported 12.72% AI background coverage. Stands are separate layers and are included in the hide/move quality check.

The purifier (`po-a518d9ddaa`) has reviewed bounds `(1122,2316,179,236)` and an approximately 90%-coverage Seedream mask; it was matched, not missing. Its saved cutout placement `(1117,2326,183,225)` is consistent with those bounds. Nevertheless, most of the purifier is visibly present in the base itself, even before adding the stand. This is not merely a transparent product layer showing through. The original quality check caught 49% unchanged distinctive pixels and the master was saved as a draft with that blocking issue. The generation path previously spent money before inheriting/rejecting this issue; preflight now prevents that spend.

The old preparation did not retain the raw background PNG locally. Its response contains remote layer URLs; no remote assets were fetched during this investigation. Consequently, the exact division between a defective AI background and subsequent local reconstruction cannot be proven from retained files. Future preparations retain the raw provider background, its hash and mapping, final base/clean hashes, background-source flags, and per-object residual/edge measurements.

The residual gate checks **every selected decomposed object**, including the stands and underlying layers visible when it is hidden. It is a pixel heuristic, not a guarantee of visual perfection: altered ghosts, omitted parts outside a mask and awkward geometry still require inspection. A supplemental read-only comparison of all 12 saved product cutouts found 48.16% unchanged pixels for the purifier; the other slots were below 1%. This supplemental measure includes flat scene pixels and is not identical to the original 49% distinct-pixel metric. Tiny satellite-speaker masks (25% coverage), subwoofer (16%) and the locally cut soundbar remain inspection warnings; low residual scores do not certify them.

## C. File inventory

Paths below are relative to the repository. These are the files changed by this reliability/background work, not the much larger pre-existing dirty tree.

| File | Change |
| --- | --- |
| `server/src/decomposition/protectedTemplates/product/imageOperation.ts` | Typed sanitized failures, unknown billing outcomes, per-image ledger, serial execution and bounded abortable wait. |
| `server/src/decomposition/protectedTemplates/product/artwork.ts` | One SDK request with zero retries, client operation ID, response request ID before body parsing, safe elapsed/status/cause diagnostics. |
| `server/src/decomposition/protectedTemplates/product/generationRecovery.ts` | Conservative read-only legacy plan/image matching, ambiguous-output block, separate usage/estimated/uncertain accounting. |
| `server/src/decomposition/protectedTemplates/product/variations.ts` | Persist plan and each paid attempt/raw image/cutout; stop on failure; preserve completed results; detect orphaned/legacy-failed jobs; explicit one-image recovery; source-quality gates; optional one-image smoke budget. |
| `server/src/decomposition/protectedTemplates/product/routes.ts` | Explicit resume endpoint. |
| `server/src/decomposition/protectedTemplates/product/prepare.ts` | Retain provider background; record background provenance and measurements for every residual check. Quality thresholds unchanged. |
| `client/src/features/productTemplates/api.ts` | Progress, recovery, source-quality and smoke-test request/response types. |
| `client/src/features/productTemplates/ProductTemplatePage.tsx` | Progress/assets, concrete diagnostics, honest accounting, source blocker, separate recovery approval and optional smoke-test checkbox. Default remains three variations. |
| `server/src/decomposition/protectedTemplates/product/imageOperation.test.ts` | Connection reset, truncated HTTP-200 response, 429, timeout/abort and serial request tests. |
| `server/src/decomposition/protectedTemplates/product/generationRecovery.test.ts` | Durable partial results, no implicit spending, explicit bounded recovery, orphan/legacy statuses, unique legacy mapping, source gates, probe limit, preservation of variation one after variation two fails. |
| `server/src/decomposition/protectedTemplates/product/backgroundQuality.test.ts` | Residual provider backgrounds block every selected product; clean native background provenance remains distinct from AI object masks. |
| `server/src/decomposition/protectedTemplates/product/reuse.test.ts` | Updated failure expectations for explicit unknown outcome. |
| `tests/fixtures/productReuseProviders.ts` | Deterministic interrupted-image fake transport. |
| `tests/fixtures/imageTemplateOfflineServer.ts` | Test-only failure injection endpoint. |
| `tests/e2e-image-templates/product-reuse.spec.ts` | Full workflow plus failed-generation/approved-one-image recovery journey. |
| `docs/LIVE_PRODUCT_GENERATION_FIX.md`, `docs/PRODUCT_FEATURE_PROGRESS.md` | Findings, exact verification, remaining blocker and manual instructions. |

## D. Offline verification

Final verification: **11 Vitest files / 28 tests passed** (91.43 s); **2 Playwright journeys passed** (36.5 s); **typecheck passed**, **targeted ESLint passed with zero warnings**, **production build passed**, and **git diff --check passed**. Vite retained its existing large-chunk warning. All provider interactions in tests are injected fakes; HTTP listeners use isolated temporary stores. The LG reference is read as an input; existing user records are not test stores. SHA-256 comparison of all **226 existing files** in the saved LG template directory confirmed no changed, missing or new files after verification.

```sh
npx vitest run server/src/decomposition/protectedTemplates/product/backgroundQuality.test.ts server/src/decomposition/protectedTemplates/product/imageOperation.test.ts server/src/decomposition/protectedTemplates/product/generationRecovery.test.ts server/src/decomposition/protectedTemplates/product/reuse.test.ts server/src/decomposition/protectedTemplates/product/variations.test.ts server/src/decomposition/protectedTemplates/product/generation.test.ts server/src/decomposition/protectedTemplates/product/variationTemplate.test.ts server/src/decomposition/protectedTemplates/product/prepare.test.ts server/src/decomposition/protectedTemplates/product/prepareGate.test.ts server/src/decomposition/protectedTemplates/product/creatives.test.ts server/src/services/openAIRequestDiagnostics.test.ts --maxWorkers=2 --reporter=verbose

FRAMEFLOW_PRODUCT_REFERENCE=1 FRAMEFLOW_PRODUCT_REUSE_PROOF=1 FRAMEFLOW_OFFLINE_E2E_PORT=3387 npx playwright test -c playwright.offline.config.ts tests/e2e-image-templates/product-reuse.spec.ts --project=desktop --workers=1

npm run typecheck
npm run build

npx eslint server/src/decomposition/protectedTemplates/product/imageOperation.ts server/src/decomposition/protectedTemplates/product/imageOperation.test.ts server/src/decomposition/protectedTemplates/product/generationRecovery.ts server/src/decomposition/protectedTemplates/product/generationRecovery.test.ts server/src/decomposition/protectedTemplates/product/artwork.ts server/src/decomposition/protectedTemplates/product/variations.ts server/src/decomposition/protectedTemplates/product/routes.ts server/src/decomposition/protectedTemplates/product/reuse.test.ts server/src/decomposition/protectedTemplates/product/prepare.ts server/src/decomposition/protectedTemplates/product/backgroundQuality.test.ts client/src/features/productTemplates/api.ts client/src/features/productTemplates/ProductTemplatePage.tsx tests/fixtures/productReuseProviders.ts tests/fixtures/imageTemplateOfflineServer.ts tests/e2e-image-templates/product-reuse.spec.ts --max-warnings 0

git diff --check
```

The browser fixture uses the real LG artwork with a handmade reviewed manifest (eight product slots / 24 fake images), not the defective saved 12-slot revision. The browser journey verifies three different product-family mixes/previews, exact Ganesh asset, canvas/background preservation, separate text/logos, generation approval, selecting one variation, denying local/unapproved paid handoffs, approved planner → actual Seedream adapter with fake transport, overlay-free provider input, independent move/resize/hide and text edits, save/reopen/export. The recovery journey verifies no new submission from viewing recovery, an explicit one-image approval, retention of previous assets and a visible pause when that budget is exhausted. Restart handling is simulated by persisted orphaned executor state in integration tests; it does not restart the user's server.

Synthetic fixture products and mock segmentation do not establish realism, perspective, shadows or semantic correctness of future live AI output. The real saved LG revision is not claimed to pass the full workflow.

## E. Background-quality outcome

**Blocked: no safe repair promoted.** Temporary offline preparation of the actual source made zero provider requests. It removed the purifier body but replaced its region with radial artwork while leaving a strong outline and discontinuous stand geometry. The outline metric was 64%; microwave, TV and dishwasher outlines also raised warnings. One satellite-speaker extraction was empty and blocking. The candidate therefore was not saved as a new master or substituted into either job.

Evidence (local, generated for inspection):

- [Source / overlay-free / saved base / base plus stand](../test-results/live-generation-fix/saved-purifier.png).
- [Source / defective saved base / rejected offline reconstruction](../test-results/live-generation-fix/repair-comparison.png).
- [Saved full background](../test-results/live-generation-fix/saved-background.png).
- [Rejected local background](../test-results/live-generation-fix/rejected-local-background.png).
- [All-slot supplemental audit](../test-results/live-generation-fix/background-audit.json) and [rejected candidate quality](../test-results/live-generation-fix/rejected-local-quality.json).

A clean supplied background or a separately approved reconstruction/re-preparation is required. A fresh paid attempt is not guaranteed to repair it: inspect every product hidden/moved and retain the gate. Do not unselect a replaceable product just to silence the check. Existing master revisions, Ganesh asset, logos and generated images remain untouched.

## F. Cost and recovery safety

The 24 saved cutouts are preserved. Seven older images and seventeen newer images have unique legacy matches based on exact known prompts, serial request/response timing and filename hashes. Legacy reuse requires explicit review. Ambiguous successful responses block resubmission; missing responses are unknown, not proof of no charge.

Future jobs checkpoint the validated plan before generation, each attempt before submission, raw image before local validation, and cutout before continuing. Recovery reuses those files and the saved plan, skips completed slots, and permits at most one explicitly approved new image attempt. The application stops subsequent submissions after a transport or credit failure. Reload, polling, inspection and opening recovery do not submit anything. A timeout aborts the local wait but never establishes that the provider did not bill.

Product image estimates from recorded usage: older $0.373455; newer $0.906905. Old mixed counters were $0.553455 and $1.026905, respectively, because they included $0.18 unknown-attempt reserves and $0.12 rejected-attempt reserves. These are not invoices. Planner costs are separate; the interrupted planner's original counter was incomplete. Only provider billing can resolve actual charges, especially the three unknown submissions.

**Current legacy jobs cannot be resumed against their defective immutable source revisions.** A repaired new revision does not silently rebase old jobs or move old images into new slots. Existing PNGs remain available for inspection/download and deliberate reuse through the editor's Replace image path. Automatic cross-revision recovery is not implemented; the current same-revision recovery path is verified on clean sources.

## G. Workflow status

| Step | Implementation status | Actual saved LG revision |
| --- | --- | --- |
| Prepare and review master | Implemented and Verified offline | **Blocked:** purifier/background and small-object inspection issues |
| Generate three preserved-layout AI mixes | Implemented and Verified offline; live quality unverified | **Blocked** until a clean new revision and sufficient credit |
| Review/select one usable variation | Implemented and Verified offline | **Blocked:** completed old variation inherits source failure |
| Separate paid approval → planner → Seedream | Implemented and Verified with mock transports; Live-Unverified | **Blocked** until clean selected composition |
| Canva editor → edit/save/reopen/export | Implemented and Verified offline | Depends on passing the preceding steps |

No declaration of complete live end-to-end readiness is made.

## H. Exact manual testing after repair/credit

1. Ensure no generation is running before starting/restarting the application. Use `npm run dev` if the app is stopped. Do not use the offline fixture server for a live test.
2. Open the existing LG master → **Inspect layers** → **Background only** and hide/move the purifier. Review the evidence above. Open **Fix it in the review** / **Change what is decomposed**, correct the purifier/stand and small speaker bounds, retain the reviewed Ganesh and logos, and save the selection. This creates current review changes; earlier published revisions stay immutable. Do not run new detection just to repeat the already saved analysis.
3. If choosing paid repair, use **Decompose with AI…** on the selection step and inspect its separate confirmation. With 13 selected objects and the current repository estimates, approximately 14 layers cost **$0.55 expected / $0.65 approval budget** (planner included). The actual UI estimate for the current selection takes precedence; these are configured estimates, not a guaranteed invoice cap. No repair has been approved or executed by this work. Existing cutout-service-only/SAM-3 preparation does not reconstruct a clean background.
4. Inspect the result with each replaceable product hidden, moved and resized. Check the purifier, stand, both satellite speakers, subwoofer, soundbar, Ganesh and logo/text exclusion. Only save a **new clean master revision** when blocking checks are resolved and the background is visually acceptable. Keep the original character asset for preserved-layout generation. If repair remains defective, stop here; do not spend on generation.
5. On the clean revision choose **Generate with AI**, preserved-layout mode, **3 variations**. Leave **Test one product image first** unchecked for the full workflow. For 12 slots the UI should show **36 images, estimated $2.16**, plus the separately displayed planner estimate if **Plan with AI** is enabled. Review and explicitly approve. Credit must cover the intended batch; do not assume the estimate is an invoice cap.
6. Review all three mixes at full size. Confirm original Ganesh, logos, festival structure, dimensions and separate text; check proportions, contact/shadows, perspective, invented lettering, ghost products and duplicate images. Failures preserve completed output; recovery requires a new explicit approval and warns about uncertain earlier charges.
7. Select one passing variation → **Decompose & Edit** → review/select layers → **Decompose with AI…** → inspect the separate planner/Seedream estimate → **Yes, decompose with AI**. Generation approval does not authorize this second operation. Only the approved composition without independent text/logo overlays goes to Seedream.
8. Inspect layers → open the editor → edit text; move, resize and hide a product, Ganesh and a logo independently → save → reopen → export PNG. Verify the background under moved/hidden products and the reopened positions/text before using the export.

Optional separate smoke test: on a **clean** revision, disable **Plan with AI**, choose one variation and check **Test one product image first**. The preview should show **1 image / estimated $0.06**. Approve once. Expect one saved product and an explicit partial-job pause, not a complete 12-product creative. No second image is submitted until separately approved recovery. A single variation without this checkbox still means 12 images on this master.
