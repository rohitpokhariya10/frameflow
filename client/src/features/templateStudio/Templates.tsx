/** Template gallery and the Create Template wizard: upload → details → analyse → review the learned style → save. */
import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, FileImage, LayoutTemplate, Plus, Sparkles } from 'lucide-react';
import type { StudioAsset, StudioBrandKit, StudioMoney, StudioTemplate } from '@frameflow/shared';
import { newIdempotencyKey, studioApi } from './api';
import { ImagePicker } from './ImagePicker';
import { TemplateDetail, statusBadge } from './TemplateDetail';
import { Alert, Badge, Empty, Field, JobSteps, Money, PageHeading, StepCard, useJob } from './ui';

export function TemplatesGallery({ onCreate, onOpen, onGenerate }: { onCreate: () => void; onOpen: (id: string) => void; onGenerate: (id: string) => void }) {
  const [templates, setTemplates] = useState<StudioTemplate[] | null>(null), [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    const load = () => studioApi.get<{ templates: StudioTemplate[] }>('/templates').then(r => { if (alive) setTemplates(r.templates); }).catch((e: Error) => { if (alive) setError(e.message); });
    void load();
    const poll = setInterval(() => void load(), 5000);
    return () => { alive = false; clearInterval(poll); };
  }, []);
  return <div className="ts-page">
    <PageHeading kicker="STEP 1 · TEMPLATE STUDIO" title="Templates" actions={<button type="button" className="ws-btn ws-btn-primary" onClick={onCreate}><Plus size={16} aria-hidden="true" /> Create template</button>}>
      Reusable designs learned from your reference posters. Each keeps its backdrop, staging, palette, lighting and layout for new products.
    </PageHeading>
    {error && <Alert>{error}</Alert>}
    {templates === null ? <p className="ts-muted" role="status">Loading templates…</p>
      : templates.length === 0 ? <Empty icon={<LayoutTemplate size={30} aria-hidden="true" />} title="No templates yet" action={<button type="button" className="ws-btn ws-btn-primary" onClick={onCreate}><Plus size={16} aria-hidden="true" /> Create your first template</button>}>Upload one to three posters whose look you want to reuse. The AI learns the design, not the old products or offers.</Empty>
        : <ul className="ts-template-grid">{templates.map(t => {
          const p = t.profile?.data;
          return <li key={t.id} className="ts-template-card">
            <button type="button" className="ts-template-art" onClick={() => onOpen(t.id)} aria-label={`Open ${t.name}`}>
              {t.references.map(r => <img key={r.assetId} src={r.thumb} alt="" loading="lazy" />)}
            </button>
            <div className="ts-template-info">
              <div className="ts-template-name"><h3>{t.name}</h3>{statusBadge(t.status)}</div>
              <p>{p?.summary ?? (t.status === 'analysing' ? 'Learning the design…' : t.latestJob?.error?.message ?? 'Not analysed yet.')}</p>
              {p && <ul className="ts-swatches" aria-label="Palette">{p.palette.colors.slice(0, 6).map(c => <li key={c.hex + c.role} style={{ background: c.hex }} title={`${c.hex} · ${c.role}`} />)}</ul>}
              <div className="ts-template-meta"><span>{t.references.length} reference{t.references.length === 1 ? '' : 's'}</span>{t.profile && <span>v{t.profile.version}</span>}<span>{t.posterCount} poster{t.posterCount === 1 ? '' : 's'}</span>{t.brandKit && <span>{t.brandKit.name}</span>}</div>
              <div className="ws-row">
                <button type="button" className="ws-btn" onClick={() => onOpen(t.id)}>View style</button>
                <button type="button" className="ws-btn ws-btn-primary" disabled={t.status !== 'ready'} onClick={() => onGenerate(t.id)}><Sparkles size={15} aria-hidden="true" /> Generate image</button>
              </div>
            </div>
          </li>;
        })}</ul>}
  </div>;
}

/** One template's page inside the Templates section (loads and keeps it fresh). */
export function TemplatePage({ id, onBack, onGenerate }: { id: string; onBack: () => void; onGenerate: (id: string) => void }) {
  const [template, setTemplate] = useState<StudioTemplate | null>(null), [error, setError] = useState('');
  useEffect(() => { let alive = true; void studioApi.get<{ template: StudioTemplate }>(`/templates/${id}`).then(r => { if (alive) setTemplate(r.template); }).catch((e: Error) => { if (alive) setError(e.message); }); return () => { alive = false; }; }, [id]);
  if (error) return <div className="ts-page"><Alert>{error}</Alert></div>;
  if (!template) return <div className="ts-page"><p className="ts-muted" role="status">Loading template…</p></div>;
  return <TemplateDetail template={template} onChange={setTemplate} onBack={onBack} onGenerate={t => onGenerate(t.id)} />;
}

type Estimate = { total: StudioMoney; cap: StudioMoney; withinCap: boolean; calls: { stage: string; model: string; cost: StudioMoney }[] };
const WIZARD = ['Upload references', 'Details', 'Analyse', 'Review style'] as const;

