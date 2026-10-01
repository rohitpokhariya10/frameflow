# Offer creative themes and fonts

This feature extends **Create Own Template**, the existing Vite/React/Konva template studio. It does not use a generator, planner, decomposition provider, server endpoint, remote artwork, or another canvas/store. Google Fonts are the only new network resource, loaded when needed.

## Data and rendering

- `shared/src/designTemplates/themes.ts`: `OFFER_THEMES`, native starter builder, role-based typography, palettes, recommendations, safe areas, and atomic theme operations.
- `shared/src/designTemplates/responsive.ts`: selects normalized ratio geometry and isolates per-ratio edits.
- `TemplateAuthor` / `ThemePanel`: previews, safe apply choices, selection, existing layer inspector, native transforms and save.
- `CreativeEditor`: existing content overrides and ratio selector. It resolves the selected layout **before** applying creative geometry overrides.
- `resolveElements` / `TemplateCanvas`: existing renderer. No flattened offer copy or text-in-image assets.
- `creativeToVariant` / shared canvas editor adapter: native text, shapes and locally copied images enter the existing editor, retaining fonts, order and geometry. `variant.template.themeId` records provenance.

`themeId` on a template and `themeRole` / `ratioLayouts` on its elements are optional additions to the existing schema version 1. Geometry remains normalized. Old templates without these additions retain their single-layout behavior. Template-library restore supplies Inter when a legacy text's font family is missing; malformed data is otherwise still preserved in the library's rejected entries.

The existing versioned localStorage library handles save, edit, duplicate, rename, delete and creative pinning. Image bytes remain in the local asset store. There is no new history framework: applying a theme is one existing `onChange` action. Existing editor undo continues to work for edits made after handoff.

## Initial designs

| Theme | Palette and motifs | Typography | Starter hierarchy |
| --- | --- | --- | --- |
| Diwali | Burgundy, warm gold, cream, saffron; lights, diya, rangoli petals, product display | Yatra One / Poppins | Festive Special → Celebrate More, Save More → Up to 40% Off → Explore Offers |
| Dhanteras | Emerald, metallic gold, warm cream; engraved coin motifs, stacked coins, gold frame | Cinzel / Poppins | Dhanteras Special → Bring Home More This Dhanteras → Up to 30% Off → View Offers |
| Holi | Warm white, magenta, cyan, yellow, orange, purple; colour burst, confetti, overlapping colour shapes | Baloo 2 / Poppins | Holi Special → Color Your Cart With Savings → Flat 30% Off → Grab The Offer |

All include subheading, terms, replaceable logo/product slots and a background. Decorations are individually editable native shapes. There is no sacred imagery or downloaded artwork.

Semantic roles: `theme-background`, `theme-decoration-*`, `hero-stage`, `logo-slot`, `hero-image-slot`, `eyebrow`, `headline`, `subheading`, `offer-badge`, `offer-value`, `cta`, `terms`. Role metadata is template-owned; the standalone editor works with the already materialized native elements.

## Applying and resetting themes

- Empty template: choosing a theme creates the complete starter.
- Non-empty template: explicit **Apply styling only**, **Replace with [theme] starter**, or **Cancel**. The replacement button warns that the current canvas is removed.
- Styling keeps content, assets, IDs and edited ratio geometry of semantic content layers. It changes the palette/type tokens of matching theme roles and replaces old theme-owned decoration. Unrelated custom elements are left alone. Styling a custom composition therefore adds motifs; it does not guess which user text should become a headline.
- Selecting the active theme is a no-op. Repeated theme changes do not accumulate decorations. The existing 50-element limit is enforced before replacing the draft.
- **Custom / No Theme** preserves all elements, text, assets and styles. It freezes the current preview's geometry as the new custom layout and removes theme ownership/adaptive layouts. This is intentionally not a blank/reset canvas action.
- **Apply theme font pairing** changes only semantic theme text. Individual font overrides remain until the user explicitly reapplies a pairing or another theme's styling.

## Five ratio layouts

| Ratio | Composition |
| --- | --- |
| 1:1 | Headline/offer left, product right |
| 4:5 | Broad headline above, offer and product below |
| 3:4 | Portrait composition with its own product height |
| 9:16 | Story composition: headline high, central product, wide offer, CTA in lower safe area |
| 16:9 | Copy/offer/CTA left, larger product area right |

