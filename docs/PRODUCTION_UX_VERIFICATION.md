# Production UX verification — 2026-09-26

The editor now has local image/vector thumbnails, canvas locks, drag and keyboard
layer ordering, and editable two-stop gradients. Layer selection survives undo;
the inspector and layer list scroll independently, leaving room for the launcher.
The left tools panel supports drag resize, 224–480 px bounds (further constrained
to leave room for the canvas), reload persistence, arrow/Shift-arrow/Home/End
keys, Escape cancellation, and a narrow-screen fallback.

Review uses the job's authoritative `options.maxObjects`, counting every kept
non-background layer, including text and shapes. The default backend limit is
six; the server-owned base background is excluded. The review shows the count,
blocks excess saves/approval, and prevents actions that would increase the count
past its limit. Combining/removing still works to reduce an oversized selection.
Names, types, guidance and keep/remove choices are retained.

The API validates counts before queueing. A current failed `TARGET_LIMIT`
proposal review may accept a valid correction through the review route; ownership,
revision, action, state and worker-fence checks remain enforced. This does not
change `retryJob`, consume its one explicit retry, or remove the existing
pipeline's final `TARGET_LIMIT` guard. Historical evidence jobs are left intact.

Browser coverage exercises actual retry/review API responses with an isolated
database and a deterministic fake worker: available retry, exhausted retry,
stale-page 409, a fresh attempt retaining the old job, empty/error states,
responsive stacking, count prevention, and correction of failed review choices.
The API has only a placeholder fal key; the worker refuses real keys and replaces
inference with local fixtures. No new paid provider calls are made.

## Reproduce

```sh
npx vitest run client/src
npm run typecheck
npm run lint
npm run build
CI=1 npx playwright test --workers=4 --output=artifacts/decomposition/editor-e2e
npx playwright test -c playwright.decomposition.config.ts --output=artifacts/decomposition/decomposition-e2e
PLAYWRIGHT_PRODUCTION=1 \
DECOMP_E2E_REPLAY_DIR="$PWD/server/data/decomposition-ui-demo" \
DECOMP_E2E_REPLAY_JOB=297f4268-5dad-4db2-8915-1e634609b937 \
DECOMP_E2E_SHOTS=artifacts/decomposition/real-poster \
npx playwright test -c playwright.decomposition.config.ts --output=artifacts/decomposition/real-poster-tests
git diff --check
```

The real-poster command requires the existing private cached artifacts. It reads
the donor SQLite database in read-only mode and verifies artifact hashes. It
replays cached Seedream discovery through the real local pipeline; later SAM and
BiRefNet outputs are test fakes. `PLAYWRIGHT_PRODUCTION=1` serves the built client
from the isolated API. It does not enable production authentication or a live
provider worker.

## Evidence and limits

Screenshots are local, ignored artifacts under `artifacts/decomposition/`;
private uploads and caches are not committed. The replay verifies UX and local
integration, not fresh provider quality or real segmentation accuracy. Text
conversion still uses an unverified suggestion rather than OCR, and editable
text remains above the raster/vector layer stack. Full editing is intended for
desktop; narrow screens keep the canvas and offer the responsive decomposition
workspace.

The two separate historical failures and paid-call evidence are documented in
[RETRY_EXHAUSTION_INVESTIGATION.md](RETRY_EXHAUSTION_INVESTIGATION.md). Unrelated
pre-existing packaging/router drafts and user data are excluded from these commits.
