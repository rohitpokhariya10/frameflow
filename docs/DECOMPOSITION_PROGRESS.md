# Decomposition checkpoint — phases 1–5 only

Branch: `feat/image-decomposition-phases-1-10`. Original specification and initial checkpoint already pushed.
Scope superseded by user: stop after phase 5. No live calls; FAL_KEY is not configured.

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
Earlier phase-6/extraction and phase-10 drafts remain uncommitted and unused; do not resume them without approval.

Remaining: live Fal quality verification; broader API/worker/browser operational validation is not claimed by this offline demo.
Next: live verification when configured, then phase 6 only after approval.

Phase 01 completion commit: `2f752a7`. Phase 02 gate: six analysis/coordinate cases passed.
Phase 02 completion commit: `2e4ede0`. Phase 03 gate: endpoint-specific proposals pass offline smoke and candidate tests; live pending.
Phase 03 completion commit: `130edbf`. Phase 04 gate: distinct mock person/board masks, duplicates and geometry checks, zero board/person overlap.
