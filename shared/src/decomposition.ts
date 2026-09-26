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
  action: 'save-proposals' | 'approve-proposals' | 'merge-targets' | 'split-target' | 'manual-alpha' | 'restore-interior' | 'back-to-semantic' | 'manual-masks' | 'accept-masks' | 'guided-refine' | 'accept-visible-only' | 'approve-generation' | 'approve-result';
  objects?: { id: string; candidateId?: string; label?: string; points?: DecompositionPoint[]; box?: DecompositionBox; strokes?: DecompositionStroke[]; selected?: boolean; completeHidden?: boolean }[];
  targets?: ProposalReviewTarget[];
  group?: { label: string; memberIds: string[] };
  alphaValue?: number;
  order?: string[];
  occlusion?: { frontObjectId: string; backObjectId: string }[];
  hiddenRegions?: { objectId: string; strokes: DecompositionStroke[]; prompt: string }[];
}
export type ReviewGate = 'qwen-proposal-review' | 'semantic-mask-review' | 'alpha-review';
export type QualityTier = 'PASS' | 'REVIEW' | 'FAIL';
/** One named ownership check behind a REVIEW/FAIL tier, with a user-facing message. */
export interface QualityCheckSummary { code: string; tier: 'REVIEW' | 'FAIL'; message: string }
export interface DecompositionReviewRequest { gate?: ReviewGate; code: string; message: string; actions: string[]; artifactIds: string[] }
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
  candidates?: { id: string; label: string; maskArtifactId: string; overlayArtifactId?: string; analysisMaskArtifactId?: string; source?: 'sam2' | 'sam3' | 'synthesized'; target?: SemanticTarget; qualityStatus?: string; qualityTier?: QualityTier; qualityChecks?: QualityCheckSummary[]; revisionId?: string; sourceCandidateIds?: string[]; proposalId?: string; proposalMatches?: { proposalId: string; iou: number }[]; statistics?: { area: number; areaFraction: number }; selected?: boolean; warnings: string[] }[];
  proposals?: ProposalSummary[]; proposalTargets?: ProposalReviewTarget[]; refined?: ReviewedMask[]; discovery?: DiscoverySummary;
  reviewSubmission?: DecompositionReview;
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
  if (!object(value) || !integer(value.expectedRevision) || !['save-proposals','approve-proposals','merge-targets','split-target','manual-alpha','restore-interior','back-to-semantic','manual-masks','accept-masks','guided-refine','accept-visible-only','approve-generation','approve-result'].includes(String(value.action))) return false;
  if (value.order !== undefined && (!strings(value.order) || value.order.length > 12 || new Set(value.order).size !== value.order.length)) return false;
  if (value.occlusion !== undefined && (!Array.isArray(value.occlusion) || value.occlusion.length > 144 || !value.occlusion.every((edge) => object(edge) && typeof edge.frontObjectId === 'string' && typeof edge.backObjectId === 'string' && edge.frontObjectId.length <= 100 && edge.backObjectId.length <= 100 && edge.frontObjectId !== edge.backObjectId))) return false;
  if (value.hiddenRegions !== undefined && (!Array.isArray(value.hiddenRegions) || value.hiddenRegions.length > 2 || !value.hiddenRegions.every((region) => object(region) && typeof region.objectId === 'string' && region.objectId.length <= 100 && typeof region.prompt === 'string' && region.prompt.length > 0 && region.prompt.length <= 2000 && Array.isArray(region.strokes) && region.strokes.length > 0 && region.strokes.length <= 100 && region.strokes.every((stroke) => object(stroke) && ['add','subtract'].includes(String(stroke.mode)) && finite(stroke.radius) && stroke.radius >= 1 && stroke.radius <= 256 && Array.isArray(stroke.points) && stroke.points.length > 0 && stroke.points.length <= 1000 && stroke.points.every((p) => object(p) && finite(p.x) && finite(p.y) && p.x >= 0 && p.y >= 0 && p.x < width && p.y < height))))) return false;
  if (value.alphaValue !== undefined && (!integer(value.alphaValue) || value.alphaValue < 0 || value.alphaValue > 255)) return false;
  if (value.group !== undefined && (!object(value.group) || typeof value.group.label !== 'string' || !value.group.label.trim() || value.group.label.length > 100 || !strings(value.group.memberIds) || !value.group.memberIds.length || value.group.memberIds.length > 6 || new Set(value.group.memberIds).size !== value.group.memberIds.length)) return false;
  if (value.targets !== undefined) {
    if (!Array.isArray(value.targets) || value.targets.length > 12 || new Set(value.targets.map(t => object(t) ? t.id : null)).size !== value.targets.length) return false;
    for (const target of value.targets) {
      if (!object(target) || typeof target.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(target.id) || typeof target.label !== 'string' || !target.label.trim() || target.label.length > 100 || !strings(target.proposalIds) || target.proposalIds.length > 6 || new Set(target.proposalIds).size !== target.proposalIds.length || typeof target.approved !== 'boolean' || typeof target.rejected !== 'boolean' || (target.approved && target.rejected) || !['single','group'].includes(String(target.groupMode)) || !['foreground','background','text','shape','object','unknown'].includes(String(target.role))) return false;
      if (target.description !== undefined && (typeof target.description !== 'string' || target.description.length > 500)) return false;
      if (target.baseLayer !== undefined && typeof target.baseLayer !== 'boolean') return false;
      if (target.splitFromTargetId !== undefined && (typeof target.splitFromTargetId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(target.splitFromTargetId))) return false;
      if (target.memberTargetIds !== undefined && (!strings(target.memberTargetIds) || target.memberTargetIds.length > 6 || new Set(target.memberTargetIds).size !== target.memberTargetIds.length)) return false;
      if (!validDecompositionReview({ expectedRevision: value.expectedRevision, action: 'manual-masks', objects: [{ id: target.id, label: target.label, points: target.points, box: target.userBox, strokes: target.strokes }] }, width, height)) return false;
    }
  }
  if (['save-proposals','approve-proposals'].includes(String(value.action)) && !value.targets) return false;
  if (['merge-targets','split-target'].includes(String(value.action)) && !value.group) return false;
  if (value.objects === undefined) return true;
  if (!Array.isArray(value.objects) || value.objects.length > 64) return false;
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

