# Create from Reference Image

Open **Create Own Template → Create from Reference Image**. This merchant workflow uses an uploaded campaign's design language while allowing product, background and festival changes. The existing standalone **Create Template from Image** remains available with its original upload/analysis and ratio-selection behavior.

## Workflow

1. Upload PNG/JPEG/WebP (up to 25 MB). Uploading creates a draft; it does not analyze or generate.
2. Press **Analyze reference**. One structured analysis provides subject/collection classification, visual evidence, business zones and A/B/C decomposition-style detection. The panel shows readable evidence, not raw JSON. Re-analysis and failed-analysis retry are explicit actions.
3. Choose **What will stay** and edit **What will change**. Product, background, mood, festival, decorations, offer and CTA intentions build a prompt locally. Empty fields retain reference traits; explicit changes override preservation choices, which override detected values. General scenes remain usable without invented product/offer structure.
4. Expand **Advanced · Full editable prompt** to edit or copy the prompt. Typing switches to **Custom Prompt Mode**. Subsequent field changes do not overwrite it. **Rebuild from fields** explicitly replaces it, locally, after confirmation. The canonical editable limit remains 2,000 characters; the full request remains at most 3,000.
5. Optionally upload a replacement product image. The capability is shown only for models whose installed SDK contract supports multiple image-edit inputs. Each ratio receives `[original campaign, same replacement product]` in that order. Without it, each receives the original alone. Bytes, MIME, dimensions, EXIF orientation, transparency, size and actual decode are validated. Filename extension validation is scoped to the integrated uploads; standalone valid-byte compatibility is preserved.
6. **Generate 3 variants** submits three independent `images.edit` requests: 1:1 **1024×1024**, 4:5 **1216×1520**, 16:9 **1536×864**. No generated output conditions another output. Sources are hash-checked before each call. Duplicate submissions are refused. Source-specific request identities ignore late responses after replacement or session closure.
7. Successful cards survive partial failure. **Try again** retries only the failed ratio with the same sources, model and frozen prompt/instructions. No hidden retry occurs.
8. **Use Generated Set** attaches the server group ID to the current template as one undoable metadata action. Existing canvas elements and geometry remain intact. Return and **Save Template** to persist this association. **Undo/Redo** changes the link without regenerating.
9. Use **Decompose into layers** or **Decompose all** explicitly. These reuse the existing A/B/C planner, layerization, layer previews and **Open in editor** import. Generation never starts decomposition automatically.

## Code and persistence

- `ReferenceCreative.tsx`: integrated panel; mounted only after its entry button is clicked. `referenceDraft.ts`: local draft edits and request-identity guards.
- `shared/src/referenceCreative.ts`: bounded settings, versioned blueprint view, deterministic prompt builder and validation. `imageTemplateAnalysis.ts` extends the existing analysis with design evidence; there is no second analysis service.
- `POST /api/layerize-experiment/image-templates/draft`: deferred-analysis upload. Existing `/:id/prompt`, `/:id/generate`, variant retry/decomposition and editor endpoints are reused. `/:id/product-reference` stores/serves/removes the optional product image; `PATCH /:id` saves settings.
- `startImageTemplateGeneration` freezes analysis, choices, final prompt, ratio set, model, reference instruction and source hashes. The existing group keeps source assets, exact variant prompts, result assets and decomposition history. `generateVariant` sends one or two validated files to the existing provider adapter.
- Template library versions store `referenceSetId`; groups/assets remain on the existing server artifact volume. Draft edits also survive same-browser reload through bounded localStorage records, keyed by source and analysis revision. No image base64 is copied into template metadata or React state. Images use existing asset endpoints and editor IndexedDB import.
- Existing feature gates/access middleware apply. No client credentials or new arbitrary remote asset URLs are introduced. Analysis and fields are validated as plain bounded descriptions. Group restoration, template storage, native themes, fonts and history retain their existing architecture.

## Provider calls

| Action | Paid provider requests in normal live mode |
| --- | --- |
| Open, upload/replace source or product, choose a saved set | 0 |
| Analyze / explicit re-analysis / explicit analysis retry | 1 analysis |
| Edit fields, preserve choices or full prompt; rebuild | 0 |
| Generate all | 3 image edits |
| Duplicate Generate | 0 additional |
| Retry one failed ratio | 1 image edit |
| Save, reload, link, Undo/Redo, local curated/premium selection | 0 |
| Decompose one | 1 planner + 1 Seedream request (a refusal/failure can stop before Seedream) |
| Decompose all | Same per eligible generated image; already decomposed images are skipped |
| Open completed layers in editor | 0 |

