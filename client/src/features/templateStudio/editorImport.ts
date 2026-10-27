/**
 * Template Studio → FrameFlow editor, at the boundary only. FrameFlow imports the decomposed layers exactly as it always
 * does (openResultInEditor → experimentToVariant); for a run that came from a generated poster, the new design is then
 * given the poster's campaign copy as native, editable text elements and its approved logo lock-up as one image layer,
 * above the layers. Nothing of the import or the decomposition changes, and a design that does not validate is opened
 * without the additions rather than not at all.
 */
import { TEMPLATE_LIMITS, TEXT_LIMITS, clamp, isCatalogFont, type DesignLayer, type ProjectDocument, type StudioCostSummary, type StudioEditorOverlay, type TextElement } from '@frameflow/shared';
import { isDesignVariant } from '../../lib/persistence/schema';
import { STUDIO_API } from './api';

export interface StudioRunLink {
  link: { posterId: string; runId: string; sentWidth: number; sentHeight: number; createdAt: string } | null;
  /** provenance reference_reuse: the run decomposed the template's original reference, copied unchanged (with its text and logos). */
  poster?: { id: string; headline: string | null; thumb: string; fidelityMode: string; provenance?: 'reference_reuse' | 'ai_generated' };
  template?: { id: string; name: string } | null;
  costs?: { template: StudioCostSummary | null; generation: StudioCostSummary };
}

/** The poster a FrameFlow run decomposes, if it came from Template Studio (null for every other run). */
export async function studioLinkOf(runId: string): Promise<StudioRunLink | null> {
  try {
    const response = await fetch(`${STUDIO_API}/decompositions/${encodeURIComponent(runId)}`, { cache: 'no-store' });
    if (!response.ok) return null;
    const value = await response.json() as StudioRunLink;
    return value.link ? value : null;
  } catch { return null; }
}

const ROLE: Record<string, TextElement['role']> = { headline: 'heading', subheadline: 'subheading', offer: 'offer', body: 'paragraph', cta: 'cta', date: 'date', footer: 'body' };
const LABEL: Record<string, string> = { headline: 'Headline', subheadline: 'Subheadline', offer: 'Offer', body: 'Body', cta: 'Call to action', date: 'Date', footer: 'Footer' };
const weight = (w: number): TextElement['fontWeight'] => (w >= 650 ? 700 : w >= 550 ? 600 : 400);

/** The poster's copy as editor text elements on a canvas of width × height (the poster's own boxes, scaled). */
export function overlayTexts(overlay: StudioEditorOverlay, width: number, height: number, newId: () => string): TextElement[] {
  return overlay.texts.map(t => {
    const fontSize = clamp(Math.round(((t.renderedFontSizePct ?? t.fontSizePct) / 100) * height), TEXT_LIMITS.minFontSize, TEXT_LIMITS.maxFontSize);
    return {
      id: `studio-text-${newId()}`, type: 'text', role: ROLE[t.field] ?? 'generic-text', name: `Campaign text · ${LABEL[t.field] ?? t.field}`,
      text: (t.uppercase ? t.text.toLocaleUpperCase('en-IN') : t.text).slice(0, TEXT_LIMITS.maxCharacters),
      x: t.box.x * width, y: t.box.y * height, width: clamp(t.box.width * width, TEXT_LIMITS.minWidth, TEXT_LIMITS.maxWidth), height: Math.max(1, t.box.height * height),
      fontFamily: isCatalogFont(t.fontFamily) ? t.fontFamily : 'Inter', fontSize, fontWeight: weight(t.fontWeight),
      fill: t.color, align: t.align, verticalAlign: t.verticalAlign, lineHeight: t.lineHeight, letterSpacing: 0,
      maxLines: Math.min(20, TEMPLATE_LIMITS.maxLines), overflow: 'shrink', minFontSize: Math.min(fontSize, Math.max(TEXT_LIMITS.minFontSize, (t.minFontSizePct / 100) * height)),
      ...(t.plate ? { box: { fill: t.plate.color, radius: (t.plate.radiusPct / 100) * height } } : {}),
    };
  });
}

