# AI format adaptation

Milestone 6 adds reference-based artwork recomposition and deterministic editable-text
layout. It extends the existing AI panel with **Adapt format**, creates a new variant,
and keeps the source design available. Canvas resizing remains a separate local action.

## Source → target boundary

1. Capture project ID, source variant ID/revision, editor history version, and variant
   selection version. Read the source artwork Blob from IndexedDB by its asset ID.
2. Fully decode the image in the browser. Accept the existing PNG/JPEG/WebP assets
   within the application's 8 MiB / 16-million-pixel limits. Draw an aspect-preserving,
   high-quality thumbnail onto a temporary canvas; never upscale or overwrite storage.
3. Encode that thumbnail as PNG with a maximum side of **511 pixels** and at most
   **2 MiB**. These are FrameFlow's conservative reference transport limits.
4. Send application intent to `POST /api/ai/adapt`: visual prompt, target dimensions,
   format, style brief, quiet region, source identifiers/dimensions, and the bounded
   reference PNG. No editable text elements, remote URLs, or filesystem paths are sent.
5. The backend validates the shared runtime contract, canonical base64, signature,
   actual dimensions, declared dimensions, and byte bounds. It composes reference-aware
   instructions and invokes the `AdaptImage` capability. Output uses `ImageResponse`.
   The prompt explicitly forbids reproducing or tracing source lettering; exact wording
   comes from FrameFlow TextElements while the reference preserves visual identity.
6. Independently copy and lay out every source TextElement. Fully decode/store returned
   artwork before publishing the composed preview. Apply adds one new variant.

The project retains its established handwritten shared runtime validation rather than
adding a new schema library. Adapt requests have a **3 MiB JSON limit**; generation
keeps its **24 KiB** limit. Both endpoints share the three-per-minute client rate limit,
two-active-request cap, timeout, abort handling, safe errors, and request IDs. No automatic
retry occurs. Image payloads, raw provider messages, credentials, and full prompts are
excluded from logs. The backend does not fetch client-supplied asset paths or URLs.

## Provider contract and current Cloudflare API

`GenerateImage` remains compatible with M5. `AdaptImage` requires prompt, ratio,
AbortSignal, target dimensions, and validated reference bytes. Both service operations
use the same timeout/output-validation pipeline. Only the Cloudflare adapter knows its
multipart shape. Gemini generation remains intact; Gemini adaptation returns the explicit
`ADAPT_UNAVAILABLE` error rather than pretending to use a reference.

Official documentation was checked on **2026-09-22**:

