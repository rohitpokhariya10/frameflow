/**
 * Provider prices used for estimates and usage-derived costs.
 *
 * Source: https://developers.openai.com/api/docs/pricing and the image
 * generation guide, checked 2026-10-10. Standard (not Batch/Flex) processing,
 * short context (≤272K input tokens). The OpenAI billing dashboard is
 * authoritative; update RATE_CARD_VERSION whenever these numbers change.
 *
 * All money is integer micro-USD (1 USD = 1_000_000).
 */

export const RATE_CARD_VERSION = "openai-standard-2026-10-10";

/** USD per 1M tokens → micro-USD per token is the same number. */
export interface TextModelRates {
  kind: "text";
  input: number;
  cachedInput: number;
  output: number;
  /** Vision tokens per 32px patch; null when the provider doesn't publish it. */
  visionPatchMultiplier: number | null;
  /** Long-context tier applies above this many input tokens; we never send that much. */
  longContextThreshold: number;
}

export interface ImageModelRates {
  kind: "image";
  textInput: number;
  imageInput: number;
  imageOutput: number;
  /**
   * Published per-image output cost in micro-USD, by quality and size. Used for
   * estimates; actual cost comes from returned usage.
   */
  outputPerImage: Partial<Record<string, Partial<Record<"low" | "medium" | "high", number>>>>;
}

export type ModelRates = TextModelRates | ImageModelRates;

const usd = (v: number) => Math.round(v * 1_000_000);

export const RATE_CARD: Record<string, ModelRates> = {
  "gpt-6-luna": { kind: "text", input: 0.1, cachedInput: 0.01, output: 0.5, visionPatchMultiplier: null, longContextThreshold: 272_000 },
  "gpt-5.6-luna": { kind: "text", input: 0.2, cachedInput: 0.02, output: 1.2, visionPatchMultiplier: 1.2, longContextThreshold: 272_000 },
  "gpt-5.6-terra": { kind: "text", input: 2, cachedInput: 0.2, output: 12, visionPatchMultiplier: 1.2, longContextThreshold: 272_000 },
  "gpt-5.4-nano": { kind: "text", input: 0.2, cachedInput: 0.02, output: 1.25, visionPatchMultiplier: 1.2, longContextThreshold: 272_000 },
  "gpt-5.4-mini": { kind: "text", input: 0.75, cachedInput: 0.075, output: 4.5, visionPatchMultiplier: 1.2, longContextThreshold: 272_000 },

  "gpt-image-2": {
    kind: "image",
    textInput: 5,
    imageInput: 8,
    imageOutput: 30,
    outputPerImage: {
      "1024x1024": { low: usd(0.006), medium: usd(0.053), high: usd(0.211) },
      "1024x1536": { low: usd(0.005), medium: usd(0.041), high: usd(0.165) },
      "1536x1024": { low: usd(0.005), medium: usd(0.041), high: usd(0.165) },
    },
  },
  "gpt-image-1-mini": {
    kind: "image",
    textInput: 2,
    imageInput: 2.5,
    imageOutput: 8,
    outputPerImage: {
      "1024x1024": { low: usd(0.005), medium: usd(0.011), high: usd(0.036) },
      "1024x1536": { low: usd(0.006), medium: usd(0.015), high: usd(0.052) },
      "1536x1024": { low: usd(0.006), medium: usd(0.015), high: usd(0.052) },
    },
  },
};

/**
 * Documented assumptions where the provider publishes no formula. Each is
 * deliberately on the high side so estimates bound real costs; replace with
 * measured averages from the usage ledger once real runs exist.
 */
export const ASSUMPTIONS = {
  /**
   * gpt-6-luna publishes no vision multiplier; other current models use 1.2.
   * 1.5 (the highest among current small models) keeps estimates conservative.
   */
  unknownVisionPatchMultiplier: 1.5,
  /**
   * gpt-image-2 always reads reference images at high fidelity but publishes no
   * token formula. gpt-image-1's high-fidelity rule (tiles + 4160/6240 extra)
   * gives ≈4.7k–6.8k tokens per image; we assume the top of that range.
   */
  imageModelTokensPerReference: 6_800,
  /** Approximate characters per text token for prompt-size estimates. */
  charsPerToken: 3,
  /** Safety margin applied on top of every estimate. */
  estimateMargin: 1.2,
} as const;

export function getRates(model: string): ModelRates | null {
  return RATE_CARD[model] ?? null;
}

/**
 * fal.ai prices (micro-USD), from the model pages, checked 2026-10-10. fal
 * returns no usage, so these fixed prices are also what we record as the cost.
 * - Seedream 5.0 Pro Layerize: $0.03375 per generated layer for a base image
 *   under 1536×1536 total pixels, $0.0675 above; 2–17 layers per call.
 * - Bria Eraser: $0.04 per generation.
 */
export const FAL_RATES = {
  layerize: { perLayerSmall: usd(0.03375), perLayerLarge: usd(0.0675), smallMaxPixels: 1536 * 1536, maxLayers: 17 },
  eraser: { perImage: usd(0.04) },
  /**
   * FrameFlow addition: SAM-3 masks for exact product cutouts (FrameFlow's segmenter), fal's listed price as noted on
   * 2026-10-09. Not confirmed against an invoice, so it is recorded as an estimate, never as a confirmed charge.
   */
  cutoutSam3: { perRequest: usd(0.01), source: "fal model page (fal-ai/sam-3-1/image), listed 2026-10-09; unconfirmed" },
} as const;
