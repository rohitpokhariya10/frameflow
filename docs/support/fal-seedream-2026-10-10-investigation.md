# Seedream rejection investigation — 10 October 2026

**Status: the real 422 remains unresolved.** The saved responses prove that fal refused the requests, including a partner-labelled content refusal, but do not establish why its partner did so. No paid inference, upload, regeneration, retry, commit, or push was performed in this investigation. Safety checks stayed enabled.

## Evidence and its limits

All runs below are under `artifacts/decomposition/layerize-experiment/`. The original portrait template is a useful accepted control because it shares the failed creative's canvas. A second accepted PNG rules out a blanket rejection of PNG input.

| Observation | Accepted original template | Accepted PNG control | Rejected global edit | Rejected layered edit (latest) |
|---|---|---|---|---|
| Run suffix / UTC timestamp | `2026-10-08T09-00-18-516Z-8e6c7c` | `2026-10-09T17-40-37-385Z-805157` | `2026-10-09T19-16-20-486Z-13ee9a` | `2026-10-09T19-20-07-329Z-e733f7` |
| Request ID | `01a11abf-2888-7d10-a8c2-4676dc857079` | `01a121c0-bfa8-7202-8567-4d324ae08abb` | `01a12218-fc7c-7782-b03c-104db71f4219` | `01a1221b-d9a8-7fe3-ab5e-cabb13031509` |
| File / actual format / MIME | `original.jpg`, JPEG, `image/jpeg` | `original.png`, PNG, `image/png` | `original.png`, PNG, `image/png` | `original.png`, PNG, `image/png` |
| Signature prefix (hex) | `ffd8ffe000104a4649460001` | `89504e470d0a1a0a0000000d` | `89504e470d0a1a0a0000000d` | `89504e470d0a1a0a0000000d` |
| Dimensions / ratio / total pixels | 900×1600 / 9:16 / 1,440,000 | 1024×1024 / 1:1 / 1,048,576 | 900×1600 / 9:16 / 1,440,000 | 900×1600 / 9:16 / 1,440,000 |
| Encoded bytes | 130,247 | 1,776,817 | 2,482,846 | 2,442,485 |
| Channels / alpha / depth / space | 3 / none / 8-bit / sRGB | Same | Same | Same |
| ICC / EXIF / orientation tag | None / none / none | Same | Same | Same |
| Density | 72 DPI | 72 DPI | Unspecified | Unspecified |
| Full local decode | Passed | Passed | Passed | Passed |
| Current preflight on saved input | Byte-identical | Byte-identical | Byte-identical | Byte-identical |
| Historical normalization evidence | No orientation normalization; no preflight report recorded | Same | Same | Same |
| Prompt characters | 1,647 | 1,187 | 1,650 | 1,002 |
| Local requested layers | 15 in planner plan | No comparison needed | 8 in planner plan | Saved template recommends 15 |
| Actual `num_layers` field | Absent | Absent | Absent | Absent |
| Provider result / editor layers | 16 returned / 15 retained | 9 returned / 7 retained | 422 / none | 422 / none |
| Rejected field / type / reason | — | — | `body.image` / `content_policy_violation` / `partner_validation_failed` | `body.image_url` / `invalid_request` / no reason field |
| Recorded billable units | Not independently fetched | Not independently fetched | `0` | `0` |

Every request names `bytedance/seedream/v5/pro/layerize`. The application adapter is version `1`; the endpoint exposes no immutable deployment/weights version, so identical model weights cannot be established from these files.

All four recorded requests use exactly these six keys and types:

```text
image_url: string
prompt: string
image_size: string = "auto"
enhance_prompt_mode: string = "standard"
enable_safety_checker: boolean = true
sync_mode: boolean = false
```

