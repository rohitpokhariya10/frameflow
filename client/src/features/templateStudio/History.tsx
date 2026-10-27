/** Generation history (Generator HistoryList): every poster run and template analysis, with status and recorded cost. */
import { useEffect, useState } from 'react';
import { History, Search } from 'lucide-react';
import { FIDELITY_MODES, type StudioHistoryItem } from '@frameflow/shared';
import { studioApi } from './api';
import { Alert, Badge, Empty, PageHeading, fmtDate } from './ui';

function stateBadge(i: StudioHistoryItem) {
  if (i.poster?.reviewStatus === 'ok') return <Badge tone="ok">Ready</Badge>;
  if (i.poster?.reviewStatus === 'needs_review') return <Badge tone="warn">Needs review</Badge>;
  if (i.state === 'failed') return <Badge tone="danger">Failed</Badge>;
  if (i.state === 'cancelled') return <Badge>Cancelled</Badge>;
  if (i.state === 'complete') return <Badge tone="ok">Done</Badge>;
  return <Badge tone="accent">In progress</Badge>;
}
const kindLabel = (i: StudioHistoryItem) => (i.kind === 'analyse_template' ? 'Template analysis' : 'Image generation');

export function GenerationHistory({ onOpenPoster, onOpenJob, onOpenTemplate }: { onOpenPoster: (id: string) => void; onOpenJob: (id: string) => void; onOpenTemplate: () => void }) {
  const [items, setItems] = useState<StudioHistoryItem[] | null>(null), [error, setError] = useState('');
  const [query, setQuery] = useState(''), [kind, setKind] = useState('all');
  useEffect(() => {
    let alive = true;
    const load = () => studioApi.get<{ items: StudioHistoryItem[] }>('/posters').then(r => { if (alive) { setItems(r.items); setError(''); } }).catch((e: Error) => { if (alive) setError(e.message); });
    void load();
    const poll = setInterval(() => void load(), 5000);
    return () => { alive = false; clearInterval(poll); };
  }, []);
  const shown = (items ?? []).filter(i => (kind === 'all' || i.kind === kind) && `${i.headline ?? ''} ${i.templateName ?? ''} ${i.state} ${i.formatLabel ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()));
  const totalInr = (items ?? []).reduce((s, i) => s + i.cost.total.microUsd, 0);
  const unknown = (items ?? []).reduce((s, i) => s + i.cost.unknownCalls, 0);
  const fx = items?.[0]?.cost.fx;
  return <div className="ts-page">
    <PageHeading kicker="TEMPLATE STUDIO" title="Generation history">Every image generation and template analysis, with its status and recorded cost. Decomposition costs are on each FrameFlow run.</PageHeading>
    {error && <Alert>{error}</Alert>}
    {items && items.length > 0 && <div className="ts-stats">
      <div><span>Image generations</span><strong>{items.filter(i => i.kind === 'generate_poster').length}</strong></div>
      <div><span>Template analyses</span><strong>{items.filter(i => i.kind === 'analyse_template').length}</strong></div>
      <div><span>Recorded spend</span><strong>{fx ? `₹${((totalInr / 1e6) * fx.rate).toFixed(0)}` : '–'}</strong><small>${(totalInr / 1e6).toFixed(2)}{unknown ? ` · ${unknown} call(s) at reserved estimate` : ''}</small></div>
    </div>}
    <div className="ts-filters">
      <label className="ts-search"><Search size={16} aria-hidden="true" /><input aria-label="Search history" placeholder="Search by headline, template or status" value={query} onChange={e => setQuery(e.target.value)} /></label>
      <label className="ts-inline-select">Show<select aria-label="Filter history" value={kind} onChange={e => setKind(e.target.value)}><option value="all">Everything</option><option value="generate_poster">Image generations</option><option value="analyse_template">Template analyses</option></select></label>
    </div>
    {items === null ? <p className="ts-muted" role="status">Loading history…</p> : !shown.length ? <Empty icon={<History size={28} aria-hidden="true" />} title={items.length ? 'Nothing matches' : 'Nothing yet'}>{items.length ? 'Try another search or filter.' : 'Generated images and template analyses appear here.'}</Empty>
      : <ul className="ts-history-grid">{shown.map(i => <li key={i.jobId} className="ts-history-card">
        <button type="button" className="ts-history-thumb" onClick={() => (i.poster ? onOpenPoster(i.poster.id) : i.kind === 'analyse_template' ? onOpenTemplate() : onOpenJob(i.jobId))} aria-label={`Open ${i.headline ?? i.templateName ?? kindLabel(i)}`}>
          {i.poster ? <img src={i.poster.thumb} alt="" loading="lazy" /> : <>{i.templateThumb && <img src={i.templateThumb} alt="" loading="lazy" className="is-reference" />}<span className="ts-history-tag">{i.kind === 'analyse_template' ? 'Template analysis' : i.state === 'failed' ? 'Generation failed' : i.state === 'cancelled' ? 'Cancelled' : 'Generating…'}</span></>}
        </button>
        <div className="ts-history-info">
          <div className="ts-template-name"><h3>{i.headline ?? i.templateName ?? kindLabel(i)}</h3>{stateBadge(i)}</div>
          <p>{kindLabel(i)}{i.templateName ? ` · ${i.templateName}` : ''}</p>
          <p className="ts-muted">{fmtDate(i.createdAt)}{i.fidelityMode ? ` · ${FIDELITY_MODES.find(m => m.id === i.fidelityMode)?.label}` : ''}{i.formatLabel ? ` · ${i.formatLabel}` : ''}</p>
          <p className="ts-history-cost">{i.cost.calls ? <>{i.cost.total.inr} <small>{i.cost.total.usd} · {i.cost.calls} call{i.cost.calls === 1 ? '' : 's'}{i.cost.unknownCalls ? ' · includes estimate' : ''}</small></> : <small>No paid calls recorded</small>}{i.poster?.decomposed && <Badge tone="accent">decomposed</Badge>}</p>
        </div>
      </li>)}</ul>}
  </div>;
}
