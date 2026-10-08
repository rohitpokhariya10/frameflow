import type { TemplateStructure } from './types.js';

/** Canonical product groups use structural evidence, never product names or colors. */
export function canonicalStructure(input: TemplateStructure): TemplateStructure {
  const structure = structuredClone(input), aliases = new Map<string, string>();
  const products = structure.layers.filter(l => l.role === 'main_product' && l.independent && l.zone && l.zone !== 'full-canvas');
  for (const layer of products) {
    const root = products.find(p => p.zone === layer.zone)!;
    if (root.id !== layer.id) aliases.set(layer.id, root.id);
  }
  for (const layer of structure.layers) {
    if (layer.attachment?.relation === 'part_of_object' && ['main_product', 'supporting_product'].includes(layer.role)) {
      const parent = structure.layers.find(p => p.id === layer.attachment?.parent);
      if (parent?.role === 'main_product') aliases.set(layer.id, aliases.get(parent.id) ?? parent.id);
    }
  }
  const rootOf = (id: string) => aliases.get(id) ?? id;
  structure.layers = structure.layers.filter(l => !aliases.has(l.id)).map(l => ({ ...l,
    ...(l.attachment ? { attachment: { ...l.attachment, parent: rootOf(l.attachment.parent) } } : {}),
    ...(l.occlusion ? { occlusion: { ...l.occlusion, occludedBy: [...new Set(l.occlusion.occludedBy.map(rootOf))].filter(id => id !== l.id) } } : {}),
  }));
  structure.relationships = structure.relationships.map(r => ({ ...r, source: rootOf(r.source), target: rootOf(r.target) })).filter(r => r.source !== r.target);
  return structure;
}

/** Conservative semantic comparison after analysis; missing geometry never proves an automatic match. */
export function sameTemplateStructure(a: TemplateStructure, b: TemplateStructure): boolean {
  const profile = (input: TemplateStructure) => {
    const s = canonicalStructure(input);
    // Kept-with-parent roles still describe topology: a person holding a merged prop is not a person alone.
    const layers = s.layers.filter(l => !['decoration', 'effect'].includes(l.role));
    if (layers.some(l => l.role !== 'background' && !l.zone)) return undefined;
    const keys = new Map(layers.map(l => [l.id, `${l.role}@${l.zone ?? 'full-canvas'}:${l.independent ? 'separate' : 'kept'}`]));
    if (layers.some(l => l.attachment && !keys.has(l.attachment.parent))) return undefined;
    return JSON.stringify({ layers: [...keys.values()].sort(), relationships: [...new Set(s.relationships.filter(r => ['holds', 'wears', 'attached_to', 'inside', 'on'].includes(r.relation) && keys.has(r.source) && keys.has(r.target)).map(r => `${keys.get(r.source)}:${r.relation}:${keys.get(r.target)}`))].sort(),
      attachments: layers.filter(l => l.attachment).map(l => `${keys.get(l.id)}:${l.attachment!.relation}:${keys.get(l.attachment!.parent)}:${l.attachment!.keepWithParent}`).sort() });
  };
  const left = profile(a), right = profile(b);
  return left !== undefined && left === right;
}
