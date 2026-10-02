# Premium reference-inspired Diwali templates

This adds a separate six-family **Premium Reference-Inspired Diwali** gallery. The existing five definitions in `offerTemplates.ts`, their appearance, and the original curated gallery renderer are preserved. Dhanteras, Holi and Custom remain available. There is one existing editable canvas model, library and editor handoff.

## Design families and visual review

All six supplied images were visually inspected before implementation. Actual Chromium/Konva renders with loaded public fonts were reviewed alongside each reference at 1:1, 4:5, 3:4, 9:16 and 16:9. Reference posters are not shipped.

| Family / reference | Preserved visual language | Native content and image fitting | Deliberate differences |
| --- | --- | --- | --- |
| Jewellery Festive Offer / `D_OC_2.jpg` | Orange/gold warmth, large split discounts, central secondary festive hero, fine gold frame, location/footer zone | Independent offers and labels, headline/support/CTA/date/location/footer; logo and diya-hands hero contain | Photographic diya hands replace dancers/crowd; restrained decoration and original campaign copy; straight fine framing |
| Ecommerce Festival Sale / `D_OC_3.jpg` | Maroon, campaign-scale gold headline, clear start-date divider, product showcase, festive light | Headline/support/date/offer parts/CTA/footer; logo and product collection contain | Generic cosmetic collection instead of a branded multi-category shopping bag; no Amazon branding |
| Elegant Diwali Greeting / `D_OC_6.jpg` | Indigo, serif greeting, asymmetric quiet space, warm diya and subdued fireworks | Headline/support/optional offer/CTA/footer; logo and human/diya hero contain | Real hands replace the illustrated balcony/person; different type and original copy |
| Lantern Night Celebration / `D_OC_7.jpg` | Deep night, warm lantern focal point, crowd depth, luminous contrast and greeting | Headline/support/optional offer/CTA/footer; logo contain, hero cover | Real lantern-festival photo replaces illustration/billboard/skyline. Continuous colour/edge blending retains cover fit |
| Diwali Event Invite / `DIWALI_OC_(.jpg` | Plum/magenta, illuminated architecture on both sides, centered invitation/date/time, lower venue details | Separate headline/support/offer/CTA/date/time/dress-code/location/footer, logo contain; scene contain and architecture cover | Real historic facade details replace the imagined street; serif headline, quieter lighting, original sample details |
| Product Gift Campaign / `Diwali_oc_1.jpg` | Amber/brown, product emphasis, patterned gift box, lamps/floral surface and restrained serif copy | Headline/support/optional offer/CTA/footer, logo and product contain; gift box stays a separate decor layer | Closed gift stack and generic bottle replace the reference's open satin box and branded bottle; no POND'S content |

Reviewed fixes: smaller/repositioned hanging lamps clear logo/headline space; florals clear offers, CTA and copy; architecture reserves a central text zone; the single product cutout has no neighbouring fragment. The lantern source has edge feathering plus a separate night veil so cover cropping has no exposed rectangular seam. Low-opacity fireworks remain behind business content. Decorative safe zones have geometry regression coverage.

The layouts retain intentionally different focal points and typography. They are original editable interpretations, not replicas or a guarantee of photorealistic synthesis when arbitrary user images are substituted. Packaging, people and architecture within a photo are raster detail; each photo layer can be replaced, moved or removed, but its internal objects are not decomposed.

## Architecture and storage

- `premiumDefinitions.ts`: six local reusable `ThemeSpec` definitions; no provider/API request to select one.
- `premiumLayouts.ts`: authored normalized geometry from the canonical family for all five ratios. Portrait and landscape use different compositions. Ratio browsing selects stored layouts and never rescales the previous result.
- `premiumCompiler.ts`: existing `DesignTemplate` elements: native text, shape rules/gradients and separate photographic layers. All business copy stays native; empty optional fields remain editable and render when filled.
- `premiumAssets.ts` / `runtimeAssets.ts`: fixed same-origin assets, bounded fetch/validation, cached bytes and persistent editor-copy path. Full source/license details and byte manifest: [asset record](premium-diwali-assets.md).
- `ThemePanel` / `OfferPreview`: separate gallery; premium thumbnails are real reviewed canvas renders, loaded lazily without downloading six font families. Applying to a non-empty canvas requires the existing explicit replacement action and creates one Undo step.

Saved templates preserve family/spec metadata, five ratio layouts, native text, user image IDs, colours, fonts and geometry. User uploads and editor-owned copies use the existing IndexedDB repository; templates/creatives use the existing local library. Use Template applies creative overrides without changing the saved base. Open in editor converts all texts/layers through the existing adapter and copies static/uploaded image bytes; it does not flatten the poster.

