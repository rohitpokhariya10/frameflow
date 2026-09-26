# Retry exhaustion investigation — 2026-09-26

The latest failed job with its explicit retry consumed is
`ba4e839e-946b-4852-8a59-fef484e87332` in
`server/data/decomposition-ui-demo/decomposition.sqlite`. Its first failure was
local proposal-review validation: the saved review approved eight non-background
targets against `maxObjects: 6`. One explicit retry replayed that unchanged review
and failed the same check. The configured single-retry limit then correctly
prevented another retry.

This is the 673 × 1009 pink “SUMMER CHASER” card (source
`0639f288-0826-4717-9a00-8a425103d9b2`), distinct from the orange woman-and-phone
poster used for the production UX replay.

## Evidence and first failure

All timestamps below are UTC on 2026-09-26; add 05:30 for Asia/Kolkata.

| Time | Event / revision | Evidence |
| --- | --- | --- |
| 10:17:29.002 | 668 / 1 | Job queued. |
| 10:19:46.447 | 695 / 11 | Seedream discovery finished; proposal review opened. No earlier error event exists for this job. |
| 10:22:45.054 | 696 / 12 | `save-proposals` accepted with `expectedRevision: 11`; review queued for processing. |
| 10:22:45.512 | 697 / 13 | Worker begins “Phase 4 of 6 — Processing.” |
| **10:22:45.525** | **698 / 14** | **FIRST failure: `TARGET_LIMIT`, “Keep the approved targets within the object limit.”** |
| 10:22:49.633 | 699 / 15 | One explicit `retry` event: “Retry queued.” |
| 10:22:50.048 | 700 / 16 | Worker begins phase 4 again. |
| 10:22:50.055 | 701 / 17 | Second `TARGET_LIMIT` failure from the same review. |

The stored submission has `approved: true` and `rejected: false` for
`target-1` through `target-8`, plus `target-background`. The background is excluded
by the server-owned base-target check; the remaining count is **8 > 6**.
`reviewRevision` remains 12; `proposalReviewApplied` is absent, confirming the
validation rejected the review before persisting the edited proposal targets.
The saved original targets remain unapproved.

The attempted stage is **phase 4, proposal-review application before source
segmentation**, specifically `applyProposalReview` in
[`proposalReview.ts`](../server/src/decomposition/phases/proposalReview.ts).
The persisted job and error events say `phase: 3` because that field records the
last completed phase; the dispatcher runs `job.phase + 1` in
[`pipeline.ts`](../server/src/decomposition/pipeline.ts).

## Classification and retry attempts

- **First failure: local pipeline/input validation.** The accepted review exceeded
  the target limit. Validation occurred after the API had queued the review, so a
  correctable selection problem became a failed job.
- **Exhaustion trigger: explicit/manual retry.** There is exactly one durable
  `retry` event and `data.attempt` is 1. The retry retained the invalid
  `reviewSubmission`, so it could not resolve the cause. The event records an
  explicit repository retry; it does not identify a human click versus an API
  caller.
- **Provider failure: no.** Discovery had already completed successfully.
- **Stale revision: no evidence.** Revision 11 was accepted, then revisions
  advanced normally. Neither failure is `STALE_REVISION` or `STALE_LEASE`.
- **Worker failure: no evidence.** Both executions reached the same named local
  validation. No worker-mode mismatch, timeout, or stale lease is recorded.

The attempt sequence is the initial phase-4 execution (`data.attempt: 0`), then
the single accepted explicit retry (`data.attempt: 1`). The current state is
`failed`, revision 17, with `RETRY_LIMIT` derived by
[`retryAvailability` / `retryJob`](../server/src/decomposition/repository.ts).
It is **not call-budget exhaustion**: `callsUsed: 1`, `maxCalls: 20`.
No limit was changed and the historical job was not retried or repaired during
this investigation.

Rejected HTTP retry requests are not persisted as job events, so the database
cannot establish how many additional clicks received HTTP 409 or their times.
The remaining phase-4 step has a stale `running` status because the failure path
persists the job error without marking that step failed. This is not evidence
of a second active worker; the error events and terminal job state establish
the outcome.

