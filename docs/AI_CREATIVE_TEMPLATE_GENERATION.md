# Smart edits and "Generate creative template"

Merged into `main` in `8ade2a3` (built on the creative template wizard of `6b23609`). Both features live in the wizard's **Customize** step and continue through its existing **Generate → review → Decompose → editor**
flow. Nothing here was validated against live providers: every automated test uses faked OpenAI and fal calls.

## What changed for the user

The Customize step now has two explicit tools next to the reference image:

| | **Analyze image** → smart edit (existing generation action) | **Generate creative template** (new action) |
|---|---|---|
| What it does | Edits *this* creative: your explicit changes, plus the changes they require | New offer-creative scenes around this image's own products or subjects |
| What is kept | Everything you did not change, while it stays compatible | The protected subjects' **own source pixels**, exactly |
| What is new | Only what the resolved plan says | Only the scenery around the subjects |
| Text | No text, price, badge or logo is ever added; existing overlay text is kept or removed, never written | No text at all in the new scenery |

The saved template's fields are the normal way in, and the normal **Generate Creative** plans them intelligently
(below). **Edit what's in the image** switches to the image's own item cards; **Use template fields instead** switches
back. A saved analysis of the same image is found by its hash (a read, no call); the fields stay on screen. Saved
templates, their versions, executions, reviews, decomposition and the editor import are unchanged.

### Normal Generate from the template fields (Feature 2)

The template fields, empty or partly filled, go through the same change-planning engine as the item cards. Nothing in
it is specific to a product category, brand, layout or field name.

1. **No field changes anything:** Generate reviews your **original image**, exactly and at its own size, with no
   analysis and no image request. It then goes through review, decomposition and the editor as usual. **Regenerate
   anyway · 1 image request** is a separate, explicit button (the whole image, at its own size).
2. **Some fields are filled:** Generate reads the image once (**1 AI call**, saved by the image's hash and template
   version, and reused afterwards) unless an analysis already exists. **Plan changes · 1 AI call** does the same
   without generating, to read the plan and exact prompt first.
3. Each filled field becomes an explicit change of the detected item it maps to. The mapping is by the field's role and
   position, from the analysis (`draftFromTemplateFields`). Empty fields stay as they are. What else must change, what
   stays, and what is unclear is then decided exactly as for the item cards (below): from the image's own items,
   relations and brands, deterministic rules first, and the resolver model for anything unfamiliar. The plan,
   questions and exact prompt are shown beside the fields; an answer to a question is kept with the fields.
4. A filled field that matches nothing in the image is reported, never silently dropped. **Keep the original supporting
   products** keeps each of them explicitly; otherwise the image decides (other copies or accessories of the product
   are asked about, unrelated products stay).
5. Creatives here are text-free. A filled **text** field keeps the template's own behaviour (its prompt writes the text
   as typed), and that request does not use the engine.
6. **Without an image analysis** (smart edits unavailable, or the analysis failed), the template's own prompt is used,
   made safe:
   - The brand comes from the brand field or from your words, and it is the one stated exception to the no-brand rule.
     With none, "no brand name or logo" is drawn.
   - When the product is replaced, every text or logo field left as it is may name the old product. Each one needs
     **Keep** or **Remove** before generating (`DECISION_REQUIRED`); nothing is kept or removed by guess.
   - The result keeps the image's own size and aspect.

### Smart edit from the item cards (Feature 2)

1. **Analyze image · 1 AI call** reads the uploaded image into a validated scene: every product, person, held or worn
   object, background and decoration, with a readable position-aware label ("Smartphone · left"), what it looks like now,
   a brand only with visible evidence (and a confidence), relations (holds, wears, accessory of… only with evidence),
   product brand marks apart from merchant/bank/payment logos, overlaid text (as data, never instructions), and the light.
   The scene is bound to the image's sha256, the template version and the analysis configuration; the same binding is
   found again by hash with no call (opening the step makes no write request).
