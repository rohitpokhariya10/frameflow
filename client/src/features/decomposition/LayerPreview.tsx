import { useEffect, useState } from 'react';
import { editorLayersOf, experimentApi, experimentFileUrl, type ExperimentRun } from './layerizeExperiment';

/** Read-only preview of exactly the final layers the existing editor importer will use. */
export function LayerPreview({ runId, open = false }: { runId: string; open?: boolean }) {
  const [expanded, setExpanded] = useState(open);
  const [run, setRun] = useState<ExperimentRun>();
  const [error, setError] = useState('');
  useEffect(() => {
    if (!expanded || run) return;
    let current = true;
    void experimentApi.get(runId).then(value => { if (current) { setRun({ ...value, outputLayers: editorLayersOf(value) }); setError(''); } }).catch((reason: Error) => { if (current) setError(reason.message); });
    return () => { current = false; };
  }, [expanded, run, runId]);
  return <details className="cti-advanced" open={open} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>Preview layers</summary>
    {expanded && <>
      {error ? <p role="alert">{error} Close and reopen this preview to try again.</p> : !run ? <p role="status">Loading layers…</p> : <>
        <div className="cti-layer-previews">{(run.outputLayers ?? run.layers ?? []).map(layer => <figure key={layer.file}>
          <img src={experimentFileUrl(run.id, layer.file)} alt={layer.name ?? `Layer ${layer.zIndex}`} loading="lazy" />
          <figcaption>{layer.name ?? `Layer ${layer.zIndex}`}{layer.placement.kind === 'unresolved' ? ' · placement needs review' : ''}</figcaption>
        </figure>)}</div>
        {run.refinement?.background && ['fallback', 'contaminated'].includes(run.refinement.background.status) && <p className="ws-hint">The recovered background may need touch-ups.</p>}
        <p className="ws-hint">Each output opens as an image layer you can move, resize or replace. Text within an image remains pixels.</p>
      </>}
    </>}
  </details>;
}
