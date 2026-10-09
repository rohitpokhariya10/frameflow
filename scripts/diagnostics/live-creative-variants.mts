/**
 * Live validation of "Generate creative template", with hard limits on paid calls. Two plans, run one at a time:
 *
 *   Plan A  ONE gpt-image-2 masked edit at 9:16 (864×1536): is the size accepted? The Mijia products (their saved
 *           Seedream-layer cutouts, so no fal call) are placed on a 9:16 canvas with one fixed concept, then composed
 *           and measured exactly as a variant would be.
 *   Plan B  The real pipeline (createSmartCreative.startVariants) on the saved Mijia analysis (no analysis call):
 *           SAM-3 masks (4 requests), 1 concept call, 3 image edits at 4:5, AI check off.
 *
 * Protections:
 *   - Every paid client is wrapped with a hard cap per plan, checked BEFORE a request is sent (CAPS below). A call over
 *     the cap is refused and recorded; the resolver, analyzer and AI check are refused outright.
 *   - Nothing is retried: the OpenAI and fal clients have retries off, and a failed call is recorded and left failed.
 *   - Every call is written to <out>/plan-x/ledger.json as it happens (request id, usage, timing, error); costs are
 *     computed from recorded usage with the app's price table (fal SAM-3 at its listed price per accepted request).
 *   - A live run needs --live; --dry swaps every paid client for an offline fake and removes the API keys from this
 *     process first. A plan never runs twice into the same folder (an existing ledger stops it).
 *   - Outputs must stay under artifacts/decomposition/ (git-ignored). Keys are read from the environment only (the
 *     existing client factories read OPENAI_API_KEY and FAL_KEY); nothing here writes or prints them.
 *
 * Usage, from the repository root:
 *   node --conditions=development --import tsx scripts/diagnostics/live-creative-variants.mts <A|B> --dry [--cap-test] [--out <dir>]
 *   node --conditions=development --import tsx scripts/diagnostics/live-creative-variants.mts <A|B> --live [--out <dir>]
 * A live run needs OPENAI_API_KEY (both plans) and FAL_KEY (Plan B) in the environment, e.g. exported from server/.env
 * by the caller. The saved Mijia artifacts are read from FRAMEFLOW_REPLAY_ARTIFACTS (default: this checkout's
 * artifacts/decomposition). --cap-test (dry only) lowers Plan B's image cap to 2 to show the third edit being refused.
 * Default output: artifacts/decomposition/diagnostics/live-creative-variants (live) or …-dry-<time> (dry).
 */
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { toFile } from 'openai';
import { AI_PRICING, calculateCallCost, compileVariantPrompt, conceptScene, parseConcept, type VariantSet } from '@frameflow/shared';
import { liveGenerationConfig } from '../../server/src/decomposition/generationGroups.js';
import { createFalTransport, type FalTransport } from '../../server/src/decomposition/providers/falClient.js';
import { usageFacts } from '../../server/src/decomposition/runDiagnostics.js';
import { fileExecutionStore } from '../../server/src/decomposition/creativeTemplates/executions.js';
import { liveSegmenter } from '../../server/src/decomposition/creativeTemplates/segmenter.js';
import { createSmartCreative, readSmartFeatures } from '../../server/src/decomposition/creativeTemplates/smartCreative.js';
import { liveConceptWriter } from '../../server/src/decomposition/creativeTemplates/smartProviders.js';
import { fileSceneStore, fileVariantStore } from '../../server/src/decomposition/creativeTemplates/smartStores.js';
import { fileTemplateStore } from '../../server/src/decomposition/creativeTemplates/store.js';
import { composeVariant, maskBox, maskRaster, refineEdges, sourceRaster, type Raster } from '../../server/src/decomposition/creativeTemplates/variantCompose.js';
import { backgroundColour, canvasInputs, DEFAULT_COMPOSITION, groupBox, placeGroup, placeProducts, touchedEdges } from '../../server/src/decomposition/creativeTemplates/variantLayout.js';
import { falSegmentation, imagesClient, mijiaReplay, replayRoot } from '../../server/src/decomposition/creativeTemplates/variantTestKit.js';
import { createOpenAIClient } from '../../server/src/services/openAIClient.js';

