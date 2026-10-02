import { IMAGE_TEMPLATE_LIMITS, parseReferenceCreative, type ReferenceCreativeDraft } from '@frameflow/shared';
import type { ImageTemplate } from '../imageTemplates/imageTemplates';
export const REFERENCE_LAST_KEY = 'frameflow:reference-creative:last';
export const referenceDraftKey = (id: string) => `frameflow:reference-creative:draft:${id}`;
/** Local unsaved edits contain only bounded strings and IDs. Uploaded pixels stay in the existing server asset store. */
export function readReferenceEdits(storage: Pick<Storage, 'getItem'>, template: ImageTemplate): { name: string; draft?: ReferenceCreativeDraft } {
  if (template.generatedAt) return { name: template.name, draft: template.referenceCreative };
  const raw = storage.getItem(referenceDraftKey(template.id));
  if (!raw) return { name: template.name, draft: template.referenceCreative };
  const saved = JSON.parse(raw);
  if (saved.sourceId !== template.id || saved.analysisStartedAt !== template.promptGeneration?.startedAt) return { name: template.name, draft: template.referenceCreative };
  return { name: typeof saved.name === 'string' && saved.name.length <= IMAGE_TEMPLATE_LIMITS.name ? saved.name : template.name, draft: saved.draft ? parseReferenceCreative(saved.draft) : template.referenceCreative };
}
export function writeReferenceEdits(storage: Pick<Storage, 'setItem'>, template: ImageTemplate, name: string, draft?: ReferenceCreativeDraft) {
  storage.setItem(referenceDraftKey(template.id), JSON.stringify({ sourceId: template.id, analysisStartedAt: template.promptGeneration?.startedAt, name, draft }));
  storage.setItem(REFERENCE_LAST_KEY, template.id);
}
/** Each source/view gets a ticket. Changing it invalidates all older uploads, polls and actions synchronously. */
export function referenceRequestGuard() {
  let current = 0;
  const active = new Set<number>();
  return { ticket: () => current, replace: () => ++current, accepts: (ticket: number) => ticket === current,
    begin: (ticket: number) => { if (ticket !== current || active.has(ticket)) return false; active.add(ticket); return true; },
    finish: (ticket: number) => active.delete(ticket) };
}
