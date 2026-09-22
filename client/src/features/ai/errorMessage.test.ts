import { expect, it } from 'vitest';
import { imageErrorMessage } from './errorMessage';

it.each([
  ['CONFIGURATION', 503, 'Ask the app owner'],
  ['NOT_CONFIGURED', 503, 'edit and export'],
  ['ADAPT_UNAVAILABLE', 503, 'Adaptation is unavailable'],
  ['RATE_LIMIT', 429, 'usage limit'],
  ['TIMEOUT', 504, 'longer than expected'],
  ['PROVIDER_REFUSAL', 422, 'different visual description'],
  ['INVALID_REFERENCE', 400, 'source artwork'],
  ['INVALID_REQUEST', 400, 'canvas size'],
  ['UNEXPECTED', 502, 'temporarily unavailable'],
])('shows actionable copy for %s without rendering service diagnostics', (code, status, phrase) => {
  const message = imageErrorMessage({ error: { code, message: 'private provider token / account configuration / raw response' } }, status);
  expect(message).toContain(phrase);
  expect(message).not.toMatch(/private|token|account|provider|raw response/);
});
it('handles malformed service responses without exposing arbitrary text', () => {
  for (const value of [null, 'raw upstream HTML', { error: 'private diagnostic' }, { error: { message: 'private diagnostic' } }]) {
    expect(imageErrorMessage(value, 502)).toBe('The image service is temporarily unavailable. Your design is unchanged. Please try again later.');
  }
});
