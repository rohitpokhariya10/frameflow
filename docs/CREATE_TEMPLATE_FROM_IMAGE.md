# Create Template from Image

Open **OpenAI + Seedream test → Create Template from Image**. The existing bottom launchers and zoom controls retain their positions. This standalone feature remains available alongside the integrated [Create from Reference Image](REFERENCE_CREATIVE.md) panel inside **Create Own Template**, which reuses its generation and decomposition services.

## Structured analysis and local prompt compilation

The root fix replaces `image → model-written prose → reject over 2000 characters` with:

`validated reference → one structured analysis → local normalization/compilation → editable prompt → original-reference images.edit → decomposition → layers → editor`.

`createOpenAIImagePromptWriter` requests `IMAGE_ANALYSIS_SCHEMA` and passes the response to `parseImageAnalysisResponse` and `buildImageTemplatePrompt`. The schema contains scene type, hero identity/appearance/orientation/view/position/scale, counted objects with spatial relationships, composition, palette, lighting, materials, background treatment, visible text, preservation rules, suggested name and A/B/C detection. Strings have per-field bounds; objects are limited to 12 entries and palette/material/rule lists to six each. The same call detects the layer style. There is no AI prose-rewrite or automatic retry.

Local normalization tolerates missing optional fields, nulls, unknown keys, duplicate evidence and excess verbosity. It bounds whole phrases/words with Unicode-aware segmentation, never slices the finished prompt or splits a word/emoji. An oversized unbroken identifier is represented by a reference-preservation phrase rather than a broken identifier. Invalid object counts, unknown layer styles, unusable core evidence, malformed JSON, refusals and incomplete responses produce one explicit analysis error.

The deterministic builder first reserves a compact representation of every retained P0 section: hero identity/appearance, orientation/view/position, object counts/relationships and fixed preservation constraints. It expands those sections before admitting P1 framing/scale/palette/background/hierarchy and then P2 lighting/material/depth/prop detail. Optional sections that do not fit are omitted whole. Exact duplicate objects/rules are removed. Beyond 12 object entries, the prompt explicitly preserves additional objects from the canonical image; the prompt is a bounded description, not an exhaustive scene graph. Normalized analysis is persisted independently in each group's `group.json`; the raw response remains in the existing server artifact file.

| Budget | Source / value |
| --- | --- |
| Editable prompt | `IMAGE_TEMPLATE_LIMITS.prompt`: **2000**, derived from the existing base limit and available complete-request space |
| App complete request | `IMAGE_TEMPLATE_REQUEST_LIMIT`: **3000** |
| Fixed instruction headroom | Consistency + longest framing + reference instruction + join spaces: **949** |
| Longest valid request | **2949** with a full 2000-character edit; 51 characters spare |
| GPT Image provider maximum | Installed OpenAI SDK documents **32000**; the app keeps its smaller contract |
| Decomposition | Independent **2000** Seedream limit and planner reserves; unchanged |

Client counter, client blockers, server draft-save validation and Generate validation now count the exact editable text, including whitespace. A user edit at 2000 is valid; 2001 is displayed unchanged and blocks generation. Going below the limit re-enables Generate. `generateVariant` validates the **complete** image-template request after appending reference instructions and before creating the image client. System compaction costs zero provider calls; user-authored text is never silently compacted.

Uploads retain the existing 25 MB and Sharp decoder/pixel limits. Before creating a group or analyzing, the server validates PNG/JPEG/WebP signature/metadata, single-frame dimensions, matching multipart MIME and actual decode through the analysis-image preparation path. Filename extensions are cosmetic: decoded bytes and matching MIME govern acceptance. Missing/empty/corrupt, unsupported, oversized, extreme-dimension and interrupted multipart uploads cannot start analysis. Original bytes remain unchanged.

**Write again from image** makes one explicit new analysis request and compiles locally, preserving name, ratio selection and manual A/B/C override. It is draft-only. Source replacement still requires a new group. Selected ratios use the original bytes plus the latest valid edit; retries and later-added ratios preserve that lineage. No text-only fallback or copy-from-copy chain was added. Existing save serialization, duplicate-action guards and stale-response protection remain in place.

