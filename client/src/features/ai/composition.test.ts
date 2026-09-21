import { describe, expect, it } from 'vitest';
import { CANVAS_PRESETS, type CanvasSize } from '@frameflow/shared';
import { composeText, emptyContent, quietRegion, type EventContent } from './composition';
import { boundsFit, type MeasureText } from '../../lib/layout/autoLayout';

// A deterministic measurement double tests composition policy; Chrome covers real fonts.
const measure: MeasureText = (element) => {
  const lines = element.text.split('\n').reduce((count, line) => count + Math.max(1, Math.ceil(Array.from(line).length * element.fontSize / 2 / element.width)), 0);
  return { width: element.width, height: lines * element.fontSize * element.lineHeight, lines, complete: true };
};
const content: EventContent = {
  eyebrow: '  Together with their families  ', title: 'Aarav & Meera\n♥',
  date: '12 December 2026 · 7:00 PM', venue: 'The Grand Royal Wedding Palace,\nConnaught Place, New Delhi, India',
};
function compose(values = content, canvas: CanvasSize = CANVAS_PRESETS[0]) {
  let counter = 0;
  return composeText(values, canvas, measure, () => `text-${++counter}`);
}

describe('generated artwork editable text composition', () => {
  it.each(CANVAS_PRESETS)('preserves exact wording inside separate quiet-region rows for $name', (canvas) => {
    const before = structuredClone(content);
    const { elements, unresolved } = compose(content, canvas);
    const normalized = quietRegion(canvas);
    const region = { x: normalized.x * canvas.width, y: normalized.y * canvas.height, width: normalized.width * canvas.width, height: normalized.height * canvas.height };
    expect(unresolved).toEqual([]);
    expect(elements.map((element) => element.role)).toEqual(['eyebrow', 'title', 'date', 'venue']);
    expect(elements.map((element) => element.text)).toEqual(Object.values(content));
    expect(new Set(elements.map((element) => element.id)).size).toBe(4);
    for (const [index, element] of elements.entries()) {
      expect(boundsFit(element, measure(element), region)).toBe(true);
      expect(element.align).toBe(canvas.width > canvas.height ? 'left' : 'center');
      if (index > 0) expect(elements[index - 1].y + measure(elements[index - 1]).height).toBeLessThanOrEqual(element.y + 1);
    }
    expect(content).toEqual(before);
  });

  it('creates no invented event wording and omits unspecified fields', () => {
    expect(compose(emptyContent)).toEqual({ elements: [], unresolved: [] });
    const result = compose({ ...emptyContent, venue: 'Only the venue was supplied' });
    expect(result.elements).toHaveLength(1);
    expect(result.elements[0]).toMatchObject({ role: 'venue', text: 'Only the venue was supplied' });
  });

  it('keeps impossible exact content and reports its role instead of truncating', () => {
    const longVenue = 'Every line remains editable 👩🏽‍🎨\n'.repeat(100);
    const result = compose({ ...emptyContent, venue: longVenue }, { width: 256, height: 256 });
    expect(result.unresolved).toEqual(['venue']);
    expect(result.elements[0].text).toBe(longVenue);
    expect(Number.isFinite(result.elements[0].fontSize)).toBe(true);
  });

  it.each([{ width: 4096, height: 256 }, { width: 256, height: 4096 }])('keeps a normalized quiet region within custom canvas %o', (canvas) => {
    const region = quietRegion(canvas);
    expect(region.x).toBeGreaterThanOrEqual(0);
    expect(region.y).toBeGreaterThanOrEqual(0);
    expect(region.x + region.width).toBeLessThanOrEqual(1);
    expect(region.y + region.height).toBeLessThanOrEqual(1);
    expect(compose({ ...emptyContent, title: 'A' }, canvas).elements[0].text).toBe('A');
  });
});
