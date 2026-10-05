/** Local-only reviewer fixture: real routes/storage/planner adaptation/import, deterministic providers, no credentials. */
import express from 'express';
import { createHash } from 'node:crypto';
import { referenceCreativeFixture } from '../../server/src/decomposition/referenceCreative.fixture.js';
import { verboseImageAnalysis } from '../../server/src/decomposition/imageTemplateAnalysis.fixture.js';
import { createOpenAIImagePromptWriter, referenceForPrompt } from '../../server/src/decomposition/imageTemplates.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { createApp, readConfig } from '../../server/src/app.js';
import { createLayerizeRouter } from '../../server/src/decomposition/layerizeRouter.js';
import { createOpenAIPlanner } from '../../server/src/decomposition/layerizePlanner.js';
import type { GenerationConfig } from '../../server/src/decomposition/generationGroups.js';
import type { FalTransport } from '../../server/src/decomposition/providers/falClient.js';
import { ALL_PARTS, offerComposite, offerPart, partName, rowFillEdit, type OfferPart } from '../../server/src/decomposition/complexOffer.fixture.js';
import { RESIDUAL_PROMPT } from '../../server/src/decomposition/recursiveDecomposition.js';
import { SEMANTIC_SCHEMA, type SemanticAnalysis } from '../../server/src/decomposition/semanticPlanner.js';

