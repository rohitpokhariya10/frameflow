# Template A test generator: one creative, three aspect ratios

A test/admin harness inside the **OpenAI + Seedream test** panel (button **Create Template A**). It is served only by
the local layerize experiment router (`LAYERIZE_EXPERIMENT=1`, never in production).

A Template A creative is defined once and generated as a **group** of aspect-ratio variants:

| Ratio | Size requested | Variant id |
|---|---|---|
| 1:1 | 1024 × 1024 | `1x1` |
| 16:9 | 1536 × 864 | `16x9` |
| 4:5 | 1216 × 1520 | `4x5` |

Each variant can then be sent, on its own, into the existing Template A decomposition (OpenAI planner → fal Seedream
Layerize → local layer count). The decomposition pipeline is unchanged.

## Target behaviour: creative identity consistency

The three images are aspect-ratio variants of the **same creative**: the same subject, styling, held object, inner
region, border and backgrounds, and the same ad concept, reframed for each ratio.

They are **not** pixel-identical, and the system does not claim they are. Each ratio is a separate text-to-image
request made from the same description. What the description pins down is the same in all three; what it does not pin
down (the exact face, the exact folds of a fabric, small pose details) can differ. How close the three come out has
not been measured yet: no image has been generated with this flow (see "Not validated live").

## How the prompts are built

```
fields  →  built prompt ─┐
                         ├→  base prompt (one per creative)
edited by hand (opt-in) ─┘
base prompt + consistency sentence + framing sentence of the ratio  →  the prompt of that variant
```

- **Base prompt:** the fixed Template A skeleton filled from the fields (`buildTemplateAPrompt`), deterministic, no
  LLM rewrite. The user may edit it with **Edit shared prompt**; the edit replaces the base for every ratio alike.
- **Consistency sentence:** `TEMPLATE_A_CONSISTENCY`, the same words in every variant.
- **Framing sentence:** `TEMPLATE_A_RATIO_FRAMING[ratio]`, fixed text per ratio. It is the only thing that differs
  between the prompts of one creative, and it cannot be edited.
- The client never sends a variant's final prompt; a request that carries one is refused (`PROMPT_NOT_ACCEPTED`).
- Every exact prompt can be read before generating (under "What each aspect ratio adds…") and afterwards on each card.

All of this is in `shared/src/templateAGeneration.ts`, shared by the server (which builds what it sends) and the client
(which shows it).

## Data model

One folder per creative: `artifacts/decomposition/template-a-generations/<groupId>/`.

```
group.json
  id, createdAt, updatedAt, version: "template-a-generation-v3"
  fields            the shared creative definition
  builtPrompt       from the fields
  basePrompt        what every variant uses (built, or edited)
  promptEdited
  structure         { visibleBorder, heldObject }: what a decomposition's defaults follow
  aspectRatios      ["1:1", "16:9", "4:5"]
  variants[]
    id, aspectRatio, size
    status          pending | queued | generating | done | failed
    framing, prompt
    generator       { provider, model, requestId }
    attempts, requestFile, responseFile, startedAt, finishedAt, durationMs
    image           { file, mimeType, width, height, bytes, sha256 }
    error           { code, message, status, messages, bodyFile }
    decompositions  [{ runId, createdAt, separateHeldObject, targetLayers }]

<variant>.image.png
<variant>.openai-request.json
<variant>.openai-response.json      the response without the image bytes
<variant>.provider-error.json       only after a provider error
```

Ratio-specific data lives only inside its variant; nothing a variant does changes the shared fields or prompts.

A decomposition run made from a variant records where it came from:
`origin: { kind: "template-a-generation", generationId: <groupId>, variantId, aspectRatio }`.

## Rules

- **Generate always makes a new group.** Changing a field or the prompt and generating again never rewrites an
  earlier group.
- **Variants are independent.** One failing leaves the others as they are.
- **Generate a ratio later.** Untick a ratio to leave it "not generated"; generate it, or a failed one, from its card.
- **A finished variant is never regenerated**, because decomposition runs may point at its image.
- **Only a variant with an image can be decomposed.**
- **One request at a time.** Variants are generated in the order asked for; none is resent automatically.
- **Interrupted work.** A variant left "queued" or "generating" by a stopped server is shown as failed (interrupted)
  and can be generated again.
- **Older records.** One-image records from before groups (`generation.json`, all 2:3) are listed as single-image
  creatives and can still be decomposed. They are never converted or regenerated.

## Endpoints (`/api/layerize-experiment/template-a`)

| Request | Does |
|---|---|
| `GET /generator` | Fields, ratios, sizes, consistency and framing sentences, limits, image model |
| `GET /groups`, `GET /groups/:id` | History, one group |
| `POST /groups` `{ fields, basePrompt?, aspectRatios? }` | New creative; answers at once, variants follow in the background |
| `POST /groups/:id/variants/:variant/generate` | One failed or not yet generated variant |
| `GET /groups/:id/variants/:variant/image` | The image exactly as generated |
| `POST /groups/:id/variants/:variant/decompose` `{ separateHeldObject?, targetLayers?, skipFitCheck? }` | A Template A run of that image |

## Cost

One paid OpenAI image request per variant generated, so three for a full creative. One decomposition is one OpenAI
planner request and one paid Seedream Layerize request. Every button that spends says so, and generating asks for
confirmation first.

## Not validated live

Built and tested with fake providers only; no OpenAI, fal or Seedream request has been made with this flow.

- Whether `gpt-image-2` accepts the three sizes, in particular the non-standard 1536 × 864 and 1216 × 1520.
- How consistent the three ratios actually look, and whether the framing sentences give good compositions.
- Whether the 16:9 image decomposes well with Template A (its sizes pass Seedream's local size check).
- Latency per image against the 300 s timeout, and cost at the API's default quality.
- Real provider error responses (the mapping was written from the SDK's error shape).

If the three ratios drift too far apart in practice, the next step is to generate one ratio first and produce the
others from it as a reference image, instead of from text alone.
