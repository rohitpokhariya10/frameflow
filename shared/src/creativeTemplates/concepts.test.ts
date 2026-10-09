import { describe, expect, it } from 'vitest';
import { TEXT_FREE_RULE } from './changePlan.js';
import { COMPOSITION_LIMITS, compileVariantPrompt, conceptDistance, conceptScene, MIN_CONCEPT_DISTANCE, parseConcept, scenePromptProblems, selectDiverseConcepts } from './variants.js';

// The concept engine's rules, offline: what a concept may say, how different the chosen ones must be, and the prompt
// they become. Whether the concepts are GOOD is a live judgement; these tests check that they are valid and different.
const raw = (over: Record<string, unknown> = {}) => ({ title: 'Morning kitchen', family: 'lifestyle', theme: 'calm breakfast light', environment: 'a sunlit marble kitchen counter by a window', surface: 'a white marble counter',
  props: ['a bowl of lemons', 'a linen towel'], palette: ['warm white', 'sage'], lighting: 'soft morning window light from the left', mood: 'fresh', camera: 'eye-level',
  composition: { x: 0.42, y: 0.6, scale: 0.6, copy_space: 'right' }, ...over });
const concept = (over: Record<string, unknown> = {}) => parseConcept(raw(over)).concept!;

describe('a concept, checked', () => {
  it('is kept as a structured art direction, its composition held to the limits', () => {
    const c = parseConcept(raw({ composition: { x: 1.4, y: -2, scale: 3, copy_space: 'top' } })).concept!;
    expect(c).toMatchObject({ family: 'lifestyle', camera: 'eye-level', props: ['a bowl of lemons', 'a linen towel'] });
    expect(c.composition).toEqual({ x: COMPOSITION_LIMITS.x[1], y: COMPOSITION_LIMITS.y[0], scale: COMPOSITION_LIMITS.scale[1], copySpace: 'top' });
  });

  it('is refused when it asks for text, prices, offers or logos anywhere, or has no setting', () => {
    for (const bad of [{ props: ['a sign reading SALE'] }, { theme: 'Diwali offer with 10% cashback' }, { palette: ['gold', 'brand logo blue'] }, { environment: '' }])
      expect(parseConcept(raw(bad)).concept, JSON.stringify(bad)).toBeUndefined();
  });

  it('becomes a text-free scene description, with its open space when it has one', () => {
    const text = conceptScene(concept());
    expect(scenePromptProblems(text)).toEqual([]);
    expect(text).toMatch(/sunlit marble kitchen counter.*rest on a white marble counter.*Leave the right part of the frame calm and open/);
    expect(conceptScene(concept({ composition: { x: 0.5, y: 0.5, scale: 0.6, copy_space: 'none' } }))).not.toMatch(/calm and open/);
  });
});

describe('the most different concepts are chosen; near-copies are left out', () => {
  const studio = concept({ title: 'Studio pedestal', family: 'studio', theme: 'clean product hero', environment: 'a seamless grey studio sweep', surface: 'a matte grey cylinder pedestal', props: [], palette: ['grey', 'white'], lighting: 'soft key light', mood: 'precise', camera: 'eye-level', composition: { x: 0.5, y: 0.6, scale: 0.6, copy_space: 'top' } });
  const recolor = { ...studio, title: 'Studio pedestal in blue', palette: ['blue', 'white'] };
  const nature = concept({ title: 'Forest stream', family: 'nature', theme: 'cool freshness', environment: 'mossy stones beside a clear forest stream', surface: 'a flat wet river stone', props: ['ferns', 'water droplets'], palette: ['moss green', 'slate'], lighting: 'dappled daylight', mood: 'refreshing', camera: 'low-angle', composition: { x: 0.35, y: 0.62, scale: 0.55, copy_space: 'right' } });
  const kitchen = concept();
  const festive = concept({ title: 'Festive table', family: 'festive', theme: 'evening celebration', environment: 'a festive dinner table with brass diyas and marigold garlands', surface: 'a carved wooden tray', props: ['marigolds', 'brass diyas'], palette: ['saffron', 'deep maroon', 'gold'], lighting: 'warm candle glow', mood: 'joyful', camera: 'high-angle', composition: { x: 0.55, y: 0.55, scale: 0.5, copy_space: 'bottom' } });

  it('a recolour of the same studio set is too close to count as another creative', () => {
    expect(conceptDistance(studio, recolor)).toBeLessThan(MIN_CONCEPT_DISTANCE);
    for (const other of [nature, kitchen, festive]) expect(conceptDistance(studio, other)).toBeGreaterThan(MIN_CONCEPT_DISTANCE);
  });

  it('chooses n different ones, leaving the recolour out, and reports how far apart they are', () => {
    const { chosen, rejected, minDistance } = selectDiverseConcepts([studio, recolor, nature, kitchen, festive], 3);
    expect(chosen.map(c => c.title)).toEqual(expect.arrayContaining(['Studio pedestal']));
    expect(chosen.map(c => c.title)).not.toContain('Studio pedestal in blue');
    expect(new Set(chosen.map(c => c.family)).size).toBe(3);
    expect(minDistance).toBeGreaterThanOrEqual(MIN_CONCEPT_DISTANCE);
    // Left out as a near-copy, not merely as surplus: the report says why.
    expect(rejected).toContainEqual({ title: 'Studio pedestal in blue', reason: expect.stringMatching(/^too close/) });
  });

  it('prefers fewer creatives to near-copies, and new ones must differ from a set\'s existing ones', () => {
    expect(selectDiverseConcepts([studio, recolor], 2).chosen.map(c => c.title)).toEqual(['Studio pedestal']);
    expect(selectDiverseConcepts([recolor, nature], 1, [studio]).chosen.map(c => c.title)).toEqual(['Forest stream']);
  });
});

describe('the prompt of a variant on its own canvas', () => {
  it('keeps the placed products final, matches their light, grounds them, and adds no text', () => {
    const prompt = compileVariantPrompt({ protectedLabels: ['Water purifier', 'Faucet'], lighting: { direction: 'left', quality: 'soft', color: 'warm' }, scene: conceptScene(concept()), people: false, placed: true });
    expect(prompt).toMatch(/products already placed in the attached image \(the unmasked area: Water purifier, Faucet\)/);
    expect(prompt).toMatch(/Do not redraw, move, resize, restyle or duplicate them/);
    expect(prompt).toMatch(/the light comes from the left, soft, warm in tone/);
    expect(prompt).toMatch(/contact shadow directly beneath it/);
    expect(prompt.endsWith(`${TEXT_FREE_RULE} The scene must contain no lettering of any kind.`)).toBe(true);
    // The only mention of prices, offers or discounts is the rule forbidding them.
    expect(prompt.replace(TEXT_FREE_RULE, '')).not.toMatch(/headline|offer|discount|price|cashback|interest/i);
  });
});