Saving a themed template remembers the selected preview as its master/default ratio for new creatives. Existing custom templates keep their original preview-only behavior. The same text, images and fonts are shared across all ratios. Only geometry changes. Decorations retain physical proportions. Content bounds use six-percent side margins; the story protects nine-percent top/bottom zones. Authoring a themed element's geometry changes only that ratio. Creative overrides materialize **after** selecting the ratio, preventing the responsive resolver from overwriting an allowed drag.

Logo/product slots default to **contain**, retaining transparent product edges and wide/tall logos. Authors may still deliberately select cover using the existing inspector.

Text uses existing Konva measurement and shared wrap/shrink rules. Font completion triggers remeasurement without changing stored copy, position or box size. Headline, offer and CTA overflow shows an explicit correction prompt instead of an ellipsis; saving the current authoring layout/opening a creative in the editor is blocked until corrected. Lower-priority text retains the existing warning/ellipsis behavior. Extremely long text cannot always fit a finite box at a readable minimum size: shorten it or resize the box. The standalone editor keeps its existing fixed-box overflow rules.

## Google Fonts

`shared/src/fonts/googleFontsCatalog.ts` bundles **metadata only**, a versioned snapshot of 1,950 families from [Google Fonts' public metadata](https://fonts.google.com/metadata/fonts). It includes family, category, actual available weights, italic availability and verified Devanagari subset presence. No API key is required. Refresh explicitly with `python3 scripts/update-font-catalog.py`, then review the metadata diff and rerun catalog tests. The runtime never fetches the catalog.

`catalog.ts` provides case-insensitive, whitespace-trimmed substring search and lookup. Font-picker results use the interface font and display at most 40 results; refining a search reaches every family. Typing/searching does not request font files or rerender the canvas. Recommended headings and body lists come from theme registration data. The Devanagari badge reflects Google's actual subset metadata.

`client/src/features/fonts/fontLoader.ts` is the sole Google CSS URL builder. It requests [CSS2](https://developers.google.com/fonts/docs/css2) with `display=swap` for selected family/weight combinations, deduplicates pending/success/failed requests, and bounds concurrency to three. Each browser request has an eight-second timeout and checks `document.fonts.load`. Failed links are removed; successful stylesheets are cached for the application's lifetime so returning to a font needs no new request. Reloading the app retries previously failed fonts.

Only fonts required by visible text/exports are loaded. Bundled Inter/Lora keep their existing offline loading path. Nearest actual weight is fetched when a family does not supply the requested weight; the existing 400/600/700 editor controls and browser weight synthesis remain. Italic metadata is recorded but italic editing is not exposed because the existing text model has no italic property.

Hindi text uses the chosen script-capable family, or loads Noto Sans Devanagari as a fallback when needed. Latin serif/sans fallbacks remain readable when Google is unavailable. A failure preserves the chosen font name and shows a warning. Missing catalog families in templates fall back to Inter and retain their original saved name. Fonts are also reloaded for editor previews, export and text measurement.

## Adding a theme or recommendation

1. Add one `OfferTheme` entry to `OFFER_THEMES` with palette, text, font tokens, recommendations and all five role layouts. The panel builds its cards from this registry.
2. Reuse a local motif family or extend the native builder with a reusable shape motif. Keep shapes below the existing element cap, and keep critical roles within `THEME_SAFE_AREAS`.
3. Add optional extra palette colours to `extraColors`. Inspectors automatically show the swatches before generic colour controls.
4. Verify each recommended font with `catalogFont`; use the catalog's actual script metadata, never infer language support from a name.
5. Run definition/ratio tests and the browser journeys. Visually inspect square, story and landscape using actual fonts before shipping.

## Verification

- `shared/src/designTemplates/themes.test.ts`: all 15 theme/ratio safe areas, editable semantic content, valid definitions, switching without duplicates, preserved custom layers/assets/copy, ratio-local edits, creative handoff materialization, serialization, legacy default, duplicate, fonts and search.
- `client/src/features/fonts/fontLoader.test.ts`: actual-weight deduplication, bounded concurrency, rejection/synchronous failure recovery, caching and URL construction.
- Existing template/no-AI, library, editor adapter, persistence and regression tests continue to run.
- `tests/e2e/themes.spec.ts`: real UI journeys at 1366, 1440 and 1920 widths, font-search request checks, late/failed fonts, Hindi/mixed copy, transparent products, wide/tall logos, all ratios, save/reload, creative edits and native editor handoff. Application `/api/` routes are blocked in these journeys.

Commands:

```sh
npm test -- shared/src/designTemplates client/src/features/fonts client/src/features/templates
npm run typecheck
npm run lint
npm run build
npx playwright test -c playwright.offline.config.ts
# Visual review only: free Google Fonts instead of the offline font-face fixture.
THEME_VISUAL_FONTS=1 npx playwright test -c playwright.offline.config.ts tests/e2e/themes.spec.ts --project=wide --grep 'editable themed' --output=test-results/theme-visual
git diff --check
```

Offline browser tests inject a bundled font-face fixture and test failure behavior deterministically. The separate visual run uses real Google Fonts; no AI/generation request is permitted. Screenshots and test logs stay outside the commit.

Known limits: fonts need network availability on first use; unavailable fonts affect visual metrics; existing weight controls are 400/600/700 with no italic UI; no new undo in template authoring; custom reset freezes one layout; library/images remain browser-local; editor handoff is an independent design, not a live link back to its template. Catalog refresh is manual so deployed behavior is stable. Google font files are not prefetched for search results.

### Existing baseline failures

The complete unit suite was compared with a clean archive of main commit `3853b71`, with independently installed dependencies. The final main baseline has **932 passes / 3 failures**; the feature has **960 passes / the same 3 failures**. The failures are unchanged decomposition behavior:

- `server/src/decomposition/reviewFlow.test.ts`: phase 4 versus expected 5.
- `server/src/decomposition/router.test.ts`: HTTP 503 versus expected 202.
- `server/src/decomposition/repository.test.ts`: intermittent provider-request lease timing. This passed in another run of each tree and failed in the final runs of both.

None of these server files is changed by this feature. A mocked provider's `live` mode label in test output does not mean a real paid request occurred.

## Feature file manifest

The branch changes these 37 files. Test artifacts, screenshots and font binaries are excluded.

```text
client/src/features/canvas/TextElementNode.tsx
client/src/features/export/exportPng.ts
client/src/features/fonts/FontPicker.tsx
client/src/features/fonts/fontLoader.test.ts
client/src/features/fonts/fontLoader.ts
client/src/features/fonts/useFonts.ts
client/src/features/templates/CreativeEditor.tsx
client/src/features/templates/TemplateAuthor.tsx
client/src/features/templates/TemplateCanvas.tsx
client/src/features/templates/TemplateStudio.tsx
client/src/features/templates/ThemePanel.tsx
client/src/features/templates/templateText.ts
client/src/features/templates/templateUi.tsx
client/src/features/templates/templates.css
client/src/features/templates/toDesignVariant.ts
client/src/features/text/TextInspector.tsx
client/src/features/text/textGeometry.ts
client/src/lib/layout/measureText.ts
client/src/lib/persistence/schema.ts
docs/offer-creative-themes.md
playwright.offline.config.ts
scripts/update-font-catalog.py
shared/src/canvasElement.ts
shared/src/designTemplates/creative.ts
shared/src/designTemplates/library.ts
shared/src/designTemplates/noAi.test.ts
shared/src/designTemplates/resolve.ts
shared/src/designTemplates/responsive.ts
shared/src/designTemplates/schema.ts
shared/src/designTemplates/textFit.ts
shared/src/designTemplates/themes.test.ts
shared/src/designTemplates/themes.ts
shared/src/fonts/catalog.ts
shared/src/fonts/googleFontsCatalog.ts
shared/src/index.ts
shared/src/text.ts
tests/e2e/themes.spec.ts
```

## Visual review record

Opened and inspected the real-font screenshots for Diwali, Dhanteras and Holi at 1:1, 4:5, 9:16 and 16:9 (12 starter views), plus Hindi/mixed copy, transparent products, a wide logo and custom Hind typography. Also inspected full workspace captures at 1366, 1440 and 1920 widths. Final artifacts are written under the ignored `test-results/theme-visual-final/` directory.

Review fixes: preserve decorative proportions across ratios; wait for fonts before capture and remeasure canvas text after loading; change themed image slots to contain; reduce placeholder-label dominance; add restrained rangoli/engraved coin/colour-burst details; improve Holi text contrast; constrain the Dhanteras headline to a balanced two-line fit; keep legacy Inter/Lora names unchanged; remember the saved themed ratio for the SPOC's initial creative. Very long primary copy has an explicit correction state and retains its full editable source.

The public catalog metadata is about 107 KB uncompressed. A local Node check performed 1,000 substring searches over its 1,950 families in 34 ms; this is a local measurement, not a cross-device performance guarantee. Browser tests verify that searching requests no font files, and that failure/timeout removes the failed stylesheet without losing the selected font.