/** The first version of `document` with the copy and logo added; the document unchanged if the result would not validate. */
export function withNativeOverlay(document: ProjectDocument, overlay: StudioEditorOverlay, logoAssetId: string | null, newId: () => string, productAssets: Record<string, string> = {}): { document: ProjectDocument; applied: boolean } {
  const [first, ...rest] = document.variants;
  const { width, height } = first.canvas;
  const logo: DesignLayer[] = overlay.logo && logoAssetId ? [{
    id: `studio-logo-${newId()}`, type: 'image', assetId: logoAssetId, name: 'Brand logo (from brand kit)', role: 'logo',
    x: overlay.logo.box.x * width, y: overlay.logo.box.y * height, width: Math.max(1, overlay.logo.box.width * width), height: Math.max(1, overlay.logo.box.height * height),
    rotation: 0, opacity: 1, visible: true, locked: false,
  }] : [];
  const products: DesignLayer[] = (overlay.products ?? []).filter(p => productAssets[p.id]).map(p => ({
    id: `studio-product-${newId()}`, type: 'image', assetId: productAssets[p.id], name: `Protected product · ${p.id}`, role: 'product',
    x: p.box.x * width, y: p.box.y * height, width: Math.max(1, p.box.width * width), height: Math.max(1, p.box.height * height),
    rotation: 0, opacity: 1, visible: true, locked: false,
  }));
  const variant = { ...first, elements: [...first.elements, ...overlayTexts(overlay, width, height, newId)], layers: [...(first.layers ?? []), ...products, ...logo] };
  if (!isDesignVariant(variant)) return { document, applied: false };
  return { document: { ...document, variants: [variant, ...rest] }, applied: true };
}

type Assets = { putAsset(id: string, blob: Blob): Promise<unknown>; deleteAsset(id: string): Promise<unknown> };

/**
 * For a run that came from a poster: fetch its copy and logo (reads of this server only), and return an `openNew` wrapper
 * that adds them to the design FrameFlow creates. `finish` removes the stored logo when no new design used it.
 */
export async function prepareStudioImport(runId: string, assets: Assets, newId: () => string = () => crypto.randomUUID()) {
  const link = await studioLinkOf(runId);
  if (!link?.link) return null;
  const response = await fetch(`${STUDIO_API}/posters/${link.link.posterId}/editor-overlay`, { cache: 'no-store' });
  if (!response.ok) return null;
  const overlay = await response.json() as StudioEditorOverlay;
  let logoAssetId: string | null = null, used = false;
  const productAssets: Record<string, string> = {};
  try {
    for (const product of overlay.products ?? []) {
      const response = await fetch(product.url, { cache: 'no-store' });
      if (!response.ok) throw new Error('A protected product layer could not be loaded. Import was stopped to avoid dropping products.');
      const assetId = `studio-product-${newId()}`;
      await assets.putAsset(assetId, await response.blob()); productAssets[product.id] = assetId;
    }
  } catch (err) { await Promise.all(Object.values(productAssets).map(id => assets.deleteAsset(id))); throw err; }
  if (overlay.logo) {
    const logo = await fetch(overlay.logo.url, { cache: 'no-store' });
    if (logo.ok) { logoAssetId = `studio-logo-${newId()}`; await assets.putAsset(logoAssetId, await logo.blob()); }
  }
  return {
    link,
    wrap: (openNew: (document: ProjectDocument) => void) => (document: ProjectDocument) => {
      const next = withNativeOverlay(document, overlay, logoAssetId, newId, productAssets);
      if (!next.applied && Object.keys(productAssets).length) throw new Error('Protected product layers did not pass editor validation. Import was stopped.');
      openNew(next.document);
      used = next.applied;
    },
    finish: async () => { if (!used) await Promise.all([...Object.values(productAssets), ...(logoAssetId ? [logoAssetId] : [])].map(id => assets.deleteAsset(id).catch(() => undefined))); },
  };
}
