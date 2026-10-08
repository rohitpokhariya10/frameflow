# Manual reusable templates — validation

**Status: READY FOR MANUAL LIVE TEST.** The primary flow is a four-step wizard with **manual template card selection**:
**Template → Customize → Generate → Decompose**. Automatic layout detection and Plan fresh remain under
**Advanced · planning experiments** and never run on their own. Smart edits (the uploaded image analyzed, edits resolved into a change plan) and
**Generate creative template** (new scenes around the image's own subjects) extend the Customize step: see
[AI_CREATIVE_TEMPLATE_GENERATION.md](AI_CREATIVE_TEMPLATE_GENERATION.md).

## The flow

1. **Template** — saved templates render as cards (thumbnail, name, version, description, content-slot badges,
   "Reusable · Planner ₹0", selected state). **+ Create New Template** is a top-level header action.
2. **Customize** — the reference creative and the template's fields, grouped from its saved schema
   (`describeTemplateSlots`): **Main product** (Replace product / Change details, optional brand, optional product
   photo, "keep the original supporting products"), **Background & style**, **People & held objects**, **Offer text**
   (only when the template has text), and everything else under a collapsed **Advanced elements**. Same-role fields get
   labels by place ("Supporting product · top left"). The prompt panel lists **What will change**, shows the **Base
   template prompt** with each field as a marked part (hover, focus or click leads to its field; the rest are locked
   rules), and the **Final prompt · exactly what is sent** in a disclosure. Preview and request use one compiler:
   `compileTemplateEdit` (`shared/src/creativeTemplates/editPlan.ts`).
3. **Generate** — **Generate Creative** makes exactly one image request (two input images when a product photo is
   attached) and stops at a saved `generated` review state. A local review compares the generated image with the
   original (`server/src/decomposition/creativeTemplates/review.ts`, pixels only). A replaced or removed object always
   needs a person's tick; a kept outline is a warning ("Main product may not have been replaced"). A product change the
   saved decomposition plan was not learned from asks **How should layers be extracted?**: saved plan (₹0), simpler
   grouping (₹0) or a refreshed plan (one planner call). **Use this image** stays disabled until both are answered.
   **Regenerate** makes exactly one more request; a failure keeps the previous image. With every field empty, **Use
   original image** decomposes the reference with 0 image calls.
4. **Decompose** — exactly the approved image (its sha256 is checked before anything is uploaded) with the chosen plan,
   plus the existing refinement: residual recovery, background cleanup and curation. A failed extraction keeps the
   generated creative and offers explicit retries, each priced: simpler grouping, the same plan, or a refreshed plan.
   Nothing is retried automatically; a stored fal 422 is never "resumed". **Open in Editor** and **Preview layers**.

State survives Back/Next, tab switches and refresh (session draft: step, template, fields, execution id). A refresh
cannot keep image file bytes, so the user is asked to reselect the file while other choices are kept. Saved sessions
are listed under **Saved Runs** and reopen at the right step (`generated` → review, `done` → result).

## Offline validation

Fake providers and fixtures only; provider credentials blank; the browser fixture blocks non-local requests.

| Check | Result |
|---|---|
| Server (incl. creative templates, recursive decomposition, background recovery, interaction grouping) | **547 passed**, 48 files |
| Client + shared (incl. 16 wizard tests in `templateWizard.test.ts`) | **565 passed**, 51 files |
| Full offline browser suite (`playwright.offline.config.ts`, all projects, 2 workers) | **297 passed, 0 failed, 14 skipped** (heavy journeys run on desktop only) |
| Typecheck / lint / build / `git diff --check` | **PASS / PASS / PASS / PASS** |

Wizard browser journeys (`creative-templates.spec.ts`, every project): **C+A** create a template (planner 1, image 0) →
card appears → customize → preview equals the prompt sent → one image call (double-click safe) → regenerate (+1 exactly)
→ refresh and Saved Runs reopen the review → approve → decomposition of the approved image (bytes compared), planner 0 →
layers → editor. **B** no changes → original image, 0 image and planner calls; wrong-template warning (refused before
anything is stored), Continue with selected template, Create New Template; explicit Plan fresh (planner 1). **Failed
regeneration** keeps and decomposes the previous image. **Corrupt upload** is refused before any call. **D** 390px and
320px without horizontal overflow. Provider counts are each test's own (a prompt token, the page's own requests, its
executions' records), so they hold while other specs share the fixture server.

### Specs migrated from the removed legacy UI

The five older specs drove the deleted Create Template from Image dialog or the deleted Template B selector. Their
legacy-only steps were removed; every still-relevant assertion now runs through the wizard (desktop project):

| Spec | Now covers |
|---|---|
| `recursive-decomposition.spec.ts` | Complex offer: create (planner 1) and saved-plan reuse (planner 0) each recover the 2 missed products in 1 residual pass; each object once with provenance; plain-field clean background; artifacts; dashboard; 10 editable editor layers (move, hide) |
| `protected-interactions.spec.ts` | Person + phone + badge + finger fragments as one layer on create and reuse; grouped held object still an editable field; graphic-fill clean background (no black, ≥90% true scene); move/hide in editor. Worn bangles with their hands (create and reuse); red field ≥95%, no ghosts |
| `curation.spec.ts` | 13 raw → 6 curated in preview, editor, reload; technical layers never fetched; Saved Runs search/filter; dashboard costs (₹49.71 = planner ₹10.22 + Seedream ₹39.49), raw layers, prompt copy, developer details, 390px; reading spends nothing; persisted failure (₹10.22 known + unknown) |
| `open-in-editor.spec.ts` | Each result its own design and canvas; campaign keeps 28 (and 30, no limit warning); reopen switches back; double-click makes one design; only `/opened` writes; launchers clear of zoom; edits persist after reload |
| `journey.spec.ts` (removed) | Prompt-from-image writer, "Write again" and size checkboxes were legacy-only. Launcher layout and edit persistence moved to `open-in-editor.spec.ts`; corrupt-upload refusal moved to `creative-templates.spec.ts` |

`legacy-image-to-layers.spec.ts` kept its flag-off checks; its Template A/B/C button expectation now expects the wizard's
library and Create New Template.

```sh
env OPENAI_API_KEY= FAL_KEY= GEMINI_API_KEY= CLOUDFLARE_API_TOKEN= npx vitest run server/src --maxWorkers=2
env OPENAI_API_KEY= FAL_KEY= GEMINI_API_KEY= CLOUDFLARE_API_TOKEN= npx vitest run client/src shared/src --maxWorkers=2
npm run build && npm run test:e2e:offline
npm run typecheck && npm run lint && git diff --check
```

## Clean background recovery

Every candidate background is judged on its own evidence, and every step records whether it ran and why
(`refinement.background.steps`, shown under **Run details → Background → Why each recovery step ran or was skipped**):

1. Seedream's base, then 2. its scene layers: kept when they no longer show an extracted layer (no call).
3. A local continuation (no call) only where the surroundings can be trusted: a plain field, a design of flat colors
   (98%+ of the colors around the hole within 8 of their 8 most common), or small removed areas. A large removed area on
   a shaded, gradient, textured or photographic background is not trusted: a local fill there smears or ghosts.
4. Otherwise the one image edit runs. 5. If it is unavailable or worse, the local fill is a fallback reported
   `degraded` with **Needs review** (`untrusted-continuation`), never "clean".

A layer counts as recreated only when its colors and (when it has 100+ strong outline pixels) its outline return, so a
white glow where a white product stood is not mistaken for the product. Darkening and residue are judged only against a
trusted continuation, and a seam only beyond the surroundings' own contrast. Calibrated on 30 saved live runs (offline
replay, no calls): every clean run kept its decision and cost; every visually dirty one now gets the recovery pass or is
flagged for review.

