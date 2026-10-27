/**
 * The client of style variations (server/src/templateStudio/variations/), on Template Studio's API. Only `create` can
 * spend anything, and only with a confirmation that names the exact estimate the administrator was shown.
 */
import type { CustomTypography, StyleVariationRequest, StyleVariationView, StylePreset, StudioFx, StudioImageQuality, TypographyMode, VariationEstimate, VariationProvenance } from '@frameflow/shared';
import { studioApi } from '../templateStudio/api';

export interface VariationMeta {
  presets: StylePreset[]; defaults: string[]; typographyModes: Record<TypographyMode, { label: string; detail: string }>;
  provenance: { labels: Record<VariationProvenance, string>; details: Record<VariationProvenance, string> };
  limits: { maxCount: number; defaultCount: number; maxCustomInstructions: number; maxPresetName: number };
  quality: StudioImageQuality; qualities: StudioImageQuality[]; model: string; fx: StudioFx;
}
export type Readiness = { ready: boolean; code?: string; reason?: string };
export type LayoutChange = {
  typographyMode?: TypographyMode; customTypography?: CustomTypography | null;
  words?: { wordId: string; text?: string; hidden?: boolean }[]; logos?: { slotId: string; hidden?: boolean }[]; confirmProtectedEdits?: string[];
};
export const variationsApi = {
  meta: () => studioApi.get<VariationMeta>('/variations/meta'),
  list: (templateId: string) => studioApi.get<{ readiness: Readiness; variations: StyleVariationView[] }>(`/protected/${templateId}/variations`),
  /** Free: what the request would do and cost; nothing is started. */
  estimate: (templateId: string, request: StyleVariationRequest) => studioApi.post<VariationEstimate>(`/protected/${templateId}/variations/estimate`, { request }),
  /** Paid when the estimate lists paid requests: `confirm` must carry the exact amount shown. */
  create: (templateId: string, body: { idempotencyKey: string; request: StyleVariationRequest; confirm?: { paid: boolean; estimateMicroUsd: number } }) =>
    studioApi.post<{ batch: { id: string; variationIds: string[]; existing: boolean }; variations: StyleVariationView[] }>(`/protected/${templateId}/variations`, body),
  get: (id: string) => studioApi.get<{ variation: StyleVariationView }>(`/variations/${id}`).then(r => r.variation),
  /** Free: typography, word and logo changes in the variation's own coordinates. Never new artwork. */
  layout: (id: string, change: LayoutChange) => studioApi.patch<{ variation: StyleVariationView }>(`/variations/${id}/layout`, change).then(r => r.variation),
  review: (id: string, action: 'select' | 'reject' | 'save' | 'reopen') => studioApi.post<{ variation: StyleVariationView }>(`/variations/${id}/review`, { action }).then(r => r.variation),
  duplicate: (id: string) => studioApi.post<{ variation: StyleVariationView }>(`/variations/${id}/duplicate`).then(r => r.variation),
};
export const terminalVariation = (v: Pick<StyleVariationView, 'status'>) => ['ready', 'needs_review', 'failed', 'cancelled'].includes(v.status);
