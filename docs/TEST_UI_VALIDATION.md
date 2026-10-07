# FrameFlow test UI redesign — validation

Validated 7 October 2026 on the existing `main` working tree. The four-tab implementation was continued in place.

| Acceptance check | Result |
|---|---|
| Overview / Create Template / Decompose/Test / Saved Runs navigation | PASS — mouse and keyboard, selected-tab semantics |
| Form state survives tab switches | PASS — creative draft, uploaded file, target layers, cleanup setting |
| Generated results | PASS — A/B/C forms, three ratios, accessible image links, retries, decomposition, old creative history |
| Saved runs | PASS — search, status filter, clear filters, empty states, reopen |
| Mobile / narrow layout | PASS — 390px tabs, forms, generated results, saved runs, dashboard; screenshots inspected |
| Dashboard / cost telemetry | PASS — recorded costs, failures, reopen/refresh, curated layers, debug tools and editor import |

Forms use separate cards; advanced settings, prompts and debug details start collapsed. Results use consistent image cards, and Overview puts image/layer previews before detailed accounting.

## Verification

- **Browser: 25/25 distinct affected desktop journeys passed**, including 390px checks within the journeys. The regression run passed 22; three stale reference-style tests were corrected and passed on a targeted rerun. No tests were skipped. Artifacts are in `test-results/redesign-regression/` and `test-results/redesign-legacy-fixes/`.
- **Unit/integration: 382/382 passed**, 42 files: client plus server diagnostics/access and shared pricing tests.
- **Typecheck, lint, production build, `git diff --check`: PASS.** The existing Vite bundle-size advisory remains.
- Validation fixes: accessible name for the template selector; constrain the generated-results grid so long history options cannot force horizontal overflow; update browser selectors for tabs/disclosures and the existing image-aware reference flow. Save-failure protection remains tested through Rename.
- Cost regression fixture still shows **Calculated ₹56.01**, **13 raw → 6 editor layers**, and **₹16.53 known + unknown** for a failed run. These are synthetic fixture usage/costs, not spending during validation.

## Files changed for the UI work

UI files under `client/src/features/decomposition/`:

- `LayerizeExperimentPanel.tsx`
- `ExperimentNavigation.tsx` (new)
- `experimentLab.css` (new)
- `TemplateGenerator.tsx`
- `RunDashboard.tsx`
- `runDashboard.css`

Tests:

- `client/src/features/decomposition/ExperimentNavigation.test.ts` (new)
- `tests/e2e/template-generators.spec.ts`
- `tests/e2e/image-templates.spec.ts`
- `tests/e2e-image-templates/workspace.spec.ts` (new)
- `tests/e2e-image-templates/curation.spec.ts`
- `tests/e2e-image-templates/journey.spec.ts`
- `tests/e2e-image-templates/open-in-editor.spec.ts`
- `tests/e2e-image-templates/protected-interactions.spec.ts`
- `tests/e2e-image-templates/recursive-decomposition.spec.ts`

Documentation: `docs/TEST_UI_VALIDATION.md` (this file).

The pre-existing curation, provider pipeline, cost telemetry and costing documents remain in the working tree. No server, shared pricing or provider behavior was changed for this UI redesign. `test__.png` was untouched.

**Paid calls: OpenAI = 0 · fal = 0 · Seedream = 0 · GPT Image = 0.** Tests used injected or browser-intercepted fakes with blank credentials; the offline server blocks outbound fetch.

**Committed: NO · Pushed: NO.** No reset, stash, restore or discard was used.