- [Klein 4B reference contract](https://developers.cloudflare.com/changelog/post/2026-01-15-flux-2-klein-4b-workers-ai/)
  documents binary multipart fields `input_image_0` through `input_image_3`, at most four
  references, and inputs smaller than 512×512. Its examples upload PNG files. It does not
  enumerate a complete format allowlist or reference byte cap; FrameFlow's PNG/2 MiB
  restriction is an application choice, not an invented provider limit.
- [Model response schema](https://developers.cloudflare.com/workers-ai/models/flux-2-klein-4b/)
  specifies base64 image output.

FrameFlow sends **one** PNG as `input_image_0`, plus `prompt`, `width`, and `height`, to
`POST https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/@cf/black-forest-labs/flux-2-klein-4b`.
Native FormData supplies the boundary. Bearer token/account ID stay server-side. The
adapter retains the same bounded JSON envelope handling and actual PNG/JPEG/WebP MIME
and dimension inspection as generation.

Cloudflare's documented output-side range is 256–1920. FrameFlow bounds its requests
near one megapixel, rounds to 16px, and keeps each side at least 256. Logical landscape
**1600×900** requests **1024×576** artwork. Returned dimensions are recorded separately.
The renderer uses uniform cover fitting and frame clipping; it never stretches artwork.

The prompt asks the model to preserve palette, decorative motifs, mood, lighting,
artistic treatment and visual identity while rearranging the composition. Landscape
weights decoration toward the left and reserves calm space on the right. It explicitly
asks for no names, dates, words, typography, logos or signatures, and rejects mere
stretching/cropping as the intended operation. Compliance remains subject to preview review.

## Exact text and deterministic target layout

Text never comes back from the model. `adaptText` copies every element, retaining its
ID (scoped to the variant), exact string including whitespace/newlines, role/type,
font family/weight, color, line height, and letter spacing. Geometry and font size adapt.
Apply additionally rejects removed/rewritten strings by ID as a document invariant.

| Target | App-controlled layout |
| --- | --- |
| Landscape | Separate semantic rows in the right-hand text region; left aligned |
| Poster / story | Centered vertical semantic stack with comfortable safe margins |
| Square | Compact centered semantic stack with perimeter room |
| Custom | Map normalized source positions/widths; fit/clamp within safe target bounds |

Preset typography scales by target/source short side to preserve hierarchy. Custom
scaling uses the smaller axis ratio. Repeated semantic roles receive separate ordered
subrows. Body/custom-role elements use normalized mapping even in preset formats.
The existing font-aware Auto Layout fits each box within its reserved region using
readable floors derived from the target canvas. Custom overlaps can move below an
earlier box when space permits. Residual overlaps, measurement failures, and impossible
fits remain explicit warnings; no element or character is silently removed.

## Preview, variants, stale results and history

The AI panel offers Generate and Adapt format. Adaptation chooses the active version
as source, a preset/custom target, and an optional visual continuity brief. Loading
supports Cancel. Errors, missing artwork, preprocessing/storage failures and quota
failures preserve the current document.

Source/Target comparison renders two read-only Konva stages, each independently fitted
at its natural logical aspect ratio and labelled with dimensions. It does not stretch
both into equal-shaped boxes. Existing applied variants also have a Compare versions
action and a version selector. Select a version and return to editing to alter its text.

Preview is transient AI state. It contains only serializable variant/context metadata;
Blobs, base64, decoded images and controllers stay outside Redux. The source document
and localStorage remain unchanged until **Use this version**. New artwork must already
be decoded and stored successfully in IndexedDB before the preview becomes ready.

Apply checks project identity, monotonic editor version, source revision/artwork, active
variant and monotonic selection version. Editing then undoing, or switching away then
back, cannot make stale previews valid. The UI labels stale results and disables Apply;
users can regenerate from the current version or discard. Request IDs reject older or
cancelled completions. Leaving the AI panel while pending aborts that request.

One `adaptedDesignApplied` action appends the new variant, preserving the source,
`sourceVariantId`, and generation `sourceAssetId`. The store selects the target without
creating a separate history operation. One Undo removes the application; Redo restores
the exact snapshot and target selection, making no provider call. Duplicate IDs,
rewritten/missing text, malformed metadata, and the 30-variant limit are rejected.

The unchanged v1 document schema already supports these relationships. localStorage
saves both variants and their asset IDs; IndexedDB retains both artwork Blobs. Reload
restores both versions and starts on the first variant with empty history, matching the
existing recovery policy. Switching does not mutate/save the document. Source artwork
is never overwritten. Applied/history assets are retained; discard/cancellation removes
only newly created preview assets. General orphan cleanup remains outside this milestone.

## Verification

Automated tests mock every provider operation. They cover multipart reference bytes,
request/reference limits, normalization/errors, timeout, exact text/layout, source
immutability, stale edits and selections, atomic history, backward-compatible persistence,
and complete browser comparison/apply/switch/reload flows at 1440×900 and 1366×768.

Final post-live checks passed: **310 unit/API tests across 22 files**, **86 development
browser tests**, **86 production browser tests**, typecheck, lint and build. Each browser
mode includes 14 adaptation checks and 22 existing generation checks at both desktop
sizes. See [implementation status](../IMPLEMENTATION_STATUS.md). The live harness is outside source
control, permits a single upstream reference request, blocks source generation/retries,
and compares the browser-prepared reference hash with the binary multipart field before
forwarding it. It reuses the real M5 artwork and its saved browser profile.

## Real app verification — 2026-09-22

**REAL-LIVE VERIFIED.** Exactly **one adaptation request**, **zero source-generation
requests**, and **zero retries** were made. Reused the M5 source already saved in the
isolated browser's IndexedDB: JPEG, 816×1024, 595,042 bytes, on a 1080×1350 poster.

| Item | Observed result |
| --- | --- |
| Provider / model | Cloudflare Workers AI / `@cf/black-forest-labs/flux-2-klein-4b` |
| HTTP | **200** |
| Logical target | **1600×900**, Landscape |
| Prepared reference | **407×511 PNG**, **425,225 bytes** |
| Upstream field | Binary **`input_image_0`**; reference SHA-256 matched the browser request |
| Provider target and actual output | **1024×576**, **image/jpeg**, **342,986 bytes** |
| Request ID | `5e5f132a-f0af-4cc0-b9ea-305e7e3fdc0e` |
| Upstream duration | 8,072 ms (single observed request; no latency promise) |

The real image decoded and stored successfully. Source/Target comparison rendered at
natural ratios; preview left the exact saved ProjectDocument unchanged. Apply created
and selected a new landscape variant. The original variant remained exactly equal,
and its source Blob's SHA-256 remained unchanged through preprocessing, Apply, and
reload. Target text IDs and every string matched the source:

- `Together with their families`
- `Aarav & Meera`
- `12 December 2026 · 7:00 PM`
- `The Grand Royal Wedding Palace, Connaught Place, New Delhi, India`

All text was placed on the right with retained hierarchy and remained editable. One
Undo restored the source-only document; Redo restored the exact two-variant document.
Both survived reload. Source/target switching and target text editing worked, and editing
the target did not alter the source. No history action caused another provider call.
History was tested before reload because history stacks intentionally do not persist.

Visual review at **1440×900** and **1366×768** found clear source/target labels, natural
ratios, visible dimensions, accessible Apply/Regenerate/Discard actions and usable version
selection. The landscape rearranges the ivory rose groups into a left-hand floral border
and redistributes the gold ornamentation along the edges; warm ivory/gold/sage colors,
soft lighting and the refined decorative treatment remain recognizable. This is a new
reference-conditioned composition, not a simple crop or stretched portrait. The result
is not pixel-identical. A gold sprig approaches the venue line, so users may still adjust
text placement after preview. No automatic text-layout warning was raised for this result.

Generated images, screenshots, reference bytes, browser profile and the one-shot transport
harness remain outside tracked source. The successful result was reused for all live
checks; it was not regenerated for aesthetic refinement.

## Limits

- Generative adaptation preserves theme/style best-effort, not pixel-identically.
- Artwork output dimensions can differ from the logical target. Uniform cover can crop.
- Exact editable text is preserved by FrameFlow; arbitrary/custom layouts may need manual adjustment.
- The model may put detail inside requested quiet regions or invent unwanted lettering;
  users must inspect preview. There is no automatic aesthetic retry.
- Reference thumbnails lose fine source detail. Only Cloudflare adaptation is implemented.
- Free allocation is bounded; provider availability and latency vary. Cancellation does
  not guarantee that remote processing/charging stops.
- One local project, at most 30 variants and 50 text elements per variant; browser storage
  can be cleared. History and selected-version preference are not persisted.
- Exact-size PNG export, desktop polish and same-origin Render deployment are implemented.
  See [Implementation status](../IMPLEMENTATION_STATUS.md) for current release verification.
