import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DESIGN_ASPECT_RATIOS, TemplateError, addElement, applyCreative, assertDesignTemplate, canvasElementsToVariant, createCreative, createTemplateDraft, createTemplateElement, designCanvasSize, fitText,
  hasExplicitOrder, isTextBox, paintOrder, reorderElement, resolveTemplate, rotatedOrigin, setCreativeOverride, setElementLayout, textBoxOf, textFitInput, toPixels, updateElement, variantToCanvasElements,
  type CanvasElement, type CanvasSize, type Creative, type DesignTemplate, type DesignVariant, type TextElement,
} from './index.js';

const NOW = '2026-09-30T10:00:00.000Z';
const LONG = 'MEGA FESTIVE CASHBACK OFFER FOR EVERY NEW AND EXISTING CUSTOMER THIS FESTIVE SEASON ACROSS ALL OUR BRANCHES';
const SOURCE = { id: 'design-1', name: 'Holi', template: { templateId: 'tpl', templateVersion: 1, creativeId: 'creative-1' } };

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value).forEach(deepFreeze); }
  return value;
}
/**
 * background z0 · rotated decorative text z1 (15°) · hero image z2 · circle z3 · heading z4 (2 lines, shrink then
 * ellipsis) · CTA with a button z5 · empty logo slot z6 · gradient ellipse z7. Frozen: nothing may mutate it.
 */
function template(): DesignTemplate {
  let draft = createTemplateDraft('tpl', NOW, 'Festival Campaign');
  for (const [role, id] of [['background', 'background'], ['generic-text', 'ribbon'], ['hero', 'hero'], ['circle', 'circle'], ['heading', 'heading'], ['cta', 'cta'], ['logo', 'logo'], ['ellipse', 'ellipse']] as const) draft = addElement(draft, createTemplateElement(role, id, 0));
  draft = setElementLayout(draft, 'ribbon', { x: 0.1, y: 0.3, width: 0.5, height: 0.08, rotation: 15 });
  draft = setElementLayout(draft, 'hero', { x: 0.3, y: 0.25, width: 0.6, height: 0.5, rotation: -30 });
  draft = setElementLayout(draft, 'heading', { x: 0.05, y: 0.05, width: 0.6, height: 0.1 });
  draft = setElementLayout(draft, 'circle', { x: 0.333333, y: 0.142857, width: 0.2, height: 0.3 });
  draft = updateElement(draft, 'ribbon', element => element.type === 'text' ? { ...element, name: 'Ribbon', defaultContent: { text: 'Limited time' }, style: { ...element.style, letterSpacing: 0.05 } } : element);
  draft = updateElement(draft, 'hero', element => element.type === 'image' ? { ...element, defaultContent: { assetId: 'asset-hero' }, style: { opacity: 0.8, cornerRadius: 0.2 }, behavior: { fit: 'cover', focalX: 0.2, focalY: 0.7 } } : element);
  draft = updateElement(draft, 'ellipse', element => element.type === 'shape' ? { ...element, style: { ...element.style, stroke: '#1F2925', strokeWidth: 0.004, gradient: { from: '#285443', to: '#F4A261', angle: 45 } } } : element);
  draft = updateElement(draft, 'background', element => element.type === 'background' ? { ...element, defaultContent: { color: '#F48FB1', assetId: 'asset-bg' }, behavior: { fit: 'contain', focalX: 0.1, focalY: 0.9 } } : element);
  return deepFreeze(assertDesignTemplate(draft));
}
const creativeOf = (source: DesignTemplate): Creative => setCreativeOverride(createCreative(source, { id: 'creative-1', name: 'Holi', now: NOW, aspectRatio: '4:5' }), source, 'heading', { text: LONG, color: '#AD1457' }, NOW);
const elementsOf = (source = template()) => applyCreative(source, creativeOf(source)).elements;
const open = (elements: readonly CanvasElement[] = elementsOf(), canvas: CanvasSize = designCanvasSize('4:5')) => canvasElementsToVariant(elements, canvas, SOURCE);
const order = (variant: DesignVariant) => paintOrder(variant).map(item => item.kind === 'text' ? item.element.id : item.layer.id);
const textOf = (variant: DesignVariant, id: string) => variant.elements.find(element => element.id === id)!;
const layerOf = (variant: DesignVariant, id: string) => variant.layers!.find(layer => layer.id === id)!;