if (process.env.FRAMEFLOW_OFFLINE_E2E !== '1') throw new Error('This fixture requires FRAMEFLOW_OFFLINE_E2E=1.');
// No SDK transport is used. An accidental fetch fails before it can leave this process.
globalThis.fetch = async () => { throw new Error('Network is disabled in the offline fixture server.'); };
const port = Number(process.env.FRAMEFLOW_OFFLINE_PORT ?? 3317), origin = `http://127.0.0.1:${port}`;
const root = mkdtempSync(join(tmpdir(), 'frameflow-image-template-e2e-'));

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const sources = new Map<string, string>(), analysisBehaviors = new Map<string, string>();
const events: { kind: string; source: string; prompt?: string; size?: string; inputs?: string[] }[] = [];
const failedPortrait = new Set<string>();
const pause = () => new Promise<void>(done => setTimeout(done, 350));
async function artwork(width: number, height: number, part: 'all' | 'background' | 'phone' = 'all') {
  const backdrop = '<rect width="1000" height="1000" fill="#ede4f7"/><circle cx="190" cy="230" r="75" fill="#ddd0ed"/><circle cx="800" cy="500" r="110" fill="#e1d7ed"/><ellipse cx="500" cy="820" rx="320" ry="65" fill="#c6b6dc"/><ellipse cx="500" cy="790" rx="320" ry="60" fill="#faf7ff"/>';
  const phone = '<rect x="345" y="190" width="310" height="570" rx="45" fill="#514661"/><rect x="357" y="202" width="286" height="546" rx="37" fill="#b294d2"/><rect x="375" y="222" width="105" height="130" rx="28" fill="#9a7aba"/><circle cx="405" cy="255" r="20" fill="#292431"/><circle cx="447" cy="305" r="20" fill="#292431"/><circle cx="505" cy="495" r="40" fill="#cbb4e2"/>';
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 1000 1000" preserveAspectRatio="none">${part !== 'phone' ? backdrop : ''}${part !== 'background' ? phone : ''}</svg>`)).png().toBuffer();
}
const generate = async (request: { size: string; prompt: string; image?: File | File[] }) => {
  const images = request.image ? Array.isArray(request.image) ? request.image : [request.image] : [];
  const inputs = await Promise.all(images.map(async image => digest(Buffer.from(await image.arrayBuffer()))));
  const source = inputs[0] ?? '';
  events.push({ kind: 'generation', source, inputs, prompt: request.prompt, size: request.size });
  if (request.prompt.includes('Slow phone')) await new Promise<void>(done => setTimeout(done, 2200));
  await pause();
  if (request.prompt.includes('Portrait retry test') && request.size === '1216x1520' && !failedPortrait.has(source)) { failedPortrait.add(source); throw new Error('Fixture portrait failure. Retry this size.'); }
  const [width, height] = request.size.split('x').map(Number);
  return { created: 1, data: [{ b64_json: (await artwork(width, height)).toString('base64') }] };
};
const files = new Map<string, Buffer>(), inputs = new Map<string, Buffer>(), results = new Map<string, unknown>();
// The complex offer creative (recursive decomposition): its first decomposition misses the speaker and power bank and
// leaves everything baked into its base; the residual pass that follows finds both, plus a duplicate of the headphones.
const complexDigest = offerComposite().then(digest);
let complexResidualNext = false;
const providerCalls: { kind: 'seedream-initial' | 'seedream-residual' | 'background-edit'; complex?: boolean }[] = [];
async function complexLayers(requestId: string, base: readonly OfferPart[], parts: OfferPart[], duplicates: OfferPart[] = []) {
  const entries: [string, Buffer][] = [['Background', await offerComposite(base)], ...await Promise.all([...parts, ...duplicates].map(async part => [partName(part), await offerPart(part)] as [string, Buffer]))];
  return entries.map(([name, png], z_index) => { const url = `https://v3b.fal.media/files/offline/${requestId}-${z_index}.png`; files.set(url, png); return { image: { url }, z_index, name }; });
}
const transport: FalTransport = {
  upload: async bytes => { const url = `https://v3b.fal.media/files/offline/input-${inputs.size}.png`; inputs.set(url, bytes); return url; },
  submit: async (_endpoint, input) => {
    const bytes = inputs.get(String(input.image_url))!, residual = String(input.prompt ?? '').startsWith(RESIDUAL_PROMPT.slice(0, 60));
    const { width = 1024, height = 1024 } = await sharp(bytes).metadata();
    const requestId = `offline-${results.size}`;
    if (!residual && digest(bytes) === await complexDigest) {
      providerCalls.push({ kind: 'seedream-initial', complex: true }); complexResidualNext = true;
      results.set(requestId, { layers: await complexLayers(requestId, ALL_PARTS, ALL_PARTS.filter(part => part !== 'speaker' && part !== 'powerBank')) });
      return { requestId };
    }
    if (residual && complexResidualNext) {
      providerCalls.push({ kind: 'seedream-residual', complex: true }); complexResidualNext = false;
      results.set(requestId, { layers: await complexLayers(requestId, [], ['speaker', 'powerBank'], ['headphones']) });
      return { requestId };
    }
    providerCalls.push({ kind: residual ? 'seedream-residual' : 'seedream-initial' });
    const layers = await Promise.all((['background', 'phone'] as const).map(async (part, z_index) => {
      const url = `https://v3b.fal.media/files/offline/${requestId}-${part}.png`;
      files.set(url, await artwork(width, height, part));
      return { image: { url }, z_index, name: part === 'phone' ? 'Lavender phone' : 'Studio background' };
    }));
    results.set(requestId, { layers });
    return { requestId };
  },
  status: async () => 'COMPLETED', result: async (_endpoint, id) => { await pause(); return results.get(id); }, cancel: async () => undefined,
  download: async url => { const bytes = files.get(url); if (!bytes) throw new Error('Unknown fixture layer.'); return bytes; },
};
// Image-template decompositions ask for the semantic analysis (semanticPlanner.ts); the test panel's runs for the plain plan.
const semanticAnalysis: SemanticAnalysis = { image_type: 'product photograph', scene_summary: 'A lavender smartphone standing in a lavender studio.',
  elements: [
    { id: 'studio_background', type: 'background', description: 'The lavender studio background with its soft shapes', editable_independently: true, approximate_region: 'full canvas', z_order: 0, confidence: 'high', occlusion: { is_occluded: true, occluded_by: ['lavender_phone'], requires_reconstruction: true } },
    { id: 'lavender_phone', type: 'product', description: 'The lavender smartphone, whole', editable_independently: true, approximate_region: 'center', z_order: 1, confidence: 'high', occlusion: { is_occluded: false, occluded_by: [], requires_reconstruction: false } },
  ],
  relationships: [{ source: 'lavender_phone', relationship: 'in_front_of', target: 'studio_background' }], ambiguities: [], recommended_layer_count: 2,
  decomposition_strategy: 'Separate the phone from the studio.', downstream_decomposition_prompt: 'Extract the lavender phone as a whole object. Separate the studio background.' };
