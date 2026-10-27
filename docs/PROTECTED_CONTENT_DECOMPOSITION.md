# Protected content decomposition

Bank and brand logos, promotional copy and legal text are kept **out of AI decomposition**. An administrator marks them on
the creative; only the remaining artwork is sent to **Seedream 5.0 Pro Layerize** (`bytedance/seedream/v5/pro/layerize`,
through fal). The protected content is restored deterministically from its own preserved pixels or original files, and can
be replaced later (a new bank logo, new offer copy) without decomposing again.

Workspace tab: **OpenAI + Seedream test → Protected Templates**. Runs, costs and diagnostics stay in Overview and Saved Runs.

```
source creative ─► mark protected regions (draw, exact pixels, kind, how each is kept) ─► review each ─► confirm
                ─► prepare the base (clean artwork │ Template Studio scene │ local fill, an estimate) ─► check ─► approve
                ─► preflight (local) ─► ONE Seedream request (explicit, cost shown) ─► layers validated
                ─► reconstruction: Seedream layers + protected visuals, measured against the source ─► approve
                ─► editor (Seedream layers under locked protected slots) ─► reuse: new logos/copy in the same slots
```

## Models: Seedream only

| Where | What runs | Evidence |
| --- | --- | --- |
| `layerizeExperiment.ts` `executeRun`, prompt source `protected` | No planner call; the administrator's optional instructions (or none: Seedream's automatic mode) go to Seedream as written | `promptSource.mode === 'protected'` branch; `createRun` refuses a protected run with refinement, a template execution or capture |
| `protectedTemplates/service.ts` `protectedRunDeps` | The only deps a protected run gets: planner refuses (`PLANNER_NOT_ALLOWED`), no background reconstructor (the OpenAI image edit), and the fal transport refuses any endpoint but Seedream's (`MODEL_NOT_ALLOWED`) | `protectedTemplates.test.ts`: planner and image-edit fakes never called; submits `=== [SEEDREAM_ENDPOINT]` |
| `qwenAlternative.ts` `createQwenRun`, `createRetryRun` | Refuse protected runs (409 `NOT_RETRYABLE`) | server test, and the dashboard shows neither "Try Qwen layers" nor "Retry extraction" (E2E) |
| Provider safety | `enable_safety_checker: true` is set by `buildProviderInput` for every Seedream request, unchanged | server test asserts it on the submitted input |

Everything else (masks, fills, checks, reconstruction, metrics) is local and deterministic (sharp and arrays).

## Canonical coordinates

