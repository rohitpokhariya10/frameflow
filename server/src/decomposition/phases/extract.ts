import { decodeRgba, extractLayer } from '../image/extract.js';
import type { ExtractedLayer } from '../image/extract.js';
import { emptyMask, maskBounds } from '../image/masks.js';
import { assertMask, assertSameSize, ImageValidationError } from '../image/types.js';
import type { Mask } from '../image/types.js';

export type VisibleSelection = { id: string; label: string; mask: Mask };
export type VisibleExtraction = { layers: ExtractedLayer[]; residual: ExtractedLayer | null; coverage: { retainedPixels: number; selectedPixels: number; transparentPixels: number } };

export async function extractVisibleLayers(master: Buffer, selections: VisibleSelection[], padding = 2): Promise<VisibleExtraction> {
  if (!selections.length || selections.length > 6 || new Set(selections.map(selection => selection.id)).size !== selections.length) throw new ImageValidationError('OBJECT_SELECTION', 'Select between one and six objects with distinct IDs.');
  const source = await decodeRgba(master), residual = emptyMask(source.width, source.height);
  const layers: ExtractedLayer[] = [];
  for (const selection of selections) {
    assertMask(selection.mask); assertSameSize(source, selection.mask);
    layers.push(await extractLayer(source, selection.mask, selection.id, selection.label, padding));
  }
  let retainedPixels = 0, selectedPixels = 0, transparentPixels = 0;
  for (let i = 0; i < residual.data.length; i++) {
    const sourceAlpha = source.data[i * 4 + 3] / 255;
    if (!sourceAlpha) { transparentPixels++; continue; }
    let uncovered = 1;
    for (const selection of selections) uncovered *= 1 - Math.round(selection.mask.data[i] * sourceAlpha) / 255;
    const objectAlpha = 1 - uncovered;
    // Residual sits below objects. Solve sourceAlpha = objectAlpha + residualAlpha * (1 - objectAlpha).
    if (objectAlpha > sourceAlpha + 1 / 255) throw new ImageValidationError('AMBIGUOUS_OWNERSHIP', 'Overlapping object masks over transparent pixels need ownership review.');
    const residualAlpha = uncovered > 0 ? Math.max(0, (sourceAlpha - objectAlpha) / uncovered) : 0;
    residual.data[i] = Math.round(residualAlpha / sourceAlpha * 255);
    if (residual.data[i]) retainedPixels++;
    if (objectAlpha > 0) selectedPixels++;
  }
  return { layers, residual: maskBounds(residual) ? await extractLayer(source, residual, 'residual', 'Observed background and unclassified pixels', padding) : null,
    coverage: { retainedPixels, selectedPixels, transparentPixels } };
}
