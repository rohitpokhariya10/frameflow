# Template test generators: one creative, three aspect ratios (Templates A, B and C)

A test/admin harness inside the **OpenAI + Seedream test** panel: **Create Template A**, **Create Template B**,
**Create Template C**. It is served only by the local layerize experiment router (`LAYERIZE_EXPERIMENT=1`, never in
production).

For each template, a creative is defined once and generated as a **group** of aspect-ratio variants. Each variant can
then be sent, on its own, into the decomposition of **the same template**.

| Ratio | Size requested | Variant id |
|---|---|---|
| 1:1 | 1024 × 1024 | `1x1` |
| 16:9 | 1536 × 864 | `16x9` |
| 4:5 | 1216 × 1520 | `4x5` |

Template A's generator is described in detail in [TEMPLATE_A_GENERATION.md](TEMPLATE_A_GENERATION.md); it behaves as
it did before Templates B and C were added. This document covers what the three share, what they do not, and
Templates B and C.

## The rule: shared mechanics, separate semantics

```
shared multi-ratio mechanics  (knows nothing a template means)
        ├── Template A generation profile + handoff
        ├── Template B generation profile + handoff
        └── Template C generation profile + handoff
```

**Shared** (one implementation, used by all three):

| What | Where |
|---|---|
| Ratios, sizes, variant ids, prompt limits, field validation mechanics, `base + consistency + framing` | `shared/src/templateGeneration.ts` |
| Group and variant records, statuses, the serial queue, retry of one variant, interrupted work, history, images | `server/src/decomposition/generationGroups.ts` |
| The routes, registered once per template under that template's own path | `server/src/decomposition/layerizeRouter.ts` |
| The form state, the requests, the choice of decomposition control | `client/src/features/decomposition/templateGeneration.ts` |
| The screen: form, shared prompt, ratio cards, history | `client/src/features/decomposition/TemplateGenerator.tsx` |

The shared layer also offers options a profile may opt into, and knows nothing of what they are used for: a plain
form (`tagline`, `intro`; `placeholder`, `examples`, `multiline`, `options` and `advanced` on a field), `upgradeFields`
for reading field values stored by an earlier version of the same profile, and `referenceInstruction` for making the
further ratios of a creative from the first finished image. Today only Template B sets them; Templates A and C set
none, keep their flat form, and generate every ratio from its prompt independently.

**Per template** (one module each, used by no other template):

| What | Template A | Template B | Template C |
|---|---|---|---|
| Fields, validation, prompt skeleton, consistency sentence, framing per ratio, notes | `shared/src/templateAGeneration.ts` | `shared/src/templateBGeneration.ts` | `shared/src/templateCGeneration.ts` |
| Decomposition handoff | `server/.../templateAGeneration.ts` | `server/.../templateBGeneration.ts` | `server/.../templateCGeneration.ts` |
| Decomposition control | held-object checkbox | the options Template B declares | the options Template C declares |
| Records folder | `artifacts/decomposition/template-a-generations/` | `.../template-b-generations/` | `.../template-c-generations/` |

There is no prompt builder that branches on the template. `shared/src/templateGenerationProfiles.ts` is the only place
the three profiles are named together, and it only picks one by key.

`server/src/decomposition/generationHandoff.ts` is the handoff *mechanism* used by templates that are steered by their
own declared options (B and C). Which options exist, what they are called and what they mean stays in the
decomposition template that declares them (`layerizeTemplateB.ts`, `layerizeTemplateC.ts`); nothing is copied.

## Expected consistency

The three images of a group are the **same creative family**: the same subjects or products, the same visual identity
and theme, the same modules and object relationships, framed or reflowed for each ratio.

They are **not** pixel-identical, and nothing claims they are. Each ratio is a separate text-to-image request made
from the same description. What the description pins down is the same in all three; what it does not pin down can
differ (a face, a reflection, where exactly a module sits).

How close they come out has **not been measured**: no image has been generated with any of the three generators (see
"Not validated live"). If manual testing shows unacceptable identity drift, that is to be reported, not hidden.