The offline fixture now uses the real analysis adapter/compiler with synthetic JSON responses of exactly **3344** and **4002** characters. Both must yield a visible, editable, budget-safe prompt after one fake analysis call. `?analysis=3344` on the test reference endpoint selects the smaller case; the default selects 4002. Fake images still cannot establish live visual fidelity.

## Reviewer walkthrough without provider calls

```sh
npm run build
npm run demo:image-templates
```

Open `http://127.0.0.1:3317`. This server uses the real application routes, file storage, decomposition runner and editor import, with deterministic local providers. It reads no credentials or `.env` files, rejects outbound fetch, and stores its records in a fresh temporary directory printed on startup. Its test-only reference image is at `http://127.0.0.1:3317/__test__/reference.png`.

1. Open **OpenAI + Seedream test**, then **Create Template from Image**.
2. Choose **New template**, enter a name and upload a PNG, JPEG or WebP reference (up to 25 MB).
3. Click **Generate prompt from image**. Wait for the editable **Generated prompt** textarea.
4. Edit the prompt. Select **1:1**, **4:5**, and/or **16:9**; turn off the sizes you do not want.
5. Click **Generate selected templates** and accept the confirmation. On this fixture server, all provider work is fake even though the normal UI describes live costs.
6. Check that only selected sizes appear as result cards. Inspect their previews and statuses.
7. Click **Decompose into layers** on a completed image. After completion, expand **Preview layers**.
8. Click **Open in editor**. Select the phone layer, change its position or opacity, and reload to verify the edit persists.
9. Reopen the feature, create a second named template and switch between them. Earlier groups retain their own prompts and results.

The deterministic fixture generates the same lavender phone artwork regardless of the uploaded reference or prompt. It demonstrates wiring and UI behavior, not model quality. Stop it with Ctrl-C. It never uses the normal artifact directory.

## Automated verification

```sh
npm run typecheck
npm run lint
npm run build
OPENAI_API_KEY= FAL_KEY= GEMINI_API_KEY= CLOUDFLARE_API_TOKEN= npm test -- --maxWorkers=2
npm run test:e2e:offline
```

The offline browser configuration starts its own server on port 3317, refuses to reuse another server, and runs full regressions at 1440×900 and 1366×768, plus the reviewer journey at 1920×1080. Existing AI browser specs mock their API responses; the health check reaches the local server. The new `tests/e2e-image-templates/journey.spec.ts` goes through the real local API with fake providers. Screenshots and failure traces are under `test-results/offline/`.

## Actual code path

- `CreateTemplateFromImage` → `imageTemplateApi.create` → `POST /api/layerize-experiment/image-templates` → `createImageTemplate` + `describeReference` + `createOpenAIImagePromptWriter`.
- `TemplateDraft` displays/edits the returned prompt. `PATCH /image-templates/:id` saves draft edits. Autosaves are serialized; explicit actions wait for them and stop if a save failed. **Retry save** retains the unsaved fields. Refresh responses from before a mutation, or older than an already accepted refresh, cannot overwrite newer state.
- `POST /image-templates/:id/generate` → `startImageTemplateGeneration` → the existing image queue → `queueVariant` / `generateVariant` from `generationGroups.ts` → OpenAI `images.edit`. Every request attaches the original uploaded file with the edited prompt and ratio-specific preservation instructions. Only selected variants are queued. Remaining ratios can be added later.
- `POST /image-templates/:id/variants/:variant/decompose` → saved variant bytes → `createRun` / `executeRun` → existing planner, Seedream transport, rendering and layer normalization. Per-variant reservations prevent concurrent duplicate starts.
- `LayerPreview` reads the existing run and artifact endpoints. `importAsVersion` wraps the unchanged `experimentToVariant`.
- **Open in editor** (`openResultInEditor`, shared with reference creatives) opens a decomposed result as a **design of its own**, never as a new version of the design that is open: the first open builds a one-version design from the stored run (its canvas, its layers, `importedFrom` = template, result and run) and the editor switches to it; the design that was open is kept unchanged on this device (`lib/persistence/designLibrary.ts`), so its version count and its 30-version limit are untouched. **Open in editor again** switches back to that same design. A double-click joins the open already on its way. Nothing is planned, generated or decomposed again: only the stored run and its files are read, plus one "opened" record. The **Design** menu beside **Version** switches between the designs on this device; **New design** discards only the open one (pictures a stored design shows are kept).

