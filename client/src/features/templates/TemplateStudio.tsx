import { useState } from 'react';
import { ReferenceCreative } from '../referenceCreatives/ReferenceCreative';
import { X } from 'lucide-react';
import {
  TemplateError, createCreative, createTemplateDraft, creativesOf, deleteCreative, deleteDesignTemplate, designTemplateVersion, duplicateDesignTemplate, latestDesignTemplate, listDesignTemplates,
  renameDesignTemplate, saveCreative, saveDesignTemplate, upgradeCreative, type Creative, type DesignTemplate, type DesignVariant, type TemplateLibrary,
} from '@frameflow/shared';
import { useAppDispatch, useAppSelector } from '../../store';
import { decomposedDesignImported } from '../../store/editorSlice';
import { variantSelected } from '../../store/uiSlice';
import { isDesignVariant } from '../../lib/persistence/schema';
import '../decomposition/workspace/workspace.css';
import './templates.css';
import { CreativeEditor } from './CreativeEditor';
import { TemplateAuthor } from './TemplateAuthor';
import { loadTemplateLibrary, saveTemplateLibrary } from './templateStorage';
import { useTemplateHistory } from './useTemplateHistory';
import { historyKey } from '../editor/selectionKeyboard';

type View = { kind: 'author'; draft: DesignTemplate } | { kind: 'creative'; creative: Creative };
const documentOf = (view: View) => view.kind === 'author' ? view.draft : view.creative;
const storage = () => window.localStorage;
const now = () => new Date().toISOString();
const newDraft = (): View => ({ kind: 'author', draft: createTemplateDraft(`tpl-${crypto.randomUUID()}`, now()) });
const problemText = (problem: unknown) => problem instanceof TemplateError || problem instanceof Error ? problem.message : 'That did not work.';

/**
 * Create Own Template: author reusable templates, then make creatives from them. Everything here is local: templates
 * and creatives are kept in this browser, pictures in its asset store. Explicit AI planning and the reference campaign
 * panel use server services; curated selection and reuse stay local.
 */