## Product replacement, plan reuse and fal 422 (2026-10-08)

**Confirmed from the saved live executions** (05-04-12, 05-04-43, 05-06-43, 05-10-38, read-only):

- The earbuds were never asked to change. "Main product" mapped only to the case slot; the two earbuds were unnamed
  supporting slots. The old prompt also said "Do not add or remove elements" and "Keep its composition: … the supporting
  product at the top…", which contradicts a replacement. The background, prop and decoration changes were followed.
- Both 422s (requests 01a119e8-93b7-7cb2-b7c9-462795933d79 and 01a119ec-18c8-7cb1-bfdb-762bf6bf3a57) decomposed the
  exact approved image (run original sha = generated sha) with the saved 7-layer plan. Each was `invalid_request` on
  `body.image_url` with 0 billable units, after the queue reported `IN_PROGRESS` for about 85 s. *Corrected later the
  same day:* an earlier version of this note called them "intake refusals" from fal's `Date` header. That header reads
  the submission second even for requests that ran for a minute, so it shows no processing stage.
- **Not confirmed:** what fal refused (see `docs/support/fal-seedream-layerize-422.md`). Its message is generic; the image and the prompt were both valid elsewhere.

**Now:**

- **Replacement.** The main product is replaced explicitly. Its original set (supporting products) is removed unless
  kept or described, and a new silhouette is allowed. No logos, specs or prices are invented. An optional product
  photo is sent as the second image.
