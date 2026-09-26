import { validateCanvasSize, type DecompositionJobSummary, type DesignLayer, type DesignVariant, type SceneGraph } from '@frameflow/shared';

type Assets = { putAsset(id: string, blob: Blob): Promise<unknown>; deleteAsset(id: string): Promise<unknown> };
type FetchArtifact = (artifactId: string) => Promise<Blob>;

/**
 * Turn a completed decomposition scene graph into a new editor version at native resolution:
 * the original source is the background, image layers and text rasters become image layers (text keeps its unverified
 * suggestion for "Convert to editable text"), confident shapes become vector shape layers. Order is back-to-front.
 * All assets are stored first; on any failure the stored assets are removed and nothing is added to the design.
 */
export async function sceneToVariant(job: Pick<DecompositionJobSummary, 'id' | 'sceneGraph'>, fetchArtifact: FetchArtifact, assets: Assets, newId: () => string = () => crypto.randomUUID()): Promise<DesignVariant> {
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
      const base = { id: `layer-${newId()}`, name: layer.name.slice(0, 200) || layer.type, x: layer.bbox.x, y: layer.bbox.y, width: layer.bbox.width, height: layer.bbox.height,
        rotation: layer.rotation, opacity: layer.opacity, visible: layer.visible, locked: false };
      if (layer.type === 'background') backgroundAsset = await store(layer.imageArtifactId);
      else if (layer.type === 'image') layers.push({ ...base, type: 'image', assetId: await store(layer.transparentRgbaArtifactId), source: { jobId: graph.jobId, layerId: layer.id, kind: 'image' } });
      else if (layer.type === 'text') layers.push({ ...base, type: 'image', assetId: await store(layer.rasterArtifactId), source: { jobId: graph.jobId, layerId: layer.id, kind: 'text' },
        textSuggestion: { text: layer.text.slice(0, 5000), confidence: layer.textConfidence, ...(layer.color ? { fill: layer.color } : {}), ...(layer.fontSize ? { fontSize: Math.max(8, Math.min(512, layer.fontSize)) } : {}), ...(layer.fontWeight ? { fontWeight: layer.fontWeight } : {}) } });
      else if (layer.shapeType === 'raster' || !layer.fill) layers.push({ ...base, type: 'image', assetId: await store(layer.rasterArtifactId), source: { jobId: graph.jobId, layerId: layer.id, kind: 'shape' } });
      else layers.push({ ...base, type: 'shape', shapeType: layer.shapeType, fill: layer.fill, radius: layer.radius ?? 0, source: { jobId: graph.jobId, layerId: layer.id, kind: 'shape' },
        ...(layer.gradient ? { gradient: layer.gradient } : {}), ...(layer.stroke ? { stroke: layer.stroke } : {}) });
    }
    return {
      id: `decomposed-${newId()}`, name: 'Decomposed design', revision: 0,
      canvas: { width: graph.width, height: graph.height, backgroundColor: '#FFFFFF' }, elements: [], layers,
      ...(backgroundAsset ? { background: { assetId: backgroundAsset, fit: 'cover' as const, focalPoint: { x: 0.5, y: 0.5 } } } : {}),
    };
  } catch (error) {
    await Promise.all(stored.map(id => assets.deleteAsset(id).catch(() => undefined)));
    throw error instanceof Error ? error : new Error('The scene could not be imported.');
  }
}
