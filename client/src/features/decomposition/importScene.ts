import { validateCanvasSize, type DecompositionJobSummary, type DesignLayer, type DesignVariant, type SceneGraph, type SceneLayer } from '@frameflow/shared';

type Assets = { putAsset(id: string, blob: Blob): Promise<unknown>; deleteAsset(id: string): Promise<unknown> };
type FetchArtifact = (artifactId: string) => Promise<Blob>;
export type OpenMode = 'blank' | 'original';
/**
 * blank: a transparent canvas holding only the separated layers; the AI-rebuilt background is added only when asked for.
 * original: the original image stays underneath as the background, with the separated layers on top.
 */
export type OpenOptions = { mode: OpenMode; includeBackground?: boolean };
type Store = (artifactId: string) => Promise<string>;

/** The AI-rebuilt background discovered with the layers, if any. It never contains the original image. */
export const rebuiltBackgroundArtifact = (graph: Pick<SceneGraph, 'layers'> | undefined) =>
  graph?.layers.find((layer): layer is Extract<SceneLayer, { type: 'background' }> => layer.type === 'background')?.reconstructionCandidateArtifactId;

/** One scene layer as an editor layer at its original position and size. Background layers are handled by the caller. */
export async function sceneLayerToDesignLayer(layer: Exclude<SceneLayer, { type: 'background' }>, jobId: string, store: Store, id: string): Promise<DesignLayer> {
  const base = { id, name: layer.name.slice(0, 200) || layer.type, x: layer.bbox.x, y: layer.bbox.y, width: layer.bbox.width, height: layer.bbox.height,
    rotation: layer.rotation, opacity: layer.opacity, visible: layer.visible, locked: false };
  if (layer.type === 'image') return { ...base, type: 'image', assetId: await store(layer.transparentRgbaArtifactId), source: { jobId, layerId: layer.id, kind: 'image' } };
  if (layer.type === 'text') return { ...base, type: 'image', assetId: await store(layer.rasterArtifactId), source: { jobId, layerId: layer.id, kind: 'text' },
    textSuggestion: { text: layer.text.slice(0, 5000), confidence: layer.textConfidence, ...(layer.color ? { fill: layer.color } : {}), ...(layer.fontSize ? { fontSize: Math.max(8, Math.min(512, layer.fontSize)) } : {}), ...(layer.fontWeight ? { fontWeight: layer.fontWeight } : {}) } };
  if (layer.shapeType === 'raster' || !layer.fill) return { ...base, type: 'image', assetId: await store(layer.rasterArtifactId), source: { jobId, layerId: layer.id, kind: 'shape' } };
  return { ...base, type: 'shape', shapeType: layer.shapeType, fill: layer.fill, radius: layer.radius ?? 0, source: { jobId, layerId: layer.id, kind: 'shape' },
    ...(layer.gradient ? { gradient: layer.gradient } : {}), ...(layer.stroke ? { stroke: layer.stroke } : {}) };
}

/** Marks the AI-rebuilt background on the canvas, so "Detected layers" knows it is already there. */
export const REBUILT_BACKGROUND_LAYER_ID = 'detected-background';
/** A full-canvas, locked bottom layer for a background picture. */
export const backgroundLayer = (id: string, assetId: string, width: number, height: number, name = 'Background', jobId?: string): DesignLayer =>
  ({ id, type: 'image', name, assetId, x: 0, y: 0, width, height, rotation: 0, opacity: 1, visible: true, locked: true, ...(jobId ? { source: { jobId, layerId: REBUILT_BACKGROUND_LAYER_ID, kind: 'image' as const } } : {}) });

/**
 * Turn a completed decomposition scene graph into a new editor version at native resolution. Image layers and text
 * rasters become image layers (text keeps its unverified suggestion for "Make text editable"), confident shapes become
 * vector shape layers; order is back-to-front. All assets are stored first; on any failure the stored assets are
 * removed and nothing is added to the design.
 */
export async function sceneToVariant(job: Pick<DecompositionJobSummary, 'id' | 'sceneGraph'>, fetchArtifact: FetchArtifact, assets: Assets, newId: () => string = () => crypto.randomUUID(), options: OpenOptions = { mode: 'original' }): Promise<DesignVariant> {
  const graph = job.sceneGraph as SceneGraph | undefined;
  if (!graph?.layers.length) throw new Error('This job has no editable scene yet.');
  if (!validateCanvasSize(graph.width, graph.height).valid) throw new Error(`The source (${graph.width} × ${graph.height}) is larger than the editor canvas limit.`);
  const stored: string[] = [];
  const store = async (artifactId: string) => {
    const id = `decomp-${newId()}`;
    await assets.putAsset(id, await fetchArtifact(artifactId));
    stored.push(id);
    return id;
  };
  try {
    let backgroundAsset: string | undefined;
    const layers: DesignLayer[] = [];
    for (const layer of graph.layers) {
      // The scene background is the original image. Only the original-background mode puts it on the canvas.
      if (layer.type === 'background') { if (options.mode === 'original') backgroundAsset = await store(layer.imageArtifactId); }
      else layers.push(await sceneLayerToDesignLayer(layer, graph.jobId, store, `layer-${newId()}`));
    }
    const rebuilt = rebuiltBackgroundArtifact(graph);
    if (options.mode === 'blank' && options.includeBackground && rebuilt) layers.unshift(backgroundLayer(`layer-${newId()}`, await store(rebuilt), graph.width, graph.height, 'Background', graph.jobId));
    const blank = options.mode === 'blank';
    return {
      id: `decomposed-${newId()}`, name: blank ? 'Layers on blank canvas' : 'Layers on original image', revision: 0,
      canvas: { width: graph.width, height: graph.height, backgroundColor: '#FFFFFF', ...(blank ? { transparent: true } : {}) }, elements: [], layers,
      decomposition: { jobId: graph.jobId, mode: options.mode },
      ...(backgroundAsset ? { background: { assetId: backgroundAsset, fit: 'cover' as const, focalPoint: { x: 0.5, y: 0.5 } } } : {}),
    };
  } catch (error) {
    await Promise.all(stored.map(id => assets.deleteAsset(id).catch(() => undefined)));
    throw error instanceof Error ? error : new Error('The scene could not be imported.');
  }
}
