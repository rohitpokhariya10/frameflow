# Qwen reproducibility investigation — 2026-09-26

Historical SQLite records prove that earlier live jobs omitted the Qwen seed. Fal returned
a different random seed for each invocation. Same-source jobs have identical original,
working-master, and actual analysis/provider-input hashes. No encoding, crop, resize,
orientation or source-selection difference was found within those groups.

The previous adapter sent `image_url`, `num_layers: 4`, `output_format: png`, and
`enable_safety_checker: true`. It omitted prompt, negative prompt, steps, guidance,
acceleration and seed. Provider defaults were therefore involved. The only observed change
in a recorded generation parameter was the returned seed; historical records cannot prove
that an automatically supplied caption or an unexposed model revision stayed identical.
The old normalizer discarded the returned prompt. Do not infer it from image contents.

## Historical comparison

Prefixes below identify local jobs and SHA-256 values; full hashes/request IDs and all four
output hashes are retained in the ignored local report
`artifacts/decomposition/qwen-reproducibility/historical-comparison.json`.
Every row has the same endpoint `fal-ai/qwen-image-layered` and four proposals.

| Job | Source SHA prefix | Actual Qwen input SHA prefix | Seed sent | Seed returned | First proposal SHA prefix |
| --- | --- | --- | --- | --- | --- |
| 55db0133 | 79004a685255 | f1e882e5d286 | omitted | 630264410 | 334da8ea4aab |
| d01dcdde | 79004a685255 | f1e882e5d286 | omitted | 2012330551 | bdab28b3a5d6 |
| e1424e92 | e954435cce63 | f98f180b8c7c | omitted | 1326645905 | 2ed8ec08248c |
| 8662bba7 | 7bbbc65d1d6b | f7276b0ab0e29 | omitted | 1083563488 | a1c2fcb252188 |
| e7fb976c | 7bbbc65d1d6b | f7276b0ab0e29 | omitted | 256174873 | f820cfeafddd |
| 9d5e91d1 | 7bbbc65d1d6b | f7276b0ab0e29 | omitted | 1553843769 | 484be3045aae |
| 744f6f83 | 7bbbc65d1d6b | f7276b0ab0e29 | omitted | 977127818 | cc15dffcf6af |
| 55eb0b0d | 3c1443bcdf77 | 0837403f6e7c | omitted | 275634882 | 63a8fbbeeb21 |
| 7b3b804b | 3c1443bcdf77 | 0837403f6e7c | omitted | 1365631058 | fb62aeb73658 |
| 2c802dfe | 3c1443bcdf77 | 0837403f6e7c | omitted | 1344302420 | 424505e44456 |
| 84905d7d | 3c1443bcdf77 | 0837403f6e7c | 2096359909 | 2096359909 | 5e13a0911bf6 |

For the poster, the complete provider-input hash is
`0837403f6e7c72c4ad4fe50c210a438e88a034de0fb4acd9a003b3492d1dd8d3`.
The input was 819×1024. Recomputed original → oriented sRGB master → analysis PNG twice
for each of the four distinct historical sources: every hash matched the persisted input.
The read-only verification report is `artifacts/decomposition/qwen-reproducibility/input-verification.json`.

Commit 89f14c0 introduced a stable seed derived from master SHA and job options. That run
is the last row above. Its defaults remained implicit and its cache was per job; this
follow-up fingerprints the effective wire request and enables reuse across owned jobs.

## Effective request and persistence

Verified [official Qwen API schema](https://fal.ai/models/fal-ai/qwen-image-layered/api):
caption `prompt`, negative prompt, steps, guidance, seed, layer count, acceleration, PNG/WebP,
and safety fields are supported. The output exposes the used seed and optional prompt.
Fal documents random seed generation when omitted and repeatability conditional on the same
seed, prompt and model version. No immutable model version is exposed here; record `unknown`.

The new adapter pins a neutral, nonempty caption:
`An image containing foreground elements and a background.`
It does not invent object labels or replace the user's SAM target. Empty captions are
rejected so an implicit caption path is not mistaken for a fixed effective prompt.
Negative prompt is empty, layers 4, steps 28, guidance 5, acceleration regular, PNG,
safety enabled, and synchronous media disabled. Whitespace trimming and NFC normalization
are applied before both hashing and submission. Explicit internal settings are validated.

A canonical, sorted SHA-256 identity includes original source SHA, actual uploaded-image
SHA, endpoint, adapter version, request-contract version, model version (`unknown`), and
every effective setting above. The default seed is deterministically mapped to [0, 2^31−1].
The final fingerprint also includes the actual seed. Transient URLs, job IDs, step keys,
and unrelated budgets/options cannot change identity. Material setting changes cannot hit
the same cache. `QWEN_REQUEST_VERSION` is an explicit invalidation boundary when adopting
changed defaults or a provider deployment change.

Before submission, save `job.data.qwenRequest`; after success save
`job.data.qwenInference` and the usual inference record. These preserve sent/returned seeds
separately, optional returned prompt, source/input hashes, effective parameters, request ID,
fingerprint, output hashes and decoded sizes. Durable provider records also preserve both
seeds. A missing/mismatched returned seed raises `QWEN_SEED_UNVERIFIED` and disallows shared
cache reuse. Legacy records are retained unchanged, without fabricating missing fields.
Sanitized `qwen_layered_request` / `qwen_layered_result` logs contain IDs, hashes, numerical
settings, counts, seeds and cache status, never signed URLs, image bodies or credentials.

Completed identical outputs can be reused within a job and between live jobs of the same
owner. Cross-job reuse checks fingerprint, matching returned seed, expiry, tombstone and
artifact hashes, then copies the files into the new job before checkpointing. Deleting the
old job cannot invalidate those copies. Mock/other-owner/legacy-unfingerprinted results
are ineligible. The existing single-active-job lease serializes this initial host profile.
Known current requests resume by saved step/request ID, even when a caller's step label
changes. An unfinished request with different settings blocks new submission with
`QWEN_REQUEST_CHANGED`; reconcile the saved request before changing its effective inputs.

## Verification and limits

Focused tests cover byte determinism, canonical request/seed identity, changes to
prompt/negative prompt/source/input/layers/steps/guidance/acceleration/seed, independent
seed persistence through queue restart, same-job and cross-job cache reuse, owner isolation,
expiry and copy independence. Source-semantic regression checks remain intact.
No extra paid reproducibility calls were necessary: historical evidence establishes the
missing-seed failure. Identical fresh Fal output hashes have **not** been live verified.
A deterministic request and cached output do not prove that an unversioned provider deployment
will reproduce pixel-identical results forever, or produce the intended semantic grouping.

Existing poster job `84905d7d-678f-40f1-b884-517e5e4c44d9` remains unchanged at Phase 5
needs_review after five total submissions. BiRefNet finished; native 1200×1500 ownership
covers 27.2997%, includes the visible woman and phone, and excludes poster panels/text.
Mask/alpha/overlay revision is `61197ed1-de60-48da-8031-a2100462e34e`. No guided retry.
Recover through AI → Decompose → Recover jobs → 84905d7d. Qwen remains proposal evidence;
SAM 3.1 owns semantics, BiRefNet handles constrained edges, and final RGB comes from the master.
