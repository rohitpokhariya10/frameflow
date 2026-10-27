import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PROTECTED_SCHEMA_VERSION, type DetectedWord } from '@frameflow/shared';
import type { RunnerDeps } from '../layerizeExperiment.js';
import { fakeRecognizer } from '../../textRecognition/recognizer.js';
import { replacementLogoPng, VARIATION_ELEMENTS, VARIATION_WORDS, variationPosterPng } from '../../textRecognition/variationPoster.fixture.js';
import { readyVariationTemplate } from '../../textRecognition/variationTemplate.fixture.js';
import { createProtectedTemplates } from './service.js';
import { fileProtectedStore } from './store.js';

const readyTemplate = readyVariationTemplate;

describe('protected template words and logos', { timeout: 30_000 }, () => {
  it('finds Easy, EMI and available. as three words with their own boxes, one phrase on three lines, and logo slots', async () => {
    const { service, template, recognizer, providers } = await readyTemplate();
    const v = await service.analyseText(template.id, template.revision), a = v.textAnalysis!;
    const [easy, emi, available] = ['Easy', 'EMI', 'available.'].map(text => a.words.find(w => w.text === text)!);
    expect([easy, emi, available].every(Boolean)).toBe(true);
    expect(new Set([easy.id, emi.id, available.id]).size).toBe(3);
    // The recognizer's own boxes (tightened to their ink, never split or merged), in source pixels.
    for (const [w, src] of [[easy, VARIATION_WORDS[0]], [emi, VARIATION_WORDS[1]], [available, VARIATION_WORDS[2]]] as const) {
      expect(w.box.x).toBeGreaterThanOrEqual(src.box.x); expect(w.box.y).toBeGreaterThanOrEqual(src.box.y);
      expect(w.box.x + w.box.width).toBeLessThanOrEqual(src.box.x + src.box.width + 0.5); expect(w.box.y + w.box.height).toBeLessThanOrEqual(src.box.y + src.box.height + 0.5);
      expect(w.normalized.x).toBeCloseTo(w.box.x / 900, 5);
      expect(w.review.status).toBe('needs-review');
    }
    expect(easy.groupId).toBe(emi.groupId); expect(emi.groupId).toBe(available.groupId);
    expect(new Set([easy.lineId, emi.lineId, available.lineId]).size).toBe(3);
    expect([easy.order, emi.order, available.order]).toEqual([0, 1, 2]);
    expect(emi.style.fontSize).toBeGreaterThan(easy.style.fontSize * 2);
    expect(easy.style.fontStyle).toBe('italic');
    expect(emi.style.fontWeight).toBe(700);
    expect(emi.style.color.toLowerCase()).toMatch(/^#0[0-9a-f]5[0-9a-f]5[0-9a-f]$/);
    // Claims, durations and legal text are protected; the low-confidence "apply" waits for review.
    expect(a.words.find(w => w.text === '3-6-9-12')!.role).toBe('duration');
    expect(a.words.find(w => w.text === 'T&Cs')!.protected).toBe(true);
    expect(v.wordProblems!.some(p => p.code === 'LOW_CONFIDENCE' && p.message.includes('apply'))).toBe(true);
    // Three bank cards (a grid) and the brand logo, each its own slot with its exact source pixels.
    const cards = a.logoSlots.filter(l => l.detection === 'tile-grid'), brand = a.logoSlots.find(l => l.detection === 'element')!;
    expect(cards).toHaveLength(3);
    expect(cards.map(c => Math.round(c.box.x))).toEqual([80, 300, 520]);
    expect(brand.box).toMatchObject({ x: 640, y: 50, width: 220, height: 100 });
    expect(a.engine.local).toBe(true);
    // Only the template regions were read; nothing else was called.
    expect(recognizer.calls.every(c => c.purpose === 'template')).toBe(true);
    expect(providers).toEqual({ planner: 0, transport: 0 });
    // The analysis does not touch the protected elements: the base and its approval stay current.
    expect(v.elementsRevision).toBe(template.elementsRevision); expect(v.stale.base).toBe(false); expect(v.base?.approval).toBeTruthy();
    expect(v.schemaVersion).toBe(PROTECTED_SCHEMA_VERSION);
  });

  it('keeps corrections with a review history, and keeps ids and corrections when the words are found again', async () => {
    const { service, template } = await readyTemplate();
    let v = await service.analyseText(template.id, template.revision);
    const a = v.textAnalysis!, emi = a.words.find(w => w.text === 'EMI')!, apply = a.words.find(w => w.text === 'apply')!;
    const words: DetectedWord[] = a.words.map(w => w.id === apply.id ? { ...w, text: 'apply*', review: { status: 'approved' } } : w.id === emi.id ? { ...w, box: { ...w.box, x: w.box.x + 4 }, review: { status: 'approved' } } : w);
    v = await service.correctText(template.id, v.revision, { expectedAnalysisRevision: a.revision, words, groups: a.groups, logoSlots: a.logoSlots });
    const corrected = v.textAnalysis!;
    expect(corrected.revision).toBe(a.revision + 1);
    expect(corrected.words.find(w => w.id === apply.id)).toMatchObject({ text: 'apply*', recognized: { text: 'apply' }, review: { status: 'approved' } });
    expect(corrected.history.map(h => h.action)).toEqual(expect.arrayContaining(['analysed', 'corrected', 'approved']));
    expect(corrected.history.some(h => h.detail?.includes('“apply” → “apply*”'))).toBe(true);
    // A stale analysis revision is refused.
    await expect(service.correctText(template.id, v.revision, { expectedAnalysisRevision: a.revision, words, groups: a.groups, logoSlots: a.logoSlots })).rejects.toMatchObject({ code: 'STALE_REVISION' });
    // Found again: the same ids, and the administrator's text, box and review kept.
    v = await service.analyseText(template.id, v.revision);
    const again = v.textAnalysis!;
    expect(again.words.find(w => w.id === apply.id)).toMatchObject({ text: 'apply*', review: { status: 'approved' } });
    expect(again.words.find(w => w.id === emi.id)!.box.x).toBe(emi.box.x + 4);
    expect(new Set(again.words.map(w => w.id))).toEqual(new Set(a.words.map(w => w.id)));
  });

  it('refuses a word with a space (a phrase is split into its words, never one box)', async () => {
    const { service, template } = await readyTemplate();
    const v = await service.analyseText(template.id, template.revision), a = v.textAnalysis!;
    const words = a.words.map(w => w.text === 'months' ? { ...w, text: '3-6-9-12 months' } : w);
    const saved = await service.correctText(template.id, v.revision, { expectedAnalysisRevision: a.revision, words, groups: a.groups, logoSlots: a.logoSlots });
    expect(saved.wordProblems!.some(p => p.code === 'INVALID_TEXT')).toBe(true);
  });

  it('replaces one bank logo byte for byte and restores the original pixels', async () => {
    const { service, template, store } = await readyTemplate();
    let v = await service.analyseText(template.id, template.revision);
    const card = v.textAnalysis!.logoSlots.find(l => l.detection === 'tile-grid')!, bytes = await replacementLogoPng();
    v = await service.replaceLogo(template.id, v.revision, card.id, bytes, 'new-bank.png');
    const replaced = v.textAnalysis!.logoSlots.find(l => l.id === card.id)!;
    expect(replaced.replacement).toMatchObject({ mime: 'image/png', width: 200, height: 76, originalName: 'new-bank.png' });
    expect(store.read(template.id, replaced.replacement!.file).equals(bytes)).toBe(true);
    expect(replaced.original.sha256).toBe(card.original.sha256);
    expect(v.textAnalysis!.history.at(-1)!.action).toBe('logo-replaced');
    // The other cards are untouched.
    expect(v.textAnalysis!.logoSlots.filter(l => l.id !== card.id).every(l => !l.replacement)).toBe(true);
    v = await service.restoreLogo(template.id, v.revision, card.id);
    expect(v.textAnalysis!.logoSlots.find(l => l.id === card.id)!.replacement).toBeUndefined();
    expect(store.has(template.id, replaced.replacement!.file)).toBe(false);
  });

  it('reads a schema-1 record unchanged (no words) and saves it as schema 2', async () => {
    const { store, service, template } = await readyTemplate();
    const file = join(store.root, template.id, 'template.json'), raw = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...raw, schemaVersion: 1 }));
    const read = service.view(template.id);
    expect(read.schemaVersion).toBe(2); expect(read.textAnalysis).toBeUndefined(); expect(read.status).toBe(template.status);
    await service.analyseText(template.id, read.revision);
    expect(JSON.parse(readFileSync(file, 'utf8')).schemaVersion).toBe(2);
    // A record of a newer schema is never guessed at.
    writeFileSync(file, JSON.stringify({ ...raw, schemaVersion: 99 }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(store.get(template.id)).toBeUndefined();
    warn.mockRestore();
  });

  it('needs confirmed regions before reading words', async () => {
    const root = mkdtempSync(join(tmpdir(), 'protected-words-')), store = fileProtectedStore(join(root, 'protected'));
    const service = createProtectedTemplates({ store, runsDir: join(root, 'runs'), deps: () => ({}) as RunnerDeps, isActiveRun: () => false, recognizer: () => fakeRecognizer(VARIATION_WORDS) });
    const t = await service.create(await variationPosterPng('x'), { name: 'x' });
    const v = await service.setElements(t.id, t.revision, VARIATION_ELEMENTS);
    await expect(service.analyseText(t.id, v.revision)).rejects.toMatchObject({ code: 'REGIONS_NOT_CONFIRMED' });
  });
});