export function TemplateStudio({ onClose }: { onClose: () => void }) {
  const dispatch = useAppDispatch();
  const [referenceOpen, setReferenceOpen] = useState(false);
  const variantCount = useAppSelector(state => state.editor.document.variants.length);
  const [loaded] = useState(() => loadTemplateLibrary(storage));
  const [library, setLibrary] = useState<TemplateLibrary>(loaded.library);
  // Opens on the authoring editor with a new template; the library beside it lists the existing ones.
  const history = useTemplateHistory<View>(newDraft);
  const view = history.present;
  // The last saved state is independent of undo: undoing a saved edit correctly becomes dirty again.
  const [baseline, setBaseline] = useState(() => JSON.stringify(documentOf(view)));
  const setView = (next: View) => { history.reset(next); setBaseline(JSON.stringify(documentOf(next))); };
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(loaded.warning ? { text: loaded.warning, error: true } : null);
  const dirty = JSON.stringify(documentOf(view)) !== baseline;
  const templates = listDesignTemplates(library);

  /** Writes the library to storage first; the screen only moves on when that worked. */
  const persist = (next: TemplateLibrary) => {
    try { saveTemplateLibrary(storage, next); setLibrary(next); return true; }
    catch { setMessage({ text: 'Could not save to this browser\'s storage (it may be full or unavailable). Nothing was changed.', error: true }); return false; }
  };
  const attempt = (work: () => void) => { try { work(); } catch (problem) { setMessage({ text: problemText(problem), error: true }); } };
  /** Leaving unsaved work asks first. */
  const leave = (go: () => void) => { if (!dirty || window.confirm('Discard the unsaved changes?')) { setMessage(null); attempt(go); } };

  const saveTemplate = (draft: DesignTemplate) => attempt(() => {
    if (view.kind !== 'author') return;
    const result = saveDesignTemplate(library, draft, now());
    if (result.outcome !== 'unchanged' && !persist(result.library)) return;
    history.replace({ kind: 'author', draft: result.template }); setBaseline(JSON.stringify(result.template));
    const pinned = creativesOf(result.library, result.template.id).filter(creative => creative.templateVersion !== result.template.version).length;
    setMessage({ text: { created: `Saved "${result.template.name}" as version 1.`, renamed: `Renamed to "${result.template.name}". The structure is unchanged, so it is still version ${result.template.version}.`, unchanged: 'Nothing to save.',
      'new-version': `Saved as version ${result.template.version}.${pinned ? ` ${pinned} existing creative${pinned === 1 ? '' : 's'} stay${pinned === 1 ? 's' : ''} on the earlier version and ${pinned === 1 ? 'is' : 'are'} unchanged.` : ''}` }[result.outcome] });
  });
  const saveCurrentCreative = () => attempt(() => {
    if (view.kind !== 'creative') return;
    const result = saveCreative(library, view.creative, now());
    if (!persist(result.library)) return;
    history.replace({ kind: 'creative', creative: result.creative }); setBaseline(JSON.stringify(result.creative));
    setMessage({ text: `Saved creative "${result.creative.name}".` });
  });
  const edit = (id: string) => leave(() => { const draft = latestDesignTemplate(library, id)!; setView({ kind: 'author', draft }); });
  const use = (id: string) => leave(() => {
    const template = latestDesignTemplate(library, id)!;
    const creative = createCreative(template, { id: `creative-${crypto.randomUUID()}`, name: `${template.name} creative ${creativesOf(library, id).length + 1}`.slice(0, 200), now: now() });
    setView({ kind: 'creative', creative });
  });
  const openCreative = (creative: Creative) => leave(() => setView({ kind: 'creative', creative }));
  const duplicate = (id: string) => attempt(() => {
    const result = duplicateDesignTemplate(library, id, `tpl-${crypto.randomUUID()}`, now());
    if (persist(result.library)) setMessage({ text: `Duplicated as "${result.template.name}", a separate template.` });
  });
  const rename = (template: DesignTemplate) => attempt(() => {
    const name = window.prompt('Template name', template.name);
    if (name === null) return;
    const next = renameDesignTemplate(library, template.id, name, now());
    if (next === library || !persist(next)) return;
    // The open draft of this template takes the new name too, without becoming an unsaved change.
    if (view.kind === 'author' && view.draft.id === template.id) { const renamed = { ...view.draft, name: name.trim() }; history.reset({ kind: 'author', draft: renamed }); setBaseline(JSON.stringify({ ...JSON.parse(baseline), name: name.trim() })); }
  });
  const removeTemplate = (template: DesignTemplate) => attempt(() => {
    if (!window.confirm(`Delete the template "${template.name}"? This cannot be undone.`)) return;
    if (!persist(deleteDesignTemplate(library, template.id))) return;
    if (view.kind === 'author' && view.draft.id === template.id) setView(newDraft());
  });
  const removeCreative = (creative: Creative) => attempt(() => {
    if (!window.confirm(`Delete the creative "${creative.name}"? This cannot be undone.`)) return;
    if (!persist(deleteCreative(library, creative.id))) return;
    if (view.kind === 'creative' && view.creative.id === creative.id) setView(newDraft());
  });
  const upgrade = () => attempt(() => {
    if (view.kind !== 'creative') return;
    const latest = latestDesignTemplate(library, view.creative.templateId)!;
    const result = upgradeCreative(view.creative, latest, now());
    history.edit({ ...view, creative: result.creative });
    setMessage({ text: `Now on version ${latest.version}; save the creative to keep it.${result.dropped.length ? ` Not carried over: ${result.dropped.join(' ')}` : ''}`, error: result.dropped.length > 0 });
  });
  /** Adds the rendered creative to the editor as a new version, the same way other imports do, and closes the studio. */
  const openInEditor = (variant: DesignVariant): string | undefined => {
    if (variantCount >= 30) return 'This design already has 30 versions. Delete one and try again.';
    if (!isDesignVariant(variant)) return 'This creative could not be opened as a design version.';
    // The store's add-a-version action (named after its first use, a decomposed image); it is a plain local reducer.
    dispatch(decomposedDesignImported({ variant, timestamp: now() }));
    dispatch(variantSelected(variant.id));
    onClose();
    return undefined;
  };

  const pinnedTemplate = view.kind === 'creative' ? designTemplateVersion(library, view.creative.templateId, view.creative.templateVersion) : undefined;
  const newest = view.kind === 'creative' ? latestDesignTemplate(library, view.creative.templateId)?.version : undefined;
  // Creative ratio is persisted, but browsing it is not an edit. Keep the current ratio when travelling history
  // unless undoing a version upgrade restores a template that does not support it.
  const restore = (next: View, current: View): View => {
    if (next.kind !== 'creative' || current.kind !== 'creative') return next;
    const source = designTemplateVersion(library, next.creative.templateId, next.creative.templateVersion);
    return source?.supportedAspectRatios.includes(current.creative.aspectRatio) ? { ...next, creative: { ...next.creative, aspectRatio: current.creative.aspectRatio } } : next;
  };
  const controls = { canUndo: history.canUndo, canRedo: history.canRedo,
    undo: () => { history.undo(restore); setMessage(null); }, redo: () => { history.redo(restore); setMessage(null); } };
  const associated = view.kind === 'author' ? view.draft : pinnedTemplate;
  return <><div className="ws-backdrop" style={referenceOpen ? { display: 'none' } : undefined}><div className="ws" role="dialog" aria-modal="true" aria-labelledby="tpl-title" style={{ gridTemplateRows: 'auto minmax(0, 1fr)' }}
    {...history.fieldEvents} onKeyDown={event => {
      const command = historyKey(event);
      if (command) { event.preventDefault(); event.stopPropagation(); controls[command](); }
    }}>
    <header className="ws-header" style={{ gridTemplateColumns: '1fr auto' }}>
      <h2 id="tpl-title" style={{ fontSize: 15, fontWeight: 600 }}>{view.kind === 'author' ? 'Create Own Template' : 'Use Template'} <span className="ws-muted">· local templates · optional AI planner</span></h2>
      <button className="ws-icon-button" aria-label="Close" onClick={() => leave(onClose)}><X size={18} /></button>
    </header>
    <div className="ws-body"><div className="tpl">
      <nav className="tpl-sidebar" aria-label="Templates">
        <button type="button" className="ws-btn ws-btn-primary" onClick={() => leave(() => setView(newDraft()))}>Create Own Template</button>
        {message && <p role={message.error ? 'alert' : 'status'} className={message.error ? 'ws-warn' : 'ws-notice'}>{message.text}</p>}
        {view.kind === 'author' && <button id="reference-entry" type="button" className="ws-btn" onClick={() => setReferenceOpen(true)}>{associated?.referenceSetId ? 'Open reference campaign' : 'Create from Reference Image'}</button>}
        <p className="ws-hint">Keep a reference style, change your product or festival, and create three sizes.</p>
        <h3>Existing templates</h3>
        {!templates.length && <p className="ws-muted">None yet. Build one and press Save Template.</p>}
        {templates.map((template) => {
          const creatives = creativesOf(library, template.id), open = view.kind === 'author' ? view.draft.id === template.id : view.creative.templateId === template.id;
          return <div key={template.id} className={`tpl-card ${open ? 'is-on' : ''}`}>
            <strong>{template.name}</strong>
            <span className="ws-muted">version {template.version} · {template.elements.length} element{template.elements.length === 1 ? '' : 's'} · {template.supportedAspectRatios.join(' ')}</span>
            <div className="tpl-row">
              <button type="button" className="ws-btn ws-btn-primary" onClick={() => use(template.id)}>Use Template</button>
              <button type="button" className="ws-btn" onClick={() => edit(template.id)}>Edit Template</button>
              <button type="button" className="ws-btn" onClick={() => duplicate(template.id)}>Duplicate</button>
              <button type="button" className="ws-btn ws-btn-quiet" onClick={() => rename(template)}>Rename</button>
              <button type="button" className="ws-btn ws-btn-quiet" disabled={creatives.length > 0} title={creatives.length ? 'Delete its creatives first.' : undefined} onClick={() => removeTemplate(template)}>Delete</button>
            </div>
            {creatives.length > 0 && <ul className="tpl-creatives" aria-label={`Creatives of ${template.name}`}>{creatives.map(creative => <li key={creative.id}>
              <button type="button" className={view.kind === 'creative' && view.creative.id === creative.id ? 'is-on' : ''} onClick={() => openCreative(creative)}>
                <span>{creative.name}</span><span className="ws-muted">{creative.aspectRatio} · v{creative.templateVersion}</span></button>
              <button type="button" className="ws-icon-button" aria-label={`Delete creative ${creative.name}`} onClick={() => removeCreative(creative)}><X size={14} /></button>
            </li>)}</ul>}
          </div>;
        })}
      </nav>
      {view.kind === 'author'
        ? <TemplateAuthor key={`${history.session}-${view.draft.id}`} template={view.draft} history={controls} saved={!!latestDesignTemplate(library, view.draft.id)} dirty={dirty} onSave={saveTemplate} onChange={draft => history.edit({ ...view, draft })} />
        : pinnedTemplate
          ? <CreativeEditor key={`${history.session}-${view.creative.id}`} template={pinnedTemplate} creative={view.creative} history={controls} saved={library.creatives.some(creative => creative.id === view.creative.id)} dirty={dirty}
              newerVersion={newest !== undefined && newest > view.creative.templateVersion ? newest : undefined}
              onChange={creative => history.edit({ ...view, creative })} onRatioChange={creative => history.replace({ ...view, creative })} onSave={saveCurrentCreative} onUpgrade={upgrade} onOpenInEditor={openInEditor} />
          : <p role="alert" className="ws-warn" style={{ margin: 16 }}>The template version this creative was made with is no longer in this browser, so it cannot be shown.</p>}
    </div></div>
  </div></div>
    {referenceOpen && <ReferenceCreative templateId={associated!.id} templateName={associated!.name} linkedSetId={associated?.referenceSetId}
      onAssociate={id => {
        if (view.kind === 'author') history.edit({ ...view, draft: { ...view.draft, referenceSetId: id } });
        else setMessage({ text: 'Open Edit Template to save this reference association.', error: true });
      }}
      onClose={() => { setReferenceOpen(false); requestAnimationFrame(() => document.getElementById('reference-entry')?.focus()); }} onEditor={onClose} />}
  </>;
}
