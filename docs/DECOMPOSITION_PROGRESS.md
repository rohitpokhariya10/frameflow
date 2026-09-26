# Decomposition checkpoint — phases 1–6 offline demo

Branch: `feat/image-decomposition-phases-1-10`. Original specification and initial checkpoint already pushed.
Scope extended by user: implement phase 6 only, then stop. No live calls; FAL_KEY is not configured.

Phase 1: IMPLEMENTED / OFFLINE VERIFIED — source validation, immutable original/master hashes.
Phase 2: IMPLEMENTED / OFFLINE VERIFIED — exact native/analysis transforms, no upscaling.
Phase 3: IMPLEMENTED / MOCK VERIFIED / LIVE PENDING — Qwen images[] proposals.
Phase 4: IMPLEMENTED / MOCK VERIFIED / LIVE PENDING — SAM2 individual_masks[], candidates/overlays.
Phase 5: IMPLEMENTED / MOCK VERIFIED / LIVE PENDING — guided SAM3 and constrained person BiRefNet alpha.

Verification: typecheck passed; 30 focused source/analysis/candidate/provider tests passed.
`npm run decomp:smoke -- --mock` passed, five deterministic mock responses, board/person overlap 0.
Artifacts: `artifacts/decomposition/offline-demo/index.html` and phase directories (22 files).
Sample: owned synthetic 320×400 person holding board. Provider mock mode is explicit; live adapters remain intact.
Runtime databases and demo outputs ignored. Prior 11 unrelated modified files preserved and excluded from commits.
Phase-6 extraction drafts completed for the offline demo. Phase-10 drafts remain uncommitted and unused.

Remaining: live Fal quality verification; broader API/worker/browser operational validation is not claimed by this offline demo.
Next: live Phase 3–6 verification. Phase 7 is not authorized.

Phase 01 completion commit: `2f752a7`. Phase 02 gate: six analysis/coordinate cases passed.
Phase 02 completion commit: `2e4ede0`. Phase 03 gate: endpoint-specific proposals pass offline smoke and candidate tests; live pending.
Phase 03 completion commit: `130edbf`. Phase 04 gate: distinct mock person/board masks, duplicates and geometry checks, zero board/person overlap.
Phase 04 completion commit: `bdcacae`. Phase 05 gate: five mock responses through endpoint-specific normalization, SAM3 native crops and constrained BiRefNet alpha; inspection remains review-required.

Phase 6: IMPLEMENTED / OFFLINE VERIFIED. `npm run decomp:extract-demo` consumes existing
phase-5 files and validates hashes; native masks are not transformed twice. Outputs in
`artifacts/decomposition/offline-demo/06-extracted/`: person/board RGBA, alpha/visible masks,
white/dark previews, residual and placement metadata. HTML inspection updated.
128000 opaque pixels checked across objects/residual, zero RGB mismatches; board/person overlap 0.
Focused extraction/analysis tests: 8 passed; server typecheck passed. Soft recomposition
has <=1 channel-value rounding; extracted straight RGB/alpha are exact. Mock person alpha
remains a diagnostic soft-edge proposal requiring review, not live-verified hair quality.
No live calls or credential inspection in this iteration; recorded live blocker: FAL_KEY not configured.

## Browser wiring (phases 1–6 only)
AI panel now has Decompose. Explicit `DECOMP_PROVIDER_MODE=mock` (development only)
uses the owned fixture through existing API/jobs/worker; arbitrary artwork fails with
MOCK_FIXTURE_REQUIRED rather than fake segmentation. Live mode never falls back.
Worker freshness is checked before job creation. Refresh reconnects the saved job.
Phase-6 artifacts use existing authenticated artifact routes, with white/dark surfaces
and metadata links. Source remains the original Blob, without editable text.
Verification: workspace typecheck and build passed; one Chromium upload/job/artifact/
refresh smoke (`node tests/decomposition-ui-smoke.mjs`) passed on localhost:3001:
job 815ffde9-6fc7-49bc-873e-62985ef2c84f, phase 6 completed, 34 artifacts, person/board visible.
No live inference run. Local env is explicitly mock/development; existing Fal key untouched.
Startup: `npm run build`, then `npm start` and `npm run worker -w @frameflow/server`.
Env: DECOMPOSITION_ENABLED=true, DECOMP_PROVIDER_MODE=mock, DECOMP_AUTH_MODE=development,
DECOMP_DATA_DIR=./data/decomposition-ui-demo. Phase 7 remains outside scope.

