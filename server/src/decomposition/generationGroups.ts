/**
 * Image generation for reference creatives (imageTemplates.ts): a creative's sizes are the variants of its group folder
 * (group.json and its images). Each variant is one OpenAI image edit of the original uploaded reference (never resent,
 * never a text-only fallback), saved with its request, response and image, or its error. A finished variant is never
 * generated again (decomposition runs may point at its image), and every decomposition made from it is linked to it.
 * The image client and failure classification are shared with template edits (creativeTemplates/).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import OpenAI, { toFile } from 'openai';
import sharp from 'sharp';
import { validateImageTemplateRequestPrompt } from '@frameflow/shared';
import { imageModel } from './aiModels.js';
import { RunError, validRunId } from './layerizeExperiment.js';

/** One image request can take minutes; it is billed once sent, so it is given time and never retried automatically. */
const IMAGE_TIMEOUT_MS = 300_000;
const GROUP_FILE = 'group.json';

type ImagesClient = Pick<OpenAI, 'images'>;
/** Models whose installed SDK contract explicitly permits multiple edit inputs. */
export const supportsProductReference = (model: string) => /^(?:gpt-image-(?:1(?:-mini|\.5)?|2)(?:-\d{4}-\d{2}-\d{2})?|gpt-image-2\.5-(?:sunburst|flare)(?:-\d{4}-\d{2}-\d{2})?|chatgpt-image-latest)$/.test(model);
/** client: created per request, so a missing OPENAI_API_KEY is a saved failure, not a broken server. */
export type GenerationConfig = { model: string; client: () => ImagesClient };

/** pending: not generated yet. queued / generating: on its way. done: has its image. failed: has its error. */
export type VariantStatus = 'pending' | 'queued' | 'generating' | 'done' | 'failed';
/** A decomposition run made from a variant. */
export type VariantDecomposition = { runId: string; createdAt: string };
/** One size of a creative. Nothing here is shared with the other variants. */
export type GenerationVariant = {
  /** The ratio as a file-safe word ("16x9"); the prefix of this variant's files. */
  id: string;
  aspectRatio: string; size: { width: number; height: number }; status: VariantStatus;
  /** The ratio's framing sentence, and the exact prompt sent. */
  framing: string; prompt: string;
  generator: { provider: string; model: string; requestId?: string };
  /** How often it was sent to the provider, and the files holding the last request and response. */
  attempts: number; requestFile?: string; responseFile?: string; startedAt?: string; finishedAt?: string; durationMs?: number;
  image?: { file: string; mimeType: string; width: number; height: number; bytes: number; sha256?: string };
  /** A replacement product image sent as a second input with the original. */
  productReference?: { file: string; sha256: string };
  /** The original uploaded reference every attempt edits, and the sentence about it added to the prompt. */
  sourceReference?: { file: string; sha256: string; instruction: string };
  /** The provider's own status and messages when it failed, and the file with its complete error response. */
  error?: { code: string; message: string; status?: number; messages?: { msg: string; type?: string }[]; bodyFile?: string };
  /** Decomposition runs made from this variant's image, oldest first. */
  decompositions: VariantDecomposition[];
};
/** What these functions read and write of a creative's group.json (the rest of the record is kept as it is). */
export type GenerationGroup = { id: string; updatedAt: string; variants: GenerationVariant[] };

export function liveGenerationConfig(env = process.env): GenerationConfig {
  return { model: imageModel(env), client: () => {
    if (!env.OPENAI_API_KEY?.trim()) throw new RunError('GENERATOR_NOT_CONFIGURED', 'Set OPENAI_API_KEY in server/.env.');
    return new OpenAI({ apiKey: env.OPENAI_API_KEY, maxRetries: 0, timeout: IMAGE_TIMEOUT_MS });
  } };
}

const write = (dir: string, file: string, value: unknown) => {
  const path = join(dir, file), temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2));
  renameSync(temp, path);
};
export const groupDir = (root: string, id: string) => {
  if (!validRunId(id) || !existsSync(join(root, id, GROUP_FILE))) throw new RunError('NOT_FOUND', 'Generation not found.');
  return join(root, id);
};
export function readGroup(root: string, id: string): GenerationGroup {
  return JSON.parse(readFileSync(join(groupDir(root, id), GROUP_FILE), 'utf8')) as GenerationGroup;
}
export const findVariant = (group: GenerationGroup, variantId: string) => {
  const variant = group.variants.find(item => item.id === variantId);
  if (!variant) throw new RunError('NOT_FOUND', `Generation ${group.id} has no variant "${variantId}".`);
  return variant;
};
/**
 * Every change to a group: read what is on disk now, change it, write it. Nothing holds a group across an await, so a
 * variant finishing and a decomposition being linked at the same time cannot overwrite each other.
 */