2. The left column shows one rounded card per detected item, grouped (main, held & worn, supporting, scene, logos & text,
   decorations), with the **detected** values apart from the **requested** change. Each item is **Keep** (inherit, the
   default), **Change** (a property or the overall look), **Replace** (optional brand and product photo) or **Remove**;
   logos and text are only kept or removed. **Correct the detection** fixes a wrong label, description or brand, or marks
   an item as not in the image.
3. The right column separates the **base reusable prompt** (the template's locked rules and fields), the **draft
   changes** (what you asked, not yet resolved) and the **resolved plan** with the **final prompt exactly as sent**.
4. **Resolve changes** (or Generate, which resolves first) turns the draft into a plan. Rules run first and always; a
   resolver model is called only when your words, a brand or a product photo can say more (a background restyle or a
   clothing change resolves by rule, with no call). Every entry is marked **you asked**, **inherited** or **inferred**,
   with a reason. An inferred change can be undone with "Keep it instead". Questions block generation until answered,
   and are asked only when an answer is needed:
   - a brand given with no product;
   - words that name two brands;
   - a brand field the words contradict;
   - a photo that shows a different product;
   - an accessory of a replaced product (only with evidence);
   - a logo that may be about another product of the same brand that stays;
   - an explicit choice that contradicts a dependency.
5. **The resolved plan says how the image will be made** ("How it is made"), decided locally from the plan
   (`editStrategy`), exactly as the server decides it:
   - **No changes:** no image request. Generate reviews the original image, exactly, because a whole-image
     regeneration could only redraw it. **Regenerate anyway** is the explicit exception.
   - **Edits only the changed areas** (most edits): each change gets its own region from the analysis, grown around its
     item (more for a replacement, which may differ in shape). The image model may paint only there. The result is the
     source with those regions blended in through a soft inner edge, so every pixel outside them is exactly your
     image's own, whatever the model did there. This is used when the regions cover at most half of the image.
   - **Restyles around your products** (a background restyle): the products that stay are cut out (one mask request
     each) and kept as their own pixels with the creative-variant method. If the cutout is not reliable, the whole
     image is edited instead, said plainly, and the review must be ticked.
   - **Edits the whole image:** the changes cover most of the image.

   Every strategy keeps the source's own size and aspect: the image is contained in the model's canvas and mapped
   back, so a 9:16 creative stays 9:16.
6. **Generate Creative** sends exactly the resolved prompt. The server re-checks the resolution's binding to the image,
   template version, draft and product photo, and that the plan recompiles to the persisted prompt
   (`STALE_RESOLUTION` otherwise). After the image comes back:
   - The result says what it kept, e.g. "Edited only Smartphone, Product brand mark: 6,97,372 pixels (66.5% of the
     image) are your image's own, unchanged".
   - The local pixel review runs on the analysis's own boxes.
   - An optional **AI check** follows (pass / fail / uncertain per expectation). A found contradiction needs an explicit
     "use anyway"; a checker that did not run is shown as *not checked*, never as a pass.

   Then comes the normal review, Decompose, and the editor.
7. **Reopening a smart edit** from Saved Runs in another browser or session brings back its own changes and resolved
   plan, read from the server with no new call. Regenerate sends those changes. A product photo cannot come back as a
   file; the panel asks you to attach it again.