Templates A and C generate each ratio as a separate text-to-image request. Template B goes further: it generates one
ratio first and makes the others from that image (see "How the three ratios are generated" under Template B).

## How a variant's prompt is built (every template)

```
fields  →  built prompt ─┐
                         ├→  base prompt (one per creative)
edited by hand (opt-in) ─┘
base prompt + the template's consistency sentence + the template's framing sentence for the ratio  →  the variant's prompt
```

- Deterministic; no LLM rewrites anything.
- The framing sentence is the only thing that differs between the prompts of one creative.
- The client never sends a variant's final prompt; a request that carries one is refused (`PROMPT_NOT_ACCEPTED`).
- A base prompt over 2000 characters is refused, never cut. A variant's whole prompt is at most 3000.
- The consistency and framing sentences of B and C name optional parts only "where any are described", so they never
  ask for a support, an object, a panel or a headline the creative does not have.

## Template B: product-focused advertising creative

One clearly dominant product, object, dish, piece of furniture or gadget on a designed background; optionally on a
support, with optional independent objects around it and decorative elements. No people.

The user gives the creative intent. Template B knows its own family and adds the structure.

### The form: three inputs (generation version 3)

| Label | Key | Required | Limit | Helper | Placeholder |
|---|---|---|---|---|---|
| Main product | `mainProduct` | yes | 120 | What do you want this creative to feature? | e.g. lavender premium smartphone |
| Scene / visual style | `sceneStyle` | yes | 500 | Describe the look and setting you want around the product. | e.g. premium pastel studio with soft lavender spheres |
| Extra details | `extraDetails` | | 300 | Anything specific you want the product or composition to show. | e.g. show the back of the phone, no text |

All three start empty. Each shows its helper and examples under it and a Required or Optional tag. Two small choices
are folded under **Advanced options**; most users never open it:

| Label | Key | Choices |
|---|---|---|
| Product angle | `productAngle` | Auto (default), Front, Three-quarter, Side |
| Text in the image | `imageText` | Avoid text and logos (default), Allow text I describe |

Labels, helpers, placeholders and examples are presentation only and never reach a prompt. An answer longer than its
limit is refused with a message ("Scene / visual style is 501 characters; at most 500."), never cut. The limits are
chosen so that a completely filled form still fits the 2000-character base prompt; a typical creative is 850 to 1050.

An untouched empty form shows no error: it says "To generate, fill in: Main product, Scene / visual style." A required
input that was filled and emptied again is marked where it is.

### What Template B adds itself

The prompt is the user's intent followed by a fixed structure (`buildTemplateBGenerationPrompt`), deterministic, each
rule said once:

```
Create a premium product advertising image featuring one {main product} as the single, clearly dominant hero.
Scene and visual style: {scene / visual style}.
Requested details: {extra details}.                                   (only when given)
The hero's own parts, contents and markings stay with it; anything the scene places around or under it (objects, a
  platform, graphic shapes) is a separate element, complete and clearly distinguishable from the hero.
Show the hero whole and intact, large in the frame[, seen from the front | in a three-quarter view | seen from the
  side]; unless described otherwise, use soft professional advertising lighting with gentle shadows and a balanced
  composition.
Keep a clean commercial hierarchy: the hero, the elements around it and the designed background are visually
  distinct, with clean edges.
Polished, sharp, high-resolution finish. No people or hands, no extra copies of the hero, no unrelated props, no
  clutter, and no text or logos except what is on the hero itself.
```

- **One hero**, unless the user asks for a number: "lavender smartphone" and "a lavender smartphone" are one; "two
  ceramic lamps" is what it says.
- **Intrinsic vs independent** is not the user's job. They write "soft lavender spheres around the phone" or "a white
  platform and a pink graphic shape" in the scene; the structure declares whatever the scene puts around or under the
  hero a separate element. That is what lets the decomposition, and its touching-objects option, tell them apart later.
- **Lighting and composition** are defaults, worded "unless described otherwise", so a scene that asks for something
  else wins. No photographic style is forced on a scene that asks for a 3D or poster look.
- **Text** is avoided by default. "Allow text I describe" lifts only that rule and adds "Show only the text the
  description asks for, short and legible."

