/**
 * Template Studio's records on disk: the Generator's Prisma models, kept as JSON beside FrameFlow's other experiment data
 * instead of a second database engine.
 *
 *   <root>/db/<collection>.json   one file per collection, rewritten atomically (temporary file, then rename)
 *   <root>/files/…                 uploaded and generated images and fonts (storage.ts, path-traversal guarded)
 *
 * One process, one user: every change is applied in memory and written to disk before the call returns, and nothing
 * awaits between a read and its write, so a check-then-write (budget reservations, idempotency keys) is atomic.
 * Money is integer micro-USD, as in the Generator. Dates are ISO strings.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { CustomTypography, LayoutValidation, StudioProductAction, StudioReferenceScene, StyleVariationRequest, StylePreset, TypographyMode, VariantLayout, VariationEvent, VariationProvenance, VariationReview, VariationSource, VariationStatus } from '@frameflow/shared';
import { ARTIFACTS_DIR } from '../deployment.js';

export interface ReferencePolicy {
  primaryAssetId: string; scene: StudioReferenceScene | null;
  actions: StudioProductAction[]; backgroundOnly: boolean; text: 'keep' | 'remove'; localReuse: boolean;
}

export const DEFAULT_STUDIO_DIR = resolve(ARTIFACTS_DIR, 'template-studio');
export const STORE_SCHEMA = 'template-studio-db/1';

export const newId = (prefix: string) => `${prefix}_${randomBytes(10).toString('hex')}`;
const ID = /^[a-z]{2,4}_[a-f0-9]{20}$/;
export const validId = (id: unknown): id is string => typeof id === 'string' && ID.test(id);
export const now = () => new Date().toISOString();

export type AssetRole = 'reference' | 'subject' | 'logo' | 'cutout' | 'generated_scene' | 'layout_guide' | 'export';
export interface AssetRecord {
  id: string; role: AssetRole; sha256: string; mimeType: string; width: number; height: number; bytes: number; hasAlpha: boolean;
  sourceFilename: string | null; label: string | null;
  /** Relative to the files root; produced by this app only, never taken from a request. */
  originalPath: string; normalisedPath: string; analysisPath: string; thumbPath: string;
  createdAt: string;
}
export interface BrandKitRecord { id: string; name: string; rulesSchema: string; rules: unknown; revision: number; sourceNote: string | null; createdAt: string; updatedAt: string }
export interface BrandKitLogoRecord { id: string; brandKitId: string; assetId: string; kind: 'primary' | 'partner'; name: string; colourName: string | null; createdAt: string }
export interface BrandFontRecord {
  id: string; brandKitId: string; role: 'display' | 'text'; family: string; weight: number; style: 'normal' | 'italic'; format: 'ttf' | 'otf';
  sha256: string; bytes: number; path: string; sourceFilename: string | null; licenceConfirmed: boolean; createdAt: string;
}
export interface TemplateRecord {
  id: string; name: string; creatorGuidance: string | null; status: 'draft' | 'analysing' | 'ready' | 'failed';
  currentProfileVersionId: string | null; thumbnailAssetId: string | null; brandKitId: string | null;
  references: { assetId: string; position: number }[]; createdAt: string; updatedAt: string;
}
export interface StyleProfileVersionRecord {
  id: string; templateId: string; version: number; schemaVersion: string; analysisModel: string; promptVersion: string;
  referenceHashes: Record<string, string>; cacheKey: string; profile: unknown; selectedClusterId: string | null;
  /** True when the profile was reused from an identical earlier analysis (no paid call). */
  cached: boolean; createdAt: string;
}
export interface SubjectRecord {
  id: string; primaryAssetId: string; name: string; subjectType: string | null; isSku: boolean;
  analysis: unknown | null; analysisModel: string | null; analysisCacheKey: string | null; analysisConfidence: number | null; createdAt: string; updatedAt: string;
}
export interface CampaignRecord {
  referencePolicy?: ReferencePolicy;
  id: string; templateId: string; profileVersionId: string; copy: Record<string, string>; partnerLogoIds: string[]; subjectIds: string[];
  formatId: string; imageQuality: 'low' | 'medium' | 'high'; outputWidth: number; outputHeight: number; direction: string | null; occasion: string | null;
  creativeDirectionId: string | null; fidelityMode: 'match' | 'adapt' | 'explore'; preserveProductPixels: boolean;
  brandKitId: string | null; brandSnapshot: unknown | null; createdAt: string;
}
export interface JobErrorInfo { code: string; message: string; stage?: string; detail?: string; requestId?: string | null }
export interface JobRecord {
  id: string; kind: string; idempotencyKey: string; inputSnapshot: unknown; state: string; currentStage: string | null;
  leaseOwner: string | null; leaseExpiresAt: string | null; attemptCount: number; cancelRequested: boolean;
  error: JobErrorInfo | null; result: unknown | null; campaignId: string | null; createdAt: string; updatedAt: string; finishedAt: string | null;
}
export interface JobStageRecord {
  id: string; jobId: string; stage: string; status: 'running' | 'done' | 'failed' | 'outcome_unknown'; paid: boolean; output: unknown | null;
  startedAt: string; completedAt: string | null; durationMs: number | null;
}
export interface ConceptPlanRecord {
  id: string; jobId: string; schemaVersion: string; model: string; promptVersion: string; concepts: unknown; chosenConceptId: string;
  selectionRationale: string; scenePlan: unknown; overlayPlan: unknown; createdAt: string;
}
export interface GenerationAttemptRecord {
  id: string; jobId: string; model: string; quality: string; requestedSize: string; providerSize: string; promptVersion: string; prompt: string;
  referenceManifest: unknown; providerRequestId: string | null; sceneAssetId: string | null; layoutGuideAssetId: string | null; latencyMs: number | null;
  usage: unknown | null; costStatus: 'estimated' | 'usage_derived' | 'unknown'; outcome: 'pending' | 'succeeded' | 'failed' | 'outcome_unknown';
  error: { code: string; message: string } | null; createdAt: string;
}
export interface PosterRecord {
  provenance?: 'reference_reuse' | 'ai_generated';
  decompositionAssetId?: string;
  productLayers?: { productId: string; assetId: string; box: { x: number; y: number; width: number; height: number } }[];
  expectedProductCount?: number;
  id: string; campaignId: string; jobId: string | null;
  /** The text-free scene the poster is built on (with exact product pixels composited, when that was asked and worked). */
  sceneAssetId: string;
  /** The image model's own scene when exact product pixels replaced its products; null otherwise. */
  rawSceneAssetId: string | null;
  exactProducts: { requested: boolean; applied: boolean; ok: boolean | null; detail: string } | null;
  overlay: unknown; layoutReport: unknown | null; reviewStatus: 'pending' | 'ok' | 'needs_review'; approvedAt: string | null;
  createdAt: string; updatedAt: string;
}
export interface ReviewRecord {
  id: string; posterId: string; jobId: string | null; model: string | null; promptVersion: string | null; fidelityMode: string;
  hardFailures: { code: string; description: string }[]; scores: unknown | null; issues: unknown; referenceMatch: unknown | null; createdAt: string;
}
export interface UsageLedgerRecord {
  response?: { text: string | null; refusal: string | null; incompleteReason: string | null };
  id: string; jobId: string | null; stage: string; model: string; providerRequestId: string | null; rawUsage: unknown | null;
  rateCardVersion: string; estimatedMicroUsd: number | null; usageDerivedMicroUsd: number | null; costUnknown: boolean; createdAt: string;
}
export interface BudgetReservationRecord {
  id: string; jobId: string; stage: string; microUsd: number; actualMicroUsd: number | null; status: 'held' | 'settled' | 'released'; createdAt: string; updatedAt: string;
}
/** A poster handed to FrameFlow's decomposition: the run it started and how the image sent was prepared. */
export interface DecompositionLinkRecord {
  id: string; posterId: string; runId: string; sceneAssetId: string; sentWidth: number; sentHeight: number;
  canvasWidth: number; canvasHeight: number; crop: { x: number; y: number; width: number; height: number }; createdAt: string;
}
export interface WorkerHeartbeatRecord { id: string; pid: number; startedAt: string; lastSeenAt: string }
/**
 * One style variation of a protected template (shared styleVariations.ts). Its artwork is a Studio asset; its layout holds
 * VARIANT coordinates, never the template's original ones. `status` is the variation's own (set when its layout is made);
 * while its job runs or after it failed, the job's state is shown instead (variations/service.ts).
 */
