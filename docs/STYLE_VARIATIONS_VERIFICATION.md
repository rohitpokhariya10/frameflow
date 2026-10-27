# FrameFlow continuation verification — 20 October 2026

The existing implementation was recovered in place. Offline functional verification is complete. Live artwork quality and
font matching remain review tasks; this is not a production-readiness certification. No paid API calls, commits or pushes
were made.

**Final recommendation:** suitable for a controlled internship demonstration using the offline server, with mock
generation identified explicitly. No further implementation is required for that demonstration. Exact font matching,
final visual cleanup and optional paid-provider validation remain the limitations described below.

**1. Repository and preservation**

- Intended repository: the `FrameFlow-template-studio` worktree.
- Branch: `template-studio-main`; HEAD: `27d95757707343a5ccc1186556f0b1aa3923fd42`.
- This is an existing worktree of FrameFlow. No branch or worktree was switched, moved, reset or removed.
- `pineLabs-FD`: branch `spoc-screens`, HEAD `9e70da8`, clean working tree at the beginning and end. No feature files or
  feature-period application edits were found there. Earlier unrelated Pine Labs session activity is not attributed to
  this feature. Pine Labs was inspected read-only.
- Claude's actual session-start backup exists at `/tmp/frameflow-preserve.F4Ex7x`: HEAD, tracked patch and untracked tar.
  Its reconstructed baseline was verified against all three, including the 23 untracked source files (excluding macOS
  archive metadata). It has the reported **38 Git status entries**, including 30 modified tracked files.
- At this continuation's start, 86 modified/untracked files were hashed. All 86 remain; 80 are byte-identical and the six
  edited files are listed below. No earlier work was discarded. The real saved poster's 13 files were also verified
  unchanged after the isolated OCR/replacement check.
- Preservation evidence: `test-results/recovery/initial-sha256.json`, `initial-status.txt`, `file-inventory.txt`,
  `final-status.txt`. These are local ignored verification artifacts.

**2. Recovered implementation**

All requested modules contain code, including shared protected words, schema migration, variation layout/validation and
text fields; local Tesseract recognition, measurements and logo detection; protected-template analysis/correction and
asset routes; variation prompts, service, persistence, worker and existing budget/ledger integration; preview, typography,
word/logo review, editor import and phrase editing; and the listed unit/browser tests and documentation.

`tesseract.js` **6.0.1** and `@tesseract.js-data/eng` **1.0.0** are installed. The real poster was analyzed with the local
English LSTM data, with external fetch disabled. The browser fixtures inject fake providers and reject external fetch.

Claude's prior Playwright run had completed with one timeout, not merely been cancelled: its test searched for
“Compare and adjust” after the first comparison was already automatically open. No old Playwright/Vitest process was
active. Existing Vite/API development processes were preserved. The initial sandboxed full-suite attempt in this
continuation was interrupted and replaced by a completed localhost-enabled run; it is not counted as an application failure.

**3. Changes made during this continuation**

| File | Change |
| --- | --- |
| `server/src/templateStudio/variations/service.ts` | Serialize concurrent batch submissions with the same idempotency key across asynchronous planning/asset writes. |
| `server/src/templateStudio/variations/variations.test.ts` | Regression: three concurrent requests return one batch, with one mocked image call. Before the fix all three returned new batches. |
| `client/src/features/protectedTemplates/StyleVariations.tsx` | Reset comparison drafts when selecting another variation; describe collision checks as layout-box checks. |
| `client/src/features/protectedTemplates/VariationPreview.tsx` | Measure rendered font widths in the browser and display overflow and unavailable-font warnings without mutating geometry. |
| `tests/e2e-image-templates/style-variations.spec.ts` | Correct comparison-state assumptions; verify draft isolation, font/size/rotation edits, autosave/reload, reopening without duplicates and source preservation. |
| `tests/fixtures/imageTemplateOfflineServer.ts` | Optionally seed an isolated copy of the real saved template. |
| `tests/fixtures/prepareSavedVariation.ts` — new | Repeatable offline OCR, non-overlap assertions, ten-slot replacement verification, source-hash checks and annotated evidence. |
| `tests/e2e-image-templates/saved-style-variations.spec.ts` — new | Real-poster browser journey using actual OCR results and fake artwork generation. |
| This document — new | Results, limitations and exact reproduction steps. |