export function TemplateCreate({ onGenerate, onOpenTemplates }: { onGenerate: (id: string) => void; onOpenTemplates: () => void }) {
  const [refs, setRefs] = useState<StudioAsset[]>([]), [name, setName] = useState(''), [guidance, setGuidance] = useState('');
  const [kits, setKits] = useState<StudioBrandKit[]>([]), [brandKitId, setBrandKitId] = useState('');
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [created, setCreated] = useState<{ templateId: string; jobId: string } | null>(null), [template, setTemplate] = useState<StudioTemplate | null>(null);
  const [submitting, setSubmitting] = useState(false), [error, setError] = useState(''), [touched, setTouched] = useState(false);
  const key = useRef<string | null>(null);
  useEffect(() => { void studioApi.get<{ kits: StudioBrandKit[] }>('/brand-kits').then(r => { setKits(r.kits); if (r.kits.length === 1) setBrandKitId(r.kits[0].id); }).catch(() => undefined); }, []);
  useEffect(() => { void studioApi.get<Estimate>(`/costs/template-estimate?references=${Math.max(1, refs.length)}`).then(setEstimate).catch(() => setEstimate(null)); }, [refs.length]);
  const { job } = useJob(created?.jobId, () => { if (created) void studioApi.get<{ template: StudioTemplate }>(`/templates/${created.templateId}`).then(r => setTemplate(r.template)); });
  const step = template ? 3 : created ? 2 : refs.length ? 1 : 0;
  const nameMissing = touched && !name.trim();
  const submit = async () => {
    setTouched(true);
    if (!name.trim() || !refs.length) return;
    setSubmitting(true); setError('');
    key.current ??= newIdempotencyKey();
    try { setCreated(await studioApi.post<{ templateId: string; jobId: string }>('/templates', { idempotencyKey: key.current, name: name.trim(), guidance: guidance.trim() || null, brandKitId: brandKitId || null, referenceAssetIds: refs.map(r => r.id) })); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not create the template.'); key.current = null; }
    finally { setSubmitting(false); }
  };
  const restart = () => { setRefs([]); setName(''); setGuidance(''); setCreated(null); setTemplate(null); setTouched(false); key.current = null; };

  return <div className="ts-page">
    <PageHeading kicker="STEP 1 · TEMPLATE STUDIO" title="Create a template">Teach FrameFlow a design from one to three example posters. Their products, offers, dates and logos are ignored; only the design is learned.</PageHeading>
    <ol className="ts-wizard" aria-label="Create template steps">{WIZARD.map((label, i) => <li key={label} className={i < step ? 'is-done' : i === step ? 'is-current' : undefined} aria-current={i === step ? 'step' : undefined}><span>{i < step ? <Check size={13} aria-hidden="true" /> : i + 1}</span>{label}</li>)}</ol>
    {error && <Alert>{error}</Alert>}
    {template?.status === 'ready' ? <>
      <Alert tone="ok"><strong>Template saved.</strong> “{template.name}” is ready. Review what the AI learned below, then generate an image with it.</Alert>
      <TemplateDetail template={template} onChange={setTemplate} onGenerate={t => onGenerate(t.id)} />
      <div className="ws-row"><button type="button" className="ws-btn" onClick={restart}><Plus size={15} aria-hidden="true" /> Create another template</button><button type="button" className="ws-btn ws-btn-quiet" onClick={onOpenTemplates}>Go to all templates</button></div>
    </> : created ? <StepCard step={3} title="Analysing the reference posters" hint="Usually under a minute. You can leave this page: the template appears in Templates when it is ready.">
      {job ? <JobSteps job={job} /> : <p className="ts-muted" role="status">Starting…</p>}
      {job?.terminal && job.state !== 'complete' && <><Alert>{job.error?.message ?? 'The analysis did not finish.'}</Alert><button type="button" className="ws-btn" onClick={() => { setCreated(null); key.current = null; }}>Back to the form</button></>}
      {template?.status === 'failed' && <Alert>{template.latestJob?.error?.message}</Alert>}
    </StepCard> : <>
      <StepCard step={1} title="Reference posters (1–3)" hint={<>Choose posters whose <strong>look</strong> you want to reuse. Two or three in the same style give the most reliable template.</>}>
        <ImagePicker roles={['reference']} uploadRole="reference" max={3} selected={refs} onChange={setRefs} label="reference posters" emptyText="No reference posters yet. Upload one above." />
      </StepCard>
      <StepCard step={2} title="Details">
        <div className="ts-form-grid">
          <Field label="Template name" htmlFor="ts-template-name" hint={nameMissing ? <span className="ts-error-text">Give the template a name.</span> : undefined}><input id="ts-template-name" aria-invalid={nameMissing} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Blue studio podiums" /></Field>
          <Field label="Brand kit (optional)" htmlFor="ts-template-kit" hint="Logo rules, colours and fonts applied to images from this template."><select id="ts-template-kit" value={brandKitId} onChange={e => setBrandKitId(e.target.value)}><option value="">No brand kit</option>{kits.map(k => <option key={k.id} value={k.id}>{k.name}</option>)}</select></Field>
          <Field label="Instructions for the analyst (optional)" htmlFor="ts-template-notes" hint="Anything the examples don't show, e.g. 'always keep the blue backdrop' or 'never use people'."><textarea id="ts-template-notes" rows={3} value={guidance} onChange={e => setGuidance(e.target.value)} /></Field>
        </div>
      </StepCard>
      <div className="ts-submit-bar">
        <div>{estimate ? <><strong>AI style analysis: up to <Money value={estimate.total} /></strong><small>{estimate.calls.map(c => `${c.stage}: ${c.cost.inr}`).join(' · ')}. Upper bound; the recorded cost appears on the template.</small></> : <small>Estimating…</small>}</div>
        <button type="button" className="ws-btn ws-btn-primary ws-btn-large" disabled={submitting || !refs.length} onClick={() => void submit()}>{submitting ? 'Creating…' : <><FileImage size={16} aria-hidden="true" /> Create template & analyse <ArrowRight size={16} aria-hidden="true" /></>}</button>
      </div>
      {!refs.length && touched && <Alert tone="warn">Add at least one reference poster.</Alert>}
    </>}
    {template && template.status !== 'ready' && template.status !== 'analysing' && <Badge tone="danger">{template.status}</Badge>}
  </div>;
}