Worker troubleshooting: duplicate old mock worker and live worker shared the demo database,
causing live jobs to fail before inference. Stopped the previously agent-started dev worker.
Mode mismatch now reports WORKER_MODE_MISMATCH with restart instructions. Server typecheck passed.
No job retried and no live model call initiated during diagnosis.

## 2026-09-26 — Phase 4 → 5 review identity fix

Implemented / offline verified. Read-only inspection of the affected saved live job confirmed
candidate-5 (3,809 analysis pixels, 0.454% coverage) was selected as Person. All 11 positive
and 13 negative points were persisted AND present in both saved SAM3 request settings.
POSITIVE_GUIDANCE_MISSING meant a point lay outside support, not absent guidance.
Rejected refinement deliberately retained that original patch. Positional overlay filenames
also diverged from stable candidate IDs after deduplication; source context obscured ownership.

Changed review UI/inspection/CSS, shared summary, repository summary, pipeline, mask validation,
and two focused regressions. UI now identifies candidates/coverage/actual legacy filenames,
uses a luminance ownership overlay, restores server corrections and per-revision session drafts.
New candidate filenames use stable IDs. Phase 5 validates unique identity and point/support
agreement before inference, records candidate/input artifact/point counts/acceptance, and reports
POSITIVE_POINT_OUTSIDE_MASK accurately. No automatic semantic relabeling or mask expansion.
Review payload permits up to the existing 64 candidate cap; selected-object cap stays unchanged.

Verification: npm run typecheck passed; focused ESLint passed; 23 tests passed across review UI,
persisted review→Phase 5, candidate/refinement, repository, and adapter contracts. Full-person
regression preserves exact coverage through SAM3/BiRefNet mocks; wrong patch pauses with zero
calls. No paid calls, DB edits, or historical artifact rewrites. Live/browser visual quality remains
unverified for this fix. Restart API/worker and reload client to use it; inspect actual mask support
before selecting the full person. Phase 7+ remains out of scope.

## 2026-09-26 — Confirm visible masks transition

Exact persisted diagnosis: job e7fb976c-50ae-4e84-9335-b927a68f8ac0 submitted all six
candidates as selected. Three review_saved events queued revisions 9/11/13; the worker
returned OVERLAPPING_VISIBLE_OWNERSHIP at revisions 10/12/14. Last return took 544 ms.
The phase-5 handler was reached, but stopped before paid inference; phase stores the last
completed phase (4). Provider mode remained live and the review lease was released.
No request/worker mode failure. Original job remains unchanged at needs_review/4/revision14.

Fix: live review candidates require explicit inclusion; show the entire included set and
provide Use only this candidate. Preserve saved labels, IDs, selection and corrections.
Confirm uses a synchronous in-flight guard, submitting label and local error display;
API response still drives Redux/polling. Overlap review names the included IDs. Worker
logs phase start/checkpoint and persists active phase wording before processing. Provider
mode isolation, overlap validation and phase numbering are unchanged.

Verification: typecheck and root build passed. 12 focused review/candidate tests passed;
8 repository tests passed on rerun (one initial run hit the existing 1 ms lease test race).
Focused ESLint and diff checks passed. Built-client browser smoke passed with mocked HTTP:
candidate-6/34.5%, per-object positive/negative points, single request for rapid clicks,
visible 409, disabled submitting state and running Phase 5 response. Command:
`node tests/decomposition-review-smoke.mjs` (local built API on localhost:3001; no inference).
No changes to Phase 1–3 provider logic or Phase 7+; unrelated work remains uncommitted.

