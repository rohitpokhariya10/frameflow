import { useEffect, useReducer, useRef, useState } from 'react';
import { TEMPLATE_A_ASPECT_RATIOS } from '@frameflow/shared';
import { groupingOf, type ExperimentRun, type TemplateEntry } from './layerizeExperiment';
import { creationRequest, generationApi, generatorReducer, initialForm, isUnderway, resolvedCreative, variantImageUrl, type GenerationGroup, type GenerationVariant, type GeneratorInfo } from './templateAGeneration';

const box: React.CSSProperties = { padding: 16, borderTop: '1px solid var(--color-line)', display: 'grid', gap: 10 };
const pre: React.CSSProperties = { whiteSpace: 'pre-wrap', background: '#fff', padding: 10, borderRadius: 8, margin: 0, fontSize: 12 };
const muted: React.CSSProperties = { color: 'var(--color-muted)' };
const card: React.CSSProperties = { display: 'grid', gap: 8, alignContent: 'start', padding: 12, border: '1px solid var(--color-line)', borderRadius: 10, background: 'var(--color-panel)', minWidth: 0 };
const STATUS: Record<GenerationVariant['status'], { label: string; color: string }> = {
  pending: { label: 'Not generated', color: '#7a8087' }, queued: { label: 'Queued', color: '#2f6fb3' }, generating: { label: 'Generating…', color: '#2f6fb3' },
  done: { label: 'Ready', color: '#285443' }, failed: { label: 'Failed', color: '#b42318' },
};
const badge = (color: string): React.CSSProperties => ({ display: 'inline-block', padding: '2px 8px', borderRadius: 6, background: color, color: '#fff', fontWeight: 600, fontSize: 12 });
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
/** The list with this group in it: replaced where it already is, else added first (newest first). */
const withGroup = (list: GenerationGroup[], group: GenerationGroup) => list.some(item => item.id === group.id) ? list.map(item => item.id === group.id ? group : item) : [group, ...list];
const summary = (group: GenerationGroup) => `${group.fields.subject}${group.fields.heldObject ? ` + ${group.fields.heldObject}` : ''}`;

/**
 * Template A test generator (admin harness). One creative, three aspect ratios: the user defines the creative once
 * (Template A's fields, or the shared prompt edited from them), and it is generated as a group of aspect-ratio variants
 * (1:1, 16:9, 4:5) that all use that one definition and differ only in a fixed framing sentence. Each variant has its
 * own status, image or error, and its own "Decompose image", which hands exactly that image to the ordinary Template A
 * decomposition; the run shows in the panel's run view below.
 */
