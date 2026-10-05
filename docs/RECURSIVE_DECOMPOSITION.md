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
8. **Clean background**: the first candidate that passes validation (step 9) wins:
   1. **Seedream's base**, when it no longer shows any extracted layer. No call.
   2. **Seedream's own scene layers** (a white field, a brand curve, a gradient) composited over its base. They often
      already hold the complete background behind a person. No call.
   3. **One OpenAI image edit** of the original. The removal area is pre-filled from its own surroundings, so the model
      never sees the removed subject's shape. The prompt asks for background only, with no silhouettes or dark
      placeholders. The result is used only inside the feathered mask, at the canvas's resolution; outside it every
      pixel is the original's, so passes never compound.
   4. **Deterministic continuation** from the original, when the edit is unavailable, fails or is not usable.
      - Simple graphic backgrounds (a few flat colors or gradients) continue region by region with crisp, smooth
        boundaries. A single visible curve between two regions is extrapolated through the hole.
      - Anything else gets the local fill.

   At most one edit is ever sent, and it is never retried.
9. **Validate** every candidate (`backgroundRecovery.ts`), on the worst removed region of at least 0.5% of the image.
   - **failed:** a near-black area (≥ 10%), a seam along the edge (≥ 40%), mostly colors found nowhere around it
     (≥ 35%), or a removed layer recreated.
   - **degraded:** milder versions of these, darkening by ≥ 50, or an AI result that re-rendered ≥ 40% of what lies
     outside the mask.

   Leftover objects no layer holds make the background `contaminated`. A fallback is always reported as `fallback`,
   never as clean.

   The record (`refinement.background`, `decomposition-debug.json`, the test panel) has:
   - `quality`, `validation` (reasons and metrics) and every candidate with its verdict
   - `difficulty`: easy, medium or hard-large-occlusion, from `foregroundMaskCoverage`, `largestConnectedMaskCoverage`,
     the number of background zones and whether the background is simple graphic
   - `reconstructionReason`, `fallbackUsed`, `aiTried` and `outsideMaskChangedPercent`

   Large atmosphere and design layers ("…glow background", "yellow curved decorative field") are scene layers. They are
   never cut out of the background. Pixels a scene layer explains (the same color there) never count as leftover
   objects, so a crisp brand shape does not trigger a residual pass.

## Protected people and interactions

A visually correct layer beats a technically separate but broken one. Two places enforce this, neither with an extra call.

**Planner** (`semanticPlanner.ts`). Every planned element has an `attachment`: `relation` (`none`, `held_in_hand`,
`worn_by_human`, `attached_to_human`, `part_of_object`), `parent_id`, `separation_risk` (low/medium/high) and
`keep_with_parent`. Code enforces the rules on the model's answer, whatever its prose says:
- worn or attached items stay with the wearer
- finger, grip and occlusion fragments stay with their person
- a held object stays with the person unless the split is rated low risk, and always when a fragment crosses it
- content on a merged element follows it (a badge on a held phone)

When anything had to be merged, the Seedream prompt is rebuilt from the protected inventory. Images with people also get
a fixed clause asking Seedream to keep hands, fingers and worn jewelry whole. The model's own analysis is kept unchanged
in `planner.semantic_analysis`; what code changed is in `planner.semantic_protection`.

**After Seedream** (`interactionGrouping.ts`, image-aware and refined runs). Whatever Seedream returned:

| Layer | Rule |
| --- | --- |
| A body part on its own (hand, arm…) | Back into the whole person it touches (at least 3× its size); pairs of hands with no person stay |
| Finger / grip fragments | Back into their person |
| Held object | Grouped with the person when fingers cross it, when the stack hides hand pixels the original shows in front of it (interleave check), or when the planner rated the split risky; a clean split stays separate and is recorded |
| Content on a held object | Follows it |
| Worn ornaments | Join the person they touch and sit within or across (bangles wider than the wrist count); a standalone ornament stays |
| Tiny attached pieces (< 0.15% of the canvas) | Join the layer they sit in |
| Three or more tiny decorations | Become one group |

Text is never merged into a person. A group is one PNG of its members in their own order, at the front-most member's
depth, or the back-most one when a layer between its members would otherwise change the picture. Refined runs group
after the residual passes and the stacking order, so a bangle a residual pass finds joins its hand in the right depth.
Seedream's base is still judged per original layer for the clean background. Template A runs with "Separate held object"
ticked keep the held object and its grip as returned.

Each group layer carries `grouping` (`groupedWithParent`, `parent`, `protectedInteraction: "hand_holding_object"`,
`attachmentReason`, `members` with role and reason). Every decision, including clean splits kept separate, is in
`run.interactions`, `decomposition-debug.json` and the test panel's debug view ("Protected groups").

Limits:
- Names decide what a layer is (person, ornament, fragment, text), and geometry decides the merge. An unnamed or
  oddly named hand piece is only caught by the tiny-piece or interleave rules.
- A grouped person and held object move and hide together. To edit the product alone, use a creative where the hand
  does not cross it, or replace the whole group.

## Stop reasons

`clean`, `below-threshold`, `low-confidence`, `not-assessable`, `max-depth`, `no-new-layers`, `all-duplicates` (only
copies came back), `pass-failed` (earlier layers kept), `max-total-layers` (32), `resume-no-new-calls`.

## Calls (`run.calls`, refined runs)

Counted when sent, never retried by the orchestration:

| Case | Planner | Initial Seedream | Residual Seedream | Background edit |
| --- | --- | --- | --- | --- |
| Simple image, clean base (or clean scene layers) | 1 | 1 | 0 | 0 |
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
