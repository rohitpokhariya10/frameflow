/**
 * Template Studio inside the OpenAI + Seedream workspace: the Generator's pages (templates, create template, generate
 * image, history, assets, brand kits, setup) under one tab, with its own sub-navigation. The decomposition tabs beside it
 * are FrameFlow's own and unchanged; a generated image reaches them only through `onDecompose`.
 */
import { useEffect, useState, type KeyboardEvent } from 'react';
import { History, ImagePlus, Images, Layers3, LayoutTemplate, Palette, Settings2, Sparkles } from 'lucide-react';
import type { StudioImageQuality, StudioPoster } from '@frameflow/shared';
import { studioApi } from './api';
import { TemplateCreate, TemplatePage, TemplatesGallery } from './Templates';
import { GenerateImage } from './GenerateImage';
import { GenerationRun, PosterResult } from './PosterResult';
import { GenerationHistory } from './History';
import { AssetLibrary, type CutoutOffer } from './AssetLibrary';
import { BrandKits } from './BrandKits';
import { SetupPanel } from './Setup';
import { Alert } from './ui';
import './templateStudio.css';
import { TemplateTypeChoice } from '../masterTemplates/OfferTemplates';

export const STUDIO_SECTIONS = [
  { id: 'templates', label: 'Templates', icon: LayoutTemplate },
  { id: 'create', label: 'Create Template', icon: ImagePlus },
  { id: 'generate', label: 'Generate Image', icon: Sparkles },
  { id: 'history', label: 'Generation History', icon: History },
  { id: 'assets', label: 'Assets', icon: Images },
  { id: 'brand', label: 'Brand Kits', icon: Palette },
  { id: 'setup', label: 'Setup & Usage', icon: Settings2 },
] as const;
export type StudioSection = typeof STUDIO_SECTIONS[number]['id'];

type GenerateView = { kind: 'form'; templateId?: string } | { kind: 'job'; jobId: string } | { kind: 'poster'; posterId: string };
type HistoryView = { kind: 'list' } | { kind: 'job'; jobId: string } | { kind: 'poster'; posterId: string };
/** A request from outside the studio (Overview's workflow card) to show one generated image. */
export type StudioRequest = { posterId: string; at: number };

const JOURNEY = [
  { label: 'Create template', section: 'create', sections: ['templates', 'create', 'assets', 'brand'] },
  { label: 'Generate image', section: 'generate', sections: ['generate', 'history', 'setup'] },
] as const;

