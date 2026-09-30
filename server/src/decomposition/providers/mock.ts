import sharp from 'sharp';
import { personHoldingBoardFixture } from '../image/syntheticFixtures.js';
import { cropMask, resizeMask, encodeMask } from '../image/masks.js';
import { sha256 } from '../phases/source.js';
import { normalizeProviderOutput, endpointRegistry, ProviderError } from './adapters.js';
import type { PipelineContext } from '../context.js';

/** Explicit fixture provider. Never used as a fallback and never pretends to segment arbitrary images. */
export async function attachMockProvider(context: PipelineContext) {
  const fixture = await personHoldingBoardFixture();
  const source = context.repository.getSource(context.job.sourceId)!;
  const master = await context.artifact(source.masterArtifactId);
  const raw = await sharp(master).ensureAlpha().raw().toBuffer();
  if (sha256(raw) !== sha256(await sharp(fixture.image).ensureAlpha().raw().toBuffer())) throw new ProviderError('MOCK_FIXTURE_REQUIRED', 'Mock mode supports only the owned person-and-board fixture. Choose Use demo fixture, or configure Live Fal for other artwork.');
  context.infer = async (model, request) => {
    context.check();
    const buffers: Buffer[] = [];
    if (model === 'qwen') {
      for (const mask of [fixture.person, fixture.board]) buffers.push(await sharp(master).removeAlpha().joinChannel(Buffer.from(mask.data), { raw: { width: mask.width, height: mask.height, channels: 1 } }).png().toBuffer());
    } else if (model === 'sam2') {
      for (const mask of [fixture.person, fixture.board]) buffers.push(await encodeMask(mask));
    } else if (model === 'sam3' || model === 'birefnet') {
      const t = request.transform; if (!t) throw new Error('Missing fixture crop transform');
      const mask = request.prompt === 'board' ? fixture.board : fixture.person;
      let bytes = await encodeMask(resizeMask(cropMask(mask, t.crop), t.modelWidth, t.modelHeight));
      if (model === 'birefnet') bytes = await sharp(bytes).blur(0.8).png().toBuffer();
      buffers.push(bytes);
    } else throw new ProviderError('MOCK_SCOPE', 'Mock demo stops at phase 6.');
    const images = buffers.map((_, i) => ({ url: `https://mock.invalid/${model}/${i}.png` }));
    normalizeProviderOutput(model, model === 'qwen' ? { images } : model === 'sam2' ? { individual_masks: images } : model === 'sam3' ? { masks: images } : { image: images[0] });
    const provenance = (context.job.data.inferences ??= {}) as Record<string, unknown>;
    provenance[request.key ?? model] = { provider: 'mock', liveVerified: false, endpoint: endpointRegistry[model].endpoint, requestId: `mock-${request.key}`, transform: request.transform, outputHashes: buffers.map(sha256) };
    context.save(); return buffers;
  };
}
export const mockReviewObjects = [
  { id: 'candidate-1', label: 'person', selected: true, points: [{ x: 150, y: 120, label: 1 as const }, { x: 160, y: 200, label: 0 as const }] },
  { id: 'candidate-2', label: 'board', selected: true, points: [{ x: 160, y: 200, label: 1 as const }, { x: 150, y: 60, label: 0 as const }, { x: 70, y: 205, label: 0 as const }, { x: 247, y: 205, label: 0 as const }, { x: 150, y: 120, label: 0 as const }] },
];
