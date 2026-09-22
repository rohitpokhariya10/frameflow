# Artwork generation

Milestone 5 supports two server-side image providers. The current environment selects
**Cloudflare Workers AI / @cf/black-forest-labs/flux-2-klein-4b**. The existing Gemini
adapter remains intact; its live generation is blocked by this project's zero daily
Free Tier quota. No automatic fallback occurs. Current live verification is recorded
in the [README](../README.md#real-ai-verification); historical Gemini failures are retained below.

## Cloudflare selection and request mapping

`AI_PROVIDER=cloudflare` selects `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, and
`CLOUDFLARE_IMAGE_MODEL` (default `@cf/black-forest-labs/flux-2-klein-4b`).
`AI_PROVIDER=gemini` selects the existing `GEMINI_API_KEY` and `GEMINI_IMAGE_MODEL`.
An omitted selector defaults to Gemini for compatibility; the environment example
and active local configuration explicitly select Cloudflare. Unknown providers fail
configuration validation. Only the selected provider's credentials affect readiness.
Credentials are never exposed by `/api/health`, which returns `provider`,
`aiConfigured`, and the compatibility `aiAvailable` flag.

```dotenv
AI_PROVIDER=cloudflare
CLOUDFLARE_ACCOUNT_ID=
CLOUDFLARE_API_TOKEN=
CLOUDFLARE_IMAGE_MODEL=@cf/black-forest-labs/flux-2-klein-4b
```

The common `GenerateImage` function receives composed prompt, requested ratio,
AbortSignal, and logical target dimensions. Cloudflare maps these to native Node
`fetch` and `FormData`: `POST /client/v4/accounts/{account}/ai/run/{model}` at the
fixed Cloudflare API origin, with bearer authentication and multipart `prompt`,
`width`, and `height`. Fetch generates the multipart boundary; no extra SDK is needed.
The shared timeout/cancellation logic remains authoritative and neither adapter retries.

The [official Klein 4B contract](https://developers.cloudflare.com/changelog/post/2026-01-15-flux-2-klein-4b-workers-ai/)
was checked on 2026-09-22. Width/height support 256–1920 pixels. FrameFlow bounds the
longest generation side to 1024, rounds to 16-pixel increments, and clamps the short
side to at least 256 to keep requests near one megapixel. A 1080×1350 poster requests
816×1024 artwork; the logical canvas remains exactly 1080×1350. Small ratio changes
and extreme custom formats use uniform cover and can crop. Actual returned dimensions
are always read from bytes and recorded separately; arbitrary exact output sizes
are not promised.

Cloudflare returns a JSON envelope with `success` and `result.image` base64. The
adapter bounds the streamed response, validates base64 shape, detects actual
PNG/JPEG/WebP MIME from bytes, then uses the same signature/dimension/size validator
and browser decode as Gemini. Provider metadata is optional for old documents but
new responses and saved designs include `generation.provider`. Preview, apply,
IndexedDB, persistence, and history continue using the same application contract.

Cloudflare HTTP errors and documented numeric error codes map to safe request,
auth/account, model, quota, timeout, and provider failures; bounded known codes and
HTTP status can appear in server logs. Raw envelopes, tokens, account identifiers,
image payloads, and provider messages do not reach logs or client errors. Missing
configuration cannot fall through to another provider. Invalid images never reach
preview/apply. Free generation uses the account's available allocation and is not
unlimited: see [Cloudflare errors and quota](https://developers.cloudflare.com/workers-ai/platform/errors/).

## Real Cloudflare verification — 2026-09-22

**VERIFIED through the actual FrameFlow UI and backend**, with exactly one live
Cloudflare generation request and no retries. Health reported `provider=cloudflare`
and `aiConfigured=true`; the AI panel was enabled. Requested the ivory-floral Indian
wedding prompt on a **1080×1350 / 4:5 poster**. The REST response was HTTP **200**,
model **@cf/black-forest-labs/flux-2-klein-4b**, actual **image/jpeg**, **816×1024**,
**595,042 bytes**, request ID `86468371-534a-4443-bdc6-c5d231f16bd8`.

The browser decoded the real bytes and matched their dimensions, stored a Blob in
IndexedDB, and rendered preview without changing the original saved document.
Use this design applied artwork below four exact editable text elements: eyebrow,
title, date, and venue. Save succeeded. One Undo restored the original design and
one Redo restored the generated design with the request count still one. Reload
restored artwork, text, provider metadata, and canvas dimensions. Selecting all four
text fields and editing/undoing the venue after reload confirmed editability.
History was tested before reload because the history stack is intentionally not persisted.

Screenshots were reviewed at **1440×900** (preview) and **1366×768** (restored inspector).
Ivory florals/gold ornamentation and the text hierarchy rendered correctly. The
lower-left flowers extend near the venue region, so users may still adjust text
placement after preview; the provider does not guarantee a perfectly empty text area.
Images/screenshots and the isolated browser profile remain outside tracked source.
Gemini's separate quota blocker is unchanged. This records the completed M5 pass;
the subsequent M6 adaptation is documented in [AI_ADAPTATION.md](AI_ADAPTATION.md).

## Milestone 6 reference support (now implemented)

Cloudflare was selected following the user's successful external smoke test, its
available free allocation, and documented reference-image editing support. The
model supports up to four binary references named `input_image_0` through
`input_image_3` in the same multipart request. **Each reference must be smaller
than 512×512**. M6 now prepares a PNG thumbnail below that bound, preserves the original asset,
and supplies it through the separate required-reference adaptation capability.
The current app can decode stored PNG/JPEG/WebP assets; references are normalized to PNG.
Reference processing, the adaptation endpoint, variants and comparison are documented
in [AI_ADAPTATION.md](AI_ADAPTATION.md), including the successful single real adaptation.
Gemini generation remains available; Gemini adaptation truthfully reports unavailable.

## Server boundary and provider

The Express server owns all provider credentials. The client has only the public
`VITE_API_BASE_URL` setting, defaulting to `/api`. `GET /api/health` returns
nonsecret `status`, `provider`, and `aiConfigured` flags (`aiAvailable` is retained for compatibility).
The AI panel disables Generate when configuration is absent and offers a connection
retry if the backend cannot be reached. Adding the selected credentials and restarting the server
activates generation; no mock or example replaces a failed request.

`POST /api/ai/generate` validates the shared application request. The service maps
aspect ratio, builds the artwork prompt, enforces timeout, and validates the returned
image. Only the provider adapter and its tests import the Gemini SDK or know
its request/response structure. Responses use the shared `ImageResponse` contract;
errors contain a safe code, message, retryable flag, and request ID.

The official [Gemini image-generation guide](https://ai.google.dev/gemini-api/docs/image-generation)
was rechecked on 2026-09-22. Installed SDK: **@google/genai 2.23.0**. Default configured
model: **gemini-3.1-flash-image**, overridable with `GEMINI_IMAGE_MODEL`. The adapter
uses `ai.interactions.create`, `input`, and `response_format` requesting JPEG,
`image_size: '1K'`, and the mapped `aspect_ratio`; it reads `output_image.data` and
`mime_type`. `store: false` disables stored interactions and SDK retries are disabled.
The image response is inline by default; do not explicitly set `delivery`. Although
the installed SDK accepts it, the live provider rejected that option. The current
guide's request examples omit it. Model metadata is accessible with the configured
key, but metadata access alone does not prove generation or editing entitlement.
A text-only or empty image response fails explicitly.

## Artwork and wording

The backend builds instructions from the visual prompt, theme, palette, motifs,
mood, target ratio, and a normalized quiet rectangle. It requests calm, light,
low-detail space for dark editable text. An authoritative artwork-only rule surrounds
the visual brief, excluding readable text, letters, names, dates, venue copy, logos,
signatures, typography and watermarks even if the brief requests lettering. Model
compliance still needs preview inspection. The AI panel labels the visual field
**Artwork direction** and opens **Exact event wording** by default; those optional
fields create editable text separately from the image.

Optional eyebrow/title/date/venue fields stay entirely in the client. Their exact
strings, including spacing and newlines, become ordinary `TextElement` values.
No fictional content is inserted. Portrait, square, and story use a centered stack;
landscape uses a left-aligned block in the right portion. Separate role regions
reuse the existing measured Auto Layout. If text cannot fit readably, its original
wording is preserved and the preview flags the role for manual adjustment.

## Preview, assets, and history

After a response, the runtime layer decodes base64 to a Blob, fully decodes the image
in the browser, verifies actual dimensions, and waits for the IndexedDB write to
finish. Only then does it create preview metadata. The current document and its
saved JSON are untouched. Use this design, Regenerate, and Discard are explicit.
Other editor tabs show the current document; returning to AI restores the preview
and its form content. A source-version guard rejects Apply after intervening edits
or history traversal. Cancellation ignores late responses and cleans unapplied assets.

Apply dispatches one document action containing exact canvas dimensions, background
asset ID, editable text, original visual prompt, style brief, and generation metadata.
One Undo restores the previous design; Redo restores the generated snapshot without
another provider request. A monotonic session version prevents stale acceptance even
if Undo returns to an earlier revision number.

The document, AI Redux state, history, and localStorage contain JSON and asset IDs
only. Blobs live in `frameflow-assets` IndexedDB. Runtime images stay in component
state; temporary object URLs are revoked after decoding. The M4 saver persists the
applied metadata naturally, after the Blob already exists. Reload decodes the asset
again and restores editable text and exact logical dimensions. Missing/corrupt assets
show an actionable message while retaining the text. Applied/history assets are
retained. Discarded, replaced, and cancelled previews are deleted when cleanup
succeeds; refreshing an unapplied preview can leave an orphan. General orphan
cleanup is outside scope.

## Dimensions and rendering

Logical canvas dimensions remain exact (256–4096 per side, at most 12 million pixels).
Provider image dimensions are recorded separately. Poster 1080×1350 maps to 4:5,
square to 1:1, landscape 1600×900 to 16:9, and story 1080×1920 to 9:16. Custom sizes
minimize the absolute log-ratio distance over the supported ratio list; ties use list
order. A provider resolution tier never changes the requested canvas dimensions.

The decoded image renders below text in a noninteractive, frame-clipped Konva layer.
Cover uses one uniform scale and centered focal point by default, so cropping can
occur but stretching cannot. Existing contain/focal-point metadata is also respected.
There are no image manipulation controls. Reference-image adaptation is a separate
M6 operation documented in [AI_ADAPTATION.md](AI_ADAPTATION.md).

## Bounds and failures

Requests have a 24 KiB JSON limit, 2,000-character visual prompt, bounded theme/style
fields, finite valid dimensions, and a contained normalized quiet region. Returned
PNG/JPEG/WebP data must have canonical base64, nonempty bytes, matching signature/MIME,
readable dimensions, at most 8 MiB, 16 million pixels, and 16,384 pixels per side.
Browser decoding adds the full image integrity check before storage or preview.

Each server process permits three requests per client IP per minute and two active
generations. The default timeout is 120 seconds, configurable from 1–180 seconds.
Client disconnection/timeout aborts the provider request where supported; cancellation
cannot guarantee that provider processing or billing stops. There is no automatic
retry after ambiguous failures. The client has a longer 185-second deadline.

CORS applies to API routes and allows explicit local Vite (5173) and built-server
(3001) origins plus `CLIENT_ORIGIN`, without a wildcard or credentials. Static
module/font loading is unaffected. Request IDs are returned in a header and payload. Logs
contain ID, duration, outcome, and allowlisted provider status/code/reason, never keys, image bytes, raw error messages, or full prompts.
Validation, missing configuration, authentication, quota/rate limiting, concurrency,
refusal, timeout, no-image, network, decode, and browser-storage failures preserve
the existing document. Rate limits are in-memory per instance, not a distributed
quota system; configure an account budget before publishing a public demo.

## Local setup and deployment preparation

Copy `server/.env.example` to ignored `server/.env`, configure the selected provider locally,
and run `npm run dev`. Never use a `VITE_` name for the secret. The frontend uses
Vite's `/api` proxy locally. No credentials are needed for ordinary editing or mocks.

Current production is a single Render Web Service at
https://frameflow-h7fa.onrender.com. Express serves the built Vite frontend and
`/api` on the same origin. Leave `VITE_API_BASE_URL` unset (the default is `/api`),
set `CLIENT_ORIGIN=https://frameflow-h7fa.onrender.com`, configure the selected
provider credentials/model/timeout, and use `TRUST_PROXY_HOPS=1`. Keep proxy trust
0 for direct local access. Express respects Render's `PORT` and listens on
`0.0.0.0`. The milestone evidence below is historical; current release verification
is recorded in [README](../README.md#verification-and-testing).

## Verification

Routine tests never use real API quota. Server tests mock provider factories,
SDK transport, and Cloudflare fetch; browser tests intercept the API using a PNG drawn at runtime
by the test. That synthetic fixture is not a generated AI image or live evidence.
Tests cover preview-before-apply, exact wording, assets, layering, history, recovery,
missing configuration, failures, stale work, and cancellation alongside prior editor
regressions. Current command counts and visual-review results are recorded in
[README](../README.md#verification-and-testing).

Final Cloudflare milestone regression: **273 unit/API tests across 18 files**, **72
development browser tests**, and **72 production browser tests** passed, including
22 AI browser checks per mode. Typecheck, lint, and build passed. Final review and
test completion made **zero additional live AI requests**; the successful request
documented above was preserved as the sole app-level Cloudflare live verification.

## Historical Gemini smoke test — 2026-09-22

A real Gemini smoke attempt ran on 2026-09-22 (Asia/Kolkata) using the requested ivory-floral
Indian-wedding visual prompt and 4:5 poster target. The ignored server configuration
contained a key; health reported `aiConfigured=true`, and the enabled AI panel made
exactly **one** unmocked request. SDK: `@google/genai` **2.23.0**; configured/requested
model: **gemini-3.1-flash-image**, through `ai.interactions.create`.

Result: HTTP **502**, safe code **PROVIDER_FAILURE**, request ID
`0cf29396-e25f-4e8e-817b-47f40fad2151` (server duration 765 ms). No image was returned,
so actual MIME, dimensions, decode, preview, storage, apply, and live recovery could
not be verified. The safe error does not establish the underlying provider cause.
No retry was made in that historical pass. Later explicitly authorized diagnostic
attempts are recorded below; none returned an image. Mocked end-to-end verification
remains separate from live verification.
Milestone 6 adaptation, export, and deployment are not implemented here.

## Historical Gemini provider diagnosis — 2026-09-22

- One read-only SDK `models.get` succeeded for `gemini-3.1-flash-image` (Nano Banana 2).
  The official image guide and Interactions overview document that model for both
  text-to-image and image editing through `ai.interactions.create`. No fallback
  model or API-surface migration was justified.
- One minimal real request used the same key/model/adapter, prompt “Minimal elegant
  floral wedding background, no text.” and ratio 1:1. Result after 628 ms:
  `BadRequestError`, HTTP/statusCode **400**, provider code **invalid_request**,
  message **Image delivery mode is not supported.** The nested cause was
  `CreateInteractionClientError` with the same message. No image was returned.
- This reproduces an **application request-configuration bug** in the old adapter,
  rather than evidence of a quota, key, or model-access failure. The first historical
  502 did not retain its raw exception, so its exact original provider response
  cannot be recovered retrospectively. The unchanged adapter's live reproduction
  establishes the rejected field.
- Removed `delivery: 'inline'`; retained the documented method, model setting,
  aspect ratio, JPEG MIME, 1K size, stateless behavior, and disabled retries.
- Error normalization now preserves upstream request/model/access/quota/network/
  timeout distinctions. HTTP 400/422 requests are nonretryable `PROVIDER_REQUEST`
  errors. HTTP 404 maps to `MODEL_UNAVAILABLE`; 401/403 remain a server configuration
  error. Fixed undefined `statusCode` masking valid `status`.
- Logs now include only bounded, allowlisted provider HTTP status, canonical code,
  and recognized reason when available. Raw messages, credentials, headers,
  arbitrary details, image bodies, and causes are excluded. Redacted local diagnostic
  text was used only to identify the concrete rejected option.
- Actual SDK transport tests assert request serialization without `delivery`, image
  response extraction from `steps`, and single-call 400 handling. Existing successful
  generation tests remain intact; no test was weakened to accept failure.

## Historical corrected Gemini live request — 2026-09-22

After explicit continuation authorization, exactly **one** corrected minimal request
ran through the same adapter, key, `@google/genai` **2.23.0**, and configured model
**gemini-3.1-flash-image**. Prompt: “Minimal elegant floral wedding background, no text.”
Ratio: **1:1**. API surface: **ai.interactions.create**. No automatic retry occurred.

Result after **882 ms**:

- SDK class: **RateLimitError**, with nested **CreateInteractionClientError**.
- Provider HTTP/statusCode: **429**.
- Provider code: **too_many_requests**.
- Safe provider message: **Rate limit exceeded for model gemini-3.1-flash-image
  (limit: 0 requests per day on Free Tier). Please upgrade your tier.**
- Normalized application error: **RATE_LIMIT / HTTP 429**. No image, MIME, or
  dimensions returned. The observed provider code is retained in safe diagnostics.

The unsupported-delivery rejection has been eliminated in the corrected attempt;
the current blocker is **external project tier/quota**, not a reason to switch models
or repeatedly retry. Metadata access does not confer generation quota. The project
owner must enable the appropriate billing/tier and confirm nonzero quota for this
model in AI Studio before another controlled verification. Google documents that
limits apply per project and that moving from Free to a paid tier requires billing:
[Gemini rate limits and tier setup](https://ai.google.dev/gemini-api/docs/rate-limits).
No billing or account configuration was changed by this pass.

The conditional full FrameFlow live request was **not run**, because minimal
success was required first. IndexedDB, preview, apply, exact editable text,
refresh, and Undo/Redo remain covered by mocks but are **not verified with a real
Gemini image**. This continuation used **1 minimal / 0 full** generation requests.
Across the earlier explicitly authorized passes, there were three generation
attempts in total: original generic 502, diagnostic 400, and corrected quota 429.

**Real Gemini generation is not VERIFIED. The current Cloudflare result is recorded separately above/in implementation status.**