afterEach(() => { vi.unstubAllGlobals(); });

describe('one order across text, images and shapes', () => {
  it('1–2. text behind an image stays behind it, text above it stays above, in the editor', () => {
    const variant = open();
    expect(hasExplicitOrder(variant)).toBe(true);
    // The ribbon text (z1) is below the hero image (z2); the heading (z4) and CTA (z5) are above it.
    expect(order(variant)).toEqual(['ribbon', 'hero', 'circle', 'heading', 'cta', 'logo', 'ellipse']);
    expect(paintOrder(variant).map(item => item.kind)).toEqual(['text', 'layer', 'layer', 'text', 'text', 'layer', 'layer']);
    // The same template with the heading sent behind everything and the ribbon brought to the front.
    const moved = reorderElement(reorderElement(template(), 'heading', 'back'), 'ribbon', 'front');
    expect(order(open(applyCreative(moved, creativeOf(moved)).elements))).toEqual(['heading', 'hero', 'circle', 'cta', 'logo', 'ellipse', 'ribbon']);
  });

  it('7–8. every element keeps its own zIndex: images and shapes are not flattened under the text', () => {
    const variant = open();
    expect(variant.layers!.map(layer => [layer.id, layer.type, layer.zIndex])).toEqual([['hero', 'image', 2], ['circle', 'shape', 3], ['logo', 'image', 6], ['ellipse', 'shape', 7]]);
    expect(variant.elements.map(element => [element.id, element.zIndex])).toEqual([['ribbon', 1], ['heading', 4], ['cta', 5]]);
    expect(variantToCanvasElements(variant).map(element => [element.id, element.zIndex])).toEqual(elementsOf().map(element => [element.id, element.zIndex]));
  });

  it('draws a document without any zIndex exactly as before: its layers, then all its text', () => {
    const older: Pick<DesignVariant, 'elements' | 'layers'> = {
      elements: [{ id: 't1' }, { id: 't2' }] as TextElement[], layers: [{ id: 'l1' }, { id: 'l2' }] as DesignVariant['layers'],
    };
    expect(hasExplicitOrder(older)).toBe(false);
    expect(paintOrder(older).map(item => item.kind === 'text' ? item.element.id : item.layer.id)).toEqual(['l1', 'l2', 't1', 't2']);
    expect(paintOrder({ elements: older.elements })).toHaveLength(2);
    // An element without a place, among elements that have one, is drawn above them.
    const mixed = { elements: [{ id: 'new' }, { id: 'placed', zIndex: 5 }] as TextElement[], layers: [{ id: 'layer', zIndex: 9 }] as DesignVariant['layers'] };
    expect(paintOrder(mixed).map(item => item.kind === 'text' ? item.element.id : item.layer.id)).toEqual(['placed', 'layer', 'new']);
  });
});

describe('rotation', () => {
  it('3. rotated text keeps its exact rotation in the editor and on the way back', () => {
    const canvas = designCanvasSize('4:5'), variant = open(), ribbon = textOf(variant, 'ribbon');
    expect(ribbon.rotation).toBe(15);
    expect(layerOf(variant, 'hero').rotation).toBe(-30);
    expect(textOf(variant, 'heading').rotation).toBe(0);
    // A template box turns about its centre; an editor element turns about its origin: the origin is where the box's corner lands.
    const box = toPixels({ x: 0.1, y: 0.3, width: 0.5, height: 0.08, rotation: 15 }, canvas);
    expect([ribbon.x, ribbon.y]).toEqual([rotatedOrigin(box).x, rotatedOrigin(box).y]);
    expect([ribbon.width, ribbon.height]).toEqual([box.width, box.height]);
    const back = variantToCanvasElements(variant);
    expect(back.find(element => element.id === 'ribbon')!.layout).toEqual({ x: 0.1, y: 0.3, width: 0.5, height: 0.08, rotation: 15 });
    expect(back.find(element => element.id === 'hero')!.layout.rotation).toBe(-30);
  });
});

