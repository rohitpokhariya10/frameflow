import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { buildProviderInput } from './providers/adapters.js';
import { composeLayerizePrompt } from './seedreamPromptExperiment.js';

const read = (name: string) => readFileSync(new URL(`./prompts/seedream-layerize.${name}.txt`, import.meta.url), 'utf8');

it('sends the reusable positive prompt with the negative lines folded in, within the endpoint request limits', () => {
  const prompt = composeLayerizePrompt(read('positive'), read('negative'));
  expect(prompt.startsWith('Separate the image into clean semantic layers.')).toBe(true);
  expect(prompt).toContain('\n\nAlso avoid:\nDo not merge the held object with the person.');
  expect(prompt.endsWith('Avoid loss of fine details.')).toBe(true);
  expect(prompt.length).toBeLessThanOrEqual(2000);
  const input = buildProviderInput('seedream', { imageUrl: 'https://fal.media/x.png', prompt, imageSize: 'auto', enhancePromptMode: 'standard', width: 1055, height: 1491 });
  // The endpoint has no negative_prompt parameter; nothing else is invented.
  expect(Object.keys(input).sort()).toEqual(['enable_safety_checker', 'enhance_prompt_mode', 'image_size', 'image_url', 'prompt', 'sync_mode']);
  expect(input).toMatchObject({ prompt, image_size: 'auto', enhance_prompt_mode: 'standard', enable_safety_checker: true, sync_mode: false });
  expect(composeLayerizePrompt('Only this.', '  ')).toBe('Only this.');
});
