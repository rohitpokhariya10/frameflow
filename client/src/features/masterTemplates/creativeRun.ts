import { loadCreativeFonts } from './creativeText';
/**
 * A creative sent to decomposition, in the editor. The run (server master/creativeRun.ts) has one layer per element; its
 * `creative` record keeps the creative's texts and shapes, so here:
 *
 *   pictures   the background base, each object of the artwork (border, corner illustrations, ornaments) and every logo,
 *              QR or picture: the run's own layer files, at their placements
 *   text       every text as native editor text on its saved baseline (never a picture of text)
 *   shapes     every plate as a native shape
 *
 * all in the creative's own order. The design is a design of its own, not a version of the creative: saving it never
 * writes to the creative or its master. Opening the same run again switches back to that design. Reads stored files only.
 */
import { TEXT_LIMITS, type DesignLayer, type DesignVariant, type ProjectDocument } from '@frameflow/shared';
import { isDesignVariant } from '../../lib/persistence/schema';
import type { ExperimentRun } from '../decomposition/layerizeExperiment';
import { creativeScale, creativeTextElement, shapeLayer } from './creativeDocument';
import { productRunDocument } from '../productTemplates/productEditor';

type Assets = { putAsset(id: string, blob: Blob): Promise<unknown>; deleteAsset(id: string): Promise<unknown> };
export type CreativeRun = ExperimentRun & { creative: NonNullable<ExperimentRun['creative']> };
export const isCreativeRun = (run: ExperimentRun | undefined): run is CreativeRun => !!run?.creative;
/** The source a design made from a creative's run records (`importedFrom`), so opening the run again finds it. */
export const creativeRunSource = (run: CreativeRun) => ({ templateId: run.creative.masterId, resultId: `run-${run.id}`, runId: run.id });

export async function creativeRunDocument(run: CreativeRun, deps: { file: (name: string) => Promise<Blob>; assets: Assets; newId?: () => string; now?: () => string }): Promise<ProjectDocument> {
  if (run.creative.product && run.creative.native) return productRunDocument(run, deps);
  const newId = deps.newId ?? (() => crypto.randomUUID()), at = deps.now?.() ?? new Date().toISOString(), c = run.creative;
  if (c.product && typeof document !== 'undefined') await loadCreativeFonts(c);
  // The creative's own size when the editor takes it, else scaled down like any creative; either way the export has its size.
  const width = Math.floor(c.canvas.width * creativeScale(c.canvas, c)), s = width / c.canvas.width, height = Math.floor(c.canvas.height * s);
  const stored: string[] = [];
  try {
    const layers: DesignLayer[] = [];
    let order = 0;
    for (const meta of c.layers.filter(l => l.kind === 'background' || l.kind === 'artwork' || l.kind === 'image' || l.kind === 'object')) {
      const p = run.layers?.find(l => l.file === meta.file)?.placement;
      if (!p) throw new Error(`The run has no placement for its layer ${meta.file}.`);
      const assetId = `layerize-${newId()}`;
      await deps.assets.putAsset(assetId, await deps.file(meta.file));
      stored.push(assetId);
      const name = run.layers?.find(l => l.file === meta.file)?.name ?? meta.file, background = meta.kind === 'background', artwork = meta.kind === 'artwork';
      // The base stays where it is (locked, unlockable in Layers); the artwork's objects are free, in their own order below
      // every element of the creative; a picture keeps its proportions when replaced.
      // A Product with Text creative's character, product or brand logo: a picture of its own, replaceable.
      layers.push({ id: `layer-${newId()}`, type: 'image', assetId, name: name.slice(0, 200), role: background || artwork || meta.kind === 'object' ? 'generic-image' : 'logo',
        x: p.x * s, y: p.y * s, width: Math.max(1, p.width * s), height: Math.max(1, p.height * s), rotation: 0, opacity: 1, visible: !meta.hidden, locked: background, zIndex: background ? -1000 : artwork ? -999 + order++ : meta.z,
        ...(background ? {} : { fit: 'contain' as const, focalPoint: { x: 0.5, y: 0.5 } }) });
    }
    for (const sh of c.shapes) layers.push(shapeLayer(sh, s));
    // No protected slots: this design belongs to no master (its texts are free text).
    const elements = c.texts.map(t => creativeTextElement(t, s, { masterId: c.masterId, words: c.product ? c.words ?? [] : [] }));
    if (elements.length > TEXT_LIMITS.maxElements) throw new Error(`This creative has ${elements.length} texts; the editor holds at most ${TEXT_LIMITS.maxElements} per design.`);
    const name = `${c.name} · layers`.slice(0, 120);
    const variant: DesignVariant = { id: `layerize-${newId()}`, name, revision: 0, canvas: { width, height, backgroundColor: '#FFFFFF' }, elements, layers, ...(c.product ? { productTemplate: true as const } : {}), importedFrom: creativeRunSource(run),
      ...(width < c.canvas.width ? { sourceSize: { ...c.canvas, scale: s } } : {}) };
    if (!isDesignVariant(variant)) throw new Error('The layers did not pass the editor\'s checks; nothing was opened.');
    return { schemaVersion: 1, id: `design-${newId()}`, name, createdAt: at, updatedAt: at, variants: [variant] };
  } catch (error) {
    await Promise.all(stored.map(id => deps.assets.deleteAsset(id).catch(() => undefined)));
    throw error instanceof Error ? error : new Error('The layers could not be opened.');
  }
}
