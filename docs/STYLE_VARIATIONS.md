# Style variations of protected templates

New artwork for an existing protected template in other styles, with the template's **own words and logos placed on top by
FrameFlow** (never drawn by the image model), opened in the Konva editor as editable text and replaceable logo slots.

Workspace: **OpenAI + Seedream test → Protected Templates → a template → steps 6 and 7**.

```
analyse (local OCR, free) ─► review and correct words and logos ─► choose count, styles, typography
  ─► estimate (free) ─► explicit confirmation of the paid requests ─► one image request per AI variation
  ─► fit the artwork to the template canvas ─► local check for drawn text ─► place words and logos (variant coordinates)
  ─► validate (collisions, canvas, safe margin, overflow, contrast, protected text) ─► compare ─► adjust ─► save ─► editor
```

## What the image model receives

Only two pictures and a prompt (`server/src/templateStudio/variations/prompt.ts`, version `style-variation/1`):

1. the template's **approved text-free base** (step 2), resized to the provider size;
2. a **wordless guide**: grey, with white dashed boxes where the template's text lines and logos sit;
3. the preset's art direction, optional extra direction, the guide's meaning, a rule against drawing logos, names, numbers
   or legal text, and Template Studio's `NO_TEXT_RULE` last.

No copy, partner name or logo label is ever written into the prompt (asserted in the tests). The provider's own safety
checks apply unchanged; a refusal fails the variation and nothing is put in its place.

## Cost and confirmation

| Stage | Model | Cost |
| --- | --- | --- |
| Word and logo analysis | tesseract.js, on this server | free, done once per template |
| Seedream decomposition | not used | variations reuse the approved base; typography and logo changes never decompose |
| Artwork generation | `STUDIO_IMAGE_MODEL` (`gpt-image-2`) | one request per AI variation, upper-bound estimate from the rate card |
| Local restyle / reuse | sharp | free |
| Artwork text check, layout, validation | local | free |

`POST /protected/:templateId/variations` starts paid work only with `confirm: { paid: true, estimateMicroUsd }` naming the
exact current estimate (otherwise 400 `confirmation_required` or 409 `estimate_changed`, nothing started). Each AI variation
is its own job (`generate_style_variation`), idempotent by the variation, sent once through `imageCall` (budget hold, usage
ledger, per-job and daily limits; a server stop during the call marks it `outcome_unknown`, never re-sent). The request's
idempotency key returns the same variations on a repeat. Identical artwork (same base, guide, prompt, model, size, quality)
is reused from an earlier variation with no call and shown as such.

Provider size: the template's aspect inside the model's largest standard size, sides multiples of 16 (1820×2420 →
1024×1360), so the price is bounded by the published 1024×1536 price.

## Provenance

Every variation states where its artwork came from (`VariationProvenance`): `ai_generated` (new pixels from the image
model), `local_reuse` (the approved base unchanged), `local_restyle` (a fixed local colour treatment of the base), and
`reconstructed` (the decomposed original, used for the Original comparison). The editor document keeps it
(`DesignVariant.styleVariation`). There is no silent fallback to a copy.

## Presets and typography

`shared/src/styleVariations.ts`: four defaults (A original-inspired festive, B premium minimal, C modern fintech,
D creative promotional) and further presets; any slot can use a custom direction instead, and extra instructions apply to
every AI slot. Typography modes:

- **Match original**: the measured styles, in the original boxes.
- **Suggested for the style**: the preset's type pairing, picked **by rule** from the licensed catalogue (open-licensed Google
  Fonts) — no AI call, so it is free and repeatable; colours are kept unless they would be hard to read on the new artwork.
- **Custom**: fonts, weights and an optional colour chosen from the catalogue.

Typography never changes text. Protected words (claims, durations, partner names, legal) can be changed only with an
explicit administrator confirmation, recorded in the variation's history.

## Two coordinate systems

The template's word and logo boxes (`textAnalysis`) are the ORIGINAL coordinates; only an administrator's correction
changes them. Each variation has its own VARIANT layout (`VariantLayout`): typography changes reflow a line around its anchor
keeping the baseline; the editor or the adjust panel move words. Validation compares every pair of visible boxes; a variation
is called collision-free only after that check found none.

## API (`/api/template-studio`, Template Studio's access guard)

| Route | Purpose |
| --- | --- |
| `GET /variations/meta` | presets, defaults, typography modes, provenance labels, limits |
| `GET /protected/:templateId/variations` | readiness (base approved, words found and reviewed) and the variations |
| `POST /protected/:templateId/variations/estimate` | the estimate; nothing started |
| `POST /protected/:templateId/variations` | paid when the estimate lists paid requests: needs the confirmation above |
| `GET /variations/:id`, `PATCH /variations/:id/layout` | a variation; typography, word and logo changes (free, never new artwork) |
| `POST /variations/:id/review`, `POST /variations/:id/duplicate` | select / reject / save / reopen; a free copy (child) |

Records: `style-variations` and `style-variation-batches` collections in the Studio store (new files; older stores open
unchanged). Each variation records its parent template, base and analysis revision, its children, and a review history.

## Tests

- `shared/src/styleVariations.test.ts`: schema migration, reading order, roles, presets and fonts, typography modes, variant
  layouts, validation.
- `server/src/textRecognition/measure.test.ts`, `server/src/decomposition/protectedTemplates/words.test.ts`: measurements,
  logo tiles, analysis (Easy / EMI / available. as three words), corrections, re-analysis, logo replacement, migration.
- `server/src/templateStudio/variations/variations.test.ts`: the routes with a mocked image model: readiness, estimate and
  confirmation gates, four distinct prompts without copy, cached reuse, idempotency, typography without calls, protected
  text, collisions, refusal without fallback, drawn text, local restyles, budget limit.
- `client/src/features/protectedTemplates/variationDocument.test.ts`: the editor document, phrase tools, schema.
- `tests/e2e-image-templates/style-variations.spec.ts` (offline fixture): the whole journey to the editor.

## Limits (to validate live)

- Recognition and style are estimates: stylised display type, very small text and fonts the catalogue lacks need review.
- The local text check on generated artwork can miss stylised lettering; look at each variation.
- The real image model's adherence to the guide (calm reserved areas) and to the no-text rule is not guaranteed; nothing
  here has been run against the live model yet.
- Custom provider sizes such as 1024×1360 must be accepted by the live model; this was not checked with a paid call.