// ---- Arguments, inputs and the output folder ------------------------------------------------------------------------
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), ARTIFACTS = join(ROOT, 'artifacts', 'decomposition');
const args = process.argv.slice(2), plan = args[0] as 'A' | 'B', dry = args.includes('--dry'), live = args.includes('--live');
const usage = 'usage: live-creative-variants.mts <A|B> (--dry [--cap-test] | --live) [--out <dir under artifacts/decomposition>]';
if (!['A', 'B'].includes(plan) || dry === live) throw new Error(`${usage}\nChoose exactly one of --dry and --live.`);
if (dry) { delete process.env.OPENAI_API_KEY; delete process.env.FAL_KEY; } // a dry run can never reach a provider
else for (const key of plan === 'A' ? ['OPENAI_API_KEY'] : ['OPENAI_API_KEY', 'FAL_KEY']) if (!process.env[key]?.trim()) throw new Error(`Plan ${plan} --live needs ${key} in the environment.`);
const outArg = args.includes('--out') ? args[args.indexOf('--out') + 1] : undefined;
const out = resolve(outArg ?? join(ARTIFACTS, 'diagnostics', dry ? `live-creative-variants-dry-${new Date().toISOString().replace(/[:.]/g, '-')}` : 'live-creative-variants'));
if (!out.startsWith(ARTIFACTS + sep)) throw new Error(`Outputs stay under ${relative(process.cwd(), ARTIFACTS) || ARTIFACTS} (git-ignored); ${out} is outside it.`);
const dir = join(out, plan === 'A' ? 'plan-a' : 'plan-b');
if (existsSync(join(dir, 'ledger.json'))) throw new Error(`${dir} already has a ledger: this plan already ran there. Refusing to run it again.`);
// The saved Mijia creative: its upload, scene analysis, template and Seedream run (read only; Plan B works on a copy).
const SAVED = replayRoot(), ANALYSIS = '2026-10-09T05-57-10-343Z-765fa9', TEMPLATE = 'tpl-38c772960a45';
for (const p of [`scene-analyses/${ANALYSIS}/analysis.json`, `creative-templates/${TEMPLATE}/template.json`]) if (!existsSync(join(SAVED, p))) throw new Error(`The saved Mijia artifacts are missing (${join(SAVED, p)}). Set FRAMEFLOW_REPLAY_ARTIFACTS to the artifacts/decomposition folder that has them.`);
mkdirSync(dir, { recursive: true });
/** fal's listed price for fal-ai/sam-3-1/image (fal.ai model page, read 2026-10-09); fal reports no usage per request. */
const FAL_SAM3_USD = 0.01;

// ---- The hard caps and the ledger -----------------------------------------------------------------------------------
type Kind = 'imageEdit' | 'responses' | 'falSubmit' | 'falUpload';
const CAPS: Record<'A' | 'B', Record<Kind, number>> = { A: { imageEdit: 1, responses: 0, falSubmit: 0, falUpload: 0 }, B: { imageEdit: 3, responses: 1, falSubmit: 4, falUpload: 1 } };
// Dry only: show a call over the cap being refused before it is sent (Plan B's third image edit).
if (dry && args.includes('--cap-test')) CAPS.B.imageEdit = 2;
const used: Record<Kind, number> = { imageEdit: 0, responses: 0, falSubmit: 0, falUpload: 0 };
type Entry = Record<string, unknown> & { kind: Kind; at: string };
const calls: Entry[] = [], refused: { kind: Kind; at: string }[] = [];
const writeLedger = () => writeFileSync(join(dir, 'ledger.json'), JSON.stringify({ plan, dry, caps: CAPS[plan], used, refused, calls }, null, 2));
/** One paid call, counted before it is sent: over the cap it is refused (and recorded) instead. */
function take(kind: Kind): Entry {
  if (used[kind] >= CAPS[plan][kind]) {
    refused.push({ kind, at: new Date().toISOString() }); writeLedger();
    throw Object.assign(new Error(`CALL CAP: Plan ${plan} allows ${CAPS[plan][kind]} ${kind} call(s); this one was refused before sending.`), { code: 'CALL_CAP' });
  }
  used[kind] += 1;
  const entry: Entry = { kind, at: new Date().toISOString() }; calls.push(entry); writeLedger();
  return entry;
}
const failure = (entry: Entry, error: unknown) => {
  const e = error as { message?: string; status?: number; requestID?: string; error?: unknown; code?: string };
  Object.assign(entry, { ok: false, error: e.message ?? String(error), status: e.status ?? null, requestId: e.requestID ?? null, body: e.error ?? null, code: e.code ?? null });
};
const refuse = (what: string) => async () => { throw new Error(`refused: ${what} is not part of Plan ${plan}`); };

