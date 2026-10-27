/**
 * A Template Studio poster as a protected template, from what the studio already knows (no model is called):
 *
 *   ai_generated     the source is the poster as rendered (scene + copy + logo, full size, PNG); its copy becomes native
 *                    text with the studio's own typography, its logo lock-up and any exact products become original files;
 *                    the base can be the studio's text-free scene (structured-scene), which never contained them
 *   reference_reuse  the source is the original reference, exactly as it was decomposed; the text and logo regions of the
 *                    template's earlier saved analysis are offered as suggestions (approximate boxes), and the base has to
 *                    be clean artwork or a local fill
 *
 * Every element starts unreviewed: the administrator checks and confirms it before anything else happens.
 */
import { PROTECTED_LIMITS, type ProtectedTemplateView, type SourceSize, type StudioEditorOverlay, type StudioPoster, type StudioReferenceScene, type StudioTemplate } from '@frameflow/shared';
import { STUDIO_API } from '../templateStudio/api';
import { newElementId, protectedApi, type ElementDraft } from './api';

const weight = (w: number): 400 | 600 | 700 => (w >= 650 ? 700 : w >= 550 ? 600 : 400);
const LABEL: Record<string, string> = { headline: 'Headline', subheadline: 'Subheadline', offer: 'Offer', body: 'Body text', cta: 'Call to action', date: 'Date / validity', footer: 'Footer / disclaimer' };
const unreviewed = { status: 'needs-review' as const };
const mask = { mode: 'difference' as const, threshold: 24 };
const box = (b: { x: number; y: number; width: number; height: number }, size: SourceSize) => ({ x: b.x * size.width, y: b.y * size.height, width: b.width * size.width, height: b.height * size.height, rotation: 0 });

/** The poster's own copy, logo and exact products as protected elements, in source pixels of the rendered poster. */
export function overlayElements(overlay: StudioEditorOverlay, size: SourceSize, newId: () => string = newElementId): ElementDraft[] {
  let z = 0;
  const texts: ElementDraft[] = overlay.texts.filter(t => !t.hidden && t.text.trim()).map(t => ({ id: newId(), kind: t.field === 'footer' ? 'legal' : 'text', label: LABEL[t.field] ?? t.field, box: box(t.box, size), zIndex: z++,
    representation: 'native-text', mask, locked: true, replaceable: true, origin: 'template-studio', review: unreviewed,
    text: { value: t.uppercase ? t.text.toLocaleUpperCase('en-IN') : t.text, fontFamily: t.fontFamily, fallbackFamily: 'Inter', fontSize: Math.max(1, Math.round(((t.renderedFontSizePct ?? t.fontSizePct) / 100) * size.height * 10) / 10),
      fontWeight: weight(t.fontWeight), lineHeight: t.lineHeight, letterSpacing: 0, align: t.align, verticalAlign: t.verticalAlign, color: t.color } }));
  const products: ElementDraft[] = (overlay.products ?? []).map(p => ({ id: newId(), kind: 'other', label: `Product ${p.id}`, box: box(p.box, size), zIndex: z++, representation: 'raster', mask,
    locked: true, replaceable: true, origin: 'template-studio', review: unreviewed }));
  const logo: ElementDraft[] = overlay.logo ? [{ id: newId(), kind: 'logo', label: 'Brand logo', box: box(overlay.logo.box, size), zIndex: z++, representation: 'raster', mask,
    locked: true, replaceable: true, origin: 'template-studio', review: unreviewed }] : [];
  return [...texts, ...products, ...logo].slice(0, PROTECTED_LIMITS.maxElements);
}
/** The text and logo regions of the template's saved analysis: approximate boxes, suggestions to check, never confirmed. */
export function suggestedElements(scene: Pick<StudioReferenceScene, 'textRegions'> | undefined, size: SourceSize, newId: () => string = newElementId): ElementDraft[] {
  return (scene?.textRegions ?? []).filter(r => r.box.width > 0 && r.box.height > 0).slice(0, PROTECTED_LIMITS.maxElements).map((r, i) => ({ id: newId(), kind: r.kind === 'logo' ? 'logo' : 'text',
    label: (r.description || (r.kind === 'logo' ? 'Logo' : 'Text')).slice(0, 80), box: box(r.box, size), zIndex: i, representation: 'raster', mask, locked: true, replaceable: true,
    origin: 'saved-analysis', review: unreviewed, note: 'Suggested from the template\'s saved analysis (approximate). Adjust the box to the content.' }));
}

export type PosterFetch = { blob: (url: string) => Promise<Blob>; json: <T>(url: string) => Promise<T> };
export const browserFetch: PosterFetch = {
  blob: async url => { const r = await fetch(url, { cache: 'no-store' }); if (!r.ok) throw new Error('Could not read the poster from Template Studio.'); return r.blob(); },
  json: async url => { const r = await fetch(url, { cache: 'no-store' }); if (!r.ok) throw new Error('Could not read the poster from Template Studio.'); return r.json(); },
};

/** Creates the protected template of a poster, with its elements and original files, unreviewed. */
export async function protectPoster(poster: StudioPoster, io: PosterFetch = browserFetch): Promise<ProtectedTemplateView> {
  const reuse = poster.provenance === 'reference_reuse';
  const source = await io.blob(reuse ? poster.urls.decompositionScene : `${STUDIO_API}/posters/${poster.id}/image?format=png`);
  let t = await protectedApi.create(source, `${poster.template.name} · ${poster.copy.headline ?? (reuse ? 'reused reference' : 'poster')}`.slice(0, 120),
    { kind: 'template-studio-poster', posterId: poster.id, provenance: reuse ? 'reference_reuse' : 'ai_generated', templateName: poster.template.name.slice(0, 120) });
  const size = { width: t.source.width, height: t.source.height };
  if (reuse) {
    const template = (await io.json<{ template: StudioTemplate }>(`${STUDIO_API}/templates/${poster.template.id}`)).template;
    const elements = suggestedElements(template.profile?.data.referenceScenes?.find(s => s.referenceId === 'ref1'), size);
    return elements.length ? protectedApi.setElements(t, elements) : t;
  }
  const overlay = await io.json<StudioEditorOverlay>(`${STUDIO_API}/posters/${poster.id}/editor-overlay`);
  const elements = overlayElements(overlay, size);
  if (!elements.length) return t;
  t = await protectedApi.setElements(t, elements);
  // The logo lock-up and the exact products as rendered for this poster: original files, byte for byte.
  const files = [...(overlay.products ?? []).map((p, i) => ({ url: p.url, element: elements.filter(e => e.kind === 'other')[i] })), ...(overlay.logo ? [{ url: overlay.logo.url, element: elements.find(e => e.kind === 'logo')! }] : [])];
  for (const f of files) t = await protectedApi.attachAsset(t, f.element.id, new File([await io.blob(f.url)], `${f.element.label.toLowerCase().replace(/\W+/g, '-')}.png`, { type: 'image/png' }));
  return t;
}
/** The studio's text-free scene for a generated poster's template (its structured base). */
export const studioSceneUrl = (posterId: string) => `${STUDIO_API}/posters/${encodeURIComponent(posterId)}/decomposition-scene.png`;
