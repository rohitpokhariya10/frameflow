/**
 * Template Studio: the template creation → image generation flow ported from the Generator (Poster Studio) app. Data the
 * server and the browser both need: output formats, campaign copy fields, occasions, generation modes, and the shapes of
 * the API's answers. Behaviour lives on the server (server/src/templateStudio); nothing here calls a provider.
 */
import { CREATIVE_DIRECTIONS } from './creativeTemplates/creativeDirections.js';

/**
 * Output formats (Generator compose/formats.ts). GPT Image 2 accepts any size whose sides are multiples of 16, so each
 * format is generated at (or within a few pixels of) its own aspect ratio. `width`×`height` is the final export size;
 * `providerSize` is what the image model is asked for. The two are kept apart and every crop or scale is recorded.
 */
export interface StudioFormat { id: string; label: string; ratio: string; width: number; height: number; providerSize: string }
export const STUDIO_FORMATS: readonly StudioFormat[] = [
  { id: 'portrait-4-5', label: 'Portrait 4:5 (Instagram feed)', ratio: '4:5', width: 1080, height: 1350, providerSize: '1024x1280' },
  { id: 'square', label: 'Square 1:1', ratio: '1:1', width: 1080, height: 1080, providerSize: '1024x1024' },
  { id: 'story-9-16', label: 'Story 9:16', ratio: '9:16', width: 1080, height: 1920, providerSize: '864x1536' },
  { id: 'portrait-2-3', label: 'Portrait 2:3', ratio: '2:3', width: 1080, height: 1620, providerSize: '1024x1536' },
  { id: 'a4-portrait', label: 'A4 portrait (print draft)', ratio: 'A4', width: 1240, height: 1754, providerSize: '1024x1456' },
  { id: 'landscape-16-9', label: 'Landscape 16:9', ratio: '16:9', width: 1920, height: 1080, providerSize: '1536x864' },
  { id: 'landscape-3-2', label: 'Landscape 3:2', ratio: '3:2', width: 1620, height: 1080, providerSize: '1536x1024' },
];
export const DEFAULT_STUDIO_FORMAT = 'portrait-4-5';
export const studioFormat = (id: string) => STUDIO_FORMATS.find(f => f.id === id);

/** Campaign copy (Generator compose/overlay.ts). Only filled fields are placed, exactly as typed. */
export const STUDIO_COPY_FIELDS = [
  { id: 'headline', label: 'Headline', role: 'display', placeholder: 'Upgrade your kitchen this Diwali' },
  { id: 'subheadline', label: 'Subheadline', role: 'text', placeholder: 'Smart chimneys with auto-clean' },
  { id: 'offer', label: 'Offer / price', role: 'display', placeholder: 'No-cost EMI from ₹1,999/month' },
  { id: 'body', label: 'Body text', role: 'text', placeholder: '' },
  { id: 'cta', label: 'Call to action', role: 'text', placeholder: 'Visit your nearest store' },
  { id: 'date', label: 'Date / validity', role: 'text', placeholder: 'Offer valid till 31 Oct 2026' },
  { id: 'footer', label: 'Footer / disclaimer', role: 'text', placeholder: 'T&C apply. EMI on select bank cards.' },
] as const;
export type StudioCopyField = typeof STUDIO_COPY_FIELDS[number]['id'];
export const STUDIO_COPY_LIMITS: Record<StudioCopyField, number> = { headline: 300, subheadline: 300, offer: 300, body: 1200, cta: 300, date: 300, footer: 1200 };

/** Common Indian retail occasions (Generator GenerateForm); anything else is a custom occasion. */
export const STUDIO_OCCASION_GROUPS = [
  { label: 'Festivals', options: ['Diwali', 'Dhanteras', 'Navratri', 'Dussehra', 'Durga Puja', 'Ganesh Chaturthi', 'Holi', 'Raksha Bandhan', 'Onam', 'Pongal', 'Makar Sankranti', 'Baisakhi', 'Ugadi / Gudi Padwa', 'Eid', 'Christmas', 'Akshaya Tritiya', 'Karwa Chauth'] },
  { label: 'National days', options: ['Independence Day', 'Republic Day'] },
  { label: 'Seasons and events', options: ['Wedding season', 'New Year', "Valentine's Day", "Mother's Day", "Father's Day", 'Summer', 'Monsoon', 'Back to school', 'End of season sale', 'Big sale / Black Friday', 'Store launch'] },
] as const;

/**
 * How closely a poster follows its template. Match is the default: the reference's backdrop, staging, props, camera,
 * lighting and palette are kept and only the products (and an occasion, when chosen) change. The three modes send
 * different instructions to the art director, the image model and the reviewer; a failure never switches modes.
 */