export interface StyleVariationRecord {
  schemaVersion: 1;
  id: string; batchId: string; index: number; templateId: string; templateName: string;
  preset: StylePreset; customInstructions: string | null; source: VariationSource; provenance: VariationProvenance;
  status: VariationStatus; error: { code: string; message: string; requestId?: string | null } | null;
  /** The artwork at the template's canvas size; the model's own output before fitting; the wordless guide it was given. */
  artworkAssetId: string | null; rawArtworkAssetId: string | null; guideAssetId: string | null;
  generation: null | { model: string; providerSize: string; quality: 'low' | 'medium' | 'high'; promptVersion: string; prompt: string; cacheKey: string; requestId: string | null; cachedFrom: string | null };
  artworkCheck: null | { status: 'clean' | 'text_found' | 'not_run'; words: { text: string; confidence: number }[]; note: string };
  layout: VariantLayout; validation: LayoutValidation;
  typographyMode: TypographyMode; customTypography: CustomTypography | null; confirmedProtectedEdits: string[];
  review: { status: VariationReview; history: VariationEvent[] };
  estimateMicroUsd: number; jobId: string | null;
  parent: { templateId: string; baseSha256: string; analysisRevision: number; elementsRevision: number; variationId: string | null };
  children: string[];
  createdAt: string; updatedAt: string;
}
/** One confirmed request for variations: its idempotency key, what was asked and the amount the administrator confirmed. */
export interface VariationBatchRecord { id: string; templateId: string; idempotencyKey: string; request: StyleVariationRequest; estimateMicroUsd: number; confirmedMicroUsd: number | null; variationIds: string[]; createdAt: string }

