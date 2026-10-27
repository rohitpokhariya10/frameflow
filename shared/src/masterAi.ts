import type { SourceSize } from './protectedContent.js';
import { studioFormat, type StudioJob } from './templateStudio.js';

export const MASTER_AI_COUNTS = [3, 4, 5] as const;
export type MasterAiCount = typeof MASTER_AI_COUNTS[number];
/** The master's own canvas (the size its artwork was made for), offered beside the standard formats (STUDIO_FORMATS). */
export const MASTER_AI_OWN_FORMAT = 'master';
/** Ends the stored name of a logo copy whose surrounding field was matched to its new background (the logo is unchanged). */
export const MATCHED_EDGE_NOTE = 'edge matched to its background';
export interface MasterAiRequest { count: MasterAiCount; formatId: string; guidance: string }
/** The canvas of an AI creative: the master's own size, or a standard format; undefined for an unknown format. */
export function masterAiCanvas(formatId: string, master: SourceSize): SourceSize | undefined {
  if (formatId === MASTER_AI_OWN_FORMAT) return { width: master.width, height: master.height };
  const f = studioFormat(formatId);
  return f && { width: f.width, height: f.height };
}
/** What the design request will and will not use from the saved master, checked before any cost is approved. */
export interface MasterAiReadiness {
  /** Content left out of the designs, and why (a text box never filled in, a blank picture). */
  excluded: { kind: 'text' | 'image'; label: string; reason: string }[];
  /**
   * Text the original poster has and the saved master lacks (Scan Again's reading, run read only). `inBackground`: it is
   * still part of the clean background, so designs do not use that artwork. Generating anyway needs an explicit choice.
   */
  missingText: { text: string; inBackground: boolean }[];
  /** The saved clean background was made by an older clean-up and may keep leftovers (stray marks, white patches). */
  olderCleanup: boolean;
}
export interface MasterAiEstimate {
  masterRevision: number; model: string; maxUsd: number; maxInr: number; configured: boolean;
  withinCap: boolean; note: string;
  /** Whether the designs may place the master's own artwork (enough of it is open for text and logos). */
  artwork: boolean;
  /** Who would design: the configured AI model, or the offline test provider (no charge, never real AI). */
  provider: MasterAiProvider;
  readiness: MasterAiReadiness;
}
/** Where an AI batch came from: the configured OpenAI model, or the deterministic offline test provider (never real AI). */
export type MasterAiProvider = 'openai' | 'offline-mock';
export interface MasterAiBatch {
  job: StudioJob; masterId: string; masterRevision: number; count: MasterAiCount; formatId: string; canvas: SourceSize;
  provider: MasterAiProvider;
  /** Saved options; `idea` is the AI's one-sentence description of the design. */
  creatives: { id: string; name: string; previewFile: string; idea: string | null }[];
  /** Designs the AI proposed that failed the checks: nothing was saved for them (a partial result when creatives exist). */
  skipped: { name: string | null; reason: string }[];
}