All new routes are below the existing `LAYERIZE_EXPERIMENT=1` gate and `experimentAccess` middleware. Production uses the configured `CLIENT_ORIGIN`; this feature does not add authentication or bypass existing access rules.

## Data and scope

Named groups live under `artifacts/decomposition/image-templates/<id>/group.json`, with the original reference, prompt request/response records, generated images and variant metadata. Decompositions use the existing run/artifact directory. Groups retain generated and edited prompts, selected sizes, timestamps, errors, run references and the last recorded editor import. The list shows the newest 50 groups. Durable hosting requires persistent storage for these existing file-based artifact directories. Editor documents/assets remain in the browser's existing persistence system.

Generation accepts arbitrary reference compositions in supported image formats. Decomposition reuses the existing A/B/C layer styles: the prompt request suggests one, and **Layer style** lets the user override it. This does not introduce a universal decomposition model or guarantee suitable results for every composition. A manually rewritten prompt may call for another layer style.

Generated groups keep their generation prompt fixed. Create a new group to use a different prompt; adding or retrying a size uses the group's saved prompt. Every ratio, including the first, added sizes and retries, uses the same original uploaded reference bytes. Generated outputs never become the source of another ratio. This feature always uses image conditioning, even with `TEMPLATE_RATIO_REFERENCE=off`; that flag retains its existing behavior for the standalone A/B/C generators. A missing reference or edit failure is reported without a text-only fallback.

The analysis asks for exact object counts, relative sizes/positions, product geometry and details, orientation, camera view, overlaps, palette, lighting, materials and background treatment, plus preservation constraints. The editable prompt remains visible. Square framing minimizes reinterpretation; portrait/wide framing extends or minimally reframes the original background vertically/horizontally. Explicit user edits take precedence; otherwise the uploaded image is the visual authority. Existing saved groups receive the new framing instructions when a pending/failed ratio is generated; already finished images stay untouched.

New attempts record `sourceReference` (original filename, SHA-256 and instruction) and `ratioStrategy: "uploaded-reference"` for auditability. The saved checksum is verified before sending an edit; changed source bytes fail visibly before any image request. The installed OpenAI 7.23.0 SDK supports `images.edit` with the existing PNG/JPEG/WebP uploads and requested sizes. Its `ImageEditParamsBase` comments say `gpt-image-2` ignores `input_fidelity`, so this fix does not depend on that parameter. Image conditioning improves the request's preservation intent but does not guarantee exact pixels or object geometry; actual model fidelity still needs a separately authorized live review.

Source replacement uses a new group. Before the first upload, choosing another local file only replaces the preview; no prompt exists yet. Once uploaded, the reference is immutable even while the group is a draft, and the UI says to start a new template for a different image. The API rejects reference edits. **Write again from image** is available only for drafts: it re-analyzes the same original, preserves name/ratios/manual layer-style selection, and never starts image generation. After generation, that action is refused to preserve completed results and their prompt provenance.

Editor import remains the existing raster-layer workflow. Each output layer can be moved, resized, rotated, hidden, reordered, duplicated, deleted or replaced. Text inside an image remains pixels, not native editable text. The existing 30-version limit and unresolved-placement behavior are preserved.

## Minimum live test, only after separate approval

First validate fidelity alone: upload the real product reference into a new group, generate its prompt once, inspect/edit it, select only **1:1**, then generate once. Compare product proportions, camera module, angle, prop count/placement, background and lighting with the original. Stop there until fidelity is acceptable. This costs **2 OpenAI requests** (one reference analysis, one image edit), **0 fal**, and **0 Seedream**. An existing ready draft needs only the one image-edit request. Do not test the other ratios live until this passes.

