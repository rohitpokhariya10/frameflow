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