Live check: rebuilt/restarted API and exactly one live worker. Created one fresh job
9d5e91d1-41ac-436f-8fc8-9c40a53a6ed8 from the existing validated portrait, maxCalls=4.
Live result pending below; do not confuse mocked browser verification with paid inference.

Live result: PASS transition, Phase 5 reached. Visually inspected candidate-6 overlay:
full person, 34.516% analysis coverage. Actual browser clicked Confirm once with only
candidate-6 selected, label person, no user correction points. POST review returned 200:
needs_review/4/revision12 → queued/4/revision13. Worker f1f6c728-265e-4fa2-bb37-345bedf4c38b
logged phase 5 start; browser observed running Phase 5. Final DB state needs_review/5/
revision18, leaseUntil=0, mode=live, REFINEMENT_VISUAL_REVIEW. Candidate-6 refinementAccepted=true;
input native coverage 542779 pixels. Soft-edge and model-crop-resampling warnings remain honest.
Exactly four paid calls, no retries: Qwen 01a0dc0f-7a6a-7ff1-8cba-131d2d447fc3 (768×512),
SAM2 01a0dc12-4af4-7691-9482-7205add58b30 (1024×695), SAM3
01a0dc13-7cd3-75c0-b61b-e3db84fe2393 and BiRefNet 01a0dc13-edd7-7ae2-8960-0b30de6cae25
(both 1024×784). Local-only network/status JSON and screenshots:
artifacts/decomposition/review-transition/. Images/runtime evidence are not committed.
Final root build passed after removing the duplicate old-phase heading; mocked browser check
rerun against this final build. No Phase 6 approval or Phase 7+ work performed. API and one live
worker remain running. Open Recover jobs → 9d5e91d1 to inspect the live Phase-5 result.

## 2026-09-26 — Semantic grouping and guided expansion

Implemented; focused verification in progress. Root A: Qwen returns image proposals with
no semantic labels. Phase 4 only saved overlap scores; it exposed independent SAM2 masks.
Root B: both input guidance preflight and conservative output IoU/dilation gates blocked
intentional expansion. These gates remain for accept-masks, not guided-refine.

Phase 4 now offers additional source-mask unions only for registered matching geometry,
>=95% per-part inclusion, >=80% proposal coverage and >=0.1 IoU improvement over any single
candidate. Nested redundant masks are omitted from contributors; raw options remain.
Synthesized IDs record proposalId/sourceCandidateIds; no Qwen RGB enters source masks.
These heuristic groups require review, and labels stay generic until user assignment.
UI exposes RAW/SYNTHESIZED provenance and offers user target names in the name input.
Use only this candidate, include summary, errors and duplicate guards remain intact.

Guided correction uses full-source context resized aspect-preservingly to <=1024, so a
fragment bbox cannot clip missing regions. Valid source points map with pixel-center
rounding; the old 0.8 IoU and tiny-support dilation gate do not apply. One SAM3 attempt;
output must satisfy all positive/negative points, exclude confirmed neighboring ownership,
retain some identity overlap and occupy <=90% of canvas. Empty/full/invalid geometry fails.
Successful correction always requires visual review. Confirm stays conservative. Existing
per-job budget and BiRefNet constraints remain. User target underscores normalize to spaces.
Coordinate conversion moved unchanged to shared code, re-exported at the existing client
path, so a letterboxed UI→native→model regression uses the exact UI implementation.

27 focused tests passed: semantic/candidate/refinement/review worker/analysis/provider and
client submission suites. Root typecheck, focused lint, and root build passed after fixing
a test-only cross-workspace rootDir import. Mocked browser test also verifies synthesized
provenance and Use only excludes raw fragments. No whole-repository suite run.
One authorized fresh live test: 7b3b804b-2a42-48d9-9b38-7dd1e693fdb7, existing uploaded
girl-with-phone source, user target person_with_phone, maxCalls=4. Result recorded below.