/** User intent is distinct from model labels and source-image evidence. */
export interface SemanticTarget {
  id: string; label: string; providerPrompt: string; compositionMode: 'single' | 'group';
  memberHints?: string[]; proposalIds?: string[]; userConfirmedGroup?: boolean; role?: ProposalReviewTarget['role']; origin: 'user' | 'proposal'; proposalId?: string;
}

export interface ProposalReviewTarget {
  id: string; label: string; proposalIds: string[]; approved: boolean; rejected: boolean;
  memberTargetIds?: string[]; groupMode: 'single' | 'group'; role: 'foreground' | 'background' | 'text' | 'shape' | 'object' | 'unknown';
  /** Provider description of the discovered element (display only). */
  description?: string;
  /** Set by the server for the discovered base/background layer; never routed to source segmentation. */
  baseLayer?: boolean;
  /** Client hint when a target was split out of another; the server verifies it and records provenance. */
  splitFromTargetId?: string;
  /** Server-computed history. Client-supplied values are ignored. */
  provenance?: ProposalTargetProvenance;
  /** Server-computed reconstruction route; an explicit role always wins. Client-supplied values are ignored. */
  classification?: ElementClassification;
  points?: DecompositionPoint[]; strokes?: DecompositionStroke[]; userBox?: DecompositionBox;
  provisionalMaskRevision?: string; maskArtifactId?: string; overlayArtifactId?: string;
}
/** IMAGE_OBJECT → source segmentation, TEXT → text reconstruction, SHAPE → vector geometry, BACKGROUND → kept, UNKNOWN → user decides. */
export type ElementKind = 'IMAGE_OBJECT' | 'TEXT' | 'SHAPE' | 'BACKGROUND' | 'UNKNOWN';
export interface ElementClassification {
  kind: ElementKind; confidence: 'user' | 'high' | 'medium' | 'low';
  source: 'user-role' | 'base-layer' | 'user-intent' | 'provider-label' | 'provider-description' | 'default'; reasons: string[];
}
export interface ProposalTargetProvenance {
  operation: 'discovered' | 'discovered-base' | 'target-label' | 'user-created' | 'user-group' | 'user-split';
  /** Review revision that created this target (0 for discovery). */
  sourceRevision: number; createdAt: string;
  /** Provider or option label the target started with, so renames stay traceable. */
  originalLabel?: string;
  proposalIds?: string[]; memberTargetIds?: string[]; memberLabels?: string[]; parentTargetId?: string; parentLabel?: string;
}
export interface ProposalSummary {
  id: string; label: string; artifactId: string; alphaArtifactId?: string; width: number; height: number;
  registered: boolean; warnings: string[]; bounds?: DecompositionBox | null; coverage?: number;
  seed?: number; requestFingerprint?: string;
  /** Discovery contract fields. Optional: historical Qwen jobs persisted before discovery-v1 omit them. */
  provider?: DiscoveryProviderName; providerModel?: string; labelSource?: 'provider' | 'generic'; description?: string;
  zIndex?: number; providerOrder?: number; providerBbox?: DecompositionBox; sourceRegistration?: DiscoverySourceRegistration;
  sourceHash?: string; providerRequestId?: string; revision?: number; contractVersion?: string; metadataWarnings?: string[];
}
export type DiscoveryProviderName = 'seedream' | 'qwen';
/** How a provider layer was placed on the analysis canvas. Unregistered layers are never stretched into place. */
export interface DiscoverySourceRegistration {
  method: 'full-canvas' | 'bbox-placed' | 'bbox-scaled' | 'unregistered';
  /** Provider image size and provider-canvas → analysis scale. */
  providerWidth: number; providerHeight: number; scaleX: number; scaleY: number;
  /** Placement rules version; absent on registrations persisted before seedream-registration-v2. */
  revision?: string;
  /** Provider-canvas bbox [left, top, right, bottom] the layer was placed from. */
  providerBbox?: [number, number, number, number];
  /** bbox-scaled only: crop pixels per bbox pixel on each axis, their geometric mean, and the relative aspect error. */
  cropScaleX?: number; cropScaleY?: number; cropScale?: number; aspectError?: number;
}
export interface DiscoverySummary {
  contractVersion: string; provider: DiscoveryProviderName; providerModel: string; fallbackFrom?: DiscoveryProviderName;
  requestFingerprint?: string; providerRequestId?: string; deterministic: boolean; sourceHash: string;
  attempts: { provider: DiscoveryProviderName; providerModel: string; outcome: 'used' | 'failed' | 'unreliable'; code?: string; providerRequestId?: string; proposalCount?: number }[];
  baseLayer?: { artifactId: string; width: number; height: number; zIndex: number; name?: string; description?: string; sourceRegistration: DiscoverySourceRegistration };
  warnings: string[];
}
export interface ReviewedMask {
  id: string; label: string; maskArtifactId: string; alphaArtifactId: string; overlayArtifactId: string;
  revisionId: string; maskRevisionId: string; alphaRevisionId: string; overlayRevisionId: string;
  qualityStatus?: QualityTier; warnings: string[];
}
export interface SemanticTargetGroup {
  id: string; label: string; memberTargets: string[]; relationshipEvidence: string[];
  groupMaskRevision: string; provenance: { operation: 'user-group'; sourceRevision: number; timestamp: string };
}