/** One collection: an in-memory map backed by one JSON file. */
export class Collection<T extends { id: string }> {
  private rows = new Map<string, T>();
  constructor(private readonly file: string) {
    if (!existsSync(file)) return;
    const data = JSON.parse(readFileSync(file, 'utf8')) as T[];
    for (const row of data) this.rows.set(row.id, row);
  }
  get(id: string | null | undefined): T | undefined { return id ? this.rows.get(id) : undefined; }
  require(id: string | null | undefined, what = 'Record'): T {
    const row = this.get(id);
    if (!row) throw new Error(`${what} ${id ?? '(none)'} not found.`);
    return row;
  }
  all(): T[] { return [...this.rows.values()]; }
  find(match: (row: T) => boolean): T | undefined { for (const row of this.rows.values()) if (match(row)) return row; return undefined; }
  filter(match: (row: T) => boolean): T[] { return this.all().filter(match); }
  count(match?: (row: T) => boolean): number { return match ? this.filter(match).length : this.rows.size; }
  insert(row: T): T {
    if (this.rows.has(row.id)) throw new Error(`Duplicate id ${row.id}.`);
    this.rows.set(row.id, structuredClone(row)); this.save();
    return structuredClone(row);
  }
  /** Change one record. `change` returns the fields to set, or edits a copy in place. */
  update(id: string, change: Partial<T> | ((row: T) => Partial<T> | void)): T {
    const current = this.rows.get(id);
    if (!current) throw new Error(`Record ${id} not found.`);
    const copy = structuredClone(current);
    const patch = typeof change === 'function' ? change(copy) : change;
    const next = { ...copy, ...(patch ?? {}), id } as T;
    this.rows.set(id, next); this.save();
    return structuredClone(next);
  }
  /** Change every matching record in one write; returns how many changed. */
  updateMany(match: (row: T) => boolean, change: (row: T) => Partial<T>): number {
    let n = 0;
    for (const [id, row] of this.rows) if (match(row)) { this.rows.set(id, { ...row, ...change(structuredClone(row)), id }); n++; }
    if (n) this.save();
    return n;
  }
  remove(id: string) { if (this.rows.delete(id)) this.save(); }
  private save() {
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
    writeFileSync(temp, JSON.stringify([...this.rows.values()]));
    renameSync(temp, this.file);
  }
}

export interface StudioStore {
  root: string; filesDir: string;
  assets: Collection<AssetRecord>; brandKits: Collection<BrandKitRecord>; brandKitLogos: Collection<BrandKitLogoRecord>; brandFonts: Collection<BrandFontRecord>;
  templates: Collection<TemplateRecord>; profiles: Collection<StyleProfileVersionRecord>; subjects: Collection<SubjectRecord>; campaigns: Collection<CampaignRecord>;
  jobs: Collection<JobRecord>; stages: Collection<JobStageRecord>; conceptPlans: Collection<ConceptPlanRecord>; attempts: Collection<GenerationAttemptRecord>;
  posters: Collection<PosterRecord>; reviews: Collection<ReviewRecord>; usage: Collection<UsageLedgerRecord>; reservations: Collection<BudgetReservationRecord>;
  decompositions: Collection<DecompositionLinkRecord>; heartbeats: Collection<WorkerHeartbeatRecord>;
  /** Added after the first release: absent files are empty collections, so older stores open unchanged. */
  styleVariations: Collection<StyleVariationRecord>; variationBatches: Collection<VariationBatchRecord>;
}

/** Open (or create) the store under `root`. Refuses a store written by a newer, unknown schema. */
export function openStudioStore(root = DEFAULT_STUDIO_DIR): StudioStore {
  const db = join(root, 'db'), meta = join(db, 'meta.json');
  mkdirSync(db, { recursive: true });
  if (existsSync(meta)) {
    const schema = (JSON.parse(readFileSync(meta, 'utf8')) as { schema?: string }).schema;
    if (schema !== STORE_SCHEMA) throw new Error(`Template Studio data at ${root} uses schema ${schema}; this server reads ${STORE_SCHEMA}.`);
  } else writeFileSync(meta, JSON.stringify({ schema: STORE_SCHEMA, createdAt: now() }));
  const c = <T extends { id: string }>(name: string) => new Collection<T>(join(db, `${name}.json`));
  return {
    root, filesDir: join(root, 'files'),
    assets: c('assets'), brandKits: c('brand-kits'), brandKitLogos: c('brand-kit-logos'), brandFonts: c('brand-fonts'),
    templates: c('templates'), profiles: c('style-profiles'), subjects: c('subjects'), campaigns: c('campaigns'),
    jobs: c('jobs'), stages: c('job-stages'), conceptPlans: c('concept-plans'), attempts: c('generation-attempts'),
    posters: c('posters'), reviews: c('reviews'), usage: c('usage-ledger'), reservations: c('budget-reservations'),
    decompositions: c('decomposition-links'), heartbeats: c('worker-heartbeats'),
    styleVariations: c('style-variations'), variationBatches: c('style-variation-batches'),
  };
}