describe('text overflow', () => {
  /** Stand-in metrics, as in the template overflow tests: every character half the font size wide. */
  const counter = (element: TextElement) => (fontPx: number) => Math.max(1, Math.ceil(element.text.length * fontPx * 0.5 / element.width));

  it('4–5. maxLines, the overflow strategy and the smallest size survive the hand-off', () => {
    const heading = textOf(open(), 'heading');
    expect(heading).toMatchObject({ maxLines: 2, overflow: 'shrink', height: 135, width: 648, verticalAlign: 'top' });
    // Sizes are the fractions of the short edge in pixels of this canvas: 7.5% and 3.8% of 1080.
    expect(heading.fontSize).toBeCloseTo(81, 9);
    expect(heading.minFontSize).toBeCloseTo(41.04, 9);
    expect(isTextBox(heading)).toBe(true);
    expect(textOf(open(), 'cta')).toMatchObject({ maxLines: 1, overflow: 'shrink', verticalAlign: 'middle', align: 'center', box: { fill: '#285443' } });
    const back = variantToCanvasElements(open()).find(element => element.id === 'heading')!;
    expect(back).toMatchObject({ type: 'text', behavior: { maxLines: 2, overflow: 'shrink', minFontSize: 0.038 }, style: { fontSize: 0.075 } });
  });

  it('6. the raw text stays intact even when it is drawn ellipsized', () => {
    const heading = textOf(open(), 'heading');
    expect(heading.text).toBe(LONG);
    // Drawn by the shared policy from the editor element: shrunk to the smallest size, cut to 2 lines with an ellipsis.
    if (!isTextBox(heading)) throw new Error('The heading is a fixed text box.');
    const drawn = fitText(textFitInput(textBoxOf(heading)), counter(heading));
    expect(drawn).toMatchObject({ truncated: true, shrunk: true, visibleLines: 2 });
    expect(drawn.fontPx).toBeCloseTo(41.04, 9);
    // What is stored is the design size and the whole text: no ellipsis, nothing shortened, nothing resized.
    expect(heading.fontSize).toBeCloseTo(81, 9);
    expect(heading.text).not.toContain('…');
    expect(JSON.stringify(open())).not.toContain('…');
    expect((variantToCanvasElements(open()).find(element => element.id === 'heading') as Extract<CanvasElement, { type: 'text' }>).defaultContent.text).toBe(LONG);
    // The editor draws it with the same numbers Template Studio does: the same box, the same sizes, the same rules.
    const studio = resolveTemplate(template(), designCanvasSize('4:5'), creativeOf(template())).find(element => element.id === 'heading')!;
    expect(textFitInput(textBoxOf(heading))).toEqual(textFitInput(studio as Parameters<typeof textFitInput>[0]));
  });
});

