import { expect, it } from 'vitest';
import { createReferenceCreative, parseImageAnalysisResponse } from '@frameflow/shared';
import { referenceCreativeFixture } from '../../../../server/src/decomposition/referenceCreative.fixture';
import type { ImageTemplate } from '../imageTemplates/imageTemplates';
import { readReferenceEdits, referenceDraftKey, referenceRequestGuard, writeReferenceEdits } from './referenceDraft';
const analysis = parseImageAnalysisResponse(referenceCreativeFixture).analysis;
const template = { id: 'source-a', name: 'Headphones', analysis, promptGeneration: { startedAt: 'one' }, referenceCreative: createReferenceCreative(analysis) } as ImageTemplate;
const storage = () => { const entries = new Map<string,string>(); return { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); } }; };
it('source replacement invalidates old uploads, analysis, poll and generation completions', () => {
  const guard = referenceRequestGuard(), sourceA = guard.ticket(); expect(guard.begin(sourceA)).toBe(true);
  const sourceB = guard.replace(); expect(guard.accepts(sourceA)).toBe(false); expect(guard.begin(sourceB)).toBe(true);
  guard.finish(sourceA); expect(guard.begin(sourceB)).toBe(false); expect(guard.accepts(sourceB)).toBe(true);
});
it('double generate is blocked until the accepted action finishes; explicit retry gets one ticket', () => {
  const guard = referenceRequestGuard(), ticket = guard.ticket(); expect(guard.begin(ticket)).toBe(true); expect(guard.begin(ticket)).toBe(false);
  guard.finish(ticket); expect(guard.begin(ticket)).toBe(true);
});
it('persists IDs and local custom edits without image pixels; reload is a read only operation', () => {
  const memory = storage(), draft = { ...template.referenceCreative!, mode: 'custom' as const, prompt: 'A silver phone in the same campaign style and typography.' };
  writeReferenceEdits(memory, template, 'Phone campaign', draft);
  expect(readReferenceEdits(memory, template)).toEqual({ name: 'Phone campaign', draft });
  expect(memory.getItem(referenceDraftKey(template.id))).not.toContain('base64');
});
it('new analysis invalidates earlier local edits; generated settings cannot be replaced by local edits', () => {
  const memory = storage(), edited = { ...template.referenceCreative!, prompt: 'local edit' };
  writeReferenceEdits(memory, template, 'Edited', edited);
  expect(readReferenceEdits(memory, { ...template, promptGeneration: { ...template.promptGeneration!, startedAt: 'two' } }).draft).toEqual(template.referenceCreative);
  expect(readReferenceEdits(memory, { ...template, generatedAt: 'now' }).draft).toEqual(template.referenceCreative);
});
