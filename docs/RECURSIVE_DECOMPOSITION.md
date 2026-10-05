# Recursive decomposition and clean backgrounds (experiment)

Complex offer creatives come back from Seedream Layerize with a base layer that still holds products: copies of the ones
it extracted, and the ones it missed. Imported as is, the editor's background shows ghost products the moment a layer is
moved or hidden. The recursive refinement fixes that after the run's own decomposition, within hard limits.

Code: `server/src/decomposition/recursiveDecomposition.ts` (orchestration), `backgroundContamination.ts` (image checks),
`cleanBackground.ts` (the clean background). Tests: `recursiveDecomposition.test.ts`,
`tests/e2e-image-templates/recursive-decomposition.spec.ts` (fake providers only).

## When it runs

A run is refined only when it is created with the option; older runs and every other run are unchanged.

| Entry point | Refinement |
| --- | --- |
| Create Template from Image / reference creative: "Decompose into layers" | on |
| OpenAI + Seedream test panel | checkbox "Recursive cleanup + clean background", on by default (`recursive=true` form field) |
| Template A/B/C test generators, retries of unrefined runs, the API without `recursive` | off |
| CLI `decomp:layerize-experiment` | `--recursive` |

## Pipeline

1. **Pass 0**: the run's own planner call and Seedream call, rendered as before.
2. **Residual**: Seedream's base with every extracted layer's area (grown slightly) filled locally. This is "what pass 0 left behind".
3. **Assess** (`assessBackgroundContamination`): pixels outside the extracted layers that stand out from a smooth model of
   the background are grouped into regions. Size, solidity and contrast give each region a confidence. Scattered confetti,
   texture and noise stay below it, while products, pedestals and text blocks do not. No model call.
4. If it is contaminated, a **residual pass** sends the residual to Seedream with a fixed residual prompt (no planner call).
   New layers are screened. Rejected: fragments, background-like layers, layers mostly inside an area already extracted,
   and duplicates (mask IoU ≥ 0.5, ≥ 70% inside an existing layer, or overlapping boxes with a similar name). The earlier
   layer is always kept. More than 8 new layers: the smallest are grouped into one "Residual details" layer.
5. Repeat on the next residual, at most **2 residual passes** (`MAX_RESIDUAL_PASSES`). The residual after the last pass is
   assessed for the record and never sent.
6. **Order**: one back-to-front order for every layer. Within a pass Seedream's order holds. Where layers of different
   passes overlap, the one matching the original there is in front. Elsewhere the order is background, decoration,
   supports, secondary objects, products, then text. Pass number is never the z-order.
7. **Foreground union mask**: every foreground layer, grown by 0.8% of the canvas's shorter side and feathered over half
   that (`foreground-mask.png`). Scene layers (full-frame backgrounds, backdrop panels) are not removed.
8. **Clean background**: if Seedream's base still shows any extracted layer, ONE OpenAI image edit gets the original
   image, the mask (transparent = remove) and a short background-only instruction. The result is used only inside the
   feathered mask, at the canvas's resolution. Every other pixel is the original's, so passes never compound
   (no copy of a copy). If the base is already clean it is kept, with no call.
9. **Validate**: a removed product still visible where it was (≥ 25% of its distinctive pixels) or an object no layer holds
   makes the background `contaminated`. A failed or unavailable edit gives a local fill marked `fallback`, never "clean".

## Stop reasons

`clean`, `below-threshold`, `low-confidence`, `not-assessable`, `max-depth`, `no-new-layers`, `all-duplicates` (only
copies came back), `pass-failed` (earlier layers kept), `max-total-layers` (32), `resume-no-new-calls`.

## Calls (`run.calls`, refined runs)

Counted when sent, never retried by the orchestration:

| Case | Planner | Initial Seedream | Residual Seedream | Background edit |
| --- | --- | --- | --- | --- |
| Simple image, clean base | 1 | 1 | 0 | 0 |
| Clean of missed objects, base duplicates its layers | 1 | 1 | 0 | 1 |
| One residual pass | 1 | 1 | 1 | 1 |
| Maximum | 1 | 1 | 2 | 1 |

(+1 OpenAI call when `LAYERIZE_FIT_CHECK=1`.) Resume and "Re-render" reuse saved residual responses (by request ID) and
the saved edit (cache key: original + mask + size + prompt + model). They never send anything new.

## Outputs (run folder)

Existing: `layers.json` (additive `provenance`, `cleanBackground` and a `refinement` summary), `contact-sheet.png`
(original, background, pass-0 layers, each residual with its new and rejected layers, mask, reconstruction),
`reconstructed.png`. New: `clean-background.png`, `clean-background-ai.png`, `clean-background-mask.png` and
`clean-background-request/response.json`, `foreground-mask.png`, `residual-pass-N.png` / `residual-final.png`,
`pass-N-layer-NN.png`, `pass-N-seedream-request/response.json`, `decomposition-debug.json`.

Each layer's `provenance` records `sourcePass` (0 = initial, 1–2 = residual), `sourceImage`, `parentResidualId`,
`providerFile`, `providerRequestId`, `role`, `bbox` (canvas px) and `mask` (the file whose alpha is the mask).

## Known limitations

- **Shadows**: a product's shadow is removed with it only as far as its layer's alpha and the small mask growth reach.
  Broad environmental lighting stays in the background by design. Long cast shadows can remain.
- **Text** stays raster: text Seedream returns as layers is kept as layers, with no OCR or native text.
- **Scene layers** (backdrop panels, frames) stay in the clean background under their own layer.
- The contamination check is image-statistical: strong lighting effects or busy patterns can look object-like (bounded
  by the depth limit), and an object colored like its surroundings can be missed.
- The residual fill continues from neighbouring pixels, including missed objects next to it, so residual images can
  show smears inside already-extracted areas. These are ignored by the check and the duplicate screen.
- Validated offline only: thresholds have not yet been tuned on real Seedream or OpenAI output.