export const FIDELITY_MODES = [
  { id: 'match', label: 'Match Reference', summary: 'Same design family: keeps the backdrop, podiums and props, camera, lighting, palette and spacing. Only the products and occasion change.' },
  { id: 'adapt', label: 'Adapt Reference', summary: 'Keeps the recognisable visual language and palette, but recomposes the scene around the new products.' },
  { id: 'explore', label: 'Explore Creatives', summary: 'Uses the template as loose inspiration for new environments and staging. Pick a FrameFlow creative direction or let the AI decide.' },
] as const;
export type FidelityMode = typeof FIDELITY_MODES[number]['id'];
export interface StudioReferenceProduct {
  id: string; label: string; identity: string;
  box: { x: number; y: number; width: number; height: number };
  depth: number; confidence: number; overlaps: string[]; transparent: boolean;
  shadows: string; reflections: string;
}
export interface StudioReferenceScene {
  referenceId: string; products: StudioReferenceProduct[]; confidence: number;
  camera: string; lighting: string; supportingObjects: string[]; background: string;
  textRegions: { kind: 'text' | 'logo'; description: string; box: { x: number; y: number; width: number; height: number } }[];
}
export interface StudioProductAction { productId: string; action: 'keep' | 'replace' | 'remove'; replacementAssetId?: string }
export const DEFAULT_FIDELITY_MODE: FidelityMode = 'match';

/** Explore mode can start from one of FrameFlow's twelve creative directions (creativeTemplates/creativeDirections.ts). */
export const STUDIO_CREATIVE_DIRECTIONS = CREATIVE_DIRECTIONS.map(d => ({
  id: d.id, title: d.title,
  text: `${d.style}. Staging: ${d.staging}. Environment: ${d.environment}. Surface: ${d.surface}. Props: ${d.props.join(', ')}. Palette: ${d.palette.join(', ')}. Lighting: ${d.lighting}. Mood: ${d.mood}.`,
}));
export const studioCreativeDirection = (id: string | null | undefined) => STUDIO_CREATIVE_DIRECTIONS.find(d => d.id === id);

export const STUDIO_IMAGE_QUALITIES = ['low', 'medium', 'high'] as const;
export type StudioImageQuality = typeof STUDIO_IMAGE_QUALITIES[number];
export const STUDIO_MAX_PRODUCTS = 6;
export const STUDIO_MAX_REFERENCES = 3;

// ---------------------------------------------------------------------------------------------------------------------
// API answers
// ---------------------------------------------------------------------------------------------------------------------

/** Money as recorded: micro-USD (provider-native) and its rupee display at the stated rate. */
export interface StudioMoney { microUsd: number; usd: string; inr: string }
export interface StudioFx { rate: number; source: 'configured'; variable: string; pricingVersion: string; note: string }

export type StudioAssetRole = 'reference' | 'subject' | 'logo' | 'cutout' | 'generated_scene' | 'layout_guide' | 'export';
export interface StudioAsset {
  id: string; role: StudioAssetRole; mimeType: string; width: number; height: number; bytes: number; hasAlpha: boolean;
  sourceFilename: string | null; label: string | null; sha256: string; createdAt: string;
  urls: { thumb: string; normalised: string; original: string };
}

export interface StudioStyleProfile {
  /** Absent in old profiles: reuse is safe, editing requires fresh analysis. First reference owns the products. */
  referenceScenes?: StudioReferenceScene[];
  summary: string; visualMedium: string; campaignCharacter: string; visualHierarchy: string;
  palette: { colors: { hex: string; role: string; prominence: 'dominant' | 'secondary' | 'accent' }[]; allowedVariation: string };
  typography: { headlineCharacter: string; bodyCharacter: string; casing: string; suggestedHeadlineFamily: string; suggestedBodyFamily: string; identificationConfidence: number };
  layout: { density: string; negativeSpace: string; alignment: string; focalHierarchy: string; textPlacement: string; typicalRelationships: string };
  composition?: {
    arrangement: string; staging: string; heroPlacement: string; subjectGroupWidth: number; subjectGroupHeight: number; subjectGroupCenterX: number; subjectGroupCenterY: number;
    headroom: number; footroom: number; minEdgeMargin: number; overlap: string; visibleSupports: boolean;
    backdrop: { description: string; x: number; y: number; width: number; height: number; productRelation: string; textOnlyFeatures: string | null } | null;
  };
  lighting: string | null; materials: string | null; backgroundTreatment: string;
  sharedInvariants: string[]; referenceSpecificMotifs: { referenceId: string; motif: string }[]; allowedVariation: string[]; excludedDirections: string[];
  referenceClusters: { id: string; label: string; description: string; referenceIds: string[] }[]; defaultClusterId: string;
  contentToReplace: { referenceId: string; kind: string; description: string }[];
  evidence: { rule: string; referenceIds: string[]; confidence: number }[]; overallConfidence: number; singleReferenceCaveat: string | null;
}

