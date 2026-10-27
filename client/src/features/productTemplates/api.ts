/**
 * The client of Product with Text templates (server/src/decomposition/protectedTemplates/product/). Every request goes to
 * the app's own server. Nothing here spends anything unless it says so: `useAi` (finding characters and products, one
 * vision request), `paid` (the cut-out service, one request per object) and `ai` (the variation planner, one request)
 * are only sent when the person chose them after seeing the cost.
 */
import type { MasterCategory, PixelRect, ProductAspectRatio, ReuseAspectRatio, ReuseDraft, ReuseOverride, ReuseTextEdit, ProductVariationCheck, CreativeTextStyle, ProductDecompositionPlan, ProductGenerationBrief, ProductCreative, ProductInfo, ProductObjectKind, ProductSnapshot, ProductStage, ProductVariationInfo, ProductVariationKind, ProtectedTemplate } from '@frameflow/shared';
import { ProtectedApiError, protectedFileUrl } from '../protectedTemplates/api';

const BASE = '/api/layerize-experiment/product-templates';
export { protectedFileUrl as productFileUrl, ProtectedApiError as ProductApiError };

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, { credentials: 'same-origin', cache: 'no-store', ...init });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = body?.error ?? {};
    throw new ProtectedApiError(response.status === 404 && !body?.error ? 'Product templates need the server\'s layerize experiment (LAYERIZE_EXPERIMENT=1).' : error.message ?? `Request failed (${response.status}).`, error.code ?? 'HTTP_ERROR', response.status, error);
  }
  return body as T;
}
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const upload = (file: Blob, fields: Record<string, string> = {}, name?: string): RequestInit => {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  form.append('image', file, name ?? (file instanceof File ? file.name : 'image.png'));
  return { method: 'POST', body: form };
};

export interface ReviewWord { id: string; text: string; line: number; box: PixelRect; removed: boolean; attention: boolean; confidence: number; corrected: boolean }
export interface TextBlock { id: string; category: MasterCategory; text: string; box: PixelRect; words: number; removed: boolean; attention: boolean; confidence: number;
  /** Words of a line lying on top of each other (one is probably misread), named in pairs. */
  overlaps?: string[]; style?: { fontFamily: string; fontSize: number; fontWeight: number; color: string; align: string }; wordList?: ReviewWord[] }
export interface LogoView { id: string; label: string; category: string; box: PixelRect; file: string; removed: boolean; attention: boolean; confidence: number; /** A brand logo or graphic kept in the picture (not its own layer). */ inBackground?: boolean }
export interface Attention { type: 'object' | 'text' | 'logo' | 'missing'; id: string; label: string; reason: string; box: PixelRect }
export interface ProductView {
  recovery?: { savedAnswer: boolean; retrievable: boolean; interrupted: boolean };
  template: { id: string; name: string; revision: number; createdAt: string; updatedAt: string; source: ProtectedTemplate['source'] };
  stage: ProductStage; product: ProductInfo; texts: TextBlock[]; logos: LogoView[]; attention: Attention[];
  counts: { characters: number; products: number; text: number; words: number; logos: number; background: number };
}
export interface ProductListItem { id: string; name: string; createdAt: string; updatedAt: string; stage: ProductStage; source: ProtectedTemplate['source']; counts: ProductView['counts']; revisions: number; /** The latest saved version is a draft with quality warnings. */ draft?: boolean }
export interface SheetAnswer { sheet: boolean; width: number; height: number; boxes: PixelRect[] }
/** What fitting the text did, line by line (letters: read on this computer; strokes: by the picture; kept: unchanged). */
export interface TextFit { moved: number; lines: { text: string; method: 'letters' | 'strokes' | 'kept'; moved: number; reason?: string }[] }
export interface ReviewBody {
  expectedRevision: number;
  /** `layer`, for a podium or stand: its own layer (separated, movable) or part of the background; null clears it. `hidden`: kept but not used. */
  objects: { id?: string; kind: ProductObjectKind; label: string; box: PixelRect; accepted?: boolean; hidden?: boolean; layer?: 'own' | 'background' | null }[];
  texts: { groupId: string; box?: PixelRect; removed?: boolean; category?: MasterCategory; text?: string; accepted?: boolean }[];
  logos: { slotId?: string; removed?: boolean; category?: 'brand-logo' | 'partner-logo' | 'qr' | 'badge'; label?: string; box?: PixelRect; accepted?: boolean; replacement?: string | null }[];
  /** Word by word: its text (one word), box, removal, or another block ('new': a block of its own). */
  words?: { wordId: string; text?: string; box?: PixelRect; removed?: boolean; groupId?: string }[];
  /** Text the detection missed, typed in a box drawn on the creative. */
  newTexts?: { text: string; box: PixelRect; category?: MasterCategory }[];
  dismissMissingText?: boolean;
}
export interface PrepareEstimate { objects: number; local: { usd: 0 }; sam3: { configured: boolean; requests: number; usd: number; note: string };
  /** The AI decomposition core: the OpenAI planner, then Seedream Layerize, on the picture without its text and logos. */
  ai: { configured: boolean; offline: boolean; planner: string; engine: string; elements: number; requests: number; sentSize: { width: number; height: number }; expectedUsd: number; maxUsd: number; note: string } }
