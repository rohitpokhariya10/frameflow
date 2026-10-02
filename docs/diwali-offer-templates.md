# Editable Diwali offer creatives

## Product and architecture

The Diwali gallery contains five locally registered `OfferTemplateDefinition` entries in `shared/src/designTemplates/offerTemplates.ts`. A definition includes identity, festival, use case, description, and a bounded `ThemeSpec` with palette, fonts, default copy, composition and ornament tokens. `compileOfferTemplate` creates the existing `DesignTemplate` / `CanvasElement[]` model. Curated selection and AI planning share this compiler and the existing renderer, library, creative overrides and editor adapter. There is no second canvas model or generated poster background.

| Family | Use case and visual direction | Typography | Distinct composition |
| --- | --- | --- | --- |
| Diwali Mega Sale | Ecommerce/retail; purple, maroon, gold and cream; lantern, diya, fine rangoli and particles | Poppins, bold commercial offer | Large offer opposite product/pedestal; portrait campaign header and lower action |
| Luxury Gold Diwali | Premium retail, jewellery or fintech; charcoal/wine, muted gold, cream; inset frame, double arch, restrained lamp | Cinzel headline, DM Serif Display offer, Poppins body/CTA | Split editorial copy/product; centered product with offer beneath in portrait |
| Product Spotlight | Beauty, FMCG, electronics or D2C; ivory/saffron, warm brown; bokeh, petals, diya glow | DM Serif Display with Poppins | Large central product, restrained copy, low offer/action; product moves right in landscape |
| Festive Greeting | Brand greeting with an optional promotion; teal, gold, cream; rangoli, lantern and diya | Yatra One with Poppins | Expressive centered festival lettering, support message, separate offer and small hero slot |
| Event / Store Promo | Local merchant/store events; maroon, wine, saffron/gold; lantern and lamp | Baloo 2 with Poppins | Invitation headline, date/location panel, offer, hero and explicit visit CTA |

Every family supports 1:1, 4:5, 3:4, 9:16 and 16:9. Native roles include background, eyebrow, headline, subheadline/support copy, offer-prefix/value/suffix, CTA, terms, logo and product; event templates additionally have date/time and location. Authoring supports existing selection, movement, resize, rotation, fonts, colors, layer order, delete and adding custom elements. Creative mode respects the designer's editable-property permissions.

## Local assets and gallery

`diwaliAssets.ts` contains original small trusted SVG strings for diya, lantern, rangoli, particles/sparkles, bokeh and flower. No reference artwork, remote asset URL or business copy is embedded in them. `runtimeAssets` resolves only registered IDs to local SVG blobs; user images still use IndexedDB. These ornaments are independently movable/resizable/deletable image layers. Their internal vector strokes are not individually editable. Borders, product stages, framing and gradients are native shapes.

`OfferPreview` renders the actual curated element definitions as thumbnail SVGs, including local ornaments, colors and geometry. Thumbnail labels use the interface font so browsing does not download five sets of fonts. Applying a template requests only its selected public font faces when not already loaded. Curated loading itself makes **zero application API/provider calls**.

On an empty canvas selection applies immediately. On a non-empty canvas the designer must confirm **Replace canvas** or cancel. Reapplying replaces the element array, never appends motifs. The legacy Diwali, Dhanteras and Holi starters remain under **More festival starters** with their existing styling/replacement behavior.

## Structured AI planner

`AIThemePanel` sends one POST to `/api/themes/plan` only after **Generate Editable Theme**. Prompt length is 1–2,000 characters. Typing, choosing templates, editing, applying, switching ratios, saving, reopening and Use Template do not call this endpoint. A synchronous in-flight guard prevents duplicate submissions; the button is disabled during the request. Failed requests preserve prompt and current canvas. Retry is a new explicit click.

`server/src/themes/planner.ts` follows the existing injected Responses-client pattern and uses the shared `services/openAIClient.ts` factory, also reused by image-template analysis. It uses the existing `OPENAI_API_KEY` server-side, defaults to the repository's `gpt-5-mini` planner model and permits an explicit `OPENAI_THEME_MODEL` override. No secret reaches the browser. Responses use `store: false`, strict `text.format` JSON Schema, low reasoning effort and a bounded output budget. SDK construction and individual calls both set `maxRetries: 0`. No image generation, decomposition or fal/Seedream request is involved.

The route uses the application's origin policy/body limit, a three-per-minute/IP limit and two active requests maximum. SDK timeout is 60 seconds; route cancellation is 65 seconds and browser cancellation 70 seconds. Provider failures/refusals/incomplete responses produce a generic error, without returning raw provider diagnostics or logging prompts/keys. There is no automatic repair or retry request.