Validation of its own: the main product must be an object. "young woman" is refused; "woman's handbag" is not.

Notes (never blocking): a transparent or reflective product; objects that touch or overlap the product (points at the
decomposition option); allowed text (lettering is often misspelt).

### The prompt preview

The shared creative prompt is shown under the inputs as something to review: "Built automatically from your Template B
inputs. You can review it before generation." **Edit shared prompt** switches to an editable box with an "Edited by
hand" badge and "Editing this prompt overrides the automatic prompt for this creative." **Discard edit** rebuilds the
prompt from the inputs; the same inputs always build the same prompt.

### How the three ratios are generated: by image, not by words alone

The installed OpenAI SDK (`openai` 7.23.0, `resources/images.d.ts`) documents `images.edit` for `gpt-image-2` with one
or more input images and arbitrary `WIDTHxHEIGHT` sizes. Template B uses it to keep its ratios together:

```
first ratio asked for   →  images.generate(prompt)                                   the original
each further ratio      →  images.edit(image = the original, prompt + one sentence)  the same creative, reframed
```

- The prompt of every ratio is still `base + consistency + framing`; a reference-based ratio adds Template B's
  `referenceInstruction` ("The attached image is this same creative in another aspect ratio. Recreate it for this
  frame ... Change the framing only ...").
- Only parameters the SDK lists are sent: `image`, `prompt`, `model`, `size`, `n`, `output_format`. Same model.
- The reference is the first finished ratio that was itself generated from its prompt, so copies are not made of copies.
- **Nothing depends on the first ratio succeeding.** If it fails, the next ratio is generated from its prompt and
  becomes the reference. A failed ratio never touches its siblings, and one ratio can be generated again on its own.
- **A reference-based ratio that failed** can be generated "from the prompt only" from its card (`{ independent: true }`).
- **Switch:** `TEMPLATE_RATIO_REFERENCE=off` in `server/.env` makes new Template B creatives generate every ratio
  independently, as Templates A and C do.
- A group records how it was made (`ratioStrategy: "reference"`), and each variant which image it was made from
  (`reference`). Groups without it, which is every earlier group and every Template A and C group, generate each ratio
  independently, as before.

This is the mechanism for "three adaptations of the same creative". It does not make them pixel-identical, and how
well an edit to a different aspect ratio reframes a creative has **not been validated live**.

Decomposition: **Template B**, with its option `separateTouchingIndependentObjects` ("Separate touching / overlapping
independent objects", default off). Nothing about the decomposition changed; an image made from a reference decomposes
exactly like one made from text.

### Earlier forms and their records

| Version | Fields | Status |
|---|---|---|
| 1 (committed in `b3b66c6`) | 14: `heroProduct`, `heroDescription`, `material`, `intrinsicDetails`, `placement`, `support`, `secondaryObjects`, `decoration`, `foregroundAccents`, `background`, `composition`, `lighting`, `palette`, `extraNotes` | read-only |
| 2 (never committed) | 5: `heroProduct`, `productLook`, `scene`, `extras`, `extraInstructions` | read-only |
| 3 | `mainProduct`, `sceneStyle`, `extraDetails` + `productAngle`, `imageText` | current |

How earlier fields map into today's inputs (`upgradeTemplateBFields`):

| Today | From version 1 | From version 2 |
|---|---|---|
| Main product | `heroProduct` | `heroProduct` |
| Scene / visual style | `background`, `lighting`, `palette`, `support`, `secondaryObjects`, `decoration`, `foregroundAccents` | `scene`, `extras` |
| Extra details | `heroDescription`, `material`, `intrinsicDetails`, `placement`, `composition`, `extraNotes` | `productLook`, `extraInstructions` |

- Earlier records are **not migrated or rewritten**. They keep their version, fields, prompts, images and
  decomposition links. They are listed and shown as stored; a ratio they never generated is generated from the prompt
  they stored, independently; their images decompose through Template B as before.
- **Load this creative into the form** fills today's inputs from the stored fields, using the mapping above. The stored
  record is not changed. A mapped value longer than an input's limit shows the usual "at most N" message.
- New creatives take only today's fields. A request that carries an earlier field is refused (`INVALID_FIELDS`).

## Template C: people and campaign modules

A designed, human-centric campaign layout that is more than a single portrait: several people, or a person with an
independent product showcase or promotional module, or repeated panels; optional badge, headline and decorative
structures.

| Field | Key | Required | Default (an example, not a rule) |
|---|---|---|---|
| Campaign / creative concept | `concept` | yes | seasonal sale campaign for a clothing brand |
| Primary subject(s) | `primarySubjects` | yes | two people standing side by side, a woman in a yellow jacket and a man in a denim shirt |
| Additional human subjects | `additionalSubjects` | | |
| Relationships / grouping between people | `relationships` | | standing apart with a clear gap between them |
| Repeated panels / modules | `repeatedPanels` | | |
| Product showcase | `productShowcase` | | |
| Promo card / module | `promoModule` | | a rounded offer card in the lower right corner |
| Logo / badge | `logoBadge` | | a small round badge in the top left corner |
| Headline text | `headline` | | |
| Decorative structures | `decorativeStructures` | | |
| Background / campaign environment | `background` | yes | bold coral backdrop with large graphic sun rays |
| Colour palette | `palette` | | |
| Composition | `composition` | | |
| Lighting / style | `lightingStyle` | | |
| Extra notes | `extraNotes` | | |

Fixed structure: a composed modular layout, not a candid photograph; every person whole, with what they wear; a
product showcase independent of anything worn or held; a promotional module as its own region; repeated panels as one
coherent set; background graphics distinguishable; only the people described, no crowd.

Notes (never blocking): one person and no module is a single portrait (Template A, not C); several people (points at
the people option); repeated panels (points at the panel option); a headline (generated lettering is often misspelt,
and it is decomposed as picture, not editable text).

Decomposition: **Template C**, with its options `separateHumanSubjects` ("Separate individual people / human
subjects") and `separateRepeatedModules` ("Separate repeated subject / showcase panels"), both default off.

## Isolation

- A template's generator accepts only its own fields. Another template's creative is `INVALID_FIELDS`.
- A group is served, generated and decomposed only through its own template's routes. Through another template's it
  is `404`, even if its folder were copied into the other template's directory (`ownGroup`).
- "Decompose" always runs the group's own template. The request may carry only that template's settings:

  | Template | Accepts | Refuses |
  |---|---|---|
  | A | `separateHeldObject`, `targetLayers`, `skipFitCheck` | `templateOptions` and anything else → `INVALID_REQUEST` |
  | B | `templateOptions` (its own key), `targetLayers`, `skipFitCheck` | `separateHeldObject` → `INVALID_REQUEST`; C's option keys → `INVALID_TEMPLATE_OPTIONS` |
  | C | `templateOptions` (its own keys), `targetLayers`, `skipFitCheck` | `separateHeldObject` → `INVALID_REQUEST`; B's option key → `INVALID_TEMPLATE_OPTIONS` |

- In the UI, which kind of control a template has is fixed per template (`GENERATION_DECOMPOSITION`). Template A's
  cards show the held-object checkbox; B's and C's show the options their decomposition template declares, read from
  the server's template list. One template's control is never shown for, or sent with, another.
- Switching generators remounts the screen for that template: nothing of one form carries into another.

One change to Template A's endpoint follows from this: its decompose request used to ignore unknown body keys; it now
refuses them. The app only ever sent `separateHeldObject`.

## Data model

One folder per creative, in its template's folder. The record is the same shape for every template:

```
group.json
  id, templateKey, version, createdAt, updatedAt
  fields            the shared creative definition (the template's own fields)
  builtPrompt       from the fields
  basePrompt        what every variant uses (built, or edited)
  promptEdited
  structure         Template A only: { visibleBorder, heldObject }
  notes             Templates B and C, when there are any
  ratioStrategy     "reference" on a Template B creative whose further ratios are made from the first finished image
  aspectRatios      ["1:1", "16:9", "4:5"]
  variants[]
    id, aspectRatio, size
    status          pending | queued | generating | done | failed
    framing, prompt                       the exact prompt sent
    generator       { provider, model, requestId }
    attempts, requestFile, responseFile, startedAt, finishedAt, durationMs
    image           { file, mimeType, width, height, bytes, sha256 }
    reference       { variantId, aspectRatio, file, sha256, instruction }   when the last attempt was made from another variant's image
    error           { code, message, status, messages, bodyFile }
    decompositions  [{ runId, createdAt, targetLayers?, separateHeldObject (A) | templateOptions (B, C) }]
```

A decomposition run made from a variant records where it came from:
`templateKey` and `origin: { kind: "<templateKey>-generation", generationId, variantId, aspectRatio }`.

Template A records written before this change, and the one-image records from before groups, are read as they are.
Nothing is migrated or rewritten.

## Endpoints

The same set under `/api/layerize-experiment/template-a`, `/template-b` and `/template-c`:

| Request | Does |
|---|---|
| `GET /generator` | The template's fields, skeleton, consistency and framing sentences, ratios, sizes, limits, image model |
| `GET /groups`, `GET /groups/:id` | History, one group |
| `POST /groups` `{ fields, basePrompt?, aspectRatios? }` | New creative; answers at once, variants follow in the background |
| `POST /groups/:id/variants/:variant/generate` `{ independent? }` | One failed or not yet generated variant; `independent: true` = from its prompt alone |
| `GET /groups/:id/variants/:variant/image` | The image exactly as generated |
| `POST /groups/:id/variants/:variant/decompose` | A run of that image with the group's own template (body: see Isolation) |

Variants are generated one at a time, in the order asked for, across all three templates.

## Cost

One paid OpenAI image request per variant generated (three for a full creative). One decomposition is one OpenAI
planner request and one paid Seedream Layerize request. Every button that spends says so; generating asks first.

## Tests (all with fake providers)

| File | Covers |
|---|---|
| `shared/src/templateBGeneration.test.ts`, `templateCGeneration.test.ts` | Each template's fields, validation, prompt structure, edge cases, notes, ratio prompts, no foreign semantics, no hard-coded examples |
| `shared/src/templateGenerationProfiles.test.ts` | One profile per template; no shared wording; cross-template field refusal; Template A's texts pinned |
| `server/src/decomposition/templateBCGeneration.test.ts` | Groups, one failure, retry of one, decomposition routed to the right template with the right options, refusals, separate folders, earlier Template A records, the shared queue |
| `server/src/decomposition/templateAGeneration.test.ts`, `shared/src/templateAGeneration.test.ts`, `client/.../templateAGeneration.test.ts` | Template A, unmodified |
| `client/src/features/decomposition/templateGeneration.test.ts` | The form per template; which decomposition control each template shows and sends |
| `tests/e2e/template-generators.spec.ts` | The three generators in the browser, the experiment API faked inside the page |

`templateBCGeneration.test.ts` replaces `fetch` for its duration: a request to anything but its own local test server
throws and fails the test. The e2e spec fails on any request the in-page fake does not know or that leaves
`127.0.0.1`.

## Not validated live

Built and tested with fake providers only. No OpenAI, fal or Seedream request has been made with any of this.

- **Template B's reference-based ratios.** Whether `images.edit` with `gpt-image-2` accepts the request as built,
  whether an edit to a different aspect ratio reframes the creative well or distorts it, how close the three ratios
  then are, and what it costs compared with a plain generation. If it does not work, `TEMPLATE_RATIO_REFERENCE=off`
  restores three independent generations, and a single ratio can be generated "from the prompt only".

- Whether the Template B and Template C prompts produce the intended compositions at all.
- How consistent the three ratios look for B and C, in particular whether 16:9 stays the same creative, and whether
  Template C keeps the same people and the same number of modules.
- Whether generated B and C images decompose well with their templates, per option.
- Whether a generated headline (Template C) is legible.
- Everything listed under "Not validated live" in [TEMPLATE_A_GENERATION.md](TEMPLATE_A_GENERATION.md): the three
  sizes, latency, cost, real error responses.
