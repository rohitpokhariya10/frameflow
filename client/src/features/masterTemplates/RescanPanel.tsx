/**
 * "Scan Again" for a saved template, in three steps: 1 check the original design again (on this server, free), 2 review
 * the suggestions beside the current template, 3 apply only the chosen ones. Nothing changes before step 3; saved
 * creatives never change (they keep the version they were made from). Plain words only: this is the user-facing flow.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, CheckCircle2, LoaderCircle, RefreshCw, ScanSearch } from 'lucide-react';
import type { RescanFont, SourceBox } from '@frameflow/shared';
import { Alert } from '../templateStudio/ui';
import { loadRequiredFonts } from '../fonts/fontLoader';
import { masterApi, masterFileUrl, MasterApiError, type MasterRescanResult, type MasterView } from './api';

const WEIGHTS: Record<number, string> = { 400: 'Regular', 600: 'Semibold', 700: 'Bold' };
const fontName = (f: RescanFont) => `${f.fontFamily} ${WEIGHTS[f.fontWeight] ?? f.fontWeight}${f.fontStyle === 'italic' ? ' Italic' : ''}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const friendly = (e: unknown) => e instanceof MasterApiError
  ? e.code === 'STALE_REVISION' ? 'Your template was changed in the meantime. We refreshed it: please look at the suggestions again.'
    : e.code === 'NOT_FOUND' ? 'These results are no longer available. Please scan again.' : e.message
  : e instanceof Error ? e.message : 'Something went wrong. Please try again.';

interface Line { lineId: string; text: string; box: SourceBox; wordIds: string[]; chosen: boolean; from: RescanFont; to: RescanFont }
/** Something the template is missing: new text on one of its lines, or a shape behind one of its phrases. */
interface Finding { key: string; kind: 'text' | 'shape'; ids: string[]; text: string; box: SourceBox; where: string }
const union = (a: SourceBox, b: SourceBox): SourceBox => { const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y); return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y, rotation: 0 }; };