If an end-to-end decomposition check is later authorized, decompose that square once and open the editor. With `LAYERIZE_FIT_CHECK` off (the existing default), that adds one OpenAI plan and one paid fal/Seedream Layerize submission (total **3 OpenAI + 1 fal/Seedream submission**). With fit checking enabled, add one OpenAI request. Uploads, status/result reads and editor import are transport requests, not extra model submissions. No live-provider request is required for the offline walkthrough above.

## Known pre-existing unit failures

The takeover reproduced the three failures already reported against clean HEAD; their affected implementation files are unchanged:

- `server/src/decomposition/repository.test.ts`: worker lease required before reserving inference.
- `server/src/decomposition/reviewFlow.test.ts`: phase 4 returned where the test expects phase 5.
- `server/src/decomposition/router.test.ts`: upload returns 503 where the test expects 202.

The existing main-client chunk-size warning also remains. These are separate from the image-template feature's focused tests.

## Historical feature verification (before the structured-analysis fix)

- Typecheck, lint and production build passed after the final review fixes. Main client chunk: 617.73 kB raw / 184.14 kB gzip; the 500 kB warning predates this feature.
- All 41 focused feature/access tests passed.
- All 180 browser regressions passed at 1366×768 and 1440×900. The additional 1920×1080 journey passed.
- After the final review fixes, all 15 targeted browser checks passed: the feature scenarios at 1366/1440, both failed-save/stale-response regressions, and real-backend journeys at 1366/1440/1920. Typecheck, lint and build were rerun successfully. The earlier full browser suite was not rerun after these two localized frontend fixes.
- The real-backend fake-provider journey verified editor import, moving an individual layer and persistence after reload at all three sizes.
- A full 892-test unit run had the three known failures above and five timeouts while Chromium was also running. All 49 tests in the four affected timeout files passed in isolation. The two Template B cases were then rerun alone with the original five-second timeout: both passed (3.25 seconds total including startup), confirming load-related timeouts without changing their timeout settings.
- Visual review found no launcher/zoom overlap at 1366 or 1920 pixels. `git diff --check` passed. No live OpenAI, fal or Seedream requests were made.

Review artifacts (ignored by Git): [1366px launchers](../test-results/image-template-review/1366-launchers.png), [1920px prompt](../test-results/image-template-review/1920-prompt.png), [returned layers](../test-results/image-template-review/1920-layers.png), [editor](../test-results/image-template-review/1920-editor.png). The same folder contains the test logs, including the full unit-run failures and isolated reruns.

## Historical initial feature inventory

23 feature/verification files: 10 modified tracked files and 13 new files. All remain uncommitted.

| Category | Files |
| --- | --- |
| Client (6) | `client/src/App.tsx`; `client/src/features/decomposition/LayerizeExperimentPanel.tsx`; `client/src/features/imageTemplates/{CreateTemplateFromImage.tsx,imageTemplates.ts,imageTemplates.css,imageTemplates.test.ts}` |
| Server (6) | `server/src/decomposition/{imageTemplates.ts,imageTemplates.test.ts,generationGroups.ts,layerizeRouter.ts,layerizeExperiment.ts,layerizeAccess.test.ts}` |
| Shared (3) | `shared/src/{imageTemplateGeneration.ts,imageTemplateGeneration.test.ts,index.ts}` |
| Tests (5) | `tests/e2e/image-templates.spec.ts`; `tests/e2e/templates.spec.ts`; `tests/e2e-image-templates/journey.spec.ts`; `tests/fixtures/imageTemplateOfflineServer.ts`; `tests/tsconfig.json` |
| Scripts/config (2) | `package.json`; `playwright.offline.config.ts` |
| Documentation (1) | `docs/CREATE_TEMPLATE_FROM_IMAGE.md` |