export function TemplateStudio({ onDecompose, onOpenRun, onOpenDecomposition, onProtect, request, startOnCreate = false, onTextGraphics, onMakeMaster }: {
  onDecompose: (poster: StudioPoster, recursive: boolean) => Promise<void>; onOpenRun: (runId: string) => void; onOpenDecomposition: () => void; request?: StudioRequest;
  /** A poster's protected template (its text and logos kept out of decomposition). */
  onProtect?: (poster: StudioPoster) => Promise<void>;
  /** Opened from Offer Templates' "Product + Text" choice: start on Create Template. */
  startOnCreate?: boolean;
  /** Create Template's "Text & Graphics" choice: Offer Templates makes those. */
  onTextGraphics?: () => void;
  /** A poster's image as a Text & Graphics master. */
  onMakeMaster?: (poster: StudioPoster) => Promise<void>;
}) {
  // A request (Overview → "open the generated image") starts the studio on that image; the panel remounts it per request.
  const [section, setSection] = useState<StudioSection>(request ? 'history' : startOnCreate ? 'create' : 'templates');
  // Create Template asks for the template type first; the Product + Text form appears only once that type is chosen
  // (already chosen when Offer Templates sent the user here).
  const [createType, setCreateType] = useState<'product-text' | undefined>(startOnCreate ? 'product-text' : undefined);
  const [templatePage, setTemplatePage] = useState<string>(), [generate, setGenerate] = useState<GenerateView>({ kind: 'form' });
  const [history, setHistory] = useState<HistoryView>(request ? { kind: 'poster', posterId: request.posterId } : { kind: 'list' });
  const [meta, setMeta] = useState<{ cutouts: CutoutOffer; defaults: { quality: StudioImageQuality } } | null>(null), [unavailable, setUnavailable] = useState('');
  useEffect(() => {
    let alive = true;
    void studioApi.get<{ cutouts: CutoutOffer; defaults: { quality: StudioImageQuality } }>('/meta').then(m => { if (alive) setMeta(m); }).catch((e: Error) => { if (alive) setUnavailable(e.message); });
    return () => { alive = false; };
  }, []);
  const generateWith = (templateId: string) => { setGenerate({ kind: 'form', templateId }); setSection('generate'); };
  const result = (posterId: string, back: () => void, backLabel: string) => <PosterResult key={posterId} posterId={posterId} onBack={back} backLabel={backLabel} onDecompose={onDecompose} onOpenRun={onOpenRun} onProtect={onProtect} onMakeMaster={onMakeMaster}
    onStartedJob={jobId => { setGenerate({ kind: 'job', jobId }); setSection('generate'); }} />;
  const keys = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const n = STUDIO_SECTIONS.length;
    const next = event.key === 'ArrowRight' ? (index + 1) % n : event.key === 'ArrowLeft' ? (index + n - 1) % n : event.key === 'Home' ? 0 : event.key === 'End' ? n - 1 : undefined;
    if (next === undefined) return;
    event.preventDefault(); setSection(STUDIO_SECTIONS[next].id);
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role=tab]')[next]?.focus();
  };
  const at = JOURNEY.findIndex(j => (j.sections as readonly string[]).includes(section));
  return <div className="ts-studio">
    <div className="ts-studio-bar">
      <ol className="ts-journey" aria-label="Workflow">
        {JOURNEY.map((step, i) => <li key={step.label} className={i === at ? 'is-current' : i < at ? 'is-done' : undefined} aria-current={i === at ? 'step' : undefined}><button type="button" onClick={() => setSection(step.section)}><span>{i + 1}</span>{step.label}</button></li>)}
        <li><button type="button" onClick={onOpenDecomposition}><span>3</span>Decompose & edit <Layers3 size={14} aria-hidden="true" /></button></li>
      </ol>
      <div role="tablist" aria-label="Template Studio sections" className="ts-subnav">
        {STUDIO_SECTIONS.map(({ id, label, icon: Icon }, index) => <button key={id} type="button" role="tab" id={`studio-tab-${id}`} aria-controls={`studio-panel-${id}`} aria-selected={section === id} tabIndex={section === id ? 0 : -1}
          onClick={() => { setSection(id); if (id === 'templates') setTemplatePage(undefined); if (id === 'create') setCreateType(undefined); }} onKeyDown={event => keys(event, index)}><Icon size={15} aria-hidden="true" /><span>{label}</span></button>)}
      </div>
    </div>
    {unavailable && <div className="ts-page"><Alert>Template Studio is unavailable on this server: {unavailable}</Alert></div>}
    <div role="tabpanel" id={`studio-panel-${section}`} aria-labelledby={`studio-tab-${section}`}>
      {section === 'templates' && (templatePage ? <TemplatePage id={templatePage} onBack={() => setTemplatePage(undefined)} onGenerate={generateWith} /> : <TemplatesGallery onCreate={() => setSection('create')} onOpen={setTemplatePage} onGenerate={generateWith} />)}
      {section === 'create' && (onTextGraphics && !createType
        // The template type first: Text & Graphics opens Offer Templates' master creation; Product + Text this studio's form.
        ? <div className="ts-page"><div><p className="ts-kicker">CREATE TEMPLATE</p><h2 style={{ fontSize: 20, margin: '4px 0 6px' }}>What kind of template is it?</h2>
          <p className="ts-muted">Offer posters with replaceable text, logos, badges and QR codes (Easy EMI and similar) are Text &amp; Graphics.</p></div>
          <TemplateTypeChoice onChoose={type => { if (type === 'text-graphics') onTextGraphics(); else setCreateType('product-text'); }} /></div>
        : <>
          {onTextGraphics && <div className="ts-page" style={{ paddingBottom: 0 }}><p className="ts-muted">Product + Text template · <button type="button" className="ws-link" onClick={() => setCreateType(undefined)}>change type</button></p></div>}
          <TemplateCreate onGenerate={generateWith} onOpenTemplates={() => { setTemplatePage(undefined); setSection('templates'); }} />
        </>)}
      {section === 'generate' && (generate.kind === 'job' ? <GenerationRun key={generate.jobId} jobId={generate.jobId} onDone={posterId => setGenerate({ kind: 'poster', posterId })} onCancelled={() => setGenerate({ kind: 'form' })} />
        : generate.kind === 'poster' ? result(generate.posterId, () => setGenerate({ kind: 'form' }), 'New image')
          : <GenerateImage key={generate.templateId ?? 'default'} initialTemplateId={generate.templateId} cutoutOffer={meta?.cutouts ?? null} defaultQuality={meta?.defaults.quality ?? 'high'} onStarted={jobId => setGenerate({ kind: 'job', jobId })} onCreateTemplate={() => setSection('create')} onOpenBrandKits={() => setSection('brand')} />)}
      {section === 'history' && (history.kind === 'poster' ? result(history.posterId, () => setHistory({ kind: 'list' }), 'Generation history')
        : history.kind === 'job' ? <GenerationRun key={history.jobId} jobId={history.jobId} onDone={posterId => setHistory({ kind: 'poster', posterId })} onCancelled={() => setHistory({ kind: 'list' })} />
          : <GenerationHistory onOpenPoster={posterId => setHistory({ kind: 'poster', posterId })} onOpenJob={jobId => setHistory({ kind: 'job', jobId })} onOpenTemplate={() => setSection('templates')} />)}
      {section === 'assets' && <AssetLibrary cutoutOffer={meta?.cutouts ?? null} />}
      {section === 'brand' && <BrandKits />}
      {section === 'setup' && <SetupPanel />}
    </div>
  </div>;
}
