/** Isolated contract test doubles. offline:false deliberately exercises cost approval; NEVER contacts a provider. */
import sharp from 'sharp';
import { createProductLayerizer, standInProductLayerizer, type DecompositionRequest, type AiDecomposition } from '../../server/src/decomposition/protectedTemplates/product/aiDecompose.js';
import type { ArtworkGenerator } from '../../server/src/decomposition/protectedTemplates/product/artwork.js';
import type { FalTransport } from '../../server/src/decomposition/providers/falClient.js';

export function productReuseProviders() {
  const prompts: string[] = [], calls: DecompositionRequest[] = [], submissions: string[] = [];
  let failAt = -1;
  let answer: AiDecomposition;
  const blobs = new Map<string, Buffer>();
  const transport: FalTransport = {
    async upload(bytes) { blobs.set('https://fixture.invalid/input', bytes); return 'https://fixture.invalid/input'; },
    async submit(endpoint) { submissions.push(endpoint); return { requestId: `fixture-seedream-${submissions.length}` }; },
    async status() { return 'COMPLETED'; },
    async result() { return { layers: answer.layers.map((l, i) => {
      const url = `https://fixture.invalid/layer-${i}`; blobs.set(url, l.png);
      return { image: { url }, z_index: l.zIndex, name: l.name };
    }) }; },
    async download(url) { const bytes = blobs.get(url); if (!bytes) throw new Error('Unknown fixture URL'); return bytes; },
    async cancel() { throw new Error('Unexpected cancellation'); },
  };
  const layerizer = Object.assign(createProductLayerizer({ planner: {
    model: 'test planner (no network or charges)', offline: false,
    async plan(request, save) {
      calls.push(request);
      answer = await standInProductLayerizer().decompose(request, save);
      return { plan: answer.plan, responseId: `fixture-plan-${calls.length}` };
    },
  }, transport: () => transport }), { calls });
  const artwork: ArtworkGenerator & { calls: string[] } = { model: 'test product image provider (no network or charges)', offline: false, calls: prompts,
    async generate({ prompt }, save) {
      prompts.push(prompt);
      if (prompts.length === failAt) throw new TypeError('terminated', { cause: Object.assign(new Error('fixture transport only'), { code: 'UND_ERR_SOCKET' }) });
      save('response.json', { test: true, requestId: `fixture-product-${prompts.length}` });
      const wide = /category: (television|soundbar|computer|microwave|induction)/.test(prompt);
      const color = `hsl(${prompts.length * 37},55%,35%)`, x = wide ? 20 : 65, w = wide ? 260 : 170, h = wide ? 140 : 240;
      const png = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="white"/><rect x="${x}" y="30" width="${w}" height="${h}" rx="12" fill="${color}"/><rect x="${x + 10}" y="44" width="${w - 20}" height="${h / 2}" rx="6" fill="#d1d5db"/><circle cx="${x + w / 2}" cy="${h - 8}" r="17" fill="#334155"/></svg>`)).png().toBuffer();
      return { png, costUsd: .02, requestId: `fixture-product-${prompts.length}` };
    },
  };
  return { artwork, layerizer, submissions, prompts, failProductAfter: (count: number) => { failAt = prompts.length + count; } };
}
