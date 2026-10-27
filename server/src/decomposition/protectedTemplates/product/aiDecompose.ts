/**
 * AI decomposition of a Product with Text template: an OpenAI PLANNER writes the instructions, Seedream 5.0 Pro LAYERIZE
 * (fal `bytedance/seedream/v5/pro/layerize`) splits the picture into layers.
 *
 *   input     the picture WITHOUT its text and its overlay logos (bank, payment, QR, partner): prepare.ts removes them
 *             first and keeps them as editable layers with their word-by-word coordinates; their pixels never reach
 *             either model. Only the reviewed elements' names, kinds and boxes go with it — never a word of the text.
 *   planner   one OpenAI request (structured JSON): the Seedream prompt — which reviewed element becomes which layer,
 *             front to back, and what stays the background — and the planned layers, each tied to an element id
 *   seedream  one Layerize request with that prompt: RGBA layers on the picture's canvas (its background first)
 *
 * prepare.ts maps the layers to the reviewed elements (by place, the planned names breaking ties), takes each element's
 * pixels from the creative itself where they are seen, and uses Seedream's background where an element was. An element
 * Seedream did not return keeps the local cut-out. Each call is made once, only after the person approved its cost; a
 * failure is reported, never retried by itself.
 */
import OpenAI from 'openai';
import sharp from 'sharp';
import { AI_PRICING, type ProductObjectKind } from '@frameflow/shared';
import { decompositionPlannerModel } from '../../aiModels.js';
import { MAX_LAYERIZE_PROMPT, type PlannerUsage } from '../../layerizePlanner.js';
import { buildProviderInput, normalizeProviderOutput, ProviderError, endpointRegistry } from '../../providers/adapters.js';
import type { FalTransport } from '../../providers/falClient.js';
import { classifySeedreamRejection, prepareProviderImage, ProviderImageError, rejectionExplanation } from '../../providerImage.js';
import { openAIFailureSummary, openAIRequestDiagnostics } from '../../../services/openAIRequestDiagnostics.js';
import { sha256 } from '../pixels.js';
import { placedOverlay, placeLayers } from '../../layerizeArtifacts.js';

type Box = { x: number; y: number; width: number; height: number };
export const SEEDREAM_LAYERIZE = endpointRegistry.seedream.endpoint;
/** The planner request's estimate (one structured answer about a picture); Seedream's is per returned layer. */
export const DECOMPOSITION_PLANNER_USD = 0.08;
export const SEEDREAM_MAX_LAYERS = 17;

/** A reviewed element as the planner sees it (in the sent picture's pixels). */
export interface DecompositionElement { id: string; kind: ProductObjectKind; label: string; box: Box; decompose: boolean }
export interface DecompositionRequest {
  /** PNG of the picture without text and overlay logos, at the size Seedream gets. */
  image: Buffer; width: number; height: number;
  elements: DecompositionElement[];
  /** What was taken out before (counts and logo names only: never pixels, never the words). */
  excluded: { textBlocks: number; words: number; logos: string[] };
}
export interface DecompositionPlan { prompt: string; layers: { element_id: string; name: string; description: string }[]; background: string; warnings: string[] }
export interface LayerizedLayer { png: Buffer; zIndex: number; name?: string; description?: string }
export interface AiDecomposition {
  plan: DecompositionPlan;
  planner: { model: string; offline: boolean; responseId?: string; usage?: PlannerUsage; costUsd: number };
  seedream: { endpoint: string; offline: boolean; requestId?: string; layers: number; costUsd: number; imageSha256: string };
  /** RGBA layers on the sent picture's canvas, back to front. */
  layers: LayerizedLayer[];
}
export type Save = (file: string, value: object) => void;
export interface ProductDecompositionPlanner { model: string; offline: boolean; plan(request: DecompositionRequest, save: Save): Promise<{ plan: DecompositionPlan; responseId?: string; usage?: PlannerUsage }> }
export interface ProductLayerizer {
  /** Shown to the person: what plans and what decomposes. */
  planner: string; engine: string; offline: boolean;
  decompose(request: DecompositionRequest, save: Save): Promise<AiDecomposition>;
}
export class AiDecompositionError extends Error {
  constructor(public readonly code: string, message: string, public readonly details: { requestId?: string; stage: 'planner' | 'seedream' } = { stage: 'seedream' }) { super(message); this.name = 'AiDecompositionError'; }
}

