/**
 * A variation as it will open in the editor, drawn with HTML for comparison: its artwork, each logo slot's picture at its
 * variant box and each word in its variant style at its baseline. The words are text set by the browser, never pixels
 * from the image model. Positions and sizes are fractions of the canvas, so any preview size shows the same layout.
 */
import { useMemo, type CSSProperties } from 'react';
import { catalogFont, fontStack, validateLayout, type ProtectedTemplateView, type StyleVariationView } from '@frameflow/shared';
import { useFonts } from '../fonts/useFonts';
import { protectedFileUrl } from './api';

export function VariationPreview({ template: t, variation: v, label }: { template: ProtectedTemplateView; variation: StyleVariationView; label: string }) {
  const { width: W, height: H } = v.layout.canvas, slots = new Map((t.textAnalysis?.logoSlots ?? []).map(l => [l.id, l]));
  const fonts = useFonts(v.layout.words.map(w => ({ family: w.style.fontFamily, weight: w.style.fontWeight, text: w.text, italic: w.style.fontStyle === 'italic' })));
  const overflow = useMemo(() => {
    void fonts.revision;
    const context = document.createElement('canvas').getContext('2d');
    if (!context || !t.textAnalysis) return [];
    return validateLayout(v.layout, { analysis: t.textAnalysis, measure: (text, style) => {
      const italic = style.fontStyle === 'italic' && catalogFont(style.fontFamily)?.italic;
      context.font = `${italic ? 'italic ' : ''}${style.fontWeight} ${style.fontSize}px ${fontStack(style.fontFamily)}`;
      return context.measureText(text).width + Math.max(0, [...text].length - 1) * style.letterSpacing;
    } }).issues.filter(issue => issue.code === 'OVERFLOW');
  }, [v.layout, t.textAnalysis, fonts.revision]);
  const box = (b: { x: number; y: number; width: number; height: number; rotation: number }): CSSProperties => ({ left: `${(b.x / W) * 100}%`, top: `${(b.y / H) * 100}%`, width: `${(b.width / W) * 100}%`, height: `${(b.height / H) * 100}%`, transform: b.rotation ? `rotate(${b.rotation}deg)` : undefined });
  return <><figure className="sv-preview" style={{ aspectRatio: `${W} / ${H}` }} aria-label={label} data-fonts={fonts.revision}>
    {v.artwork ? <img className="sv-artwork" src={v.artwork.url} alt="" /> : <div className="sv-artwork sv-artwork-empty" aria-hidden="true" />}
    {v.layout.logos.filter(l => !l.hidden).map(l => { const slot = slots.get(l.slotId); if (!slot) return null;
      const file = l.asset === 'replacement' && slot.replacement ? slot.replacement.file : slot.original.file;
      return <img key={l.slotId} className="sv-slot" style={box(l.box)} src={protectedFileUrl(t.id, file)} alt="" />; })}
    {v.layout.words.filter(w => !w.hidden).map(w => <span key={w.wordId} className="sv-text" data-word={w.wordId}
      style={{ left: `${(w.box.x / W) * 100}%`, top: `${((w.box.y + w.style.baseline - w.style.fontSize * 0.8) / H) * 100}%`, fontSize: `${(w.style.fontSize / W) * 100}cqw`,
        fontFamily: fontStack(w.style.fontFamily), fontWeight: w.style.fontWeight, fontStyle: w.style.fontStyle === 'italic' && catalogFont(w.style.fontFamily)?.italic ? 'italic' : 'normal',
        color: w.style.color, opacity: w.style.opacity, letterSpacing: `${(w.style.letterSpacing / W) * 100}cqw`, transform: w.box.rotation ? `rotate(${w.box.rotation}deg)` : undefined }}>{w.text}</span>)}
  </figure>
    {fonts.failed && <p className="ts-hint" role="status">Some fonts are unavailable. The preview uses fallback fonts; your font choices are kept.</p>}
    {overflow.length > 0 && <details className="ts-hint" data-testid="measured-text-overflow">
      <summary>{overflow.length} word(s) exceed their boxes in the browser font. Adjust typography in the editor.</summary>
      <ul>{overflow.map(issue => <li key={issue.ids.join(':')}>{issue.message}</li>)}</ul>
    </details>}
  </>;
}
