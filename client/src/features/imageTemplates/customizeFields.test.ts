import { describe, expect, it } from 'vitest';
import { parseSceneDescription } from '@frameflow/shared';
import { customizeFields, fieldValue, withField } from './CustomizePanel';

const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h, certainty: 'tight' as const });
const id0 = { brand: '', model: '', evidence: '', confidence: 0, markings: 'none' as const };
const object = (id: string, kind: string, importance: string, category: string, b: ReturnType<typeof box>) => ({ id, kind, importance, category, description: category, box: b, occluded: false, properties: [], identity: id0, confidence: 0.9 });
const scene = (objects: ReturnType<typeof object>[], main: string[]) => parseSceneDescription({ summary: 's', objects, relations: [], marks: [], text_overlays: [], lighting: { direction: 'top', quality: 'soft', color: 'neutral' }, main_candidates: main, uncertainties: [] });

describe('Customize your creative: fields from the image itself', () => {
  it('three products give three product fields, left to right, each paired with its own object; stands and background follow', () => {
    const s = scene([object('bg', 'scenery', 'background', 'kitchen backdrop', box(0, 0, 1, 1)), object('c', 'product', 'main', 'kettle', box(0.7, 0.4, 0.2, 0.3)),
      object('a', 'product', 'main', 'toaster', box(0.1, 0.4, 0.2, 0.3)), object('b', 'product', 'main', 'blender', box(0.4, 0.3, 0.2, 0.4)), object('p', 'furniture', 'supporting', 'display pedestal', box(0.05, 0.7, 0.9, 0.1))], ['a', 'b', 'c']);
    const fields = customizeFields(s);
    expect(fields.filter(f => f.group === 'products').map(f => [f.title, f.detail])).toEqual([['Product 1', 'Toaster'], ['Product 2', 'Blender'], ['Product 3', 'Kettle']]);
    expect(fields.filter(f => f.group === 'scene').map(f => f.title)).toEqual(['Background', 'Display stands']);
    const draft = withField({ edits: {}, corrections: {} }, fields[0], 'Premium sports bike', '');
    expect(draft.edits).toEqual({ toaster_1: { action: 'replace', value: 'Premium sports bike' } });
    expect(fieldValue(draft, fields[0]).value).toBe('Premium sports bike');
    expect(withField(draft, fields[0], '', '').edits).toEqual({});
  });
  it('one watch gives one product field, no numbering', () => {
    const fields = customizeFields(scene([object('bg', 'scenery', 'background', 'studio', box(0, 0, 1, 1)), object('w', 'product', 'main', 'watch', box(0.3, 0.3, 0.4, 0.4)), object('p', 'furniture', 'supporting', 'platform', box(0.2, 0.7, 0.6, 0.1))], ['w']));
    expect(fields.map(f => f.title)).toEqual(['Product', 'Background', 'Display stands']);
  });
});
