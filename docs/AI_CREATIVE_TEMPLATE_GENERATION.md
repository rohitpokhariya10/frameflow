# Smart edits and "Generate creative template"

Branch `feat/ai-creative-template-generation`, built on the creative template wizard (`main` @ `6b23609`). Both features
live in the wizard's **Customize** step and continue through its existing **Generate → review → Decompose → editor**
flow. Nothing here was validated against live providers: every automated test uses faked OpenAI and fal calls.

## What changed for the user

The Customize step now has two explicit tools next to the reference image:

| | **Analyze image** → smart edit (existing generation action) | **Generate creative template** (new action) |
|---|---|---|
| What it does | Edits *this* creative: your explicit changes, plus the changes they require | New offer-creative scenes around this image's own products or subjects |
| What is kept | Everything you did not change, while it stays compatible | The protected subjects' **own source pixels**, exactly |
| What is new | Only what the resolved plan says | Only the scenery around the subjects |
| Text | No text, price, badge or logo is ever added; existing overlay text is kept or removed, never written | No text at all in the new scenery |

Before an analysis exists, the saved template's fields (the existing flow) are shown unchanged; **Use template fields
instead** switches back to them at any time. A saved analysis of the same image is found by its hash (a read, no
call) and opens the smart controls, except when template fields were already filled in: those stay on screen. Saved templates, their versions, executions, reviews, decomposition and the
editor import are unchanged.

### Smart edit (Feature 2)

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
   with a reason; an inferred change can be undone ("Keep it instead"). Questions (a brand alone, a photo that shows a
   different product, an accessory of a replaced product, a contradiction) block generation until answered.
5. **Generate Creative** sends exactly the resolved prompt. The server re-checks the resolution's binding to the image,
   template version, draft and product photo, and that the plan recompiles to the persisted prompt
   (`STALE_RESOLUTION` otherwise). After the image comes back, the existing local pixel review runs, then an optional
   **AI check** (pass / fail / uncertain per expectation). A found contradiction needs an explicit "use anyway";
   a checker that did not run is shown as *not checked*, never as a pass.

The plan's main rule: **an empty field inherits the existing content only while it stays compatible**. Replacing a
product removes the brand mark printed on it and offer text about it (offers never transfer); a merchant or bank logo
is a different entity and stays; an accessory is asked about only when the analysis has evidence; a replaced held
object adjusts the hand's grip; removing a person takes what they hold along, or asks. A resolver may never add
numbers, prices, offers, dates or specifications that nobody gave, or a brand neither your words nor the photo show.

### Generate creative template (Feature 1)

1. Click **Generate creative template** (it analyzes the image first if needed).
2. Confirm what must stay exactly as it is. The one main subject is preselected; when several items could be the main
   subject nothing is preselected. Held and worn objects and their holder are kept together automatically.
3. Give a direction, or **Surprise me**; choose 1–4 variants; optionally **Check each result with AI**.
4. The server cuts the subjects out with a **validated mask** (SAM-3 prompted per subject by default): the mask must
   cover each subject's region, stay near them, and not be empty or the whole image. Overlaid text or logos that overlap
   the subject are reported as a limitation (they stay in the cutout). An unreliable mask stops the set and asks for a
   cutout PNG exported from the same image — accepted only if every opaque pixel equals the source; nothing is redrawn
   instead.
5. A scene-concept call writes N genuinely different scenes (skipped for one variant with a direction); concepts that ask
   for text or repeat another are not sent. Each variant is **one** masked image edit (the subject stays visible to the
   model for its light), mapped back to the source canvas, its subject area filled locally into a clean plate, a soft
   contact shadow added as its own layer, and the subject's **own source pixels** composited on top at full resolution.
   Preservation is measured on every result (all fully opaque subject pixels compared with the source; any difference
   rejects the result). One failure never discards the others; nothing is resent automatically.
6. Each card shows the image, status, AI check, the editable scene and the exact prompt sent. **Regenerate · 1 paid
   call** re-sends one variant with its edited scene (the previous image stays in its history). **Use this creative**
   continues to the normal review with these extraction choices: **Use its own layers** (no extraction, ₹0: scenery,
   shadow and the exact subject), **Also split the new scenery** (one Seedream request on the scenery plate only; the
   exact subject is added back on top), or a planned split of the scenery. The template's saved plan is never forced onto
   new scenery and the template itself is never changed.

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

## Run and verify

Offline (no keys, all providers faked): `npm run build && npm run demo:image-templates`, open http://127.0.0.1:3317,
**OpenAI + Seedream test → Create Template**, create a template from any image (or use one already saved), select it,
**Next**.

- Smart edit: **Analyze image** → set the Smartphone to **Replace** "Xiaomi phone" → **Resolve changes** → the plan shows
  the explicit replacement, the inferred brand and the removed brand mark → **Next** → **Generate Creative** → the review
  shows the AI check → tick, choose a plan, **Use this image** → **Open in Editor**.
- Variants: **Generate creative template** → keep Smartphone protected → **Surprise me** → **Generate 3 creatives** →
  edit a scene and **Regenerate** → **Use this creative** → **Use its own layers** → **Use this image** → **Open in
  Editor** (three layers: New scenery, Contact shadow, Smartphone (exact source pixels)).

Live (paid): set `LAYERIZE_EXPERIMENT=1`, `OPENAI_API_KEY`, `FAL_KEY` and `CLIENT_ORIGIN` as for the existing wizard.
Suggested first checks, one image at a time: a phone ad with merchant and bank logos (replace the phone; check that
only the phone's own mark and offer text go), a person holding an object (replace the object), two products of the same
kind (change one), and one variant set of a single product with a plain direction.

## Not verified, and limits

- **No live provider call was made** for any of this. Unverified: whether the analysis model fills the scene schema
  well on real creatives (boxes, brand evidence, relations, overlay text vs printed marks); whether the resolver's
  proposals are useful; whether `gpt-image-2` honors the replacement and text-free rules; SAM-3 mask quality on real
  photos (hair, transparent or reflective edges, held objects); how often the strict-schema calls are refused; latency
  and cost per call.
- **Exact preservation** covers the protected subject's fully opaque mask pixels. Its edge is the mask's soft alpha (a
  1-pixel feather) over a locally filled plate: hair, glass, smoke and motion blur may look cut out. The model sees the
  subject only to light the scene; its own re-rendering of it is filled away (2.5% margin) — a larger drift can leave a
  ghost the AI check or the reviewer must catch. Shadows the model paints near the subject are filled away too; the
  separate contact shadow replaces them.
- The AI check is a vision model's judgment: it can miss a wrong logo or a subtle duplicate, and it is never treated as
  proof. Pixel review regions from the analysis are approximate boxes, never segmentation masks.
- A smart edit regenerates the whole image (an image edit): unchanged items are kept by instruction, not by
  compositing. Only Generate creative template preserves pixels exactly.
- The analysis is bound to a template version: a new settings version needs a new analysis (one call).
