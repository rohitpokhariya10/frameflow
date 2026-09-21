# Artwork generation

Milestone 5 implementation is complete. Automated provider and browser checks use
explicit mocks. **Live Gemini smoke test: BLOCKED — requires GEMINI_API_KEY.**
The environment and `server/.env` were checked on 2026-09-21; neither supplied a key.
No real request was made, and account/model access and image quality remain unverified.

## Server boundary and provider

The Express server owns `GEMINI_API_KEY`. The client has only the public
`VITE_API_BASE_URL` setting, defaulting to `/api`. `GET /api/health` returns
nonsecret `status` and `aiConfigured` flags (`aiAvailable` is retained for compatibility).
The AI panel disables Generate when configuration is absent and offers a connection
retry if the backend cannot be reached. Adding a key and restarting the server
activates generation; no mock or example replaces a failed request.

`POST /api/ai/generate` validates the shared application request. The service maps
aspect ratio, builds the artwork prompt, enforces timeout, and validates the returned
image. Only `server/src/providers/geminiProvider.ts` imports the Gemini SDK or knows
its request/response structure. Responses use the shared `ImageResponse` contract;
errors contain a safe code, message, retryable flag, and request ID.

The official [Gemini image-generation guide](https://ai.google.dev/gemini-api/docs/image-generation)
was reviewed on 2026-09-21. Installed SDK: **@google/genai 2.23.0**. Default configured
model: **gemini-3.1-flash-image**, overridable with `GEMINI_IMAGE_MODEL`. The adapter
uses `ai.interactions.create`, `input`, and `response_format` with inline JPEG,
`image_size: '1K'`, and the mapped `aspect_ratio`; it reads `output_image.data` and
`mime_type`. `store: false` disables stored interactions and SDK retries are disabled.
This surface is typechecked and contract-tested with a mock, not tested against a
live account. A text-only or empty image response fails explicitly.

## Artwork and wording

The backend builds instructions from the visual prompt, theme, palette, motifs,
mood, target ratio, and a normalized quiet rectangle. It requests calm, light,
low-detail space for dark editable text and asks for no wording, lettering, logos,
signatures, or visible watermarks. Model compliance still needs preview inspection.

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
There are no image manipulation controls or reference-image adaptation in this milestone.

## Bounds and failures

Requests have a 24 KiB JSON limit, 2,000-character visual prompt, bounded theme/style
fields, finite valid dimensions, and a contained normalized quiet region. Returned
PNG/JPEG/WebP data must have canonical base64, nonempty bytes, matching signature/MIME,
readable dimensions, at most 8 MiB, 16 million pixels, and 16,384 pixels per side.
Browser decoding adds the full image integrity check before storage or preview.

Each server process permits three requests per client IP per minute and two active
generations. The default timeout is 120 seconds, configurable from 1–180 seconds.
Client disconnection/timeout aborts the SDK request where supported; cancellation
cannot guarantee that provider processing or billing stops. There is no automatic
retry after ambiguous failures. The client has a longer 185-second deadline.

CORS applies to API routes and allows explicit local Vite (5173) and built-server
(3001) origins plus `CLIENT_ORIGIN`, without a wildcard or credentials. Static
module/font loading is unaffected. Request IDs are returned in a header and payload. Logs
contain only ID, duration, and outcome, never keys, image bytes, or full prompts.
Validation, missing configuration, authentication, quota/rate limiting, concurrency,
refusal, timeout, no-image, network, decode, and browser-storage failures preserve
the existing document. Rate limits are in-memory per instance, not a distributed
quota system; configure an account budget before publishing a public demo.

## Local setup and deployment preparation

Copy `server/.env.example` to ignored `server/.env`, supply `GEMINI_API_KEY` locally,
and run `npm run dev`. Never use a `VITE_` name for the secret. The frontend uses
Vite's `/api` proxy locally. No credentials are needed for ordinary editing or mocks.

Deployment architecture is Vercel frontend plus Render backend. Set the frontend's
`VITE_API_BASE_URL=https://<render-service>/api` at build time; set Render's exact
`CLIENT_ORIGIN=https://<vercel-app>`, server key/model/timeout, and proxy setting
`TRUST_PROXY_HOPS=1`. Keep proxy trust 0 for direct local access. Express respects
Render's `PORT` and listens on `0.0.0.0`. The existing built-client static fallback
is retained for production E2E checks. No deployment was performed in Milestone 5.

## Verification

Routine tests never use real API quota. Server tests inject a mocked provider and
mock the SDK mapping; browser tests intercept the API using a PNG drawn at runtime
by the test. That synthetic fixture is not a generated AI image or live evidence.
Tests cover preview-before-apply, exact wording, assets, layering, history, recovery,
missing configuration, failures, stale work, and cancellation alongside prior editor
regressions. Current command counts and visual-review results are recorded in
[IMPLEMENTATION_STATUS.md](../IMPLEMENTATION_STATUS.md).

A real smoke attempt ran on 2026-09-22 (Asia/Kolkata) using the requested ivory-floral
Indian-wedding visual prompt and 4:5 poster target. The ignored server configuration
contained a key; health reported `aiConfigured=true`, and the enabled AI panel made
exactly **one** unmocked request. SDK: `@google/genai` **2.23.0**; configured/requested
model: **gemini-3.1-flash-image**, through `ai.interactions.create`.

Result: HTTP **502**, safe code **PROVIDER_FAILURE**, request ID
`0cf29396-e25f-4e8e-817b-47f40fad2151` (server duration 765 ms). No image was returned,
so actual MIME, dimensions, decode, preview, storage, apply, and live recovery could
not be verified. The safe error does not establish the underlying provider cause.
No second request was made; no successful actual model response is claimed. Mocked
end-to-end verification remains separate from this failed live attempt. Resolving
the provider failure remains necessary before claiming live generation works.
Milestone 6 adaptation, export, and deployment are not implemented here.
