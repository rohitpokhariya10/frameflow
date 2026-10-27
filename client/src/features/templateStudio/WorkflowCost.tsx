/**
 * The whole journey's cost beside FrameFlow's run dashboard, for runs that came from a generated image. Template Studio's
 * recorded costs and FrameFlow's own decomposition total (its existing calculation, read as is) are shown side by side;
 * unknown amounts are flagged, never counted as zero, and the one-time template analysis is kept apart so it is not
 * charged again to every image made from the template.
 */
import type { RunDiagnostics } from '@frameflow/shared';
import type { StudioRunLink } from './editorImport';
import { Badge } from './ui';

const inr = (usd: number, fx: number) => `₹${(usd * fx).toFixed(usd * fx < 10 ? 2 : 0)}`;

export function WorkflowCost({ link, diagnostics, onOpenPoster }: { link: StudioRunLink; diagnostics?: RunDiagnostics; onOpenPoster: (id: string) => void }) {
  const generation = link.costs?.generation, template = link.costs?.template ?? null;
  const fx = generation?.fx.rate ?? diagnostics?.fx ?? 90;
  const decomposition = diagnostics?.total;
  const genUsd = (generation?.total.microUsd ?? 0) / 1e6, tplUsd = (template?.total.microUsd ?? 0) / 1e6, decUsd = decomposition?.knownUsd ?? 0;
  const unknown = [generation?.unknownCalls ? 'generation includes reserved estimates' : '', decomposition && decomposition.confidence !== 'Calculated' ? `decomposition ${decomposition.confidence.toLowerCase()}` : '', !decomposition ? 'decomposition not loaded' : ''].filter(Boolean);
  return <section className="ts-workflow-cost" aria-label="Workflow cost">
    <header>
      {link.poster && <button type="button" className="ts-workflow-thumb" onClick={() => onOpenPoster(link.poster!.id)} aria-label="Open the generated image"><img src={link.poster.thumb} alt="" /></button>}
      <div><p className="ts-kicker">FROM TEMPLATE STUDIO</p><h3>{link.poster?.headline ?? (link.poster?.provenance === 'reference_reuse' ? 'Reused reference' : 'Generated image')}</h3>
        {link.poster?.provenance === 'reference_reuse'
          ? <p>{link.template?.name ?? 'Template'} → <Badge tone="warn">original reference reused, no image generated</Badge> → this FrameFlow decomposition ({link.link?.sentWidth}×{link.link?.sentHeight}, with the reference's own text and logos)</p>
          : <p>{link.template?.name ?? 'Template'} → generated image → this FrameFlow decomposition ({link.link?.sentWidth}×{link.link?.sentHeight} text-free scene)</p>}</div>
    </header>
    <table className="ts-cost-table">
      <thead><tr><th scope="col">Stage</th><th scope="col">Basis</th><th scope="col" className="ts-num">Cost</th></tr></thead>
      <tbody>
        <tr><th scope="row">Template analysis <small>one-time, reused by every image from this template</small></th><td>{template?.calls ? `${template.calls} recorded call(s)` : 'Reused (no new call)'}</td><td className="ts-num">{template?.calls ? template.total.inr : '₹0 new'}</td></tr>
        <tr><th scope="row">Image generation</th><td>{generation ? `${generation.calls} recorded call(s)${generation.unknownCalls ? ` · ${generation.unknownCalls} at reserved estimate` : ''}` : '–'}</td><td className="ts-num">{generation?.total.inr ?? '–'}</td></tr>
        <tr><th scope="row">Decomposition <small>FrameFlow's existing calculation (below)</small></th><td>{decomposition ? <Badge tone={decomposition.confidence === 'Calculated' ? 'ok' : 'warn'}>{decomposition.confidence}</Badge> : 'Loading…'}</td><td className="ts-num">{decomposition ? decomposition.inr === null ? `${inr(decUsd, diagnostics!.fx)} known + unknown` : inr(decomposition.knownUsd, diagnostics!.fx) : '–'}</td></tr>
      </tbody>
      <tfoot>
        <tr><th scope="row">This image: generation + decomposition</th><td>{unknown.length ? <Badge tone="warn">{unknown.join('; ')}</Badge> : <Badge tone="ok">all recorded</Badge>}</td><td className="ts-num"><strong>{inr(genUsd + decUsd, fx)}{unknown.length ? '+' : ''}</strong></td></tr>
        <tr><th scope="row">Including the one-time template analysis</th><td /><td className="ts-num">{inr(genUsd + decUsd + tplUsd, fx)}{unknown.length ? '+' : ''}</td></tr>
      </tfoot>
    </table>
    <p className="ts-footnote">Rupees at ₹{fx}/$ (AI_BUDGET_USD_INR, configured){diagnostics && diagnostics.fx !== fx ? `; the decomposition dashboard uses ₹${diagnostics.fx}/$` : ''}. Known amounts only; a "+" means part of the cost is not confirmed by the provider. Each recorded charge is counted once.</p>
  </section>;
}