// ---- The paid clients, capped (or their offline fakes) --------------------------------------------------------------
type ImagesEdit = (params: unknown) => Promise<Record<string, unknown>>;
/** The image model: one images.edit per allowed call, never resent; its request id, usage and quality recorded. */
function images() {
  const real = dry ? imagesClient('drifts').client : liveGenerationConfig(process.env).client();
  return { images: { generate: refuse('images.generate'), edit: async (params: Record<string, unknown>) => {
    const entry = take('imageEdit'); Object.assign(entry, { model: params.model, size: params.size, quality: params.quality ?? '(not set: model default)' });
    const t = Date.now();
    try {
      const r = await (real.images.edit as unknown as ImagesEdit)(params);
      Object.assign(entry, { ok: true, requestId: (r as { _request_id?: string })._request_id ?? null, usage: r.usage ?? null, outputQuality: r.quality ?? null, outputSize: r.size ?? null, outputFormat: r.output_format ?? null });
      return r;
    } catch (error) { failure(entry, error); throw error; } finally { entry.ms = Date.now() - t; writeLedger(); }
  } } };
}
type ResponsesCreate = (body: unknown, options?: unknown) => Promise<Record<string, unknown>>;
/** The concept writer's Responses client: one call. */
function responses() {
  const fake = { responses: { create: async (body: { model: string }) => ({ status: 'completed', model: body.model, output_text: JSON.stringify({ concepts: DRY_CONCEPTS }),
    usage: { input_tokens: 2100, output_tokens: 3200, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 2400 } } }) } };
  const real = dry ? fake : createOpenAIClient(process.env.OPENAI_API_KEY);
  return { responses: { create: async (body: Record<string, unknown>, options?: unknown) => {
    const entry = take('responses'); Object.assign(entry, { model: body.model, reasoning: body.reasoning ?? null });
    const t = Date.now();
    try {
      const r = await (real.responses.create as unknown as ResponsesCreate)(body, options);
      Object.assign(entry, { ok: true, requestId: (r as { _request_id?: string })._request_id ?? (r.id as string | undefined) ?? null, status: r.status ?? null, usage: r.usage ?? null });
      return r;
    } catch (error) { failure(entry, error); throw error; } finally { entry.ms = Date.now() - t; writeLedger(); }
  } } } as never;
}
/** fal: uploads and submissions capped; polls, results and downloads of an accepted request are free and pass through. */
async function fal(): Promise<FalTransport> {
  let real: FalTransport;
  if (dry) {
    // The fake answers each SAM-3 box with the saved Seedream cutout that overlaps it most (the upload is read at full size).
    const replay = (await mijiaReplay(SAVED))!, w = replay.width;
    const kit = falSegmentation(input => {
      const b = (input.box_prompts as { x_min: number; y_min: number; x_max: number; y_max: number }[])[0];
      const inBox = (m: Uint8Array) => { let n = 0; for (let y = b.y_min; y < b.y_max; y++) for (let x = b.x_min; x < b.x_max; x++) if (m[y * w + x]) n++; return n; };
      return { masks: [Buffer.from(replay.products.map(p => p.mask).sort((x, y) => inBox(y) - inBox(x))[0])], scores: [0.9] };
    }).transport;
    // The kit answers raw masks; the segmenter downloads PNGs.
    real = { ...kit, download: async url => { const raw = await kit.download(url); return raw.length === w * replay.height ? sharp(raw, { raw: { width: w, height: replay.height, channels: 1 } }).png().toBuffer() : raw; } };
  } else real = createFalTransport(process.env.FAL_KEY ?? '');
  return { ...real,
    upload: async (bytes, mime) => { const entry = take('falUpload'); entry.bytes = bytes.length; try { const url = await real.upload(bytes, mime); entry.ok = true; return url; } catch (error) { failure(entry, error); throw error; } finally { writeLedger(); } },
    submit: async (endpoint, input) => {
      const entry = take('falSubmit'), i = input as Record<string, unknown>; Object.assign(entry, { endpoint, prompt: i.prompt, box: (i.box_prompts as unknown[] | undefined)?.[0] ?? null, listedUsd: FAL_SAM3_USD });
      try { const r = await real.submit(endpoint, input); Object.assign(entry, { ok: true, requestId: r.requestId }); return r; } catch (error) { failure(entry, error); throw error; } finally { writeLedger(); }
    } };
}
const DRY_CONCEPTS = [
  { title: 'Morning kitchen', family: 'lifestyle', theme: 'fresh water at home', environment: 'a bright kitchen with pale stone walls by a tall window', surface: 'a long travertine counter', props: ['a glass carafe'], palette: ['warm white', 'sage'], lighting: 'soft daylight from the left', mood: 'fresh', camera: 'eye-level', composition: { x: 0.5, y: 0.62, scale: 0.7, copy_space: 'top' } },
  { title: 'Morning kitchen in blue', family: 'lifestyle', theme: 'fresh water at home', environment: 'a bright kitchen with pale stone walls by a tall window', surface: 'a long travertine counter', props: ['a glass carafe'], palette: ['ice blue', 'white'], lighting: 'soft daylight from the left', mood: 'fresh', camera: 'eye-level', composition: { x: 0.5, y: 0.62, scale: 0.7, copy_space: 'top' } },
  { title: 'Glacier stream', family: 'nature', theme: 'pure cold water', environment: 'smooth river stones beside a glacier stream', surface: 'a flat slate slab', props: ['moss'], palette: ['slate', 'glacier blue'], lighting: 'cool overcast light', mood: 'pure', camera: 'low-angle', composition: { x: 0.42, y: 0.66, scale: 0.6, copy_space: 'right' } },
  { title: 'Gallery plinths', family: 'architectural', theme: 'design objects', environment: 'a concrete gallery with tall arched niches', surface: 'a polished concrete plinth', props: [], palette: ['concrete grey', 'warm brass'], lighting: 'spotlight from above left', mood: 'refined', camera: 'eye-level', composition: { x: 0.58, y: 0.6, scale: 0.65, copy_space: 'left' } },
  { title: 'Dusk terrace', family: 'outdoor', theme: 'evening calm', environment: 'a terrace at dusk with city lights far below', surface: 'a teak outdoor table', props: ['a lantern'], palette: ['indigo', 'amber'], lighting: 'warm low light from the right', mood: 'calm', camera: 'high-angle', composition: { x: 0.5, y: 0.58, scale: 0.6, copy_space: 'bottom' } },
];