/** The size Seedream gets: under its higher price tier (1536² pixels) and at least its minimum (512²). */
export function sentSize(w: number, h: number): { width: number; height: number; scale: number } {
  const limit = AI_PRICING.seedream.thresholdPixels - 1, scale = Math.min(1, Math.sqrt(limit / (w * h)));
  let width = Math.max(1, Math.floor(w * scale)), height = Math.max(1, Math.floor(h * scale));
  if (width * height < 512 * 512) { const up = Math.sqrt((512 * 512) / (width * height)); width = Math.ceil(width * up); height = Math.ceil(height * up); }
  return { width, height, scale: width / w };
}
/**
 * An element's place as Seedream reads it in a prompt: `<bbox>left top right bottom</bbox>`, normalised to 0–1000 of the
 * picture (fal's schema: "Normalized <bbox> tags may be used for precise coordinate targeting").
 */
export const bboxTag = (b: Box, w: number, h: number) => {
  const n = (v: number, d: number) => Math.max(0, Math.min(1000, Math.round((1000 * v) / d)));
  return `<bbox>${n(b.x, w)} ${n(b.y, h)} ${n(b.x + b.width, w)} ${n(b.y + b.height, h)}</bbox>`;
};
/** What the AI decomposition can cost: the planner's request and every layer Seedream may return (at most 17). */
export function aiDecompositionEstimate(size: { width: number; height: number }, elements: number) {
  const perLayer = size.width * size.height < AI_PRICING.seedream.thresholdPixels ? AI_PRICING.seedream.low : AI_PRICING.seedream.high;
  const expected = Math.min(SEEDREAM_MAX_LAYERS, elements + 1), round = (v: number) => Math.round(v * 100) / 100;
  return { plannerUsd: DECOMPOSITION_PLANNER_USD, perLayerUsd: perLayer, expectedLayers: expected, expectedUsd: round(DECOMPOSITION_PLANNER_USD + expected * perLayer), maxUsd: round(DECOMPOSITION_PLANNER_USD + SEEDREAM_MAX_LAYERS * perLayer) };
}

const PLAN_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['prompt', 'layers', 'background', 'warnings'],
  properties: {
    prompt: { type: 'string', description: `The Seedream Layerize instructions, at most ${MAX_LAYERIZE_PROMPT} characters.` },
    layers: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['element_id', 'name', 'description'], properties: { element_id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' } } } },
    background: { type: 'string' }, warnings: { type: 'array', items: { type: 'string' } },
  },
} as const;
export const PLANNER_INSTRUCTIONS = `You plan the decomposition of an advertising creative into editable image layers by Seedream 5.0 Pro Layerize.
The picture you get has ALREADY had its text and its overlay logos (bank, payment, partner, QR) removed: they are kept as separate editable layers and must not appear in any layer. Do not ask for text or logo layers.
You also get the reviewed elements: each with an id, a kind, a name, a box in the picture's pixels, and whether it must become its own layer ("decompose": true) or stay part of the background ("decompose": false).
Write:
- prompt: the instructions for Seedream, in plain English, at most ${MAX_LAYERIZE_PROMPT} characters. Name every element to decompose as its own separate layer (one layer each, never two products together, never a product merged with a character, a stand or the background), and right after each name write its "bbox" tag EXACTLY as given (Seedream reads these tags as the element's place), list them front to back, and say that everything else — including the elements to keep in the background, display podiums not chosen, decorations, frames and patterns — is ONE background layer, completed where the decomposed elements covered it. Keep each object whole and clean: no pieces of the background or of a neighbour inside it.
- layers: one entry per element to decompose, with its element_id exactly as given, a short distinct name (the one used in the prompt) and a one-line description of what it looks like.
- background: one line on what the background layer contains.
- warnings: anything that may go wrong (an element partly hidden, two elements touching, a tiny element), else empty.`;

