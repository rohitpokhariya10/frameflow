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