The inherited untracked `test__.png` was left untouched and is not part of the feature. Screenshots, logs and build output remain ignored; nothing is staged.

## Fidelity follow-up: change scope

This follow-up changes 11 files within the existing work:

| File | Purpose |
| --- | --- |
| `server/src/decomposition/generationGroups.ts` | Optional original-source edit input, provenance and checksum verification; existing A/B/C callers retain their behavior. |
| `server/src/decomposition/imageTemplates.ts` | Structural analysis instructions, mandatory original input for every attempt, refusal of prompt-only retries, interrupted-upload handling. |
| `server/src/decomposition/imageTemplates.test.ts` | Assert real SDK request shapes/input bytes with fakes, retry/add-size lineage, failures, concurrency, detection, regeneration and immutable source behavior. |
| `shared/src/imageTemplateGeneration.ts` | Preservation and ratio-specific framing instructions. |
| `shared/src/imageTemplateGeneration.test.ts` | Fidelity constraints and prompt length limits. |
| `client/src/features/imageTemplates/CreateTemplateFromImage.tsx` | Explain original-source adaptation and remove prompt-only retry. |
| `client/src/features/imageTemplates/imageTemplates.ts` | Mirror provenance/strategy metadata and reference-only retry API. |
| `client/src/features/imageTemplates/imageTemplates.test.ts` | Updated retry request contract. |
| `tests/e2e/image-templates.spec.ts` | Current mock contract, no prompt-only fallback, immediate edits and duplicate-click protection. |
| `tests/e2e/templates.spec.ts` | Wait for stable canvas screen geometry before computing real drag coordinates after aspect-ratio changes; assertions and timeouts unchanged. |
| `docs/CREATE_TEMPLATE_FROM_IMAGE.md` | Behavior, limitations, verification and minimum-cost live review. |

These tests establish request wiring and reference lineage. Fake outputs do not measure image-model fidelity, object placement accuracy or pixel-perfect preservation.

## Reference invariants verified with fake requests

| Attempt | Uses original upload |
| --- | --- |
| First 1:1 | Yes |
| 4:5 | Yes |
| 16:9 | Yes |
| Later-added size | Yes |
| Explicit retry | Yes |

No generated sibling is used as input, no silent text-only fallback exists, and no unselected ratio is queued. Provider failures do not automatically retry. Tests assert edited prompt content, actual image bytes/checksum, edit method and target dimensions, and reject duplicate generation/decomposition requests. A changed original is rejected before the provider call.

The Create Own Template laptop drag failure was a test-coordinate race: its logical-size assertion completed before ResizeObserver fitted the visible canvas, so mouse-down hit the background at an outdated position. Only the test helper changed: Playwright's trial click waits for element stability before coordinates are read. It sends no click. The test still performs the real drag and asserts geometry and persistence, with the original timeouts. Runtime template code remains unchanged.

## Historical fidelity verification (before the structured-analysis fix)

- Final typecheck, lint and production build: passed. The existing main-chunk size warning remains.
- Final focused feature/access/A/B/C generation tests: **91 passed** across six files.
- Full unit run: **900 passed**, only the same **3 pre-existing failures** listed above, no timeout failures. The interrupted-upload test added afterward passed separately and in the final focused run; the full suite was not unnecessarily repeated.
- Create Own Template laptop drag: **3/3 passed** with original timeouts after the test-only stability wait. Complete templates browser spec: **4/4 passed** normally.
- Final full browser suite: **187/187 passed**, including all existing flows, stale-response and failed-autosave protections, latest-edit/duplicate-click checks, and real-backend fake-provider journeys at **1366, 1440 and 1920px**.
- Visual review: readable forms, result cards and layer previews; no launcher/zoom overlap; editor controls intact. Individual imported layer movement survives reload.
- `git diff --check`: passed. No commits, pushes, staged files or live provider calls. Work remains on `main`.

Latest evidence is copied into the ignored `test-results/fidelity-review/` directory: final check logs, the original full-unit log, isolated drag reruns and viewport screenshots. The final browser log retains the complete list of passing tests.