Live result: BLOCKED, no retry. Qwen completed (four 576×704 proposals; all geometry
mismatched, therefore retained but not unioned). Starting SAM2 failed with PROVIDER_NETWORK:
"Provider connection failed or timed out." Final job state failed/phase3/revision11,
callsUsed=1; only Qwen was submitted. No Phase-5 live inference was reached in this run.
Do not describe the girl+phone mask as live-verified. Existing artifacts and source retained.
Final focused suite: 28 tests passed, including removing a negative point region from old
support, guided expansion through durable review/live-mode worker with mocked inference,
and conservative confirmation. Final root build passed. Real browser mocked-HTTP check
passed synthesized grouping selection/provenance, point payloads, errors and double-click
protection. No further paid requests. Next: visually verify one guided result when provider
connectivity is restored; no Phase 7+ work. Current implementation uses explicit user target
assignment, not automatic semantic labeling of Qwen images; unsupported/misaligned groups
remain raw candidates with a guided fallback. Grouping and 90% correction coverage cap are
review heuristics, not proofs of semantic correctness.

## 2026-09-26 — Source-driven semantic ownership hardening

Before: raw SAM2 candidate → prior-overlap-biased correction → rejected/retained mask could
still be published as phase-5-ready. Provider scores/boxes did not reach candidate selection.
After: user intent → working-master SAM 3.1 → local quality and group-member checks →
review/correction → constrained high-resolution alpha → explicit approval → native extraction.
Phase 7+ unchanged. Qwen RGB never enters ownership or extracted RGB.

Verified official schemas on 2026-09-26:
https://fal.ai/models/fal-ai/sam-3-1/image/api (same documented pixel points/boxes, object_id,
masks/scores/normalized boxes); endpoint registry sam3 adapter v2 now uses that endpoint.
https://fal.ai/models/fal-ai/birefnet/v2/api (Dynamic supports 2048 operating resolution).
No model carousel; previous endpoint requests retain recorded endpoints in durable transport.

SemanticTarget preserves user label, normalized prompt, single/group mode and member hints.
Direct full-expression segmentation is independent of SAM2. Two-member groups additionally
check atomic masks; ambiguous instances are review-required. A union is only a reviewable
alternative with recorded member prompts, scores and a close spatial relationship. No automatic
semantic label is inferred from Qwen image order. Automatic mode can use registered proposal
bounds/interior/exterior seeds; mismatched proposals fall back to raw review. SAM2 is auxiliary.

Quality rejects missed positive points, negative leaks, missing member coverage, protected
ownership overlap, excessive coverage/border leakage, excessive components and low provider
confidence. Current-mask IoU is only a weak score prior. Geometry cannot prove semantic intent;
all successful masks still require human visual confirmation. Failed attempts keep previous
artifacts and stay in phase 4; rejected legacy results cannot be approved into extraction.

Manual-masks applies native ADD/SUBTRACT strokes, saves immutable revisions, and makes no
provider call. Accepted ownership is matted only in a small uncertainty band; native interior
is retained. Dynamic 2048 alpha is used on larger soft-target crops, Matting otherwise. Native
mask/alpha/overlay are published together with matching revision IDs and checksums; overlay
is made directly from the exact saved alpha. Target UI prioritizes semantic results; raw IDs
and provenance stay in Advanced inspection. Qwen seed is deterministic from source SHA/options;
bbox/coverage/registration/provenance are stored. Per-job inference cache excludes step key,
preserves scores/boxes and skips duplicate inference on identical source/settings/adapter input.

Verification so far: 44 focused tests passed across semantic ownership/review/coordinates,
provider contracts/recovery, client submission, and native extraction. Root typecheck, focused
lint, root build passed. Live test pending: job 84905d7d-678f-40f1-b884-517e5e4c44d9,
woman holding phone poster, maximum six submissions, at most one guided correction.