export interface StudioJobStage { stage: string; label: string; status: 'running' | 'done' | 'failed' | 'outcome_unknown'; paid: boolean; durationMs: number | null }
export interface StudioJob {
  id: string; kind: string; state: string; terminal: boolean; currentStage: string | null; cancelRequested: boolean; attemptCount: number;
  error: { code: string; message: string; stage?: string; detail?: string; requestId?: string | null } | null; result: unknown;
  createdAt: string; finishedAt: string | null; stages: StudioJobStage[];
  cost: StudioCostSummary;
}

export interface StudioTemplate {
  id: string; name: string; guidance: string | null; status: 'draft' | 'analysing' | 'ready' | 'failed';
  brandKit: { id: string; name: string } | null;
  references: { assetId: string; refId: string; thumb: string; full: string; width: number; height: number }[];
  profile: { id: string; version: number; model: string; promptVersion: string; createdAt: string; selectedClusterId: string | null; cached: boolean; data: StudioStyleProfile } | null;
  versions: { id: string; version: number; createdAt: string }[];
  latestJob: { id: string; state: string; error: { code: string; message: string } | null; createdAt: string } | null;
  analysisCost: StudioCostSummary;
  posterCount: number;
  createdAt: string; updatedAt: string;
}

/** One paid (or skipped) call as recorded in the usage ledger. */
export interface StudioCostLine {
  stage: string; label: string; model: string; providerRequestId: string | null;
  /** usage_derived: computed from the provider's reported token usage; estimate_only: no usable usage, the reserved upper bound is shown; */
  status: 'usage_derived' | 'estimate_only';
  estimated: StudioMoney | null; recorded: StudioMoney | null; at: string;
}
export interface StudioCostSummary {
  reserved?: StudioMoney;
  /** Sum of usage-derived costs plus reserved estimates where usage is unknown (never ₹0 for an unknown call). */
  total: StudioMoney; usageDerived: StudioMoney; estimatedOnly: StudioMoney;
  calls: number; unknownCalls: number; lines: StudioCostLine[]; fx: StudioFx; rateCardVersion: string;
}

export interface StudioEstimateLine { stage: string; model: string; cost: StudioMoney; cached: boolean; note?: string; assumptions: string[] }
export interface StudioEstimate { label: string; lines: StudioEstimateLine[]; total: StudioMoney; cap: StudioMoney; withinCap: boolean; quality: StudioImageQuality; providerSize: string; fx: StudioFx; rateCardVersion: string; note: string;
  daily?: { cap: StudioMoney; used: StudioMoney; held: StudioMoney; remaining: StudioMoney; fits: boolean; resets: string };
  localReuse?: boolean; segmentation?: StudioMoney; blockedReason?: string | null;
}

export interface StudioOverlayText {
  id: string; kind: 'text'; field: StudioCopyField; text: string; box: { x: number; y: number; width: number; height: number };
  align: 'left' | 'center' | 'right'; verticalAlign: 'top' | 'middle' | 'bottom'; fontFamily: string; fontWeight: number; fontSizePct: number; minFontSizePct: number;
  lineHeight: number; uppercase: boolean; color: string; plate: { color: string; opacity: number; paddingPct: number; radiusPct: number } | null; hidden: boolean;
}
export interface StudioLayoutReport {
  texts: { id: string; fontSizePx: number; lines: string[]; overflow: boolean; contrast: number | null }[];
  logo: { variantId: string | null; widthPx: number; contrast: number | null; box: { x: number; y: number; width: number; height: number } } | null;
  issues: { severity: 'info' | 'warning' | 'error'; elementId: string | null; message: string }[];
}

