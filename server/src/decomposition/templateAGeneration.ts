/**
 * Template A image generation, a test/admin harness served by the local-only layerize experiment router.
 *
 * One creative, several aspect ratios. The user defines a Template A creative once (the fields, or the base prompt
 * edited from them); it is generated as a GROUP of aspect-ratio variants (1:1, 16:9, 4:5). The group holds the shared
 * creative definition; each variant holds only what belongs to its ratio: its size, its framing sentence, the exact
 * prompt sent, the request and response, its image or its error, and the decomposition runs made from it. The prompts
 * are built deterministically (shared/src/templateAGeneration.ts; no LLM rewrite) and differ between the variants of a
 * group in the framing sentence only.
 *
 * OpenAI Image 2 generates each variant with its own request, so one failing leaves the others as they are, and a
 * failed or not yet generated variant can be generated later on its own. A finished variant is never generated again
 * (decomposition runs may point at its image); a changed creative is a new group. Decomposing a variant creates an
 * ordinary Template A run linked back to the group, the variant and its ratio; fal is used only there, for Seedream
 * Layerize, never to generate an image.
 *
 * Records made before groups existed (one image per record, generation.json) are read as a group with that one
 * variant and are left on disk as they are.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';
import sharp from 'sharp';
import { buildTemplateAVariantPrompt, hasHeldObject, hasVisibleBorder, resolveTemplateABasePrompt, resolveTemplateAFields, TEMPLATE_A_ASPECT_RATIOS, TEMPLATE_A_GENERATION_VERSION, TEMPLATE_A_IMAGE_SIZES, TEMPLATE_A_RATIO_FRAMING,
  templateAVariantId, type TemplateAAspectRatio, type TemplateAFieldValues } from '@frameflow/shared';
import { imageModel } from './aiModels.js';
import { RunError, validRunId } from './layerizeExperiment.js';

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_GENERATIONS_DIR = resolve(here, '../../../artifacts/decomposition/template-a-generations');
/** One image request can take minutes; it is billed once sent, so it is given time and never retried automatically. */
const IMAGE_TIMEOUT_MS = 300_000;
const GROUP_FILE = 'group.json', LEGACY_FILE = 'generation.json';

type ImagesClient = Pick<OpenAI, 'images'>;
/** client: created per request, so a missing OPENAI_API_KEY is a saved failed variant, not a broken server. */
export type GenerationConfig = { model: string; client: () => ImagesClient };

/** pending: not generated yet. queued / generating: on its way. done: has its image. failed: has its error. */
export type VariantStatus = 'pending' | 'queued' | 'generating' | 'done' | 'failed';
export type VariantDecomposition = { runId: string; createdAt: string; separateHeldObject: boolean; targetLayers: number };
/** One aspect ratio of a creative. Nothing here is shared with the other variants. */
export type GenerationVariant = {
  /** The ratio as a file-safe word ("16x9"); the prefix of this variant's files. "single" on a record from before groups. */
  id: string;
  aspectRatio: string; size: { width: number; height: number }; status: VariantStatus;
  /** The ratio's framing sentence, and the exact prompt sent: the group's base prompt, the consistency sentence, this framing. */
  framing: string; prompt: string;
  /** provider: 'openai' since OpenAI Image 2; older records say 'fal', 'cloudflare' or 'gemini'. */
  generator: { provider: string; model: string; requestId?: string };
  /** How often it was sent to the provider, and the files holding the last request and response. */
  attempts: number; requestFile?: string; responseFile?: string; startedAt?: string; finishedAt?: string; durationMs?: number;
  image?: { file: string; mimeType: string; width: number; height: number; bytes: number; sha256?: string };
  /** The provider's own status and messages when it failed, and the file with its complete error response. */
  error?: { code: string; message: string; status?: number; messages?: { msg: string; type?: string }[]; bodyFile?: string };
  /** Template A decomposition runs made from this variant's image, oldest first. */
  decompositions: VariantDecomposition[];
};
/** One creative and its aspect-ratio variants. */
export type GenerationGroup = {
  id: string; templateKey: 'template-a'; version: string; createdAt: string; updatedAt: string;
  /** The shared creative definition: the field values (defaults filled in) and the prompt built from them. */
  fields: TemplateAFieldValues; builtPrompt: string;
  /** The base prompt every variant uses: the built prompt, or the user's edit of it (promptEdited). */
  basePrompt: string; promptEdited: boolean;
  /** Structure known from the fields, which a decomposition's default layer count follows. */
  structure: { visibleBorder: boolean; heldObject: boolean };
  aspectRatios: string[]; variants: GenerationVariant[];
  /** Read from a record made before groups existed: one image, never regenerated. */
  legacy?: true;
};
/** A record from before groups: one image per record, in generation.json. */
type LegacyRecord = {
  id: string; version: string; createdAt: string; updatedAt?: string; status: 'generating' | 'done' | 'failed'; fields: TemplateAFieldValues; prompt: string;
  structure?: GenerationGroup['structure']; generator: { provider?: string; id?: string; model: string; requestId?: string }; aspectRatio: string; size?: { width: number; height: number }; durationMs?: number;
  image?: GenerationVariant['image']; error?: GenerationVariant['error']; decompositions?: VariantDecomposition[];
};

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
const structureFrom = (fields: TemplateAFieldValues) => ({ visibleBorder: hasVisibleBorder(fields), heldObject: hasHeldObject(fields) });
export const groupDir = (root: string, id: string) => {
  if (!validRunId(id) || !(existsSync(join(root, id, GROUP_FILE)) || existsSync(join(root, id, LEGACY_FILE)))) throw new RunError('NOT_FOUND', 'Generation not found.');
  return join(root, id);
};