export interface CreativeListItem { id: string; name: string; templateRevision: number; revision: number; createdAt: string; updatedAt: string; origin: ProductCreative['origin']; replaced: number; variation?: { kind: ProductVariationKind; title: string } }
export interface VariationOptions { sourceIssues?: string[];
  productFamilies?: string[]; compatibleProducts?: Record<string, string[]>;
  revision: number; kinds: { kind: ProductVariationKind; title: string; hint: string }[]; aspectRatios: ProductAspectRatio[]; canvas: { width: number; height: number };
  slots: { slotId: string; label: string; kind: 'product' | 'character' }[]; choices: { ref: string; label: string; file: string; kind: 'product' | 'character' }[];
  texts: { groupId: string; role: string; text: string }[]; planner: { ai: boolean; model: string; costUsd: number };
  /** New AI artwork: whether an image model is configured, which, whether it is an offline test model, the cost per image (estimate). */
  artwork?: { ai: boolean; model: string; offline: boolean; costUsd: number };
}
/** 'pending': some of its product images are not made yet (paused, awaiting approval or queued); `note` says why. Never a failure. */
export interface VariationResult { index: number; status: 'ready' | 'failed' | 'pending'; note?: string; round?: number; plan?: { kind: ProductVariationKind; title: string; notes: string[] }; creative?: ProductCreative & { variation?: ProductVariationInfo }; preview?: string; previewSha256?: string; savedCreativeId?: string; removed?: boolean; error?: string; runId?: string; /** "Decompose & Edit": the template made from it. */ templateId?: string }
export type GenerationState = 'generating' | 'paused-smoke-test' | 'paused-approval' | 'cancelled' | 'completed' | 'insufficient-credits' | 'provider-failure' | 'connection-interrupted' | 'images-rejected' | 'interrupted' | 'source-blocked' | 'failed';
export interface VariationJob {
  sourceIssues?: string[]; interrupted?: boolean; accounting?: { usageCostUsd: number; uncertainCostUsd: number; estimatedCostUsd: number };
  operations?: { id: string; index: number; slotId: string; label: string; status: string; requestId?: string; asset?: { file: string }; failure?: { code: string; message: string; outcome: string } }[];
  /** Product-image jobs: the precise state and its message (from the server), image progress, and what continuing sends and costs. */
  state?: GenerationState; message?: string; cancelRequested?: boolean;
  authorizations?: { id: string; kind: 'batch' | 'smoke-test' | 'continuation' | 'regenerate'; images: number; maxUsd: number; retry: boolean; approvedAt: string }[];
  progress?: { total: number; ready: number; inFlight: number; waiting: number; retry: number; variations: { index: number; total: number; ready: number; inFlight: number; waiting: number; retry: number; legacy: boolean; blocked: boolean;
    slots: { slotId: string; slot: string; label: string; state: 'ready' | 'received' | 'in-flight' | 'not-started' | 'failed' | 'unknown'; asset?: string; failure?: string }[] }[] };
  continuation?: { available: boolean; reason?: string; images: number; estimateUsd: number; retryImages: number; retryEstimateUsd: number; reused: number; legacy: boolean };
 id: string; templateId: string; revision: number; createdAt: string; status: 'running' | 'paused' | 'done' | 'failed'; running?: boolean; request: { generateProducts?: boolean; count: number; kinds: ProductVariationKind[]; copy: 'none' | 'suggest' | 'apply'; ai: boolean; aspectRatios?: ProductAspectRatio[]; headline?: string; offer?: string; sizes?: 'cycle' | 'each'; brief?: string; briefSource?: 'template' | 'edited' }; planner: { model: string; offline: boolean; requests: number; costUsd: number }; results: VariationResult[]; error?: string;
  productGeneration?: { model: string; offline: boolean; requests: number; costUsd: number };
  artwork?: { mode: 'template' | 'local' | 'ai'; model: string; offline: boolean; requests: number; costUsd: number } }