// ---- Evidence: panels, maps and costs (all local) -------------------------------------------------------------------
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const json = (file: string, value: unknown) => writeFileSync(join(dir, file), JSON.stringify(value, null, 2));
/** Labelled panels side by side, each fitted into a side×side tile (for a person to look at). */
async function sheet(file: string, panels: { label: string; png: Buffer }[], side = 560) {
  const tiles = await Promise.all(panels.map(async p => {
    const image = await sharp(p.png).resize(side, side, { fit: 'contain', background: '#ffffff' }).png().toBuffer();
    const label = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${side}" height="30"><rect width="100%" height="100%" fill="#ffffff"/><text x="6" y="21" font-family="Helvetica, Arial" font-size="15" fill="#111">${p.label.replace(/[<&>]/g, '')}</text></svg>`);
    return sharp({ create: { width: side, height: side + 30, channels: 3, background: '#ffffff' } }).composite([{ input: label, left: 0, top: 0 }, { input: image, left: 0, top: 30 }]).png().toBuffer();
  }));
  writeFileSync(join(dir, file), await sharp({ create: { width: tiles.length * (side + 8), height: side + 30, channels: 3, background: '#ffffff' } }).composite(tiles.map((t, k) => ({ input: t, left: k * (side + 8), top: 0 }))).png().toBuffer());
}
/** Where the model's output differs from the placed products inside their area (its own re-rendering of them), in red. */
async function driftMap(generated: Buffer, reference: Raster, union: Uint8Array) {
  const { width, height } = reference, g = await sharp(generated).removeAlpha().raw().toBuffer(), map = Buffer.alloc(width * height * 3);
  let inside = 0, changed = 0, sum = 0;
  for (let i = 0; i < width * height; i++) {
    const d = Math.max(...[0, 1, 2].map(c => Math.abs(g[i * 3 + c] - reference.rgb[i * 3 + c]))), v = Math.round(g[i * 3] * 0.3 + g[i * 3 + 1] * 0.59 + g[i * 3 + 2] * 0.11) * 0.35;
    map[i * 3] = v; map[i * 3 + 1] = v; map[i * 3 + 2] = v;
    if (union[i] >= 128) { inside++; sum += d; if (d > 24) changed++; map[i * 3] = Math.min(255, v + d * 3); }
  }
  return { png: await sharp(map, { raw: { width, height, channels: 3 } }).png().toBuffer(), meanDifference: Math.round((sum / Math.max(1, inside)) * 10) / 10, changedShare: Math.round((changed / Math.max(1, inside)) * 1000) / 1000 };
}
/** The products' area, cropped the same way from the placed reference and from an image of the same canvas. */
async function productCrops(reference: Raster, png: Buffer, box: { x: number; y: number; width: number; height: number }) {
  const pad = 24, x = Math.max(0, box.x - pad), y = Math.max(0, box.y - pad), w = Math.min(reference.width - x, box.width + 2 * pad), h = Math.min(reference.height - y, box.height + 2 * pad);
  const ref = await sharp(reference.rgb, { raw: { width: reference.width, height: reference.height, channels: 3 } }).extract({ left: x, top: y, width: w, height: h }).png().toBuffer();
  return { reference: ref, result: await sharp(png).extract({ left: x, top: y, width: w, height: h }).png().toBuffer() };
}
/** The ledger's calls priced: OpenAI from recorded usage with the app's price table; fal at its listed price per accepted request. */
function costs() {
  const rows = calls.map(c => {
    if (c.kind === 'imageEdit' || c.kind === 'responses') {
      if (!c.ok && !c.usage) return { kind: c.kind, requestId: c.requestId, usd: null, note: 'failed: no usage recorded (check OpenAI billing; a rejected request is normally not billed)' };
      const a = calculateCallCost({ kind: c.kind === 'imageEdit' ? 'image' : 'text', model: String(c.model), usage: usageFacts(c.usage) });
      return { kind: c.kind, requestId: c.requestId, usd: a.usd, inr: a.inr, confidence: a.confidence, notes: a.notes };
    }
    if (c.kind === 'falSubmit') return { kind: c.kind, requestId: c.requestId, usd: c.ok ? FAL_SAM3_USD : null, inr: c.ok ? FAL_SAM3_USD * AI_PRICING.budgetUsdInr : null, confidence: 'Listed price (fal reports no per-request usage)' };
    return { kind: c.kind, usd: 0, note: 'upload: no charge' };
  });
  const usd = rows.reduce((s, r) => s + (typeof r.usd === 'number' ? r.usd : 0), 0);
  return { fx: AI_PRICING.budgetUsdInr, pricingVersion: AI_PRICING.version, rows, totalUsd: Math.round(usd * 10000) / 10000, totalInr: Math.round(usd * AI_PRICING.budgetUsdInr * 100) / 100, dry };
}