Structured response format follows [OpenAI's structured output documentation](https://developers.openai.com/api/docs/guides/structured-outputs). Live account/model availability and real planner output quality require the separately approved manual live test; development used fake clients exclusively.

## ThemeSpec and validation

`themeSpec.ts` owns the shared type, strict response schema and runtime parser:

- `templateName`, `style` (sale/premium/product/greeting/event).
- Four validated six-digit hex palette colors.
- Headline/offer/body/CTA font families, checked against the existing local catalog.
- Bounded plain copy: headline and CTA required; eyebrow, subheadline, offer parts, terms, date and location optional. Optional strings default to empty.
- A bounded layout archetype, hero position (left/right/center) and alignment (left/center).
- Background token, at most six supported decoration tokens (duplicates removed), optional logo/product/hero slot flags.

Layouts: OFFER_LEFT_PRODUCT_RIGHT, CENTERED_SALE, PRODUCT_CENTER, EDITORIAL_GREETING, EVENT_PROMO, SPLIT_LAYOUT. Left-product variants mirror local content geometry without reversing reading direction. Center requests use a centered composition where appropriate. Decorations: DIYA, LANTERN, RANGOLI_CORNER, SPARKLES, ARCH, GOLD_RING, BOKEH, FLOWER_ACCENT. Background treatments: SOLID, GRADIENT, RADIAL_GLOW, FESTIVE_PATTERN, DARK_PREMIUM. All tokens resolve to trusted local builders/assets.

Malformed JSON, missing required data, unknown keys/enums, invalid colors/fonts/slot types, oversized copy, executable markup and URL-like strings are rejected. Unicode, Hindi and emoji plain text are accepted. No model-produced code, HTML, SVG, CSS, arbitrary geometry or URL is rendered or executed. The route and client both validate; compilation also runs the existing template geometry/schema validation before Apply is offered.

Successful output stays a draft with its name and content summary. **Apply generated theme** is explicit, warns that the current canvas is replaced, and makes the result ordinary editable template state. Discarding a draft has no canvas effect. Multiple saved AI templates have separate template IDs/version histories and independent elements.

## Ratios, fitting and fonts

`offerLayout` authors geometry by composition and canvas class. Each element stores layouts for all five ratios; the original definition is the source for each layout. Ratio switching only selects stored geometry—no provider call, chaining, cumulative rescaling or mutation. Content, assets, fonts and colors stay shared. Ornament sizes use the canvas short edge to preserve their physical proportions. Authors can adjust an individual ratio using the existing geometry inspector.

Font fitting uses real Konva measurements and existing wrap/shrink/max-line rules. Empty optional text does not falsely trigger overflow. Headlines, offers, CTA, offer prefix/suffix, date and location show an explicit correction warning and block saving the current layout/editor handoff if they exceed readable limits. Supporting copy retains the existing warning behavior. A finite box cannot fit arbitrary text; shorten or enlarge it. Check all campaign ratios after major content changes.

The existing 1,950-family Google Font catalog, local search, script metadata, on-demand face loader, deduplication and timeout fallbacks are reused. Heading/body/offer recommendations are role-specific. Font Family is explicitly labeled; selecting a layer scrolls its properties into view. No font search downloads font files and no ratio switch resets user font choices. Hindi uses the chosen supported family or Noto Sans Devanagari fallback.

Logo and product slots default to contain, including transparent, tall, wide, square and tiny images. Cover remains an explicit existing inspector option. Missing slots remain replaceable; a designer can hide/delete a slot. Planner slot booleans can omit them entirely.

## Save, reuse and editor handoff

The existing versioned browser library stores `offerTemplate` metadata (source, definition ID, festival, schema version and normalized original ThemeSpec), elements, actual user-edited styles/assets/copy/geometry and the selected master ratio. The metadata is provenance; rendering uses the saved element state and never recompiles/regenerates it on reload. Metadata participates in template-version comparisons. Old templates without it need no migration.

Designer: choose curated design or generate/apply an AI draft → refine business content, brand images and fonts → select ratio → Save Template.

SPOC: Use Template → change allowed headline/offer/CTA/product/logo content → Save Creative → Open in editor. The creative stays pinned to an immutable template version, so it cannot mutate the base. Handoff copies local assets, including built-in SVG ornaments, into independently owned editor assets. Text, shapes, gradients and images remain separate editor layers. Export uses the existing editor workflow.

Library, asset storage and editor remain browser-local. Clearing browser storage removes user templates/assets. Handoff is an independent design, not a live template link. Authoring and derived creatives have session-only [undo/redo history](template-history.md). Google font first-use loading requires network, with readable fallbacks. Curated card thumbnails use interface typography. No mandatory generated background or arbitrary image-prompt canvas engine is included.

## Extending the gallery

Add one definition to `DIWALI_TEMPLATES` with original copy, palette/fonts and a bounded spec. Reuse a composition or extend `offerLayout` with an intentionally designed archetype; retain all five ratio layouts and existing element limits. Add original ornaments only to the trusted local registry. Validate every definition and review all ratio screenshots. For another festival, extend the festival metadata enum/validation and add its own registry/UI section while continuing to emit the same `DesignTemplate` model. Do not duplicate the canvas, storage or AI provider layer. Existing Dhanteras/Holi starters are unchanged by this iteration.

## Verification

All development provider calls: OpenAI **0**, fal **0**, Seedream **0**. Browser visual review may load public Google font CSS/files, which are not paid inference calls.

Commands:

```sh
npm test -- shared/src/designTemplates client/src/features/fonts client/src/features/templates server/src/themes
npm test -- --maxWorkers=2
npm run typecheck
npm run lint
npm run build
npx playwright test -c playwright.offline.config.ts
THEME_VISUAL_FONTS=1 npx playwright test -c playwright.offline.config.ts tests/e2e/diwali.spec.ts --project=wide
```

Automated coverage includes definitions, roles, schema rejection/normalization, all layouts/placements, fake Responses request counts, HTTP errors/origins, independent saved templates, creative isolation, contain fitting, repeated ratio cycles, actual font search/selection, failure/manual retry, draft Apply safety, persistence, SVG asset copying and editable editor handoff. Browser runs include 1366, 1440 and 1920 viewports, all five ratios, long/Hindi offers, event date/location text and image extremes. Existing browser suites cover Custom, Dhanteras/Holi/basic Diwali, fonts, editor, Template A/B/C and image-template workflows.

### Visual review and refinements

Reviewed all five curated campaigns at 1:1, 4:5, 9:16 and 16:9; 3:4 also has screenshots and geometry coverage. Additional review covers tall transparent product/wide logo replacements, Hindi and long offers, event copy/images, AI sale/premium drafts and workspace/inspector layouts at 1366/1440/1920.

Issues corrected during review: borders below the model's minimum geometry size; optional empty text incorrectly blocking Save; cramped product-offer suffix space; oversized sparkles competing with copy; diya overlapping the CTA edge; the landscape sale suffix sitting too far from the percentage; light event headline weight; duplicate palette swatches; font controls below the visible inspector area. Text fitting was extended to dates, locations and offer prefixes/suffixes. Legacy style-only switching now recognizes the new campaign's owned ornaments, preserving business content without accumulating decorations.

The local SVG registry totals about 13 KB of source strings. A local timing check compiled 500 curated templates in approximately 46 ms on the development machine (illustrative, not a device-independent performance guarantee). Preview components are memoized and do not request fonts while browsing.

### Final release checks

The full offline browser suite finished with **239 passed / 0 failed**. After the final landscape offer-suffix position adjustment, the Diwali browser suite was rerun with public fonts enabled across all three viewports: **24 passed / 0 failed**. The updated wide Mega Sale screenshot was also inspected directly. The full suite preceded that final geometry refinement; the targeted run verifies the final source.

Final typecheck, lint, production build and `git diff --check` passed. The build retains the existing large-chunk warning. The final source of `offerTemplates.ts` and `OfferPreview.tsx` was manually audited, including JSX, geometry overrides, conditional gradient definitions and definition-prefixed gradient IDs. No unrelated source changes were introduced by the last replacements.

Local review artifacts (excluded from Git): `test-results/diwali-reviewed/` contains the five-family visual review and additional copy/image/draft cases; `test-results/diwali-last-check/` contains the final 24-case run.

### Unit baseline comparison

An isolated archive of unchanged main `3853b7195d7e57c5c174a2136e484bc36d33b6d8`, with its own offline-installed dependencies, produced **932 passed / 3 failed**. The feature's final full unit run produced **1,006 passed / 2 failed**. The two remaining failures occur in both trees:

- `server/src/decomposition/reviewFlow.test.ts`: expected phase 5, received phase 4 (`SEMANTIC_OWNERSHIP_REVIEW`).
- `server/src/decomposition/router.test.ts`: expected HTTP 202, received 503.

The main run additionally reproduced the known `repository.test.ts` provider-request lease failure, which passed in the final feature run. An earlier unbounded feature run also hit the existing extraction test's five-second timeout during concurrent browser work; it passed with bounded workers. None of these unrelated implementation/test files was changed. All new theme-related unit tests pass; focused suite: **111 passed**.