The plan's main rule: **an empty field inherits the existing content only while it stays compatible**.
- **Brands:**
  - The brand of a new or changed product is read from your own words, by rule and with no call, when it is a brand
    the image itself shows (any product identity or printed brand mark the analysis found, in any category), or one of
    a small seed of widely known names and product lines of one brand ("Galaxy" is Samsung's).
  - Any other brand (unfamiliar, or a line not listed) is read by the resolver model, and accepted only when your own
    words name it. Rules alone never invent one: without the resolver, such a product is drawn with no brand.
  - Everyday words are not mistaken for brands ("apple green", "a galaxy pattern", "lava lamp").
  - A brand nobody named is never added.
  - The text-free rule keeps one exception only: the brand marking the changed product itself carries.
- **Replacing a product** removes:
  - the brand mark printed on it;
  - offer text about it, and lines naming its model even where the analysis did not link them;
  - that brand's logo on the artwork, unless another product of the same brand stays, in which case you are asked;
  - logos and lines that use the old brand's other names, even where the analysis did not link them. Those names come
    from the image first (a brand mark printed on the product, its model's line: "Kestrel" of "Kestrel 2"), then the
    seed's short forms and product lines ("mi" and "Redmi" are Xiaomi's). A short form or a name taken from a model
    counts only as written or in capitals, never as an everyday word. A replacement of the same brand keeps the brand's
    logos, and loses only its old line's name and model.

  Offers never transfer, and merchant, bank and partner logos are different entities and stay. Other copies of the same product
  (the same kind, the same brand or both unbranded: other colours of it, say) are asked about once: replace them too,
  remove them, or keep them.
- **Accessories and held objects:**
  - An accessory is asked about only on evidence.
  - A product of the same brand is its own product: it stays, with a note.
  - A replaced held object adjusts the hand's grip. A new outfit and a new grip are one instruction for the person, so
    "keep the same clothing" is never said next to a new outfit.
  - Removing a person takes what they hold along, or asks.
- **The resolver** may never add numbers, prices, offers, dates or specifications that nobody gave, or a brand neither
  your words nor the photo show. A brand your words name is accepted whatever label the resolver gives it.
- **Contradiction check:** every compiled prompt is checked for self-contradictions (`promptContradictions`), and one
  that has any is never sent.
- **Resolutions made before these rules** (`PLAN_RULES`) are rebuilt when you resolve the same draft again. The rules
  run again and their saved resolver answer is merged again, with no new call. Nothing is sent from an older prompt.

### Generate creative template (Feature 1)

1. Click **Generate creative template** (it analyzes the image first if needed). The image on screen is the reference.
2. The panel says what will be kept: **Keeps exactly: …, chosen automatically**. The advertised product or product
   group is chosen from the analysis, on evidence only: its main products (or the list the analysis itself names), plus
   items linked to them as an accessory, as shown with it (`related_to` ≥ 0.7), or by the same visible brand. For
   example, a water purifier keeps its faucet. Attached parts (a control panel, a screen) travel inside their
   product's cutout. A holder and what it holds stay together. Stands, plinths, props, scenery, logos and text are never
   kept. When nothing is named as main, the most prominent products are used, and the panel says so.
3. Choose the **number of creatives** (1, 3 or 5; default 3) and the **aspect ratio** (1:1, 4:5 or 16:9; default the
   reference's closest), then click **Generate N creatives**. Nothing else is required. **Advanced (optional)** holds the
   manual choice of what to keep (with **Use the automatic choice**), a direction (refused if it asks for text), and the
   AI check. 9:16 is not offered until `gpt-image-2` accepts that size in a live run.
4. The server cuts the products out with a **validated mask per product**: SAM-3 is prompted with each product's label
   and region, and of its candidates the one that matches that region is kept (its score breaks ties), not just the
   best-scored one, which can be another product of the same kind. BiRefNet (`CREATIVE_CUTOUT_PROVIDER=birefnet`)
   mattes the whole image once; its matte is kept only at the chosen products' regions and split between them. The
   combined mask must cover each subject's region, stay near them, and not be empty or the whole image. Overlaid text
   or logos that overlap the subject are reported as a limitation (they stay in the cutout). An unreliable mask stops the
   set and asks for a cutout PNG exported from the same image. It is accepted only if every opaque pixel equals the
   source; nothing is redrawn instead.
5. **Concepts.** One call writes N + 2 (at most 7) structured art directions. Each has a family (studio, lifestyle,
   nature, architectural, abstract, festive, tech, luxury, minimal, outdoor), a theme, an environment, a surface, props,
   a palette, lighting, a mood, a camera angle and a composition: where the products stand, how much of the frame they
   fill, and an optional open area (top, bottom, left or right). Text, prices, offers, discounts, financial terms, logos
   and signs are refused in every field.
   - The N most different concepts are chosen greedily by a distance over family, setting, palette, placement, camera
     and open space.
   - A concept closer than 1.2 to a chosen one, such as a recolour of the same set, is left out and reported (`conceptReport`).
   - Too few different concepts means fewer creatives, never near-copies; **Write scene ideas again · 1 call** asks
     again for the rest.
   - A writer that answers plain `{title, scene}` concepts still works, without the selection.
6. **The canvas.** The products are placed on the ratio's own canvas **as one group**: their arrangement, overlaps and
   proportions are kept. The group goes at the concept's position and size, inside a 5% safe margin, clear of the
   concept's open area (30% of the canvas), and **never enlarged past the source's own pixels** (scale ≤ 1) or
   stretched. A group the source frame cuts off stays against the same canvas edge.
   - Only product pixels go onto the canvas; the rest is a plain fill of the reference's average background colour.
   - A group that must shrink is resampled once (lanczos3), after padding its edges with its own colours so no old
     background bleeds in.
   - Before placing, each product's soft edge is refined: alpha is re-estimated from the product and local background
     colours, and the old background's tint is removed from edge pixels.
7. Each variant is **one** masked image edit (`images.edit`, the mask keeping only the products). The prompt asks for a
   premium photograph around the placed products, light matching theirs, a contact shadow beneath each, no other
   products, and no text. The composite is then built locally:
   - **Ghost removal.** The model's own re-rendering of the products is located by edge correlation (shift and scale,
     not colour, so a brightness change does not hide it). It is filled away with a margin that fits the measured drift
     (3 px when the model kept them in place). The fill continues the surrounding scenery's texture by mirroring it.
   - **Shadows.** A product's synthetic contact shadow is added only when the model painted none beneath it.
   - **Product pixels.** Each product's own pixels are composited on top as **its own layer**: exact at scale 1, or
     resampled once when scaled down.

   Preservation is measured on every result: every opaque product pixel must equal the placed source pixels (one owner
   per pixel where products overlap), every soft edge pixel must be the exact blend (within 2 levels), and no product
   layer may show any pixel outside its mask. Any failure rejects the result (`PRESERVATION_FAILED`). One failure never
   discards the others, and nothing is resent automatically.
8. Each card shows the image, status, the concept (family, mood, open area), the preservation measurement (and the
   scale), the AI check, the editable scene and the exact prompt sent. **Regenerate · 1 paid call** re-sends one variant
   with its edited scene (the previous image stays in its history).
   **Use this creative** continues to the normal review with these extraction choices:
   - **Use its own layers** (no extraction, ₹0): **Generated scene (flattened)**, **Contact shadow · <product>** for
     each grounded product, and **<product> (exact source pixels)** or **(original pixels, scaled to N%)**.
   - **Also split the new scenery**: one Seedream request on the scenery plate only; the products are added back on top.
   - A planned split of the scenery.

   The template's saved plan is never forced onto new scenery, and the template itself is never changed. A set made
   before aspect ratios (no ratio) keeps the reference canvas and its old layer names.

## Configuration

All under the existing `LAYERIZE_EXPERIMENT=1` mount and its origin checks (`server/.env.example`):

| Setting | Default | Meaning |
|---|---|---|
| `CREATIVE_SMART_EDIT=0` | on | turns smart edits off |
| `CREATIVE_VARIANTS=0` | on | turns Generate creative template off |
| `CREATIVE_SEMANTIC_VERIFY=0` | on | turns the AI check off (results show as not checked) |
| `CREATIVE_CUTOUT_PROVIDER` | `sam3` | `sam3` or `birefnet` (fal, needs `FAL_KEY`), or `none` (the user uploads a cutout) |
| `OPENAI_SCENE_MODEL` | `gpt-5.6-sol` | analysis; `OPENAI_RESOLVER_MODEL`, `OPENAI_VERIFIER_MODEL`, `OPENAI_CONCEPT_MODEL` default to it |

Without `OPENAI_API_KEY` both features say they are unavailable (and why) instead of failing on use; without `FAL_KEY`
(and with an automatic cutout provider) variants say so. `GET /api/layerize-experiment/creative-features` reports this.

## API and storage

`server/src/decomposition/creativeTemplates/smartRoutes.ts` lists the routes (analyses, resolutions, variant sets).
A smart edit is a normal `POST /template-executions` with `analysisId`, `resolutionId` and `draft`. Data on disk
(next to the existing folders under `artifacts/decomposition/`): `scene-analyses/<id>/` (the analyzed image, scene,
call files, resolutions bound to their drafts and product photos) and `creative-variants/<id>/` (cutout, mask, every
attempt's request, response, scenery, plate, shadow, subject and composite). Request files never contain image bytes.

Calls are counted apart on each record and in the run dashboard: image analysis (shared by edits of that image),
change resolution, image generation, AI check; for variants, mask requests, scene concepts, images and AI checks in the
set. Costs are computed only from recorded usage with the existing price table; fal SAM-3 has no configured price and is
shown as such.

## Saved data and the editor

Nothing saved needs a migration, and opening it makes no call:

- **Saved templates, versions, sessions and runs** open as they were. A deleted template stays out of the list, and a
  session a stopped server left mid-way is shown as interrupted (resumable), as before.
- **Old requests** are accepted: every new request field is optional (`regenerateUnchanged`; `aspectRatio` for a
  variant set; `protectedIds` may still be given, and is chosen automatically when absent).
- **Old image analyses** are found again by the image's hash and template version (the analysis key, `scene-v1` and
  the model, is unchanged).
- **Old plans** (saved before plan-rules versions existed, or under older rules):
  - They still generate when their saved prompt compiles to exactly the same text under the current rules. Otherwise
    generation stops with `STALE_RESOLUTION`, and nothing is sent.
  - Resolving the same changes again rebuilds the plan under the current rules from what was saved (its resolver
    answer, if one was made), as a new record linked by `reusedFrom`. No call; the old record stays.
- **Variant sets** saved before aspect ratios and concepts existed have none of the new optional fields, and keep their
  source canvas.

Both features reach the editor through the same import (`experimentToVariant`). Each kept layer becomes one image
layer, back to front by its `zIndex`, at its run placement and size, on the run's canvas (scaled down only past the
editor's canvas limits). The editor lists the layers front to back, each named with its stacking position ("Smartphone
(exact source pixels) (z2)").

## Run and verify

Offline (no keys, all providers faked): `npm run build && npm run demo:image-templates`, open http://127.0.0.1:3317,
**OpenAI + Seedream test → Create Template**, create a template from any image (or use one already saved), select it,
**Next**.

- Smart edit: **Analyze image** → set the Smartphone to **Replace** "Xiaomi phone" → **Resolve changes** → the plan shows
  the explicit replacement, the inferred brand and the removed brand mark → **Next** → **Generate Creative** → the review
  shows the AI check → tick, choose a plan, **Use this image** → **Open in Editor**.
- Variants: **Generate creative template** → the panel shows "Keeps exactly: Smartphone · chosen automatically" →
  choose **3** and **4:5** → **Generate 3 creatives** → three different concepts on 1216×1520 canvases (the fixture's
  recolours are left out) → edit a scene and **Regenerate** → **Use this creative** → **Use its own layers** → **Use
  this image** → **Open in Editor**. One product gives three layers: Generated scene (flattened), Contact shadow ·
  Smartphone, and Smartphone (exact source pixels). Several products give one shadow and one exact layer each.
- The real Mijia creative, offline: with `FRAMEFLOW_REPLAY_ARTIFACTS=<artifacts/decomposition>` (and optionally
  `FRAMEFLOW_VISUAL_OUT=<dir>` for the images), `variantLayout.test.ts` and `variantCompose.test.ts` replay its saved
  analysis and real per-product cutouts. They check that all four products are chosen (the faucet included, never the
  plinths) and place them at 1:1, 4:5 and 16:9 under a fake model that drifts.
- Your own saved data, offline: with the same variable:
  - `savedData.test.ts` opens a copy-on-write clone of the saved templates, sessions, image analyses, plans and the runs
    they use through the current API. Every provider is a fake that fails the test when called. It checks that
    nothing saved changes, that the previous app's request format is accepted, and that an old plan is rebuilt with
    no call.
  - `editorImport.test.ts` imports every finished run your sessions used into the editor's own import. It checks
    names, positions, sizes, stacking order and canvas, and that a variant's composed layers rebuild its creative
    exactly.

Live (paid): set `LAYERIZE_EXPERIMENT=1`, `OPENAI_API_KEY`, `FAL_KEY` and `CLIENT_ORIGIN` as for the existing wizard.
Suggested first checks, one image at a time: a phone ad with merchant and bank logos (replace the phone; check that
only the phone's own mark and offer text go), a person holding an object (replace the object), two products of the same
kind (change one), and one variant set of a single product with a plain direction.

## Not verified, and limits

- **No live provider call was made** for any of this (including the one-click flow, the aspect ratios and the
  concept engine). Unverified: whether the analysis model fills the scene schema
  well on real creatives (boxes, brand evidence, relations, overlay text vs printed marks); whether the resolver's
  proposals are useful; whether `gpt-image-2` honors the replacement and text-free rules; SAM-3 mask quality on real
  photos (hair, transparent or reflective edges, held objects); how often the strict-schema calls are refused; latency
  and cost per call.
- **Exact preservation** covers every opaque product pixel at scale 1. A group scaled down for its canvas is the
  source's own pixels **resampled once**, measured against that resample (`resampled-source-pixels`, with the scale),
  never redrawn. Soft edges blend the refined edge pixels with the new scenery, and nothing outside the mask is ever shown.
  Edge refinement removes the old background's tint where the product and background colours differ; hair, glass,
  smoke and motion blur are not verified on real photos.
- **Ghosts and fill.** Drift is measured from the model's output, so a re-rendering the edge correlation does not find
  (a heavily restyled product) is not filled away: the AI check or the reviewer must catch it. When the model drifts on
  strongly textured scenery, the mirrored fill near the products can look mottled. Moving a product in the editor
  reveals the fill under it.
- **Concept diversity is semantic, not artistic.** The offline tests prove that the chosen concepts are valid, text-free
  and measurably different (family, setting, palette, placement), and that near-copies are left out. Whether they look
  premium, and whether `gpt-image-2` follows the composition, is only visible in live runs.
- The generated scene is one flattened layer; its props and surfaces cannot be moved separately without **Also split
  the new scenery**.
- Before 2026-10-09 the masks sent to the model, the ghost-removal fill and the product edges were read in the wrong
  pixel layout (sharp returns three bands from a one-band resize or blur): variants made before that may show the
  model's own copy around the product, or old background inside its box. Their stored measurements predate the edge
  and outside-the-mask checks.
- The AI check is a vision model's judgment: it can miss a wrong logo or a subtle duplicate, and it is never treated as
  proof. The local pixel review of a smart edit uses the template's own regions (exact layer shapes only when the edited
  image is the template's source creative, otherwise thirds of the canvas), never segmentation masks.
- A smart edit keeps the pixels outside its changed regions exactly, and a restyle keeps its products exactly. Inside
  a region, and in a whole-image edit, unchanged details are kept by instruction only. A region boundary is blended
  over about 1.5% of the image: if the model shifts the colours inside a region, a soft seam can show at its edge.
  Gripping hands and items reaching beyond their region are not verified on real outputs.
- Rules recognise only brands the image shows and a small seed list; any other brand needs the resolver call, and with
  rules only it is drawn without a brand. Removed text is never rewritten: a removed offer leaves its place to the
  background (add new text in the editor).
- A template field maps to a detected item by role and position. A creative that the analysis reads differently from
  the template (a missing item, two items where the template has one) reports the field as unmatched instead of
  guessing.
- The analysis is bound to a template version: a new settings version needs a new analysis (one call).
