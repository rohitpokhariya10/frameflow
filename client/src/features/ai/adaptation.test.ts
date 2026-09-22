import { describe, expect, it } from 'vitest';
import { CANVAS_PRESETS, type DesignVariant } from '@frameflow/shared';
import { adaptText } from './adaptation';
import { composeText } from './composition';
import { referenceSize } from '../../lib/assets/referenceImage';
import { type MeasureText } from '../../lib/layout/autoLayout';
import { safeRegion } from '../../lib/layout/constants';
const measure: MeasureText = (e) => {
  const lines = e.text.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil([...line].length * e.fontSize / 2 / e.width)), 0);
  return { width: e.width, height: lines * e.fontSize * e.lineHeight, lines, complete: true };
};
const content = { eyebrow: '  With family  ', title: 'Aarav & Meera\n♥', date: '12 December · 7 PM', venue: 'The Grand Royal Wedding Palace,\nConnaught Place, New Delhi, India' };
let id = 0;
const source: DesignVariant = { id: 'source', name: 'Source', revision: 4, canvas: { ...CANVAS_PRESETS[0], backgroundColor: '#FFFEFA' },
  elements: composeText(content, CANVAS_PRESETS[0], measure, () => `text-${++id}`).elements };
describe('deterministic exact-text adaptation', () => {
  it.each(CANVAS_PRESETS)('preserves all identities, wording and styling in distinct $id regions', (target) => {
    const before = structuredClone(source), result = adaptText(source, target, target.id, measure);
    expect(source).toEqual(before); expect(result.unresolved).toEqual([]);
    expect(result.elements.map((e) => e.text)).toEqual(Object.values(content));
    for (const [i, e] of result.elements.entries()) {
      expect(e).toMatchObject({ id: source.elements[i].id, type: 'text', role: source.elements[i].role, fontFamily: source.elements[i].fontFamily, fontWeight: source.elements[i].fontWeight, fill: source.elements[i].fill });
      expect(e.align).toBe(target.id === 'landscape' ? 'left' : 'center');
      if (target.id === 'landscape') {
        expect(e.x).toBeGreaterThan(target.width * .4);
        if (e.role === 'title') expect(e.fontSize).toBe(60);
      }
      if (i) expect(result.elements[i - 1].y + measure(result.elements[i - 1]).height).toBeLessThanOrEqual(e.y);
    }
  });
  it('gives duplicate semantic roles separate rows and retains empty text', () => {
    const original = source.elements[0];
    const result = adaptText({ ...source, elements: [original, { ...original, id: 'second', text: 'Another eyebrow' }, { ...original, id: 'empty', text: '' }] }, CANVAS_PRESETS[2], 'landscape', measure);
    expect(result.elements).toHaveLength(3); expect(result.elements[1].y).toBeGreaterThan(result.elements[0].y); expect(result.elements[2].text).toBe('');
  });
  it('maps custom positions proportionally, preserves alignment and resolves a simple collision', () => {
    const custom = { ...source.elements[0], role: 'custom' as const, x: 100, y: 100, width: 300, fontSize: 24, align: 'right' as const };
    const target = { width: 2160, height: 2700 };
    const result = adaptText({ ...source, elements: [custom, { ...custom, id: 'duplicate' }] }, target, 'custom', measure);
    expect(result.elements[0]).toMatchObject({ x: 200, y: 200, width: 600, align: 'right', fontSize: 48 });
    expect(result.elements[1].y).toBeGreaterThan(result.elements[0].y + measure(result.elements[0]).height);
    expect(result.unresolved).toEqual([]);
  });
  it('clamps custom boxes into safe bounds and flags impossible text without losing a character', () => {
    const text = 'Exact 👩🏽‍🎨 paragraph\n'.repeat(100);
    const result = adaptText({ ...source, elements: [{ ...source.elements[0], x: 4000, y: 6000, text }] }, { width: 256, height: 256 }, 'custom', measure);
    expect(result.elements[0].text).toBe(text); expect(result.elements[0].x).toBeGreaterThanOrEqual(safeRegion({ width: 256, height: 256 }).x);
    expect(result.unresolved).toContain(source.elements[0].id);
  });
  it.each([{ width: 816, height: 1024 }, { width: 4096, height: 256 }, { width: 32, height: 64 }])('prepares bounded reference dimensions without upscaling or stretching %o', (size) => {
    const result = referenceSize(size);
    expect(Math.max(result.width, result.height)).toBeLessThanOrEqual(511);
    expect(result.width).toBeLessThanOrEqual(size.width); expect(result.height).toBeLessThanOrEqual(size.height);
    expect(Math.abs(result.width - size.width * result.height / size.height)).toBeLessThanOrEqual(1);
  });
});