## Paid provider calls

**One historical paid-model inference was submitted and completed before the
first failure.** The durable request record is:

| Field | Value |
| --- | --- |
| Endpoint | `bytedance/seedream/v5/pro/layerize` |
| Provider request ID | `01a0dd38-6623-7893-a651-513cc80a83d8` |
| Local request ID | `8bb130b8-f679-4a0a-b6ac-704a834144c6` |
| Reserved | 10:17:34.891 UTC |
| Completed record updated | 10:19:19.927 UTC |
| Status | `COMPLETED` |
| Recorded requests for the job | 1 |
| Job call reservations | 1 |

There are no SAM, BiRefNet, Qwen fallback, or other provider requests for this
job, and no additional provider request on the retry. Stored discovery output
contains nine provider images: eight proposals plus the base. The request's
`attempts: 0` field counts provider lookup-error retries, not paid submissions
or explicit job retries. Actual billed currency is unavailable in local data;
no billing endpoint was queried.

## Method and replay source

Inspection used Python SQLite URI `mode=ro` with `PRAGMA query_only=ON`, reading
only `decomposition_jobs`, `job_events`, `decomposition_steps`,
`provider_requests`, `source_assets`, and artifact metadata. It also inspected
the local pipeline source and existing progress notes. No application repository
constructor, worker, provider API, provider media download, or job mutation was
used. **This investigation made zero new provider calls.**

The real-poster UX replay can read the existing cached discovery from the same
data directory using job `297f4268-5dad-4db2-8915-1e634609b937` (or owner-cache
copy `7afa2ec2-d14d-4c31-84bd-3cff18a954c6`). These are separate jobs. The original
poster request `01a0dcd5-8773-7da0-94c2-604dd84d0903` previously encountered a local
Seedream geometry/metadata normalization failure and was recovered without a
new submission, as documented in
[`DECOMPOSITION_PROGRESS.md`](DECOMPOSITION_PROGRESS.md). That recovered poster
job also has `attempt: 1`, but is now `needs_review`; it is not the latest failed
retry-exhausted job analyzed above.

An appropriate follow-up is to reject or explain over-limit review submissions
before they become worker failures and prevent over-limit save/approval in the
workspace. It does not require increasing the backend retry limit.

## Follow-up: new zero-call TARGET_LIMIT job

The subsequently reported failed job with **zero calls and its retry still
available** is `aff349e2-d51c-4cf2-b4f0-dd425894cee0` in the same database. This
is a separate job using the same pink-card source as `ba4e839e…`; it is not an
additional retry on the exhausted job.

| Time (UTC, 2026-09-26) | Event / revision | Evidence |
| --- | --- | --- |
| 10:32:23.149 | 702 / 1 | New job queued. |
| 10:32:26.894 | 712 / 11 | Discovery complete; proposal review opened with eight proposals and the base background. |
| 10:32:36.685 | 713 / 12 | First and only `save-proposals`, with current `expectedRevision: 11`, accepted. |
| 10:32:36.931 | 714 / 13 | Worker starts phase 4. |
| **10:32:36.943** | **715 / 14** | **FIRST and only failure: `TARGET_LIMIT`.** |

Its submission contains the original `target-1` through `target-8`, all
`approved: true`, `rejected: false`, `groupMode: single`, plus the server-owned
background. No target has `memberTargetIds` or `splitFromTargetId`; all original
names, proposal memberships, and discovered provenance are retained. Comparing
the submitted targets with the saved targets shows only approval being changed
to true and server classification being omitted from the submitted payload.
There are no new groups, splits, renamed targets, guidance edits, or replaced
target IDs in this submission.

This matches the workspace's ordinary **keep all discovered layers by default,
then Save for later** path: `ReviewStep.initialDraft` promotes undecided targets
to approved, and `send` omits classification. A particular click sequence is
not stored, so this is a source-and-payload inference rather than click telemetry.
There is **no evidence of a grouping bug or stale/replayed review state**. The
submission uses the current revision and this job's freshly created provenance;
the earlier job's renamed target and brush edits were not carried over.