export function RescanPanel({ view, onClose, onView, onApplied }: { view: MasterView; onClose: () => void; onView: (v: MasterView) => void; onApplied: (v: MasterView, message: string) => void }) {
  const rescan = view.master.rescan, [confirm, setConfirm] = useState<'selected' | 'replace'>();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const heading = useRef<HTMLHeadingElement>(null), [now, setNow] = useState(() => Date.now());
  const phase = !rescan ? 'intro' : rescan.status === 'running' ? 'running' : rescan.status === 'failed' ? 'failed' : confirm ? 'confirm' : 'review';
  const step = phase === 'review' ? 2 : phase === 'confirm' ? 3 : 1;

  // The finished scan's suggestions, fetched once per scan (kept with the scan they belong to).
  const file = rescan?.status === 'done' ? rescan.file : undefined, [fetched, setFetched] = useState<{ file: string; result: MasterRescanResult }>();
  const result = fetched && fetched.file === file ? fetched.result : undefined;
  useEffect(() => {
    if (!file) return;
    let alive = true;
    masterApi.rescanResult(view.template.id).then(r => { if (alive) setFetched({ file, result: r }); }).catch(e => { if (alive) setError(friendly(e)); });
    return () => { alive = false; };
  }, [file, view.template.id]);
  // Each text line with a suggested font: the line as it reads now, where it is, and both fonts.
  const lines = useMemo<Line[]>(() => {
    const words = (view.template.textAnalysis?.words ?? []).filter(w => w.review.status !== 'rejected'), out: Line[] = [];
    for (const c of result?.changes.fonts ?? []) {
      let line = out.find(l => l.lineId === c.lineId);
      if (!line) {
        const row = words.filter(w => w.lineId === c.lineId).sort((a, b) => a.box.x - b.box.x);
        const x = Math.min(...row.map(w => w.box.x)), y = Math.min(...row.map(w => w.box.y));
        const box = { x, y, width: Math.max(...row.map(w => w.box.x + w.box.width)) - x, height: Math.max(...row.map(w => w.box.y + w.box.height)) - y, rotation: 0 };
        line = { lineId: c.lineId, text: row.map(w => w.text).join(' ') || c.text, box, wordIds: [], chosen: false, from: c.from, to: c.to };
        out.push(line);
      }
      line.wordIds.push(c.wordId); line.chosen ||= c.chosen;
    }
    return out;
  }, [result, view.template.textAnalysis]);
  // New text on a current line (one row per line) and new shapes behind a current phrase.
  const findings = useMemo<Finding[]>(() => {
    const words = (view.template.textAnalysis?.words ?? []).filter(w => w.review.status !== 'rejected'), out: Finding[] = [];
    const lineText = (lineId: string) => words.filter(w => w.lineId === lineId).sort((a, b) => a.box.x - b.box.x).map(w => w.text).join(' ');
    for (const a of [...(result?.changes.added ?? [])].filter(x => x.lineId).sort((p, q) => p.box.x - q.box.x)) {
      const key = `t:${a.lineId}`;
      let f = out.find(x => x.key === key);
      if (!f) { f = { key, kind: 'text', ids: [], text: '', box: a.box, where: lineText(a.lineId!) }; out.push(f); }
      f.ids.push(a.wordId); f.text = [f.text, a.text].filter(Boolean).join(' '); f.box = union(f.box, a.box);
    }
    for (const p of result?.changes.plates ?? []) if (p.groupId) out.push({ key: `p:${p.plateId}`, kind: 'shape', ids: [p.plateId], text: '', box: p.box, where: words.filter(w => w.groupId === p.groupId).sort((a, b) => a.order - b.order).map(w => w.text).join(' ') });
    return out;
  }, [result, view.template.textAnalysis]);
  // Ticked by default, except fonts you picked yourself (kept unless you tick them); your own ticks per scan.
  const [ticks, setTicks] = useState<{ file?: string; picked: Record<string, boolean> }>({ picked: {} });
  const isPicked = (l: Line) => ticks.file === file && l.lineId in ticks.picked ? ticks.picked[l.lineId] : !l.chosen;
  const isFound = (f: Finding) => ticks.file === file && f.key in ticks.picked ? ticks.picked[f.key] : true;
  const pick = (entries: [string, boolean][]) => setTicks(t => ({ file, picked: { ...(t.file === file ? t.picked : {}), ...Object.fromEntries(entries) } }));
  const [fontsReady, setFontsReady] = useState(false);
  useEffect(() => {
    if (!lines.length) return;
    const fonts = lines.flatMap(l => [l.from, l.to]).map(f => ({ family: f.fontFamily, weight: f.fontWeight, italic: f.fontStyle === 'italic' }));
    void loadRequiredFonts(fonts).catch(() => false).finally(() => setFontsReady(true));
  }, [lines]);
  useEffect(() => { heading.current?.focus(); }, [phase]);
  useEffect(() => {
    if (phase !== 'running') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [phase]);

  const run = async (work: () => Promise<void>) => { setBusy(true); setError(''); try { await work(); } catch (e) { setError(friendly(e)); if (e instanceof MasterApiError && e.code === 'STALE_REVISION') onView(await masterApi.get(view.template.id)); } finally { setBusy(false); } };
  const start = () => run(async () => { const r = await masterApi.rescan(view); onView(r.master); });
  const discard = (message?: string) => run(async () => { const v = rescan ? await masterApi.discardRescan(view) : view; onView(v); onClose(); if (message) onApplied(v, message); });
  const chosenLines = lines.filter(isPicked), chosenFindings = findings.filter(isFound), chosenCount = chosenLines.length + chosenFindings.length;
  const apply = () => run(async () => {
    if (!result) return;
    if (confirm === 'replace') {
      const v = await masterApi.applyRescan(view, result.analysisRevision, { mode: 'replace' });
      onApplied(v, 'Your template now uses the new scan. Check each item below, then continue and press Save master. Saved creatives are unchanged.');
    } else {
      const v = await masterApi.applyRescan(view, result.analysisRevision, { mode: 'selected', wordIds: chosenLines.flatMap(l => l.wordIds),
        addWordIds: chosenFindings.filter(f => f.kind === 'text').flatMap(f => f.ids), addPlateIds: chosenFindings.filter(f => f.kind === 'shape').flatMap(f => f.ids) });
      const done = [chosenLines.length && `updated the font on ${plural(chosenLines.length, 'line')}`, chosenFindings.length && `added ${plural(chosenFindings.length, 'missing item')}`].filter(Boolean).join(' and ');
      onApplied(v, chosenFindings.length
        ? `Done: ${done}. Next, make the clean background again below so the added text is removed from it, then press Save master. Saved creatives are unchanged.`
        : `Done: ${done}. To use ${chosenLines.length === 1 ? 'it' : 'them'} in new creatives, press Save master below. Saved creatives are unchanged.`);
    }
  });

  const c = result?.changes, unplaced = c ? c.added.filter(a => !a.lineId) : [], others = c ? unplaced.length + c.plates.filter(p => !p.groupId).length + c.missing.length + c.text.length + c.logos.added + c.logos.missing + c.logos.moved : 0;
  const imageUrl = masterFileUrl(view.template.id, view.template.source.inputFile), size = { width: view.template.source.width, height: view.template.source.height };
  const elapsed = rescan ? Math.max(0, Math.round((now - Date.parse(rescan.startedAt)) / 1000)) : 0;

  return <section className="ot-rescan" aria-labelledby="ot-rescan-title">
    <div className="ot-rescan-head">
      <ol className="ot-steps is-compact" aria-label="Scan Again steps">
        {['Scan again', 'Review results', 'Apply changes'].map((label, i) => <li key={label} className={i + 1 === step ? 'is-current' : i + 1 < step ? 'is-done' : undefined} aria-current={i + 1 === step ? 'step' : undefined}><span>{i + 1 < step ? '✓' : i + 1}</span>{label}</li>)}
      </ol>
    </div>

    {phase === 'intro' && <div className="ot-rescan-body">
      <h3 id="ot-rescan-title" ref={heading} tabIndex={-1}><ScanSearch size={18} aria-hidden="true" />Scan your original design again</h3>
      <p>We'll look at your original design again to find its text and match the fonts more closely. You'll see every suggestion before anything changes.</p>
      <ul className="ot-rescan-facts">
        {['Your saved creatives stay exactly as they are.', 'Your corrections and logos are kept unless you choose otherwise.', 'Takes about 10–30 seconds. Free.'].map(fact => <li key={fact}><CheckCircle2 size={15} className="ot-ok-icon" aria-hidden="true" />{fact}</li>)}
      </ul>
      {error && <Alert>{error}</Alert>}
      <div className="ot-rescan-actions">
        <button type="button" className="ws-btn ws-btn-primary" disabled={busy} onClick={() => void start()}><RefreshCw size={15} aria-hidden="true" />{busy ? 'Starting…' : 'Start scan'}</button>
        <button type="button" className="ws-btn ws-btn-quiet" disabled={busy} onClick={onClose}>Cancel</button>
      </div>
    </div>}

    {phase === 'running' && <div className="ot-rescan-body">
      <h3 id="ot-rescan-title" ref={heading} tabIndex={-1}><LoaderCircle size={18} className="ws-spin" aria-hidden="true" />Checking your design…</h3>
      <p role="status" aria-live="polite">Finding the text and comparing fonts. Nothing in your template changes yet.</p>
      <div className="ot-rescan-progress" aria-hidden="true"><span /></div>
      <p className="ot-muted">{elapsed >= 3 ? `${elapsed} s · ` : ''}You can leave this page: the results will wait here.</p>
    </div>}

    {phase === 'failed' && <div className="ot-rescan-body">
      <h3 id="ot-rescan-title" ref={heading} tabIndex={-1}>The scan didn't finish</h3>
      <Alert>Your template hasn't changed. Please try again.{rescan?.error ? <span className="ot-small"> ({rescan.error})</span> : null}</Alert>
      {error && <Alert>{error}</Alert>}
      <div className="ot-rescan-actions">
        <button type="button" className="ws-btn ws-btn-primary" disabled={busy} onClick={() => void start()}><RefreshCw size={15} aria-hidden="true" />Try again</button>
        <button type="button" className="ws-btn ws-btn-quiet" disabled={busy} onClick={() => void discard()}>Close</button>
      </div>
    </div>}

    {phase === 'review' && <div className="ot-rescan-body">
      <h3 id="ot-rescan-title" ref={heading} tabIndex={-1}>Review the suggestions</h3>
      {!result ? <p className="ot-muted" role="status">{error ? '' : 'Loading the results…'}</p>
        : !lines.length && !findings.length && !others ? <>
          <p><CheckCircle2 size={16} className="ot-ok-icon" aria-hidden="true" /> Everything already matches your template. There's nothing to change.</p>
          <div className="ot-rescan-actions"><button type="button" className="ws-btn ws-btn-primary" disabled={busy} onClick={() => void discard('Scan finished: your template already matched. Nothing was changed.')}>Done</button></div>
        </> : <>
          {findings.length > 0 && <>
            <h4 className="ot-rescan-sub">Found this time</h4>
            <p>{findings.length === 1 ? 'Something your template is missing.' : `${findings.length} things your template is missing.`} Adding them removes them from the background, so nothing of the original shows behind your new text, and new text becomes editable.</p>
            <ul className="ot-rescan-list">
              {findings.map(f => <li key={f.key} className={isFound(f) ? 'is-picked' : undefined}>
                <label className="ot-rescan-pick">
                  <input type="checkbox" checked={isFound(f)} onChange={() => pick([[f.key, !isFound(f)]])} aria-describedby={`ot-rescan-${f.key}`} />
                  <span>{f.kind === 'text' ? <><strong>“{f.text}”</strong> <span className="ot-muted">new text on the line “{f.where}”</span></> : <><strong>A shape behind “{f.where}”</strong> <span className="ot-muted">its colour can then be changed in creatives</span></>}</span>
                </label>
                <div className="ot-rescan-compare is-one" id={`ot-rescan-${f.key}`}><figure><figcaption>Your design</figcaption><PosterCrop url={imageUrl} size={size} box={f.box} label={f.kind === 'text' ? f.text : `the shape behind ${f.where}`} /></figure></div>
              </li>)}
            </ul>
          </>}
          {lines.length > 0 && <>
            {findings.length > 0 && <h4 className="ot-rescan-sub">Closer fonts</h4>}
            <p>{lines.length === 1 ? 'One line looks closer to your design in a different font.' : `${lines.length} lines look closer to your design in a different font.`} Tick the ones you want to use.</p>
            <div className="ot-row ot-small"><button type="button" className="ws-link" onClick={() => pick(lines.map(l => [l.lineId, true]))}>Select all</button><button type="button" className="ws-link" onClick={() => pick(lines.map(l => [l.lineId, false]))}>Clear</button></div>
            <ul className="ot-rescan-list" aria-busy={!fontsReady}>
              {lines.map(l => <li key={l.lineId} className={isPicked(l) ? 'is-picked' : undefined}>
                <label className="ot-rescan-pick">
                  <input type="checkbox" checked={isPicked(l)} onChange={() => pick([[l.lineId, !isPicked(l)]])} aria-describedby={`ot-rescan-${l.lineId}`} />
                  <span><strong>“{l.text}”</strong>{l.chosen && <span className="ot-rescan-note"> You picked this font yourself: kept unless you tick it.</span>}</span>
                </label>
                <div className="ot-rescan-compare" id={`ot-rescan-${l.lineId}`}>
                  <figure><figcaption>Your design</figcaption><PosterCrop url={imageUrl} size={size} box={l.box} label={l.text} /></figure>
                  <figure><figcaption>Now <span>{fontName(l.from)}</span></figcaption><Sample font={l.from} text={l.text} /></figure>
                  <figure className="is-new"><figcaption>Suggested <span>{fontName(l.to)}</span></figcaption><Sample font={l.to} text={l.text} /></figure>
                </div>
              </li>)}
            </ul>
          </>}
          {others > 0 && <div className="ot-rescan-others">
            <h4>Also noticed (not changed)</h4>
            <ul>
              {unplaced.length > 0 && <li>New text not on any of your lines: {unplaced.slice(0, 6).map(a => `“${a.text}”`).join(', ')}{unplaced.length > 6 ? ` and ${unplaced.length - 6} more` : ''}</li>}
              {c!.text.length > 0 && <li>Read differently (your wording is kept): {c!.text.slice(0, 4).map(t => `“${t.from}” → “${t.to}”`).join(', ')}</li>}
              {c!.missing.length > 0 && <li>Not found this time (kept): {c!.missing.slice(0, 6).map(m => `“${m.text}”`).join(', ')}</li>}
              {c!.logos.added + c!.logos.missing + c!.logos.moved > 0 && <li>Logos and graphics: {[c!.logos.added && `${c!.logos.added} new`, c!.logos.missing && `${c!.logos.missing} not found`, c!.logos.moved && `${c!.logos.moved} in a slightly different place`].filter(Boolean).join(', ')} (kept as they are)</li>}
            </ul>
            <p className="ot-muted">To rebuild the template from this scan instead, <button type="button" className="ws-link" onClick={() => setConfirm('replace')}>start over with the new scan</button>. Your corrections would be replaced.</p>
          </div>}
          {error && <Alert>{error}</Alert>}
          <div className="ot-rescan-actions">
            {lines.length + findings.length > 0 && <button type="button" className="ws-btn ws-btn-primary" disabled={busy || !chosenCount} aria-describedby={chosenCount ? undefined : 'ot-rescan-none'} onClick={() => setConfirm('selected')}>{chosenCount ? `Continue with ${plural(chosenCount, 'change')}` : 'Continue'}</button>}
            <button type="button" className="ws-btn ws-btn-quiet" disabled={busy} onClick={() => void discard('Scan results discarded. Nothing was changed.')}>Cancel</button>
          </div>
          {lines.length + findings.length > 0 && !chosenCount && <p className="ot-muted" id="ot-rescan-none">Tick something to continue, or Cancel to keep everything as it is.</p>}
        </>}
    </div>}

    {phase === 'confirm' && <div className="ot-rescan-body">
      {confirm === 'selected' ? <>
        <h3 id="ot-rescan-title" ref={heading} tabIndex={-1}>Apply the selected changes?</h3>
        {chosenFindings.length > 0 && <><p>{chosenFindings.length === 1 ? 'This will be added to your template:' : `These ${chosenFindings.length} things will be added to your template:`}</p>
          <ul className="ot-rescan-summary">{chosenFindings.map(f => <li key={f.key}>{f.kind === 'text' ? <><strong>“{f.text}”</strong> <span className="ot-muted">on the line “{f.where}”</span></> : <><strong>The shape behind “{f.where}”</strong></>}</li>)}</ul></>}
        {chosenLines.length > 0 && <><p>{chosenLines.length === 1 ? 'This line will use the suggested font:' : `These ${chosenLines.length} lines will use the suggested fonts:`}</p>
          <ul className="ot-rescan-summary">{chosenLines.map(l => <li key={l.lineId}><strong>“{l.text}”</strong> <span className="ot-muted">{fontName(l.from)} → {fontName(l.to)}</span></li>)}</ul></>}
        <p className="ot-muted">Stays the same: your other text, colours, logos, your corrections and every saved creative. {chosenFindings.length
          ? 'Afterwards, make the clean background again (the added items are then removed from it) and press Save master.'
          : 'Afterwards, press Save master below so new creatives use the updated fonts.'}</p>
      </> : <>
        <h3 id="ot-rescan-title" ref={heading} tabIndex={-1}>Start over with the new scan?</h3>
        <p>Everything the new scan found replaces the current text and logo areas. Your corrections and approvals are replaced, and you'll check each item again before saving.</p>
        <p className="ot-muted">Saved creatives stay exactly as they are.</p>
      </>}
      {error && <Alert>{error}</Alert>}
      <div className="ot-rescan-actions">
        <button type="button" className={`ws-btn ${confirm === 'replace' ? 'ws-btn-danger' : 'ws-btn-primary'}`} disabled={busy} onClick={() => void apply()}>{busy ? 'Applying…' : confirm === 'replace' ? 'Start over with the new scan' : 'Apply selected changes'}</button>
        <button type="button" className="ws-btn ws-btn-quiet" disabled={busy} onClick={() => { setConfirm(undefined); setError(''); }}><ArrowLeft size={15} aria-hidden="true" />Back</button>
      </div>
    </div>}
  </section>;
}

/** The line as it is in the original design (a crop of the uploaded poster). */
function PosterCrop({ url, size, box, label }: { url: string; size: { width: number; height: number }; box: SourceBox; label: string }) {
  // A little room around the line (capped, so very large text does not take in its neighbours).
  const pad = Math.min(box.height * 0.12, 24), x = Math.max(0, box.x - pad), y = Math.max(0, box.y - pad);
  const w = Math.min(size.width - x, box.width + pad * 2), h = Math.min(size.height - y, box.height + pad * 2), k = Math.min(48 / h, 260 / w);
  return <div className="ot-rescan-crop" role="img" aria-label={`“${label}” in your original design`}
    style={{ width: Math.round(w * k), height: Math.round(h * k), backgroundImage: `url("${url}")`, backgroundSize: `${size.width * k}px ${size.height * k}px`, backgroundPosition: `${-x * k}px ${-y * k}px` }} />;
}
/** The line drawn in a font, the way the template would show it. */
const Sample = ({ font, text }: { font: RescanFont; text: string }) =>
  <span className="ot-rescan-sample" style={{ fontFamily: `"${font.fontFamily}", sans-serif`, fontWeight: font.fontWeight, fontStyle: font.fontStyle }}>{text}</span>;
