import { afterEach, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DecompositionJobSummary, DesignVariant, ProposalReviewTarget, SceneGraph } from '@frameflow/shared';
import { isDesignLayer } from '../../lib/persistence/schema';
import { cutoutToLayer, detectedBackground, detectedItems, loadTrayPrefs, saveTrayPrefs } from './detectedLayers';
import { ReadyStep } from './workspace/Steps';

afterEach(() => vi.unstubAllGlobals());
const target = (id: string, patch: Partial<ProposalReviewTarget> = {}): ProposalReviewTarget => ({ id, label: id, proposalIds: [], approved: true, rejected: false, groupMode: 'single', role: 'object', ...patch });
const graph: SceneGraph = { schemaVersion: 1, jobId: 'job', revision: 5, width: 800, height: 1000, createdAt: '', warnings: [], sourceImage: { artifactId: 'src', originalSha256: 'a', workingMasterSha256: 'b' },
  layers: [
    { id: 'background', type: 'background', name: 'Background', bbox: { x: 0, y: 0, width: 800, height: 1000 }, zIndex: 0, opacity: 1, rotation: 0, visible: true, locked: true, sourceRevision: 'b', imageArtifactId: 'src', reconstruction: 'original-source', reconstructionCandidateArtifactId: 'rebuilt', metadata: {} },
    { id: 'text-headline', type: 'text', name: 'Headline', bbox: { x: 100, y: 40, width: 560, height: 190 }, zIndex: 1, opacity: 1, rotation: 0, visible: true, locked: false, sourceRevision: 'r', targetId: 'headline', text: 'PRO', textConfidence: 'low', rasterArtifactId: 'headline-raster', metadata: {} },
  ] } as SceneGraph;
const job = { id: 'job', sceneGraph: graph, proposalTargets: [target('headline'), target('phone', { approved: false }), target('sticker', { approved: false, rejected: true }), target('background', { baseLayer: true, role: 'background', approved: false, rejected: true })] } as Pick<DecompositionJobSummary, 'id' | 'proposalTargets' | 'sceneGraph' | 'discovery'>;

it('lists every detected layer except the background, with what is already on the canvas', () => {
  const variant: Pick<DesignVariant, 'layers'> = { layers: [
    { id: 'l1', type: 'image', name: 'Headline', assetId: 'a1', x: 100, y: 40, width: 560, height: 190, rotation: 0, opacity: 1, visible: true, locked: false, source: { jobId: 'job', layerId: 'text-headline', kind: 'text' } },
    { id: 'l2', type: 'image', name: 'Phone', assetId: 'a2', x: 1, y: 1, width: 10, height: 10, rotation: 0, opacity: 1, visible: true, locked: false, source: { jobId: 'other-job', layerId: 'detected-phone', kind: 'image' } },
  ] };
  const items = detectedItems(job, variant);
  expect(items.map(i => [i.target.id, i.onCanvas, i.sceneLayer?.id])).toEqual([['headline', true, 'text-headline'], ['phone', false, undefined], ['sticker', false, undefined]]);
  expect(detectedItems(job, { layers: [] }).every(i => !i.onCanvas)).toBe(true);
  // The background offered is the rebuilt one, never the original image.
  expect(detectedBackground(job)).toBe('rebuilt');
});

it('turns a cut-out into a valid editor layer at its original position, recognisable as added from this job', () => {
  const layer = cutoutToLayer({ targetId: 'phone', label: 'Phone', kind: 'image', artifactId: 'art', bbox: { x: 420, y: 520, width: 360, height: 200 } }, 'job', 'decomp-1', 'layer-1', 'My phone');
  expect(layer).toMatchObject({ id: 'layer-1', name: 'My phone', x: 420, y: 520, width: 360, height: 200, source: { jobId: 'job', layerId: 'detected-phone', kind: 'image' } });
  expect(isDesignLayer(layer)).toBe(true);
  expect(detectedItems(job, { layers: [layer] }).find(i => i.target.id === 'phone')?.onCanvas).toBe(true);
  const text = cutoutToLayer({ targetId: 'title', label: 'Title', kind: 'text', artifactId: 'art', bbox: { x: 0, y: 0, width: 10, height: 10 }, textSuggestion: { text: 'SALE', textConfidence: 'low' } }, 'job', 'decomp-2', 'layer-2');
  expect(text).toMatchObject({ textSuggestion: { text: 'SALE', confidence: 'low' } });
  expect(isDesignLayer(text)).toBe(true);
});

it('keeps tray names and removed-from-list choices per job, tolerating bad or missing storage', () => {
  const map = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) });
  saveTrayPrefs('job', { hidden: ['sticker'], names: { phone: 'My phone' } });
  expect(loadTrayPrefs('job')).toEqual({ hidden: ['sticker'], names: { phone: 'My phone' } });
  expect(loadTrayPrefs('other')).toEqual({ hidden: [], names: {} });
  map.set('frameflow:detected-layers:bad', '{"hidden":[1,"ok"],"names":{"a":2,"b":"B"}}');
  expect(loadTrayPrefs('bad')).toEqual({ hidden: ['ok'], names: { b: 'B' } });
  vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } });
  expect(loadTrayPrefs('job')).toEqual({ hidden: [], names: {} });
});

it('ready step offers blank canvas first and the original background second, with the rebuilt background opt-in', () => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
  const html = renderToStaticMarkup(createElement(ReadyStep, { job: { ...job, state: 'completed', sourcePreviewArtifactId: 'src' } as DecompositionJobSummary, busy: false, onOpen: () => {} }));
  expect(html.indexOf('Open on blank canvas')).toBeLessThan(html.indexOf('Keep original background'));
  expect(html).toContain('nothing from the original image is underneath');
  expect(html).toContain('Add the AI-rebuilt background');
  // The background was not included at review, so the option starts unchecked.
  expect(html).toMatch(/<input type="checkbox"\/>Add the AI-rebuilt background/);
  expect(html).toContain('1 more detected layer is saved for later.');
  expect(html).not.toContain('Open in editor');
});
