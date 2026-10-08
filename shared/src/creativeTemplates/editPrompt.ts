import { EDIT_INSTRUCTION_SLOT, type GenerationPromptTemplate, type TemplateVersion } from './types.js';
import { TEMPLATE_ROLE_LABELS } from './roles.js';

export const EDIT_INSTRUCTION_LIMIT = 500;
/** A user's edit instruction as it goes into a prompt: plain words, bounded, no braces, markup or control characters. */
export function sanitizeEditInstruction(value: unknown): string {
  if (typeof value !== 'string') return '';
  // Deliberately remove control characters from untrusted instruction text.
  // eslint-disable-next-line no-control-regex
  return value.normalize('NFC').replace(/[{}<>`\\]/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}
/** Problems with an edit instruction ([] = usable). */
export function editInstructionProblems(value: unknown): string[] {
  const clean = sanitizeEditInstruction(value);
  if (!clean) return ['Describe the edit, for example "replace the held object with a red bottle".'];
  if (clean.length > EDIT_INSTRUCTION_LIMIT) return [`The edit instruction is ${clean.length} characters; at most ${EDIT_INSTRUCTION_LIMIT}.`];
  return [];
}
/** The image-edit prompt: the template's saved role-based prompt with this execution's instruction filled in, locally. */
export function compileEditPrompt(template: GenerationPromptTemplate, instruction: string): string {
  const problems = editInstructionProblems(instruction);
  if (problems.length) throw new Error(problems.join(' '));
  if (template.text.split(EDIT_INSTRUCTION_SLOT).length !== 2) throw new Error('The template\'s generation prompt has no edit slot.');
  return template.text.replace(EDIT_INSTRUCTION_SLOT, sanitizeEditInstruction(instruction));
}

/** Content can change even when a slot stays grouped with its parent during decomposition (for example a held ball). */
export const templateContentSlots = (version: TemplateVersion) => version.structure.layers.filter(layer => layer.role !== 'effect');
export const GENERATE_UNCHANGED_INSTRUCTION = 'Generate a new creative from the reference image, preserving its current content and the saved composition.';
/** Shared by the visible preview and server request. No model is used to fill the saved prompt. */
export function compileSlotInstruction(version: TemplateVersion | undefined, values: unknown): string {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Use the selected template fields.');
  const changes: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    const slot = version && templateContentSlots(version).find(layer => layer.id === key);
    if (!slot || typeof value !== 'string' || value.length > 120) throw new Error('Each edit must name a saved template field and contain at most 120 characters.');
    const clean = sanitizeEditInstruction(value);
    if (clean) changes.push(`${TEMPLATE_ROLE_LABELS[slot.role]} (${slot.zone ?? 'same position'}): ${clean}`);
  }
  const instruction = changes.join('; ');
  if (instruction && editInstructionProblems(instruction).length) throw new Error(editInstructionProblems(instruction).join(' '));
  return instruction;
}
