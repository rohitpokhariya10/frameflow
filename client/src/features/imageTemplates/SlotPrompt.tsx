import type { PromptSegment } from '@frameflow/shared';

/**
 * A prompt with its dynamic parts marked: each part that comes from a field is a button that leads to that field; the
 * rest are locked rules, plain text the form cannot change.
 */
export function SlotPrompt({ segments, linked, onLink, onPick, label, sentences = false, controlsId }: { segments: PromptSegment[]; linked: string; onLink: (slotId: string) => void; onPick: (slotId: string) => void; label: string; sentences?: boolean; controlsId: (slotId: string) => string }) {
  return <p className="tw-slot-prompt" aria-label={label}>{segments.map((segment, index) => segment.kind === 'slot' && segment.slotId
    // Field names are buttons; whole compiled sentences are marked text (the "What will change" list is their keyboard path).
    ? sentences ? <mark key={index} className={`tw-slot-text${linked === segment.slotId ? ' is-linked' : ''}`} title={segment.label} onClick={() => onPick(segment.slotId!)} onMouseEnter={() => onLink(segment.slotId!)} onMouseLeave={() => onLink('')}>{segment.text}</mark>
      : <button type="button" key={index} className={`tw-slot-chip${linked === segment.slotId ? ' is-linked' : ''}`} aria-controls={controlsId(segment.slotId)} title={`Edit ${segment.label}`}
        onClick={() => onPick(segment.slotId!)} onMouseEnter={() => onLink(segment.slotId!)} onMouseLeave={() => onLink('')} onFocus={() => onLink(segment.slotId!)} onBlur={() => onLink('')}>{segment.text}</button>
    : <span key={index} className="tw-locked">{segment.text} </span>)}</p>;
}