Layer count is expressed through the prompt and local processing; it is not an unsupported numeric API field. The keys and values match the [official Seedream schema](https://fal.ai/models/bytedance/seedream/v5/pro/layerize/api). The same page requires 512²–6000² total pixels, ratio 1/16–16, and at most 30 MB. It does not specify a DPI requirement. Different density metadata is an observation, not evidence of a defect or reason to rewrite the images.

**Wire-evidence boundary:** both rejected responses include the provider's received input in `body.detail[0].input`; all non-URL values exactly match the local request record. Accepted runs have local request records and real downloaded result layers, but no independently persisted request echo or input URL. Do not present those accepted request records as packet captures.

The SDK upload route is `createFalTransport` → `client.storage.upload(Blob)` → fal media, with one-day expiry and public fetch ACL. The rejected responses retain their actual `v3b.fal.media` input URLs privately. Anonymous GETs of the two latest URLs returned HTTP 200, `Content-Type: image/png`, correct content lengths, and byte-for-byte matches to the local images. No API key was sent. URLs are intentionally omitted here. This proves accessibility from this machine at check time; it does not expose the partner's historical fetch logs.

Full image hashes:

```text
Accepted portrait: 79a40c56658c2c6f356e79002158f242f1cd830e18bf38c3559312417949fb10
Accepted PNG:      9031561e8de653f8d5b8a536c51d9d7d3c49cdb9f69371149bd0b6c0adf4a7cf
Rejected global:   641220089bd3abb8125e5f202bb7d9e5a204a6a4b94b9e75c4d080dba779cab9
Rejected layered:  230570970894885ebccc52e704fa097a80c377dc82dc54f6ce422081f1b1e36e
```

The served upload hashes equal the last two hashes. They also equal `edited.png` in executions `2026-10-09T18-44-32-011Z-cfe2b9` and `2026-10-09T19-18-33-446Z-a7e5b4`, respectively. The intended generated image was sent; it was not the source template or a mask.

The global image was rejected three times: `01a121fd-4209-7e00-acf4-4f003ec891fa`, `01a121ff-fa9d-7920-b528-0561056ab3f4`, and `01a12218-fc7c-7782-b03c-104db71f4219`. The prompts had 1,189, 949, and 1,650 characters. All reported the same partner reason and zero billable units. The later layered edit is a **different image**, rejected once with a different error type.

The provider messages were:

- Global image: “The content could not be processed because it contained material flagged by a content checker.”
- Layered image: “The provided image could not be processed for layer decomposition. Try a different image.”

[fal's error documentation](https://fal.ai/docs/documentation/model-apis/errors) classifies `content_policy_violation` as non-retryable. The partner's specific trigger is not disclosed. Nothing here identifies Apple branding, a flag, image content in general, prompt complexity, or missing DPI as the confirmed cause. Do not disable moderation or strip content to work around it.

A separate historical pair was also rechecked: requests `01a11a24-e030-70e1-8a24-c42aa446d5ad` (failed) and `01a11a2a-75ea-7803-b88d-ef535e7a0825` (done) had identical image SHA `b79f1527bd8946b9e811b4e4fb90d7ebcc121e3f92e4b129e3ad77dd9cdc7d8d` and identical non-URL parameter fingerprints. That is evidence of inconsistent outcomes for that older image. It is **not** proof that the current refused images are acceptable or that retrying them is appropriate.

## Local correction and focused verification

The reported residual-pass regression is not reproduced in the current checkout. `recursiveDecomposition.ts` and its test are unchanged from HEAD. The residual upload directly sends the saved residual bytes; it does not currently call the new preflight. The isolated “pass 1 misses the speaker” test passed in 6.78 seconds, including its exact-byte assertion. No assertions were weakened and neither file was changed.

One separate bug was reproduced: `prepareProviderImage` accepted a valid, unchanged PNG of 31,457,281 bytes, exceeding its own 31,457,280-byte limit. The size check only covered re-encoded images.

Changes made in this continuation:

- `server/src/decomposition/providerImage.ts`: enforce the same size limit before returning byte-preserved input. No new image transformations, density changes, or retries.
- `server/src/decomposition/providerImage.test.ts`: test exact-limit acceptance without changing bytes and one-byte-over-limit rejection.
- This report: distinguish observed evidence, unknowns, recovery limitations and the next diagnostic.

This correction applies to both features and template creation through their shared `executeRun` preflight. It does **not** explain the recorded 2.4 MB failures. Recursive and legacy worker uploads do not currently use that preflight; extending its conversion behavior without a demonstrated need was deliberately avoided. They have not been represented as newly corrected paths.

Verification passed: 29 focused tests total (isolated residual 1; image preflight 6; generic adapters 5; segmenter 3; synthetic editor import/recovery 3; service recovery 2; Seedream adapter/durable recovery 9), workspace plus browser-fixture typecheck, and targeted ESLint with zero warnings. One optional saved-data replay test was skipped because no replay environment was supplied. No full regression suite was run. `git diff --check` still identifies a pre-existing blank line at EOF in `smartCreative.test.ts`; that unrelated user file was left untouched.

## Real editor verification and recovery limits

An isolated Chromium context imported the accepted portrait run through the real `experimentToVariant` and asset repository, exported it with the actual Konva `exportPng`, moved just the dark phone layer by 40 pixels, and exported again. It imported all 15 layers on the original 900×1600 canvas; exactly one layer changed, and the second export changed. The original export differed from the saved server reconstruction by mean absolute RGB error 0.907/255 (maximum 67), so it is not claimed pixel-perfect. All API and non-local requests were blocked; no user browser storage or saved run was changed.

This proves import, independent movement and PNG export for an already successful real decomposition. It does **not** prove that either rejected creative has been decomposed.

The latest failed execution has three `edit-cutout-*.png` masks, but they came from the **original** phone image used during background editing. A local overlay visibly shows that they do not cover the replaced phones' final outlines. No `recovery-*` final-image masks or recovery run were saved. Reusing those old masks would cut off parts of the new products, so no fake “recovered” result was created.

Current supported paths:

| Path | What it actually provides | Limits / cost status |
|---|---|---|
| Seedream layerize | Background and multiple transparent semantic image layers; placement/z-order already supported by editor | Target creative remains refused; no successful new inference verified |
| Existing SAM-3 cutout recovery | Independent transparent product images on the final creative, plus a locally filled background | Needs masks of the **final** image; up to one segmentation call per product (three here); does not separate all text/props or reconstruct hidden scene detail |
| Flat preview | One editable image layer for the whole creative | Free/local; not object decomposition |
| Existing Qwen integration | Real RGBA layer proposals through `fal-ai/qwen-image-layered`, already adapted in the legacy pipeline | Official API remains documented; not wired as a drop-in creative-template retry; target acceptance, semantics, alignment, occlusion and reconstruction quality remain unverified |

[Qwen's official API](https://fal.ai/models/fal-ai/qwen-image-layered/api) describes RGBA layering with layer count, seed, PNG output and safety checking. Historical local Qwen jobs exist, but the existing pipeline treats these as proposals and uses further segmentation/registration. Do not advertise guaranteed complete scene reconstruction or editable vector text. No new alternative architecture was added.

## Next action and bounded diagnostic plan

**First action: send fal support the two latest request IDs and this sanitized evidence, asking which partner validation failed and whether a diagnostic replay is appropriate. Inference cost: $0.** Nothing has been sent to support automatically. Ask for the partner's input-fetch status, validation code, any category/model-moderation information, and endpoint deployment revision. No unsupported free “validation-only” inference endpoint was identified in the official schema.

If a paid diagnostic is later authorized, approve **one previously accepted portrait control** first: exact saved bytes, exact saved prompt/settings, no planner, no regeneration, no recursive pass, no background generation, no automatic retries. It can distinguish a presently failing endpoint/account path from an input-specific issue if compared with support's rejection trace. It cannot prove why the target failed, and one control success cannot prove the target will work.

The repository's 7 October budgeting table uses $0.03375/$0.0675 per returned layer. At its configured highest rate and the endpoint's 17-layer maximum, one call would be **estimated at at most $1.1475** (about ₹103.28 using the repository's budgeting rate of ₹90/USD). This is a local historical estimate, not a verified current fal quote or billing cap; confirm dashboard pricing before authorizing. The observed zero-unit failures do not guarantee another request is free.

No target resubmission, normalized copy, SAM call or Qwen call is authorized by this report. A normalized-copy experiment is not currently justified: the failed input already meets the documented contract. After provider clarification, one Qwen trial or three final-image SAM masks could evaluate alternatives with safety enabled; current prices for those were not established, and a cost cap must be agreed before execution.

Private recovery/evidence directory: `~/Documents/FrameFlow-recovery/fal-handoff-20261010-014254/`. It contains the verified pre-edit source snapshot, sanitized request comparisons, URL hash checks, historical control pair, mask overlay, and actual Konva exports. No credentials or signed URLs are included in this report or those diagnostic JSON files. Existing environment files, saved artifacts, Git branches and parked security stash were not modified.

## Update — 10 October 2026, later the same day (saved evidence only; no paid call)

**The latest "rejected" creative was decomposed.** Request `01a12257-…` (image `54ee26d1…`, the three phones on the flag background) was refused with the template's saved plan. Ten minutes later, at 20:34 UTC, the same execution (`2026-10-09T20-23-15-187Z-f08d88`) was retried with a refreshed plan. Request `01a12260-8cfb-7143-aefb-811fa77de7ae`, run `2026-10-09T20-34-21-169Z-186b33`, sent the **byte-identical PNG** (same SHA-256, same 2,170,966 bytes, no normalization). Seedream accepted it and returned 9 layers, giving 8 editor layers: three independent phones, ribbon, vine, confetti, divider and a clean flag background. The execution is `done`, and the run passes the editor-import replay. PNG versus JPEG, bytes, upload and transport are therefore ruled out for this image. The prepared JPEG is not needed for it.

**The two 422s behave differently in the saved runs:**

| Rejection | Saved evidence | What changes the outcome |
|---|---|---|
| `body.image_url` / `invalid_request` ("could not be processed for layer decomposition") | `54ee26…`: saved plan refused, refreshed plan accepted. `b79f15…` and `56d791…`: identical requests refused then accepted. The template's generic 15-layer plan was accepted on `9d98d1…`, where all 15 elements existed. It was refused on both images (`230570…`, `54ee26…`) where the edit had removed 9 of them. | The prompt and plan, plus some nondeterminism. Not the image bytes. |
| `body.image` / `content_policy_violation` / `partner_validation_failed` | `641220…`: refused 3 times with 3 different refreshed prompts. | Nothing tried so far. Treat it as a content-checker refusal of this image. |

**Two local defects in the Seedream request were found and fixed:**

1. The saved plan asked for layers of objects the edit had removed. The app had already flagged them itself (`compatibility: structural-change`, "the saved plan's layer for it has nothing to extract"). Saved and simple plans now leave those layers out (`withoutSlots`, `compile.ts`). On both real rejected executions the request drops from 15 layers to 7. One phantom remains (the top-right logo slot), because the change plan never marked it as removed.
2. "Simpler grouping" sent the **identical** prompt as the saved plan: 15 layers requested while 11 were expected locally. The plan text was not rebuilt from the simplified structure. It is now rebuilt, as a template version is saved (`restructured`, `compile.ts`).

These are evidence-backed fixes, not proof that every `invalid_request` is caused by the prompt: identical requests have also flipped. `partner_validation_failed` is not addressed by either fix.

**Alternative for a refused image: Qwen-Image-Layered.** It is offered only after a Seedream refusal, chosen and confirmed by a person, at one fal request (listed $0.05). It is never automatic, and Seedream stays the first extractor. `creativeTemplates/qwenLayers.ts` maps Qwen's layers back to the creative's canvas. The mapping was measured on all 9 saved Qwen results (3 aspect ratios). The layers are the input stretched to about 640² with sides rounded to multiples of 32, with no crop or padding. A free search over scale and offset converged exactly on that stretch every time. Every result is checked again before use and refused if it does not line up. Visible pixels come from the creative itself. Only areas hidden behind objects come from Qwen and are reported as AI-generated. On the 9 saved results, the editor redraw differs from the originals by 0.07–0.78/255. Whether Qwen accepts `641220…` is unknown until one authorized call.

**Support ticket:** the draft in `~/Documents/FrameFlow-recovery/fal-next-steps-20261010/` presents `01a12257-…` as the latest unresolved failure. Before it is sent, it should say that the same bytes were accepted 10 minutes later with another prompt (`01a12260-…`). The ticket should focus on the `partner_validation_failed` refusals of `641220…` and the nondeterministic `invalid_request`.