## Verification and offline review

Run `npm run build`, then `npm run demo:image-templates` and open `http://127.0.0.1:3317`. This fixture reads no credentials, blocks outbound fetch and injects deterministic analysis/image/layer providers. Download its synthetic reference at `/__test__/offer-reference.png`; optional product fixture: `/__test__/reference.png`. The displayed cost notices describe production behavior; this fixture performs no paid work.

For a deterministic partial failure in this fixture, include `Portrait retry test` in the edited prompt: 4:5 fails once, then its explicit retry succeeds. Include `Slow phone` to delay image requests while testing replacement/closure. Add `?failAnalysis=1` to the synthetic reference URL to exercise an explicit analysis retry. These switches exist only in the offline fixture, not production.

Focused tests cover shared prompt/blueprint rules, local draft lifecycle, real request routes, original/product hashes, exact input order, full prompt budget, frozen retries, duplicate actions, partial failures and existing design-template regressions. `tests/e2e/reference-creatives.spec.ts` exercises five journeys at 1366/1440/1920 widths, including non-empty canvas preservation, association history, reload, decomposition/editor, source replacement and session closure with a delayed response. Existing browser suites cover native/curated/premium themes, fonts, A/B/C and standalone flows.

Final verification (2026-10-02): focused **187/187** (including **42** backend/request tests); full offline browser **308/308**; final rebuilt-bundle reference/standalone journeys **24/24** (15 integrated + 9 standalone); full unit **1,099 passed, 3 existing baseline failures** in `repository.test.ts` (worker lease), `reviewFlow.test.ts` (phase 4 vs 5), and `router.test.ts` (503 vs 202). Typecheck, lint, production build and diff whitespace checks passed. The existing bundle-size warning remains. Screenshots of forms, design details, prompt modes, results and partial failures were reviewed across 1366/1440/1920 widths. Verification used zero live OpenAI/fal/Seedream calls. Changes remain uncommitted on `main` for manual review.

## Limits

- Fake outputs prove wiring, request identity and UI behavior, **not live image fidelity or campaign coherence**. Product design, placement, logos and exact business text still require later authorized live review. The original and product references condition generation; pixel-exact preservation is not guaranteed.
- Generated text is raster. Decomposed image layers can move/resize independently, but words inside them are not native editable text. Add/correct exact offer, CTA, legal and contact text with native editor text layers.
- Small references trigger a non-blocking warning. Blur/compression confidence is not measured; no precision claim is made for poor evidence.
- Template links/draft edits are browser-local; generated groups require the existing persistent server artifact storage. Losing that volume leaves an unavailable link. This feature adds no cross-device synchronization or authentication system.
- A generated set's settings are frozen. To make another campaign, start a new reference draft. Changing the displayed A/B/C layer style affects future explicit decomposition, not the image-generation snapshot.

## Manual QA

- [ ] Open Create Own Template; add/edit a manual layer; confirm existing canvas works.
- [ ] Open Create from Reference, upload, then Analyze once; inspect detected style, zones and Keep controls.
- [ ] Change Product; upload an optional product image; change Background, Festival and Decorations; confirm guided updates without more analysis.
- [ ] Edit the full prompt; change a field; confirm custom text stays exact; rebuild explicitly.
- [ ] Generate; inspect 1:1, 4:5 (1216×1520), 16:9 and current canvas safety.
- [ ] Use Generated Set; Undo; Redo; Save Template; reload and reopen the linked campaign.
- [ ] With a fake partial failure, retry one ratio and verify other images stay intact.
- [ ] Replace a reference while generation is pending; confirm old callbacks cannot overwrite it; analyze/generate the new reference.
- [ ] Close/reopen during a pending request; confirm the new session is safe.
- [ ] Decompose one; decompose remaining images; preview layers; Open in editor and edit a layer.
- [ ] Verify standalone Create Template from Image, curated/premium templates, Dhanteras/Holi, fonts, Use Template and history.
- [ ] Check expected request counts. Use the offline fixture until live-provider testing is explicitly approved.