Live poster verification completed: job 84905d7d-678f-40f1-b884-517e5e4c44d9 is
needs_review at phase 5, five total submissions, zero guided retries. First full-expression
SAM mask failed member completeness; independently segmented woman/phone were spatially
related and combined as an explicitly reviewable group. Browser confirmation started alpha.
Native ownership is 1200×1500, 491394 pixels (27.2997%). Visual inspection confirms visible
woman, arms/hands, phone, and hair bulk; poster text/panels excluded. Soft edges still need
human inspection; no claim of perfect individual hair strands. SAM inputs/outputs 1200×1500;
BiRefNet Dynamic 2048 operating mode returned 1168×1065 contextual crop, mapped to native.
Mask/alpha/overlay share revision 61197ed1-de60-48da-8031-a2100462e34e. Request IDs:
Qwen 01a0dc64-c793-77e1-8f6b-6e69b2fae51d;
SAM 01a0dc67-8e6f-7190-9aff-b794a3f982af, 01a0dc67-b7e5-7ad1-b37b-9c4665cea5d7,
01a0dc67-dd4c-7cb3-b693-e23975ed335f; alpha 01a0dc69-eceb-75f0-b287-79026eb68016.
Original artifacts retained. Browser screenshot in ignored artifacts/decomposition/source-semantic/.
45 focused tests now pass, including semantic partial-result failure preserving prior mask.
Next user request is Qwen reproducibility investigation; keep this source-driven architecture.

## 2026-09-26 — Qwen reproducibility (follow-up)

Read historical jobs before changing requests. Eleven Qwen records across four source hashes:
legacy calls omitted seed; same-source provider PNG hashes were identical, but returned seeds
and proposal hashes differed. Poster legacy seeds: 275634882 / 1365631058 / 1344302420.
Latest poster seed sent/returned: 2096359909. Recreated all four original→master→analysis paths
twice; source, master and input hashes exactly matched history. No encoding nondeterminism found.
Old returned caption was discarded; historical provider model revision is unknown. Consequently
seed is the proven differing parameter, without claiming all provider-side defaults were identical.

Added explicit Qwen caption/negative prompt/steps/guidance/acceleration/output settings, canonical
SHA-256 effective-request seed/fingerprint, independent sent/returned seeds and returned-caption
persistence, sanitized request/result logs, and same-owner cross-job verified artifact reuse.
Cached files are copied into the new job; expired/tombstoned/other-owner/mock results are excluded.
Pending differently fingerprinted requests block new billing; known matching IDs resume.
SAM 3.1 semantic ownership, boundary alpha and original RGB extraction remain intact.

Evidence, full parameter comparison and limits: docs/QWEN_REPRODUCIBILITY.md.
Local ignored reports: artifacts/decomposition/qwen-reproducibility/{historical-comparison,input-verification}.json.
56 focused tests passed (12 files), root typecheck, focused lint and root build passed; final
cache-metadata consistency assertion rerun passed all 11 reproducibility tests. No additional
paid calls for this investigation; no same-seed two-call provider equality claim.
Existing poster remains phase5/needs_review, five total calls, final 1200×1500 mask/alpha/overlay
saved and visually inspected. Source-driven hardening checkpoint pushed separately as 89f14c0.
Next: user inspects/approves existing Phase-5 target. No Phase 7+ implementation or inference.
## 2026-09-26 — Scene-graph plan, Step 1–3 checkpoint: Seedream discovery + provider selection

Scope for this checkpoint: Seedream layer discovery adapter, normalized proposal contracts,
provider selection/fallback, focused tests. Proposal-review, classification, SAM, alpha and
scene-graph stages are NOT changed by this checkpoint.

Endpoint `bytedance/seedream/v5/pro/layerize` (fal API page verified 2026-09-26): input
`image_url`, optional `prompt`, `image_size` (auto…auto_2K), `enhance_prompt_mode`,
`enable_safety_checker`, `sync_mode`; 512–6000 px sides, aspect 1/16–16; no seed. Output
`layers[]` {image, z_index, bounding_box{absolute px LTRB, normalized 0–1000}, name, description};
base layer is z_index 0 without bbox/name. `images[]` duplicates layers and is ignored.
Undocumented: whether non-base layers are full-canvas or bbox crops — both are handled.

