import { hasExplicitOrder, type DesignVariant } from '@frameflow/shared';

/**
 * Keeping one back-to-front order in a design that interleaves text and layers, i.e. whose elements carry a zIndex (a
 * design opened from a template). Each function does nothing for a design without any zIndex: its order is still the
 * layer list followed by the text list, as it always was. They write to the (draft) variant they are given.
 */
type Placed = { zIndex?: number };
const everything = (variant: DesignVariant): Placed[] => [...(variant.layers ?? []), ...variant.elements];
const places = (variant: DesignVariant, except?: Placed) => everything(variant).filter(item => item !== except).flatMap(item => item.zIndex ?? []);

/** A new element goes above everything. */
export function placeOnTop(variant: DesignVariant, item: Placed | undefined) {
  if (!item || !hasExplicitOrder(variant)) return;
  const others = places(variant, item);
  if (others.length) item.zIndex = Math.max(...others) + 1;
}
/** A background layer goes below everything. */
export function placeAtBottom(variant: DesignVariant, item: Placed | undefined) {
  if (!item || !hasExplicitOrder(variant)) return;
  const others = places(variant, item);
  if (others.length) item.zIndex = Math.min(...others) - 1;
}
/** A copy goes directly above what it was made from: everything higher moves up one place. */
export function placeAbove(variant: DesignVariant, item: Placed | undefined, below: number | undefined) {
  if (!item || !hasExplicitOrder(variant)) return;
  if (below === undefined) { delete item.zIndex; placeOnTop(variant, item); return; }
  for (const other of everything(variant)) if (other !== item && other.zIndex !== undefined && other.zIndex > below) other.zIndex += 1;
  item.zIndex = below + 1;
}
/** After the layer list was reordered: the layers take the places layers held, in their new list order; text keeps its places. */
export function followLayerOrder(variant: DesignVariant) {
  const layers = variant.layers ?? [];
  if (!hasExplicitOrder(variant) || layers.some(layer => layer.zIndex === undefined)) return;
  const held = layers.map(layer => layer.zIndex!).sort((a, b) => a - b);
  layers.forEach((layer, index) => { layer.zIndex = held[index]; });
}