/** An older one-image record as a group with that one variant. Its prompt had no ratio framing; it is shown as it was sent. */
function legacyGroup(record: LegacyRecord): GenerationGroup {
  const done = record.status === 'done' && !!record.image;
  return {
    id: record.id, templateKey: 'template-a', version: record.version, createdAt: record.createdAt, updatedAt: record.updatedAt ?? record.createdAt, legacy: true,
    fields: record.fields, builtPrompt: record.prompt, basePrompt: record.prompt, promptEdited: false, structure: record.structure ?? structureFrom(record.fields), aspectRatios: [record.aspectRatio],
    variants: [{
      id: 'single', aspectRatio: record.aspectRatio, size: record.size ?? { width: record.image?.width ?? 0, height: record.image?.height ?? 0 }, status: done ? 'done' : 'failed', framing: '', prompt: record.prompt,
      generator: { provider: record.generator.provider ?? record.generator.id ?? 'unknown', model: record.generator.model, ...(record.generator.requestId ? { requestId: record.generator.requestId } : {}) },
      attempts: 1, ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}), ...(done ? { image: record.image } : {}),
      ...(done ? {} : { error: record.error ?? { code: 'INTERRUPTED', message: 'This generation never finished.' } }), decompositions: record.decompositions ?? [],
    }],
  };
}
export function readGroup(root: string, id: string): GenerationGroup {
  const dir = groupDir(root, id);
  return existsSync(join(dir, GROUP_FILE)) ? JSON.parse(readFileSync(join(dir, GROUP_FILE), 'utf8')) as GenerationGroup : legacyGroup(JSON.parse(readFileSync(join(dir, LEGACY_FILE), 'utf8')) as LegacyRecord);
}
/** The newest groups first, older one-image records among them. */
export function listGroups(root: string): GenerationGroup[] {
  if (!existsSync(root)) return [];
  return readdirSync(root).filter(validRunId).filter(id => existsSync(join(root, id, GROUP_FILE)) || existsSync(join(root, id, LEGACY_FILE))).sort().reverse().slice(0, 30).map(id => readGroup(root, id));
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
  if (group.legacy) throw new RunError('LEGACY_RECORD', 'This is an older one-image generation; it cannot be changed. Generate a new creative instead.');
  change(group);
  group.updatedAt = new Date().toISOString();
  write(dir, GROUP_FILE, group);
  return group;
}

/**
 * A new group for one creative: the shared definition and a pending variant for each aspect ratio, each with the exact
 * prompt it will be sent. Nothing is sent here. Invalid fields, an unusable edited prompt, a prompt over the limit or
 * an unknown ratio are refused before anything is written; a request carrying a final prompt is refused (a variant's
 * prompt is built here from the base prompt and its framing, never supplied).
 */
