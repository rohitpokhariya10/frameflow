import { expect, it } from 'vitest';
import { completeNumber } from './NumberField';
it('keeps incomplete and nonfinite numeric drafts out of documents', () => {
  for (const value of ['', '-', '1.', 'NaN', 'Infinity', '1e3', ' ', '9'.repeat(400)]) expect(completeNumber(value)).toBeNull();
  for (const [draft, number] of [['0', 0], ['-12', -12], ['1.5', 1.5], ['.5', .5], ['4096', 4096]] as const) expect(completeNumber(draft)).toBe(number);
});
