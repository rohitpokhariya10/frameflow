# Recursive decomposition and clean backgrounds (experiment)

Complex offer creatives come back from Seedream Layerize with a base layer that still holds products: copies of the ones
it extracted, and the ones it missed. Imported as is, the editor's background shows ghost products the moment a layer is
moved or hidden. The recursive refinement fixes that after the run's own decomposition, within hard limits.

Code: `server/src/decomposition/recursiveDecomposition.ts` (orchestration), `backgroundContamination.ts` (image checks),
`cleanBackground.ts` (the clean background), `backgroundRecovery.ts` (plain-field continuation and candidate validation),
`shadowResidue.ts` (cast shadows), `layerUsefulness.ts` (which layers are editor layers). Tests:
`recursiveDecomposition.test.ts`, `backgroundRecovery.test.ts`, `peopleShadow.test.ts`,
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
   texture and noise stay below it, while products, pedestals and text blocks do not. Cast shadows of the extracted
   foreground (step 8) count as explained: a shadow is removed with its subject and never costs a residual call.
   **Plan coverage** (`planCoverage`, `refinement.planCoverage`): when every foreground element the planner listed (not
   the scene, after protection merges) has an extracted layer, matched by the words they share, what still stands out is
   presumed to be the background's own design (a platform, soft circles, a brand shape). A region then also needs a
   contrast of 3 (as a missed product has) to count, for the residual pass and for the final "contaminated" verdict.
   Without a plan, or with a planned element missing, any object-like region counts as before. No model call.
4. If it is contaminated, a **residual pass** sends the residual to Seedream with a fixed residual prompt (no planner call).
   New layers are screened. Rejected: fragments, background-like layers, layers mostly inside an area already extracted,
   and duplicates (mask IoU ≥ 0.5, ≥ 70% inside an existing layer, or overlapping boxes with a similar name). The earlier
   layer is always kept. More than 8 new layers: the smallest are grouped into one "Residual details" layer.
5. Repeat on the next residual, at most **2 residual passes** (`MAX_RESIDUAL_PASSES`). The residual after the last pass is
   assessed for the record and never sent.
6. **Order**: one back-to-front order for every layer. Within a pass Seedream's order holds. Where layers of different
   passes overlap, the one matching the original there is in front. Elsewhere the order is background, decoration,
   supports, secondary objects, products, then text. Pass number is never the z-order.
7. **Layer screen** (`layerUsefulness.ts`, see below): fillers Seedream invented, hidden guesses, faint remnants and
   detached shadow stains are not editor layers.