Generation and Seedream implementation logic was not refactored.

**4. Actual saved-poster word results**

Template: `pt-f02c645d8e82`, “Tent-Cards · reused reference”, Berkowits/Pine Labs, 1820 × 2420 pixels.
The real local OCR found 12 words in four phrase groups. These three have independent IDs, source boxes, styles and
group/line metadata:

| Word | Confidence | X | Y | Width | Height | Rotation |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Easy | 95% | 284 | 440 | 488 | 224 | 0° |
| EMI | 93% | 279 | 676 | 1244 | 578 | 0° |
| available. | 95% | 280 | 1291 | 620 | 102 | 0° |

Easy ends at Y=664; EMI starts at Y=676. EMI ends at Y=1254; available. starts at Y=1291. There is no headline-box overlap.
The annotated source was visually inspected. Small-copy OCR is still reviewable: for example, it reads “T&Cs apply”
without adding punctuation absent from its reading.

Evidence: `test-results/recovery/saved-poster-Chdx6n/analysis.json`, `verification.json`, `detected-boxes.png`.

**5. Bank-logo results**

**10/10 bank tiles**, plus the separate Berkowits and Pine Labs marks: **12 total logo slots**.
The ten cards occupy three columns over four rows (last row has one card), approximately 200 × 76 source pixels each.
Visual inspection confirms the boxes correspond to the actual cards, including the heavily filled logos that previously
escaped detection.

Every bank slot was replaced independently through the real protected-template service in a disposable copy. Each
replacement preserved exact uploaded bytes and the original crop; every other slot remained unchanged. The browser test
selects all ten slots individually, checks each replacement control, replaces one in Konva and verifies its persisted asset.

**6. AI pipeline verification**

The real routes, queue, worker stages, asset ingestion, estimates, confirmation gate, budget checks and usage ledger were
exercised with `FakeProvider`. Four directions produce four different prompts and four requests. The service tests cover
unconfirmed requests, changed estimates, budget limits, sequential and concurrent idempotency, cache reuse, refusal without
fallback, unwanted drawn text, protected-copy confirmation and free restyles. Existing runner tests cover interrupted paid
stages becoming `outcome_unknown` rather than being resent.

The model input path uses the approved base and a wordless layout guide, with protected copy/logos composed separately.
The fake provider's recolored output tests plumbing; it is **not evidence of genuinely different live AI artwork**.
No live OpenAI or Seedream image request was made.

Optional future live verification estimate from the repository's rate card `openai-standard-2026-10-10`, calculated on
this poster with no cache: OpenAI `gpt-image-2`, **4 images**, **medium**, **1024×1360**, **$0.731484 total** (UI: **$0.73 / ₹66**
at its configured FX), $0.182862 estimated per image. This is a planning estimate, not an invoice or authorization.
The API requires `confirm.paid: true` and `confirm.estimateMicroUsd: 731484`; a changed estimate must be reconfirmed.
The actual configured environment and cache must be re-estimated before any live call.

**7. Konva, persistence and visual limits**

- Real-poster output opened with 12 native editable word nodes, 12 independent logo images and one artwork layer.
- Font, size and rotation changes persisted through autosave/reload. Reopening the variation returned the existing design,
  with no duplicate import. The source template did not change.
- Phrase styling, movement, locking, adding/removing words and undo are covered by the editor tests.
- Source boxes can be accurate while the substituted catalogue font has different glyph widths. The real tenure text
  initially overflowed its source box; the preview now displays a browser-measured warning. The browser test reduces its
  size in the editor, verifies the actual Konva text no longer reaches “months”, and verifies persistence.
- Exact original fonts are estimates. External catalogue fonts fall back when unavailable, with a visible warning.
  Offline tests deliberately block those downloads. Low contrast on generated artwork still needs administrator review.
- The original approved local-fill base is an approximation. Its visual cleanup and any text unintentionally drawn by a
  live model must be reviewed; OCR cannot guarantee text-free artwork.
- Live design diversity, no-text adherence and acceptance of the custom provider size remain unverified.

Screenshots: `test-results/recovery/browser-verified/` contains editor/reopened evidence for desktop, laptop and wide.

**8. Completed verification**

