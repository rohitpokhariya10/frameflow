# One approved generation batch, honest pauses and safe continuation — 2026-10-26 (afternoon)

Offline only: no OpenAI or fal request, no commit, no push. Saved templates and generated images were not modified
(SHA-256 of all 152 files of `pt-c533f7a238e7` and all 226 files of `pt-6119001cdc81` unchanged after the work).

## A. Root causes (with evidence)

The user's job `pv-ec8c6243` (template `pt-c533f7a238e7` "Ganesh ji", revision 1, prepared 2026-10-26 08:52 UTC with
Seedream, Water purifier residual 0.03 %, no blocking issue) had `request.maxNewImages: 1`, 3 saved images
(induction cooktop, air conditioner, dishwasher; usage-derived estimate $0.160055) and stored
`status: failed`, results `failed / Not started after an earlier image failure ×2`.

1. **The smoke-test box was the whole cause of the pause.** `maxNewImages: 1` gave `run()` a budget of one image
   (`{ remaining: 1 }`); the next slot threw `Paused after the approved image attempt limit` as an ordinary error.
2. **Continuing was one image per approval.** `resume()` accepted only `maxNewImages` 0 or 1 per variation
   (`Recover with at most one new image attempt at a time`), so 33 more approvals were needed. Unticking the box
   later changed nothing: it is client state used only when a new batch starts.
3. **A pause was recorded as a failure.** The thrown pause made variation 1 `failed`; the loop then wrote
   `Not started after an earlier image failure` into every later variation, and the job `failed`.
4. **"Generating…"** was bound to `job.status === 'running'`; each one-image recovery set the job running, so the main
   button and "Making 3 variations…" showed for a single-image attempt (and while it waited in the process-wide
   queue or ran local checks). No evidence of a spinner while the server was idle was found.
5. Normal mode (box unticked) already ran every image without per-image prompts, strictly one request at a time
   (process-wide `serialImage`), and stopped the whole job at the first failure of any kind.
6. Additional defects found and fixed: a rejected image's reason was replaced by a generic message; a batch stopped
   mid-variation stored no result, so its Decompose endpoint answered 404 instead of 422; old jobs stored as
   `done` with failed variations were not recognised as credit exhaustion; resume persisted computed fields
   (`recovery`, `running`, `accounting`) into the job file; a variation save could overwrite the job file with a stale copy.
7. Source preflight: `pt-c533f7a238e7` passes (paid generation correctly allowed). `pt-6119001cdc81` (both revisions,
   Water purifier 49 % residual) remains blocked for start, continuation and regeneration.

## B. Changes

| File | Change |
| --- | --- |
| `server/src/decomposition/protectedTemplates/product/imageOperation.ts` | `limitedImage` (process-wide cap, `FRAMEFLOW_PRODUCT_IMAGE_CONCURRENCY` 1–4, default 2; permits handed over so the cap is never exceeded) replaces `serialImage`; `failureKind` (insufficient credits / provider failure / connection interrupted / image rejected); `authorizationId` on each attempt. |
| `server/src/decomposition/protectedTemplates/product/variations.ts` | `GenerationState` + coarse `status` (`running / paused / done / failed`); `ImageAuthorization` (images, maxUsd, retry) recorded per approval; `productImage()` (reuse saved → re-check kept raw bytes free → one attempt gated right before sending by stop, Stop request, image count and spend); `batch()` (worker pool, variation by variation, each variation composed as soon as its images exist, stores a pending result for every unfinished variation); `start()` one authorization for the whole batch or a 1-image smoke test, `approveImages` must match, `UNFINISHED_JOB` unless `startNew`; `resume()` one approval for all never-attempted images, failed/uncertain ones only with `retry: true`; `cancel()` (Stop); `get()` computes state, message, per-slot progress, continuation (images, estimate, retry images, reason) and pending/failed notes without writing; `sourceIssuesOf()` (blocking quality issues, missing product cut-outs or background) used by options, start, continuation, batch and regenerate; legacy jobs read correctly. |
| `server/src/decomposition/protectedTemplates/product/routes.ts` | `POST /:id/variations/:jid/cancel`. |
| `client/src/features/productTemplates/api.ts` | `GenerationState`, progress/continuation/authorization types, `pending` result status, `resumeVariations` (approveImages, approveProductsUsd, retry), `cancelVariations`. |
| `client/src/features/productTemplates/ProductTemplatePage.tsx` | `GenerationStatus` panel (title by state, progress bar "N of M images completed", server message, Stop, one Continue approval with optional retry tick-box, repair action for blocked sources, approvals and cost estimates); smoke-test wording; one-approval confirmation text; warning before a new batch when an unfinished one has saved images; cards of unfinished variations show their saved product images and why they wait; per-card one-image recovery removed. |
| `client/src/features/productTemplates/productTemplates.css` | Status panel, progress bar, pending card and thumbnails. |
| `server/src/decomposition/protectedTemplates/product/generationRecovery.test.ts` | Rewritten for the new behaviour (5 integration tests + the unchanged legacy mapping test). |
| `server/src/decomposition/protectedTemplates/product/imageOperation.test.ts`, `reuse.test.ts` | Concurrency cap and failure classification; updated expectations (requests in flight at a failure, repeated image stops). |
| `tests/e2e-image-templates/product-reuse.spec.ts` | Journey 1 asserts one approval / no pause; journey 2 rewritten (interruption → one continuation with ticked retry); journey 3 new (smoke test → honest pause → one continuation → separately approved Seedream → editor). |

