import type { StudioProductAction, StudioStyleProfile } from '@frameflow/shared';
import type { ReferencePolicy, StudioStore } from './store.js';

export interface ReferenceChoices {
  templateId: string; fidelityMode?: string; direction?: string | null; occasion?: string | null;
  copy?: Record<string, string | undefined>; subjects?: { assetId: string }[];
  productActions?: StudioProductAction[]; backgroundOnly?: boolean; referenceText?: 'keep' | 'remove';
}

/** Pure selection/validation shared by submission and its cost preview. Never infer REMOVE from an empty upload. */
export function resolveReferencePolicy(db: StudioStore, input: ReferenceChoices): ReferencePolicy {
  const template = db.templates.require(input.templateId, 'Template');
  const primary = [...template.references].sort((a, b) => a.position - b.position)[0];
  if (!primary) throw new Error('The primary reference is missing.');
  const profile = db.profiles.get(template.currentProfileVersionId)?.profile as StudioStyleProfile | undefined;
  const scene = profile?.referenceScenes?.find(s => s.referenceId === 'ref1') ?? null;
  const actions = input.productActions ?? [];
  const subjects = input.subjects ?? [];
  const hasCopy = Object.values(input.copy ?? {}).some(v => v?.trim());
  const text = input.referenceText ?? (hasCopy || input.fidelityMode && input.fidelityMode !== 'match' ? 'remove' : 'keep');
  const localReuse = (input.fidelityMode ?? 'match') === 'match' && !input.direction?.trim() && !input.occasion?.trim() &&
    !subjects.length && actions.every(a => a.action === 'keep') && !input.backgroundOnly && text === 'keep';
  if (!scene && !localReuse) throw new Error('This older template has no product inventory. Analyse it again before editing products or generating a new scene; unchanged Match Reference reuse remains available for free.');
  if (new Set(actions.map(a => a.productId)).size !== actions.length) throw new Error('Choose one action per reference product.');
  for (const action of actions) {
    if (!scene?.products.some(p => p.id === action.productId)) throw new Error(`Unknown reference product: ${action.productId}.`);
    if (action.action === 'replace' && !subjects.some(s => s.assetId === action.replacementAssetId)) throw new Error('Every replacement must select an uploaded product.');
    if (action.action !== 'replace' && action.replacementAssetId) throw new Error('Only Replace accepts a replacement image.');
  }
  if (input.backgroundOnly && subjects.length) throw new Error('Background-only cannot contain uploaded products. Remove that choice to replace a product.');
  const resolved = (scene?.products ?? []).map(p => input.backgroundOnly
    ? { productId: p.id, action: 'remove' as const }
    : actions.find(a => a.productId === p.id) ?? { productId: p.id, action: 'keep' as const });
  const replacements = resolved.filter(a => a.action === 'replace').map(a => a.replacementAssetId);
  if (new Set(replacements).size !== replacements.length) throw new Error('Use each replacement image in only one product slot.');
  if (scene?.products.length && subjects.some(s => !replacements.includes(s.assetId))) throw new Error('Choose which reference product each uploaded image replaces. Other products stay unchanged.');
  return { primaryAssetId: primary.assetId, scene, actions: resolved, backgroundOnly: input.backgroundOnly ?? false, text, localReuse };
}
