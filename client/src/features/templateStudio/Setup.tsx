/** Setup & usage (Generator SetupPanel + CostCard): readiness, models, limits, estimates and recorded spend. No secrets. */
import { Fragment, useEffect, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight, RefreshCw, XCircle } from 'lucide-react';
import type { StudioCostSummary, StudioFx, StudioMoney } from '@frameflow/shared';
import { studioApi } from './api';
import { RecordedCost, fxNote } from './CostViews';
import { Alert, Badge, Money, PageHeading, StepCard, fmtDate } from './ui';

interface Check { ok: boolean; message: string }
interface SetupStatus {
  config: { apiKeyConfigured: boolean; models: Record<string, string>; textReasoningEffort: string; imageQuality: string; maxImageAttemptsPerJob: number; maxJobBudgetUsd: number; maxTemplateBudgetUsd: number; dailyBudgetUsd: number; fx: StudioFx; variables: string[] };
  checks: Record<'apiKey' | 'storage' | 'worker' | 'fonts' | 'decomposition', Check & { lastSeenAt?: string | null }>;
  counts: Record<string, number>;
}
interface Workflow { label: string; total: StudioMoney; cap: StudioMoney; withinCap: boolean; calls: { stage: string; model: string; cost: StudioMoney; assumptions: string[] }[] }
interface Costs { rateCardVersion: string; fx: StudioFx; workflows: Workflow[]; estimateError: string | null; today: { spent: StudioMoney; cap: StudioMoney }; recorded: StudioCostSummary; note: string }
const CHECK_LABEL: Record<string, string> = { apiKey: 'OpenAI API key', storage: 'Storage', worker: 'Generation worker', fonts: 'Exact-text fonts', decomposition: 'FrameFlow decomposition' };

export function SetupPanel() {
  const [status, setStatus] = useState<SetupStatus | null>(null), [costs, setCosts] = useState<Costs | null>(null), [error, setError] = useState('');
  const [open, setOpen] = useState<string | null>(null), [models, setModels] = useState<{ role: string; model: string; ok: boolean; error?: { message: string } }[] | null>(null), [checking, setChecking] = useState(false);
  const load = () => Promise.all([studioApi.get<SetupStatus>('/setup'), studioApi.get<Costs>('/costs')]).then(([s, c]) => { setStatus(s); setCosts(c); setError(''); }).catch((e: Error) => setError(e.message));
  useEffect(() => { void load(); }, []);
  return <div className="ts-page">
    <PageHeading kicker="TEMPLATE STUDIO" title="Setup & usage" actions={<button type="button" className="ws-btn" onClick={() => void load()}><RefreshCw size={15} aria-hidden="true" /> Refresh</button>}>Readiness of the generation pipeline, its models and limits, and what it has cost. API keys never leave the server.</PageHeading>
    {error && <Alert>{error}</Alert>}
    {status && <div className="ts-two">
      <StepCard title="Readiness">
        <ul className="ts-checks">{Object.entries(status.checks).map(([id, c]) => <li key={id} className={c.ok ? 'is-pass' : 'is-fail'}>{c.ok ? <CheckCircle2 size={18} aria-hidden="true" /> : <XCircle size={18} aria-hidden="true" />}<div><strong>{CHECK_LABEL[id] ?? id}</strong><p>{c.message}{c.lastSeenAt ? ` Last active ${fmtDate(c.lastSeenAt)}.` : ''}</p></div></li>)}</ul>
        <p className="ts-muted">{status.counts.templates} templates · {status.counts.posters} generated images · {status.counts.assets} assets · {status.counts.brandKits} brand kits</p>
      </StepCard>
      <StepCard title="Models and limits">
        <dl className="ts-facts">
          {Object.entries(status.config.models).map(([role, model]) => <div key={role}><dt>{role}</dt><dd><code>{model}</code>{models && (() => { const r = models.find(m => m.role === role); return r ? r.ok ? <Badge tone="ok">available</Badge> : <Badge tone="danger">{r.error?.message ?? 'unavailable'}</Badge> : null; })()}</dd></div>)}
          <div><dt>Image quality</dt><dd>{status.config.imageQuality} (default) · {status.config.maxImageAttemptsPerJob} image request per generation, never retried automatically</dd></div>
          <div><dt>Reasoning effort</dt><dd>{status.config.textReasoningEffort}</dd></div>
          <div><dt>Limits</dt><dd>${status.config.maxJobBudgetUsd} per image · ${status.config.maxTemplateBudgetUsd} per template · ${status.config.dailyBudgetUsd} per day</dd></div>
          <div><dt>Rupees</dt><dd>{status.config.fx.note}</dd></div>
        </dl>
        <button type="button" className="ws-btn" disabled={checking || !status.config.apiKeyConfigured} onClick={async () => { setChecking(true); try { setModels((await studioApi.post<{ results: NonNullable<typeof models> }>('/setup/check-models')).results); } catch (e) { setError(e instanceof Error ? e.message : 'The check failed.'); } finally { setChecking(false); } }}>{checking ? 'Checking…' : 'Verify model access'}</button>
        <small className="ts-hint">Uses OpenAI's models endpoint, which is free (no tokens). Configured with: {status.config.variables.join(', ')}.</small>
      </StepCard>
    </div>}
    {costs && <>
      <StepCard title="Cost estimates" hint={costs.note} aside={<span className="ts-muted">Spent today: {costs.today.spent.inr} ({costs.today.spent.usd}) of {costs.today.cap.inr}</span>}>
        {costs.estimateError && <Alert>{costs.estimateError}</Alert>}
        <table className="ts-cost-table">
          <thead><tr><th scope="col">Workflow</th><th scope="col" className="ts-num">Up to</th><th scope="col" className="ts-num">Limit</th><th scope="col" /></tr></thead>
          <tbody>{costs.workflows.map(w => <Fragment key={w.label}>
            <tr><th scope="row"><button type="button" className="ts-expand" aria-expanded={open === w.label} onClick={() => setOpen(open === w.label ? null : w.label)}>{open === w.label ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}{w.label}</button></th>
              <td className="ts-num"><Money value={w.total} /></td><td className="ts-num">{w.cap.inr}</td><td>{w.withinCap ? <Badge tone="ok">within limit</Badge> : <Badge tone="danger">over limit</Badge>}</td></tr>
            {open === w.label && <tr className="ts-subrow"><td colSpan={4}><ul>{w.calls.map(c => <li key={c.stage}><span>{c.stage} <code>{c.model}</code></span><Money value={c.cost} /></li>)}</ul><ul className="ts-assumptions">{[...new Set(w.calls.flatMap(c => c.assumptions))].map(a => <li key={a}>{a}</li>)}</ul></td></tr>}
          </Fragment>)}</tbody>
        </table>
        <p className="ts-footnote">{fxNote(costs.fx)} Rate card {costs.rateCardVersion}. A card may add a forex fee on top.</p>
      </StepCard>
      <StepCard title="All recorded Template Studio spend" hint="Every paid call made by template analysis, image generation, review and cutouts. FrameFlow decomposition costs are on each run in Overview.">
        <RecordedCost cost={costs.recorded} empty="No paid calls yet." />
      </StepCard>
    </>}
  </div>;
}