/** The live planner: one OpenAI Responses request with the picture (no text, no overlay logos) and the reviewed elements. */
export function liveDecompositionPlanner(options: { apiKey?: string; model?: string; client?: Pick<OpenAI, 'responses'> & Partial<Pick<OpenAI, 'baseURL'>> } = {}): ProductDecompositionPlanner {
  const model = options.model?.trim() || decompositionPlannerModel();
  return { model, offline: false, async plan(request, save) {
    if (!options.client && !(options.apiKey ?? process.env.OPENAI_API_KEY)?.trim()) throw new AiDecompositionError('PLANNER_NOT_CONFIGURED', 'Set OPENAI_API_KEY in server/.env for the decomposition planner.', { stage: 'planner' });
    const client = options.client ?? new OpenAI({ apiKey: options.apiKey ?? process.env.OPENAI_API_KEY, maxRetries: 0, timeout: 180_000 });
    const elements = request.elements.map(e => ({ id: e.id, kind: e.kind, name: e.label, box: e.box, bbox: bboxTag(e.box, request.width, request.height), decompose: e.decompose }));
    const body = { picture: { width: request.width, height: request.height }, elements, removed_before: { text_blocks: request.excluded.textBlocks, words: request.excluded.words, logos: request.excluded.logos } };
    const call = {
      model, reasoning: { effort: 'low' as const }, store: false, instructions: PLANNER_INSTRUCTIONS,
      input: [{ role: 'user' as const, content: [
        { type: 'input_text' as const, text: JSON.stringify(body) },
        { type: 'input_image' as const, image_url: `data:image/png;base64,${request.image.toString('base64')}`, detail: 'high' as const },
      ] }],
      text: { format: { type: 'json_schema' as const, name: 'product_decomposition_plan', schema: PLAN_SCHEMA as unknown as Record<string, unknown>, strict: true } },
    };
    save('ai-planner-request.json', { ...call, input: [{ role: 'user', content: [call.input[0].content[0], { type: 'input_image', image_url: `<image/png, ${request.image.length} bytes, sha256 ${sha256(request.image)}>` }] }] });
    const started = Date.now();
    let response: unknown;
    try { response = await client.responses.create(call); }
    catch (error) {
      const d = openAIRequestDiagnostics(error, { baseURL: client.baseURL, elapsedMs: Date.now() - started, timeoutMs: 180_000, imageBytes: request.image.length, requestBytes: Buffer.byteLength(JSON.stringify(call)) });
      throw new AiDecompositionError('PLANNER_API_ERROR', `The OpenAI planner (${model}) request failed: ${openAIFailureSummary(d.error)}. Seedream was not called.`, { stage: 'planner' });
    }
    save('ai-planner-response.json', response as object);
    const r = response as { id?: string; status?: string; output?: { type: string; content?: { type: string; refusal?: string; text?: string }[] }[]; output_text?: string; usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number; output_tokens_details?: { reasoning_tokens?: number } } };
    const content = (r.output ?? []).filter(o => o.type === 'message').flatMap(o => o.content ?? []);
    const refusal = content.find(c => c.type === 'refusal');
    if (refusal) throw new AiDecompositionError('PLANNER_REFUSED', `The planner refused: ${refusal.refusal ?? '(no reason given)'}. Seedream was not called.`, { stage: 'planner' });
    if (r.status !== 'completed') throw new AiDecompositionError('PLANNER_INCOMPLETE', `The planner's answer is ${r.status ?? 'unknown'}. Seedream was not called.`, { stage: 'planner' });
    let parsed: unknown;
    try { parsed = JSON.parse(r.output_text ?? content.filter(c => c.type === 'output_text').map(c => c.text ?? '').join('')); }
    catch { throw new AiDecompositionError('PLANNER_INVALID_JSON', 'The planner did not return valid JSON. Seedream was not called.', { stage: 'planner' }); }
    return { plan: checkDecompositionPlan(parsed, request), responseId: r.id,
      ...(r.usage ? { usage: { input_tokens: r.usage.input_tokens, output_tokens: r.usage.output_tokens, reasoning_tokens: r.usage.output_tokens_details?.reasoning_tokens, total_tokens: r.usage.total_tokens } } : {}) };
  } };
}

