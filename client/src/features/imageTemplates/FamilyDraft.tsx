import { useEffect, useState } from 'react';
import { IMAGE_TEMPLATE_RATIOS, type ImageTemplateRatio } from '@frameflow/shared';
import { imageTemplateApi, referenceUrl, type ImageTemplate, type TemplateChange } from './imageTemplates';

/** Fields come from the server's slotFormModel, including current-image evidence only. */
export function FamilyDraft({ template, busy, onCreate, onDetect, onChange, onGenerate, onOriginal, onUse }: {
  template?: ImageTemplate; busy: string;
  onCreate: (file: File, name: string) => void; onDetect: () => void;
  onChange: (change: TemplateChange) => void; onGenerate: () => void; onOriginal: () => void; onUse: (id: string) => void;
}) {
  const [file, setFile] = useState<File>();
  const [name, setName] = useState(template?.name ?? '');
  const [values, setValues] = useState<Record<string, string>>(template?.family?.slotValues ?? {});
  const [ratios, setRatios] = useState<ImageTemplateRatio[]>(template?.aspectRatios ?? ['1:1']);
  const [library, setLibrary] = useState<Awaited<ReturnType<typeof imageTemplateApi.families>>>();
  const [libraryError, setLibraryError] = useState('');
  useEffect(() => {
    let live = true;
    void imageTemplateApi.families().then(result => { if (live) setLibrary(result); }).catch((e: Error) => { if (live) setLibraryError(e.message); });
    return () => { live = false; };
  }, []);
  const detection = template?.family?.detection, view = template?.family?.view;
  const detecting = detection?.status === 'detecting', disabled = !!busy || detecting;
  return <div className="cti-inner">
    <section className="cti-step"><h2>{template ? 'Your reusable layout' : 'Create with a reusable layout'}</h2>
      <p className="ws-hint">Upload a creative. We match its structure to saved layouts, then compile prompts from the fields you change.</p>
      {!template ? <>
        <label className="cti-label" htmlFor="family-name">Creative name</label><input id="family-name" className="cti-input" value={name} maxLength={120} onChange={e => setName(e.target.value)} />
        <label className="cti-label" htmlFor="family-image">Reference creative</label><input id="family-image" type="file" accept="image/png,image/jpeg,image/webp" onChange={e => setFile(e.target.files?.[0])} />
        <p><button className="ws-btn ws-btn-primary" disabled={disabled || !file} onClick={() => file && onCreate(file, name)}>Upload reference · no API call</button></p>
      </> : <>
        <img src={referenceUrl(template)} alt="Reference creative" style={{ width: '100%', maxWidth: 260, maxHeight: 220, objectFit: 'contain' }} />
        {!view && <><p className="ws-hint">A confident saved match needs no analysis call. Otherwise, one cheap analysis may escalate once to the strong model.</p>
          <button className="ws-btn ws-btn-primary" disabled={disabled} onClick={onDetect}>{detecting ? 'Detecting layout…' : 'Detect layout'}</button></>}
        {detection?.error && <p role="alert">{detection.error.message}</p>}
        {view && <><h3>{view.name} <small>v{view.version}</small></h3><p>{detection?.outcome === 'created' ? 'New layout saved' : 'Saved layout matched'} · {Math.round((detection?.confidence ?? 0) * 100)}% confidence</p>
          <p className="ws-hint">{view.status === 'active' ? 'Validated family: decomposition can reuse its plan.' : 'New family: its first decomposition uses a full planner to validate the saved structure.'}</p></>}
      </>}
    </section>
    {view && <>
      <section className="cti-step" aria-label="Layout fields"><h3>Change your creative</h3>
        <p className="ws-hint">Leave a field empty to keep it from this reference. Every change compiles the saved prompt template locally — ₹0 planning cost.</p>
        <label className="cti-label" htmlFor="family-edit-name">Creative name</label><input id="family-edit-name" className="cti-input" value={name} maxLength={120} onChange={e => setName(e.target.value)} onBlur={() => onChange({ name })} />
        {view.fields.map(field => <div key={field.id} style={{ marginTop: 16 }}>
          <label className="cti-label" htmlFor={`family-${field.id}`}>{field.label}</label>
          <input id={`family-${field.id}`} className="cti-input" value={values[field.id] ?? ''} maxLength={field.maxLength} placeholder={field.current ? `Keep: ${field.current}` : field.placeholder} disabled={disabled}
            onChange={e => setValues(v => ({ ...v, [field.id]: e.target.value }))} onBlur={() => onChange({ familySlots: values })} />
          <p className="ws-hint">{field.help}</p>
        </div>)}
        <details className="cti-advanced"><summary>Locally compiled generation prompt</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{template?.prompt}</pre></details>
      </section>
      <section className="cti-step"><h3>Choose the next step</h3>
        <p className="ws-hint">For text or logo changes, prefer native editor layers when available. Imported decomposition layers are images: replacing raster text requires manual work in the editor.</p>
        <button className="ws-btn" disabled={disabled} onClick={onOriginal}>Use original unchanged · no image call</button>
        <p className="ws-hint">This keeps the original pixels; field changes above are applied only when generating a new image.</p>
        <div className="cti-ratios">{IMAGE_TEMPLATE_RATIOS.map(ratio => <label className="cti-ratio" key={ratio}><input type="checkbox" checked={ratios.includes(ratio)} onChange={e => {
          const next = IMAGE_TEMPLATE_RATIOS.filter(r => r === ratio ? e.target.checked : ratios.includes(r)); setRatios(next); onChange({ aspectRatios: next });
        }} />{ratio}</label>)}</div>
        <button className="ws-btn ws-btn-primary" disabled={disabled || !name.trim() || !ratios.length} onClick={onGenerate}>Generate changed creative</button>
        <p className="ws-hint">One paid image request per size. No generation-prompt planner call.</p>
      </section>
    </>}
    {!template && <section className="cti-step" aria-label="Reusable layout library"><h3>Saved layout families</h3>
      {libraryError && <p role="alert">{libraryError}</p>}
      {!library && !libraryError && <p>Loading layouts…</p>}
      {library?.families.map(f => <div key={f.id} style={{ marginBlock: 16 }}><strong>{f.name} v{f.currentVersion}</strong><p className="ws-hint">{f.layout}</p>
        <button className="ws-btn" disabled={disabled || !f.exampleGroupId || f.status === 'retired'} onClick={() => onUse(f.id)}>Use saved layout</button>
        {!f.exampleGroupId && <span className="ws-hint"> Upload a matching creative to add an example.</span>}</div>)}
    </section>}
  </div>;
}
