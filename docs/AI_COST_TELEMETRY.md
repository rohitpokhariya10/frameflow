# Decomposition dashboard: cost telemetry

The test dashboard reads `/api/layerize-experiment/runs/:id/diagnostics`. This is a **read-only projection** of persisted `run.json`, request/response files, raw-layer manifests and linked generation `group.json` records. It never submits, retries, polls, downloads provider output, or changes curation/import behavior. Refresh and server restart reconstruct the same facts from disk.

## One rate card

[`shared/src/aiPricing.ts`](../shared/src/aiPricing.ts) owns standard synchronous prices, model matching, confidence, totals and the ₹30–₹33 target. The server reads `AI_BUDGET_USD_INR`; positive numbers override the **₹90/$ project budget rate**. Missing/invalid values fall back to 90; invalid values are disclosed. This is not live FX. Calculations keep full precision and round only for display.

Prices checked on **7 October 2026**:

| Model | Input / cached / output per 1M tokens | Cache write |
|---|---|---|
| [GPT-5 Mini](https://developers.openai.com/api/docs/models/gpt-5-mini) | $0.25 / $0.025 / $2 | Not configured |
| [GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol) | $4 / $0.40 / $20 | $5 |
| [GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna) | $0.20 / $0.02 / $1.20 | Not configured |
| [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna) | $0.10 / $0.01 / $0.50 | $0.125 |

[GPT Image 2 standard rates](https://developers.openai.com/api/docs/pricing): image input $8/M, cached image $2/M, text input $5/M, cached text $1.25/M, image output $30/M. The page's **Standard → All models** table includes GPT Image 2; the visible Batch table has different rates. Recorded image/text token splits determine cost. Quality and returned image count are displayed but do not multiply token usage a second time.

[Seedream 5 Pro Layerize](https://fal.ai/models/bytedance/seedream/v5/pro/layerize): $0.03375 per generated raw layer below 1536² output-base pixels; $0.0675 above. The exact equality boundary is not specified in that wording: the dashboard conservatively uses the upper tier and labels it **Estimated**. Every residual response uses its own native output base size, never the original canvas or curated layer count.

Sol requests above 272k input tokens use the documented 2× input / 1.5× output multiplier. Input cache hits and writes are removed from ordinary input before their rates apply. Reasoning tokens are already included in output tokens and are not added twice. Unknown models retain their recorded name and have unknown cost; only dated snapshots inherit their exact alias's rate.

## Confidence and attribution

- **Recorded usage/calls:** provider response facts or persisted submission counters.
- **Calculated:** configured price × recorded usage. Not an exact provider invoice.
- **Estimated:** an explicit assumption, such as missing text cache detail or Seedream's exact size boundary.
- **Unknown:** missing response/usage/model/price or contradictory facts. The total is a **known subtotal + unknown**, never a false zero. Explicit provider zero billable units can establish zero charge.

Skipped stages and local processing cost ₹0 in additional API charges. Attempted calls are included even if they fail; uploads, downloads, status polling and saved-result rendering are not new paid model calls. Historical call counts inferred without counters are labeled.

The view includes linked source generation and the **full retained reference-analysis charge**. Analysis may be shared across ratios, and one generated image may have multiple decomposition runs: these views must not be summed as a unique account bill. Earlier generation/analysis attempts whose responses were overwritten remain unknown. Uploaded images without a linked source have no attributable generation charge in this run.

## Limits and offline validation

Prices are a versioned budgeting snapshot, not historical invoice reconciliation. Taxes, infrastructure, provider adjustments and payment fees are excluded. Missing historical artifacts cannot be recovered without provider billing records. Recorded runtime sums available stage durations; unavailable durations remain unrecorded. Raw curation dispositions and final editor counts describe different sets because several candidates can form one editor layer.

Tests cover cost math, cached input/write tokens, unknown/failed charges, native residual dimensions, source attribution, persistence, curated-only default rendering, collapsed prompts/raw layers, and desktop/narrow browser use. Browser fixtures use synthetic usage with fake providers and block outbound fetch; all real paid development calls remain zero.
