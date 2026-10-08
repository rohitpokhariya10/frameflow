import { describe, expect, it, vi } from 'vitest';
import { liveStructureInspector, parseStructure, STRUCTURE_SCHEMA } from './inspect.js';

const answer = () => ({ confidence: 0.96, elements: [
  { id: 'background', role: 'background', zone: 'full-canvas', independent: true, parent: '', attachment: 'none', keepWithParent: false, currentValue: 'Green studio' },
  { id: 'person', role: 'primary_subject', zone: 'center', independent: true, parent: '', attachment: 'none', keepWithParent: false, currentValue: 'Baby' },
  { id: 'held', role: 'held_object', zone: 'bottom-right', independent: true, parent: 'person', attachment: 'held_in_hand', keepWithParent: false, currentValue: 'Ball' },
], relationships: [{ source: 'person', relation: 'holds', target: 'held' }] });
describe('structure-only inspection', () => {
  it('separates content from structure and validates attachment references and cycles', () => {
    const parsed = parseStructure(answer());
    expect(JSON.stringify(parsed.structure)).not.toMatch(/Baby|Ball|Green studio/);
    expect(parsed.values).toMatchObject({ person: 'Baby', held: 'Ball' });
    const broken = answer(); broken.elements[2].parent = 'missing';
    expect(() => parseStructure(broken)).toThrow(/could not be validated/);
    const cyclic = answer(); cyclic.elements[1].attachment = 'part_of_object'; cyclic.elements[1].parent = 'held';
    expect(() => parseStructure(cyclic)).toThrow(/could not be validated/);
    expect(() => parseStructure({ ...answer(), confidence: 2 })).toThrow(/could not be validated/);
  });
  it('makes one schema-only call and retains usage evidence without persisting inline image bytes', async () => {
    const create = vi.fn(async () => ({ status: 'completed', output_text: JSON.stringify(answer()), usage: { input_tokens: 1400, output_tokens: 350 } }));
    const save = vi.fn();
    const inspector = liveStructureInspector({ model: 'offline-structure', client: { responses: { create } } as never });
    expect((await inspector.inspect(Buffer.from('offline-image-bytes'), 'image/png', save)).confidence).toBe(0.96);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: 'offline-structure', text: { format: { type: 'json_schema', name: 'creative_structure', schema: STRUCTURE_SCHEMA, strict: true } } }));
    expect(JSON.stringify(save.mock.calls)).not.toContain(Buffer.from('offline-image-bytes').toString('base64'));
    expect(save).toHaveBeenCalledWith('structure.openai-response.json', expect.objectContaining({ usage: { input_tokens: 1400, output_tokens: 350 } }));
  });
  it('retains the response for billing when an invalid answer forces the planner fallback', async () => {
    const create = vi.fn(async () => ({ status: 'completed', output_text: '{}', usage: { input_tokens: 1400, output_tokens: 2 } })), save = vi.fn();
    await expect(liveStructureInspector({ client: { responses: { create } } as never }).inspect(Buffer.from('fixture'), 'image/png', save)).rejects.toThrow(/could not be validated/);
    expect(create).toHaveBeenCalledTimes(1);
    expect(save.mock.calls.map(c => c[0])).toEqual(['structure.openai-request.json', 'structure.openai-response.json', 'structure.error.json']);
  });
});