function update(root: string, id: string, change: (group: GenerationGroup) => void): GenerationGroup {
  const dir = groupDir(root, id), group = readGroup(root, id);
  change(group);
  group.updatedAt = new Date().toISOString();
  write(dir, GROUP_FILE, group);
  return group;
}

/** The only fields a request may carry; anything else is a mistake, refused with what it may carry. */
export function allowOnly(body: Record<string, unknown>, allowed: readonly string[], what: string) {
  const unknown = Object.keys(body).filter(key => !allowed.includes(key));
  if (unknown.length) throw new RunError('INVALID_REQUEST', `${what} has no setting ${unknown.map(key => `"${key}"`).join(', ')}${allowed.length ? `; it takes ${allowed.join(', ')}` : ''}.`);
}

/**
 * Marks a variant as waiting to be generated. Only a variant without an image can be: a finished one keeps its image
 * (decomposition runs may point at it), and one already on its way is not sent twice. `inProgress`: whether this
 * process really has it queued or running; a variant left queued or generating by a stopped server may be queued again.
 */
export function queueVariant(root: string, groupId: string, variantId: string, inProgress = false): GenerationGroup {
  return update(root, groupId, (group) => {
    const variant = findVariant(group, variantId);
    if (variant.status === 'done') throw new RunError('ALREADY_GENERATED', `The ${variant.aspectRatio} variant already has its image. Generate a new creative to get another one.`);
    if (inProgress && (variant.status === 'queued' || variant.status === 'generating')) throw new RunError('BUSY', `The ${variant.aspectRatio} variant is already being generated.`);
    variant.status = 'queued';
  });
}

/** An OpenAI API error (the SDK's APIError, read by shape): its HTTP status, code, request id and error body. */
export type ApiFailure = { status?: number; code?: string | null; type?: string; requestID?: string | null; error?: unknown };
/** The failure code of an image request, as saved and shown. */
export function imageFailureCode(error: unknown): string {
  if (error instanceof RunError) return error.code;
  const { status, code } = error as ApiFailure;
  if (status === undefined) return 'GENERATION_FAILED';
  if (code === 'moderation_blocked' || code === 'content_policy_violation') return 'PROVIDER_SAFETY_REFUSAL';
  if (status === 401 || status === 403) return 'PROVIDER_AUTH';
  if (code === 'insufficient_quota' || code === 'billing_hard_limit_reached') return 'PROVIDER_CREDITS';
  if (status === 429) return 'PROVIDER_RATE_LIMITED';
  return status >= 500 ? 'PROVIDER_NETWORK' : 'PROVIDER_REJECTED';
}
export const imageFileType = (file: string) => file.endsWith('.png') ? 'image/png' : file.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
/** An image the model returned, checked and described for saving (exactly these bytes are kept, never a re-encoded copy). */
export async function returnedImage(encoded: string | undefined): Promise<{ bytes: Buffer; format: string; width: number; height: number; sha256: string }> {
  if (!encoded) throw new RunError('NO_IMAGE', 'OpenAI returned no image.');
  const bytes = Buffer.from(encoded, 'base64');
  const meta = await sharp(bytes).metadata().catch(() => ({ format: undefined, width: undefined, height: undefined }));
  if (!['png', 'jpeg', 'webp'].includes(meta.format ?? '') || !meta.width || !meta.height) throw new RunError('INVALID_IMAGE', 'OpenAI returned a file that is not a PNG, JPEG or WebP image.');
  return { bytes, format: meta.format === 'jpeg' ? 'jpg' : meta.format!, width: meta.width, height: meta.height, sha256: createHash('sha256').update(bytes).digest('hex') };
}
/** A saved response without the image bytes (they are in the image file). */
export const responseWithoutImage = (response: { data?: { b64_json?: string }[] | null }) =>
  ({ ...response, data: (response.data ?? []).map(({ b64_json, ...rest }) => ({ ...rest, b64_json: b64_json ? `<${b64_json.length} base64 characters: the saved image>` : undefined })) });

/**
 * Generates one variant: one OpenAI image edit (never resent) of the original uploaded reference with the variant's
 * stored prompt at its exact size, one PNG back. Only this variant of the group is written: its image, or its error with
 * OpenAI's status, message and complete error response. A failure is saved and returned, never thrown, and leaves every
 * other variant as it is.
 */
