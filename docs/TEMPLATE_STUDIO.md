# Template Studio

Template creation and image generation inside the **OpenAI + Seedream test** workspace, ported from the Generator
(Poster Studio) app. It replaces the earlier Create Template wizard as the way to make new templates and images.
FrameFlow's decomposition (Overview, Decompose/Test, Saved Runs, the Seedream pipeline, costs, Open in Editor) is
unchanged; a generated image reaches it through one adapter.

```
Reference posters ─► style analysis ─► Template (versioned style profile)
                                            │
Products, copy, brand kit, format, occasion, mode ─► product analysis ─► art direction ─► framing + layout guide
                                            │
                              reference-aware image prompt ─► gpt-image-2 (layout guide, style reference, products)
                                            │
                    exact copy + brand logo rendered as layers ─► AI review ─► Generated result (approve)
                                            │  adapter (text-free scene PNG → POST /api/layerize-experiment/runs)
                              FrameFlow decomposition (planner + Seedream + cleanup) ─► Overview ─► Open in Editor
                                            │  editor import adapter
                     decomposed layers + the copy as native text + the logo lock-up as an image layer
```

## Where the code is

| Part | Path |
| --- | --- |
| Server module (routes, store, jobs, pipeline) | `server/src/templateStudio/` |
| Generator code ported as is (contracts, prompts, framing, layout guide, image prompt, overlay, text renderer, rate card, estimates) | `server/src/templateStudio/{contracts,compose,costs}`, `prompts.ts` |
| Generation modes (FrameFlow addition) | `prompts.ts` (`FIDELITY_DIRECTION`, `artDirector`, `visualReviewer`), `compose/imagePrompt.ts`, `contracts/ai.ts` (`referenceMatchSchema`) |
| Exact product pixels (calls FrameFlow's `composeVariant`) | `server/src/templateStudio/exactProducts.ts` |
| Exact cutouts (calls FrameFlow's SAM-3 segmenter and `cutoutFiles`) | `server/src/templateStudio/jobs/kinds/makeCutout.ts` |
| Decomposition hand-off adapter | `server/src/templateStudio/handoff.ts`; browser half in `LayerizeExperimentPanel.tsx` (`decomposePoster`) |
| Editor import adapter (native text + logo) | `client/src/features/templateStudio/editorImport.ts` |
| UI | `client/src/features/templateStudio/` |
| Shared formats, copy fields, occasions, modes, API types | `shared/src/templateStudio.ts` |
| Bundled fonts (22 SIL OFL families) | `server/assets/template-studio/fonts/` |

Not ported on purpose: Generator's decomposition (`decomposeScene.ts`, fal Layerize/Bria eraser, layer fitting), its
Next.js app, Prisma and separate worker process. Persistence is FrameFlow-style JSON files (atomic writes) and the
worker runs inside the FrameFlow server, one job at a time.

## Data

Everything is stored under `artifacts/template-studio/` (git-ignored; change with `TEMPLATE_STUDIO_DIR`):
`db/*.json` (templates and style-profile versions, assets, brand kits, campaigns, jobs and stages, concept plans,
generation attempts, posters, reviews, usage ledger, budget reservations, decomposition links) and `files/` (originals,
normalised copies, analysis copies, thumbnails, generated scenes, layout guides). FrameFlow's decomposition data is not
touched.

## Generation modes

| Mode | Art director | Image prompt | Reviewer |
| --- | --- | --- | --- |
| **Match Reference** (default) | Must keep the reference's environment, backdrop, podiums and props, surface, camera, lighting, palette, spacing; only products (and an occasion) change | Reference is the "style and scene reference" to rebuild; a KEEP FROM THE STYLE REFERENCE section lists the measured backdrop, staging, background, lighting, palette and invariants | Compares with the template examples and scores a reference match; score 1–2 is a hard failure ("Needs review"), 3 a warning |
| Adapt Reference | Generator's own behaviour | Generator's own wording | Generator's own reviewer |
| Explore Creatives | Loose inspiration; may start from one of FrameFlow's 12 creative directions | Generator's "loose inspiration" wording | Generator's own reviewer |

A failure never switches modes and never regenerates by itself. Regenerate and Re-check are explicit, confirmed, paid actions.

**Exact product pixels** (optional, Advanced): the image model always redraws products. With this on, each product
must be a transparent cutout; FrameFlow's compositor places the cutout's own pixels where the layout puts the product,
removes the model's redrawn product around it and measures that every opaque pixel is unchanged. An opaque photo can be
cut out first with **Make exact cutout** (one SAM-3 mask request through fal, FrameFlow's segmenter; explicit and
paid).

## Costs

- **Before a run**: `POST /api/template-studio/costs/estimate` gives an upper bound per stage (template analysis is
  shown as already done; product analyses already made with the same name are cached), from the Generator rate card
  (`costs/rateCard.ts`, OpenAI standard prices checked 2026-10-10) with its stated assumptions and a 20% margin.
- **After a run**: every paid call writes a usage-ledger row. Cost is calculated from the usage the provider reported;
  when no usable usage came back, the reserved upper bound is shown and flagged ("estimate · provider charge
  unconfirmed"), never ₹0. fal reports no usage, so SAM-3 cutouts are always shown as estimates.
- **Rupees** use FrameFlow's one configured rate, `AI_BUDGET_USD_INR` (default ₹90/$, FrameFlow pricing 2026-10-07),
  the same one the decomposition dashboard uses. No live exchange rate is fetched.
- **Decomposition** cost is FrameFlow's own calculation, unchanged. For a run made from a generated image, Overview
  adds a workflow card: template analysis (one-time, kept apart), image generation, the decomposition total read from
  FrameFlow's diagnostics, and their sum with unknown parts flagged.
- **Limits**: `STUDIO_MAX_JOB_BUDGET_USD` (1), `STUDIO_MAX_TEMPLATE_BUDGET_USD` (1), `STUDIO_DAILY_BUDGET_USD` (5). Every
  paid call reserves its upper bound first and is refused past a limit.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPENAI_API_KEY` | – | Shared with FrameFlow; never sent to the browser |
| `STUDIO_ANALYSIS_MODEL`, `STUDIO_PLANNER_MODEL`, `STUDIO_REVIEW_MODEL` | `gpt-6-luna` | Generator's text models |
| `STUDIO_IMAGE_MODEL` | `gpt-image-2` | Scene model (`images.edit` with the layout guide, one style reference and the products) |
| `STUDIO_IMAGE_QUALITY` | `high` | Default quality (the form can lower it) |
| `STUDIO_TEXT_REASONING_EFFORT` | `low` | Reasoning effort for the text calls |
| `TEMPLATE_STUDIO_DIR` | `artifacts/template-studio` | Data folder |
| `AI_BUDGET_USD_INR` | 90 | Rupee display rate |
| `FAL_KEY`, `CREATIVE_CUTOUT_PROVIDER` | – , `sam3` | Only for Make exact cutout (and FrameFlow's own decomposition) |

The routes are mounted only with `LAYERIZE_EXPERIMENT=1`, behind the same access guard as the experiment.

The earlier Create Template wizard's code, API and saved executions are untouched. Its tab is hidden; a saved execution
still opens from Saved Runs, and the tab returns with `VITE_LEGACY_CREATIVE_TEMPLATES=1` (build) or localStorage
`frameflow.legacyCreativeTemplates=1`.

Brand kits can be created in the UI or imported with their logos:

```bash
npm run studio:import-brand-kit -- /absolute/path/to/brand.brand.json
```

## Restart and retry safety

Jobs resume after their last completed stage. A paid stage that was running when the server stopped (for example
`tsx watch` reloading) is marked `outcome_unknown` and the job fails; it is never re-sent. SDK retries are off. Job
creation takes an idempotency key, so double clicks return the same job.

## Tests

- `server/src/templateStudio/*.test.ts`: Generator's own suites (composition, costs, fonts, provider errors) and the
  pipeline, router and hand-off with a fake provider.
- `client/src/features/templateStudio/editorImport.test.ts`: the editor import, validated by the editor's schema.
- `tests/e2e-image-templates/template-studio.spec.ts`: the browser journey on the offline fixture (fake OpenAI, fake
  planner and Seedream): create a template → generate (Match) → review → approve → decompose → Overview → editor.

## Still owed live (paid; only with approval)

The pipeline has run only with fake providers in FrameFlow. The Generator's own live run (2026-10-10) covered template
analysis and a low-quality text-only poster. Still to see live: Match Reference on a real reference with products
(does gpt-image-2 keep the backdrop, podiums and camera), the reviewer's reference-match scores on real images, the
real cost of a high-quality 4:5 poster with products, and FrameFlow decomposition of a real generated scene.
