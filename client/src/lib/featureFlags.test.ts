import { expect, it } from 'vitest';
import { flagOn, LEGACY_IMAGE_TO_LAYERS } from './featureFlags';

it('a flag is on only when it is set to an explicit yes', () => {
  for (const on of ['1', 'true', 'TRUE', 'on', 'yes', ' 1 ']) expect(flagOn(on)).toBe(true);
  for (const off of [undefined, null, '', '0', 'false', 'off', 'no', 'maybe', 1, true]) expect(flagOn(off)).toBe(false);
});

it('the earlier "Image to layers" flow is hidden unless VITE_LEGACY_IMAGE_TO_LAYERS turns it on', () => {
  expect(LEGACY_IMAGE_TO_LAYERS).toBe(flagOn(import.meta.env.VITE_LEGACY_IMAGE_TO_LAYERS));
  // Nothing sets it in a plain test run or build: the default is off.
  if (import.meta.env.VITE_LEGACY_IMAGE_TO_LAYERS === undefined) expect(LEGACY_IMAGE_TO_LAYERS).toBe(false);
});