export interface VariationStart { maxNewImages?: number; count: number; kinds: ProductVariationKind[]; copy: 'none' | 'suggest'; products?: Record<string, string[]>; ai: boolean; aspectRatios: ProductAspectRatio[]; headline?: string; offer?: string;
  generateProducts?: boolean; approveProductsUsd?: number; /** The image count the person approved (must match the server's). */ approveImages?: number; /** Start a new batch although an unfinished one of this revision has saved images. */ startNew?: boolean;
  mode?: 'reuse' | 'typography' | 'redesign'; revision?: number;
  artwork?: 'template' | 'local' | 'ai'; direction?: string; approveArtworkUsd?: number;
  /** 'each': every design in every size; the generation instructions edited for this run. */ sizes?: 'cycle' | 'each'; brief?: string }
export interface TemplateBrief { generation: ProductGenerationBrief; saved: boolean; decomposition: ProductDecompositionPlan }

export const productApi = {
  list: () => call<{ templates: ProductListItem[] }>(''),
  sheet: (file: Blob) => call<SheetAnswer>('/sheet', upload(file)),
  create: (file: Blob, input: { name: string; crop?: PixelRect; useAi: boolean }) => call<ProductView>('', upload(file, { name: input.name, useAi: String(input.useAi), ...(input.crop ? { crop: JSON.stringify(input.crop) } : {}) })),
  get: (id: string) => call<ProductView>(`/${id}`),
  /** `savedAnswer`: read the AI answer already received for this creative again (free: no new request). */
  detect: (id: string, input: { force?: boolean; useAi: boolean; savedAnswer?: boolean; recover?: boolean; newRequest?: boolean }) => call<{ started: boolean; template: ProductView }>(`/${id}/detect`, json('POST', input)),
  review: (id: string, body: ReviewBody) => call<ProductView>(`/${id}/review`, json('PUT', body)),
  /** The AI-read text boxes moved onto their letters (free, on this computer); a person's corrections stay. */
  fitText: (id: string, expectedRevision: number) => call<ProductView & { fit: TextFit }>(`/${id}/text/fit`, json('POST', { expectedRevision })),
  /** A picture for the review (a logo's replacement): stored; used only when the review naming it is saved. */
  reviewAsset: (id: string, file: Blob) => call<{ file: string; width: number; height: number }>(`/${id}/review-assets`, upload(file)),
  estimate: (id: string) => call<PrepareEstimate>(`/${id}/prepare-estimate`),
  /** What is decomposed (Step 3): each object cut out or left in the background, each brand logo or graphic a layer or kept in the picture. */
  select: (id: string, body: { expectedRevision: number; objects: { id: string; decompose: boolean }[]; logos: { slotId: string; separate: boolean }[] }) => call<ProductView>(`/${id}/selection`, json('PUT', body)),
  prepare: (id: string, input: { expectedRevision: number; paid?: boolean; engine?: 'ai'; approveUsd?: number }) => call<{ started: boolean; template: ProductView }>(`/${id}/prepare`, json('POST', input)),
  approve: (id: string, input: { expectedRevision: number; acknowledge: string[]; /** Save despite blocking warnings, as a draft. */ draft?: boolean }) => call<ProductView>(`/${id}/approve`, json('POST', input)),
  publish: (id: string, input: { expectedRevision: number }) => call<ProductView>(`/${id}/publish`, json('POST', input)),
  openEditor: (id: string) => call<{ runId: string; created: boolean; template: ProductView }>(`/${id}/open-editor`, { method: 'POST' }),
  snapshot: (id: string, revision: number) => call<ProductSnapshot>(`/${id}/revisions/${revision}`),
  creatives: (id: string) => call<{ creatives: CreativeListItem[] }>(`/${id}/creatives`),
  createCreative: (id: string, input: { name?: string; revision?: number } = {}) => call<ProductCreative>(`/${id}/creatives`, json('POST', input)),
  getCreative: (id: string, cid: string, revision?: number) => call<ProductCreative>(`/${id}/creatives/${cid}${revision ? `?revision=${revision}` : ''}`),
  saveCreative: (id: string, cid: string, input: { expectedRevision: number; creative: ProductCreative }) => call<ProductCreative>(`/${id}/creatives/${cid}`, json('PUT', input)),
  replace: (id: string, cid: string, objectId: string, file: Blob, expectedRevision: number) => call<{ creative: ProductCreative; cutout: { background: 'transparent' | 'removed' | 'kept'; note?: string } }>(`/${id}/creatives/${cid}/objects/${objectId}/replace`, upload(file, { expectedRevision: String(expectedRevision) })),
  restore: (id: string, cid: string, objectId: string, expectedRevision: number) => call<ProductCreative>(`/${id}/creatives/${cid}/objects/${objectId}/restore`, json('POST', { expectedRevision })),
  duplicate: (id: string, cid: string, name?: string) => call<ProductCreative>(`/${id}/creatives/${cid}/duplicate`, json('POST', { name })),
  uploadAsset: (id: string, cid: string, file: Blob, name?: string) => call<{ asset: { kind: 'creative'; file: string; sha256: string; width: number; height: number; originalName?: string } }>(`/${id}/creatives/${cid}/assets`, upload(file, {}, name)),
  openCreative: (id: string, cid: string) => call<{ runId: string; created: boolean }>(`/${id}/creatives/${cid}/open`, { method: 'POST' }),
  saveEditorMaster: (id: string, cid: string, expectedCreativeRevision: number, expectedMasterRevision: number) => call<ProductView>(`/${id}/creatives/${cid}/save-master`, json('POST', { expectedCreativeRevision, expectedMasterRevision })),
  variationOptions: (id: string, revision?: number) => call<VariationOptions>(`/${id}/variation-options${revision ? `?revision=${revision}` : ''}`),
  addVariationProduct: (id: string, file: Blob, kind: 'product' | 'character' = 'product') => call<{ choice: { ref: string; label: string; file: string; kind: 'product' | 'character' }; background: string; note?: string }>(`/${id}/variation-products`, upload(file, { kind })),
  startVariations: (id: string, input: VariationStart) => call<VariationJob>(`/${id}/variations`, json('POST', input)),
  /** The chosen variation sent to decomposition: saved as a creative, then a run of its own layers (local, free). */
  /** The generation instructions and the decomposition plan; the person's edit of the instructions (or written again). */
  brief: (id: string) => call<TemplateBrief>(`/${id}/brief`),
  editBrief: (id: string, body: { expectedRevision: number; brief?: Partial<ProductGenerationBrief>; derive?: boolean }) => call<TemplateBrief & { template: ProductView }>(`/${id}/brief`, json('PUT', body)),
  /** "Decompose & Edit": the variation made into a template of its own (the same decomposition steps as an upload). */
  variationTemplate: (id: string, jid: string, n: number) => call<{ templateId: string }>(`/${id}/variations/${jid}/results/${n}/template`, { method: 'POST' }),
  decomposeVariation: (id: string, jid: string, n: number) => call<{ templateId: string }>(`/${id}/variations/${jid}/results/${n}/decomposition`, { method: 'POST' }),
  variations: (id: string) => call<{ jobs: { id: string; createdAt: string; status: string; revision: number; results: number; saved: number }[] }>(`/${id}/variations`),
  variation: (id: string, jid: string) => call<VariationJob>(`/${id}/variations/${jid}`),
  saveVariation: (id: string, jid: string, n: number) => call<ProductCreative>(`/${id}/variations/${jid}/results/${n}/save`, { method: 'POST' }),
  /** Continue a paused or stopped job: one approval for every image it still needs (`retry`: also earlier failed or uncertain ones). */
  resumeVariations: (id: string, jid: string, input: { approveImages: number; approveProductsUsd: number; retry: boolean; approveLegacyRecovery?: boolean; index?: number }) => call<VariationJob>(`/${id}/variations/${jid}/resume`, json('POST', input)),
  /** Stop: nothing new is sent; requests already sent finish and are kept. */
  cancelVariations: (id: string, jid: string) => call<VariationJob>(`/${id}/variations/${jid}/cancel`, { method: 'POST' }),
  regenerate: (id: string, jid: string, n: number, ai = false, approveArtworkUsd?: number, approveProductsUsd?: number) => call<VariationJob>(`/${id}/variations/${jid}/results/${n}/regenerate`, json('POST', { ai, approveProductsUsd, ...(approveArtworkUsd ? { approveArtworkUsd } : {}) })),
  removeVariation: (id: string, jid: string, n: number) => call<VariationJob>(`/${id}/variations/${jid}/results/${n}`, { method: 'DELETE' }),
  // Reuse Template studio (separate from variations).
  reuseDrafts: (id: string) => call<{ drafts: ReuseDraftSummary[] }>(`/${id}/reuse`),
  createReuseDraft: (id: string, input: { revision?: number; name?: string; simple?: boolean } = {}) => call<ReuseDraft>(`/${id}/reuse`, json('POST', input)),
  reuseDraft: (id: string, did: string) => call<ReuseStudioView>(`/${id}/reuse/${did}`),
  updateReuseDraft: (id: string, did: string, input: ReuseDraftChange) => call<ReuseDraft>(`/${id}/reuse/${did}`, json('PUT', input)),
  reuseUpload: (id: string, did: string, file: Blob, fields: { kind: 'product' | 'character' | 'logo'; target?: string; label?: string; category?: string; expectedRevision: number }, name?: string) =>
    call<{ draft: ReuseDraft; note?: string }>(`/${id}/reuse/${did}/uploads`, upload(file, Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])), name)),
  reusePreview: (id: string, did: string, ratio: ReuseAspectRatio) => call<ReusePreview>(`/${id}/reuse/${did}/preview?ratio=${ratio.replace(':', 'x')}`),
  reuseGenerate: (id: string, did: string, ratios?: ReuseAspectRatio[]) => call<ReuseDraft>(`/${id}/reuse/${did}/generate`, json('POST', { ratios })),
  reusePlaceWithAi: (id: string, did: string, input: { ratios?: ReuseAspectRatio[]; approveUsd: number }) => call<ReuseDraft>(`/${id}/reuse/${did}/placement`, json('POST', input)),
  reuseSave: (id: string, did: string, ratios?: ReuseAspectRatio[]) => call<ReuseDraft>(`/${id}/reuse/${did}/save`, json('POST', { ratios })),
  reuseOpen: (id: string, did: string, ratio: ReuseAspectRatio) => call<{ runId: string; creativeId: string }>(`/${id}/reuse/${did}/outputs/${ratio.replace(':', 'x')}/open`, { method: 'POST' }),
  reuseDecompose: (id: string, did: string, ratio: ReuseAspectRatio) => call<{ templateId: string; creativeId: string; reused?: boolean }>(`/${id}/reuse/${did}/outputs/${ratio.replace(':', 'x')}/decomposition`, { method: 'POST' }),
};