export async function generateVariant(root: string, groupId: string, variantId: string, config: GenerationConfig, options: { sourceReference: NonNullable<GenerationVariant['sourceReference']>; productReference?: GenerationVariant['productReference'] }): Promise<GenerationGroup> {
  const dir = groupDir(root, groupId), files = { request: `${variantId}.openai-request.json`, response: `${variantId}.openai-response.json`, error: `${variantId}.provider-error.json` };
  const started = Date.now();
  const sending = findVariant(update(root, groupId, (group) => {
    const variant = findVariant(group, variantId);
    if (variant.status === 'done') throw new RunError('ALREADY_GENERATED', `The ${variant.aspectRatio} variant already has its image.`);
    Object.assign(variant, { status: 'generating', attempts: variant.attempts + 1, startedAt: new Date(started).toISOString(), generator: { provider: 'openai', model: config.model }, requestFile: files.request,
      sourceReference: options.sourceReference });
    // What an earlier attempt left behind does not describe this one.
    delete variant.error; delete variant.responseFile; delete variant.finishedAt; delete variant.durationMs; delete variant.productReference;
    if (options.productReference) variant.productReference = options.productReference;
  }), variantId);
  const from = sending.sourceReference!;
  const request = { model: config.model, prompt: `${sending.prompt} ${from.instruction}`, size: `${sending.size.width}x${sending.size.height}`, n: 1, output_format: 'png' as const };
  write(dir, files.request, { method: 'images.edit', ...request, ...(sending.productReference ? { productReference: sending.productReference } : {}), image: `<original uploaded reference: ${from.file}, sha256 ${from.sha256}>` });
  let outcome: Partial<GenerationVariant>, requestId: string | undefined, responseSaved = false;
  try {
    validateImageTemplateRequestPrompt(request.prompt);
    // The original upload exactly as saved. Missing or changed input fails; no fallback.
    const input = readFileSync(join(dir, from.file));
    if (createHash('sha256').update(input).digest('hex') !== from.sha256) throw new RunError('REFERENCE_CHANGED', 'The original reference file has changed. Create a new creative from the intended image.');
    const primary = await toFile(input, from.file, { type: imageFileType(from.file) });
    let replacement: Awaited<ReturnType<typeof toFile>> | undefined;
    if (sending.productReference) {
      if (!supportsProductReference(config.model)) throw new RunError('INVALID_REQUEST', 'The configured model does not support two reference images.');
      const product = readFileSync(join(dir, sending.productReference.file));
      if (createHash('sha256').update(product).digest('hex') !== sending.productReference.sha256) throw new RunError('REFERENCE_CHANGED', 'The replacement product file has changed.');
      replacement = await toFile(product, sending.productReference.file, { type: imageFileType(sending.productReference.file) });
    }
    const response = await config.client().images.edit({ ...request, image: replacement ? [primary, replacement] : primary });
    requestId = (response as { _request_id?: string | null })._request_id ?? undefined;
    write(dir, files.response, responseWithoutImage(response));
    responseSaved = true;
    const image = await returnedImage(response.data?.[0]?.b64_json);
    const file = `${variantId}.image.${image.format}`;
    writeFileSync(join(dir, file), image.bytes);
    outcome = { status: 'done', responseFile: files.response, image: { file, mimeType: `image/${image.format === 'jpg' ? 'jpeg' : image.format}`, width: image.width, height: image.height, bytes: image.bytes.length, sha256: image.sha256 } };
  } catch (error) {
    const api: ApiFailure = error instanceof RunError ? {} : error as ApiFailure, message = error instanceof Error ? error.message : String(error);
    requestId = api.requestID ?? requestId;
    if (api.status !== undefined) write(dir, files.error, { requestId, capturedAt: new Date().toISOString(), status: api.status, body: api.error ?? null });
    outcome = { status: 'failed', ...(responseSaved ? { responseFile: files.response } : {}),
      error: { code: imageFailureCode(error), message, ...(api.status !== undefined ? { status: api.status, messages: [{ msg: message, ...(api.code ?? api.type ? { type: (api.code ?? api.type)! } : {}) }], bodyFile: files.error } : {}) } };
  }
  return update(root, groupId, (group) => {
    const variant = findVariant(group, variantId);
    Object.assign(variant, outcome, { finishedAt: new Date().toISOString(), durationMs: Date.now() - started });
    if (requestId) variant.generator.requestId = requestId;
  });
}

/** The saved image of a finished variant, exactly as generated, for a decomposition. */
export function variantImage(root: string, groupId: string, variantId: string): { group: GenerationGroup; variant: GenerationVariant; bytes: Buffer } {
  const group = readGroup(root, groupId), variant = findVariant(group, variantId);
  if (variant.status !== 'done' || !variant.image) throw new RunError('NOT_DECOMPOSABLE', `The ${variant.aspectRatio} variant of generation ${groupId} has no image to decompose (${variant.status}${variant.error ? `: ${variant.error.message}` : ''}).`);
  return { group, variant, bytes: readFileSync(join(groupDir(root, groupId), variant.image.file)) };
}
/** Links a decomposition run to the variant it was made from. */
export function recordDecomposition(root: string, groupId: string, variantId: string, entry: VariantDecomposition): GenerationGroup {
  return update(root, groupId, (group) => { findVariant(group, variantId).decompositions.push(entry); });
}