## C. Expected experience

**Normal (default):** Generate 3 variations → confirmation "Spend about $2.16 on 36 category-matched product images? …
One approval for the whole batch: all 36 images are generated automatically (at most 36 requests, about $2.16 estimated),
each saved as soon as it arrives, and each variation shown as soon as its images are ready." → status panel with
"7 of 36 images completed · 2 in progress" → "All variations are ready". No further prompt.

**Smoke test (optional box "Smoke test: make one product image first"):** button "Run the smoke test (1 image)",
$0.06 → "Smoke test finished · Paused" "Smoke test completed. 1 product image saved. Approve the remaining generation
batch (35 images) to continue." Cards say "Not finished", never failed; the saved image is shown. One
"Continue: 35 images, about $2.10" approval finishes everything, reusing the test image.

**Failures:** credit exhaustion → "OpenAI API credits exhausted. Completed images are preserved (…). No further requests
were submitted."; transport → "The connection to the image provider was interrupted. … Provider completion and billing
are unknown …"; provider error → "The image provider refused or failed a request. …"; server restart → "Interrupted:
the server stopped"; Stop → "Stopped by you"; source → "The master template needs repair". A single image rejected by the
local checks (text found, not isolated) blocks only its slot; a repeated image or 3 rejections stop the batch.

## D. Existing jobs (read through the new code from copies; nothing changed)

| Job | Template / revision | Now reads as | Continuation |
| --- | --- | --- | --- |
| `pv-ec8c6243` | `pt-c533f7a238e7` r1 | Paused · smoke test, 3 of 36 saved | **Available:** 33 images, $1.98 estimated, 3 images reused |
| `pv-c3601515` | `pt-6119001cdc81` r2 | OpenAI API credits exhausted, 17 of 36 saved | Blocked: Water purifier 49 % residual |
| `pv-d1077345` | `pt-6119001cdc81` r1 | Interrupted, 7 of 36 saved, 3 unknown | Blocked: same residual |
| `pv-b5493fb4` | `pt-6119001cdc81` r1 | Done (older non-product job) | — |

## E. Cost safety

Every paid image attempt is counted against a recorded approval. Right before sending (after waiting for a permit) the
server refuses when: a blocking failure or Stop happened; the approval's image count is used up; or measured spend
(never below the $0.06 estimate) plus this request at the highest cost measured in the job would exceed the approved
amount. A continuation must name the exact image count it approves. Never-attempted slots are the only default work;
failed or unknown-outcome slots need the explicit retry tick. Viewing, polling and reloading send nothing. At most
`concurrency` (2) requests are in flight when a failure arrives. All costs remain estimates, not invoices.

## F. Tests (exact)

- `npx vitest run` on 11 files (generationRecovery, imageOperation, reuse, variations, generation, variationTemplate,
  backgroundQuality, creatives, prepare, prepareGate, openAIRequestDiagnostics) `--maxWorkers=2`: **11 files, 31 tests passed** (105.5 s).
  Baseline before changes (8 of those files): 20 passed.
- `FRAMEFLOW_PRODUCT_REFERENCE=1 FRAMEFLOW_PRODUCT_REUSE_PROOF=1 FRAMEFLOW_OFFLINE_E2E_PORT=3387 npx playwright test -c playwright.offline.config.ts tests/e2e-image-templates/product-reuse.spec.ts --project=desktop --workers=1`: **3 passed**.
- `npm run typecheck`: passed. `npm run build`: passed (existing chunk-size warning).
- ESLint on every changed file `--max-warnings 0`: passed. `npm run lint` (whole repo): 1 warning in
  `client/src/features/masterTemplates/CreativeCanvas.tsx` (not touched by this work).
  Journey 3 also checks the paused status panel at 390 px (no sideways scroll).
- Stale specs, failing identically on the pre-change code in an isolated copy (port 3397), so not caused by this work:
  `product-templates.spec.ts:114` and `product-full-workflow.spec.ts` (plain), `product-variations.spec.ts` and
  `product-generation.spec.ts` (REFERENCE=1), `product-final-journey.spec.ts` (REFERENCE=1 RECORDED=1). They assume the
  pre-25-Oct default mode: they click size check-boxes that exist only in Redesign, and in plain mode the fixture's fake
  product images cannot be isolated. `product-templates.spec.ts:38` passes.

## G. Not changed / still open

- The LG master `pt-6119001cdc81` stays blocked (Water purifier residual); no repair was attempted here.
- Regenerating a *completed* product variation re-plans typography only: its product prompts are unchanged, so the saved
  images are reused and no image request is sent, although the button asks to approve 12 images. Not changed here.
- Live behaviour (real OpenAI images at concurrency 2, real Seedream) is unverified; all providers in tests are fakes.