export interface StudioReviewCheck { id: string; label: string; status: 'pass' | 'warn' | 'fail' | 'unchecked'; detail: string }
export interface StudioPoster {
  provenance?: 'reference_reuse' | 'ai_generated';
  productActions?: StudioProductAction[];
  id: string; campaignId: string; jobId: string | null; createdAt: string; updatedAt: string;
  reviewStatus: 'pending' | 'ok' | 'needs_review'; approvedAt: string | null;
  template: { id: string; name: string; references: { assetId: string; thumb: string; full: string }[]; profileVersion: number | null };
  format: { id: string; label: string; ratio: string; exportWidth: number; exportHeight: number; providerSize: string; note: string } | null;
  fidelityMode: FidelityMode; occasion: string | null; direction: string | null; quality: string; preserveProductPixels: boolean;
  copy: Partial<Record<StudioCopyField, string>>;
  products: { subjectId: string; assetId: string; name: string; thumb: string; full: string; hasAlpha: boolean }[];
  canvas: { width: number; height: number }; crop: { x: number; y: number; width: number; height: number };
  texts: StudioOverlayText[]; logo: { corner: string; widthPct: number; variant: string; partnerLogoIds: string[]; hidden: boolean } | null;
  report: StudioLayoutReport | null; notes: string[];
  review: {
    summary: string | null; hardFailures: { code: string; description: string }[]; scores: Record<string, number | null> | null;
    issues: { category: string; description: string; severity: string; remedy: string; confidence: number; advisory: boolean }[];
    referenceMatch: { score: number; sameBackground: boolean; sameStagingAndProps: boolean; sameCameraAndFraming: boolean; sameLighting: boolean; samePalette: boolean; differences: string[] } | null;
    reviewError: string | null; model: string | null; promptVersion: string | null; createdAt: string;
  } | null;
  checks: StudioReviewCheck[];
  exactProducts: { requested: boolean; applied: boolean; ok: boolean | null; detail: string } | null;
  plan: { concept: { id: string; title: string; summary: string } | null; alternatives: { id: string; title: string; summary: string }[]; rationale: string; framingNotes: string[] } | null;
  generation: { model: string; quality: string; providerSize: string; prompt: string; latencyMs: number | null; promptVersion: string; references: { index: number; role: string; label: string }[] } | null;
  urls: { poster: string; scene: string; rawScene: string | null; layoutGuide: string | null; download: { png: string; jpeg: string }; decompositionScene: string };
  cost: StudioCostSummary;
  decompositions: { runId: string; createdAt: string; sentWidth: number; sentHeight: number }[];
}

export interface StudioHistoryItem {
  jobId: string; kind: string; state: string; createdAt: string; error: { message: string } | null;
  templateName: string | null; headline: string | null; fidelityMode: FidelityMode | null; formatLabel: string | null;
  /** The template's first reference, for entries without a poster (analyses, runs in progress or failed). */
  templateThumb: string | null;
  poster: { id: string; reviewStatus: string; thumb: string; decomposed: boolean } | null;
  cost: StudioCostSummary;
}

export interface StudioBrandColour { name: string; hex: string | null; cmyk?: string | null; confirmed: boolean; note?: string }
export interface StudioBrandKit {
  id: string; name: string; revision: number; sourceNote: string | null; updatedAt: string;
  rules: {
    schema: string;
    palette: { core: StudioBrandColour[]; accent: StudioBrandColour[]; extended: StudioBrandColour[]; neutrals: StudioBrandColour[]; rules: string[] };
    logo: { allowedCorners: string[]; allowedColours: string[]; minWidth: { digitalPx: number; printMm: number | null }; requireCleanBackground: boolean; partnerLockup: { gapUnits: number; separator: string | null; equalVisualWeight: boolean } | null; [key: string]: unknown };
    typography: { display: { family: string; usage: string }; text: { family: string; usage: string }; notes: string[] };
    aesthetic: { summary: string; principles: { name: string; description: string }[]; keywords: string[]; latitude: string };
    openQuestions: string[]; [key: string]: unknown;
  };
  warnings: { path: string; message: string }[];
  logos: { id: string; kind: 'primary' | 'partner'; name: string; colourName: string | null; asset: StudioAsset }[];
  fonts: { id: string; role: string; family: string; weight: number; style: string; format: string; sourceFilename: string | null; licenceConfirmed: boolean }[];
}

/** A generated poster sent to FrameFlow's own decomposition: the run it became, and how the image was prepared. */
export interface StudioDecompositionLink { id: string; posterId: string; runId: string; createdAt: string; sentWidth: number; sentHeight: number; canvasWidth: number; canvasHeight: number; note: string }

/** What the editor needs to restore the campaign copy and logos as native elements over the decomposed layers. */
export interface StudioEditorOverlay {
  products?: { id: string; url: string; box: { x: number; y: number; width: number; height: number } }[];
  posterId: string; canvas: { width: number; height: number };
  texts: (StudioOverlayText & { renderedFontSizePct: number | null; lines: string[] })[];
  logo: { url: string; box: { x: number; y: number; width: number; height: number } } | null;
}
