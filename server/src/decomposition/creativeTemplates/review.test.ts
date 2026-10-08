import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { compileTemplateEdit, type TemplateLayer, type TemplateVersion } from '@frameflow/shared';
import { reviewGeneration } from './review.js';

// Synthetic product creatives (no provider): a yellow field, two small "earbuds" at the top and a "case" at the bottom,
// each a light shape with a dark outline, as in the Product Trio template.
const W = 600, H = 750;
const svg = (body: string, background = '#f2c94c') => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="${background}"/>${body}</svg>`);
const render = (body: string, background?: string) => sharp(svg(body, background)).png().toBuffer();
const BUD_LEFT = '<ellipse cx="120" cy="140" rx="55" ry="75" fill="#fafafa" stroke="#333" stroke-width="6"/>';
const BUD_TOP = '<ellipse cx="300" cy="160" rx="55" ry="75" fill="#fafafa" stroke="#333" stroke-width="6"/>';
const CASE = '<rect x="200" y="470" width="200" height="190" rx="60" fill="#ffffff" stroke="#222" stroke-width="8"/><line x1="200" y1="540" x2="400" y2="540" stroke="#222" stroke-width="5"/>';
/** A speaker: a different silhouette in the same place (tall dark cylinder with grilles). */
const SPEAKER = '<rect x="250" y="400" width="100" height="280" rx="40" fill="#1d1d1f"/><circle cx="300" cy="470" r="30" fill="#555"/><circle cx="300" cy="590" r="38" fill="#555"/>';

const layer = (id: string, role: TemplateLayer['role'], order: number, zone: TemplateLayer['zone']): TemplateLayer => ({ id, role, order, independent: true, required: false, zone });
const version: Pick<TemplateVersion, 'structure'> = { structure: { relationships: [], layers: [
  layer('background', 'background', 0, 'full-canvas'), layer('supporting_product', 'supporting_product', 1, 'top-left'),
  layer('supporting_product_2', 'supporting_product', 2, 'top-center'), layer('main_product', 'main_product', 3, 'bottom-center')] } };

/** The template's source run, as capture stores it: planner roles per element, and one extracted layer per element. */
async function sourceRun() {
  const dir = mkdtempSync(join(tmpdir(), 'review-source-'));
  const shapes: [string, string, string, string][] = [['bud_left', BUD_LEFT, 'supporting_product', 'top left'], ['bud_top', BUD_TOP, 'supporting_product', 'top center'], ['case', CASE, 'main_product', 'bottom center']];
  const outputLayers = [];
  for (const [i, [id, body]] of shapes.entries()) {
    const file = `layer-${i}.png`;
    writeFileSync(join(dir, file), await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${body}</svg>`)).png().toBuffer());
    outputLayers.push({ index: i + 1, file, zIndex: i + 1, pixelWidth: W, pixelHeight: H, opaquePercent: 5, placement: { kind: 'full-canvas', x: 0, y: 0, width: W, height: H }, semantic: { id, type: 'product', editableIndependently: true } });
  }
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ canvas: { width: W, height: H }, outputLayers,
    planner: { capture: { roles: Object.fromEntries(shapes.map(([id, , role]) => [id, role])) }, semantic_analysis: { elements: shapes.map(([id, , , region]) => ({ id, approximate_region: region })) } } }));
  return dir;
}

describe('the local review of a generated creative', () => {
  const replaceSpeaker = compileTemplateEdit(version, { main_product: 'BOAT SPEAKER', background: 'warm orange' }).changes;

  it('flags a main product that was not replaced (the earbuds case kept on a new background) from its exact source shape', async () => {
    const source = await render(BUD_LEFT + BUD_TOP + CASE), kept = await render(BUD_LEFT + BUD_TOP + CASE, '#f5a142');
    const review = await reviewGeneration({ source, generated: kept, version, changes: replaceSpeaker, sourceRunDir: await sourceRun() });
    expect(review.method).toBe('source-layer-masks');
    expect(review.requiresAcknowledgement).toBe(true);
    expect(review.checks.filter(c => c.severity === 'warning').map(c => c.message)).toEqual([
      expect.stringMatching(/^Supporting product · top left may still be there: \d+% of its original outline is still in place\.$/),
      expect.stringMatching(/^Supporting product · top may still be there/),
      expect.stringMatching(/^Main product may not have been replaced: \d+% of the original object's outline is still in place\.$/)]);
    expect(review.note).toMatch(/pixel comparison only.*not that the new content is correct/i);
  });

  it('does not flag a product that was replaced by a different silhouette with its companions removed — and still says it proves nothing', async () => {
    const source = await render(BUD_LEFT + BUD_TOP + CASE), replaced = await render(SPEAKER, '#f5a142');
    const review = await reviewGeneration({ source, generated: replaced, version, changes: replaceSpeaker, sourceRunDir: await sourceRun() });
    expect(review.checks.filter(c => c.id === 'object-unchanged')).toEqual([]);
    expect(review.requiresAcknowledgement).toBe(false);
    expect(review.note).toMatch(/Review the image before using it/);
  });

  it('without the source shapes it only hints (approximate zones), never warns', async () => {
    const source = await render(BUD_LEFT + BUD_TOP + CASE), kept = await render(BUD_LEFT + BUD_TOP + CASE, '#f5a142');
    const review = await reviewGeneration({ source, generated: kept, version, changes: replaceSpeaker });
    expect(review.method).toBe('template-zones');
    const main = review.checks.find(c => c.slotId === 'main_product')!;
    expect(main).toMatchObject({ id: 'object-unchanged', severity: 'info', message: expect.stringContaining('only its approximate area is known here') });
    expect(review.checks.some(c => c.severity === 'warning')).toBe(false);
  });

  it('flags an image that came back unchanged although changes were asked', async () => {
    const source = await render(BUD_LEFT + BUD_TOP + CASE);
    const review = await reviewGeneration({ source, generated: source, version, changes: compileTemplateEdit(version, { background: 'teal' }).changes });
    expect(review.checks).toEqual([expect.objectContaining({ id: 'image-unchanged', severity: 'warning' })]);
    expect(review.requiresAcknowledgement).toBe(true);
  });
});
