/**
 * Prompt templates: a reusable instruction with slot placeholders, compiled locally with one creative's values.
 *
 *   {{slot}}                the value (sanitized)
 *   {{#slot}}…{{/slot}}     only when the slot has a value
 *   {{^slot}}…{{/slot}}     only when it has none ("keep what the reference shows")
 *
 * Sections do not nest. Every placeholder must be a declared slot, so a template can never carry an earlier creative's
 * content: what changes per creative is a value, never template text.
 */

const SECTION = /\{\{([#^])([a-zA-Z][\w-]*)\}\}([\s\S]*?)\{\{\/\2\}\}/g;
const VALUE = /\{\{([a-zA-Z][\w-]*)\}\}/g;
const ANY = /\{\{[#^/]?([a-zA-Z][\w-]*)\}\}/g;
export const SLOT_VALUE_LIMIT = 140;

export class PromptTemplateError extends Error { constructor(message: string) { super(message); this.name = 'PromptTemplateError'; } }

/** Every placeholder name a template uses. */
export function templatePlaceholders(template: string): string[] {
  return [...new Set([...template.matchAll(ANY)].map(m => m[1]))];
}
/** Problems with a template against its declared slots: unknown placeholders, unbalanced or nested sections. */
export function templateProblems(template: string, slots: readonly string[]): string[] {
  const problems: string[] = [];
  for (const name of templatePlaceholders(template)) if (!slots.includes(name)) problems.push(`Unknown placeholder {{${name}}}.`);
  const stripped = template.replace(SECTION, (_m, _k, _n, body: string) => {
    if (/\{\{[#^/]/.test(body)) problems.push('Nested sections are not supported.');
    return '';
  });
  if (/\{\{[#^/]/.test(stripped)) problems.push('Unbalanced section.');
  return [...new Set(problems)];
}

/**
 * One value as it goes into a prompt: plain words, bounded, no braces, newlines or markup, so a value can never open a
 * placeholder or a section of its own.
 */
export function sanitizeSlotValue(value: unknown, limit = SLOT_VALUE_LIMIT): string {
  if (typeof value !== 'string') return '';
  // Deliberately remove control characters from untrusted slot text.
  // eslint-disable-next-line no-control-regex
  const clean = value.normalize('NFC').replace(/[{}<>`\\]/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (clean.length <= limit) return clean;
  const cut = clean.slice(0, limit + 1), space = cut.lastIndexOf(' ');
  return (space > limit * 0.6 ? cut.slice(0, space) : clean.slice(0, limit)).trim();
}

/** Compiles a template with values. Throws on an undeclared placeholder; empty or missing values select the {{^slot}} text. */
export function compileTemplate(template: string, values: Record<string, unknown>, slots: readonly string[] = Object.keys(values)): string {
  const problems = templateProblems(template, slots);
  if (problems.length) throw new PromptTemplateError(problems.join(' '));
  const value = (name: string) => sanitizeSlotValue(values[name]);
  const out = template
    .replace(SECTION, (_m, kind: string, name: string, body: string) => (kind === '#') === Boolean(value(name)) ? body : '')
    .replace(VALUE, (_m, name: string) => value(name));
  return out.replace(/[ \t]+/g, ' ').replace(/ ([.,;:])/g, '$1').replace(/\s*\n\s*/g, '\n').trim();
}