export interface ReuseDraftSummary { id: string; name: string; templateRevision: number; revision: number; updatedAt: string; simple?: boolean; products: number; ratios: ReuseAspectRatio[]; saved: number; preview?: string }
export interface ReuseStudioView {
  draft: ReuseDraft; sourceIssues: string[]; canvas: { width: number; height: number }; stageFound: boolean;
  texts: { groupId: string; label: string; category: string; text: string; style?: CreativeTextStyle }[];
  logos: { id: string; label: string; category: string; file: string }[];
  formats: { ratio: ReuseAspectRatio; label: string; canvas: { width: number; height: number }; method: 'template' | 'slice' | 'mirror-extend'; note?: string }[];
  /** `slots`: the template's own product places (as many products or fewer stand in them, never arranged anew). */
  placement: { ai: boolean; model: string; offline: boolean; costUsd: number; slots?: number }; knownCategories: string[];
}
export interface ReuseDraftChange {
  expectedRevision: number; name?: string; ratios?: ReuseAspectRatio[]; placement?: { mode?: 'original' | 'geometry' | 'ai'; keepStands?: boolean; hero?: string | null; variant?: number };
  items?: { id: string; included?: boolean; hidden?: boolean; removed?: boolean; order?: number; label?: string; category?: string; restore?: boolean }[];
  texts?: Record<string, ReuseTextEdit | null>; logos?: Record<string, { hidden?: boolean; restore?: boolean }>;
  overrides?: Partial<Record<ReuseAspectRatio, Record<string, ReuseOverride | null> | null>>;
}
export interface ReusePreview { ratio: ReuseAspectRatio; creative: ProductCreative; mode: 'original' | 'geometry' | 'ai'; frame: { method: string; canvas: { width: number; height: number }; note?: string; excluded: string[] }; checks: { status: 'ready' | 'needs-review' | 'failed'; issues: ProductVariationCheck[] }; notes: string[] }