- **Plan reuse.** Layout reuse (the creative template) and plan reuse (the decomposition blueprint) are separate:
  - *Compatible:* a recolor, restyle, text change or same-product detail change. The saved plan is reused with
    planner 0 and nothing extra is asked.
  - *Structural:* a different product, removed products, or an independent held object. These need an explicit plan
    choice before extraction, and an API caller must generate for review first (`PLAN_DECISION_REQUIRED`).
- **422 message.** It states what fal reported (type, field, billed units) and that the extraction failed, not the
  generation, with the generated creative kept. It no longer infers an "intake refusal" from fal's `Date` header.

## Backdrop layers and template CRUD (2026-10-08)

**Confirmed root cause.** Live runs 06:08 (create) and 06:19 (reuse) of "Subject Presenting Object" were traced from
image to editor. The planner's inventory was right: `orange_backdrop` was a "rounded graphic panel" with role
`backdrop`. The plan asked for it. Seedream returned it as its own layer (`layer-02.png`), transparent outside its
rounded shape. Post-processing merged it:

- `classify()` in `server/src/decomposition/recursiveDecomposition.ts` labelled any backdrop-named layer whose box
  covers at least half the canvas as `kind: 'background'`.
- Background recovery then built the "scene-composite" from the base plus that layer.
- `screenPlates()` in `layerUsefulness.ts` folded it as "a full background plate" (`merged-into-background`).
- Plan coverage still said `complete: true`. It checked Seedream's raw layers, and skips backdrop roles entirely.

**Fix.** `server/src/decomposition/backdropComponents.ts` decides which large scene layers are backdrop components.

- *Plan:* the plan's own role decides. `backdrop`, `decoration` and `prop` are components; the plan's `background` is
  the base. A reused plan's requested backdrop that no layer matched by words takes the largest unmatched solid scene
  layer.
- *Shape:* without a role, a solid, smooth (flat or gradient) shape touching at most 2 canvas edges is a component.
- *Never a component:* a full plate (≥ 90% of the canvas), a soft glow, a textured photographic region, or shapes that
  together cover ≥ 85% of the canvas.

No colour is special. Components become foreground layers, so the base is judged clean behind them; hiding one shows
the base. After curation, `plannedLayerIssues()` compares requested with returned layers. It warns
`PLANNED_LAYER_MERGED` or `PLANNED_LAYER_MISSING`; the execution and the wizard show it as a quality issue. A reuse
that finds a shape the plan does not name warns `TEMPLATE_PLAN_INCOMPLETE`.

**Evidence (offline replay of the two live runs, all providers blocked, 0 calls).**

| | Before | After |
|---|---|---|
| Editor layers | Background with the panel baked in, person | White base (provider base, clean), panel, person |
| Panel hidden | not possible | white canvas, no orange, no hole |
| Reconstruction vs approved image | mean Δ 3.1 | mean Δ 3.1 (06:08), 3.0 (06:19) |

The calibration covered every saved live refined run (29 scene layers). Only the 10 planner-named backdrops (panels,
arches, circles, inner backdrops) and 2 solid inset circles became separate. No textured, photographic, wall/floor or
glow layer was split. Existing templates all list a `backdrop` layer: their plans are valid and are reused as they are.

**Template CRUD.**

- Library cards have **Details**. They show the thumbnail, name and description, layers, plan, versions with
  provenance, recent runs and plan health.
- **Names and descriptions** are edited in place, validated on the client and the server.
- **Plan settings** (own layer per backdrop, decoration, prop, effect or companion; clean-up; expected layers) always
  save a new version. The plan is recompiled locally (0 planner calls); runs keep their version.
- **Update plan** is an explicit, priced new plan of the source creative. It is saved as the template's next version.
- **Delete** asks for confirmation. Saved runs, their images, layers and the template's versions stay.

## fal 422 on a new template (request 01a11a94-216e-76f3-b37c-c1352d684440, 2026-10-08)

- **Confirmed application defect.** Semantic protection (`protect()` in `semanticPlanner.ts`) merged the case lid
  (`keep_with_parent`) into the case base across the seated earbud. By the planner's own occlusion lists the earbud is
  in front of the lid and behind the base. The planner's prompt had 9 layers in a valid order; the rebuilt prompt sent
  7 layers, asking for the earbud behind a layer that also holds the lid behind it.