describe('the round trip', () => {
  it('12–13. normalized geometry, and every other shared property, survives the editor in every aspect ratio', () => {
    const elements = elementsOf();
    for (const ratio of DESIGN_ASPECT_RATIOS) {
      const canvas = designCanvasSize(ratio), variant = canvasElementsToVariant(elements, canvas, SOURCE);
      // Back from the editor's pixels: the same elements, down to every number.
      expect(variantToCanvasElements(variant)).toEqual(elements);
      // And once more, as after saving and reopening: nothing drifts.
      expect(variantToCanvasElements(canvasElementsToVariant(variantToCanvasElements(JSON.parse(JSON.stringify(variant)) as DesignVariant), canvas, SOURCE))).toEqual(elements);
      // In the editor each element is where the template puts it on this canvas.
      for (const element of elements) {
        if (element.type === 'background') continue;
        const box = toPixels(element.layout, canvas), origin = rotatedOrigin(box);
        const placed = variant.elements.find(item => item.id === element.id) ?? variant.layers!.find(item => item.id === element.id)!;
        expect([placed.x, placed.y, placed.width, placed.height, placed.rotation]).toEqual([origin.x, origin.y, box.width, box.height, box.rotation]);
      }
      expect(variant.canvas).toEqual({ ...canvas, backgroundColor: '#F48FB1' });
    }
    // Switching the ratio is still only a different canvas: the template is what it was.
    expect(elements).toEqual(elementsOf());
  });

  it('carries image fit and focal point, empty slots, shape types, strokes, gradients and the background, not a flattened picture', () => {
    const variant = open();
    expect(layerOf(variant, 'hero')).toMatchObject({ type: 'image', role: 'hero', assetId: 'asset-hero', fit: 'cover', focalPoint: { x: 0.2, y: 0.7 }, opacity: 0.8, visible: true, locked: false });
    // An empty slot stays an element, in its place.
    expect(layerOf(variant, 'logo')).toMatchObject({ type: 'image', role: 'logo', fit: 'contain', zIndex: 6 });
    expect(layerOf(variant, 'logo')).not.toHaveProperty('assetId');
    // A circle keeps its box and stays a circle; it is not replaced by a square ellipse.
    expect(layerOf(variant, 'circle')).toMatchObject({ shapeType: 'circle', role: 'circle', width: 216, height: 405 });
    expect(layerOf(variant, 'ellipse')).toMatchObject({ shapeType: 'ellipse', gradient: { from: '#285443', to: '#F4A261', angle: 45 }, stroke: { color: '#1F2925' } });
    expect(variant.background).toEqual({ assetId: 'asset-bg', fit: 'contain', focalPoint: { x: 0.1, y: 0.9 } });
    expect(variant.template).toMatchObject({ templateId: 'tpl', templateVersion: 1, creativeId: 'creative-1', background: { id: 'background', name: 'Background' } });
    // A CTA is one text with its button, not a text and a separate shape.
    expect(variant.elements.filter(element => element.id.startsWith('cta'))).toHaveLength(1);
    expect(variant.layers).toHaveLength(4);
    // Pictures copied for the editor are used through the mapping; a picture missing from it is refused, not dropped.
    expect(layerOf(canvasElementsToVariant(elementsOf(), designCanvasSize('4:5'), { ...SOURCE, assets: { 'asset-hero': 'copy-1', 'asset-bg': 'copy-2' } }), 'hero').assetId).toBe('copy-1');
    expect(() => canvasElementsToVariant(elementsOf(), designCanvasSize('4:5'), { ...SOURCE, assets: { 'asset-bg': 'copy-2' } })).toThrow('missing from this browser');
  });

  it('keeps visibility and the editable metadata', () => {
    const hidden = updateElement(updateElement(template(), 'ribbon', element => ({ ...element, visible: false })), 'circle', element => ({ ...element, visible: false, editableProperties: { ...element.editableProperties, position: true } }));
    const elements = hidden.elements, variant = open(elements);
    expect(textOf(variant, 'ribbon').visible).toBe(false);
    expect(layerOf(variant, 'circle')).toMatchObject({ visible: false, editable: { color: true, position: true, size: false } });
    expect(textOf(variant, 'heading').editable).toEqual({ content: true, color: true, backgroundColor: false, image: false, fontFamily: false, position: false, size: false, rotation: false });
    expect(variantToCanvasElements(variant)).toEqual(elements);
    // Hidden elements are not drawn in Template Studio either.
    expect(resolveTemplate(hidden, designCanvasSize('1:1')).map(element => element.id)).toEqual(['background', 'hero', 'heading', 'cta', 'logo', 'ellipse']);
  });

  it('9. opening a creative in the editor mutates neither the template nor the creative', () => {
    const source = template(), creative = deepFreeze(creativeOf(source));
    const before = [JSON.stringify(source), JSON.stringify(creative)];
    const variant = canvasElementsToVariant(applyCreative(source, creative).elements, designCanvasSize('4:5'), SOURCE);
    // The design is its own data: changing it, as the editor does, reaches nothing in the template.
    variant.elements[0].x = 999; variant.elements[0].text = 'Edited in the editor'; variant.layers![0].fit = 'contain'; variant.template!.background!.editable.color = false;
    variantToCanvasElements(variant);
    expect([JSON.stringify(source), JSON.stringify(creative)]).toEqual(before);
    expect(source.elements.find(element => element.id === 'heading')!.layout).toEqual({ x: 0.05, y: 0.05, width: 0.6, height: 0.1, rotation: 0 });
    // The creative still holds only its overrides, no geometry.
    expect(creative.contentOverrides).toEqual({ heading: { text: LONG, color: '#AD1457' } });
  });

  it('refuses, with the reason, what the editor cannot hold instead of altering it', () => {
    const tiny = updateElement(template(), 'heading', element => element.type === 'text' ? { ...element, style: { ...element.style, fontSize: 0.005 }, behavior: { ...element.behavior, minFontSize: 0.004 } } : element);
    expect(() => open(tiny.elements)).toThrow(TemplateError);
    expect(() => open(tiny.elements)).toThrow('"Heading" has a font size of 5.4 px on this canvas; the editor takes 8 to 512 px.');
    const exotic = updateElement(template(), 'heading', element => element.type === 'text' ? { ...element, style: { ...element.style, fontFamily: 'Papyrus' } } : element);
    expect(() => open(exotic.elements)).toThrow('uses the font "Papyrus", which the editor does not have');
    const narrow = setElementLayout(template(), 'ribbon', { width: 0.02 });
    expect(() => open(narrow.elements)).toThrow('"Ribbon" is 22 px wide on this canvas');
  });
});

