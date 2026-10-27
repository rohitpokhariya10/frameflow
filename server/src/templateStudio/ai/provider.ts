import { toFile } from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { z } from "zod";
import { classifyProviderError, getOpenAI, type ClassifiedProviderError } from "../openai/client.js";

/**
 * The provider boundary. Job stages call these methods only through
 * ai/calls.ts (which handles budgets, usage and validation); tests substitute a
 * fake implementation. Nothing here retries.
 */

export type UserContent =
  | { type: "text"; text: string }
  | { type: "image"; data: Buffer; mime: string; detail: "low" | "high"; width: number; height: number };

export interface StructuredRequest {
  model: string;
  system: string;
  content: UserContent[];
  schema: z.ZodType;
  schemaName: string;
  maxOutputTokens: number;
  reasoningEffort: "none" | "low" | "medium" | "high";
}

export interface StructuredResponse {
  /** Raw JSON text produced by the model (validated by the caller). */
  text: string | null;
  refusal: string | null;
  /** Why the response stopped early, e.g. "max_output_tokens". */
  incompleteReason: string | null;
  usage: unknown;
  requestId: string | null;
}

export interface ImageEditRequest {
  mask?: Buffer;
  model: string;
  prompt: string;
  images: { data: Buffer; mime: string; name: string }[];
  size: string;
  quality: "low" | "medium" | "high";
}

export interface ImageEditResponse {
  image: Buffer;
  usage: unknown;
  requestId: string | null;
}

export interface Provider {
  structured(req: StructuredRequest): Promise<StructuredResponse>;
  editImage(req: ImageEditRequest): Promise<ImageEditResponse>;
  /** True for the deterministic offline test provider: anything it produced is labelled as a mock, never as AI output. */
  readonly offline?: boolean;
}

export class ProviderCallError extends Error {
  constructor(public readonly info: ClassifiedProviderError) {
    super(info.message);
    this.name = "ProviderCallError";
  }
}

export class OpenAIProvider implements Provider {
  constructor(private readonly apiKey: string | undefined) {}

  async structured(req: StructuredRequest): Promise<StructuredResponse> {
    try {
      const openai = getOpenAI(this.apiKey);
      const { data, request_id } = await openai.responses
        .create(
          {
            model: req.model,
            instructions: req.system,
            input: [
              {
                role: "user",
                content: req.content.map((c) =>
                  c.type === "text"
                    ? { type: "input_text" as const, text: c.text }
                    : {
                        type: "input_image" as const,
                        image_url: `data:${c.mime};base64,${c.data.toString("base64")}`,
                        detail: c.detail,
                      },
                ),
              },
            ],
            text: { format: zodTextFormat(req.schema, req.schemaName) },
            max_output_tokens: req.maxOutputTokens,
            reasoning: { effort: req.reasoningEffort },
            store: false,
          },
          { timeout: 5 * 60 * 1000 },
        )
        .withResponse();

      let refusal: string | null = null;
      for (const item of data.output ?? []) {
        if (item.type !== "message") continue;
        for (const part of item.content) {
          if (part.type === "refusal") refusal = part.refusal;
        }
      }
      return {
        text: data.output_text || null,
        refusal,
        incompleteReason: data.status === "incomplete" ? (data.incomplete_details?.reason ?? "unknown") : null,
        usage: data.usage ?? null,
        requestId: request_id ?? null,
      };
    } catch (err) {
      throw new ProviderCallError(classifyProviderError(err, { model: req.model }));
    }
  }

  async editImage(req: ImageEditRequest): Promise<ImageEditResponse> {
    try {
      const openai = getOpenAI(this.apiKey);
      const files = await Promise.all(req.images.map((i) => toFile(i.data, i.name, { type: i.mime })));
      const { data, request_id } = await openai.images
        .edit(
          {
            model: req.model,
            image: files,
            ...(req.mask ? { mask: await toFile(req.mask, 'edit-mask.png', { type: 'image/png' }) } : {}),
            prompt: req.prompt,
            size: req.size,
            quality: req.quality,
            n: 1,
            output_format: "png",
          },
          { timeout: 10 * 60 * 1000 },
        )
        .withResponse();
      const b64 = data.data?.[0]?.b64_json;
      if (!b64) {
        throw new ProviderCallError({
          code: "unknown",
          message: "The image service returned no image.",
          safeToRetry: false,
          outcomeUnknown: true,
          requestId: request_id,
        });
      }
      return { image: Buffer.from(b64, "base64"), usage: data.usage ?? null, requestId: request_id ?? null };
    } catch (err) {
      if (err instanceof ProviderCallError) throw err;
      throw new ProviderCallError(classifyProviderError(err, { model: req.model }));
    }
  }
}
