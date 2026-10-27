import { describe, expect, it } from 'vitest';
import type { StudioEditorOverlay } from '@frameflow/shared';
import { overlayElements, suggestedElements } from './fromStudioPoster';

let n = 0;
const id = () => `pe-${String(n++).padStart(10, '0')}`;
const text = (field: string, over: Partial<StudioEditorOverlay['texts'][number]> = {}): StudioEditorOverlay['texts'][number] => ({ id: field, kind: 'text', field: field as never, text: 'Easy EMI', box: { x: 0.1, y: 0.2, width: 0.5, height: 0.1 },
  align: 'left', verticalAlign: 'top', fontFamily: 'Poppins', fontWeight: 700, fontSizePct: 5, minFontSizePct: 2, lineHeight: 1.1, uppercase: false, color: '#ffffff', plate: null, hidden: false,
  renderedFontSizePct: 4.5, lines: ['Easy EMI'], ...over });

describe('a Template Studio poster as protected elements', () => {
  it('keeps the poster\'s own copy as native text with its typography, its logo and products as files, all to be reviewed', () => {
    const overlay: StudioEditorOverlay = { posterId: 'pst_x', canvas: { width: 1080, height: 1350 }, logo: { url: '/logo.png', box: { x: 0.8, y: 0.05, width: 0.15, height: 0.06 } },
      products: [{ id: 'p1', url: '/p1.png', box: { x: 0.3, y: 0.4, width: 0.4, height: 0.4 } }],
      texts: [text('headline'), text('footer', { text: 't&c apply', uppercase: true, fontWeight: 400 }), text('cta', { hidden: true })] };
    const els = overlayElements(overlay, { width: 1080, height: 1350 }, id);
    expect(els.map(e => [e.kind, e.label, e.representation])).toEqual([['text', 'Headline', 'native-text'], ['legal', 'Footer / disclaimer', 'native-text'], ['other', 'Product p1', 'raster'], ['logo', 'Brand logo', 'raster']]);
    expect(els[0]).toMatchObject({ box: { x: 108, y: 270, width: 540, height: 135, rotation: 0 }, origin: 'template-studio', review: { status: 'needs-review' },
      text: { value: 'Easy EMI', fontFamily: 'Poppins', fallbackFamily: 'Inter', fontSize: 60.8, fontWeight: 700, color: '#ffffff' } });
    expect(els[1].text).toMatchObject({ value: 'T&C APPLY', fontWeight: 400 });
    expect(els[3].box).toMatchObject({ x: 864, y: 67.5 });
    expect(new Set(els.map(e => e.zIndex)).size).toBe(4);
  });
  it('offers a saved analysis\'s text and logo regions only as unreviewed suggestions', () => {
    const els = suggestedElements({ textRegions: [{ kind: 'logo', description: 'HDFC Bank logo', box: { x: 0.05, y: 0.02, width: 0.2, height: 0.05 } }, { kind: 'text', description: '', box: { x: 0, y: 0, width: 0, height: 0.1 } }] }, { width: 1820, height: 2420 }, id);
    expect(els).toHaveLength(1);
    expect(els[0]).toMatchObject({ kind: 'logo', label: 'HDFC Bank logo', origin: 'saved-analysis', review: { status: 'needs-review' }, box: { x: 91, y: 48.4, width: 364, height: 121 } });
    expect(suggestedElements(undefined, { width: 10, height: 10 })).toEqual([]);
  });
});