**Source pixels**: the source image as decomposition sees it (EXIF orientation applied once at upload), origin top-left,
x right, y down. A region is its unrotated box (`x, y, width, height`, fractional allowed) plus `rotation` in degrees,
clockwise, about the box centre. `normalized` (fractions of the source size) is derived on every save. Seedream's canvas,
the editor canvas (the source size, scaled down only to the editor's 4096 px / 12 MP limits) and any export size are reached
through `shared/src/protectedContent.ts` (`mapBox`, `centreRotationToOrigin`, `protectedEditorCanvas`). The region editor
is an SVG whose viewBox is in source pixels and maps pointers through `getScreenCTM`, so zoom, CSS scaling, browser zoom
and device-pixel ratio never reach a stored coordinate.

## Protected elements

| Field | Meaning |
| --- | --- |
| `id` | `pe-` + 10 hex, stable for the template's life (editor slots and reuses refer to it) |
| `kind` | `logo`, `text`, `legal`, `other` |
| `box`, `normalized`, `zIndex` | geometry (above), order among protected elements (all above the decomposed artwork) |
| `representation` | `raster`: the region's own pixels (a visual copy, never called editable text); `source-asset`: an uploaded original file, stored byte for byte (sha256), fitted (contain) in the box; `native-text`: editable text the administrator typed |
| `mask` | `difference` (protected where the source differs from the base by ≥ threshold) or `opaque` (the whole region) |
| `text` | value exactly as typed, font family + fallback (the editor has Inter and Lora), size, weight, line height, letter spacing, alignment, colour |
| `raster` | the preserved pixels: the whole-pixel rectangle around the (rotated) region, never resampled, alpha outside a rotated region 0; tied to the base it was measured against (`basisSha256`, `maskKey`) |
| `locked`, `replaceable` | locked in the editor until unlocked; a reuse may replace it |
| `origin`, `review` | `admin` / `template-studio` / `saved-analysis`; every element must be reviewed by an administrator before the regions can be confirmed |

The decomposition never recognises text: an element's text is typed, or the element stays a visual copy. Word-level text
is a separate, optional step (below, and [STYLE_VARIATIONS.md](STYLE_VARIATIONS.md)) that runs a **local** recognizer only,
never in a Seedream run, and whose every result an administrator reviews.

## The base Seedream receives

| Method | Reliability | Notes |
| --- | --- | --- |
| Clean artwork upload | reliable if its checks pass | Same aspect ratio as the source (±0.5%). Checked: every protected region must differ from the source (else the content is still in it), and the rest must match (mean difference ≤ 10) |
| Template Studio scene | reliable if its checks pass | For an AI-generated poster: the studio's text-free scene, which never contained the copy or logo |
| Local fill | **always an estimate** | Each region continued from its surroundings: a plain field by a fitted surface, flat colours by continuing them (both "continued"), anything else by a smooth colour field that invents no detail ("estimated"). A region whose border crosses strongly different pixels (> 3%) is flagged: the box probably cuts through content. The administrator must accept the estimate explicitly |

The exact image proposed for Seedream is shown before approval, with the filled areas tinted (green continued, amber
estimated). A base is approved for the confirmed regions only; moving a region makes it stale.

## Preflight, the paid request, and repeats

`GET /protected-templates/:id/preflight` checks, locally: valid and reviewed elements, confirmed regions, an approved current
base (sha256 verified), Seedream's image limits (the same check every upload passes), every preserved asset present and
unchanged, and nothing of this template running. It shows the most Seedream can charge: up to 17 returned layers at
$0.03375 (output under 1536×1536) or $0.0675 per layer.

`POST /protected-templates/:id/decompose` (with `expectedRevision` and an idempotency key) creates and links the run, then
queues it behind any other decomposition; it counts as running from then on. The same key returns the same run. A second
decomposition of the same base needs `confirmRepeat`. After the provider's content check refused a base
(`partner_validation_failed`, or a safety rejection), **that exact base is never sent again** (409
`REPEAT_REQUIRES_CHANGE`): the base or the regions must change. A run that stopped after its request ID was saved is
resumed from that request (no new paid request). A run that never left the server is not an attempt.

## Reconstruction and approval

When the run finishes with usable layers (editor selection, every layer placed, Seedream's canvas with the source's aspect
ratio), the server composes Seedream's layers (mapped to the source size) and every protected visual in order, and compares
with the source pixel by pixel: overall and outside the protected regions (mean difference, share within tolerance 8), and
per element (its fully protected pixels exact, its largest and mean difference). A **duplicate** is suspected where
Seedream's own layers, under a removed element, look more like the source than like the base it was sent. Approval is
refused while anything blocks (missing or changed assets, a run of an older base, unusable layers) and needs explicit
acknowledgement of warnings and suspected duplicates.

## Editor and reuse

Open in editor builds one design (`protectedTemplateDocument`): Seedream's layers back to front, then every protected
element as a locked layer or text carrying `protectedSlot` (`templateId`, `elementId`, `kind`, `representation`); the
persisted document schema accepts it, so it survives save and reopen. Opening the approved template again returns to that
design. Replace image keeps the slot's box (fitted without distortion) and marks it "(replaced)"; a raster text with
recorded text can be made editable text in place; texts can be locked like layers. **Reuse** makes a new design with new
pictures or text in chosen slots, or slots hidden, reading only stored files: no decomposition, no AI call.

## Template Studio and reference reuse

Match Reference with nothing to change (`reference_reuse`) copies the template's original reference unchanged; no image is
generated. This is now stated in the generate form, on the poster, in the decomposition confirmation (which names the
raster text and logos it would send), and on the Overview's workflow card. **Protect text & logos** on a poster makes its
protected template: for an AI-generated poster from its own copy (native text with the studio's typography), logo lock-up
and exact products (original files), with the studio's text-free scene as a reliable base; for a reused reference from the
template's saved analysis (text and logo boxes as unreviewed suggestions), with a clean upload or a local fill as the base.

## API (`/api/layerize-experiment/protected-templates`, same access guard as the experiment)

| Route | Purpose |
| --- | --- |
| `GET /`, `POST /` (multipart), `POST /from-run` | list; create from an upload (optional `origin`); create from a saved run's image |
| `GET /:id`, `PATCH /:id` | the template with its derived status, problems, latest run and reconstruction; rename, layer instructions |
| `PUT /:id/elements`, `POST /:id/elements/:elementId/asset` | the element list (server-owned fields ignored); an element's original file |
| `POST /:id/confirm-regions` | every element valid and reviewed |
| `POST /:id/base` (multipart, `method`), `POST /:id/base/local-fill`, `POST /:id/base/approve` | prepare and approve the base |
| `GET /:id/preflight`, `POST /:id/decompose` | checks and cost; the paid request |
| `POST /:id/runs/:runId/resume`, `POST /:id/runs/:runId/reconstruct`, `POST /:id/approve` | resume from a saved request; reconstruct again; approve |
| `GET /:id/files/:name` | stored files only (names checked; `template.json` is never served) |
| `POST /:id/text-analysis`, `PUT /:id/text-analysis` | find the words and logo slots of the confirmed regions (local recognizer, free); the administrator's corrections (needs `expectedAnalysisRevision`) |
| `POST /:id/text-analysis/logos/:slotId/asset`, `DELETE …/asset` | a logo slot's replacement file, byte for byte; restore the source's pixels |

Every write names `expectedRevision`; a write from an older revision is refused (409 `STALE_REVISION`). Storage:
`artifacts/decomposition/protected-templates/<id>/` (atomic writes; files replaced by a newer version are removed).

## Tests

- `shared/src/protectedContent.test.ts`: coordinates (portrait, landscape, square, export sizes, rotation), validation.
- `server/src/decomposition/protectedTemplates/pixels.test.ts`: exact protected pixels, edge error (measured), rotated
  regions, local fill trust and box-edge detection, clean-base checks, reconstruction and duplicate detection, logo fit.
- `server/src/decomposition/protectedTemplates/protectedTemplates.test.ts`: the routes end to end with a fake fal: Seedream
  only, no planner or image edit, idempotency, repeat rules, refusal, queueing, resume, restart, stale writes, path checks.
- `client/src/features/protectedTemplates/*.test.ts`: region geometry, the editor document (positions at several sizes,
  slots, reuse), poster conversion.
- `tests/e2e-image-templates/protected-templates.spec.ts` (offline fixture): the administrator journey to export, reopen and
  reuse; a provider refusal; a reused reference protected with a local fill.

## Words and logo slots (schema 2)

`textAnalysis` (shared `protectedWords.ts`) holds every word found inside the confirmed regions and every logo slot. It is
written only by `POST /:id/text-analysis` and the administrator's corrections, never by a decomposition, and it is kept apart
from `elements`: analysing or correcting words never makes the regions, the base or an approval stale.

- Recognition: tesseract.js 6 with its English LSTM model read from `node_modules/@tesseract.js-data/eng` (no network, no
  cache written elsewhere), per region, as one block (PSM 6) and as sparse text (PSM 11), merged. Each word keeps the
  engine's box, tightened to its own ink; a box is never split into words or merged from several.
- Style is measured from the source pixels inside each box (colour, size from the ink height and the letters, weight from
  stroke width, italic from the sharpest shear, baseline and rotation from the engine's line), made consistent across a line,
  and the font is the closest catalogue family: every value is an estimate, marked `needs-review`.
- Claims, durations, partner names and legal text are guessed from the text and region kind and marked `protected`.
- Logo slots: a logo region is one slot; a grid of light logo cards in any region becomes one slot per card (and the cards'
  own text is not taken as words). A slot keeps the source's exact pixels; a replacement is stored byte for byte.
- Schema: records are read through `migrateProtectedTemplate` (1 → 2 adds nothing required); a newer schema is refused.

## Limits

- The decomposition has no recognition model. Word analysis is a separate local OCR step whose results are estimates an
  administrator reviews; it can miss stylised or very small text and misjudge fonts (the closest catalogue font is used).
- A local fill is an estimate wherever the background is not plain or flat; on textured or photographic backgrounds it is a
  smooth field without the texture. Clean artwork is the reliable path.
- Difference masks keep fully protected pixels exactly; anti-aliased edges are unmixed against the base (measured: logo
  ≤ 1, anti-aliased headline ≤ 11 levels of 255 over a clean base in the tests).
- Native text is typeset by the editor (Inter or Lora); a creative's own font is used only if the editor has it.
- Seedream's provider may refuse a prepared base; the refusal is shown as it came and nothing else is tried.