| Check | Result |
| --- | --- |
| Shared/server/client TypeScript, plus tests | All passed; `typecheck-final.log` |
| Shared/client production build | Passed; existing large-chunk advisory remains |
| ESLint on changed/untracked TS/TSX | 82 files, 0 errors, 0 warnings |
| Focused schema/measurement/word/variation/editor suite | 42 passed, 0 failed |
| Full Vitest | **1,515 passed, 8 failed, 10 skipped**; 1,533 total |
| Full Vitest files | 140 passed, 3 failed, 1 skipped |
| Verified session-start baseline, three failing suites | 34 passed, **the same 8 failures**, 0 new failure names |
| Offline Playwright: protected templates + synthetic variations + real saved poster, three viewports | 15 passed, 0 failed |
| Final affected browser rerun after preview/comparison changes, three viewports | 6 passed, 0 failed |
| Whitespace/conflict-marker diff check | Passed |

The eight reproducible baseline failures are in:

- `generator-costs.test.ts`: six-product high-quality estimate versus the $1 cap.
- `pipeline.test.ts`: ordinary poster generation cost, drawn-text review, over-budget refusal, Match Reference defaults,
  Adapt/Explore wording, and unrelated-scene review (six tests).
- `router.test.ts`: expected cost-stage list.

They were left intact because they reproduce before this feature and changing the old generation behavior is outside
this continuation. Exact output: `vitest-final.json`, `vitest-final.log`, `vitest-baseline.json`, `vitest-baseline.log`,
`targeted.log`, `playwright-final.log`, `playwright-verified.log` under `test-results/recovery/`.

**9. Final Git state**

Branch remains `template-studio-main`; no staged changes, commit or push. There are **40 modified tracked files and
49 untracked files** after adding this report (Git collapses several untracked directories in normal status output).
The complete filenames and sizes are in the local `file-inventory.txt`; `final-status.txt` records the compact Git view.
Most of this state predates the continuation. Only the nine files listed in item 3 were changed or added here.

**10. Safe browser demonstration**

From the FrameFlow directory, use the offline server so that the UI's confirmation controls cannot call a paid provider:

```sh
npm run build -w @frameflow/shared
npm run build -w @frameflow/client
node --conditions=development --import tsx tests/fixtures/prepareSavedVariation.ts
```

The last command prints a fresh directory. Substitute it below:

```sh
FRAMEFLOW_SAVED_VARIATION_FIXTURE="<printed directory>" npm run demo:image-templates
```

Open `http://127.0.0.1:3317`, then:

1. **OpenAI + Seedream test → Protected Templates → Tent-Cards · reused reference → Open**.
2. Step 6 shows the copied poster's 12 words and 12 logo slots, already reviewed in this fixture. Select individual words
   and bank slots; the source in the normal development server remains untouched.
3. Step 7: choose four styles, inspect the estimate and confirm generation. On this offline server these are fake calls
   despite the production confirmation wording.
4. Compare variations; inspect font/overflow and artwork warnings. Change typography or a protected word, explicitly
   confirm a protected-copy change, then **Save variation → Open in editor**.
5. Use the **Text** tab for individual words and phrase tools. Use **Design layers → a logo → Replace image** for a bank.
   Unlock a layer if needed to move/resize it.
6. Wait for **Saved on this device**, reload, and open that variation again. The existing edited design reopens.

Reproduce the browser coverage:

```sh
FRAMEFLOW_SAVED_VARIATION_FIXTURE="<printed directory>" \
  npx playwright test -c playwright.offline.config.ts \
  tests/e2e-image-templates/style-variations.spec.ts \
  tests/e2e-image-templates/saved-style-variations.spec.ts \
  tests/e2e-image-templates/protected-templates.spec.ts --workers=1
```

Stop the manual offline server before running Playwright: Playwright starts its own server on port 3317. The existing
development servers need not be stopped.

**Final handoff check:** the implementation and saved verification evidence were rechecked after the follow-up request.
The 86-file preservation inventory still has all files, six intentionally edited and 80 byte-identical. No additional
application change was needed, so the full suite and browser runs were not repeated. Final file hashes are recorded in
`test-results/recovery/verified-source-sha256.json` for detecting later changes.

The offline demonstration was started at `http://127.0.0.1:3317`; health and the copied template route both returned
HTTP 200 (the template route requires the normal same-origin header). Its template has 12 words, 10 bank tiles and
12 total logo slots. No previous test process was running, and the existing Vite/API development servers were left running.
This URL is usable while the demo process remains active; use the command above to restart it later.
