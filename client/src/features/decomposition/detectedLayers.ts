import type { DecompositionJobSummary, DesignLayer, DesignVariant, DetectedLayerCutout, ProposalReviewTarget, SceneLayer } from '@frameflow/shared';
import { rebuiltBackgroundArtifact } from './importScene';

/** A layer AI detected in the image, and whether it is on the current canvas. */
export type DetectedItem = {
  target: ProposalReviewTarget;
  /** The layer the pipeline produced for it (AI-refined image, text or shape), when it was added to the editor at review. */
  sceneLayer?: Exclude<SceneLayer, { type: 'background' }>;
  onCanvas: boolean;
};

/** Layers added from the tray without the pipeline carry this layer id, so they are recognised on the canvas. */
export const cutoutLayerId = (targetId: string) => `detected-${targetId}`;

export function detectedItems(job: Pick<DecompositionJobSummary, 'id' | 'proposalTargets' | 'sceneGraph'>, variant: Pick<DesignVariant, 'layers'>): DetectedItem[] {
  const sources = new Set((variant.layers ?? []).filter(l => l.source?.jobId === job.id).map(l => l.source!.layerId));
  return (job.proposalTargets ?? []).filter(t => !t.baseLayer).map(target => {
    const sceneLayer = job.sceneGraph?.layers.find((l): l is Exclude<SceneLayer, { type: 'background' }> => l.type !== 'background' && l.targetId === target.id);
    return { target, sceneLayer, onCanvas: sources.has(cutoutLayerId(target.id)) || (!!sceneLayer && sources.has(sceneLayer.id)) };
  });
}

/** The background AI rebuilt without the layers (never the original image), if the job has one. */
export const detectedBackground = (job: Pick<DecompositionJobSummary, 'sceneGraph' | 'discovery'>) =>
  rebuiltBackgroundArtifact(job.sceneGraph) ?? job.discovery?.baseLayer?.artifactId;

/** A cut-out as an editor layer at the position it had in the original image. */
export function cutoutToLayer(cutout: DetectedLayerCutout, jobId: string, assetId: string, id: string, name = cutout.label): DesignLayer {
  return { id, type: 'image', name: name.slice(0, 200) || 'Layer', assetId, x: cutout.bbox.x, y: cutout.bbox.y, width: cutout.bbox.width, height: cutout.bbox.height,
    rotation: 0, opacity: 1, visible: true, locked: false, source: { jobId, layerId: cutoutLayerId(cutout.targetId), kind: cutout.kind },
    ...(cutout.kind === 'text' && cutout.textSuggestion ? { textSuggestion: { text: cutout.textSuggestion.text.slice(0, 5000), confidence: cutout.textSuggestion.textConfidence } } : {}) };
}

/** Per-job tray preferences in this browser: layers hidden from the tray and names the user gave them. */
export type TrayPrefs = { hidden: string[]; names: Record<string, string> };
const prefsKey = (jobId: string) => `frameflow:detected-layers:${jobId}`;
export function loadTrayPrefs(jobId: string): TrayPrefs {
  try {
    const value = JSON.parse(localStorage.getItem(prefsKey(jobId)) || 'null') as Partial<TrayPrefs> | null;
    return { hidden: Array.isArray(value?.hidden) ? value.hidden.filter(id => typeof id === 'string') : [], names: value?.names && typeof value.names === 'object' ? Object.fromEntries(Object.entries(value.names).filter(([, v]) => typeof v === 'string')) : {} };
  } catch { return { hidden: [], names: {} }; }
}
export function saveTrayPrefs(jobId: string, prefs: TrayPrefs) { try { localStorage.setItem(prefsKey(jobId), JSON.stringify(prefs)); } catch { /* optional */ } }