Implemented:
- `providers/adapters.ts`: `seedream` registry entry, wire builder (no seed ever sent),
  `layers[]` normalization (z-index uniqueness, bounded/sanitized name/description, box validation,
  ≤17 layers, safety refusal preserved).
- `providers/seedreamRequest.ts`: canonical request fingerprint (`seedream-layerize-v1`, source SHA,
  analysis-input SHA, exact wire settings); `deterministic: false` recorded explicitly.
- `context.ts`: Seedream job-level cache, same-owner cross-job reuse (`findReusableSeedream`, files copied
  into the new job), layer metadata persisted in the inference cache and durable provider record, sanitized
  request/result logs. Donor-copy logic shared with Qwen (Qwen behaviour unchanged).
- `phases/discovery.ts`: `DiscoveryProposal` contract; Seedream registration onto the analysis canvas
  (full-canvas or bbox-placed crop; different-aspect canvases stay unregistered, never stretched);
  base layer kept separately (future BACKGROUND element, not fed to SAM); ≤12 proposals (review limit),
  back-to-front ids; small analysis images uniformly upscaled to 512 px minimum.
- Provider plan fixed per job (`data.discoveryPlan`): live default Seedream → Qwen fallback
  (`DECOMP_DISCOVERY_PROVIDER`, `DECOMP_DISCOVERY_FALLBACK`); mock mode and jobs that already attempted
  Qwen stay on Qwen. Fallback only after unavailable/schema/empty/rejected/network/deadline/unusable
  results; never after SUBMISSION_UNKNOWN, auth, credits, rate limit, safety, cancel or stale lease.
- Phase 3 persists `data.discovery` (DiscoverySummary: provider, model, attempts, fallbackFrom, fingerprint,
  request id, base layer) and extended optional `ProposalSummary` fields. Seedream artifacts under
  `03-discovery/`; Qwen keeps `03-qwen/`. Historical proposals without new fields still summarize.

Verification: 67 focused tests (8 files) pass, including new `providers/seedream.test.ts`,
`phases/discovery.test.ts`, `discoveryPhase.test.ts`. Root typecheck, focused lint, root build pass.
Full decomposition suite: 3 failures pre-exist without this change (reviewFlow phase-5, router 503,
semanticSource manual correction — reproduced on a copy with these changes removed) plus an
intermittent `repository.test.ts` lease-timing flake (1 ms lease). No paid calls made.

Next (not started): Step 4–5 proposal review uses provider labels/roles and base layer as background target.

## 2026-09-26 — Live Seedream verification and scaled-crop registration fix

One live call: request `01a0dcd5-8773-7da0-94c2-604dd84d0903` (poster source a97f38d9, fingerprint
`3cbf40bb…`). Live behaviour differed from the docs: image `width`/`height` are `null`; the base layer
(z=0) is full-canvas 896×1120 RGB for an 819×1024 input; non-base layers are bbox crops, each uniformly
upscaled by its own factor (1.07–3.7×, aspect within 1.65%). The strict parser rejected the paid result.

Fixes: null image metadata is treated as missing; new `bbox-scaled` placement (uniform crop scale within
max(2%, 1.5 px / shorter bbox side), scale 0.25–8×) resizes the crop once straight onto the analysis canvas and
records provider size, provider bbox, crop scales, aspect error and `seedream-registration-v2`; anything else
stays unregistered. A completed result that only fails local parsing is recorded `LOCAL_NORMALIZATION_FAILED`
and re-read for free by request id (`recoverCompleted`), never resubmitted; Seedream retries resume the saved
request step. Local parse/geometry failures after a paid result no longer trigger the Qwen fallback.

Recovered the paid result with 0 submits/0 uploads (1 status + 1 result read, 10 media downloads): 9/9 layers
registered bbox-scaled + full-canvas base; reconstruction vs analysis mean |ΔRGB| 5.38/255, placement ≤2 px.
Cache populated under the fingerprint; job 297f4268 is now reusable by identical same-owner requests.
Job a1872abd (earlier upload failure, no call) remains an empty review job.
