/** A template's learned style (Generator TemplateDetail): what the AI understood, what stays, what may change, and its cost. */
import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, RefreshCw, Sparkles } from 'lucide-react';
import type { StudioBrandKit, StudioTemplate } from '@frameflow/shared';
import { newIdempotencyKey, studioApi } from './api';
import { RecordedCost } from './CostViews';
import { Alert, Badge, Field, JobSteps, StepCard, fmtDate, useJob } from './ui';

export function statusBadge(status: StudioTemplate['status']) {
  if (status === 'ready') return <Badge tone="ok">Ready</Badge>;
  if (status === 'analysing') return <Badge tone="accent">Analysing…</Badge>;
  if (status === 'failed') return <Badge tone="danger">Analysis failed</Badge>;
  return <Badge>{status}</Badge>;
}
const pct = (v: number) => `${Math.round(v * 100)}%`;

export function TemplateDetail({ template, onChange, onBack, onGenerate }: { template: StudioTemplate; onChange: (t: StudioTemplate) => void; onBack?: () => void; onGenerate: (t: StudioTemplate) => void }) {
  const [error, setError] = useState('');
  const p = template.profile?.data;
  const activeJob = template.status === 'analysing' ? template.latestJob?.id ?? null : null;
  const reload = async () => onChange((await studioApi.get<{ template: StudioTemplate }>(`/templates/${template.id}`)).template);
  const { job } = useJob(activeJob, () => void reload().catch(() => undefined));
  const analyse = async () => {
    setError('');
    try { await studioApi.post(`/templates/${template.id}/analyse`, { idempotencyKey: newIdempotencyKey() }); await reload(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not start the analysis.'); }
  };
  return <div className="ts-page">
    <div className="ts-detail-head">
      {onBack && <button type="button" className="ws-btn ws-btn-quiet" onClick={onBack}><ArrowLeft size={15} aria-hidden="true" /> All templates</button>}
      <div className="ts-detail-title">
        <h2>{template.name} {statusBadge(template.status)}</h2>
        <p>{template.brandKit ? `Brand kit: ${template.brandKit.name}` : 'No brand kit'}{template.profile ? ` · Style profile v${template.profile.version} (${template.profile.model}${template.profile.cached ? ', reused from an identical analysis' : ''})` : ''} · {template.posterCount} poster{template.posterCount === 1 ? '' : 's'}</p>
      </div>
      {template.status === 'ready' && <button type="button" className="ws-btn ws-btn-primary ws-btn-large" onClick={() => onGenerate(template)}><Sparkles size={16} aria-hidden="true" /> Generate image <ArrowRight size={16} aria-hidden="true" /></button>}
    </div>
    {error && <Alert>{error}</Alert>}
    <div className="ts-ref-strip">{template.references.map(r => <a key={r.assetId} href={r.full} target="_blank" rel="noreferrer" className="ts-ref"><img src={r.thumb} alt={`Reference ${r.refId}`} /><span>{r.refId}</span></a>)}</div>
    {template.status === 'analysing' && <StepCard title="Analysing the reference posters" hint="One AI call studies the design: composition, staging, palette, lighting, typography and what may change.">{job ? <JobSteps job={job} /> : <p className="ts-muted" role="status">Starting…</p>}</StepCard>}
    {template.status === 'failed' && <StepCard title="Analysis failed"><Alert>{template.latestJob?.error?.message ?? 'The analysis did not finish.'}</Alert><button type="button" className="ws-btn" onClick={() => void analyse()}><RefreshCw size={15} aria-hidden="true" /> Try again (paid analysis)</button></StepCard>}
    {p && <>
      <StepCard title="What the AI learned about this design" hint={p.singleReferenceCaveat ?? undefined}>
        <p className="ts-summary">{p.summary}</p>
        <dl className="ts-facts">
          <div><dt>Medium</dt><dd>{p.visualMedium}</dd></div>
          <div><dt>Character</dt><dd>{p.campaignCharacter}</dd></div>
          <div><dt>Hierarchy</dt><dd>{p.visualHierarchy}</dd></div>
          <div><dt>Layout</dt><dd>{p.layout.density} density, {p.layout.negativeSpace} negative space, {p.layout.alignment} alignment. {p.layout.textPlacement}</dd></div>
          {p.composition && <div><dt>Product framing</dt><dd>{p.composition.staging} Hero: {p.composition.heroPlacement} Products fill about {pct(p.composition.subjectGroupWidth)} of the width with {pct(p.composition.headroom)} open space above; overlap {p.composition.overlap}{p.composition.visibleSupports ? '; on visible supports' : ''}.</dd></div>}
          {p.composition?.backdrop && <div><dt>Backdrop</dt><dd>{p.composition.backdrop.description} ({p.composition.backdrop.productRelation})</dd></div>}
          <div><dt>Background</dt><dd>{p.backgroundTreatment}</dd></div>
          {p.lighting && <div><dt>Lighting</dt><dd>{p.lighting}</dd></div>}
          {p.materials && <div><dt>Materials</dt><dd>{p.materials}</dd></div>}
          <div><dt>Typography</dt><dd>{p.typography.headlineCharacter}; body {p.typography.bodyCharacter}. Closest fonts: {p.typography.suggestedHeadlineFamily} / {p.typography.suggestedBodyFamily}</dd></div>
        </dl>
        <ul className="ts-palette" aria-label="Palette">{p.palette.colors.map(c => <li key={c.hex + c.role}><span style={{ background: c.hex }} aria-hidden="true" />{c.hex} · {c.role} <small>{c.prominence}</small></li>)}</ul>
      </StepCard>
      {p.referenceClusters.length > 1 && <ClusterChoice template={template} onChange={onChange} />}
      <div className="ts-two">
        <ListCard title="Always keep (Match Reference holds these)" items={p.sharedInvariants} tone="ok" />
        <ListCard title="Free to vary" items={p.allowedVariation} tone="accent" />
        <ListCard title="Avoid" items={p.excludedDirections} tone="warn" />
        <ListCard title="Old content that is never reused" items={p.contentToReplace.map(c => `${c.kind} (${c.referenceId}): ${c.description}`)} tone="neutral" />
      </div>
    </>}
    <BrandKitChoice template={template} onChange={onChange} />
    {template.status !== 'analysing' && <GuidanceCard template={template} onSaved={reload} />}
    <StepCard title="Template analysis cost" hint={`Versions: ${template.versions.map(v => `v${v.version} (${fmtDate(v.createdAt)})`).join(', ') || 'none yet'}`}><RecordedCost cost={template.analysisCost} empty="No paid analysis recorded (an identical earlier analysis was reused, or none has run yet)." /></StepCard>
  </div>;
}

function ListCard({ title, items, tone }: { title: string; items: string[]; tone: 'ok' | 'accent' | 'warn' | 'neutral' }) {
  return <section className={`ts-list-card is-${tone}`}><h4>{title}</h4>{items.length ? <ul>{items.map((i, n) => <li key={n}>{i}</li>)}</ul> : <p className="ts-muted">None.</p>}</section>;
}

function ClusterChoice({ template, onChange }: { template: StudioTemplate; onChange: (t: StudioTemplate) => void }) {
  const [saving, setSaving] = useState(false);
  return <StepCard title="These examples have different styles: pick the direction to use">
    <div className="ts-options" role="radiogroup" aria-label="Style direction">{template.profile!.data.referenceClusters.map(c => <label key={c.id} className={`ts-option${template.profile!.selectedClusterId === c.id ? ' is-on' : ''}`}>
      <input type="radio" name="cluster" checked={template.profile!.selectedClusterId === c.id} disabled={saving} onChange={async () => {
        setSaving(true);
        try { onChange((await studioApi.patch<{ template: StudioTemplate }>(`/templates/${template.id}`, { selectedClusterId: c.id })).template); } finally { setSaving(false); }
      }} /><span><strong>{c.label}</strong> <Badge>{c.referenceIds.join(', ')}</Badge><small>{c.description}</small></span></label>)}</div>
  </StepCard>;
}

function GuidanceCard({ template, onSaved }: { template: StudioTemplate; onSaved: () => Promise<void> }) {
  const [guidance, setGuidance] = useState(template.guidance ?? ''), [saving, setSaving] = useState(false), [error, setError] = useState('');
  const changed = guidance.trim() !== (template.guidance ?? '');
  return <StepCard title="Style notes" hint="Saving re-analyses the references as a new version (one paid analysis; unchanged inputs reuse the earlier result for free).">
    <Field label="Notes for the analyst" htmlFor={`ts-guidance-${template.id}`}><textarea id={`ts-guidance-${template.id}`} rows={3} value={guidance} onChange={e => setGuidance(e.target.value)} placeholder="e.g. Always keep the blue backdrop and the white podiums." /></Field>
    <div className="ws-row"><button type="button" className="ws-btn" disabled={!changed || saving} onClick={async () => {
      setSaving(true); setError('');
      try { await studioApi.patch(`/templates/${template.id}`, { guidance: guidance.trim() || null }); await studioApi.post(`/templates/${template.id}/analyse`, { idempotencyKey: newIdempotencyKey() }); await onSaved(); }
      catch (e) { setError(e instanceof Error ? e.message : 'Could not save.'); } finally { setSaving(false); }
    }}>{saving ? 'Starting…' : 'Save & re-analyse'}</button>{error && <Alert>{error}</Alert>}</div>
  </StepCard>;
}

/** The brand kit images from this template use (logo, palette, fonts); changing it needs no new analysis. */
function BrandKitChoice({ template, onChange }: { template: StudioTemplate; onChange: (t: StudioTemplate) => void }) {
  const [kits, setKits] = useState<StudioBrandKit[] | null>(null), [saving, setSaving] = useState(false), [error, setError] = useState('');
  useEffect(() => { let alive = true; void studioApi.get<{ kits: StudioBrandKit[] }>('/brand-kits').then(r => { if (alive) setKits(r.kits); }).catch(() => { if (alive) setKits([]); }); return () => { alive = false; }; }, []);
  return <StepCard title="Brand kit" hint="Logo rules, approved logos, palette and fonts for images made from this template. Changing it costs nothing.">
    <Field label="Brand kit for this template" htmlFor={`ts-kit-${template.id}`}>
      <select id={`ts-kit-${template.id}`} value={template.brandKit?.id ?? ''} disabled={saving || kits === null} onChange={async e => {
        setSaving(true); setError('');
        try { onChange((await studioApi.patch<{ template: StudioTemplate }>(`/templates/${template.id}`, { brandKitId: e.target.value || null })).template); }
        catch (err) { setError(err instanceof Error ? err.message : 'Could not change the brand kit.'); } finally { setSaving(false); }
      }}><option value="">No brand kit</option>{kits?.map(k => <option key={k.id} value={k.id}>{k.name}</option>)}</select>
    </Field>
    {error && <Alert>{error}</Alert>}
  </StepCard>;
}
