import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { expect, it, vi } from 'vitest';
import { assessBackgroundContamination, meaningfulRegions } from './backgroundContamination.js';
import { createRun, executeRun } from './layerizeExperiment.js';
import type { FalTransport } from './providers/falClient.js';

const options = { minRegionPercent: 0.1, contaminatedPercent: 0.2, minConfidence: 0.5 };
const png = (content: string) => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="#fafafa"/>${content}</svg>`)).png().toBuffer();
const shadow = '<defs><filter id="b"><feGaussianBlur stdDeviation="1"/></filter></defs><ellipse cx="255" cy="270" rx="65" ry="20" opacity=".3" filter="url(#b)"/>';
it('meaningful residual regions exclude faint shadow and tiny residue but include a missed neutral-color object', async () => {
  for (const [svg, meaningful] of [[shadow, false], ['<rect x="200" y="170" width="80" height="150" rx="10" fill="#777"/>', true]] as const) {
    const rgb = await sharp(await png(svg)).removeAlpha().raw().toBuffer();
    const assessment = assessBackgroundContamination({ rgb, width: 512, height: 512 }, options);
    expect(assessment.contaminated).toBe(true);
    expect(meaningfulRegions(assessment, options).length > 0).toBe(meaningful);
  }
  expect(meaningfulRegions({ regions: [{ areaPercent: 0.2, confidence: 1, contrast: 5, shadowLike: false, box: [0, 0, .1, .1], fill: 1, position: 'left' }] }, options)).toEqual([]);
  const pieces = Array.from({ length: 6 }, () => ({ areaPercent: 0.37, confidence: .85, contrast: 4.35, shadowLike: false, box: [0, 0, .1, .1] as [number, number, number, number], fill: .79, position: 'center' }));
  expect(meaningfulRegions({ regions: pieces }, options)).toHaveLength(6);
  expect(meaningfulRegions({ regions: pieces.map(r => ({ ...r, shadowLike: true })) }, options)).toEqual([]);
});

it.each([
  ['shadow only', shadow, 0, 'residue-only'],
  ['missed product', '<rect x="200" y="170" width="80" height="150" rx="10" fill="#777"/>', 1, 'no-new-layers'],
] as const)('%s: bounds residual calls in the real loop', async (_name, content, residualCalls, stopReason) => {
  const source = await png(content), empty = await png('');
  let submissions = 0;
  const transport: FalTransport = { upload: vi.fn(async () => 'https://v3b.fal.media/files/test/input.png'),
    submit: vi.fn(async () => { submissions++; if (submissions > 2) throw new Error('Unexpected retry'); return { requestId: String(submissions) }; }),
    status: vi.fn(async () => 'COMPLETED' as const), result: vi.fn(async (_endpoint, id) => ({ layers: [{ image: { url: `https://v3b.fal.media/files/test/${id}.png` }, z_index: 0, name: 'Layer 0' }] })),
    download: vi.fn(async url => url.endsWith('/1.png') ? source : empty), cancel: vi.fn(async () => undefined) };
  const reconstruct = vi.fn(async () => { throw new Error('No background edit expected'); });
  const { dir } = await createRun(mkdtempSync(join(tmpdir(), 'residual-cost-')), source, { mode: 'automatic' }, { templateKey: 'template-b', semanticPlanning: true, refinement: options });
  const planner = vi.fn(async () => { throw new Error('Automatic mode must not call the planner'); });
  const run = await executeRun(dir, { planner, transport: () => transport, backgroundReconstructor: { model: 'fake', reconstruct }, sleep: async () => undefined });
  expect(run.stage).toBe('done');
  expect(run.calls).toMatchObject({ planner: 0, seedreamInitial: 1, seedreamResidual: residualCalls, backgroundReconstruction: 0 });
  expect(run.refinement?.stopReason).toBe(stopReason);
  expect(submissions).toBe(1 + residualCalls);
  expect(reconstruct).not.toHaveBeenCalled();
  expect(planner).not.toHaveBeenCalled();
}, 30_000);