## Fonts, copy and history

Defaults: Montserrat/Poppins for offer/ecommerce, DM Serif Display/Poppins for greeting, Cormorant Garamond/Poppins for lantern/gift, Cinzel/Poppins for event. The existing searchable font catalog and user overrides remain available in authoring and creative mode, including Hind/Devanagari choices and readable network-failure fallbacks.

Critical overflow covers headline, offers/labels (including the second offer), CTA, dates, times, location and dress code. It displays a correction message and blocks saving/opening the current layout rather than silently clipping. Authors still need to review every target ratio after long copy or geometry changes. Supporting text uses the existing warning behavior.

Apply is atomic. Existing history supports native text, font, colour, image replacement, deletion and ratio-specific geometry edits; ratio browsing alone adds no history. Neither Undo/Redo nor saving/reopening generates a planner request.

## Planner behavior

`ThemeSpec` retains existing archetypes and adds six bounded premium archetypes plus optional second-offer/time/dress-code plain strings. The planner can choose a family, fonts/palette, copy and slot flags. Premium archetypes use fixed family composition; the legacy alignment/placement/background/decor tokens do not dynamically regenerate photographic scenes. Authors can edit layout and decor afterward.

One accepted Generate action makes one planner request with SDK retries disabled. The response is validated, remains a draft and requires explicit Apply. Unknown fields, arbitrary URLs/HTML/code, invalid tokens/fonts/colours and oversized strings are rejected. Assets always come from the local allowlist; planner output cannot request external scene downloads. All development planner calls used fakes. No live OpenAI, fal or Seedream request was made.

## Verification

The focused browser suite verifies 30 rendered layouts, repeated ratio switching without drift, native copy/font/color edits, Hindi, tall/wide/square transparent images, real contain/cover crop geometry, designer save/reload, creative product/logo replacement, base isolation, decorative-layer retention and editor handoff. Additional tests exercise empty offers through history/reload, long critical copy correction, atomic Apply, font/image/geometry Undo/Redo and a single mocked planner request with explicit Apply.

Reproduce:

```sh
npm run build
THEME_VISUAL_FONTS=1 npx playwright test -c playwright.offline.config.ts tests/e2e/premium-diwali.spec.ts --project=desktop --output=test-results/premium-final
node scripts/build-premium-previews.mjs test-results/premium-final
```

The fixture blanks provider credentials and rejects server network fetches. Browser app APIs are aborted for curated tests; planner responses are explicitly fulfilled from fixtures. Public Google Fonts are allowed only for visual QA, with no paid calls.

QA renders/contact sheets are local, excluded from Git. Production thumbnails are intentionally included. Final regression results are recorded below.

## Final checks (2026-10-02)

- Focused template/font/history/persistence/planner unit suite: **198 passed**.
- Full unit suite (two workers): **1,071 passed, 3 failed**. All three match the previously recorded unchanged-main baseline at `3853b7195d7e57c5c174a2136e484bc36d33b6d8`; the same three also reproduced before this work in the Undo/Redo baseline. No decomposition source/test file was changed.
- Known baseline failures: `repository.test.ts` worker-lease reservation; `reviewFlow.test.ts` phase 4 versus expected 5; `router.test.ts` HTTP 503 versus expected 202. These are not premium-template regressions and the full unit suite is not claimed green.
- Public-font premium visual/workflow run: **10 passed**, including 30 default ratio screenshots/renders and six edited designs. The later added local-gallery check is included in the final full browser run.
- Final full offline browser regression: **293 passed (9.0 minutes)** across desktop, laptop and wide projects, including all 33 premium cases. Save/reload, Use Template, editor handoff, Undo/Redo, legacy curated themes and mocked image-template journeys passed with zero new regressions.
- Typecheck, lint, production build and diff whitespace check passed. The existing Vite large-chunk warning remains.
- Final asset audit: **22 production images, 1,908,105 bytes total**, including six thumbnails; largest individual file **303,642 bytes**. No duplicate asset hashes. Sources and production crops were visually inspected, with no supplied reference-poster assets.
- Browser comparison sheets: all six source references beside all five ratios. QA artifacts remain under ignored `test-results/premium-final` and the system temporary directory; only the intended gallery thumbnails are shipped.
- Visual acceptance: all six pass the reviewed composition, readable hierarchy, image fitting, layer separation and ratio checks. Original photographic substitutions and their differences are recorded in the family table; no claim of exact replication.