The underlying failure is again **local phase-4 proposal-review validation**:
the existing backend counts every approved non-base target, including text and
shape targets, against `maxObjects: 6`; it does not count only targets routed to
image segmentation. Eight kept targets exceed that limit. The API accepted the
review, then the worker converted the validation error into a failed job before
any segmentation or edited-target persistence. `reviewRevision` is 12 and
`proposalReviewApplied` is absent. Neither provider failure, stale revision,
worker failure, nor manual retry caused this first failure.

There are **zero accepted retry events**, `data.attempt` defaults to 0, and
`callsUsed: 0 < maxCalls: 20`; the one permitted retry remains available under
the unchanged backend rules. Retrying the unchanged payload would encounter
the same validation.

There are **zero provider request rows for this new job**. Its saved Seedream
metadata explicitly records `cachedFromJobId:
ba4e839e-946b-4852-8a59-fef484e87332` and the earlier request ID
`01a0dd38-6623-7893-a651-513cc80a83d8`. Discovery reused an existing paid result;
it did not make a new paid call. The new investigation again used read-only
SQLite and local source inspection, with no provider access or job mutation.

## Existing draft-file audit

The following five files were already untracked before this UX work. An import
audit found no production dependency requiring them for the new workspace.
Recommendation: preserve them in the working tree and exclude them from the UX
commits; do not silently adopt or delete these earlier drafts.

| File | Finding | Recommendation |
| --- | --- | --- |
| `client/src/features/decomposition/ResultViewer.tsx` | No importer. The active workspace uses `ReadyStep` and scene import into the editor. Its ZIP link points at `/jobs/:id/download`, for which the current router has no route. | Leave untouched as a disconnected package-viewer draft. |
| `server/src/decomposition/packageResult.ts` | No importer. Calls `context.finish(10, ...)`, while the current dispatcher intentionally ends at phase 6. Has no direct tests. Contact-sheet construction also requires nonempty layers. | Leave untouched; adopting it would introduce a separate packaging feature beyond this checklist. |
| `server/src/decomposition/image/composite.ts` | Only imported by the unused `packageResult.ts`. Its generation/completed-alpha helpers have no callers. The similarly named helper in `extract.test.ts` is local to that test and does not test this file. | Leave untouched with its packaging draft. |
| `server/src/decomposition/image/masks.test.ts` | Four useful local mask tests, all passing; not required by the workspace changes. | Preserve; can be adopted in a separate test commit with appropriate scope. |
| `server/src/decomposition/router.test.ts` | Local-only auth/upload tests. Auth passes; upload/create expects 202 but receives 503 because the fixture never registers a fresh worker heartbeat. The current router requires that heartbeat before creating jobs. | Preserve as a draft; fix the fixture before adopting. Do not weaken production worker-readiness checks. |

Scoped ESLint passed for all five files. Server and client TypeScript checks
both passed with these files present. The focused offline Vitest run across
`image/masks.test.ts`, `router.test.ts`, and existing `repository.test.ts` passed
**12/14** tests. The second failure was the previously documented repository
lease test: it claims a **1 ms lease**, then creates a step and reserves a request;
the lease expires before that first reservation under normal scheduling. This
is unrelated to the explicit retry limit. The initial sandbox run could not bind
the router fixture's localhost port; the approved rerun resolved that restriction
and exposed the actual 503 assertion described above. All tests used temporary
data and no provider inference.

At audit time, `git diff HEAD` was empty for `repository.ts`, `router.ts`,
`worker.ts`, and `shared/src/decomposition.ts`. The backend still checks current
revision/state first, rejects `data.attempt >= 1` with HTTP 409 `RETRY_LIMIT`, then
checks call budget. An accepted retry increments `data.attempt`; it does not
reset it. The new browser coverage in `tests/e2e-decomposition/states.spec.ts`
asserts the actual retry route accepts the first retry, rejects a current-revision
second retry with `RETRY_LIMIT`, and rejects a stale-page request with
`STALE_REVISION`, then refreshes the page state. Its new-attempt action creates
a distinct job and verifies the original job's exhausted retry state remains
unchanged. This inspection establishes intended coverage; the parent task
reports the completed browser-run results separately.
