import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DESIGN_ASPECT_RATIOS, LAYOUT_LIMITS, TemplateError, addElement, applyCreative, assertDesignTemplate, aspectRatioValue, clampLayout, commitPixelBox, createCreative, createTemplateDraft, createTemplateElement,
  creativesOf, deleteDesignTemplate, designCanvasSize, designTemplateVersion, designTemplateVersions, duplicateDesignTemplate, emptyLibrary, findElement, fitText, imageFit, latestDesignTemplate, listDesignTemplates,
  parseLibrary, removeElement, renameDesignTemplate, reorderElement, resolveTemplate, rotatedOrigin, saveCreative, saveDesignTemplate, serializeLibrary, setCreativeAspectRatio, setCreativeOverride,
  setElementLayout, templateErrors, templateIssues, textFitInput, textFitWarning, toNormalized, toPixels, updateElement, upgradeCreative,
  type CanvasSize, type Creative, type DesignAspectRatio, type DesignTemplate, type NormalizedLayout, type ResolvedText, type TemplateLibrary,
} from '../index.js';

const NOW = '2026-09-30T10:00:00.000Z', LATER = '2026-09-30T11:00:00.000Z';
const HEADING: NormalizedLayout = { x: 0.05, y: 0.05, width: 0.6, height: 0.1, rotation: 0 };
/** The canvases of the specification's example (1:1 is 1000 × 1000, 4:5 is 1000 × 1250) and of every supported ratio. */
const SQUARE: CanvasSize = { width: 1000, height: 1000 }, PORTRAIT: CanvasSize = { width: 1000, height: 1250 };
const canvases = DESIGN_ASPECT_RATIOS.map(ratio => [ratio, designCanvasSize(ratio)] as const);

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value).forEach(deepFreeze); }
  return value;
}
/** A generic campaign template: background, logo, heading, paragraph, hero image, CTA and a decoration. Frozen: nothing may mutate it. */
function campaign(id = 'tpl-festival'): DesignTemplate {
  let template = createTemplateDraft(id, NOW, 'Festival Campaign');
  for (const role of ['background', 'decorative', 'hero', 'logo', 'heading', 'paragraph', 'cta'] as const) template = addElement(template, createTemplateElement(role, role, 0));
  template = setElementLayout(template, 'heading', HEADING);
  template = setElementLayout(template, 'logo', { x: 0.05, y: 0.04 });
  template = setElementLayout(template, 'hero', { x: 0.45, y: 0.2, rotation: 15 });
  template = setElementLayout(template, 'cta', { x: 0.05, y: 0.8 });
  template = updateElement(template, 'heading', element => element.type === 'text' ? { ...element, defaultContent: { text: 'DIWALI OFFER' } } : element);
  return deepFreeze(assertDesignTemplate(template));
}
const layoutOf = (template: DesignTemplate, id: string) => findElement(template, id)!.layout;
const boxesOf = (template: DesignTemplate, canvas: CanvasSize, creative?: Creative) => Object.fromEntries(resolveTemplate(template, canvas, creative).map(element => [element.id, element.box]));
const saved = (template = campaign()): { library: TemplateLibrary; template: DesignTemplate } => saveDesignTemplate(emptyLibrary(), template, NOW);

afterEach(() => { vi.unstubAllGlobals(); });

describe('normalized coordinates', () => {
  it('1. converts pixels to normalized values', () => {
    expect(toNormalized({ x: 50, y: 50, width: 600, height: 100, rotation: 0 }, SQUARE)).toEqual(HEADING);
    // The same element on a 4:5 canvas sits at different pixels and the same fractions.
    expect(toNormalized({ x: 50, y: 62.5, width: 600, height: 125, rotation: 0 }, PORTRAIT)).toEqual(HEADING);
    expect(toNormalized({ x: 480, y: 270, width: 960, height: 540, rotation: 30 }, { width: 1920, height: 1080 })).toEqual({ x: 0.25, y: 0.25, width: 0.5, height: 0.5, rotation: 30 });
  });

  it('2. converts normalized values to pixels', () => {
    expect(toPixels(HEADING, SQUARE)).toEqual({ x: 50, y: 50, width: 600, height: 100, rotation: 0 });
    // 5% from the top of 1250 px is 62.5 px: not rounded.
    expect(toPixels(HEADING, PORTRAIT)).toEqual({ x: 50, y: 62.5, width: 600, height: 125, rotation: 0 });
    expect(toPixels(HEADING, designCanvasSize('9:16'))).toEqual({ x: 54, y: 96, width: 648, height: 192, rotation: 0 });
    expect(toPixels(HEADING, designCanvasSize('16:9'))).toEqual({ x: 96, y: 54, width: 1152, height: 108, rotation: 0 });
  });

  it('3. a stored layout survives any number of round trips, in any mix of aspect ratios, without drift', () => {
    const layouts: NormalizedLayout[] = [HEADING, { x: 0.333333, y: 0.142857, width: 0.123457, height: 0.654321, rotation: -37.25 }, { x: 0, y: 0, width: 1, height: 1, rotation: 0 }, { x: 0.999, y: 0.995, width: 0.001 * 1, height: 0.005, rotation: 179.99 }].map(clampLayout);
    for (const original of layouts) {
      let layout = original;
      for (let i = 0; i < 1000; i++) layout = toNormalized(toPixels(layout, canvases[i % canvases.length][1]), canvases[i % canvases.length][1]);
      for (const key of ['x', 'y', 'width', 'height', 'rotation'] as const) expect(layout[key]).toBe(original[key]);
    }
    // Odd canvas sizes too, where the pixel values are not round.
    let layout = clampLayout({ x: 0.271828, y: 0.314159, width: 0.161803, height: 0.141421, rotation: 12.5 });
    const start = { ...layout };
    for (const canvas of [{ width: 1081, height: 1349 }, { width: 333, height: 777 }, { width: 4096, height: 2304 }, { width: 257, height: 4001 }]) for (let i = 0; i < 250; i++) layout = toNormalized(toPixels(layout, canvas), canvas);
    expect(layout).toEqual(start);
  });

  it('gives each supported aspect ratio its canvas and refuses anything else', () => {
    expect(Object.fromEntries(canvases)).toEqual({ '1:1': { width: 1080, height: 1080 }, '4:5': { width: 1080, height: 1350 }, '3:4': { width: 1080, height: 1440 }, '9:16': { width: 1080, height: 1920 }, '16:9': { width: 1920, height: 1080 } });
    expect(designCanvasSize('4:5', 1000)).toEqual(PORTRAIT);
    expect(aspectRatioValue('4:5')).toBe(0.8);
    for (const bad of ['2:3', '4x5', '0:5', '', 'wide']) expect(() => designCanvasSize(bad as DesignAspectRatio)).toThrow(TemplateError);
    for (const bad of ['4x5', '0:5', '4:0', '-4:5', '']) expect(() => aspectRatioValue(bad)).toThrow(TemplateError);
  });
});

