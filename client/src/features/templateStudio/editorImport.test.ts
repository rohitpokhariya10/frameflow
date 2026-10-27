import { describe, expect, it } from 'vitest';
import type { ProjectDocument, StudioEditorOverlay } from '@frameflow/shared';
import { isDesignVariant, isProjectDocument } from '../../lib/persistence/schema';
import { overlayTexts, withNativeOverlay } from './editorImport';

// What FrameFlow's import makes of a decomposed run (two image layers on a 1024×1280 transparent canvas), before the
// Template Studio adapter adds the poster's copy and logo.
const decomposed = (): ProjectDocument => ({
  schemaVersion: 1, id: 'design-1', name: 'Blue studio · Upgrade your kitchen', createdAt: '2026-10-12T00:00:00.000Z', updatedAt: '2026-10-12T00:00:00.000Z',
  variants: [{ id: 'layerize-1', name: 'OpenAI + Seedream run', revision: 0, canvas: { width: 1024, height: 1280, backgroundColor: '#FFFFFF', transparent: true }, elements: [], importedFrom: { templateId: 'run', resultId: 'original', runId: 'run' },
    layers: [
      { id: 'layer-a', type: 'image', assetId: 'layerize-a', name: 'Studio background (z0)', x: 0, y: 0, width: 1024, height: 1280, rotation: 0, opacity: 1, visible: true, locked: false },
      { id: 'layer-b', type: 'image', assetId: 'layerize-b', name: 'Product (z1)', x: 400, y: 600, width: 220, height: 340, rotation: 0, opacity: 1, visible: true, locked: false },
    ] }],
});
const overlay: StudioEditorOverlay = {
  posterId: 'pst_1', canvas: { width: 1080, height: 1350 },
  texts: [
    { id: 'headline', kind: 'text', field: 'headline', text: 'Upgrade your kitchen', box: { x: 0.06, y: 0.08, width: 0.88, height: 0.1 }, align: 'left', verticalAlign: 'top', fontFamily: 'Poppins', fontWeight: 700, fontSizePct: 6, minFontSizePct: 2.6, lineHeight: 1.1, uppercase: false, color: '#ffffff', plate: null, hidden: false, renderedFontSizePct: 5.5, lines: ['Upgrade your kitchen'] },
    { id: 'offer', kind: 'text', field: 'offer', text: 'No-cost EMI from ₹1,999/month', box: { x: 0.06, y: 0.2, width: 0.6, height: 0.06 }, align: 'left', verticalAlign: 'middle', fontFamily: 'Not A Catalog Font', fontWeight: 800, fontSizePct: 3, minFontSizePct: 2.2, lineHeight: 1.15, uppercase: true, color: '#14325c', plate: { color: '#ffcc33', opacity: 1, paddingPct: 1, radiusPct: 1 }, hidden: false, renderedFontSizePct: null, lines: [] },
  ],
  logo: { url: '/api/template-studio/posters/pst_1/logo.png', box: { x: 0.75, y: 0.04, width: 0.2, height: 0.05 } },
};
let n = 0;
const newId = () => `id${++n}`;

describe('Template Studio copy and logo in the editor', () => {
  it('adds the exact copy as native text elements and the logo above the decomposed layers, valid for the editor', () => {
    const { document, applied } = withNativeOverlay(decomposed(), overlay, 'studio-logo-1', newId);
    expect(applied).toBe(true);
    expect(isProjectDocument(document)).toBe(true);
    const variant = document.variants[0];
    expect(isDesignVariant(variant)).toBe(true);
    // The decomposed layers are untouched and stay underneath; the logo is the top layer.
    expect(variant.layers!.slice(0, 2)).toEqual(decomposed().variants[0].layers);
    expect(variant.layers![2]).toMatchObject({ type: 'image', assetId: 'studio-logo-1', role: 'logo', x: 0.75 * 1024, y: 0.04 * 1280, width: 0.2 * 1024 });
    expect(variant.elements.map(e => [e.role, e.text])).toEqual([['heading', 'Upgrade your kitchen'], ['offer', 'NO-COST EMI FROM ₹1,999/MONTH']]);
    const [headline, offer] = variant.elements;
    expect(headline).toMatchObject({ x: 0.06 * 1024, y: 0.08 * 1280, fontFamily: 'Poppins', fontWeight: 700, fontSize: Math.round(0.055 * 1280), fill: '#ffffff' });
    // A font the editor does not have falls back to Inter; an 800 weight to the editor's 700; the plate becomes the box.
    expect(offer).toMatchObject({ fontFamily: 'Inter', fontWeight: 700, box: { fill: '#ffcc33', radius: 12.8 } });
  });

  it('keeps the design unchanged when the additions would not validate', () => {
    const broken = { ...overlay, texts: [{ ...overlay.texts[0], color: 'not-a-colour' }] };
    const { document, applied } = withNativeOverlay(decomposed(), broken, null, newId);
    expect(applied).toBe(false);
    expect(document).toEqual(decomposed());
  });

  it('scales boxes to the decomposed canvas, whatever the poster\'s export size', () => {
    const [text] = overlayTexts(overlay, 2048, 2560, newId);
    expect(text).toMatchObject({ x: 0.06 * 2048, width: 0.88 * 2048, height: 0.1 * 2560, fontSize: Math.round(0.055 * 2560) });
  });
});
