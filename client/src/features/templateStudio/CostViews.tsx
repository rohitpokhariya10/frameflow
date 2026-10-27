/**
 * Cost tables for the client presentation. Every figure says what it is: an upper-bound estimate before a run, a cost
 * calculated from the usage the provider reported, or a reserved estimate where the provider reported none (never ₹0).
 */
import type { StudioCostSummary, StudioEstimate, StudioFx } from '@frameflow/shared';
import { Badge, Money } from './ui';

export const fxNote = (fx: StudioFx) => `Rupees at ${fx.note}`;

export function EstimateTable({ estimate }: { estimate: StudioEstimate }) {
  const counted = estimate.lines;
  return <div className="ts-cost">
    {estimate.localReuse && <p className="ts-hint">Local reference reuse · no AI image will be generated and nothing is charged for it: the template's original reference is copied unchanged, with its products, raster text and logos. To keep its text and logos out of decomposition later, protect them (Protect text &amp; logos).</p>}
    {estimate.daily && <p className="ts-hint">Studio daily budget: {estimate.daily.remaining.usd} remaining of {estimate.daily.cap.usd}; {estimate.daily.used.usd} used or reserved, including {estimate.daily.held.usd} held. {estimate.daily.fits ? 'This estimate fits.' : 'Insufficient budget — paid generation is blocked.'}</p>}
    <table className="ts-cost-table">
      <caption className="ts-sr">Estimated cost before generating</caption>
      <thead><tr><th scope="col">Stage</th><th scope="col">Model</th><th scope="col" className="ts-num">Up to</th></tr></thead>
      <tbody>
        {estimate.lines.map(line => <tr key={line.stage} className={line.stage.startsWith('Structure repair') ? 'is-optional' : undefined}>
          <th scope="row">{line.stage}{line.cached && <Badge tone="ok">cached · no new call</Badge>}{line.note && <small>{line.note}</small>}</th>
          <td><code>{line.model}</code></td>
          <td className="ts-num">{line.cached && line.cost.microUsd === 0 ? <span className="ts-muted">₹0 new</span> : <Money value={line.cost} />}</td>
        </tr>)}
      </tbody>
      <tfoot><tr><th scope="row">Estimated total ({counted.length} stages)</th><td /><td className="ts-num"><strong><Money value={estimate.total} prefix="up to " /></strong></td></tr></tfoot>
    </table>
    <p className="ts-footnote">{estimate.note} Limit per poster {estimate.cap.inr} ({estimate.cap.usd}). {fxNote(estimate.fx)} Rate card {estimate.rateCardVersion}.</p>
  </div>;
}

const STATUS = {
  usage_derived: { tone: 'ok' as const, text: 'Calculated from provider usage' },
  estimate_only: { tone: 'warn' as const, text: 'Estimate · provider charge unconfirmed' },
};

export function RecordedCost({ cost, title = 'Recorded cost', empty = 'No paid calls recorded yet.' }: { cost: StudioCostSummary; title?: string; empty?: string }) {
  if (!cost.calls) return <p className="ts-muted">{empty}</p>;
  return <div className="ts-cost">
    <table className="ts-cost-table">
      <caption className="ts-sr">{title}</caption>
      <thead><tr><th scope="col">Call</th><th scope="col">Model</th><th scope="col">Status</th><th scope="col" className="ts-num">Cost</th></tr></thead>
      <tbody>
        {cost.lines.map((line, i) => <tr key={`${line.stage}-${i}`}>
          <th scope="row">{line.label}{line.providerRequestId && <small title="Provider request id">{line.providerRequestId}</small>}</th>
          <td><code>{line.model}</code></td>
          <td><Badge tone={STATUS[line.status].tone}>{STATUS[line.status].text}</Badge></td>
          <td className="ts-num">{line.recorded ? <Money value={line.recorded} /> : line.estimated ? <Money value={line.estimated} prefix="≈ " /> : <span className="ts-muted">unknown</span>}</td>
        </tr>)}
      </tbody>
      <tfoot><tr><th scope="row">{cost.calls} paid call{cost.calls === 1 ? '' : 's'}{cost.unknownCalls ? ` · ${cost.unknownCalls} without provider usage` : ''}</th><td /><td /><td className="ts-num"><strong><Money value={cost.total} /></strong></td></tr></tfoot>
    </table>
    <p className="ts-footnote">{cost.unknownCalls ? `${cost.estimatedOnly.inr} of this is the reserved upper-bound estimate for calls whose provider reported no usage; it is not shown as free. ` : 'Calculated from the token usage each provider reported. '}The provider's billing dashboard is authoritative. {fxNote(cost.fx)} Rate card {cost.rateCardVersion}.</p>
  </div>;
}
