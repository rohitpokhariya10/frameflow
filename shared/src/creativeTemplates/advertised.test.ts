import { describe, expect, it } from 'vitest';
import { appliancesAnalysis, holdingBallAnalysis, phoneOfferAnalysis, sofaAnalysis, twoPhonesAnalysis } from '../../../server/src/decomposition/creativeTemplates/scene.fixture.js';
import { advertisedProducts } from './advertised.js';
import { applySceneCorrections, parseSceneDescription } from './scene.js';

// Which products "Generate creative template" keeps when nobody chose: evidence-based, never every prominent object.
const scene = (raw: unknown) => parseSceneDescription(raw);
const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h, certainty: 'approximate' });
const none = { brand: '', model: '', evidence: '', confidence: 0, markings: 'none' };
const object = (id: string, kind: string, importance: string, category: string, b: ReturnType<typeof box>, extra: Record<string, unknown> = {}) =>
  ({ id, kind, importance, category, description: category, box: b, occluded: false, properties: [], identity: none, confidence: 0.9, ...extra });
const relation = (source: string, rel: string, target: string, confidence = 0.9) => ({ source, relation: rel, target, evidence: 'visible', confidence });
const light = { direction: 'top', quality: 'soft', color: 'neutral' };

describe('the advertised product or group, chosen automatically', () => {
  it('a phone offer: the phone, and the earbuds shown as a set with it; never the pedestal, logos, text or background', () => {
    const s = scene(phoneOfferAnalysis()), chosen = advertisedProducts(s);
    expect([...chosen.ids].sort()).toEqual(['earbuds_1', 'smartphone_1']);
    expect(chosen.reasons).toEqual({ smartphone_1: 'what the creative is about', earbuds_1: 'an accessory of Smartphone' });
    expect(chosen).toMatchObject({ basis: 'rules', fallback: false });
  });

  it('two main products of different kinds, two similar phones, a sofa: each main product, nothing else', () => {
    expect([...advertisedProducts(scene(appliancesAnalysis())).ids].sort()).toEqual(['refrigerator_1', 'washing_machine_1']);
    expect([...advertisedProducts(scene(twoPhonesAnalysis())).ids].sort()).toEqual(['smartphone_1', 'smartphone_2']);
    // Furniture as THE product is kept; a cushion merely on it and a decorative lamp are not.
    expect(advertisedProducts(scene(sofaAnalysis())).ids).toEqual(['sofa_1']);
  });

  it('a person holding the object: both are what the creative is about', () => {
    expect([...advertisedProducts(scene(holdingBallAnalysis())).ids].sort()).toEqual(['football_1', 'man_1']);
  });

  it('only evidence links a product to the group: an uncertain accessory, a prop beside it and a stand are left out; the same visible brand is kept', () => {
    const raw = {
      summary: 'A blender with a jar of the same brand, a lemon, a cup and a marble stand.',
      objects: [object('bg', 'scenery', 'background', 'background', box(0, 0, 1, 1)),
        object('blender', 'product', 'main', 'blender', box(0.3, 0.2, 0.3, 0.55), { identity: { brand: 'Philips', model: '', evidence: 'wordmark', confidence: 0.9, markings: 'physical' } }),
        object('jar', 'product', 'supporting', 'jar', box(0.65, 0.5, 0.12, 0.25), { identity: { brand: 'Philips', model: '', evidence: 'wordmark', confidence: 0.8, markings: 'physical' } }),
        object('cup', 'product', 'supporting', 'cup', box(0.1, 0.6, 0.1, 0.12)),
        object('lemon', 'object', 'supporting', 'lemon', box(0.2, 0.7, 0.06, 0.06)),
        object('stand', 'furniture', 'supporting', 'stand', box(0.25, 0.75, 0.4, 0.15))],
      relations: [relation('cup', 'accessory_of', 'blender', 0.5), relation('lemon', 'next_to', 'blender'), relation('blender', 'on', 'stand')],
      marks: [], text_overlays: [], lighting: light, main_candidates: ['blender'], uncertainties: [],
    };
    const chosen = advertisedProducts(scene(raw));
    expect([...chosen.ids].sort()).toEqual(['blender_1', 'jar_1']);
    expect(chosen.reasons.jar_1).toBe('the same brand (Philips) as Blender');
  });

  it('a product standing right against a kept one is kept (a purifier and its faucet, related only as next to); one apart from it is not', () => {
    const raw = {
      summary: 'A water purifier with its faucet, and a kettle further away.',
      objects: [object('bg', 'scenery', 'background', 'background', box(0, 0, 1, 1)),
        object('purifier', 'product', 'main', 'water purifier', box(0.43, 0.28, 0.17, 0.23)),
        object('faucet', 'product', 'supporting', 'faucet', box(0.57, 0.37, 0.07, 0.15)),
        object('kettle', 'product', 'supporting', 'kettle', box(0.8, 0.6, 0.1, 0.15))],
      relations: [relation('faucet', 'next_to', 'purifier', 0.99), relation('kettle', 'next_to', 'purifier', 0.9)],
      marks: [], text_overlays: [], lighting: light, main_candidates: ['purifier'], uncertainties: [],
    };
    const chosen = advertisedProducts(scene(raw));
    expect([...chosen.ids].sort()).toEqual(['faucet_1', 'water_purifier_1']);
    expect(chosen.reasons.faucet_1).toBe('part of the product set: right against Water purifier');
  });
  it('a product\'s attached part goes inside its cutout, and a related product shown as part of the offer is kept', () => {
    const raw = {
      summary: 'A water purifier with its faucet and a control panel.',
      objects: [object('bg', 'scenery', 'background', 'background', box(0, 0, 1, 1)),
        object('purifier', 'product', 'main', 'water purifier', box(0.3, 0.3, 0.25, 0.4)),
        object('faucet', 'product', 'supporting', 'faucet', box(0.52, 0.2, 0.06, 0.15)),
        object('panel', 'object', 'supporting', 'control panel', box(0.35, 0.45, 0.1, 0.06)),
        object('plinth', 'furniture', 'supporting', 'display plinth', box(0.2, 0.7, 0.5, 0.15))],
      relations: [relation('faucet', 'related_to', 'purifier', 0.72), relation('panel', 'attached_to', 'purifier', 0.98), relation('purifier', 'on', 'plinth')],
      marks: [], text_overlays: [], lighting: light, main_candidates: ['purifier'], uncertainties: [],
    };
    const chosen = advertisedProducts(scene(raw));
    expect([...chosen.ids].sort()).toEqual(['faucet_1', 'water_purifier_1']);
    expect(chosen.parts).toEqual({ control_panel_1: 'water_purifier_1' });
    expect(chosen.reasons.faucet_1).toBe('shown with Water purifier');
  });

  it('the analysis\' own advertised list is used (with the main candidates), but a stand it names is never a product', () => {
    const raw = { ...appliancesAnalysis(), advertised_ids: ['fridge', 'room'] };
    const named = advertisedProducts(scene(raw));
    expect(named).toMatchObject({ basis: 'analysis' });
    expect([...named.ids].sort()).toEqual(['refrigerator_1', 'washing_machine_1']);
    const stand = { ...sofaAnalysis(), objects: [...sofaAnalysis().objects, object('stand', 'furniture', 'supporting', 'stand', box(0.1, 0.85, 0.7, 0.1))], advertised_ids: ['sofa', 'stand'] };
    expect(advertisedProducts(scene(stand)).ids).toEqual(['sofa_1']);
  });

  it('nothing named as main: the most prominent products, said so; a wrong detection is never kept', () => {
    const raw = { ...appliancesAnalysis(), main_candidates: [], objects: appliancesAnalysis().objects.map(o => ({ ...o, importance: o.importance === 'main' ? 'supporting' : o.importance })) };
    const chosen = advertisedProducts(scene(raw));
    expect(chosen.fallback).toBe(true);
    expect(chosen.ids.length).toBeGreaterThan(0);
    const corrected = applySceneCorrections(scene(phoneOfferAnalysis()), { earbuds_1: { ignored: true } });
    expect(advertisedProducts(corrected).ids).toEqual(['smartphone_1']);
  });
});