8. **Foreground union mask**: every foreground layer (and every removed stain), grown by 0.8% of the canvas's shorter
   side and feathered over half that (`foreground-mask.png`), **plus the cast shadows of what it removes**
   (`shadow-mask.png`, `shadowResidue.ts`). Scene layers (full-frame backgrounds, backdrop panels) are not removed.
   - A cast shadow is found in the original: around the removed area, the background continued from beyond it (the
     plain field's exact surface, else region by region, else smooth) is compared with what is there. A shadow is the
     expected color dimmed by one factor (same hue, darker), touches the removed area, has a clearly dark part and fades
     out softly; its faint tail joins it. A crisp grey shape or dark design element has a hard edge and is kept, and on
     the coarser models only clearly dark shadows count, so their own error on a gradient is never taken for one.
9. **Clean background**: the first candidate that passes validation (step 10) wins:
   1. **Seedream's base**, when it no longer shows any extracted layer and is the creative's background outside the
      removed area. No call.
   2. **Seedream's own scene layers** (a white field, a brand curve, a gradient, a studio plate) composited over its
      base. They often already hold the complete background behind a person. No call.
   3. **A simple background, continued locally**: when every removed region sits on a plain field (a flat brand color,
      a gradient, a soft glow or vignette: 97% of the ring around it within 18 of one smooth surface, fitted without
      outliers at a cut set by the field's own pixel noise, little texture), that surface (`plainFieldFill`); else, when
      the background around the removed areas is a few flat colors (at most 3: a white field and a yellow curve, a wall
      and a panel), the region-by-region continuation (`graphicFill`). No call, and nothing a model could repaint as a
      silhouette: a clean simplified background is preferred to a photoreal but broken one. `deterministicBackground:
      false` (a run option) skips this step; the continuation then stays the fallback.
   4. **One OpenAI image edit** of the original. The removal area is pre-filled from its own surroundings, so the model
      never sees the removed subject's shape. The prompt asks for background only, with no silhouettes or dark
      placeholders. The result is used only inside the feathered mask, at the canvas's resolution; outside it every
      pixel is the original's, so passes never compound.
   5. **Deterministic continuation** from the original, when the edit is unavailable, fails or is not usable.
      - A plain field continues as its smooth surface.
      - Simple graphic backgrounds (a few flat colors or gradients) continue region by region with crisp, smooth
        boundaries. Colors joined by a smooth transition are one region (a gradient split into several flat colors),
        so a platform under a removed product does not leave a lighter ghost of it. Where exactly two regions meet
        around a hole, their boundary is extended through it, hole by hole: one smooth curve, or straight axis-aligned
        edges meeting in a corner (a panel's top and side under a removed headline).
      - Anything else gets the local fill.

   At most one edit is ever sent, and it is never retried. A clean simplified continuation is preferred to a faithful
   but broken background: a candidate with a ghost fails even when nothing else is wrong with it.
10. **Validate** every candidate (`backgroundRecovery.ts`), on the worst removed region of at least 0.5% of the image,
   against the clean continuation of the original around it (the plain field, else the region-wise continuation).
   - **failed:** a near-black area (≥ 10%), a seam along the edge (≥ 40%), mostly colors found nowhere around it
     (≥ 35%), a **silhouette residue** (≥ 12%: a darker same-hue ghost or shadow of the removed subject, any visible
     deviation from a plain field, or a blot darker than nearly everything around it), a **background mismatch** (≥ 20%
     of the image outside the removed area differs from the creative: a placeholder or re-rendered provider base or
     scene composite), or a removed layer recreated.
   - **degraded:** milder versions of these (residue ≥ 4%, mismatch ≥ 6%), darkening by ≥ 50, or an AI result that
     re-rendered ≥ 40% of what lies outside the mask.

   Leftover objects no layer holds make the background `contaminated`. A fallback is always reported as `fallback`,
   never as clean.

   The record (`refinement.background`, `decomposition-debug.json`, the test panel) has:
   - `quality`, `validation` (reasons and metrics, including `residuePercent` and `backgroundMismatchPercent`) and every
     candidate with its verdict
   - `difficulty`: easy, medium or hard-large-occlusion, from `foregroundMaskCoverage`, `largestConnectedMaskCoverage`,
     the number of background zones and whether the background is simple graphic
   - `plainField` (plain or not, region by region) and `shadow` (share removed, each shadow found with its depth,
     softness and verdict)
   - `reconstructionReason`, `fallbackUsed`, `aiTried` and `outsideMaskChangedPercent`

   Statuses: `provider-clean`, `scene-clean`, `continued-clean` (the plain field, validated), `ai-reconstructed`,
   `contaminated`, `fallback`.

   Large atmosphere and design layers ("…glow background", "yellow curved decorative field") are scene layers. They are
   never cut out of the background. Pixels a scene layer explains (the same color there) never count as leftover
   objects, so a crisp brand shape does not trigger a residual pass.

## Which layers are editor layers

Seedream returns what it can separate, not what a designer edits. `layerUsefulness.ts` keeps people and their protected
groups, products, text, and every layer that holds something the creative shows; it leaves out, with the reason in
`refinement.layerPlan` (and a `LAYERS_LEFT_OUT` warning, the panel's "Editable layers" line, and ✗ tiles on the contact
sheet):

| Reason | Layer | Its pixels |
| --- | --- | --- |
| `not-in-original` | less than 25% of its visible opaque pixels are what the creative shows there (a grey panel invented behind a person) | stay as the creative's background |
| `hidden` | less than 3% of it is ever visible (a block inside a person, a plate under another plate) | as above |
| `filler-behind-subject` | at least 40% of what it holds behind other layers is colors its visible part never shows (a wall panel with a grey slab where the person stood) | as above |
| `faint-remnant` | a small, mostly translucent foreground layer (under 2% of the canvas) that changes the image by less than 10/255 on average; an opaque object colored like its background (a white product on white) is kept | as above |
| `background-fragment` | a scene, decoration or effect piece under 10% of the canvas that changes the image by less than 10/255 (16 on a simple background of at most 3 flat colors): background noise, a faint patch | as above |
| `detached-shadow` | a shadow or stain layer (its name's head names one, its pixels are translucent or dark) touching no subject | rebuilt with the foreground |
| `merged-into-background`, `duplicates-background`, `replaced-by-clean-background` | a full background plate (85% × 85% of the canvas, 60% opaque): the clean background is that plate, so it is never a second background layer; kept only over a provider base it differs from | in the background |

A shadow layer that touches a subject is not left out: it joins that subject (a person first) as `cast_shadow` in
`interactionGrouping.ts`, so it moves and hides with it. Scene shapes that are not full plates (a brand curve, a glow, a
backdrop panel) stay layers. `layerPlan` also counts the editable layers by category (background, person, product, text,
scene, decoration, support, object, effect) and records the background kind they were judged against (`plain`, `graphic`
or `scene`). Judged against the original only, so nothing is left out when the original
does not match the canvas aspect.

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
| Cast shadow (a shadow layer, translucent or dark, touching a subject) | Joins that subject, a person first (`cast_shadow`); one touching nothing is left out (see above) |
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
| Removed areas on a plain field or a simple graphic design (at most 3 flat colors), whatever the base holds | 1 | 1 | 0–2 | 0 |
| Every planned element extracted, only the background's own design left | 1 | 1 | 0 | 0 |
| Clean of missed objects, base duplicates its layers, background not a plain field | 1 | 1 | 0 | 1 |
| One residual pass, background not a plain field | 1 | 1 | 1 | 1 |
| Maximum | 1 | 1 | 2 | 1 |

(+1 OpenAI call when `LAYERIZE_FIT_CHECK=1`.) Resume and "Re-render" reuse saved residual responses (by request ID) and
the saved edit (cache key: original + mask + size + prompt + model). They never send anything new.

## Outputs (run folder)

Existing: `layers.json` (additive `provenance`, `cleanBackground` and a `refinement` summary), `contact-sheet.png`
(original, background, pass-0 layers, each residual with its new and rejected layers, mask, reconstruction),
`reconstructed.png`. New: `clean-background.png`, `clean-background-ai.png`, `clean-background-mask.png` and
`clean-background-request/response.json`, `foreground-mask.png`, `shadow-mask.png` (when a cast shadow was removed),
`residual-pass-N.png` / `residual-final.png`,
`pass-N-layer-NN.png`, `pass-N-seedream-request/response.json`, `decomposition-debug.json`.

Each layer's `provenance` records `sourcePass` (0 = initial, 1–2 = residual), `sourceImage`, `parentResidualId`,
`providerFile`, `providerRequestId`, `role`, `bbox` (canvas px) and `mask` (the file whose alpha is the mask).

## Known limitations

- **Shadows**: a cast shadow is removed with its subject when it is a soft, same-hue darkening that touches it, within a
  tenth of the canvas's longer side (less when the foreground is spread across the creative). The composite then shows
  the subject without that shadow (simplified, not repainted on the subject's layer). A soft dark design element that
  touches a subject can be taken for a shadow; a shadow on a busy photographic background is only removed when it is
  clearly dark; a shadow drawn into a kept scene shape (not a full plate) stays in that layer. Broad environmental
  lighting stays in the background by design.
- **Straight-edge continuation** is axis-aligned only: a rotated or diagonal panel edge under a removed object falls back
  to the region vote, which can move the edge. A hole surrounded by three or more design regions also uses the vote.
- **Plan coverage** matches planned elements to layers by the words they share: a layer named quite differently from its
  planned element counts as missing, which only means the stricter residual check is not applied (the earlier behavior).
- **Plain fields** are judged on a ring around each removed region (4% of the longer side): a gradient that bends
  strongly within the ring, or heavy grain, is not plain and goes to the edit. The continued field is smooth, with no
  grain added.
- **Layer screen**: names decide which layers can never be left out (people, products, text); an unnamed real element
  whose pixels Seedream re-rendered in another color is left out as `not-in-original` (its pixels stay in the
  background, so the picture is right but it is not separately editable).
- **Text** stays raster: text Seedream returns as layers is kept as layers, with no OCR or native text.
- **Scene layers** (backdrop panels, frames) stay in the clean background under their own layer.
- The contamination check is image-statistical: strong lighting effects or busy patterns can look object-like (bounded
  by the depth limit), and an object colored like its surroundings can be missed.
- The residual fill continues from neighbouring pixels, including missed objects next to it, so residual images can
  show smears inside already-extracted areas. These are ignored by the check and the duplicate screen.
- Validated offline only: thresholds have not yet been tuned on real Seedream or OpenAI output.
