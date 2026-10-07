/**
 * The legacy Templates A, B and C as the first families of the library. They are plain data in the same blueprint
 * format as every detected family: a canonical structure, compiled by the same functions. Nothing branches on them.
 * Raising a seed's revision makes the store add a new version; versions already used by runs are never changed.
 */
import { blueprintFromAnalysis } from './blueprint.js';
import type { StructureAnalysis, TemplateBlueprint } from './types.js';

export interface FamilySeed { id: string; key: string; revision: number; name: string; analysis: StructureAnalysis }
const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
const empty = { elements: {}, background: '' };

export const FAMILY_SEEDS: readonly FamilySeed[] = [
  { id: 'fam-framed-portrait', key: 'template-a', revision: 1, name: 'Framed Portrait', analysis: {
    layoutName: 'Framed Portrait', decompositionRecipe: 'template-a', confidence: 1, instance: empty,
    signature: { version: 1, background: 'gradient', relations: [], elements: [
      { id: 'frame', role: 'frame', z: 1, box: box(0.1, 0.08, 0.8, 0.84) },
      { id: 'backdrop', role: 'panel', z: 2, box: box(0.16, 0.14, 0.68, 0.72) },
      { id: 'subject', role: 'person', z: 3, box: box(0.26, 0.2, 0.48, 0.72) },
    ] } } },
  { id: 'fam-centered-product', key: 'template-b', revision: 1, name: 'Centered Product Creative', analysis: {
    layoutName: 'Centered Product Creative', decompositionRecipe: 'template-b', confidence: 1, instance: empty,
    signature: { version: 1, background: 'gradient', relations: [], elements: [
      { id: 'headline', role: 'headline', z: 3, box: box(0.15, 0.06, 0.7, 0.12) },
      { id: 'product', role: 'product', z: 2, box: box(0.3, 0.28, 0.4, 0.44) },
      { id: 'cta', role: 'cta', z: 3, box: box(0.35, 0.82, 0.3, 0.08) },
    ] } } },
  { id: 'fam-people-campaign', key: 'template-c', revision: 1, name: 'People Campaign', analysis: {
    layoutName: 'People Campaign', decompositionRecipe: 'template-c', confidence: 1, instance: empty,
    signature: { version: 1, background: 'gradient', relations: [], elements: [
      { id: 'logo', role: 'logo', z: 3, box: box(0.04, 0.03, 0.14, 0.07) },
      { id: 'headline', role: 'headline', z: 3, box: box(0.12, 0.08, 0.76, 0.14) },
      { id: 'person-a', role: 'person', z: 2, box: box(0.06, 0.26, 0.42, 0.66) },
      { id: 'person-b', role: 'person', z: 2, box: box(0.52, 0.26, 0.42, 0.66) },
      { id: 'promo', role: 'offer', z: 3, box: box(0.25, 0.85, 0.5, 0.1) },
    ] } } },
];

export const seedBlueprint = (seed: FamilySeed, version: number, now?: string): TemplateBlueprint =>
  blueprintFromAnalysis(seed.analysis, { familyId: seed.id, version, name: seed.name, origin: `seed ${seed.key} r${seed.revision}`, now });