export function TemplateAGenerator({ templateA, runActive, fitCheck, onGenerated, onRunStarted, onOpenRun }: {
  templateA?: TemplateEntry; runActive: boolean; fitCheck: boolean; onGenerated: () => void; onRunStarted: (run: ExperimentRun) => void; onOpenRun: (runId: string) => void;
}) {
  const [info, setInfo] = useState<GeneratorInfo>();
  const [form, dispatch] = useReducer(generatorReducer, undefined, () => initialForm());
  const [groups, setGroups] = useState<GenerationGroup[]>([]);
  const [currentId, setCurrentId] = useState<string>();
  // Held object separate or combined, chosen per variant; a variant without a choice follows the creative (separate when it has an object).
  const [separate, setSeparate] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const mounted = useRef(true);
  const current = groups.find(group => group.id === currentId);
  const keep = (group: GenerationGroup) => setGroups(list => withGroup(list, group));
  useEffect(() => {
    mounted.current = true;
    void generationApi.info().then(value => mounted.current && setInfo(value)).catch((error: Error) => mounted.current && setMessage(error.message));
    void generationApi.list().then((value) => { if (!mounted.current) return; setGroups(value.groups); setCurrentId(value.groups[0]?.id); }).catch(() => undefined);
    return () => { mounted.current = false; };
  }, []);
  // While a variant of the shown creative is queued or generating, its group is read again every two seconds. Reading costs nothing.
  const underway = !!current && current.variants.some(isUnderway);
  useEffect(() => {
    if (!currentId || !underway) return;
    const timer = window.setInterval(() => { void generationApi.get(currentId).then(group => mounted.current && setGroups(list => withGroup(list, group))).catch(() => undefined); }, 2000);
    return () => window.clearInterval(timer);
  }, [currentId, underway]);

  const resolved = resolvedCreative(form);
  const ratios = info?.aspectRatios ?? TEMPLATE_A_ASPECT_RATIOS;
  const act = async (name: string, work: () => Promise<void>) => {
    setBusy(name); setMessage('');
    try { await work(); } catch (error) { if (mounted.current) setMessage(error instanceof Error ? error.message : 'That did not work.'); }
    finally { if (mounted.current) setBusy(''); }
  };
  // Every Generate is a new group: an earlier creative is never changed by it.
  const generate = () => window.confirm(`Generate ${plural(form.ratios.length, 'aspect-ratio variant')} of this creative (${form.ratios.join(', ')})? This makes ${plural(form.ratios.length, 'paid OpenAI image request')}.`)
    && act('generate', async () => {
      const group = await generationApi.create(creationRequest(form));
      if (!mounted.current) return;
      // A new creative starts clean: no earlier decomposition is shown as if it were its own.
      keep(group); setCurrentId(group.id); onGenerated();
    });
  const generateVariant = (group: GenerationGroup, variant: GenerationVariant) => window.confirm(`Generate the ${variant.aspectRatio} variant of this creative${variant.attempts ? ' again' : ''}? This makes 1 paid OpenAI image request. The other variants are not touched.`)
    && act(`generate-${variant.id}`, async () => { const updated = await generationApi.generateVariant(group.id, variant.id); if (mounted.current) keep(updated); });
  const decompose = (group: GenerationGroup, variant: GenerationVariant) => act(`decompose-${variant.id}`, async () => {
    onRunStarted(await generationApi.decompose(group.id, variant.id, { separateHeldObject: group.structure.heldObject && (separate[`${group.id}/${variant.id}`] ?? true) }));
    const updated = await generationApi.get(group.id);
    if (mounted.current) keep(updated);
  });

  return <>
    <section style={box}>
      <strong>Template A test generator: one creative, three aspect ratios</strong>
      <span style={muted}>Template A: one clearly dominant subject (a person or an animal) inside a clearly distinguishable inner region with its own backdrop, visually separate from the outer background, optionally holding one object; a clean poster composition with no other subjects, props or text. Define the creative once; it is generated as {ratios.join(', ')} variants of that same creative. * = required.</span>
      {info && <details><summary>Fixed Template A structure ({info.version}, read-only)</summary><pre style={pre}>{info.skeleton}</pre></details>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 8 }}>
        {(info?.fields ?? []).map(field => <label key={field.key} style={{ display: 'grid', gap: 2 }}>
          <span>{field.label}{field.required ? ' *' : ''} {field.help && <span style={muted}>({field.help})</span>}</span>
          <input value={form.values[field.key]} maxLength={field.maxLength} onChange={event => dispatch({ type: 'field', key: field.key, value: event.target.value })} style={{ width: '100%' }} />
        </label>)}
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <strong>Shared creative prompt</strong>
        <span style={muted}>{form.editedPrompt === null ? '(built from the fields; the same for every aspect ratio)' : '(edited by hand; used as it is for every aspect ratio)'}</span>
        {form.editedPrompt === null
          ? <button className="ws-btn" disabled={!resolved.builtPrompt} onClick={() => dispatch({ type: 'editPrompt', value: resolved.builtPrompt ?? '' })}>Edit shared prompt</button>
          : <button className="ws-btn" onClick={() => dispatch({ type: 'editPrompt', value: null })}>Discard edit (rebuild from the fields)</button>}
      </div>
      {form.editedPrompt === null
        ? resolved.builtPrompt && <pre style={pre} data-testid="shared-prompt">{resolved.builtPrompt}</pre>
        : <>
          <textarea aria-label="Shared creative prompt" rows={7} value={form.editedPrompt} maxLength={info?.promptLimits.base} onChange={event => dispatch({ type: 'editPrompt', value: event.target.value })} style={{ width: '100%', fontSize: 12, padding: 8 }} />
          <span style={muted}>While it is edited, changing the fields above no longer changes the prompt. The decomposition's defaults (held object, border) still follow the fields, so keep them in line with what you write here.</span>
        </>}
      {resolved.errors.map(error => <div key={error} role="alert" style={{ color: 'var(--color-error)' }}>{error}</div>)}
      <details>
        <summary>What each aspect ratio adds to the shared prompt (fixed text; the only difference between the variants)</summary>
        <div style={{ display: 'grid', gap: 6, marginTop: 6 }}>
          <div><strong>Every ratio:</strong> {info?.consistency}</div>
          {ratios.map(ratio => <div key={ratio}><strong>{ratio}:</strong> {info?.framing[ratio]}
            {resolved.prompts && <details><summary>Exact {ratio} prompt ({resolved.prompts[ratio].length} characters)</summary><pre style={pre}>{resolved.prompts[ratio]}</pre></details>}</div>)}
        </div>
      </details>
      <span style={muted}>What stays the same: the subject, styling, held object, inner region, border and backgrounds. Each ratio is generated on its own from this one description, so what the description does not pin down (the exact face, the exact folds of a fabric) can still differ between the three.</span>

      <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
        <strong>Generate now:</strong>
        {ratios.map(ratio => <label key={ratio}><input type="checkbox" checked={form.ratios.includes(ratio)} onChange={event => dispatch({ type: 'ratio', ratio, on: event.target.checked })} /> {ratio}
          {info?.imageSizes[ratio] && <span style={muted}> ({info.imageSizes[ratio].width}×{info.imageSizes[ratio].height})</span>}</label>)}
        <span style={muted}>An unticked ratio stays in the creative as "not generated" and can be generated later.</span>
      </div>
      <div><button className="ws-btn ws-btn-primary" disabled={!!busy || !resolved.prompts || !info || !form.ratios.length} onClick={() => void generate()}>
        {busy === 'generate' ? 'Starting…' : `Generate ${plural(form.ratios.length, 'aspect-ratio variant')} (OpenAI ${info?.generator.model ?? ''}, ${plural(form.ratios.length, 'paid call')})`}</button></div>
      {message && <div role="alert" style={{ color: 'var(--color-error)' }}>{message}</div>}
    </section>

    <section style={box}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <strong>Generated creatives</strong>
        {groups.length > 0 && <select aria-label="Generated creative" value={current?.id ?? ''} onChange={event => setCurrentId(event.target.value)}>
          {groups.map(group => <option key={group.id} value={group.id}>{group.id} — {summary(group)} — {group.legacy ? `single image (${group.variants[0].aspectRatio})` : group.variants.map(variant => `${variant.aspectRatio} ${STATUS[variant.status].label.toLowerCase()}`).join(', ')}</option>)}</select>}
      </div>
      {!current ? <span style={muted}>No creative generated yet.</span> : <>
        <div style={{ display: 'grid', gap: 6 }}>
          <div><strong>Creative {current.id}</strong> · {summary(current)} · created {new Date(current.createdAt).toLocaleString()} {current.promptEdited && <span style={badge('#7a3fb0')}>prompt edited</span>}</div>
          {current.legacy
            ? <span style={muted}>An earlier single-image generation ({current.variants[0].aspectRatio}), made before creatives had aspect-ratio variants. It can still be decomposed; to get the three ratios, load its fields into the form and generate a new creative.</span>
            : <span style={muted}>One creative, {plural(current.variants.length, 'aspect-ratio variant')}. All of them use the shared prompt below; each can be decomposed on its own.</span>}
          <details><summary>Shared creative prompt ({current.basePrompt.length} characters{current.promptEdited ? ', edited by hand' : ', built from the fields'})</summary><pre style={pre}>{current.basePrompt}</pre>
            {current.promptEdited && <details><summary>The prompt the fields build (not used)</summary><pre style={pre}>{current.builtPrompt}</pre></details>}</details>
          <details><summary>Field values</summary><pre style={pre}>{JSON.stringify(current.fields, null, 2)}</pre></details>
          <div><button className="ws-btn" disabled={!!busy} onClick={() => dispatch({ type: 'load', group: current })}>Load this creative into the form</button></div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 }}>
          {current.variants.map(variant => <VariantCard key={variant.id} group={current} variant={variant} busy={busy} runActive={runActive} fitCheck={fitCheck} groupingLabel={groupingOf(templateA).label}
            separate={separate[`${current.id}/${variant.id}`] ?? true} onSeparate={value => setSeparate(choices => ({ ...choices, [`${current.id}/${variant.id}`]: value }))}
            onGenerate={() => void generateVariant(current, variant)} onDecompose={() => void decompose(current, variant)} onOpenRun={onOpenRun} />)}
        </div>
      </>}
    </section>
  </>;
}