/** The planner's answer checked: a prompt within Seedream's limit, layers naming only elements chosen for decomposition. */
export function checkDecompositionPlan(value: unknown, request: Pick<DecompositionRequest, 'elements' | 'width' | 'height'>): DecompositionPlan {
  const v = value as Partial<DecompositionPlan> | null, bad = (m: string) => new AiDecompositionError('PLANNER_INVALID_PLAN', `${m} Seedream was not called.`, { stage: 'planner' });
  if (!v || typeof v !== 'object' || typeof v.prompt !== 'string' || !Array.isArray(v.layers) || typeof v.background !== 'string' || !Array.isArray(v.warnings)) throw bad('The planner\'s answer does not match its schema.');
  const prompt = v.prompt.trim();
  if (!prompt) throw bad('The planner returned an empty prompt.');
  if (prompt.length > MAX_LAYERIZE_PROMPT) throw bad(`The planner's prompt has ${prompt.length} characters; Seedream takes at most ${MAX_LAYERIZE_PROMPT}.`);
  const chosen = new Set(request.elements.filter(e => e.decompose).map(e => e.id)), seen = new Set<string>(), warnings = v.warnings.filter((w): w is string => typeof w === 'string').map(w => w.slice(0, 300));
  const layers = v.layers.filter(l => l && typeof l.element_id === 'string' && typeof l.name === 'string').filter(l => {
    if (!chosen.has(l.element_id) || seen.has(l.element_id)) { warnings.push(`A planned layer for an element not chosen (or planned twice) was left out: ${l.element_id}.`); return false; }
    seen.add(l.element_id); return true;
  }).map(l => ({ element_id: l.element_id, name: l.name.trim().slice(0, 100), description: String(l.description ?? '').trim().slice(0, 300) }));
  for (const id of chosen) if (!seen.has(id)) warnings.push(`The plan has no layer for “${request.elements.find(e => e.id === id)!.label}”: it keeps the local cut-out if Seedream does not return it.`);
  // Every element chosen is in the prompt with its reviewed place: a tag the planner left out (or changed) is added here,
  // with its name, as long as the prompt stays within Seedream's limit.
  let out = prompt;
  for (const e of request.elements.filter(x => x.decompose)) {
    const tag = bboxTag(e.box, request.width, request.height); if (out.includes(tag)) continue;
    const line = `\nSeparate layer: ${layers.find(l => l.element_id === e.id)?.name ?? e.label} ${tag}.`;
    if (out.length + line.length > MAX_LAYERIZE_PROMPT) { warnings.push(`No room left in the prompt for the place of “${e.label}”.`); continue; }
    out += line; warnings.push(`The place of “${e.label}” was added to the prompt (the planner left its tag out).`);
  }
  return { prompt: out, layers, background: v.background.trim().slice(0, 500), warnings };
}

/**
 * A fal refusal in words a person can act on: our reading of it, what fal itself said (its key or account message, e.g. a
 * locked account or an exhausted balance), and what to change.
 */
export function falFailureMessage(error: unknown): string {
  const ours = error instanceof Error ? error.message : String(error);
  if (!(error instanceof ProviderError)) return ours;
  const said = (error.providerDetail?.messages ?? []).map(m => m.msg).filter(Boolean).join(' ').slice(0, 300);
  const fix = error.code === 'PROVIDER_AUTH'
    ? (error.status === 401 ? 'FAL_KEY is not a valid, active fal key: create one at fal.ai/dashboard/keys, put it in .env and server/.env, and restart the server.'
      : 'The fal account refused the key: usually its balance is used up (top up at fal.ai/dashboard/billing), or the key was revoked or lacks access (fal.ai/dashboard/keys). Restart the server after changing FAL_KEY.')
    : error.code === 'PROVIDER_CREDITS' ? 'Top up the fal balance at fal.ai/dashboard/billing.' : '';
  return `${ours}${said ? ` fal said: “${said}”` : ''}${fix ? ` ${fix}` : ''}`.trim();
}

