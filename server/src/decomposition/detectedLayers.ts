import { createHash } from 'node:crypto';
import type { DecompositionStroke, DetectedLayerCutout, ProposalReviewTarget, ProposalSummary } from '@frameflow/shared';
import type { DecompositionRepository, JobRecord } from './repository.js';
import type { ArtifactStore } from './artifactStore.js';
import { DecompositionError } from './errors.js';
import { applyBrush } from './image/masks.js';
import { decodeRgba } from './image/extract.js';
import type { ImageTransform } from './image/coordinates.js';
import { discoveryRegionAlpha, sourceRaster } from './phases/sceneGraph.js';
import { classifyTarget } from './phases/classification.js';
import { suggestText, type SourcePixels } from './phases/elementReconstruction.js';

const KIND = { IMAGE_OBJECT: 'image', TEXT: 'text', SHAPE: 'shape', BACKGROUND: 'image', UNKNOWN: 'image' } as const;

/**
 * A detected layer the user left for later, cut from the ORIGINAL source pixels with its discovery region (plus any
 * brush corrections). Entirely local: no provider is contacted and the job itself is not changed. This is the same
 * region raster the pipeline uses for text and shape layers; image objects that need AI-refined edges still go through
 * the reviewed pipeline.
 */
export async function detectedLayerCutout(repository: DecompositionRepository, store: ArtifactStore, job: JobRecord, targetId: string, strokes: DecompositionStroke[] = []): Promise<DetectedLayerCutout> {
  const targets = (job.data.proposalTargets ?? []) as ProposalReviewTarget[];
  const target = targets.find(t => t.id === targetId);
  if (!target) throw new DecompositionError('LAYER_NOT_FOUND', 'This detected layer is no longer part of the design.', 404);
  if (target.baseLayer) throw new DecompositionError('LAYER_IS_BACKGROUND', 'Use the rebuilt background instead of a cut-out.', 409);
  const source = repository.getSource(job.sourceId, job.ownerId);
  const master = source && repository.getArtifact(source.masterArtifactId, job.ownerId);
  if (!source || !master) throw new DecompositionError('SOURCE_NOT_FOUND', 'The original image is no longer available.', 404);
  const read = async (id: string) => { const record = repository.getArtifact(id, job.ownerId); if (!record) throw new DecompositionError('ARTIFACT_UNAVAILABLE', 'Part of this layer is no longer available.', 409); return store.read(record); };
  const proposals = (job.data.proposals ?? []) as ProposalSummary[];
  let alpha = await discoveryRegionAlpha(read, proposals, job.data.analysisTransform as ImageTransform, target.proposalIds, target.maskArtifactId);
  if (alpha && strokes.length) alpha = applyBrush(alpha, strokes);
  const raster = alpha && await sourceRaster(await decodeRgba(await store.read(master)) as SourcePixels, alpha);
  if (!raster) throw new DecompositionError('LAYER_EMPTY', 'Nothing is selected for this layer. Paint over it to add it.', 422);
  const kind = KIND[classifyTarget(target, proposals).kind];
  const key = createHash('sha256').update(JSON.stringify({ targetId, strokes })).digest('hex').slice(0, 16);
  const artifact = await store.write({ ownerId: job.ownerId, jobId: job.id, kind: 'detected-cutout', mimeType: 'image/png', width: raster.bbox.width, height: raster.bbox.height, relativePath: `07-detected/${targetId}-${key}.png` }, raster.png);
  return { targetId, label: target.label, kind, artifactId: artifact.artifactId, bbox: raster.bbox,
    ...(kind === 'text' ? { textSuggestion: suggestText(target.label, target.description) } : {}) };
}