- **Fix.** A part never joins its parent across an independent layer that lies between them; it stays its own layer
  (`keptApart` in the run's protection record). Cast-shadow merges get the same check. Person protection (fingers, worn
  items, held objects) is unchanged. Of 36 saved planner answers, only this one and one unfinished run change.
- **Also corrected.** The 422 message no longer claims "refused at intake, nothing attempted". Every live 422 was
  `IN_PROGRESS` for 52–132 s first.
- **Verified upload path.** Each failing request's `image_url` serves our exact bytes (sha256 equal), as `image/png`,
  within all documented endpoint limits.
- **Not resolved.** Identical inputs both failed and succeeded (06:13/06:19), and role-only template plans with no
  contradiction were also rejected (08:28). The rest is on fal's side and unexplained; the support package is in
  `docs/support/fal-seedream-layerize-422.md`.

## Known limitations

- **Live behaviour is unverified.** Offline fakes prove control flow, prompts, gates and accounting, not live-model
  output. Whether gpt-image-2 replaces the earbuds with a speaker has not been run live (the fixture's "model" draws a
  speaker or keeps the phone on purpose). The review screenshots verify the fixture's images, not real ones.
- **The local review is a heuristic, not proof.** It can show that an original outline is still there. It cannot show
  that the new product is right, or that a redrawn product in another place is wrong. Exact shapes exist only when the
  edited image is the template's own source creative; otherwise only approximate zones (hints, never warnings).
- **The cause of the 422s is still unknown.** A simpler grouping sends a different prompt; whether fal then accepts is
  unverified.
- Executions saved before this change keep their old prompts, old 422 messages and kept earbuds. They can retry
  extraction, but their images still show the earbuds; generate again to get a replacement.
- The UI's Seedream estimate counts the template's independent layers. fal bills the layers it returns, which can be
  more.
- An image edit can redraw a removed object in another color or place (a pedestal); neither color nor outline catches it.
- Small foreground fragments outside every extracted layer (a footer text sliver) are not swept into the mask.
- Backdrop separation is a heuristic over provider layers. If Seedream itself bakes a panel into its base and returns
  no panel layer, nothing can separate it; the run then warns `PLANNED_LAYER_MISSING`.
- Without a plan role, a shape reaching three or more canvas edges (a band or field along a side) stays in the base.
  A planned backdrop reaching three edges is separated only through the plan.
- A separated panel's own drop shadow stays with the panel only if Seedream put it in the panel layer. Otherwise the
  cast shadow is removed from the base with the panel.
- The review gate's held-object check gave a false "may not have been replaced" on live run 06:12 (a card became a bat
  along the same diagonal). It is pixel evidence only; the person's tick decides.

## Smallest manual live test — not performed

Live steps need configured providers and may incur charges; none were run during development.
**Paid development calls: OpenAI 0 · GPT Image 0 · fal 0 · Seedream 0.**

One controlled run on the Product Trio template (`tpl-23031323ee3b` v1). Costs come from saved live runs of the same
creative: image edit ₹1.7–2.3, planner ₹9.9, Seedream ₹15–27 per extraction, background edit ₹2.3.

1. Reload the browser tab (the dev server has already reloaded the new server code), open **Create Template**, select
   **Product Trio with Backdrop v1** and press **Next**. Keep the template's own reference image.
2. Main product: **Replace product**, type `Bluetooth speaker`, brand `boAt`. Optionally add a product photo. Leave the
   supporting products unticked, so the earbuds are removed. Background: `warm yellow gradient`.
3. Check that **What will change** lists Replace main product, Remove ×2 and Restyle background. Open the final prompt;
   it must not say "Do not add or remove elements".
4. **Generate Creative** (one image call, about ₹2–3). Look at the image yourself: are the earbuds and case gone, and is
   a speaker there? Read the review. If the outline warning appears, the model kept the product: edit the request or
   add a photo, and regenerate (one more image call).
5. Tick the review, choose **Refresh decomposition plan** (one planner call, about ₹10; recommended, because the saved
   plan expects earbuds), then **Use this image**. Seedream costs about ₹15–27, plus about ₹2 if a background edit runs.
6. If fal answers 422: note the request id on screen and stop. Retry once with **simpler grouping** only if you choose
   to; it is another Seedream request, billed only if accepted.

Expected total: about ₹28–42, or about ₹18–32 with the saved plan.
