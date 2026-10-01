/** Local-only reviewer fixture: real routes/storage/planner adaptation/import, deterministic providers, no credentials. */
import express from 'express';
import { verboseImageAnalysis } from '../../server/src/decomposition/imageTemplateAnalysis.fixture.js';
import { createOpenAIImagePromptWriter } from '../../server/src/decomposition/imageTemplates.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { createApp, readConfig } from '../../server/src/app.js';
import { createLayerizeRouter } from '../../server/src/decomposition/layerizeRouter.js';
import { createOpenAIPlanner } from '../../server/src/decomposition/layerizePlanner.js';
import type { GenerationConfig } from '../../server/src/decomposition/generationGroups.js';
import type { FalTransport } from '../../server/src/decomposition/providers/falClient.js';

if (process.env.FRAMEFLOW_OFFLINE_E2E !== '1') throw new Error('This fixture requires FRAMEFLOW_OFFLINE_E2E=1.');
// No SDK transport is used. An accidental fetch fails before it can leave this process.
globalThis.fetch = async () => { throw new Error('Network is disabled in the offline fixture server.'); };
const port = Number(process.env.FRAMEFLOW_OFFLINE_PORT ?? 3317), origin = `http://127.0.0.1:${port}`;
const root = mkdtempSync(join(tmpdir(), 'frameflow-image-template-e2e-'));

const pause = () => new Promise<void>(done => setTimeout(done, 350));
async function artwork(width: number, height: number, part: 'all' | 'background' | 'phone' = 'all') {
  const backdrop = '<rect width="1000" height="1000" fill="#ede4f7"/><circle cx="190" cy="230" r="75" fill="#ddd0ed"/><circle cx="800" cy="500" r="110" fill="#e1d7ed"/><ellipse cx="500" cy="820" rx="320" ry="65" fill="#c6b6dc"/><ellipse cx="500" cy="790" rx="320" ry="60" fill="#faf7ff"/>';
  const phone = '<rect x="345" y="190" width="310" height="570" rx="45" fill="#514661"/><rect x="357" y="202" width="286" height="546" rx="37" fill="#b294d2"/><rect x="375" y="222" width="105" height="130" rx="28" fill="#9a7aba"/><circle cx="405" cy="255" r="20" fill="#292431"/><circle cx="447" cy="305" r="20" fill="#292431"/><circle cx="505" cy="495" r="40" fill="#cbb4e2"/>';
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 1000 1000" preserveAspectRatio="none">${part !== 'phone' ? backdrop : ''}${part !== 'background' ? phone : ''}</svg>`)).png().toBuffer();
}
const generate = async (request: { size: string }) => {
  await pause();
  const [width, height] = request.size.split('x').map(Number);
  return { created: 1, data: [{ b64_json: (await artwork(width, height)).toString('base64') }] };
};
const files = new Map<string, Buffer>(), inputs = new Map<string, Buffer>(), results = new Map<string, unknown>();
const transport: FalTransport = {
  upload: async bytes => { const url = `https://v3b.fal.media/files/offline/input-${inputs.size}.png`; inputs.set(url, bytes); return url; },
  submit: async (_endpoint, input) => {
    const { width = 1024, height = 1024 } = await sharp(inputs.get(String(input.image_url))!).metadata();
    const requestId = `offline-${results.size}`;
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
const planner = createOpenAIPlanner({ client: { responses: { create: async () => ({ status: 'completed', output: [], output_text: JSON.stringify({
  prompt: 'Extract the lavender phone as a whole object. Separate the studio background.', planned_layers: [{ name: 'Lavender phone', description: 'The main product, in one layer.' }], warnings: [],
}) }) } } as never });
const router = createLayerizeRouter({
  runsDir: join(root, 'runs'), imageTemplatesDir: join(root, 'templates'),
  generationDirs: { 'template-a': join(root, 'a'), 'template-b': join(root, 'b'), 'template-c': join(root, 'c') },
  access: { production: true, clientOrigin: origin },
  generation: (): GenerationConfig => ({ model: 'offline-image-fixture', client: () => ({ images: { generate: async () => { throw new Error('Image templates must use images.edit.'); }, edit: generate } }) as unknown as ReturnType<GenerationConfig['client']> }),
  imagePrompt: () => createOpenAIImagePromptWriter({ model: 'offline-prompt-fixture', client: { responses: { create: async (request: { input: { content: { image_url?: string }[] }[] }) => {
    await pause();
    const image = request.input[0].content.find(item => item.image_url)!.image_url!;
    const { width } = await sharp(Buffer.from(image.split(',')[1], 'base64')).metadata();
    const characters = width === 900 ? 3344 : 4002;
    return { id: `offline-analysis-${characters}`, status: 'completed', output: [], output_text: JSON.stringify(verboseImageAnalysis(characters)) };
  } } } as never }),
  deps: () => ({ planner, transport: () => transport }),
});
// Explicit empty configuration: no environment credentials or .env files are read.
const app = createApp(readConfig({ CLIENT_ORIGIN: origin }), undefined, () => undefined, undefined, undefined, router);
app.get('/__test__/reference.png', async (req, res) => { const side = req.query.analysis === '3344' ? 900 : 1024; res.type('png').send(await artwork(side, side)); });
app.use(express.static(resolve('client/dist')));
app.get('/{*path}', (_req, res) => res.sendFile(resolve('client/dist/index.html')));
app.listen(port, '127.0.0.1', () => console.info(`Offline fixture: ${origin}; data: ${root}`));
