/** Portable decomposition contracts, deliberately separate from project schema v1. */
export type DecompositionState = 'queued' | 'running' | 'needs_review' | 'completed' | 'partial' | 'failed' | 'cancel_requested' | 'cancelled';
export type DecompositionPhase = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
export interface DecompositionOptions {
  maxObjects: number;
  targetLabels: string[];
  qualityProfile: 'faithful' | 'refined';
  completeHiddenObjects: boolean;
  reconstructBackground: boolean;
  allowEraseFallback: boolean;
  maxCalls: number;
}
export interface DecompositionClientContext { projectId: string; variantId: string; sourceAssetId?: string; variantRevision: number; operationToken: string }
export interface DecompositionBox { x: number; y: number; width: number; height: number }
export interface DecompositionPoint { x: number; y: number; label: 0 | 1 }
export interface DecompositionStroke { mode: 'add' | 'subtract'; radius: number; points: { x: number; y: number }[] }
export interface DecompositionReview {
  expectedRevision: number;
  action: 'accept-masks' | 'guided-refine' | 'accept-visible-only' | 'approve-generation' | 'approve-result';
  objects?: { id: string; candidateId?: string; label?: string; points?: DecompositionPoint[]; box?: DecompositionBox; strokes?: DecompositionStroke[]; selected?: boolean; completeHidden?: boolean }[];
  order?: string[];
  occlusion?: { frontObjectId: string; backObjectId: string }[];
  hiddenRegions?: { objectId: string; strokes: DecompositionStroke[]; prompt: string }[];
}
export interface DecompositionReviewRequest { code: string; message: string; actions: string[]; artifactIds: string[] }
export interface DecompositionArtifactRef {
  artifactId: string; relativePath: string; sha256: string; mimeType: string; bytes: number; width: number; height: number;
}
export interface DecompositionLayer {
  id: string; objectId: string; groupId?: string; label: string; labelSource: 'user' | 'target-prompt' | 'generic';
  kind: 'object' | 'background' | 'residual' | 'object-component'; zIndex: number; bbox: DecompositionBox;
  rgba: DecompositionArtifactRef; alpha: DecompositionArtifactRef; visibleOwnership: DecompositionArtifactRef;
  generatedSupport?: DecompositionArtifactRef; visibleOnlyRgba?: DecompositionArtifactRef;
  generation: 'none' | 'partial' | 'fully-generated'; completionStatus: 'not-needed' | 'completed' | 'skipped' | 'needs-review' | 'failed';
  provenanceStepIds: string[]; quality: { reviewRequired: boolean; warnings: string[]; metrics: Record<string, number> };
}
export interface DecompositionManifest {
  schemaVersion: 1; pipelineVersion: string; jobId: string; revision: number; status: 'completed' | 'partial';
  source: { originalSha256: string; workingMasterSha256: string; width: number; height: number; colorSpace: 'srgb'; orientationNormalized: boolean };
  coordinateSystem: 'working-master-pixels'; alphaMode: 'straight'; layers: DecompositionLayer[];
  occlusion: { frontLayerId: string; backLayerId: string; confidence: number; decisionSource: 'heuristic' | 'user'; regionArtifactId?: string }[];
  warnings: string[]; createdAt: string;
  preview?: DecompositionArtifactRef; qualityReport?: DecompositionArtifactRef; provenance?: DecompositionArtifactRef;
}
export interface DecompositionJobSummary {
  id: string; sourceId: string; state: DecompositionState; revision: number; phase: number; options: DecompositionOptions;
  warnings: string[]; review?: DecompositionReviewRequest; error?: { code: string; message: string; retryable: boolean };
  progress: string; callsUsed: number; createdAt: string; updatedAt: string; expiresAt: string;
  sourcePreviewArtifactId?: string; sourceWidth?: number; sourceHeight?: number;
  candidates?: { id: string; label: string; maskArtifactId: string; overlayArtifactId?: string; area: number; selected?: boolean; warnings: string[] }[];
  context?: DecompositionClientContext; artifacts: DecompositionArtifactRef[]; manifest?: DecompositionManifest;
}
export interface DecompositionCapabilities {
  providerMode?: 'mock' | 'live'; workerAvailable?: boolean;
  enabled: boolean; configured: boolean; authenticated: boolean; authMode: 'local-operator' | 'development';
  limits: { uploadBytes: number; minSide: number; maxSide: number; maxPixels: number; maxObjects: number; maxCalls: number; retentionDays: number };
  message: string;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const integer = (value: unknown): value is number => finite(value) && Number.isSafeInteger(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');
const safePath = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 240 && !value.startsWith('/') && !value.includes('\\') && value.split('/').every((part) => /^[a-zA-Z0-9_.-]+$/.test(part) && part !== '.' && part !== '..');
export function validDecompositionArtifact(value: unknown): value is DecompositionArtifactRef {
  return object(value) && typeof value.artifactId === 'string' && safePath(value.relativePath) && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256) && typeof value.mimeType === 'string' && integer(value.bytes) && value.bytes >= 0 && integer(value.width) && value.width >= 0 && integer(value.height) && value.height >= 0;
}
export function validDecompositionManifest(value: unknown): value is DecompositionManifest {
  if (!object(value) || value.schemaVersion !== 1 || value.coordinateSystem !== 'working-master-pixels' || value.alphaMode !== 'straight' || !['completed', 'partial'].includes(String(value.status)) || typeof value.jobId !== 'string' || typeof value.pipelineVersion !== 'string' || !integer(value.revision) || !strings(value.warnings) || typeof value.createdAt !== 'string' || !object(value.source) || !Array.isArray(value.layers) || !value.layers.length || !Array.isArray(value.occlusion)) return false;
  const source = value.source;
  if (!integer(source.width) || !integer(source.height) || source.width <= 0 || source.height <= 0 || source.colorSpace !== 'srgb' || typeof source.orientationNormalized !== 'boolean' || ![source.originalSha256, source.workingMasterSha256].every((hash) => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash))) return false;
  const ids = new Set<string>(); const paths = new Map<string, string>();
  for (const layer of value.layers) {
    if (!object(layer) || typeof layer.id !== 'string' || ids.has(layer.id) || typeof layer.objectId !== 'string' || typeof layer.label !== 'string' || !['user','target-prompt','generic'].includes(String(layer.labelSource)) || !['object','background','residual','object-component'].includes(String(layer.kind)) || !integer(layer.zIndex) || !object(layer.bbox) || !strings(layer.provenanceStepIds) || !object(layer.quality) || typeof layer.quality.reviewRequired !== 'boolean' || !strings(layer.quality.warnings) || !object(layer.quality.metrics) || !Object.values(layer.quality.metrics).every(finite) || !['none','partial','fully-generated'].includes(String(layer.generation)) || !['not-needed','completed','skipped','needs-review','failed'].includes(String(layer.completionStatus))) return false;
    ids.add(layer.id); const b = layer.bbox;
    if (![b.x,b.y,b.width,b.height].every(integer) || (b.x as number) < 0 || (b.y as number) < 0 || (b.width as number) < 1 || (b.height as number) < 1 || (b.x as number) + (b.width as number) > source.width || (b.y as number) + (b.height as number) > source.height) return false;
    for (const [key, required] of [['rgba',true],['alpha',true],['visibleOwnership',true],['generatedSupport',false],['visibleOnlyRgba',false]] as const) {
      const ref = layer[key]; if (!ref && !required) continue;
      if (!validDecompositionArtifact(ref) || ref.mimeType !== 'image/png' || ref.width !== b.width || ref.height !== b.height || (paths.has(ref.relativePath) && paths.get(ref.relativePath) !== ref.artifactId)) return false;
      paths.set(ref.relativePath, ref.artifactId);
    }
    if (layer.generation !== 'none' && !layer.generatedSupport) return false;
  }
  for (const edge of value.occlusion) if (!object(edge) || !ids.has(String(edge.frontLayerId)) || !ids.has(String(edge.backLayerId)) || edge.frontLayerId === edge.backLayerId || !finite(edge.confidence) || edge.confidence < 0 || edge.confidence > 1 || !['user','heuristic'].includes(String(edge.decisionSource))) return false;
  return [value.preview,value.qualityReport,value.provenance].every((ref) => ref === undefined || validDecompositionArtifact(ref));
}
export function validDecompositionReview(value: unknown, width: number, height: number): value is DecompositionReview {
  if (!object(value) || !integer(value.expectedRevision) || !['accept-masks','guided-refine','accept-visible-only','approve-generation','approve-result'].includes(String(value.action))) return false;
  if (value.order !== undefined && (!strings(value.order) || value.order.length > 12 || new Set(value.order).size !== value.order.length)) return false;
  if (value.occlusion !== undefined && (!Array.isArray(value.occlusion) || value.occlusion.length > 144 || !value.occlusion.every((edge) => object(edge) && typeof edge.frontObjectId === 'string' && typeof edge.backObjectId === 'string' && edge.frontObjectId.length <= 100 && edge.backObjectId.length <= 100 && edge.frontObjectId !== edge.backObjectId))) return false;
  if (value.hiddenRegions !== undefined && (!Array.isArray(value.hiddenRegions) || value.hiddenRegions.length > 2 || !value.hiddenRegions.every((region) => object(region) && typeof region.objectId === 'string' && region.objectId.length <= 100 && typeof region.prompt === 'string' && region.prompt.length > 0 && region.prompt.length <= 2000 && Array.isArray(region.strokes) && region.strokes.length > 0 && region.strokes.length <= 100 && region.strokes.every((stroke) => object(stroke) && ['add','subtract'].includes(String(stroke.mode)) && finite(stroke.radius) && stroke.radius >= 1 && stroke.radius <= 256 && Array.isArray(stroke.points) && stroke.points.length > 0 && stroke.points.length <= 1000 && stroke.points.every((p) => object(p) && finite(p.x) && finite(p.y) && p.x >= 0 && p.y >= 0 && p.x < width && p.y < height))))) return false;
  if (value.objects === undefined) return true;
  if (!Array.isArray(value.objects) || value.objects.length > 12) return false;
  const point = (p: unknown) => object(p) && finite(p.x) && finite(p.y) && p.x >= 0 && p.y >= 0 && p.x < width && p.y < height;
  return value.objects.every((entry) => {
    if (!object(entry) || typeof entry.id !== 'string' || entry.id.length > 100 || (entry.candidateId !== undefined && (typeof entry.candidateId !== 'string' || entry.candidateId.length > 100)) || (entry.label !== undefined && (typeof entry.label !== 'string' || !entry.label.trim() || entry.label.length > 100))) return false;
    if (entry.points !== undefined && (!Array.isArray(entry.points) || entry.points.length > 64 || !entry.points.every((p) => point(p) && object(p) && (p.label === 0 || p.label === 1)))) return false;
    if (entry.box !== undefined && (!object(entry.box) || !point(entry.box) || !finite(entry.box.width) || !finite(entry.box.height) || entry.box.width <= 0 || entry.box.height <= 0 || (entry.box.x as number) + entry.box.width > width || (entry.box.y as number) + entry.box.height > height)) return false;
    if (entry.strokes !== undefined && (!Array.isArray(entry.strokes) || entry.strokes.length > 100 || !entry.strokes.every((stroke) => object(stroke) && ['add','subtract'].includes(String(stroke.mode)) && finite(stroke.radius) && stroke.radius >= 1 && stroke.radius <= 256 && Array.isArray(stroke.points) && stroke.points.length > 0 && stroke.points.length <= 1000 && stroke.points.every(point)))) return false;
    return (entry.selected === undefined || typeof entry.selected === 'boolean') && (entry.completeHidden === undefined || typeof entry.completeHidden === 'boolean');
  });
}

export type ReviewCorrection = DecompositionReview;