export function createGroup(root: string, input: { fields?: unknown; basePrompt?: unknown; prompt?: unknown; aspectRatios?: unknown }, config: Pick<GenerationConfig, 'model'>): { group: GenerationGroup; requested: string[] } {
  if (input.prompt !== undefined) throw new RunError('PROMPT_NOT_ACCEPTED', 'A variant\'s prompt is built from the shared base prompt and its aspect ratio; it cannot be sent. Send basePrompt to edit the shared part.');
  const { values, errors } = resolveTemplateAFields(input.fields);
  if (errors.length) throw new RunError('INVALID_FIELDS', errors.join(' '));
  const base = resolveTemplateABasePrompt(values, input.basePrompt);
  if (base.errors.length) throw new RunError(input.basePrompt === undefined ? 'INVALID_FIELDS' : 'INVALID_PROMPT', base.errors.join(' '));
  // Which ratios to generate now; the group always has all of them, the others stay pending.
  const wanted = input.aspectRatios ?? TEMPLATE_A_ASPECT_RATIOS;
  if (!Array.isArray(wanted) || !wanted.length || !wanted.every((ratio): ratio is TemplateAAspectRatio => TEMPLATE_A_ASPECT_RATIOS.includes(ratio as TemplateAAspectRatio)) || new Set(wanted).size !== wanted.length) {
    throw new RunError('INVALID_ASPECT_RATIO', `aspectRatios must be one or more of ${TEMPLATE_A_ASPECT_RATIOS.join(', ')}, each once.`);
  }
  let variants: GenerationVariant[];
  try {
    variants = TEMPLATE_A_ASPECT_RATIOS.map(aspectRatio => ({ id: templateAVariantId(aspectRatio), aspectRatio, size: { ...TEMPLATE_A_IMAGE_SIZES[aspectRatio] }, status: 'pending', framing: TEMPLATE_A_RATIO_FRAMING[aspectRatio],
      prompt: buildTemplateAVariantPrompt(base.basePrompt, aspectRatio), generator: { provider: 'openai', model: config.model }, attempts: 0, decompositions: [] }));
  } catch (error) { throw new RunError('INVALID_PROMPT', `${error instanceof Error ? error.message : String(error)} Shorten the prompt.`); }
  const now = new Date().toISOString(), id = `${now.replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`, dir = join(root, id);
  const group: GenerationGroup = { id, templateKey: 'template-a', version: TEMPLATE_A_GENERATION_VERSION, createdAt: now, updatedAt: now, fields: values, builtPrompt: base.builtPrompt, basePrompt: base.basePrompt, promptEdited: base.promptEdited,
    structure: structureFrom(values), aspectRatios: [...TEMPLATE_A_ASPECT_RATIOS], variants };
  mkdirSync(dir, { recursive: true });
  write(dir, GROUP_FILE, group);
  return { group, requested: wanted.map(templateAVariantId) };
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
type ApiFailure = { status?: number; code?: string | null; type?: string; requestID?: string | null; error?: unknown };
function failureCode(error: unknown): string {
  if (error instanceof RunError) return error.code;
  const { status, code } = error as ApiFailure;
  if (status === undefined) return 'GENERATION_FAILED';
  if (code === 'moderation_blocked' || code === 'content_policy_violation') return 'PROVIDER_SAFETY_REFUSAL';
  if (status === 401 || status === 403) return 'PROVIDER_AUTH';
  if (code === 'insufficient_quota' || code === 'billing_hard_limit_reached') return 'PROVIDER_CREDITS';
  if (status === 429) return 'PROVIDER_RATE_LIMITED';
  return status >= 500 ? 'PROVIDER_NETWORK' : 'PROVIDER_REJECTED';
}

/**
 * Generates one variant: one OpenAI image request (never resent) with that variant's stored prompt at its exact size,
 * one PNG back. Only this variant of the group is written: its image, or its error with OpenAI's status, message and
 * complete error response. A failure is saved and returned, never thrown, and leaves every other variant as it is.
 */
export async function generateVariant(root: string, groupId: string, variantId: string, config: GenerationConfig): Promise<GenerationGroup> {
  const dir = groupDir(root, groupId), files = { request: `${variantId}.openai-request.json`, response: `${variantId}.openai-response.json`, error: `${variantId}.provider-error.json` };
  const started = Date.now();
  const sending = findVariant(update(root, groupId, (group) => {
    const variant = findVariant(group, variantId);
    if (variant.status === 'done') throw new RunError('ALREADY_GENERATED', `The ${variant.aspectRatio} variant already has its image.`);
    Object.assign(variant, { status: 'generating', attempts: variant.attempts + 1, startedAt: new Date(started).toISOString(), generator: { provider: 'openai', model: config.model }, requestFile: files.request });
    // What an earlier attempt left behind does not describe this one.
    delete variant.error; delete variant.responseFile; delete variant.finishedAt; delete variant.durationMs;
  }), variantId);
  const request = { model: config.model, prompt: sending.prompt, size: `${sending.size.width}x${sending.size.height}`, n: 1, output_format: 'png' as const };
  write(dir, files.request, request);
  let outcome: Partial<GenerationVariant>, requestId: string | undefined, responseSaved = false;
  try {
    const response = await config.client().images.generate(request);
    requestId = (response as { _request_id?: string | null })._request_id ?? undefined;
    // The response as returned, with the image bytes left to the image file.
    write(dir, files.response, { ...response, data: (response.data ?? []).map(({ b64_json, ...rest }) => ({ ...rest, b64_json: b64_json ? `<${b64_json.length} base64 characters: the saved image>` : undefined })) });
    responseSaved = true;
    const encoded = response.data?.[0]?.b64_json;
    if (!encoded) throw new RunError('NO_IMAGE', 'OpenAI returned no image.');
    const bytes = Buffer.from(encoded, 'base64');
    const meta = await sharp(bytes).metadata().catch(() => ({ format: undefined, width: undefined, height: undefined }));
    if (!['png', 'jpeg', 'webp'].includes(meta.format ?? '') || !meta.width || !meta.height) throw new RunError('INVALID_IMAGE', 'OpenAI returned a file that is not a PNG, JPEG or WebP image.');
    const file = `${variantId}.image.${meta.format === 'jpeg' ? 'jpg' : meta.format}`;
    // Saved exactly as OpenAI returned it: the decomposition gets these bytes, never a re-encoded copy.
    writeFileSync(join(dir, file), bytes);
    outcome = { status: 'done', responseFile: files.response, image: { file, mimeType: `image/${meta.format}`, width: meta.width, height: meta.height, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } };
  } catch (error) {
    const api: ApiFailure = error instanceof RunError ? {} : error as ApiFailure, message = error instanceof Error ? error.message : String(error);
    requestId = api.requestID ?? requestId;
    if (api.status !== undefined) write(dir, files.error, { requestId, capturedAt: new Date().toISOString(), status: api.status, body: api.error ?? null });
    outcome = { status: 'failed', ...(responseSaved ? { responseFile: files.response } : {}),
      error: { code: failureCode(error), message, ...(api.status !== undefined ? { status: api.status, messages: [{ msg: message, ...(api.code ?? api.type ? { type: (api.code ?? api.type)! } : {}) }], bodyFile: files.error } : {}) } };
  }
  return update(root, groupId, (group) => {
    const variant = findVariant(group, variantId);
    Object.assign(variant, outcome, { finishedAt: new Date().toISOString(), durationMs: Date.now() - started });
    if (requestId) variant.generator.requestId = requestId;
  });
}

/**
 * A group as it is shown: a variant still marked queued or generating that this process is not working on was left
 * behind by a stopped server, so it is shown as failed (interrupted) and can be generated again. The file is not
 * changed by looking at it.
 */
export function presentGroup(group: GenerationGroup, inProgress: (variantId: string) => boolean): GenerationGroup {
  return { ...group, variants: group.variants.map(variant => (variant.status === 'queued' || variant.status === 'generating') && !inProgress(variant.id)
    ? { ...variant, status: 'failed' as const, error: { code: 'INTERRUPTED', message: 'The server stopped before this variant finished. Generate it again.' } } : variant) };
}

/** The saved image of a finished variant, exactly as generated, for a decomposition. */
export function variantImage(root: string, groupId: string, variantId: string): { group: GenerationGroup; variant: GenerationVariant; bytes: Buffer } {
  const group = readGroup(root, groupId), variant = findVariant(group, variantId);
  if (variant.status !== 'done' || !variant.image) throw new RunError('NOT_DECOMPOSABLE', `The ${variant.aspectRatio} variant of generation ${groupId} has no image to decompose (${variant.status}${variant.error ? `: ${variant.error.message}` : ''}).`);
  return { group, variant, bytes: readFileSync(join(groupDir(root, groupId), variant.image.file)) };
}
/** Links a decomposition run to the variant it was made from. An older one-image record keeps its own file format. */
export function recordDecomposition(root: string, groupId: string, variantId: string, entry: VariantDecomposition): GenerationGroup {
  const dir = groupDir(root, groupId);
  if (existsSync(join(dir, GROUP_FILE))) return update(root, groupId, (group) => { findVariant(group, variantId).decompositions.push(entry); });
  const record = JSON.parse(readFileSync(join(dir, LEGACY_FILE), 'utf8')) as LegacyRecord;
  write(dir, LEGACY_FILE, { ...record, decompositions: [...(record.decompositions ?? []), entry], updatedAt: new Date().toISOString() });
  return readGroup(root, groupId);
}
