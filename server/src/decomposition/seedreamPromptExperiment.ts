/**
 * Seedream layerize prompt experiment. Sends ONE image to fal `bytedance/seedream/v5/pro/layerize` with a text prompt
 * and saves everything it returns, so a prompt can be judged on its own. It does not touch the app, its database
 * or any job, and never calls SAM or BiRefNet.
 *
 *   npm run decomp:seedream-prompt -w @frameflow/server -- --image ../test__.png            (dry run: prints the request)
 *   npm run decomp:seedream-prompt -w @frameflow/server -- --image ../test__.png --live     (one paid call)
 *   npm run decomp:seedream-prompt -w @frameflow/server -- --render <run dir>              (re-render a saved run, no call)
 *
 * Options: --positive <file> --negative <file> (default: prompts/seedream-layerize.*.txt), --enhance standard|fast,
 * --out <dir> (default: artifacts/decomposition/seedream-prompt/<timestamp>).
 *
 * The endpoint has no negative_prompt input (its schema: prompt, image_url, image_size, enhance_prompt_mode,
 * enable_safety_checker, sync_mode), so the negative lines are sent inside `prompt` under "Also avoid:".
 * The raw response is written before anything is downloaded; --render rebuilds the outputs from it without a new call.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { buildProviderInput, endpointRegistry } from './providers/adapters.js';
import { renderLayerizeOutputs } from './layerizeArtifacts.js';
import { createFalTransport } from './providers/falClient.js';

const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, '../../..');
const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const live = process.argv.includes('--live');
const endpoint = endpointRegistry.seedream.endpoint;

/** Positive instructions, then the negative lines under "Also avoid:" — the only way to send them to this endpoint. */
export function composeLayerizePrompt(positive: string, negative: string): string {
  const pos = positive.trim(), neg = negative.trim();
  return neg ? `${pos}\n\nAlso avoid:\n${neg}` : pos;
}

type Saved = { request: Record<string, unknown>; requestId: string; raw: unknown; image: { path: string; width: number; height: number } };

/** Downloads every returned layer and writes the layer PNGs, a placement table, a contact sheet and a reconstruction. */
async function render(dir: string, saved: Saved) {
  const transport = createFalTransport(process.env.FAL_KEY || 'render-only-no-submit');
  const { layers, warnings } = await renderLayerizeOutputs(dir, saved.raw, url => transport.download(url));
  console.table(layers.map(l => ({ z: l.zIndex, name: l.name ?? '', size: `${l.pixelWidth}x${l.pixelHeight}`, opaquePercent: l.opaquePercent, placement: l.placement.kind, bbox: l.bboxAbsolute?.join(',') ?? '' })));
  for (const warning of warnings) console.warn(warning);
  console.info(`\nSaved to ${dir}\n  request.json, response.json, layers.json, layer-NN.png, contact-sheet.png, reconstructed.png`);
}

async function main() {
  const again = arg('render');
  if (again) { const dir = resolve(again); await render(dir, JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as Saved); return; }
  const imagePath = resolve(arg('image') ?? join(root, 'test__.png'));
  const positive = readFileSync(resolve(arg('positive') ?? join(here, 'prompts/seedream-layerize.positive.txt')), 'utf8');
  const negative = readFileSync(resolve(arg('negative') ?? join(here, 'prompts/seedream-layerize.negative.txt')), 'utf8');
  const enhance = (arg('enhance') ?? 'standard') as 'standard' | 'fast';
  const prompt = composeLayerizePrompt(positive, negative);
  const bytes = readFileSync(imagePath), meta = await sharp(bytes).metadata();
  // The adapter enforces the endpoint's limits (512×512–6000×6000 total pixels, aspect ≤ 16, prompt ≤ 2000 characters) before any upload.
  const request = buildProviderInput('seedream', { imageUrl: 'https://fal.media/placeholder-until-upload', prompt, imageSize: 'auto', enhancePromptMode: enhance, width: meta.width, height: meta.height });
  const shown = { ...request, image_url: `<upload of ${basename(imagePath)}, ${meta.width}x${meta.height}>` };
  console.info(`Endpoint: ${endpoint}\nPrompt: ${prompt.length} characters\n\n${JSON.stringify(shown, null, 2)}\n`);
  if (!live) { console.info('Dry run: nothing was sent. Add --live to make ONE paid call.'); return; }
  if (!process.env.FAL_KEY) throw new Error('FAL_KEY is not set (server/.env).');
  const dir = resolve(arg('out') ?? join(root, 'artifacts/decomposition/seedream-prompt', new Date().toISOString().replace(/[:.]/g, '-')));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'prompt.txt'), prompt);
  writeFileSync(join(dir, 'request.json'), JSON.stringify({ endpoint, input: shown }, null, 2));
  const transport = createFalTransport(process.env.FAL_KEY);
  const imageUrl = await transport.upload(bytes, meta.format === 'jpeg' ? 'image/jpeg' : `image/${meta.format}`);
  const { requestId } = await transport.submit(endpoint, { ...request, image_url: imageUrl });
  // Exactly one submission. From here on only status and result are read; nothing is ever resubmitted.
  console.info(`Submitted once. fal request id: ${requestId}`);
  writeFileSync(join(dir, 'request.json'), JSON.stringify({ endpoint, requestId, input: shown }, null, 2));
  const started = Date.now();
  for (;;) {
    const status = await transport.status(endpoint, requestId);
    if (status === 'COMPLETED') break;
    if (Date.now() - started > 10 * 60_000) throw new Error(`Still ${status} after 10 minutes. Request id ${requestId} is saved in request.json; do not resubmit.`);
    process.stdout.write(`  ${status}…\r`);
    await new Promise(done => setTimeout(done, 3000));
  }
  const raw = await transport.result(endpoint, requestId);
  const saved: Saved = { request: shown, requestId, raw, image: { path: imagePath, width: meta.width!, height: meta.height! } };
  writeFileSync(join(dir, 'response.json'), JSON.stringify(raw, null, 2));
  writeFileSync(join(dir, 'run.json'), JSON.stringify(saved));
  console.info(`Completed in ${Math.round((Date.now() - started) / 1000)}s.`);
  await render(dir, saved);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