/** One aspect ratio of a creative: its status, picture or error, the exact prompt sent, and its own generate and decompose actions. */
function VariantCard({ group, variant, busy, runActive, fitCheck, groupingLabel, separate, onSeparate, onGenerate, onDecompose, onOpenRun }: {
  group: GenerationGroup; variant: GenerationVariant; busy: string; runActive: boolean; fitCheck: boolean; groupingLabel: string; separate: boolean; onSeparate: (value: boolean) => void;
  onGenerate: () => void; onDecompose: () => void; onOpenRun: (runId: string) => void;
}) {
  const status = STATUS[variant.status], hasObject = group.structure.heldObject, ready = variant.status === 'done' && !!variant.image;
  const canGenerate = !group.legacy && (variant.status === 'pending' || variant.status === 'failed');
  return <article style={card} aria-label={`${variant.aspectRatio} variant`} data-variant={variant.id}>
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <strong style={{ fontSize: 15 }}>{variant.aspectRatio}</strong><span style={muted}>{variant.size.width}×{variant.size.height}</span>
      <span style={badge(status.color)} data-testid={`status-${variant.id}`}>{status.label}</span>
    </div>
    {ready
      ? <a href={variantImageUrl(group.id, variant.id)} target="_blank" rel="noreferrer"><img src={variantImageUrl(group.id, variant.id)} alt={`${variant.aspectRatio} variant of this creative`} style={{ width: '100%', maxHeight: 320, objectFit: 'contain', background: '#eee' }} /></a>
      : <div style={{ padding: 20, background: '#f4f4f4', aspectRatio: `${variant.size.width || 1} / ${variant.size.height || 1}`, maxHeight: 320, display: 'grid', placeItems: 'center', textAlign: 'center' }}>
        {variant.status === 'failed' ? 'No image' : variant.status === 'pending' ? 'Not generated yet' : status.label}</div>}
    {variant.error && <div role="alert" style={{ color: 'var(--color-error)' }}>{variant.error.code}{variant.error.status ? ` (${variant.generator.provider} HTTP ${variant.error.status})` : ''}: {variant.error.message}</div>}
    <div style={muted}>{variant.generator.provider} {variant.generator.model}{variant.attempts > 1 ? ` · ${variant.attempts} attempts` : ''}{variant.durationMs !== undefined ? ` · ${(variant.durationMs / 1000).toFixed(1)} s` : ''}
      {variant.generator.requestId && <> · request <code>{variant.generator.requestId}</code></>}</div>
    <details><summary>{variant.attempts ? 'Prompt sent' : 'Prompt to be sent'} ({variant.prompt.length} characters)</summary><pre style={pre}>{variant.prompt}</pre>
      {variant.framing && <div style={muted}>Only this differs from the other ratios: “{variant.framing}”</div>}</details>
    {canGenerate && <button className="ws-btn" disabled={!!busy} onClick={onGenerate}>
      {busy === `generate-${variant.id}` ? 'Starting…' : variant.status === 'failed' ? `Generate ${variant.aspectRatio} again (1 paid call)` : `Generate ${variant.aspectRatio} (1 paid call)`}</button>}
    <div style={{ display: 'grid', gap: 6, borderTop: '1px solid var(--color-line)', paddingTop: 8 }}>
      <label style={{ opacity: ready && hasObject ? 1 : 0.5 }}><input type="checkbox" checked={hasObject && separate} disabled={!ready || !hasObject} onChange={event => onSeparate(event.target.checked)} /> {groupingLabel}</label>
      {ready && !hasObject && <span style={muted}>No held object in this creative, so it is decomposed combined.</span>}
      <button className="ws-btn ws-btn-primary" disabled={!ready || !!busy || runActive} onClick={onDecompose}>
        {busy === `decompose-${variant.id}` ? 'Starting…' : `Decompose ${variant.aspectRatio} image (Template A: ${fitCheck ? 'fit check + ' : ''}OpenAI planner + 1 paid Seedream call)`}</button>
      {!ready && <span style={muted}>This ratio has no image to decompose.</span>}
      {ready && runActive && <span style={muted}>A run is active; wait for it to finish.</span>}
      {variant.decompositions.length > 0 && <div>Decompositions of this image: {variant.decompositions.map(item =>
        <button key={item.runId} className="ws-btn" style={{ margin: '0 6px 6px 0' }} onClick={() => onOpenRun(item.runId)}>{item.runId} ({item.separateHeldObject ? 'held object separate' : 'combined'}{item.targetLayers ? `, target ${item.targetLayers}` : ''})</button>)}</div>}
    </div>
  </article>;
}
