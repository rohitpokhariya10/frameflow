/** TEST FIXTURE: a layerize router with Product with Text templates, fake reading, analysis and cut-out service, on a temp folder. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createHash } from 'node:crypto';
import { createLayerizeRouter } from '../../layerizeRouter.js';
import { fakeRecognizer } from '../../../textRecognition/recognizer.js';
import { fakeProductAnalyzer, fakeSegmenter, PRODUCT_WORDS } from './productPoster.fixture.js';
import type { ProductTemplates } from './service.js';
import type { ProductVariationPlanner } from './variations.js';
import type { SceneAnalyzer } from '../../creativeTemplates/smartProviders.js';
import type { ArtworkGenerator } from './artwork.js';
import type { ProductLayerizer } from './aiDecompose.js';
import type { ReusePlacementPlanner } from './reusePlacement.js';

export type View = ReturnType<ProductTemplates['view']>;
export const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
export async function setup(options: { analyzer?: boolean | SceneAnalyzer; segmenter?: boolean; planner?: ProductVariationPlanner; artwork?: ArtworkGenerator; layerizer?: ProductLayerizer; placement?: ReusePlacementPlanner } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'product-templates-')), recognizer = fakeRecognizer(PRODUCT_WORDS, { artworkText: ['MEGA', 'SALE', '50%'] }), analyzer = typeof options.analyzer === 'object' ? options.analyzer as ReturnType<typeof fakeProductAnalyzer> : fakeProductAnalyzer(), segmenter = fakeSegmenter();
  const app = express().use('/x', createLayerizeRouter({ runsDir: join(root, 'runs'), protectedDir: join(root, 'protected'), templatesDir: join(root, 'tpl'), executionsDir: join(root, 'exe'), imageTemplatesDir: join(root, 'img'),
    deps: () => { throw new Error('No decomposition provider in these tests'); }, masterRecognizer: () => recognizer, productAnalyzer: () => (options.analyzer === false ? undefined : analyzer),
    productSegmenter: () => (options.segmenter ? segmenter : undefined), productPlanner: () => options.planner, productArtwork: () => options.artwork, productLayerizer: () => options.layerizer, productPlacement: () => options.placement }));
  const server = app.listen(0, '127.0.0.1');
  // Longer than a client's idle reuse: Node's 5 s default can close a kept-alive socket as a slow test reuses it (ECONNRESET).
  server.keepAliveTimeout = 65_000; server.headersTimeout = 66_000;
  await new Promise(done => server.once('listening', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/x/product-templates`;
  const call = async <T>(path: string, init?: RequestInit) => { const r = await fetch(`${base}${path}`, init); return { status: r.status, body: await r.json() as T }; };
  const send = <T = View>(method: string, path: string, body: unknown) => call<T>(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const form = <T = View>(path: string, file: Buffer, fields: Record<string, string> = {}) => { const f = new FormData(); f.set('useAi', 'true'); for (const [k, v] of Object.entries(fields)) f.set(k, v); f.append('image', new Blob([new Uint8Array(file)], { type: 'image/png' }), 'creative.png'); return call<T>(path, { method: 'POST', body: f }); };
  const settled = (stage: string) => async (id: string) => { for (let i = 0; i < 2400; i++) { const v = (await call<View>(`/${id}`)).body; if (v.stage !== stage) return v; await new Promise(r => setTimeout(r, 25)); } throw new Error(`${stage} did not finish`); };
  const fetchFile = (id: string, name: string) => fetch(`${base.replace(/product-templates$/, 'protected-templates')}/${id}/files/${name}`);
  return { base, root, protectedDir: join(root, 'protected'), recognizer, analyzer, segmenter, call, fetchFile, send, form, detected: settled('detecting'), prepared: settled('preparing'), close: () => new Promise(done => { server.closeAllConnections(); server.close(done); }) };
}

/** The fixture uploaded, detected, prepared (locally), approved and saved as revision 1. */
export async function savedTemplate(s: Awaited<ReturnType<typeof setup>>, png: Buffer) {
  const made = await s.form('', png, { name: 'Festive offer' });
  let v = await s.detected(made.body.template.id);
  v = (await s.send('PUT', `/${v.template.id}/review`, { expectedRevision: v.template.revision, objects: v.product.objects.map(o => ({ ...o, accepted: true })), texts: [], logos: [], dismissMissingText: true })).body;
  await s.send('POST', `/${v.template.id}/prepare`, { expectedRevision: v.template.revision });
  v = await s.prepared(v.template.id);
  v = (await s.send('POST', `/${v.template.id}/approve`, { expectedRevision: v.template.revision, acknowledge: v.product.prepared!.quality.issues.map(i => i.id) })).body;
  const saved = await s.send('POST', `/${v.template.id}/publish`, { expectedRevision: v.template.revision });
  if (saved.status !== 201) throw new Error(`not saved: ${JSON.stringify(saved.body)}`);
  return saved.body;
}
