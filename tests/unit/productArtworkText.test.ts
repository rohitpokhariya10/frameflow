/**
 * The text check of new artwork on a REAL gpt-image-2 picture (the approved live check, 2026-10-22: the 9:16 Ganesh
 * artwork, tests/fixtures/recorded/), with the local word reader (free, no network). The picture has no text; the reader
 * found a short false reading in its mandala ("FON"), which must ask for a look, not fail the variation. Strong readings
 * (several words, or a long word) still fail it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { artworkText } from '../../server/src/decomposition/protectedTemplates/product/artwork.js';
import { variationChecks } from '../../server/src/decomposition/protectedTemplates/product/variations.js';
import { localRecognizer } from '../../server/src/textRecognition/recognizer.js';
import type { ProductCreative } from '@frameflow/shared';
import { HAS_PRIVATE_FIXTURES } from './privateFixtures.js';

const creative = (textFound: string[]) => ({ canvas: { width: 607, height: 1079 }, groups: [], texts: [], images: [], shapes: [], objects: [],
  background: { file: 'bg.png', sha256: '', width: 607, height: 1079, method: 'ai-artwork', restyled: false, filledPercent: 0, artwork: { model: 'gpt-image-2', offline: false, textFound } } }) as unknown as ProductCreative;

describe('text drawn into new artwork', { timeout: 180_000 }, () => {
  it.skipIf(!HAS_PRIVATE_FIXTURES)('reads at most a short false token in the real text-free gpt-image-2 artwork, which only asks for a look', async () => {
    const found = await artworkText(localRecognizer(), readFileSync('tests/fixtures/recorded/gpt-image-2-ganesh-9x16-2026-10-22.png'));
    expect(found.length).toBeLessThanOrEqual(1);
    expect(found.every(t => t.replace(/[^\p{L}\p{N}]/gu, '').length < 5)).toBe(true);
    const checks = variationChecks(creative(found), creative([]), new Map(), () => true);
    expect(checks.issues.filter(i => i.code === 'AI_TEXT').every(i => !i.blocking)).toBe(true);
    expect(checks.status).toBe('needs-review');
  });
  it('fails a variation whose artwork has real text in it', () => {
    for (const words of [['MEGA', 'SALE'], ['CASHBACK'], ['50%', 'OFF']]) {
      const checks = variationChecks(creative(words), creative([]), new Map(), () => true);
      expect(checks.status, words.join(' ')).toBe('failed');
      expect(checks.issues.find(i => i.code === 'AI_TEXT')!.blocking).toBe(true);
    }
  });
});
