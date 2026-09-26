import sharp from 'sharp';
import type { DiscoverySummary, ElementKind, ProposalReviewTarget, ProposalSummary, SceneGraph, SceneLayer, SemanticTarget, DecompositionBox } from '@frameflow/shared';
import type { PipelineContext } from '../context.js';
import type { SourceAsset } from '../repository.js';
import { decodeMask, mapMaskToNative, maskBounds } from '../image/masks.js';
import { decodeRgba } from '../image/extract.js';
import type { ImageTransform } from '../image/coordinates.js';
import type { Mask } from '../image/types.js';
import { estimateTextStyle, fitShape, suggestText, type SourcePixels } from './elementReconstruction.js';

type Extracted = { objectId: string; label: string; bbox: DecompositionBox; rgbaArtifactId: string };
type Refined = { id: string; label: string; maskArtifactId: string; alphaArtifactId: string; revisionId?: string; maskRevisionId?: string; alphaRevisionId?: string; ownershipSource?: string; target?: SemanticTarget };
type SceneElement = { targetId: string; label: string; kind: ElementKind; proposalIds: string[]; description?: string; baseLayer: boolean; provisionalMaskArtifactId?: string; provisionalMaskRevision?: string };
const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2));

/** Source RGB × alpha, cropped to the alpha bounds (plus padding), as a straight-alpha PNG. */
async function sourceRaster(pixels: SourcePixels, alpha: Mask, padding = 2) {
  const bounds = maskBounds(alpha);
  if (!bounds) return undefined;
  const x = Math.max(0, bounds.x - padding), y = Math.max(0, bounds.y - padding);
  const width = Math.min(pixels.width, bounds.x + bounds.width + padding) - x, height = Math.min(pixels.height, bounds.y + bounds.height + padding) - y;
  const out = Buffer.alloc(width * height * 4);
  for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) {
    const s = ((y + j) * pixels.width + (x + i)), d = (j * width + i) * 4;
    out[d] = pixels.data[s * 4]; out[d + 1] = pixels.data[s * 4 + 1]; out[d + 2] = pixels.data[s * 4 + 2];
    out[d + 3] = Math.round(pixels.data[s * 4 + 3] * alpha.data[s] / 255);
  }
  return { png: await sharp(out, { raw: { width, height, channels: 4 } }).png().toBuffer(), bbox: { x, y, width, height } };
}

/**
 * Build the editable scene graph after native extraction. Image layers carry original RGB × approved alpha; text and
 * shape layers are reconstructed from their reviewed discovery regions, always keeping a source-pixel raster; the
 * original source is the background. Z-order follows provider layer order (back to front).
 */