export interface SeedreamUpload { url: string; imageSha256: string; width: number; height: number }
/**
 * The picture made ready for Seedream and uploaded to fal: free, so it is done before anything paid. A refused key or
 * account (or no key) stops there, with nothing spent on the planner or Seedream. fal's answer is saved beside the run.
 */
export async function uploadForSeedream(transport: FalTransport, image: Buffer, save: Save): Promise<SeedreamUpload> {
  let prepared: Awaited<ReturnType<typeof prepareProviderImage>>;
  try { prepared = await prepareProviderImage(image, 'image/png'); }
  catch (error) { throw new AiDecompositionError(error instanceof ProviderImageError ? error.code : 'INVALID_SEEDREAM_INPUT', `${error instanceof Error ? error.message : String(error)} (nothing was sent)`); }
  try { return { url: await transport.upload(prepared.bytes, prepared.report.provider.mime), imageSha256: prepared.report.provider.sha256, width: prepared.report.provider.width, height: prepared.report.provider.height }; }
  catch (error) {
    if (error instanceof ProviderError) save('seedream-upload-error.json', { code: error.code, status: error.status, detail: error.providerDetail ?? null });
    throw new AiDecompositionError('FAL_UPLOAD_FAILED', `The picture could not be uploaded to fal: ${falFailureMessage(error)} Nothing was sent to OpenAI or Seedream, and nothing was charged.`);
  }
}

