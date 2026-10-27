import { ASSUMPTIONS, getRates, type ImageModelRates, type TextModelRates } from "./rateCard.js";

/**
 * Upper-bound cost estimates, used to reserve budget before a paid call.
 * A call is only allowed when its cost can be bounded: text calls must set a
 * max output token limit, and the model must be on the rate card.
 */

export class CostUnboundedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CostUnboundedError";
  }
}

export interface ImageInputSpec {
  width: number;
  height: number;
}

/** Vision tokens for patch-based text models (published formula). */
export function visionTokens(model: string, image: ImageInputSpec, detail: "low" | "high"): number {
  const rates = textRates(model);
  const multiplier = rates.visionPatchMultiplier ?? ASSUMPTIONS.unknownVisionPatchMultiplier;
  let { width, height } = image;

  if (detail === "low") {
    // Fits within 512×512.
    const s = Math.min(1, 512 / Math.max(width, height));
    width = Math.floor(width * s);
    height = Math.floor(height * s);
  } else {
    // Fits within 2048×2048, then a 2,500-patch budget.
    const s = Math.min(1, 2048 / Math.max(width, height));
    width = Math.floor(width * s);
    height = Math.floor(height * s);
    const budget = 2500;
    if (Math.ceil(width / 32) * Math.ceil(height / 32) > budget) {
      const shrink = Math.sqrt((32 * 32 * budget) / (width * height));
      const adj =
        shrink *
        Math.min(
          Math.floor((width * shrink) / 32) / ((width * shrink) / 32),
          Math.floor((height * shrink) / 32) / ((height * shrink) / 32),
        );
      width = Math.floor(width * adj);
      height = Math.floor(height * adj);
    }
  }
  const patches = Math.ceil(width / 32) * Math.ceil(height / 32);
  return Math.ceil(patches * multiplier);
}

export function textTokensFor(chars: number) {
  return Math.ceil(chars / ASSUMPTIONS.charsPerToken);
}

export interface TextCallSpec {
  model: string;
  /** Characters of system prompt + user text + JSON schema. */
  promptChars: number;
  images: ImageInputSpec[];
  imageDetail: "low" | "high";
  /** Hard cap sent to the API (includes reasoning tokens). Required to bound cost. */
  maxOutputTokens: number;
}

export interface CostEstimate {
  model: string;
  microUsd: number;
  breakdown: { label: string; tokens: number; microUsd: number }[];
  assumptions: string[];
}

export function estimateTextCall(spec: TextCallSpec): CostEstimate {
  const rates = textRates(spec.model);
  if (!(spec.maxOutputTokens > 0)) throw new CostUnboundedError("Text calls must set a max output token limit.");
  const textTokens = textTokensFor(spec.promptChars);
  const imageTokens = spec.images.reduce((sum, img) => sum + visionTokens(spec.model, img, spec.imageDetail), 0);
  const inputTokens = textTokens + imageTokens;
  if (inputTokens > rates.longContextThreshold) {
    throw new CostUnboundedError("Request would enter the long-context price tier; reduce inputs.");
  }
  const assumptions: string[] = [];
  if (rates.visionPatchMultiplier === null && spec.images.length) {
    assumptions.push(`${spec.model} publishes no vision multiplier; assumed ${ASSUMPTIONS.unknownVisionPatchMultiplier}.`);
  }
  assumptions.push(`Output assumed to use the full ${spec.maxOutputTokens.toLocaleString("en-US")}-token limit.`);
  const breakdown = [
    { label: "Text input", tokens: textTokens, microUsd: textTokens * rates.input },
    { label: "Image input", tokens: imageTokens, microUsd: imageTokens * rates.input },
    { label: "Output (max)", tokens: spec.maxOutputTokens, microUsd: spec.maxOutputTokens * rates.output },
  ];
  return finish(spec.model, breakdown, assumptions);
}

export interface ImageCallSpec {
  model: string;
  quality: "low" | "medium" | "high";
  /** Provider size string, e.g. "1024x1536". */
  size: string;
  promptChars: number;
  referenceImages: number;
}