export async function buildSceneGraph(context: PipelineContext, master: Buffer, source: SourceAsset, extracted: Extracted[]): Promise<SceneGraph> {
  const data = context.job.data;
  const pixels = await decodeRgba(master) as SourcePixels;
  const transform = data.analysisTransform as ImageTransform;
  const proposals = (data.proposals ?? []) as ProposalSummary[];
  const targets = (data.proposalTargets ?? []) as ProposalReviewTarget[];
  const refined = (data.refined ?? []) as Refined[];
  const elements = (data.sceneElements ?? []) as SceneElement[];
  const warnings: string[] = [];
  const zOf = (proposalIds: string[]) => {
    const z = proposals.filter(p => proposalIds.includes(p.id)).map(p => p.zIndex ?? (p.providerOrder !== undefined ? p.providerOrder + 1 : undefined)).filter((v): v is number => v !== undefined);
    return z.length ? Math.max(...z) : undefined;
  };
  // Soft discovery alpha (max over member proposals) in native pixels; falls back to the reviewed provisional region.
  const regionAlpha = async (element: SceneElement): Promise<Mask | undefined> => {
    let alpha: Mask | undefined;
    for (const proposal of proposals.filter(p => element.proposalIds.includes(p.id) && p.registered && !p.warnings.length && p.alphaArtifactId)) {
      const native = mapMaskToNative(await decodeMask(await context.artifact(proposal.alphaArtifactId!), { encoding: 'luminance' }), transform, 'alpha');
      alpha = alpha ? { ...alpha, data: alpha.data.map((v, i) => Math.max(v, native.data[i])) } : native;
    }
    if (!alpha && element.provisionalMaskArtifactId) alpha = await decodeMask(await context.artifact(element.provisionalMaskArtifactId), { encoding: 'luminance' });
    return alpha && maskBounds(alpha) ? alpha : undefined;
  };
  const ordered: { z: number | undefined; layer: SceneLayer }[] = [];
  const base = { opacity: 1, rotation: 0, visible: true, locked: false } as const;

  for (const object of refined) {
    const cut = extracted.find(e => e.objectId === object.id);
    if (!cut) { warnings.push(`IMAGE_LAYER_NOT_EXTRACTED:${object.id}`); continue; }
    const target = targets.find(t => t.id === object.id);
    const revision = object.revisionId ?? object.alphaRevisionId ?? 'unknown';
    ordered.push({ z: zOf(target?.proposalIds ?? []), layer: { ...base, id: `image-${object.id}`, type: 'image', name: object.label, bbox: cut.bbox, zIndex: 0, sourceRevision: revision, targetId: object.id,
      transparentRgbaArtifactId: cut.rgbaArtifactId, maskArtifactId: object.maskArtifactId, alphaArtifactId: object.alphaArtifactId, sourcePixelRegion: cut.bbox,
      semanticTarget: { id: object.id, label: object.target?.label ?? object.label, ...(object.target?.memberHints ? { memberHints: object.target.memberHints } : {}) },
      provenance: { maskRevisionId: object.maskRevisionId ?? revision, alphaRevisionId: object.alphaRevisionId ?? revision, ownership: object.ownershipSource === 'user' ? 'user' : 'source-semantic', rgb: 'original-source' },
      metadata: { proposalIds: target?.proposalIds ?? [] } } });
  }

  for (const element of elements.filter(e => e.kind === 'TEXT' || e.kind === 'SHAPE')) {
    const alpha = await regionAlpha(element);
    const raster = alpha && await sourceRaster(pixels, alpha);
    if (!alpha || !raster) { warnings.push(`ELEMENT_REGION_UNAVAILABLE:${element.targetId}`); continue; }
    const rasterArtifact = await context.put(`scene-${element.kind.toLowerCase()}-raster`, raster.png, `06-scene/${element.targetId}-raster.png`);
    const common = { ...base, id: `${element.kind.toLowerCase()}-${element.targetId}`, name: element.label, bbox: raster.bbox, zIndex: 0, sourceRevision: element.provisionalMaskRevision ?? 'discovery', targetId: element.targetId, rasterArtifactId: rasterArtifact.artifactId };
    if (element.kind === 'TEXT') {
      const suggestion = suggestText(element.label, element.description);
      const style = estimateTextStyle(alpha, pixels);
      ordered.push({ z: zOf(element.proposalIds), layer: { ...common, type: 'text', ...suggestion, ...style, alignment: 'left', confidence: suggestion.textConfidence === 'low' ? 0.3 : 0, rasterFallback: true,
        metadata: { proposalIds: element.proposalIds, styleEstimate: 'glyph-pixels', ocr: 'unavailable' } } });
    } else {
      const binary: Mask = { ...alpha, data: alpha.data.map(v => (v >= 128 ? 255 : 0)) };
      const fit = fitShape(binary, pixels);
      ordered.push({ z: zOf(element.proposalIds), layer: { ...common, type: 'shape', shapeType: fit.shapeType, bbox: fit.shapeType === 'raster' ? raster.bbox : fit.bbox, confidence: fit.confidence, fitIoU: fit.fitIoU,
        ...(fit.fill ? { fill: fit.fill } : {}), ...(fit.gradient ? { gradient: fit.gradient } : {}), ...(fit.radius !== undefined ? { radius: fit.radius } : {}),
        metadata: { proposalIds: element.proposalIds, reasons: fit.reasons } } });
    }
  }

  const discovery = data.discovery as DiscoverySummary | undefined;
  const background: SceneLayer = { ...base, locked: true, id: 'background', type: 'background', name: elements.find(e => e.kind === 'BACKGROUND')?.label ?? 'Background', bbox: { x: 0, y: 0, width: source.width, height: source.height },
    zIndex: 0, sourceRevision: source.workingMasterSha256, imageArtifactId: source.masterArtifactId, reconstruction: 'original-source',
    ...(discovery?.baseLayer ? { reconstructionCandidateArtifactId: discovery.baseLayer.artifactId } : {}),
    metadata: { note: 'Hidden pixels behind objects are not reconstructed; the original source is kept.' } };
  // Stable back-to-front order: provider z-index, then elements without provider order on top.
  ordered.sort((a, b) => (a.z ?? Number.MAX_SAFE_INTEGER) - (b.z ?? Number.MAX_SAFE_INTEGER));
  const layers = [background, ...ordered.map(o => o.layer)].map((layer, zIndex) => ({ ...layer, zIndex }));
  const graph: SceneGraph = { schemaVersion: 1, jobId: context.job.id, revision: context.job.revision, width: source.width, height: source.height,
    sourceImage: { artifactId: source.masterArtifactId, originalSha256: source.originalSha256, workingMasterSha256: source.workingMasterSha256 }, layers, createdAt: new Date().toISOString(), warnings };
  await context.put('scene-graph', json(graph), '06-scene/scene-graph.json', 'application/json');
  return graph;
}