// ---- Plan A ---------------------------------------------------------------------------------------------------------
async function planA() {
  const r = (await mijiaReplay(SAVED))!, size = { width: 864, height: 1536 }, sizeText = `${size.width}x${size.height}`;
  const source = await sourceRaster(r.source);
  // The production order and shadow rule (variantSubjects): no product here is held by or attached to another; lower ones in front.
  const loaded = r.products.map(p => { const b = maskBox(p.mask, r.width, r.height).box!; return { id: p.id, label: p.label, mask: p.mask, bottom: b.y + b.height }; })
    .sort((a, b) => a.bottom - b.bottom).map(p => ({ ...p, shadow: p.bottom < r.height * 0.985 }));
  const refined = refineEdges(source, loaded.map(p => p.mask)), group = groupBox(refined.masks, r.width, r.height);
  const { concept, problems } = parseConcept({ title: 'Morning kitchen', family: 'lifestyle', theme: 'fresh, pure water at home', environment: 'a bright modern kitchen with pale stone walls beside a tall window', surface: 'a long pale travertine counter',
    props: ['a clear glass carafe of water', 'a small olive branch'], palette: ['warm white', 'travertine beige', 'sage'], lighting: 'soft daylight from the left', mood: 'fresh', camera: 'eye-level', composition: { x: 0.5, y: 0.62, scale: 0.75, copy_space: 'top' } });
  if (!concept) throw new Error(problems.join(' '));
  const placement = placeGroup(group, size, concept.composition, touchedEdges(group, { width: r.width, height: r.height }));
  const placed = await placeProducts(refined.reference, refined.masks, group, placement, size, backgroundColour(source, refined.union)), inputs = await canvasInputs(placed.reference, placed.union);
  const prompt = compileVariantPrompt({ protectedLabels: loaded.map(p => p.label), lighting: r.scene.lighting, scene: conceptScene(concept), people: false, placed: true });
  writeFileSync(join(dir, 'input-canvas.png'), inputs.image); writeFileSync(join(dir, 'input-mask.png'), inputs.mask);
  json('request.json', { method: 'images.edit', model: 'gpt-image-2', prompt, size: sizeText, n: 1, output_format: 'png', image: '<input-canvas.png>', mask: '<input-mask.png>', concept, placement,
    products: loaded.map(p => p.label), masks: 'the saved Seedream-layer cutouts of run 2026-10-09T05-53-16-453Z-634021 (no fal call)' });
  const model = dry ? 'gpt-image-2' : liveGenerationConfig(process.env).model;
  let response: Record<string, unknown>;
  try {
    response = await images().images.edit({ model, prompt, size: sizeText, n: 1, output_format: 'png', image: await toFile(inputs.image, 'reference.png', { type: 'image/png' }), mask: await toFile(inputs.mask, 'mask.png', { type: 'image/png' }) });
  } catch (error) {
    json('result.json', { accepted: false, size: sizeText, error: calls.at(-1) ?? null, costs: costs() });
    console.log('PLAN A: the 9:16 request failed:', (error as Error).message);
    return;
  }
  const b64 = (response.data as { b64_json?: string }[] | undefined)?.[0]?.b64_json;
  json('response.json', { ...response, data: (response.data as unknown[] | undefined)?.map(() => '<image: generated.png>') });
  if (!b64) { json('result.json', { accepted: true, image: false, costs: costs() }); console.log('PLAN A: accepted, but no image came back'); return; }
  const generated = Buffer.from(b64, 'base64'), meta = await sharp(generated).metadata();
  writeFileSync(join(dir, 'generated.png'), generated);
  const sizeOk = meta.width === size.width && meta.height === size.height;
  let composedInfo: Record<string, unknown> = {};
  if (sizeOk) {
    const composed = await composeVariant(generated, inputs.placement, placed.reference, loaded.map((p, k) => ({ id: p.id, label: p.label, mask: placed.masks[k], shadow: p.shadow })));
    for (const [file, png] of [['composite.png', composed.composite], ['scenery.png', composed.scenery], ['plate.png', composed.plate]] as const) writeFileSync(join(dir, file), png);
    composed.subjects.forEach((l, k) => writeFileSync(join(dir, `subject-${k + 1}.png`), l.png)); composed.shadows.forEach((l, k) => writeFileSync(join(dir, `shadow-${k + 1}.png`), l.png));
    const drift = await driftMap(generated, placed.reference, placed.union); writeFileSync(join(dir, 'drift-map.png'), drift.png);
    const crops = await productCrops(placed.reference, composed.composite, placement.box), rawCrops = await productCrops(placed.reference, generated, placement.box);
    await sheet('before-after.png', [{ label: `reference (${r.width}×${r.height})`, png: r.source }, { label: 'input: products on 9:16 canvas', png: inputs.image }, { label: 'model output (before)', png: generated }, { label: 'final composite (after)', png: composed.composite }, { label: 'model vs products (red = changed)', png: drift.png }]);
    await sheet('products-zoom.png', [{ label: 'products: source pixels', png: crops.reference }, { label: 'products: model output', png: rawCrops.result }, { label: 'products: final', png: crops.result }], 640);
    composedInfo = { preservation: composed.preservation, ghost: composed.ghost, shadowsDrawn: composed.shadows.map(s => s.label), modelVsProducts: { meanDifference: drift.meanDifference, changedShare: drift.changedShare } };
  }
  json('result.json', { accepted: true, size: sizeText, returned: `${meta.width}x${meta.height}`, sizeOk, placement, ...composedInfo, costs: costs() });
  console.log('PLAN A done:', JSON.stringify({ sizeOk, returned: `${meta.width}x${meta.height}`, ...composedInfo }));
}