export function estimateImageCall(spec: ImageCallSpec): CostEstimate {
  const rates = imageRates(spec.model);
  const assumptions: string[] = [];

  let output = rates.outputPerImage[spec.size]?.[spec.quality];
  if (output === undefined) {
    const [w, h] = spec.size.split("x").map(Number);
    if (!(w > 0 && h > 0)) throw new CostUnboundedError(`Unrecognised image size "${spec.size}".`);
    // Custom size inside a published size: bounded by the dearest published size that contains it.
    const covering = Object.entries(rates.outputPerImage)
      .filter(([size]) => {
        const [sw, sh] = size.split("x").map(Number);
        return sw >= w && sh >= h;
      })
      .map(([, q]) => q?.[spec.quality])
      .filter((v): v is number => v !== undefined);
    if (covering.length) {
      output = Math.max(...covering);
      assumptions.push(`No published price for ${spec.size}; bounded by the published price of a larger standard size.`);
    }
  }
  if (output === undefined) {
    // Custom size larger than any published one: scale the most expensive published size by pixel area (never below it).
    const [w, h] = spec.size.split("x").map(Number);
    const known = Object.values(rates.outputPerImage)
      .map((q) => q?.[spec.quality])
      .filter((v): v is number => v !== undefined);
    if (!known.length) throw new CostUnboundedError(`No published ${spec.quality}-quality price for ${spec.model}.`);
    output = Math.ceil(Math.max(...known) * Math.max(1, (w * h) / (1024 * 1024)));
    assumptions.push(`No published price for ${spec.size}; scaled from the most expensive standard size by area.`);
  }

  const textTokens = textTokensFor(spec.promptChars);
  const refTokens = spec.referenceImages * ASSUMPTIONS.imageModelTokensPerReference;
  if (spec.referenceImages) {
    assumptions.push(
      `Assumed ${ASSUMPTIONS.imageModelTokensPerReference.toLocaleString("en-US")} input tokens per reference image (no published formula for ${spec.model}).`,
    );
  }
  const breakdown = [
    { label: "Prompt", tokens: textTokens, microUsd: textTokens * rates.textInput },
    { label: `Reference images (${spec.referenceImages})`, tokens: refTokens, microUsd: refTokens * rates.imageInput },
    { label: `Image output (${spec.quality}, ${spec.size})`, tokens: Math.round(output / rates.imageOutput), microUsd: output },
  ];
  return finish(spec.model, breakdown, assumptions);
}

function finish(model: string, breakdown: CostEstimate["breakdown"], assumptions: string[]): CostEstimate {
  const raw = breakdown.reduce((s, b) => s + b.microUsd, 0);
  assumptions.push(`Includes a ${Math.round((ASSUMPTIONS.estimateMargin - 1) * 100)}% safety margin.`);
  return {
    model,
    microUsd: Math.ceil(raw * ASSUMPTIONS.estimateMargin),
    breakdown: breakdown.map((b) => ({ ...b, microUsd: Math.ceil(b.microUsd) })),
    assumptions,
  };
}

// ---------------------------------------------------------------------------
// Usage-derived cost (from what the provider reports after a call)
// ---------------------------------------------------------------------------

/** Responses API usage. Reasoning tokens are already included in output_tokens. */
export interface ResponsesUsage {
  input_tokens: number;
  input_tokens_details?: { cached_tokens?: number } | null;
  output_tokens: number;
}

/** Images API usage. */
export interface ImagesUsage {
  input_tokens: number;
  input_tokens_details?: { text_tokens?: number; image_tokens?: number } | null;
  output_tokens: number;
}

/** Returns null when the usage is missing or malformed: cost is then "unknown", never $0. */
export function costFromUsage(model: string, usage: unknown): number | null {
  const rates = getRates(model);
  if (!rates || !usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  if (typeof u.input_tokens !== "number" || typeof u.output_tokens !== "number") return null;

  if (rates.kind === "text") {
    const details = u.input_tokens_details as { cached_tokens?: number; cache_write_tokens?: number } | undefined;
    const cached = Number(details?.cached_tokens ?? 0);
    // Cache writes are input tokens billed at 1.25× the input rate.
    const cacheWrite = Number(details?.cache_write_tokens ?? 0);
    const uncached = Math.max(0, u.input_tokens - cached);
    return Math.ceil(uncached * rates.input + cacheWrite * rates.input * 0.25 + cached * rates.cachedInput + u.output_tokens * rates.output);
  }
  const details = u.input_tokens_details as { text_tokens?: number; image_tokens?: number } | undefined;
  if (typeof details?.text_tokens !== "number" || typeof details?.image_tokens !== "number") {
    // Can't split text vs image input; price all input at the higher image rate (upper bound).
    return Math.ceil(u.input_tokens * rates.imageInput + u.output_tokens * rates.imageOutput);
  }
  return Math.ceil(details.text_tokens * rates.textInput + details.image_tokens * rates.imageInput + u.output_tokens * rates.imageOutput);
}

function textRates(model: string): TextModelRates {
  const r = getRates(model);
  if (!r || r.kind !== "text") throw new CostUnboundedError(`No price on the rate card for text model "${model}". Add it before use.`);
  return r;
}

function imageRates(model: string): ImageModelRates {
  const r = getRates(model);
  if (!r || r.kind !== "image") throw new CostUnboundedError(`No price on the rate card for image model "${model}". Add it before use.`);
  return r;
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

export function formatUsd(microUsd: number) {
  const v = microUsd / 1_000_000;
  return `$${v < 0.01 && v > 0 ? v.toFixed(4) : v.toFixed(2)}`;
}

export function formatInr(microUsd: number, usdInrRate: number) {
  const v = (microUsd / 1_000_000) * usdInrRate;
  if (v === 0) return "₹0";
  return `₹${v < 1 ? v.toFixed(2) : v.toFixed(v < 10 ? 1 : 0)}`;
}
