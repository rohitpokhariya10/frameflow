# FrameFlow: Image Generation + Decomposition Cost

**Prepared: 7 October 2026**

**Current estimated AI cost: ₹53–₹56 per image.** Replacing only the decomposition planner could reduce this to **₹44–₹47 with GPT-5 Mini** or **₹43–₹46 with Luna**, subject to quality validation.

Basis: saved FrameFlow usage, one medium-quality image, 12–13 raw layers, and **₹90/$ for budgeting, not a live exchange rate**. Taxes, FX/payment fees, hosting, storage, and extra calls are excluded.

**Current cost breakdown**

| Step | Current provider/model | Estimated cost per image |
|---|---|---:|
| Read the reference and create the prompt | GPT-5 Mini | ₹0.41 |
| Generate the image | GPT Image 2, medium quality | ₹5.90 |
| Plan the editable layers | GPT-5.6 Sol | ₹10.22 |
| Generate 12–13 raw layers | Seedream 5 Pro Layerize | ₹36.45–₹39.49 |
| Curate layers and open the editor | Local processing | ₹0 additional API cost |
| **Total** | | **₹52.98–₹56.01** |

Generation includes input and output costs at [OpenAI's image rates](https://developers.openai.com/api/docs/guides/image-generation). The full reference-analysis cost is assigned to one image here; it can be shared across variants. Totals use unrounded values. The saved Sol response includes 3,373 cache-write tokens, billed at the published cache-write rate; this adds ₹0.30 versus the earlier estimate.

**Cost if we change only the decomposition planner**

| Planning model | Planning alone | Total: 12 raw layers | Total: 13 raw layers |
|---|---:|---:|---:|
| [GPT-5.6 Sol — current](https://developers.openai.com/api/docs/models/gpt-5.6-sol) | ₹10.22 | ₹52.98 | ₹56.01 |
| [GPT-5 Mini](https://developers.openai.com/api/docs/models/gpt-5-mini) | ₹0.95 | ₹43.70 | ₹46.74 |
| [GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna) | ₹0.58 | ₹43.34 | ₹46.37 |
| [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna) | ₹0.25 | ₹43.00 | ₹46.04 |

Alternatives assume the same **3,376 input + 4,835 output tokens**, including reasoning, and unchanged layer counts/calls. Potential saving: **₹9–₹10 per image**, or **₹9,000–₹10,000 per 1,000 images**. These are estimates, not measured Luna/Mini results.

**Why are we not already using Mini or Luna for planning?**

- **GPT-5 Mini already handles reference analysis.** Sol is the current decomposition-planner default.
- Planning determines how people, products, text, and attached objects are separated. Mini/Luna have not been validated against Sol on representative images; this does not mean they are unsuitable.
- Compare quality and total cost before switching. This replaces planning only, while GPT Image and Seedream costs remain.

**What can increase the bill?**

- Seedream charges **$0.03375 per raw generated layer** when the base image is below 1536 × 1536 in total pixel area. Above that threshold, it charges **$0.0675 per layer**. See [fal's pricing](https://fal.ai/models/bytedance/seedream/v5/pro/layerize).
- **13 raw layers curated into 6 editor layers are still billed as 13 generated layers.** Local curation does not refund generation costs.
- Extra residual passes, AI background edits, regeneration, higher image quality, and additional aspect ratios increase costs.

These are **AI API estimates, not full operating costs or a guaranteed price cap**. No paid calls or model changes were made for this report.