## Structured-analysis fix: current file inventory

This fix leaves 16 feature/verification files uncommitted on `main`:

| Category | Files |
| --- | --- |
| Client (3) | `client/src/features/imageTemplates/CreateTemplateFromImage.tsx`, `imageTemplates.ts`, `imageTemplates.test.ts` |
| Server (4) | `server/src/decomposition/imageTemplates.ts`, `generationGroups.ts`, `imageTemplates.test.ts`, new `imageTemplateAnalysis.fixture.ts` |
| Shared (5) | new `shared/src/imageTemplateAnalysis.ts`, new `imageTemplateAnalysis.test.ts`, `imageTemplateGeneration.ts`, `imageTemplateGeneration.test.ts`, `index.ts` |
| Browser/fixture (3) | `tests/e2e/image-templates.spec.ts`, `tests/e2e-image-templates/journey.spec.ts`, `tests/fixtures/imageTemplateOfflineServer.ts` |
| Documentation (1) | `docs/CREATE_TEMPLATE_FROM_IMAGE.md` |

The inherited `test__.png` is untouched and excluded. No dependency, access-control, feature-flag, standalone A/B/C, decomposition, editor or persistence implementation was changed. The small editor-facing UI change describes prompt provenance accurately and marks whitespace-only edits as edits. Test screenshots/build output/logs remain ignored. There are no commits, pushes or merges for this fix.

## Structured-analysis verification (2026-10-01)

- Focused shared/client/server/access/A/B/C suite: **119 passed** after the compaction and malformed-response changes. Three PNG/JPEG/WebP acceptance cases added afterward also passed in the final full unit run.
- Final full unit suite: **933 passed / 935 total**. Only the known `reviewFlow.test.ts` phase-4-versus-5 and `router.test.ts` 503-versus-202 failures remain. No new failures or timeouts. The previously documented repository lease failure did not reproduce in either full run.
- Full offline browser suite: **197/197 passed**, at 1366/1440 with real-backend journeys additionally at 1920. The initial new multi-group test omitted the Origin header on direct API reads; the access guard correctly rejected it. The harness now supplies Origin; production access rules were not changed.
- After the final provenance-hint and whitespace-edit badge changes, the rebuilt client passed **27/27 targeted browser checks**, including all three real-backend viewports.
- Final typecheck, lint, production build and `git diff --check`: **passed**. The existing main-client chunk-size warning remains.
- Both synthetic 3344/4002-character analysis responses compile locally to **1146-character** editable prompts with hero/camera details, all four sphere positions/count, orientation and preservation constraints intact. One explicit analysis request; no extra rewrite/retry. Tests also cover dense scenes, huge individual fields, missing optional data, Unicode/emoji, invalid responses, all edit/request boundaries, selection counts, lineage and failure isolation.
- No live OpenAI/fal/Seedream calls, no automatic paid retries, no commits, no pushes. Screenshots/logs/build outputs are ignored.

| Required outcome | Result |
| --- | --- |
| 3344-equivalent / 4002-equivalent → usable editable prompt | YES / YES |
| Extra OpenAI retry / raw string truncation | NO / NO |
| Editable and complete-request budgets enforced | YES / YES |
| Prompt visible / editable / over-limit edits blocked / no provider call while invalid | YES / YES / YES / YES |
| Original input for 1:1 / 4:5 / 16:9 / later-added ratio / retry | YES / YES / YES / YES / YES |
| Copy-from-copy / text-only fallback | NO / NO |
| Template A / B / C / Create Own Template | PASS / PASS / PASS / PASS |
| This feature's decomposition / Open in editor / reload persistence | PASS / PASS / PASS |

Cheapest live retest, described only: a new valid reference plus one **Generate prompt** click costs one analysis request and directly checks the reported bug. To check fidelity afterward, select only **1:1** and generate once: one additional image edit. Decompose only after that result is acceptable; it adds the existing planner and Seedream costs described above. No live retest was executed. Raster text remains pixels; native OCR/text extraction and live-model visual fidelity are outside this offline verification.
