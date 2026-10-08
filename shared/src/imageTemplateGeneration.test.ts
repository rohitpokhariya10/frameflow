import { describe, expect, it } from 'vitest';
import { buildGenerationVariantPrompt, closestGenerationRatio, GENERATION_ASPECT_RATIOS, GENERATION_IMAGE_SIZES, GENERATION_PROMPT_LIMITS, generationVariantId } from './imageGeneration.js';
import { IMAGE_TEMPLATE_CONSISTENCY, IMAGE_TEMPLATE_FRAMING, IMAGE_TEMPLATE_LIMITS, IMAGE_TEMPLATE_RATIO_NAMES, IMAGE_TEMPLATE_RATIOS, IMAGE_TEMPLATE_REFERENCE_INSTRUCTION, IMAGE_TEMPLATE_SIZES,
  imageTemplateVariantPrompt, isImageTemplateRatio, resolveImageTemplateName, resolveImageTemplatePrompt, resolveImageTemplateRatios } from './imageTemplateGeneration.js';

const PROMPT = 'A premium product advertisement in a soft 3D render style: a lavender smartphone stands upright in the centre on a white platform, on a pastel lilac background.';

describe('Create Template from Image: shared rules', () => {
  it('offers 1:1, 4:5 and 16:9, in that order, at the sizes every template generator uses', () => {
    expect(IMAGE_TEMPLATE_RATIOS).toEqual(['1:1', '4:5', '16:9']);
    expect(IMAGE_TEMPLATE_RATIO_NAMES).toEqual({ '1:1': 'Square', '4:5': 'Portrait', '16:9': 'Landscape' });
    for (const ratio of IMAGE_TEMPLATE_RATIOS) expect(IMAGE_TEMPLATE_SIZES[ratio]).toEqual(GENERATION_IMAGE_SIZES[ratio]);
    expect(IMAGE_TEMPLATE_LIMITS).toEqual({ name: 80, prompt: GENERATION_PROMPT_LIMITS.base });
    expect([isImageTemplateRatio('4:5'), isImageTemplateRatio('9:16'), isImageTemplateRatio(undefined)]).toEqual([true, false, false]);
  });

  it('takes the chosen ratios in the fixed order, each once, and at least one', () => {
    expect(resolveImageTemplateRatios(['16:9', '1:1'])).toEqual({ ratios: ['1:1', '16:9'] });
    expect(resolveImageTemplateRatios([...IMAGE_TEMPLATE_RATIOS].reverse())).toEqual({ ratios: ['1:1', '4:5', '16:9'] });
    expect(resolveImageTemplateRatios([]).error).toBe('Choose at least one aspect ratio.');
    for (const bad of [['1:1', '1:1'], ['9:16'], '1:1', undefined]) expect(resolveImageTemplateRatios(bad).error).toMatch(/must be one or more of 1:1, 4:5, 16:9/);
  });

  it('a name is one tidy line, given, and at most 80 characters; it is refused, never cut', () => {
    expect(resolveImageTemplateName('  Diwali\n offer ')).toEqual({ name: 'Diwali offer' });
    expect(resolveImageTemplateName('   ').error).toBe('Give the template a name.');
    expect(resolveImageTemplateName(42).error).toBe('The template name must be text.');
    expect(resolveImageTemplateName('x'.repeat(81))).toEqual({ name: 'x'.repeat(81), error: 'The template name is 81 characters; at most 80.' });
    expect(resolveImageTemplateName('x'.repeat(80))).toEqual({ name: 'x'.repeat(80) });
  });

  it('a prompt keeps its paragraphs, must describe something, and is refused over the limit, never cut', () => {
    expect(resolveImageTemplatePrompt(`  ${PROMPT}  \n\n  Soft  daylight.  `)).toEqual({ prompt: `  ${PROMPT}  \n\n  Soft  daylight.  ` });
    expect(resolveImageTemplatePrompt('').error).toBe('Generate a prompt from the image, or write one.');
    expect(resolveImageTemplatePrompt('a red phone').error).toBe('The prompt is too short to describe an image.');
    expect(resolveImageTemplatePrompt(null).error).toBe('The prompt must be text.');
    expect(resolveImageTemplatePrompt('word '.repeat(401)).error).toBe('The prompt is 2005 characters; at most 2000.');
  });

  it('a ratio\'s prompt is the template\'s prompt, the consistency sentence and its framing: the framing is the only difference', () => {
    const prompts = IMAGE_TEMPLATE_RATIOS.map(ratio => imageTemplateVariantPrompt(PROMPT, ratio));
    expect(prompts).toEqual(IMAGE_TEMPLATE_RATIOS.map(ratio => `${PROMPT} ${IMAGE_TEMPLATE_CONSISTENCY} ${IMAGE_TEMPLATE_FRAMING[ratio]}`));
    expect(new Set(prompts.map(prompt => prompt.replace(/Framing for this version:.*$/, ''))).size).toBe(1);
    for (const ratio of IMAGE_TEMPLATE_RATIOS) expect(IMAGE_TEMPLATE_FRAMING[ratio]).toContain(`Framing for this version: ${ratio}`);
    // A full-length edited prompt still fits every edit request, including the original-reference instruction.
    for (const ratio of IMAGE_TEMPLATE_RATIOS) expect(`${imageTemplateVariantPrompt('x'.repeat(IMAGE_TEMPLATE_LIMITS.prompt), ratio)} ${IMAGE_TEMPLATE_REFERENCE_INSTRUCTION}`.length).toBeLessThanOrEqual(GENERATION_PROMPT_LIMITS.final);
  });

  it('keeps the original creative structure while respecting explicit edits, with no invented details', () => {
    const edited = `${PROMPT} Change only the lighting to golden hour.`;
    for (const ratio of IMAGE_TEMPLATE_RATIOS) {
      const prompt = imageTemplateVariantPrompt(edited, ratio);
      expect(prompt.startsWith(`${edited} `)).toBe(true);
      expect(prompt).toContain('Apply explicit edits in the prompt above');
      expect(prompt).toContain('otherwise the reference governs');
      for (const detail of ['geometry and details', 'camera modules', 'object count', 'relative sizes and positions', 'orientation', 'camera view', 'framing', 'overlaps and depth', 'visual hierarchy', 'palette', 'lighting', 'materials/textures', 'background']) expect(prompt).toContain(detail);
      for (const constraint of ['add or remove objects', 'redesign products or props', 'invent text/logos/branding', 'change object arrangements', 'stretch objects', 'newly crop important elements']) expect(prompt).toContain(constraint);
    }
    expect(IMAGE_TEMPLATE_REFERENCE_INSTRUCTION).toContain('original uploaded reference');
    expect(IMAGE_TEMPLATE_REFERENCE_INSTRUCTION).toContain('canonical source for every ratio');
    expect(IMAGE_TEMPLATE_REFERENCE_INSTRUCTION).toContain('never copy another generated variant');
  });

  it('preserves the square layout and extends only the background along the adapted canvas direction', () => {
    expect(IMAGE_TEMPLATE_FRAMING['1:1']).toContain('Preserve the original layout, crop and object arrangement');
    expect(IMAGE_TEMPLATE_FRAMING['1:1']).toContain('keep off-centre elements off-centre');
    expect(IMAGE_TEMPLATE_FRAMING['1:1']).toContain('minimal framing changes');
    expect(IMAGE_TEMPLATE_FRAMING['4:5']).toContain('vertically by extending existing background above/below');
    expect(IMAGE_TEMPLATE_FRAMING['16:9']).toContain('horizontally by extending existing background at the sides');
    for (const ratio of ['4:5', '16:9'] as const) expect(IMAGE_TEMPLATE_FRAMING[ratio]).toContain('Preserve relative hierarchy, sizes, positions and overlaps');
    expect(Object.values(IMAGE_TEMPLATE_FRAMING).join(' ')).not.toMatch(/large and centred|fill most of the width/);
  });

  it('says nothing about any one kind of image', () => {
    for (const text of [IMAGE_TEMPLATE_CONSISTENCY, IMAGE_TEMPLATE_REFERENCE_INSTRUCTION, ...Object.values(IMAGE_TEMPLATE_FRAMING)]) expect(text).not.toMatch(/\b(product creative|hero|portrait|campaign|person|people|phone)\b/i);
  });
});

