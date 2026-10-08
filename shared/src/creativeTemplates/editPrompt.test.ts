import { describe, expect, it } from 'vitest';
import { compileEditPrompt, compileSlotInstruction, GENERATE_UNCHANGED_INSTRUCTION, templateContentSlots } from './editPrompt.js';
import type { TemplateVersion } from './types.js';
const version = { generationPrompt: { text: 'Preserve the saved composition. User changes: {{edit_instruction}}' }, structure: { layers: [
  { id: 'person', role: 'primary_subject', independent: true }, { id: 'object', role: 'held_object', independent: false, attachment: { parent: 'person', keepWithParent: true } },
  { id: 'background', role: 'background', independent: true }, { id: 'shadow', role: 'effect', independent: false },
], relationships: [] } } as unknown as TemplateVersion;
describe('local template content compilation', () => {
  it('exposes the saved content roles, including a held object that remains grouped in decomposition', () => {
    expect(templateContentSlots(version).map(slot => slot.id)).toEqual(['person', 'object', 'background']);
    const values = { person: 'young man wearing blue jacket', object: 'football', background: 'stadium at night' };
    const prompt = compileEditPrompt(version.generationPrompt, compileSlotInstruction(version, values));
    expect(prompt).toContain('Primary subject (same position): young man wearing blue jacket');
    expect(prompt).toContain('Held object (same position): football'); expect(prompt).toContain('Background (same position): stadium at night');
    expect(version.generationPrompt.text).toContain('{{edit_instruction}}');
    expect(version.structure.layers[1].independent).toBe(false);
  });
  it('validates unsupported fields and bounds before any request, and compiles explicit no-change generation', () => {
    expect(() => compileSlotInstruction(version, { cta: 'Buy now' })).toThrow(/saved template field/);
    expect(() => compileSlotInstruction(version, { person: 'x'.repeat(121) })).toThrow(/120/);
    expect(compileSlotInstruction(version, { object: '   ' })).toBe('');
    expect(compileEditPrompt(version.generationPrompt, GENERATE_UNCHANGED_INSTRUCTION)).toContain('Generate a new creative');
  });
});
