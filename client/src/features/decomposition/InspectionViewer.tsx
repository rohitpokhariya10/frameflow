import { useState } from 'react';
import type { DecompositionJobSummary } from '@frameflow/shared';
import { artifactUrl } from './api';

/** Phase-5 inspection only: proposals and masks, no editable layers or final package. */
export function InspectionViewer({ job }: { job: DecompositionJobSummary }) {
  const [surface, setSurface] = useState('checker');
  const groups = ['01-original', '02-analysis', '03-discovery', '03-qwen', '04-semantic', '04-sam2', '05-refined', '06-extracted'];
  const labels = ['Original', 'Analysis', 'Qwen proposals', 'Semantic targets — inspect completeness', 'Advanced / raw proposals', 'Ownership and alpha — review required', 'Extracted layers'];
  const latest = [...new Map(job.artifacts.map((artifact) => [artifact.relativePath, artifact])).values()];
  return <section aria-label="Phase 1 to 6 inspection">
    <h3>Pipeline inspection</h3><p>White means object support. Gray alpha means partial opacity. Proposal RGB is generated guidance; it is not an extracted source layer.</p>
    <label>Inspection surface <select value={surface} onChange={(event) => setSurface(event.target.value)}><option value="checker">Checkerboard</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
    {groups.map((group, i) => <details key={group} open={i === Math.min(job.phase - 1, 5)}><summary>{labels[i]}</summary>
      <div className="decomp-layer-grid">{latest.filter((a) => a.relativePath.startsWith(group + '/') && a.mimeType.startsWith('image/') && !a.relativePath.includes('-native.png')).map((artifact) => <article key={artifact.artifactId}>
        <a href={artifactUrl(artifact.artifactId)} target="_blank" rel="noreferrer"><img className={`decomp-${surface}`} src={artifactUrl(artifact.artifactId)} alt={artifact.relativePath} loading="lazy" /></a>
        <p>{job.candidates?.find(c => [c.overlayArtifactId, c.maskArtifactId, c.analysisMaskArtifactId].includes(artifact.artifactId))?.id} </p><p>{artifact.relativePath.split('/').at(-1)}</p><small>{artifact.width} × {artifact.height}</small><br /><a href={`${artifactUrl(artifact.artifactId)}?download=1`}>Download PNG</a>
      </article>)}</div>
      {latest.filter((a) => a.relativePath.startsWith(group + '/') && a.mimeType === 'application/json').map((artifact) => <p key={artifact.artifactId}><a href={artifactUrl(artifact.artifactId)} target="_blank" rel="noreferrer">{artifact.relativePath.split('/').at(-1)}</a></p>)}
    </details>)}
  </section>;
}