describe('one layout in every aspect ratio', () => {
  const template = campaign();

  it('4–6. 5% from the top and the left, 60% wide and 10% high, stay exactly that in every ratio', () => {
    const pixels: Record<string, number[]> = {};
    for (const [ratio, canvas] of canvases) {
      const { box } = resolveTemplate(template, canvas).find(element => element.id === 'heading')!;
      // Pixels follow the canvas and nothing else.
      expect(box).toEqual({ x: 0.05 * canvas.width, y: 0.05 * canvas.height, width: 0.6 * canvas.width, height: 0.1 * canvas.height, rotation: 0 });
      expect(box.y / canvas.height).toBeCloseTo(0.05, 12);
      expect(box.x / canvas.width).toBeCloseTo(0.05, 12);
      expect(box.width / canvas.width).toBeCloseTo(0.6, 12);
      expect(box.height / canvas.height).toBeCloseTo(0.1, 12);
      // Read back from the rendered pixels, the layout is the stored layout.
      expect(toNormalized(box, canvas)).toEqual(HEADING);
      pixels[ratio] = [box.x, box.y, box.width, box.height];
    }
    expect(pixels).toEqual({ '1:1': [54, 54, 648, 108], '4:5': [54, 67.5, 648, 135], '3:4': [54, 72, 648, 144], '9:16': [54, 96, 648, 192], '16:9': [96, 54, 1152, 108] });
    // The specification's own example: 50 px of 1000, 62.5 px of 1250.
    expect(resolveTemplate(template, SQUARE).find(element => element.id === 'heading')!.box.y).toBe(50);
    expect(resolveTemplate(template, PORTRAIT).find(element => element.id === 'heading')!.box.y).toBe(62.5);
    // The stored layout is what it was.
    expect(layoutOf(template, 'heading')).toEqual(HEADING);
  });

  it('keeps every element\'s anchors: logo 5%/4%, hero 45%/20%, CTA 5%/80%', () => {
    for (const [, canvas] of canvases) {
      const boxes = boxesOf(template, canvas);
      for (const [id, x, y] of [['logo', 0.05, 0.04], ['heading', 0.05, 0.05], ['hero', 0.45, 0.2], ['cta', 0.05, 0.8]] as const) {
        expect(boxes[id].x).toBeCloseTo(x * canvas.width, 9);
        expect(boxes[id].y).toBeCloseTo(y * canvas.height, 9);
      }
      expect(boxes.background).toEqual({ x: 0, y: 0, width: canvas.width, height: canvas.height, rotation: 0 });
    }
  });

  it('7. rotation is in degrees and identical in every ratio', () => {
    for (const [, canvas] of canvases) expect(boxesOf(template, canvas).hero.rotation).toBe(15);
    expect(layoutOf(template, 'hero').rotation).toBe(15);
    expect(clampLayout({ ...HEADING, rotation: 350 }).rotation).toBe(-10);
    expect(clampLayout({ ...HEADING, rotation: -725 }).rotation).toBe(-5);
    // The editor's layers turn about their top-left corner; a template box turns about its centre.
    const origin = rotatedOrigin({ x: 100, y: 100, width: 200, height: 100, rotation: 90 });
    expect([origin.x, origin.y].map(n => Math.round(n * 1e6) / 1e6)).toEqual([250, 50]);
    expect(rotatedOrigin({ x: 100, y: 100, width: 200, height: 100, rotation: 0 })).toEqual({ x: 100, y: 100 });
  });

  it('8. the layer order is explicit and identical in every ratio, with the background at the bottom', () => {
    const order = ['background', 'decorative', 'hero', 'logo', 'heading', 'paragraph', 'cta'];
    expect(template.elements.map(element => [element.id, element.zIndex])).toEqual(order.map((id, zIndex) => [id, zIndex]));
    for (const [, canvas] of canvases) expect(resolveTemplate(template, canvas).map(element => [element.id, element.zIndex])).toEqual(order.map((id, zIndex) => [id, zIndex]));
    // Reordering keeps the background lowest, whatever is asked.
    const moved = reorderElement(reorderElement(template, 'logo', 'back'), 'decorative', 'front');
    expect(moved.elements.map(element => element.id)).toEqual(['background', 'logo', 'hero', 'heading', 'paragraph', 'cta', 'decorative']);
    expect(moved.elements.map(element => element.zIndex)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(reorderElement(template, 'background', 'front')).toBe(template);
    // A background added last still goes underneath.
    let late = createTemplateDraft('late', NOW);
    for (const role of ['heading', 'hero', 'background'] as const) late = addElement(late, createTemplateElement(role, role, 0));
    expect(late.elements.map(element => [element.id, element.zIndex])).toEqual([['background', 0], ['heading', 1], ['hero', 2]]);
    expect(templateErrors({ ...late, elements: late.elements.map(element => element.id === 'background' ? { ...element, zIndex: 9 } : element) }).map(issue => issue.message)).toContain('The background must have the lowest zIndex.');
  });

  it('10. switching the aspect ratio renders the same template again: nothing is copied, added or mutated', () => {
    const before = JSON.stringify(template);
    // The template is deeply frozen: any write while resolving would throw.
    const counts = [...canvases, ...canvases].map(([, canvas]) => resolveTemplate(template, canvas).length);
    expect(new Set(counts)).toEqual(new Set([template.elements.length]));
    expect(JSON.stringify(template)).toBe(before);
    // The ratio is no part of the layout: no element or template has per-ratio data.
    expect(before).not.toMatch(/"(1:1|4:5|3:4|9:16|16:9)":/);
    expect(Object.keys(template.elements[1].layout)).toEqual(['x', 'y', 'width', 'height', 'rotation']);
  });

  it('scales text with the canvas short edge, never a fixed pixel size', () => {
    const font = (canvas: CanvasSize) => (resolveTemplate(template, canvas).find(element => element.id === 'heading') as ResolvedText).fontPx;
    expect(font({ width: 1000, height: 1000 })).toBeCloseTo(75, 9);
    expect(font({ width: 2000, height: 2000 })).toBeCloseTo(150, 9);
    // Portrait and landscape canvases with the same short edge draw the same size.
    expect(font({ width: 1080, height: 1920 })).toBe(font({ width: 1920, height: 1080 }));
  });
});

describe('template authoring', () => {
  it('9. a drag or resize on the rendered canvas is stored as normalized values, converted once', () => {
    const template = campaign();
    // Dragged on a 4:5 canvas to 100 px, 250 px: 10% and 20%. Width, height and rotation are not touched at all.
    const dragged = commitPixelBox(template, 'heading', { x: 100, y: 250 }, PORTRAIT);
    expect(layoutOf(dragged, 'heading')).toEqual({ x: 0.1, y: 0.2, width: 0.6, height: 0.1, rotation: 0 });
    expect(layoutOf(template, 'heading')).toEqual(HEADING);
    // The same drop point as a fraction gives the same stored layout from any ratio.
    for (const [, canvas] of canvases) expect(layoutOf(commitPixelBox(template, 'heading', { x: 0.1 * canvas.width, y: 0.2 * canvas.height }, canvas), 'heading')).toEqual(layoutOf(dragged, 'heading'));
    const resized = commitPixelBox(template, 'hero', { x: 108, y: 270, width: 540, height: 675, rotation: 30 }, designCanvasSize('4:5'));
    expect(layoutOf(resized, 'hero')).toEqual({ x: 0.1, y: 0.2, width: 0.5, height: 0.5, rotation: 30 });
    // Dropping an element where it already is stores nothing new.
    const { x, y } = toPixels(HEADING, PORTRAIT);
    expect(commitPixelBox(template, 'heading', { x, y }, PORTRAIT)).toBe(template);
    // Only the dragged element changes.
    expect(dragged.elements.filter(element => element.id !== 'heading')).toEqual(template.elements.filter(element => element.id !== 'heading'));
    expect(() => commitPixelBox(template, 'background', { x: 10, y: 10 }, SQUARE)).toThrow('whole canvas');
    expect(() => commitPixelBox(template, 'nothing', { x: 10 }, SQUARE)).toThrow(TemplateError);
  });

  it('17. keeps elements inside the canvas: invalid numbers are refused, out-of-range ones clamped, never stored as given', () => {
    // Dragged outside, negative positions, larger than the canvas, zero or negative size.
    expect(clampLayout({ x: -0.3, y: 1.7, width: 0.6, height: 0.1, rotation: 0 })).toEqual({ x: 0, y: 0.9, width: 0.6, height: 0.1, rotation: 0 });
    expect(clampLayout({ x: 0.5, y: 0.5, width: 1.8, height: 2, rotation: 0 })).toEqual({ x: 0, y: 0, width: 1, height: 1, rotation: 0 });
    expect(clampLayout({ x: 0.2, y: 0.2, width: 0, height: -0.4, rotation: 0 })).toMatchObject({ width: LAYOUT_LIMITS.minSize, height: LAYOUT_LIMITS.minSize });
    const template = campaign();
    expect(layoutOf(commitPixelBox(template, 'heading', { x: -500, y: 5000 }, SQUARE), 'heading')).toEqual({ x: 0, y: 0.9, width: 0.6, height: 0.1, rotation: 0 });
    expect(layoutOf(commitPixelBox(template, 'heading', { x: 900, y: 0, width: 4000, height: 0 }, SQUARE), 'heading')).toEqual({ x: 0, y: 0, width: 1, height: LAYOUT_LIMITS.minSize, rotation: 0 });
    // Not numbers at all: refused.
    for (const bad of [NaN, Infinity, -Infinity, undefined as unknown as number, '0.5' as unknown as number]) {
      expect(() => clampLayout({ ...HEADING, x: bad })).toThrow(TemplateError);
      expect(() => toNormalized({ x: 0, y: 0, width: bad, height: 10, rotation: 0 }, SQUARE)).toThrow(TemplateError);
    }
    for (const canvas of [{ width: 0, height: 100 }, { width: 100, height: -1 }, { width: NaN, height: 100 }]) {
      expect(() => toPixels(HEADING, canvas)).toThrow(TemplateError);
      expect(() => toNormalized({ x: 0, y: 0, width: 1, height: 1, rotation: 0 }, canvas)).toThrow(TemplateError);
    }
    // A stored template with such values is reported, not loaded and not quietly corrected.
    const broken = (layout: Partial<NormalizedLayout>) => templateErrors({ ...template, elements: template.elements.map(element => element.id === 'heading' ? { ...element, layout: { ...element.layout, ...layout } } : element) }).map(issue => `${issue.path}: ${issue.message}`);
    expect(broken({ x: -0.1 })).toEqual(['elements[4].layout: x -0.1 is negative.']);
    expect(broken({ width: 1.4 })[0]).toContain('width 1.4 is outside');
    expect(broken({ x: 0.7 })[0]).toContain('the element leaves the canvas');
    expect(broken({ height: 0 })[0]).toContain('height 0 is outside');
    expect(broken({ y: Number.NaN })).toEqual(['elements[4].layout: y must be a finite number.']);
    expect(broken({})).toEqual([]);
  });

  it('reports duplicate ids, unsupported element types, invalid aspect ratios and malformed templates, and warns about a missing font', () => {
    const template = campaign(), heading = findElement(template, 'heading')!;
    expect(() => addElement(template, createTemplateElement('heading', 'heading', 0))).toThrow('already has an element "heading"');
    expect(() => addElement(template, createTemplateElement('background', 'bg2', 0))).toThrow('already has a background');
    expect(() => createTemplateElement('video' as never, 'v', 0)).toThrow('Unsupported element role');
    const messages = (value: unknown) => templateErrors(value).map(issue => issue.message).join(' | ');
    expect(messages({ ...template, elements: [...template.elements, { ...heading }] })).toContain('Duplicate element id "heading"');
    expect(messages({ ...template, elements: [...template.elements, { ...heading, id: 'clip', type: 'video' }] })).toContain('Unsupported element type "video"');
    expect(messages({ ...template, elements: [...template.elements, { ...heading, id: 'h2', zIndex: 99, role: 'hero' }] })).toContain('role "hero" is not a text role');
    expect(messages({ ...template, supportedAspectRatios: ['1:1', '2:3'] })).toContain('Invalid aspect ratio "2:3"');
    expect(messages({ ...template, supportedAspectRatios: ['4:5'] })).toContain('The master aspect ratio 1:1 must be one of the supported ratios.');
    expect(messages({ ...template, canvas: { masterAspectRatio: 'square' } })).toContain('Invalid aspect ratio "square"');
    expect(messages({ ...template, schemaVersion: 2 })).toContain('Unsupported template schema version 2');
    for (const malformed of [null, 'template', 42, [], {}, { ...template, elements: 'none' }, { ...template, elements: [null] }]) expect(templateErrors(malformed).length).toBeGreaterThan(0);
    expect(() => assertDesignTemplate({ ...template, id: '' })).toThrow(TemplateError);
    // A font that is not installed is a warning: the template still loads and is drawn with the default font.
    const exotic = { ...template, elements: template.elements.map(element => element.type === 'text' && element.id === 'heading' ? { ...element, style: { ...element.style, fontFamily: 'Papyrus' } } : element) };
    expect(templateErrors(exotic)).toEqual([]);
    expect(templateIssues(exotic)).toEqual([{ severity: 'warning', path: 'elements[4].style.fontFamily', message: 'Font "Papyrus" is not available here (Inter, Lora); Inter is used instead.' }]);
    expect((resolveTemplate(exotic, SQUARE).find(element => element.id === 'heading') as ResolvedText).fontFamily).toBe('Inter');
    // An empty image slot is valid: it is drawn as a placeholder, in its box.
    expect(resolveTemplate(template, SQUARE).find(element => element.id === 'hero')).toMatchObject({ assetId: null, box: toPixels(layoutOf(template, 'hero'), SQUARE) });
    expect(removeElement(template, 'logo').elements.map(element => element.zIndex)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('fits an image into its fixed slot by cover or contain, around the focal point', () => {
    const slot = { width: 400, height: 400 }, wide = { width: 1600, height: 800 };
    expect(imageFit(wide, slot, 'cover')).toEqual({ crop: { x: 400, y: 0, width: 800, height: 800 }, dest: { x: 0, y: 0, width: 400, height: 400 } });
    expect(imageFit(wide, slot, 'cover', 0, 0.5).crop.x).toBe(0);
    expect(imageFit(wide, slot, 'cover', 1, 0.5).crop.x).toBe(800);
    expect(imageFit(wide, slot, 'contain')).toEqual({ crop: { x: 0, y: 0, width: 1600, height: 800 }, dest: { x: 0, y: 100, width: 400, height: 200 } });
    expect(() => imageFit({ width: 0, height: 10 }, slot, 'cover')).toThrow(TemplateError);
  });
});

describe('creatives', () => {
  const make = (template: DesignTemplate, id: string, name: string, aspectRatio?: DesignAspectRatio) => createCreative(template, { id, name, now: NOW, aspectRatio });
  const textOf = (template: DesignTemplate, creative: Creative, id: string) => (resolveTemplate(template, SQUARE, creative).find(element => element.id === id) as ResolvedText).text;

  it('11. content overrides never touch the template', () => {
    const template = campaign(), before = JSON.stringify(template);
    let creative = make(template, 'c-holi', 'Holi Cashback Campaign');
    creative = setCreativeOverride(creative, template, 'heading', { text: 'Holi Cashback Offer', color: '#C2185B' }, LATER);
    creative = setCreativeOverride(creative, template, 'background', { color: '#FCE4EC' }, LATER);
    creative = setCreativeOverride(creative, template, 'hero', { assetId: 'asset-colours' }, LATER);
    const { elements, ignored } = applyCreative(template, creative);
    expect(ignored).toEqual([]);
    expect(elements.find(element => element.id === 'heading')).toMatchObject({ defaultContent: { text: 'Holi Cashback Offer' }, style: { color: '#C2185B' } });
    // The template (deeply frozen) still says what it said; the creative stores only what differs, and no geometry.
    expect(JSON.stringify(template)).toBe(before);
    expect(textOf(template, make(template, 'plain', 'Plain'), 'heading')).toBe('DIWALI OFFER');
    expect(creative.contentOverrides).toEqual({ heading: { text: 'Holi Cashback Offer', color: '#C2185B' }, background: { color: '#FCE4EC' }, hero: { assetId: 'asset-colours' } });
    expect(JSON.stringify(creative)).not.toMatch(/"(x|y|width|height|rotation|layout|zIndex)"/);
    expect(creative).toMatchObject({ templateId: 'tpl-festival', templateVersion: 1, aspectRatio: '1:1' });
  });

  it('12. two creatives of one template are independent and share one geometry', () => {
    const template = campaign();
    const diwali = setCreativeOverride(setCreativeOverride(make(template, 'a', 'Diwali', '1:1'), template, 'heading', { text: 'Diwali Offer' }, LATER), template, 'background', { color: '#F4A261' }, LATER);
    let holi = setCreativeOverride(make(template, 'b', 'Holi', '4:5'), template, 'heading', { text: 'Holi Offer' }, LATER);
    const christmas = setCreativeOverride(make(template, 'c', 'Christmas', '9:16'), template, 'background', { color: '#B71C1C' }, LATER);
    const diwaliBefore = JSON.stringify(diwali);
    holi = setCreativeOverride(holi, template, 'background', { color: '#F8BBD0' }, LATER);
    expect(JSON.stringify(diwali)).toBe(diwaliBefore);
    expect([textOf(template, diwali, 'heading'), textOf(template, holi, 'heading'), textOf(template, christmas, 'heading')]).toEqual(['Diwali Offer', 'Holi Offer', 'DIWALI OFFER']);
    // Same canvas, same boxes, whichever creative; each in its own ratio is the template in that ratio.
    for (const [, canvas] of canvases) for (const creative of [diwali, holi, christmas]) expect(boxesOf(template, canvas, creative)).toEqual(boxesOf(template, canvas));
    expect([diwali.aspectRatio, holi.aspectRatio, christmas.aspectRatio]).toEqual(['1:1', '4:5', '9:16']);
    // Removing an override returns to the template's own value.
    expect(setCreativeOverride(holi, template, 'heading', { text: undefined }, LATER).contentOverrides).toEqual({ background: { color: '#F8BBD0' } });
  });

  it('13–15. replacing an image, a text or the background changes content only, never a box', () => {
    const template = campaign(), base = make(template, 'c', 'Creative');
    const changes: [string, Parameters<typeof setCreativeOverride>[3]][] = [
      ['hero', { assetId: 'asset-gifts', focalX: 0.2, focalY: 0.8 }], ['logo', { assetId: 'asset-other-logo' }],
      ['heading', { text: 'MEGA FESTIVE CASHBACK OFFER FOR EVERY NEW AND EXISTING CUSTOMER THIS SEASON' }], ['cta', { text: 'Apply now', backgroundColor: '#B71C1C' }],
      ['background', { color: '#B71C1C', assetId: 'asset-snow' }],
    ];
    let all = base;
    for (const [id, change] of changes) {
      const creative = setCreativeOverride(base, template, id, change, LATER);
      all = setCreativeOverride(all, template, id, change, LATER);
      for (const [, canvas] of canvases) expect(boxesOf(template, canvas, creative)).toEqual(boxesOf(template, canvas));
    }
    for (const [, canvas] of canvases) {
      const resolved = resolveTemplate(template, canvas, all);
      expect(Object.fromEntries(resolved.map(element => [element.id, element.box]))).toEqual(boxesOf(template, canvas));
      expect(resolved.map(element => [element.id, element.zIndex])).toEqual(resolveTemplate(template, canvas).map(element => [element.id, element.zIndex]));
      expect(resolved.find(element => element.id === 'hero')).toMatchObject({ assetId: 'asset-gifts', focalX: 0.2, focalY: 0.8, fit: 'cover' });
      expect(resolved.find(element => element.id === 'background')).toMatchObject({ color: '#B71C1C', assetId: 'asset-snow', box: { x: 0, y: 0, width: canvas.width, height: canvas.height } });
    }
    expect(template.elements.map(element => element.layout)).toEqual(campaign().elements.map(element => element.layout));
  });

  it('locks geometry and every property the template did not open', () => {
    const template = campaign(), creative = make(template, 'c', 'Creative');
    // Position, size and rotation are locked on every element of this template.
    for (const layout of [{ x: 0.5 }, { y: 0.5 }, { width: 0.2 }, { height: 0.2 }, { rotation: 45 }]) expect(() => setCreativeOverride(creative, template, 'heading', { layout }, LATER)).toThrow('locked by the template');
    expect(() => setCreativeOverride(creative, template, 'heading', { fontFamily: 'Lora' }, LATER)).toThrow('fontFamily is locked');
    expect(() => setCreativeOverride(creative, template, 'logo', { text: 'x' }, LATER)).toThrow('an image element has no text');
    expect(() => setCreativeOverride(creative, template, 'decorative', { assetId: 'a' }, LATER)).toThrow('a shape element has no assetId');
    expect(() => setCreativeOverride(creative, template, 'heading', { color: 'red' }, LATER)).toThrow('not a valid color');
    expect(() => setCreativeOverride(creative, template, 'background', { layout: { x: 0.1 } }, LATER)).toThrow('whole canvas');
    expect(() => setCreativeOverride(creative, template, 'ghost', { text: 'x' }, LATER)).toThrow('no element "ghost"');
    expect(() => setCreativeOverride(creative, template, 'heading', { zIndex: 3 } as never, LATER)).toThrow('not something a creative can change');
    // A creative edited by hand cannot get past the lock either: the locked part is ignored and reported, the rest applied.
    const tampered: Creative = { ...creative, contentOverrides: { heading: { text: 'Allowed', layout: { x: 0.9, y: 0.9 } }, ghost: { text: 'x' } } };
    const { elements, ignored } = applyCreative(template, tampered);
    expect(elements.find(element => element.id === 'heading')).toMatchObject({ defaultContent: { text: 'Allowed' }, layout: HEADING });
    expect(ignored.map(issue => issue.message)).toEqual(['The template has no element "ghost"; its content is ignored.', 'Heading: position is locked by the template.', 'Heading: position is locked by the template.']);
    // Only where the template author opened it does a creative get to move an element, and then still inside the canvas.
    const open = updateElement(template, 'logo', element => ({ ...element, editableProperties: { ...element.editableProperties, position: true } }));
    const moved = setCreativeOverride(make(open, 'm', 'Moved'), open, 'logo', { layout: { x: 0.7, y: 5 } }, LATER);
    expect(applyCreative(open, moved).elements.find(element => element.id === 'logo')!.layout).toEqual({ ...layoutOf(open, 'logo'), x: 0.7, y: 0.92 });
    expect(() => setCreativeOverride(moved, open, 'logo', { layout: { width: 0.5 } }, LATER)).toThrow('size is locked');
    expect(layoutOf(open, 'logo')).toEqual(layoutOf(template, 'logo'));
    // A creative picks one of the template's supported ratios.
    const narrow = { ...template, supportedAspectRatios: ['1:1', '4:5'] as DesignAspectRatio[] };
    expect(setCreativeAspectRatio(make(narrow, 'n', 'N'), narrow, '4:5', LATER).aspectRatio).toBe('4:5');
    expect(() => setCreativeAspectRatio(make(narrow, 'n', 'N'), narrow, '16:9', LATER)).toThrow('does not support 16:9');
    expect(() => make(narrow, 'n', 'N', '9:16')).toThrow('does not support 9:16');
  });
});

describe('text overflow', () => {
  /** Stand-in for font metrics: every character is half the font size wide, words are not split. */
  const lineCounter = (text: string, boxWidth: number) => (fontPx: number) => {
    const perLine = Math.max(1, Math.floor(boxWidth / (fontPx * 0.5)));
    let lines = 1, used = 0;
    for (const word of text.split(' ')) { const length = word.length + (used ? 1 : 0); if (used && used + length > perLine) { lines++; used = word.length; } else used += length; }
    return lines;
  };
  const template = campaign();
  const headingWith = (text: string, canvas = SQUARE) => {
    const creative = setCreativeOverride(createCreative(template, { id: 'c', name: 'C', now: NOW }), template, 'heading', { text }, LATER);
    return resolveTemplate(template, canvas, creative).find(element => element.id === 'heading') as ResolvedText;
  };
  const fit = (element: ResolvedText) => fitText(textFitInput(element), lineCounter(element.text, element.box.width));

  it('16. wraps, shrinks down to the minimum size, then cuts with an ellipsis and a warning; the box never changes', () => {
    // 600 × 100 px box, 75 px font (7.5% of 1000), line height 1.1, at most 2 lines: one line fits at full size.
    const short = headingWith('DIWALI OFFER');
    expect(short).toMatchObject({ box: { width: 600, height: 100 }, fontPx: 75, minFontPx: 38, maxLines: 2, overflow: 'shrink' });
    expect(fit(short)).toEqual({ fontPx: 75, lines: 1, visibleLines: 1, shrunk: false, truncated: false });
    expect(textFitWarning(short, fit(short))).toBeUndefined();
    // Longer wording: wrapped and shrunk until it fits 2 lines inside the box, no lower than needed.
    const long = headingWith('MEGA FESTIVE CASHBACK OFFER');
    const shrunk = fit(long);
    expect(shrunk).toMatchObject({ lines: 2, visibleLines: 2, shrunk: true, truncated: false });
    expect(shrunk.fontPx).toBeLessThan(75);
    expect(shrunk.fontPx).toBeGreaterThanOrEqual(38);
    expect(shrunk.lines * shrunk.fontPx * long.lineHeight).toBeLessThanOrEqual(long.box.height + 0.01);
    // The largest size that fits: one step larger does not.
    const step = (75 - 38) / 32, larger = shrunk.fontPx + step;
    expect(lineCounter(long.text, 600)(larger) * larger * long.lineHeight > 100.01 || lineCounter(long.text, 600)(larger) > 2).toBe(true);
    // Far too long: the minimum size, the lines that fit, an ellipsis and a warning.
    const endless = headingWith('MEGA FESTIVE CASHBACK OFFER '.repeat(12).trim());
    const cut = fit(endless);
    expect(cut).toMatchObject({ fontPx: 38, visibleLines: 2, shrunk: true, truncated: true });
    expect(cut.lines).toBeGreaterThan(2);
    expect(textFitWarning(endless, cut)).toContain('"Heading" does not fit its box even at the smallest font size: 2 of');
    // Deterministic, and the geometry is the template's in every case.
    expect(fit(endless)).toEqual(cut);
    for (const element of [short, long, endless]) expect(element.box).toEqual(toPixels(HEADING, SQUARE));
    expect(layoutOf(template, 'heading')).toEqual(HEADING);
  });

  it('follows the element\'s own policy: ellipsis without shrinking, the line limit, and a box too low for one line', () => {
    const long = headingWith('MEGA FESTIVE CASHBACK OFFER');
    expect(fitText({ ...textFitInput(long), overflow: 'ellipsis' }, lineCounter(long.text, 600))).toEqual({ fontPx: 75, lines: 2, visibleLines: 1, shrunk: false, truncated: true });
    // One line allowed: it shrinks further than the two-line case, within the same box.
    const oneLine = fitText({ ...textFitInput(long), maxLines: 1 }, lineCounter(long.text, 600));
    expect(oneLine).toMatchObject({ lines: 1, visibleLines: 1, truncated: false });
    expect(oneLine.fontPx).toBeLessThan(fit(long).fontPx);
    expect(fitText({ boxHeight: 10, fontPx: 40, minFontPx: 20, lineHeight: 1.2, maxLines: 3, overflow: 'shrink' }, () => 1)).toEqual({ fontPx: 20, lines: 1, visibleLines: 1, shrunk: true, truncated: true });
    // The same wording in a taller ratio has more room and shrinks less; the layout is the same fractions.
    const tall = headingWith('MEGA FESTIVE CASHBACK OFFER', designCanvasSize('9:16'));
    expect(toNormalized(tall.box, designCanvasSize('9:16'))).toEqual(HEADING);
    expect(fit(tall).truncated).toBe(false);
  });
});

describe('the library: save, load, versions, duplicate', () => {
  it('20. saving and loading preserves the exact normalized structure', () => {
    const awkward = setElementLayout(campaign(), 'hero', { x: 0.333333, y: 0.142857, width: 0.123457, height: 0.654321, rotation: -37.25 });
    let { library } = saved(awkward);
    const template = latestDesignTemplate(library, 'tpl-festival')!;
    library = saveCreative(library, setCreativeOverride(createCreative(template, { id: 'c1', name: 'Diwali', now: NOW }), template, 'heading', { text: 'Diwali Offer' }, NOW), NOW).library;
    const text = serializeLibrary(library), loaded = parseLibrary(text);
    expect(loaded).toEqual(library);
    expect(loaded.rejected).toBeUndefined();
    for (const element of awkward.elements) for (const key of ['x', 'y', 'width', 'height', 'rotation'] as const) expect(findElement(loaded.templates[0], element.id)!.layout[key]).toBe(element.layout[key]);
    // Saving again what was loaded writes the same text: nothing drifts between sessions.
    expect(serializeLibrary(loaded)).toBe(text);
    expect(serializeLibrary(parseLibrary(serializeLibrary(loaded)))).toBe(text);
    // Only normalized geometry is stored: no pixel of any canvas.
    expect(text).not.toMatch(/1080|1350|1920|px/);
    expect(listDesignTemplates(loaded).map(item => [item.name, item.version])).toEqual([['Festival Campaign', 1]]);
    expect(creativesOf(loaded, 'tpl-festival').map(creative => creative.name)).toEqual(['Diwali']);
  });

  it('sets malformed stored entries aside with their problems and keeps them in storage, never repairing or dropping them', () => {
    const { library } = saved();
    const stored = JSON.parse(serializeLibrary(library)) as { templates: unknown[]; creatives: unknown[] };
    const negative = { ...campaign('tpl-broken'), elements: campaign('tpl-broken').elements.map(element => element.id === 'heading' ? { ...element, layout: { ...element.layout, x: -2 } } : element) };
    stored.templates.push(negative, { id: 'junk' }, stored.templates[0]);
    stored.creatives.push({ ...createCreative(library.templates[0], { id: 'orphan', name: 'Orphan', now: NOW }), templateVersion: 7 }, 'not a creative');
    const loaded = parseLibrary(JSON.stringify(stored));
    expect(loaded.templates).toEqual(library.templates);
    expect(loaded.creatives).toEqual([]);
    expect(loaded.rejected!.map(entry => [entry.kind, entry.problems[0]])).toEqual([
      ['template', 'elements[4].layout: x -2 is negative.'], ['template', expect.stringContaining('schemaVersion')], ['template', 'id: The same template version is stored twice.'],
      ['creative', 'templateVersion: template tpl-festival version 7 is missing.'], ['creative', 'creative: A creative must be an object.'],
    ]);
    // Written back exactly as they were found.
    expect(JSON.parse(serializeLibrary(loaded))).toEqual(stored);
    for (const text of ['', 'not json', '[]', '{"schemaVersion":9,"templates":[],"creatives":[]}', '{"schemaVersion":1}']) expect(() => parseLibrary(text)).toThrow(TemplateError);
    // An invalid draft is refused when saving; the library is left as it was.
    expect(() => saveDesignTemplate(library, negative as DesignTemplate, LATER)).toThrow('x -2 is negative');
    expect(() => saveDesignTemplate(library, { ...campaign('t2'), name: '   ' }, LATER)).toThrow('A name must be');
  });

  it('19. a saved version is immutable: editing a template adds a version and leaves existing creatives exactly as they were', () => {
    let { library } = saved();
    const v1 = latestDesignTemplate(library, 'tpl-festival')!;
    const diwali = setCreativeOverride(createCreative(v1, { id: 'c-diwali', name: 'Diwali', now: NOW }), v1, 'heading', { text: 'Diwali Offer' }, NOW);
    library = saveCreative(library, diwali, NOW).library;
    const renderedBefore = JSON.stringify(resolveTemplate(v1, SQUARE, diwali));
    // The author moves the heading, locks its colour and removes the logo, then saves.
    let draft = setElementLayout(v1, 'heading', { x: 0.3, y: 0.4 });
    draft = updateElement(draft, 'heading', element => ({ ...element, editableProperties: { ...element.editableProperties, color: false } }));
    draft = removeElement(draft, 'logo');
    const second = saveDesignTemplate(library, draft, LATER);
    expect(second.outcome).toBe('new-version');
    expect(second.template).toMatchObject({ id: 'tpl-festival', version: 2, createdAt: NOW, updatedAt: LATER });
    library = second.library;
    expect(designTemplateVersions(library, 'tpl-festival').map(template => template.version)).toEqual([1, 2]);
    // Version 1 is byte for byte what it was, and the existing creative still renders with it.
    expect(designTemplateVersion(library, 'tpl-festival', 1)).toEqual(v1);
    const pinned = designTemplateVersion(library, diwali.templateId, diwali.templateVersion)!;
    expect(JSON.stringify(resolveTemplate(pinned, SQUARE, library.creatives[0]))).toBe(renderedBefore);
    expect(library.creatives[0].templateVersion).toBe(1);
    expect(() => applyCreative(second.template, library.creatives[0])).toThrow('not tpl-festival version 2');
    // The list shows the newest version; a new creative uses it.
    expect(listDesignTemplates(library).map(template => template.version)).toEqual([2]);
    expect(createCreative(latestDesignTemplate(library, 'tpl-festival')!, { id: 'c-new', name: 'New', now: LATER }).templateVersion).toBe(2);
    // Moving the old creative to version 2 happens only on request, and says what could not be carried over.
    const withColour = saveCreative(library, setCreativeOverride(setCreativeOverride(library.creatives[0], v1, 'heading', { color: '#B71C1C' }, LATER), v1, 'logo', { assetId: 'logo-2' }, LATER), LATER);
    const upgraded = upgradeCreative(withColour.creative, second.template, LATER);
    expect(upgraded.creative).toMatchObject({ templateVersion: 2, contentOverrides: { heading: { text: 'Diwali Offer' } } });
    expect(upgraded.dropped).toEqual(['Heading: color is locked by the template.', 'Element "logo" no longer exists in version 2.']);
    expect(layoutOf(second.template, 'heading')).toMatchObject({ x: 0.3, y: 0.4 });
    expect(applyCreative(second.template, upgraded.creative).ignored).toEqual([]);

    // Saving without a structural change adds no version; a new name renames without one.
    expect(saveDesignTemplate(library, second.template, LATER)).toMatchObject({ outcome: 'unchanged', library });
    const renamed = saveDesignTemplate(library, { ...second.template, name: 'Bank Festival Offer' }, LATER);
    expect(renamed.outcome).toBe('renamed');
    expect(designTemplateVersions(renamed.library, 'tpl-festival').map(template => [template.name, template.version])).toEqual([['Bank Festival Offer', 1], ['Bank Festival Offer', 2]]);
    expect(renameDesignTemplate(library, 'tpl-festival', '  Festival 2026 ', LATER).templates.map(template => template.name)).toEqual(['Festival 2026', 'Festival 2026']);
    expect(() => renameDesignTemplate(library, 'tpl-festival', ' ', LATER)).toThrow('A name must be');
    // Old versions are never removed automatically: version 2, which no creative uses, is still there after version 3.
    const third = saveDesignTemplate(library, setElementLayout(second.template, 'cta', { y: 0.7 }), LATER);
    expect(designTemplateVersions(third.library, 'tpl-festival').map(template => template.version)).toEqual([1, 2, 3]);
    expect(designTemplateVersion(third.library, 'tpl-festival', 1)).toEqual(v1);
    expect(designTemplateVersion(third.library, 'tpl-festival', 2)).toEqual(second.template);
    // A version saved together with a new name: every version carries the new label, and nothing else in them changes.
    const fourth = saveDesignTemplate(third.library, { ...setElementLayout(third.template, 'cta', { y: 0.6 }), name: 'Festival 2027' }, LATER);
    expect(designTemplateVersions(fourth.library, 'tpl-festival').map(template => [template.name, template.version])).toEqual([['Festival 2027', 1], ['Festival 2027', 2], ['Festival 2027', 3], ['Festival 2027', 4]]);
    expect(designTemplateVersion(fourth.library, 'tpl-festival', 1)).toEqual({ ...v1, name: 'Festival 2027' });
    // Versions go only with their whole template, once no creative uses it.
    const emptied = deleteDesignTemplate({ ...fourth.library, creatives: [] }, 'tpl-festival');
    expect(emptied.templates).toEqual([]);
    // A creative cannot be saved against a version that is not there, or with content its version locks.
    expect(() => saveCreative(library, { ...diwali, id: 'x', templateVersion: 9 }, LATER)).toThrow('version 9 is not in the library');
    expect(() => saveCreative(library, { ...diwali, id: 'x', contentOverrides: { heading: { layout: { x: 0.9 } } } }, LATER)).toThrow('position is locked');
    // A template in use cannot be deleted from under its creatives.
    expect(() => deleteDesignTemplate(library, 'tpl-festival')).toThrow('1 creative use');
  });

  it('18. duplicating creates a new template id with the same structure, independent of the original', () => {
    let { library } = saved();
    const original = latestDesignTemplate(library, 'tpl-festival')!;
    library = saveCreative(library, createCreative(original, { id: 'c1', name: 'Diwali', now: NOW }), NOW).library;
    const copy = duplicateDesignTemplate(library, 'tpl-festival', 'tpl-premium', LATER, 'Bank Premium Festival Template');
    expect(copy.template).toMatchObject({ id: 'tpl-premium', name: 'Bank Premium Festival Template', version: 1, createdAt: LATER });
    expect(copy.template.id).not.toBe(original.id);
    expect(copy.template.elements).toEqual(original.elements);
    expect(copy.template.supportedAspectRatios).toEqual(original.supportedAspectRatios);
    expect(listDesignTemplates(copy.library).map(template => template.id).sort()).toEqual(['tpl-festival', 'tpl-premium']);
    // The creatives stay with the original, and editing the copy changes nothing in it.
    expect(creativesOf(copy.library, 'tpl-premium')).toEqual([]);
    const edited = saveDesignTemplate(copy.library, setElementLayout(copy.template, 'heading', { y: 0.5 }), LATER);
    expect(layoutOf(latestDesignTemplate(edited.library, 'tpl-festival')!, 'heading')).toEqual(HEADING);
    expect(latestDesignTemplate(edited.library, 'tpl-premium')).toMatchObject({ version: 2 });
    expect(duplicateDesignTemplate(library, 'tpl-festival', 'tpl-default-name', LATER).template.name).toBe('Festival Campaign copy');
    expect(() => duplicateDesignTemplate(library, 'tpl-festival', 'tpl-festival', LATER)).toThrow('already used');
    expect(() => duplicateDesignTemplate(library, 'nope', 'new', LATER)).toThrow('no template');
    expect(deleteDesignTemplate(copy.library, 'tpl-premium').templates.map(template => template.id)).toEqual(['tpl-festival']);
  });
});

describe('no AI, no network', () => {
  it('builds, saves, reloads and renders a template and its creatives with no key, no server and no request of any kind', () => {
    const request = vi.fn(() => { throw new Error('The template system must not make requests.'); });
    vi.stubGlobal('fetch', request);
    vi.stubGlobal('XMLHttpRequest', request);
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('FAL_KEY', '');
    try {
      let library = saved().library;
      const template = latestDesignTemplate(library, 'tpl-festival')!;
      for (const [id, name, text, ratio] of [['a', 'Diwali', 'Diwali Offer', '1:1'], ['b', 'Holi', 'Holi Offer', '4:5'], ['c', 'Christmas', 'Christmas Offer', '9:16']] as const) {
        library = saveCreative(library, setCreativeOverride(createCreative(template, { id, name, now: NOW, aspectRatio: ratio }), template, 'heading', { text }, NOW), NOW).library;
      }
      library = parseLibrary(serializeLibrary(library));
      for (const creative of library.creatives) {
        const pinned = designTemplateVersion(library, creative.templateId, creative.templateVersion)!;
        const resolved = resolveTemplate(pinned, designCanvasSize(creative.aspectRatio), creative);
        expect(toNormalized(resolved.find(element => element.id === 'heading')!.box, designCanvasSize(creative.aspectRatio))).toEqual(HEADING);
      }
      expect(library.creatives.map(creative => creative.contentOverrides.heading.text)).toEqual(['Diwali Offer', 'Holi Offer', 'Christmas Offer']);
      expect(request).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });
});
