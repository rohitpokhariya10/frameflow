# OpenAI + Seedream diagnostic dashboard — validation

**STATUS: READY FOR MANUAL UI TEST**  
**BRANCH: main · COMMITTED: NO · PUSHED: NO**

## Existing work preserved

The working tree already contained production curation, protected interactions, residual/background handling, explicit editor-layer selection, offline fixtures, and the cofounder costing document. A shared pricing calculator had been started before the continuation request. Work continued from those files; no branch/reset/restore/stash was used. `test__.png` was untouched.

## Completed

The existing test panel now has a run summary, pipeline timeline, stage/model/usage/call/cost table, target comparison, original/final previews, curated editor layers, and background/recursion cards. Raw layers, prompts, request IDs, artifacts and detailed metrics are collapsed by default. Hidden debug thumbnails are not mounted until expanded. Copy supports clipboard access and explains manual copying when access is unavailable. Desktop and 390px views were checked visually.

Provider prompts, production model selection, curation/recursion/background decisions, paid call behavior and editor import handlers were not changed by the dashboard work.

## Cost accounting

The read-only diagnostics endpoint derives facts from persisted run/request/response/raw-layer files and linked source generation records. Costs use the actual recorded model and usage, including cached input/cache writes and image/text token splits. Seedream bills raw generated layers, with a separate native output-size tier per residual pass. Curated counts never determine provider cost. Reasoning tokens are not double-counted.

Recorded usage/counters are distinguished from inferred counters. **Calculated** means configured rates × recorded usage; **Estimated** identifies assumptions; **Unknown** retains the known subtotal without claiming a complete total. No invoice-exact claim is made. Shared source analysis/generation attribution is explained in the UI.

**USD → INR:** `AI_BUDGET_USD_INR` on the server, default **₹90/$ project budgeting rate**, centralized in `shared/src/aiPricing.ts`. Not live FX. See [accounting details and pricing sources](AI_COST_TELEMETRY.md).

## Example test run — synthetic usage, fake providers

| Stage | Calculated INR |
|---|---:|
| Reference analysis | ₹0.41 |
| Image generation | ₹5.90 |
| Planner | ₹10.22 |
| Seedream initial | ₹39.49 |
| Residual | ₹0.00 |
| Background AI edit | ₹0.00 |
| Local curation | ₹0.00 |
| **Total, summed before rounding** | **₹56.01** |

**Recorded paid-call attempts: 4. Raw → Editor: 13 → 6.** Above the ₹33 target by **₹23.01**; the target is informational.

Planner pricing includes 3,373 cache-write tokens. The earlier cofounder estimate omitted that premium; `FRAMEFLOW_COSTING.md` now includes it. A read-only check of the existing October 6 saved run yielded **₹52.98, 4 calls, 12 raw → 11 editor layers**, demonstrating per-run variation without new provider calls.

A synthetic failed run displays **₹16.53 known + unknown**, with Seedream billing unknown and no editor result.

## Acceptance checks

| Check | Result |
|---|---|
| Target ₹30–₹33 display and nonblocking comparison | PASS |
| Per-run costs, exact saved models, raw-layer billing | PASS |
| Refresh / reopen telemetry | PASS |
| Fresh server reads the same persisted telemetry | PASS |
| Pipeline timeline and stage status | PASS |
| Curated layers shown by default | PASS |
| Raw debug section, collapsed and lazy | PASS |
| Prompts collapsed, Copy available | PASS |
| Background card | PASS |
| Recursion card | PASS |
| Failure UX and unknown potential charge | PASS |
| Desktop / 390px responsive layout | PASS |

## Verification

- **Client:** 322/322 tests, 37 files.
- **Affected server:** 70/70 tests, 3 files (`runDiagnostics`, `layerizeExperiment`, `layerizeAccess`). Includes production-origin protection and fresh-server persistence.
- **Shared pricing:** 20/20 tests, 1 file.
- **Browser:** 9/9 distinct desktop offline journeys passed across the regression run (8 existing journeys passed) and the targeted dashboard rerun (1 passed). The initial new Copy assertion lacked browser clipboard permission; the fixture was corrected and the full dashboard journey reran successfully, including Copy, narrow layout, refresh, failure and unchanged fake-call counters.
- **Typecheck:** PASS.
- **Lint:** PASS.
- **Build:** PASS; existing bundle-size advisory remains.
- **git diff --check:** PASS.

**Paid development calls: OpenAI = 0 · fal = 0 · Seedream = 0 · GPT Image = 0.** Browser/server providers were injected fakes; browser fixture keys were blank and outbound fetch was blocked. Public pricing documentation reads were the only external research.

## Files changed for this dashboard continuation

| Area | Files |
|---|---|
| UI | `client/src/features/decomposition/LayerizeExperimentPanel.tsx`, `RunDashboard.tsx`, `runDashboard.css`, `layerizeExperiment.ts` |
| UI tests | `client/src/features/decomposition/RunDashboard.test.ts` |
| Shared pricing/types | `shared/src/aiPricing.ts`, `shared/src/aiPricing.test.ts`, `shared/src/index.ts` |
| Read-only server telemetry | `server/src/decomposition/runDiagnostics.ts`, `runDiagnostics.test.ts`, `layerizeRouter.ts`, `layerizeAccess.test.ts` |
| Offline browser/fixtures | `tests/fixtures/imageTemplateOfflineServer.ts`, `tests/e2e-image-templates/curation.spec.ts`, `protected-interactions.spec.ts`, `recursive-decomposition.spec.ts` |
| Documentation | `docs/AI_COST_TELEMETRY.md`, `docs/FRAMEFLOW_COSTING.md`, `docs/DASHBOARD_VALIDATION.md` |

Other pre-existing modifications remain in the tree.

## Known limitations

Historical missing/overwritten usage cannot produce complete costs; unknown amounts are disclosed. Source analysis is shared and attributed in full, so totals across variants/reruns are not unique account spend. Rates are a dated standard-pricing snapshot; taxes, infrastructure and invoice adjustments are excluded. Exact Seedream size-boundary pricing is conservatively estimated. Validation covered affected areas, not the entire repository suite. Final live provider and visual-quality evaluation remains the user's manual test.
