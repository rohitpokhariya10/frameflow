import { useState } from 'react';
import type { DecompositionManifest } from '@frameflow/shared';
import { artifactUrl, downloadUrl } from './api';

export function ResultViewer({ manifest, originalId }: { manifest: DecompositionManifest; originalId?: string }) {
  const [hidden, setHidden] = useState<string[]>([]);
  const [original, setOriginal] = useState(false);
  const [generated, setGenerated] = useState(false);
  const [surface, setSurface] = useState('checker');
  return <section aria-label="Decomposition results">
    <div className="decomp-row"><h3>{manifest.status === 'partial' ? 'Partial layer package' : 'Layer package'}</h3><a className="decomp-primary" href={downloadUrl(manifest.jobId)}>Download layers ZIP</a></div>
    <p>{manifest.source.width} × {manifest.source.height} pixels · Straight alpha · Raster layers</p>
    {manifest.warnings.map((warning, index) => <p role="status" key={index}>{warning}</p>)}
    <div className="decomp-row">
      <label><input type="checkbox" checked={original} onChange={(e) => setOriginal(e.target.checked)} disabled={!originalId} /> Original comparison</label>
      <label><input type="checkbox" checked={generated} onChange={(e) => setGenerated(e.target.checked)} /> Generated areas</label>
      <label>Preview surface <select value={surface} onChange={(e) => setSurface(e.target.value)}><option value="checker">Checkerboard</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
    </div>
    <div className={`decomp-composite decomp-${surface}`} style={{ aspectRatio: `${manifest.source.width}/${manifest.source.height}` }}>
      {original && originalId ? <img alt="Original source" src={artifactUrl(originalId)} style={{ inset: 0, width: '100%', height: '100%' }} /> : [...manifest.layers].sort((a, b) => a.zIndex - b.zIndex).filter((layer) => !hidden.includes(layer.id)).map((layer) => {
        const style = { left: `${layer.bbox.x / manifest.source.width * 100}%`, top: `${layer.bbox.y / manifest.source.height * 100}%`, width: `${layer.bbox.width / manifest.source.width * 100}%`, height: `${layer.bbox.height / manifest.source.height * 100}%` };
        return <span key={layer.id}><img alt="" src={artifactUrl(layer.rgba.artifactId)} style={style} />{generated && layer.generatedSupport && <img className="decomp-generation-overlay" alt={`Generated support for ${layer.label}`} src={artifactUrl(layer.generatedSupport.artifactId)} style={style} />}</span>;
      })}
    </div>
    <div className="decomp-layer-grid">{manifest.layers.map((layer) => <article key={layer.id}>
      <label><input type="checkbox" checked={!hidden.includes(layer.id)} onChange={(e) => setHidden(e.target.checked ? hidden.filter((id) => id !== layer.id) : [...hidden, layer.id])} /> {layer.label}</label>
      <a href={artifactUrl(layer.rgba.artifactId)} target="_blank" rel="noreferrer"><img className={`decomp-${surface}`} src={artifactUrl(layer.rgba.artifactId)} alt={`${layer.label} isolated layer`} loading="lazy" /></a>
      <small>{layer.bbox.width} × {layer.bbox.height} at {layer.bbox.x}, {layer.bbox.y}<br />{layer.generation === 'none' ? 'Observed pixels' : 'Includes generated content'} · {layer.completionStatus}</small>
      {layer.quality.warnings.map((warning, i) => <p key={i}>{warning}</p>)}
    </article>)}</div>
  </section>;
}
