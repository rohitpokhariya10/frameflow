import { expect, it } from 'vitest';
import { isDesignVariant } from '../../lib/persistence/schema';
import { experimentToVariant, type ExperimentLayer } from './layerizeExperiment';

it('opens a run as a valid transparent version: base at the bottom, placed layers, unresolved layers hidden and unstretched', async () => {
  const layer = (zIndex: number, placement: ExperimentLayer['placement'], name?: string): ExperimentLayer => ({ index: zIndex, file: `layer-0${zIndex}.png`, zIndex, name, pixelWidth: placement.width, pixelHeight: placement.height, opaquePercent: 50, placement });
  const stored: string[] = [];
  let n = 0;
  const variant = await experimentToVariant({ id: '2026-09-28T10-00-00-000Z-abcdef', canvas: { width: 5000, height: 2500 }, layers: [
    layer(2, { kind: 'unresolved', x: 0, y: 0, width: 6000, height: 1000, reason: 'no fit' }),
    layer(1, { kind: 'bbox-scaled', x: 1000, y: 500, width: 400, height: 200 }, 'Phone'),
    layer(0, { kind: 'base', x: 0, y: 0, width: 5000, height: 2500 }),
  ] }, async () => new Blob(['x'], { type: 'image/png' }), { putAsset: async id => { stored.push(id); }, deleteAsset: async () => undefined }, () => String(++n));
  expect(isDesignVariant(variant)).toBe(true);
  expect(variant.canvas).toMatchObject({ width: 4096, height: 2048, transparent: true });
  expect(variant.layers!.map(l => [l.name, l.visible])).toEqual([['Generated base (z0)', true], ['Phone (z1)', true], ['⚠ unplaced: Layer (z2)', false]]);
  const s = 4096 / 5000;
  expect(variant.layers![1]).toMatchObject({ x: 1000 * s, y: 500 * s, width: 400 * s, height: 200 * s });
  // Natural aspect kept (6:1), shrunk only to fit the canvas.
  expect(variant.layers![2].width / variant.layers![2].height).toBeCloseTo(6);
  expect(stored).toHaveLength(3);
});