describe('older editor designs as CanvasElements', () => {
  const older: DesignVariant = {
    id: 'original', name: 'Original', revision: 3, canvas: { width: 1080, height: 1350, backgroundColor: '#FFFEFA' },
    elements: [{ id: 'title', type: 'text', role: 'title', text: 'Spring\nGala', x: 108, y: 270, width: 540, fontFamily: 'Lora', fontSize: 54, fontWeight: 600, fill: '#1F2925', align: 'center', lineHeight: 1.2, letterSpacing: 0 }],
    layers: [
      { id: 'panel', name: 'Panel', type: 'shape', shapeType: 'rounded-rectangle', x: 54, y: 135, width: 540, height: 270, rotation: 0, opacity: 1, visible: true, locked: true, fill: '#FF6A00', radius: 27, gradient: { from: '#FF6A00', to: '#FFD54A', angle: 45 } },
      { id: 'photo', name: 'Photo', type: 'image', assetId: 'asset-photo', x: 540, y: 675, width: 270, height: 270, rotation: 0, opacity: 0.5, visible: false, locked: false },
    ],
  };

  it('reads a design saved before these fields existed as the shared model, in its drawn order', () => {
    const elements = variantToCanvasElements(deepFreeze(older), { textHeight: () => 135 });
    expect(elements.map(element => [element.id, element.type, element.zIndex])).toEqual([['background', 'background', 0], ['panel', 'shape', 1], ['photo', 'image', 2], ['title', 'text', 3]]);
    expect(elements[1]).toMatchObject({ role: 'rounded-rectangle', layout: { x: 0.05, y: 0.1, width: 0.5, height: 0.2, rotation: 0 }, style: { fill: '#FF6A00', cornerRadius: 0.2, stroke: null, strokeWidth: 0, gradient: { angle: 45 } } });
    expect(elements[2]).toMatchObject({ role: 'generic-image', visible: false, defaultContent: { assetId: 'asset-photo' }, style: { opacity: 0.5 }, layout: { x: 0.5, y: 0.5, width: 0.25, height: 0.2 } });
    expect(elements[3]).toMatchObject({ role: 'heading', name: 'Spring Gala'.replace(' ', '\n'), defaultContent: { text: 'Spring\nGala' }, layout: { x: 0.1, y: 0.2, width: 0.5, height: 0.1, rotation: 0 }, style: { fontSize: 0.05, fontFamily: 'Lora' } });
    expect(elements[0]).toMatchObject({ defaultContent: { color: '#FFFEFA', assetId: null }, layout: { x: 0, y: 0, width: 1, height: 1 } });
    // Without a measured height, a free text takes the height of the lines it was typed with.
    expect(variantToCanvasElements(older)[3].layout.height).toBe(0.096);
    // A transparent canvas has no background element.
    expect(variantToCanvasElements({ ...older, canvas: { ...older.canvas, transparent: true } }).map(element => element.type)).toEqual(['shape', 'image', 'text']);
  });
});

describe('no provider, no network', () => {
  it('14. the hand-off is pure data: no request is made in either direction', () => {
    const request = vi.fn(() => { throw new Error('The hand-off must not make requests.'); });
    vi.stubGlobal('fetch', request);
    vi.stubGlobal('XMLHttpRequest', request);
    const variant = open();
    expect(variantToCanvasElements(variant)).toEqual(elementsOf());
    expect(request).not.toHaveBeenCalled();
  });
});
