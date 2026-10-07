import { useState } from 'react';
import { LayoutDashboard, ImagePlus, Layers3, History, Search, ArrowUpRight } from 'lucide-react';
import { dashboardStatus } from './RunDashboard';
import { editorLayersOf, experimentFileUrl, type ExperimentRun } from './layerizeExperiment';

export const EXPERIMENT_TABS = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'create', label: 'Create Template', icon: ImagePlus },
  { id: 'decompose', label: 'Decompose/Test', icon: Layers3 },
  { id: 'saved', label: 'Saved Runs', icon: History },
] as const;
export type ExperimentTab = typeof EXPERIMENT_TABS[number]['id'];
export function ExperimentTabs({ current, onChange, runCount }: { current: ExperimentTab; onChange: (tab: ExperimentTab) => void; runCount: number }) {
  return <nav className="ff-lab-nav" aria-label="Test workspace"><div role="tablist" aria-label="Test sections">
    {EXPERIMENT_TABS.map(({ id, label, icon: Icon }, index) => <button key={id} type="button" role="tab" id={`lab-tab-${id}`} aria-controls={`lab-panel-${id}`}
      aria-selected={current === id} tabIndex={current === id ? 0 : -1} onClick={() => onChange(id)} onKeyDown={event => {
        const next = event.key === 'ArrowRight' ? (index + 1) % EXPERIMENT_TABS.length : event.key === 'ArrowLeft' ? (index + EXPERIMENT_TABS.length - 1) % EXPERIMENT_TABS.length : event.key === 'Home' ? 0 : event.key === 'End' ? EXPERIMENT_TABS.length - 1 : undefined;
        if (next === undefined) return;
        event.preventDefault(); onChange(EXPERIMENT_TABS[next].id);
        (event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role=tab]')[next])?.focus();
      }}><Icon size={17} aria-hidden="true" /><span>{label}</span>{id === 'saved' && runCount > 0 && <span className="ff-lab-nav-count" aria-hidden="true">{runCount}</span>}</button>)}
  </div></nav>;
}
export function runLayerCount(run: ExperimentRun) {
  try { return editorLayersOf(run)?.length ?? 0; } catch { return 0; }
}
export function savedRunStatus(run: ExperimentRun) {
  return dashboardStatus(run, runLayerCount(run));
}
export function filterSavedRuns(runs: ExperimentRun[], query: string, status: string) {
  const text = query.trim().toLowerCase();
  return runs.filter(run => (!text || `${run.id} ${run.templateKey ?? 'template-a'} ${run.createdAt} ${savedRunStatus(run)}`.toLowerCase().includes(text))
    && (status === 'all' || savedRunStatus(run) === status));
}
const LABELS: Record<string, string> = { 'READY FOR EDITOR': 'Ready for editor', PARTIAL: 'Needs review', FAILED: 'Failed', RUNNING: 'Running' };
export function SavedRunBrowser({ runs, loading, selected, busy, onSelect }: { runs: ExperimentRun[]; loading: boolean; selected?: string; busy: boolean; onSelect: (id: string) => void }) {
  const [query, setQuery] = useState(''), [status, setStatus] = useState('all');
  const filtered = filterSavedRuns(runs, query, status);
  return <>
    <div className="ff-lab-page-heading"><div><p className="ff-lab-kicker">YOUR TEST HISTORY</p><h2>Saved runs</h2><p>Reopen results, compare layers, and inspect recorded costs.</p></div><span className="ff-lab-count">{runs.length} runs</span></div>
    <div className="ff-lab-filters">
      <label className="ff-lab-search"><Search size={17} aria-hidden="true" /><input aria-label="Search saved runs" placeholder="Search by run ID, template, or date" value={query} onChange={e => setQuery(e.target.value)} /></label>
      <label className="ff-lab-filter">Status<select aria-label="Filter runs by status" value={status} onChange={e => setStatus(e.target.value)}><option value="all">All statuses</option>{Object.entries(LABELS).map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>
    </div>
    {loading ? <p role="status">Loading saved runs…</p> : !filtered.length ? <div className="ff-lab-empty"><History size={28} aria-hidden="true" /><h3>{runs.length ? 'No matching runs' : 'Your results will appear here'}</h3><p>{runs.length ? 'Try another search or status filter.' : 'Create an image or upload one in Decompose/Test to get started.'}</p>{runs.length > 0 && <button className="ws-btn" onClick={() => { setQuery(''); setStatus('all'); }}>Clear filters</button>}</div>
      : <div className="ff-lab-run-grid">{filtered.map(run => {
        const status = savedRunStatus(run), layers = runLayerCount(run), counts = run.refinement?.curation?.counts;
        return <article key={run.id} className={`ff-lab-run-card${selected === run.id ? ' is-selected' : ''}`} aria-label={`Saved run ${run.id}`}>
          <div className="ff-lab-run-thumb"><img loading="lazy" src={experimentFileUrl(run.id, run.original.file)} alt="" /><span className={`lx-badge lx-${status === 'FAILED' ? 'failed' : status === 'PARTIAL' ? 'warning' : status === 'RUNNING' ? 'running' : 'complete'}`}>{LABELS[status]}</span></div>
          <div className="ff-lab-run-info"><h3>{(run.templateKey ?? 'template-a').replace('template-', 'Template ').toUpperCase().replace('TEMPLATE', 'Template')}</h3><p>{new Date(run.createdAt).toLocaleString()}</p>
            <p>{counts ? `${counts.rawLayers} raw → ${counts.editorLayers} editor layers` : run.stage === 'done' ? `${layers} editor layers` : LABELS[status]}{run.origin?.aspectRatio ? ` · ${run.origin.aspectRatio}` : ''}</p>
            <small className="ff-lab-run-id">{run.id}</small><button className="ws-btn" disabled={busy} onClick={() => onSelect(run.id)}>View run <ArrowUpRight size={15} aria-hidden="true" /></button>
          </div>
        </article>;
      })}</div>}
  </>;
}