/** One Seedream Layerize request: upload (unless done already), submit (once), poll, read, download every layer, put each on the sent canvas. */
export async function seedreamLayerize(options: { transport: FalTransport; image: Buffer; width: number; height: number; prompt: string; save: Save; uploaded?: SeedreamUpload; sleep?: (ms: number) => Promise<void>; pollIntervalMs?: number; pollTimeoutMs?: number }): Promise<{ requestId: string; layers: LayerizedLayer[]; imageSha256: string; costUsd: number }> {
  const { transport, save } = options, sleep = options.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
  const { url, imageSha256, width, height } = options.uploaded ?? await uploadForSeedream(transport, options.image, save);
  const input = buildProviderInput('seedream', { imageUrl: url, prompt: options.prompt });
  save('seedream-request.json', { endpoint: SEEDREAM_LAYERIZE, input: { ...input, image_url: `<fal upload, ${width}×${height}, sha256 ${imageSha256}>` } });
  let requestId: string;
  try { ({ requestId } = await transport.submit(SEEDREAM_LAYERIZE, input)); }
  catch (error) { throw new AiDecompositionError('FAL_SUBMIT_FAILED', `Seedream did not accept the request: ${falFailureMessage(error)} No request ID was returned.`); }
  save('seedream-request.json', { endpoint: SEEDREAM_LAYERIZE, requestId, input: { ...input, image_url: `<fal upload, sha256 ${imageSha256}>` } });
  const t0 = Date.now();
  for (let failures = 0; ;) {
    let status: string;
    try { status = await transport.status(SEEDREAM_LAYERIZE, requestId); failures = 0; }
    catch (error) { if (++failures >= 3) throw new AiDecompositionError('FAL_STATUS_FAILED', `Seedream request ${requestId}: its status could not be read (${error instanceof Error ? error.message : String(error)}).`, { requestId, stage: 'seedream' }); await sleep(options.pollIntervalMs ?? 3000); continue; }
    if (status === 'COMPLETED') break;
    if (Date.now() - t0 > (options.pollTimeoutMs ?? 10 * 60_000)) throw new AiDecompositionError('POLL_TIMEOUT', `Seedream request ${requestId} is still ${status} after ten minutes.`, { requestId, stage: 'seedream' });
    await sleep(options.pollIntervalMs ?? 3000);
  }
  let raw: unknown;
  try { raw = await transport.result(SEEDREAM_LAYERIZE, requestId); }
  catch (error) {
    if (error instanceof ProviderError && error.status === 422) {
      const rejection = classifySeedreamRejection(error.providerDetail, { endpoint: SEEDREAM_LAYERIZE, imageSha256, prompt: options.prompt, status: 422 });
      throw new AiDecompositionError('PROVIDER_DECOMPOSITION_REJECTED', `Seedream refused request ${requestId}: ${rejectionExplanation(rejection)}`, { requestId, stage: 'seedream' });
    }
    throw new AiDecompositionError('FAL_RESULT_FAILED', `Seedream request ${requestId}: its result could not be read (${error instanceof Error ? error.message : String(error)}).`, { requestId, stage: 'seedream' });
  }
  save('seedream-response.json', raw as object);
  let normalized: ReturnType<typeof normalizeProviderOutput>;
  try { normalized = normalizeProviderOutput('seedream', raw); }
  catch (error) { throw new AiDecompositionError(error instanceof ProviderError ? error.code : 'PROVIDER_RESULT_UNPARSED', `Seedream request ${requestId}: ${error instanceof Error ? error.message : String(error)}`, { requestId, stage: 'seedream' }); }
  // Each layer comes as its own picture (a crop, at its own resolution) with its box on the base image (z_index 0): placed
  // on the base's canvas as the run pipeline places them (layerizeArtifacts.ts), then that canvas is put on the sent
  // picture's. A layer that cannot be placed without distortion is left out, and said so.
  const downloaded = await Promise.all(normalized.images.map(async (img, k) => { const bytes = await sharp(await transport.download(img.url)).ensureAlpha().png().toBuffer(), m = await sharp(bytes).metadata(); return { png: bytes, width: m.width!, height: m.height!, meta: normalized.layers?.[k] ?? { zIndex: k } }; }));
  const placed = placeLayers(downloaded), layers: LayerizedLayer[] = [], unplaced: string[] = [];
  for (const [k, d] of downloaded.entries()) {
    const overlay = await placedOverlay(d.png, placed.placements[k], placed.canvas);
    if (!overlay) { unplaced.push(`${d.meta.name ?? `layer ${d.meta.zIndex}`}: ${(placed.placements[k] as { reason?: string }).reason ?? 'off the canvas'}`); continue; }
    const canvasPng = await sharp({ create: { width: placed.canvas.width, height: placed.canvas.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([overlay]).png().toBuffer();
    const png = placed.canvas.width === options.width && placed.canvas.height === options.height ? canvasPng : await sharp(canvasPng).resize(options.width, options.height, { fit: 'fill' }).png().toBuffer();
    layers.push({ png, zIndex: d.meta.zIndex, ...(d.meta.name ? { name: d.meta.name } : {}), ...(d.meta.description ? { description: d.meta.description } : {}) });
  }
  layers.sort((a, b) => a.zIndex - b.zIndex);
  save('seedream-layers.json', { base: placed.canvas, layers: downloaded.map((d, k) => ({ z: d.meta.zIndex, name: d.meta.name ?? null, size: [d.width, d.height], placement: placed.placements[k] })), warnings: placed.warnings, unplaced });
  // (Billed per returned layer, at the tier of the base Seedream made — not only the ones placed.)
  const tier = placed.canvas.width * placed.canvas.height < AI_PRICING.seedream.thresholdPixels ? AI_PRICING.seedream.low : AI_PRICING.seedream.high;
  return { requestId, layers, imageSha256, costUsd: Math.round(downloaded.length * tier * 10000) / 10000 };
}

/** The decomposition core: the planner's prompt, then Seedream. */
export function createProductLayerizer(options: { planner: ProductDecompositionPlanner; transport: () => FalTransport; sleep?: (ms: number) => Promise<void>; pollIntervalMs?: number }): ProductLayerizer {
  return { planner: options.planner.model, engine: SEEDREAM_LAYERIZE, offline: options.planner.offline, async decompose(request, save) {
    // fal first, and free: no key, a refused key or a locked account stops here, before the planner is paid for.
    let transport: FalTransport;
    try { transport = options.transport(); } catch (error) { throw new AiDecompositionError('FAL_NOT_CONFIGURED', `${error instanceof Error ? error.message : String(error)} Nothing was sent to OpenAI or Seedream.`); }
    const uploaded = await uploadForSeedream(transport, request.image, save);
    const planned = await options.planner.plan(request, save);
    save('ai-plan.json', planned.plan);
    const s = await seedreamLayerize({ transport, image: request.image, width: request.width, height: request.height, prompt: planned.plan.prompt, save, uploaded, ...(options.sleep ? { sleep: options.sleep } : {}), ...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {}) });
    return { plan: planned.plan, planner: { model: options.planner.model, offline: options.planner.offline, ...(planned.responseId ? { responseId: planned.responseId } : {}), ...(planned.usage ? { usage: planned.usage } : {}), costUsd: options.planner.offline ? 0 : DECOMPOSITION_PLANNER_USD },
      seedream: { endpoint: SEEDREAM_LAYERIZE, offline: false, requestId: s.requestId, layers: s.layers.length, costUsd: s.costUsd, imageSha256: s.imageSha256 }, layers: s.layers };
  } };
}

/**
 * OFFLINE STAND-IN (tests and the offline demo server only; no OpenAI, no Seedream): a plan written from the elements,
 * and "layers" made on this computer — the picture as the background, and each element's box with the pixels unlike its
 * border's colours. It exercises the whole route; it says nothing about Seedream's quality, and is labelled so wherever it
 * shows.
 */
export function standInProductLayerizer(): ProductLayerizer & { calls: DecompositionRequest[] } {
  const calls: DecompositionRequest[] = [];
  return { planner: 'offline stand-in planner (not OpenAI)', engine: 'offline stand-in decomposer (not Seedream)', offline: true, calls, async decompose(request, save) {
    calls.push(request);
    const chosen = request.elements.filter(e => e.decompose);
    const plan: DecompositionPlan = { prompt: `Decompose into separate layers, front to back: ${chosen.map(e => e.label).join('; ')}. Everything else is one background layer.`.slice(0, MAX_LAYERIZE_PROMPT),
      layers: chosen.map(e => ({ element_id: e.id, name: e.label, description: e.kind })), background: 'Everything not decomposed.', warnings: ['Offline stand-in: not a model.'] };
    save('ai-plan.json', plan);
    const { data } = await sharp(request.image).removeAlpha().raw().toBuffer({ resolveWithObject: true }), W = request.width, H = request.height;
    const layers: LayerizedLayer[] = [{ png: await sharp(request.image).ensureAlpha().png().toBuffer(), zIndex: 0, name: 'Background' }];
    for (const [k, e] of chosen.entries()) {
      const x0 = Math.max(0, Math.round(e.box.x)), y0 = Math.max(0, Math.round(e.box.y)), x1 = Math.min(W, Math.round(e.box.x + e.box.width)), y1 = Math.min(H, Math.round(e.box.y + e.box.height));
      const ring: number[][] = [[], [], []];
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (y === y0 || y === y1 - 1 || x === x0 || x === x1 - 1) for (let c = 0; c < 3; c++) ring[c].push(data[(y * W + x) * 3 + c]);
      const med = ring.map(v => { v.sort((p, q) => p - q); return v[v.length >> 1] ?? 0; }), out = Buffer.alloc(W * H * 4);
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = y * W + x; if (Math.max(...[0, 1, 2].map(c => Math.abs(data[i * 3 + c] - med[c]))) <= 40) continue; for (let c = 0; c < 3; c++) out[i * 4 + c] = data[i * 3 + c]; out[i * 4 + 3] = 255; }
      layers.push({ png: await sharp(out, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer(), zIndex: k + 1, name: e.label });
    }
    return { plan, planner: { model: 'offline stand-in planner (not OpenAI)', offline: true, costUsd: 0 }, seedream: { endpoint: 'offline stand-in decomposer (not Seedream)', offline: true, layers: layers.length, costUsd: 0, imageSha256: sha256(request.image) }, layers };
  } };
}