// ---- Plan B ---------------------------------------------------------------------------------------------------------
async function planB() {
  const data = join(dir, 'data');
  for (const d of ['templates', 'analyses', 'variants', 'executions']) mkdirSync(join(data, d), { recursive: true });
  // The saved template and analysis of the Mijia creative, copied: the originals are only read.
  cpSync(join(SAVED, 'creative-templates', TEMPLATE), join(data, 'templates', TEMPLATE), { recursive: true });
  cpSync(join(SAVED, 'scene-analyses', ANALYSIS), join(data, 'analyses', ANALYSIS), { recursive: true });
  const templates = fileTemplateStore(join(data, 'templates')), executions = fileExecutionStore(join(data, 'executions'));
  const scenes = fileSceneStore(join(data, 'analyses')), variants = fileVariantStore(join(data, 'variants'));
  const imageModel = dry ? 'gpt-image-2' : liveGenerationConfig(process.env).model, falTransport = await fal();
  const providers = {
    analyzer: () => ({ model: 'gpt-5.6-sol', analyze: refuse('a scene analysis (the saved one is reused)') as never }),
    resolver: () => ({ model: 'gpt-5.6-sol', resolve: refuse('a change resolution') as never }),
    verifier: () => ({ model: 'gpt-5.6-sol', verify: refuse('an AI check (off for this plan)') as never }),
    concepts: () => liveConceptWriter({ client: responses() }),
    segmenter: () => liveSegmenter('sam3', () => falTransport),
  };
  const features = () => readSmartFeatures({}, { openai: true, fal: true, cutout: 'sam3', models: { analysis: 'gpt-5.6-sol', resolver: 'gpt-5.6-sol', verifier: 'gpt-5.6-sol' } });
  const smart = createSmartCreative({ scenes, variants, executions, templates, generation: () => ({ model: imageModel, client: () => images() as never }), providers, features, log: (line: string) => console.log(line) } as never);
  const started = Date.now();
  const { set } = await smart.startVariants({ analysisId: ANALYSIS, templateId: TEMPLATE, templateVersion: 1, count: 3, aspectRatio: '4:5', verify: false, idempotencyKey: randomUUID() });
  console.log('PLAN B set', set.id, 'keeps', set.protectedLabels.join(', '), JSON.stringify(set.selection));
  let s: VariantSet = smart.set(set.id);
  while (!['ready', 'failed', 'needs-cutout'].includes(s.state) || s.variants.some(v => v.status === 'generating')) {
    if (Date.now() - started > 30 * 60_000) throw new Error('Plan B: still running after 30 minutes; stopped waiting (nothing is resent).');
    await new Promise(done => setTimeout(done, 3000));
    const next = smart.set(set.id);
    if (next.state !== s.state || next.variants.map(v => v.status).join() !== s.variants.map(v => v.status).join()) console.log(`[${Math.round((Date.now() - started) / 1000)}s] ${next.state} · ${next.variants.map(v => `${v.id}:${v.status}`).join(' ')}`);
    s = next;
  }
  // After the run, all local: each creative's composition reproduced from its saved files (showing the saved composite is
  // what the code makes from that output), with the ghost/drift measurement the record does not keep, and the panels.
  const setDir = join(data, 'variants', set.id), file = (f: string) => readFileSync(join(setDir, f));
  const source = await sourceRaster(file(s.source.file)), analysis = scenes.get(ANALYSIS).scene!, masks = s.cutout.masks ?? [];
  const loaded = await Promise.all(masks.map(async m => {
    const mask = await maskRaster(file(m.file), source.width, source.height), b = maskBox(mask, source.width, source.height).box!;
    const attached = analysis.relations.some(r => (r.relation === 'attached_to' || r.relation === 'part_of') && r.source === m.subjectId && masks.some(x => x.subjectId === r.target));
    return { id: m.subjectId, label: m.label, mask, bottom: b.y + b.height, shadow: !attached && b.y + b.height < source.height * 0.985 };
  }));
  const ordered = loaded.sort((a, b) => a.bottom - b.bottom), refined = refineEdges(source, ordered.map(x => x.mask)), group = groupBox(refined.masks, source.width, source.height);
  await sheet('masks.png', [{ label: 'reference', png: file(s.source.file) }, ...masks.map(m => ({ label: `SAM-3 mask: ${m.label}`, png: file(m.file) }))]);
  const per: Record<string, unknown>[] = [], finals: { label: string; png: Buffer }[] = [];
  for (const v of s.variants) {
    const info: Record<string, unknown> = { id: v.id, title: v.title, status: v.status, error: v.error ?? null, concept: v.concept ?? null, layout: v.layout ?? null, preservation: v.preservation ?? null, prompt: v.prompt, size: v.size, attempts: v.attempts };
    if (v.status === 'done' && v.image && v.requestFile) {
      const prefix = v.requestFile.replace('.openai-request.json', ''), generated = file(`${prefix}-generated.png`), size = { width: v.image.width, height: v.image.height };
      const placement = placeGroup(group, size, v.concept?.composition ?? DEFAULT_COMPOSITION, touchedEdges(group, source));
      const placed = await placeProducts(refined.reference, refined.masks, group, placement, size, backgroundColour(source, refined.union)), inputs = await canvasInputs(placed.reference, placed.union);
      const composed = await composeVariant(generated, inputs.placement, placed.reference, ordered.map((x, k) => ({ id: x.id, label: x.label, mask: placed.masks[k], shadow: x.shadow })));
      const saved = file(v.image.file), drift = await driftMap(generated, placed.reference, placed.union);
      writeFileSync(join(dir, `${v.id}-input-canvas.png`), inputs.image); writeFileSync(join(dir, `${v.id}-input-mask.png`), inputs.mask); writeFileSync(join(dir, `${v.id}-drift-map.png`), drift.png);
      const crops = await productCrops(placed.reference, saved, placement.box), rawCrops = await productCrops(placed.reference, generated, placement.box);
      await sheet(`${v.id}-before-after.png`, [{ label: 'input: products on 4:5 canvas', png: inputs.image }, { label: 'model output (before)', png: generated }, { label: 'final composite (after)', png: saved }, { label: 'model vs products (red = changed)', png: drift.png }]);
      await sheet(`${v.id}-products-zoom.png`, [{ label: 'products: source pixels', png: crops.reference }, { label: 'products: model output', png: rawCrops.result }, { label: 'products: final', png: crops.result }], 640);
      finals.push({ label: `${v.id}: ${v.title}`, png: saved });
      Object.assign(info, { reproduced: sha(composed.composite) === sha(saved), placementMatchesRecord: JSON.stringify(placement.box) === JSON.stringify(v.layout?.box), ghost: composed.ghost, shadowsDrawn: composed.shadows.map(x => x.label),
        modelVsProducts: { meanDifference: drift.meanDifference, changedShare: drift.changedShare }, files: { generated: `data/variants/${set.id}/${prefix}-generated.png`, composite: `data/variants/${set.id}/${v.image.file}` } });
    }
    per.push(info);
  }
  if (finals.length) await sheet('creatives.png', [{ label: 'reference', png: file(s.source.file) }, ...finals]);
  json('result.json', { set: { id: s.id, state: s.state, error: s.error ?? null, keeps: s.protectedLabels, selection: s.selection, aspectRatio: s.aspectRatio, usage: s.usage, cutout: s.cutout, conceptReport: s.conceptReport ?? null },
    variants: per, elapsedMs: Date.now() - started, costs: costs() });
  console.log('PLAN B done:', s.state, JSON.stringify(per.map(p => ({ id: p.id, status: p.status, reproduced: p.reproduced, ghost: p.ghost, preserved: (p.preservation as { ok?: boolean } | null)?.ok }))));
}

console.log(`Plan ${plan} (${dry ? 'dry: offline fakes, no keys' : 'LIVE: paid calls, capped'}) → ${relative(process.cwd(), dir) || dir}`);
try { if (plan === 'A') await planA(); else await planB(); }
finally { writeLedger(); console.log('LEDGER', JSON.stringify({ used, caps: CAPS[plan], refused: refused.length })); console.log('COSTS', JSON.stringify(costs())); }