describe('image generation: shared sizes and prompt mechanics', () => {
  it('asks for 1:1, 16:9 and 4:5 at exact sizes of those ratios, both sides divisible by 16', () => {
    expect(GENERATION_ASPECT_RATIOS).toEqual(['1:1', '16:9', '4:5']);
    for (const ratio of GENERATION_ASPECT_RATIOS) {
      const [w, h] = ratio.split(':').map(Number), { width, height } = GENERATION_IMAGE_SIZES[ratio];
      expect(width * h! - height * w!).toBe(0);
      expect([width % 16, height % 16]).toEqual([0, 0]);
    }
    expect(GENERATION_ASPECT_RATIOS.map(generationVariantId)).toEqual(['1x1', '16x9', '4x5']);
  });

  it('an edit keeps the image\'s proportions: the supported size closest to its own aspect', () => {
    expect([closestGenerationRatio(1000, 1000), closestGenerationRatio(1080, 1350), closestGenerationRatio(1920, 1080), closestGenerationRatio(1080, 1920), closestGenerationRatio(1200, 1000)]).toEqual(['1:1', '4:5', '16:9', '4:5', '1:1']);
  });

  it('a variant is the base + the consistency sentence + that ratio\'s framing; an unknown ratio or an oversized prompt is refused', () => {
    const parts = { consistency: 'Keep everything.', framing: { '1:1': 'Square framing.', '16:9': 'Wide framing.' } };
    expect(buildGenerationVariantPrompt(parts, '  A creative.  ', '16:9')).toBe('A creative. Keep everything. Wide framing.');
    expect(() => buildGenerationVariantPrompt(parts, 'A creative.', '4:5')).toThrow('Aspect ratio must be one of 1:1, 16:9, 4:5.');
    expect(() => buildGenerationVariantPrompt(parts, 'x'.repeat(GENERATION_PROMPT_LIMITS.final), '1:1')).toThrow(/at most 3000/);
  });
});