const planner = createOpenAIPlanner({ client: { responses: { create: async (request: { text: { format: { schema: unknown } } }) => ({ status: 'completed', output: [], output_text: JSON.stringify(request.text.format.schema === SEMANTIC_SCHEMA ? semanticAnalysis : {
  prompt: 'Extract the lavender phone as a whole object. Separate the studio background.', planned_layers: [{ name: 'Lavender phone', description: 'The main product, in one layer.' }], warnings: [],
}) }) } } as never });
const router = createLayerizeRouter({
  runsDir: join(root, 'runs'), imageTemplatesDir: join(root, 'templates'),
  generationDirs: { 'template-a': join(root, 'a'), 'template-b': join(root, 'b'), 'template-c': join(root, 'c') },
  access: { production: true, clientOrigin: origin },
  generation: (): GenerationConfig => ({ model: 'gpt-image-2', client: () => ({ images: { generate: async () => { throw new Error('Image templates must use images.edit.'); }, edit: generate } }) as unknown as ReturnType<GenerationConfig['client']> }),
  imagePrompt: () => createOpenAIImagePromptWriter({ model: 'offline-prompt-fixture', client: { responses: { create: async (request: { input: { content: { image_url?: string }[] }[] }) => {
    await pause();
    const image = request.input[0].content.find(item => item.image_url)!.image_url!;
    const input = Buffer.from(image.split(',')[1], 'base64');
    const source = sources.get(digest(input)) ?? digest(input);
    events.push({ kind: 'analysis', source });
    if (analysisBehaviors.get(source) === 'fail' && events.filter(e => e.source === source && e.kind === 'analysis').length === 1) throw new Error('Fixture analysis failure');
    const { width } = await sharp(input).metadata();
    if (width === 600) return { id: 'offline-reference-analysis', status: 'completed', output: [], output_text: JSON.stringify(referenceCreativeFixture) };
    const characters = width === 900 ? 3344 : 4002;
    return { id: `offline-analysis-${characters}`, status: 'completed', output: [], output_text: JSON.stringify(verboseImageAnalysis(characters)) };
  } } } as never }),
  // The clean-background edit: a local row fill (exact for the complex offer's vertical gradient); never a network call.
  deps: () => ({ planner, transport: () => transport, backgroundReconstructor: { model: 'offline-image-edit', reconstruct: async ({ image, mask }) => {
    providerCalls.push({ kind: 'background-edit' }); await pause(); return { image: await rowFillEdit(image, mask), requestId: `offline-edit-${providerCalls.length}` };
  } } }),
});
// Explicit empty configuration: no environment credentials or .env files are read.
const app = createApp(readConfig({ CLIENT_ORIGIN: origin }), undefined, () => undefined, undefined, undefined, router);
app.get('/__test__/complex-offer.png', async (_req, res) => res.type('png').send(await offerComposite()));
app.get('/__test__/provider-calls', (_req, res) => res.json(providerCalls));
app.get('/__test__/reference-events', (req, res) => res.json(events.filter(event => event.source === String(req.query.source))));
app.get('/__test__/offer-reference.png', async (req, res) => {
  const seed = String(req.query.seed ?? ''), color = createHash('sha256').update(seed).digest('hex').slice(0, 6);
  const bytes = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><rect width="600" height="600" fill="#e5edf5"/><rect x="285" y="100" width="280" height="380" rx="40" fill="#c4d4e8"/><text x="40" y="170" font-size="38" fill="#20334a">Sound.</text><text x="40" y="212" font-size="38" fill="#20334a">Redefined.</text><path d="M350 285V245A72 72 0 0 1 144 0V285" fill="none" stroke="#68798c" stroke-width="20"/><rect x="326" y="272" width="48" height="120" rx="20" fill="#8195ad"/><rect x="470" y="272" width="48" height="120" rx="20" fill="#8195ad"/><rect x="40" y="475" width="175" height="50" rx="12" fill="#20334a"/><text x="62" y="508" fill="white" font-size="19">DISCOVER</text><rect x="10" y="10" width="8" height="8" fill="#${color}"/></svg>`)).png().toBuffer();
  const source = digest(bytes), normalized = await referenceForPrompt(bytes);
  sources.set(digest(normalized.bytes), source); analysisBehaviors.set(source, req.query.failAnalysis === '1' ? 'fail' : '');
  res.setHeader('x-fixture-source', source); res.type('png').send(bytes);
});
app.get('/__test__/reference.png', async (req, res) => { const side = req.query.analysis === '3344' ? 900 : 1024; res.type('png').send(await artwork(side, side)); });
app.use(express.static(resolve('client/dist')));
app.get('/{*path}', (_req, res) => res.sendFile(resolve('client/dist/index.html')));
app.listen(port, '127.0.0.1', () => console.info(`Offline fixture: ${origin}; data: ${root}`));
