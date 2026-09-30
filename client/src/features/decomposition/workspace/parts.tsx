import { Check, Image as ImageIcon, Type, Square, Mountain, HelpCircle } from 'lucide-react';
import type { DecompositionBox, DecompositionJobSummary } from '@frameflow/shared';
import { artifactUrl } from '../api';
import { STEPPER, type FriendlyType } from '../flow';
import { InspectionViewer } from '../InspectionViewer';

export function Stepper({ current }: { current: number }) {
  return <ol className="ws-stepper" aria-label="Progress">
    {STEPPER.map((step, i) => <li key={step.key} className={i < current ? 'is-done' : i === current ? 'is-current' : ''} aria-current={i === current ? 'step' : undefined}>
      <span className="ws-step-dot" aria-hidden="true">{i < current ? <Check size={12} strokeWidth={3} /> : i + 1}</span><span>{step.label}</span>
    </li>)}
  </ol>;
}

/** A thumbnail cropped to a region of a larger image (e.g. one element on a full-size transparent layer). */
export function Thumb({ artifactId, region, width, height, size = 44, alt = '' }: { artifactId?: string; region?: DecompositionBox | null; width?: number; height?: number; size?: number; alt?: string }) {
  if (!artifactId) return <span className="ws-thumb ws-thumb-empty" style={{ width: size, height: size }} aria-hidden="true" />;
  if (!region || !width || !height || region.width <= 0 || region.height <= 0) return <img className="ws-thumb" src={artifactUrl(artifactId)} alt={alt} style={{ width: size, height: size }} loading="lazy" />;
  const scale = size / Math.max(region.width, region.height);
  return <span className="ws-thumb" role={alt ? 'img' : undefined} aria-label={alt || undefined} style={{ width: size, height: size,
    backgroundImage: `url("${artifactUrl(artifactId)}")`, backgroundSize: `${width * scale}px ${height * scale}px`,
    backgroundPosition: `${-region.x * scale + (size - region.width * scale) / 2}px ${-region.y * scale + (size - region.height * scale) / 2}px` }} />;
}

const TYPE_ICON: Record<FriendlyType, React.ReactNode> = { Image: <ImageIcon size={12} />, Text: <Type size={12} />, Shape: <Square size={12} />, Background: <Mountain size={12} />, 'Choose type': <HelpCircle size={12} /> };
export function TypeChip({ type, suggested = false }: { type: FriendlyType; suggested?: boolean }) {
  return <span className={`ws-chip ws-chip-${type === 'Choose type' ? 'warn' : type.toLowerCase()}`} title={suggested ? 'Suggested by AI — you can change it' : undefined}>{TYPE_ICON[type]}{type}</span>;
}

/** Everything technical lives here, collapsed by default. */
export function DeveloperDetails({ job }: { job: DecompositionJobSummary }) {
  return <details className="ws-dev">
    <summary>Developer details</summary>
    <div className="ws-dev-body">
      <dl>
        <dt>Job</dt><dd>{job.id}</dd><dt>State</dt><dd>{job.state} · phase {job.phase} · revision {job.revision}</dd><dt>Provider calls</dt><dd>{job.callsUsed}</dd>
        {job.review && <><dt>Review gate</dt><dd>{job.review.gate ?? 'none'} · {job.review.code}: {job.review.message}</dd></>}
        {job.error && <><dt>Error</dt><dd>{job.error.code}: {job.error.message}</dd></>}
        {job.retry && <><dt>Retry</dt><dd>{job.retry.available ? 'available' : `unavailable (${job.retry.reason})`} · attempt {job.retry.attempt}/{job.retry.limit}</dd></>}
        {job.warnings.length > 0 && <><dt>Warnings</dt><dd>{job.warnings.join(', ')}</dd></>}
        {job.discovery && <><dt>Discovery</dt><dd>{job.discovery.provider} ({job.discovery.providerModel}) · request {job.discovery.providerRequestId ?? 'n/a'}{job.discovery.fallbackFrom ? ` · fallback from ${job.discovery.fallbackFrom}` : ''}</dd></>}
      </dl>
      {job.proposals?.length ? <details><summary>Discovered proposals</summary><pre>{JSON.stringify(job.proposals.map(p => ({ id: p.id, label: p.label, provider: p.provider, zIndex: p.zIndex, registration: p.sourceRegistration, bounds: p.bounds, providerBbox: p.providerBbox, warnings: p.warnings, metadataWarnings: p.metadataWarnings })), null, 2)}</pre></details> : null}
      {job.proposalTargets?.length ? <details><summary>Review targets</summary><pre>{JSON.stringify(job.proposalTargets.map(t => ({ id: t.id, label: t.label, role: t.role, classification: t.classification, provenance: t.provenance, proposalIds: t.proposalIds, revision: t.provisionalMaskRevision })), null, 2)}</pre></details> : null}
      {job.candidates?.length ? <details><summary>Segmentation (SAM 3.1) and quality checks</summary><pre>{JSON.stringify(job.candidates.map(c => ({ id: c.id, label: c.label, tier: c.qualityTier, checks: c.qualityChecks, revision: c.revisionId, warnings: c.warnings })), null, 2)}</pre></details> : null}
      {job.refined?.length ? <details><summary>Alpha (BiRefNet) revisions</summary><pre>{JSON.stringify(job.refined, null, 2)}</pre></details> : null}
      {job.sceneGraph ? <details><summary>Scene graph</summary><pre>{JSON.stringify({ ...job.sceneGraph, layers: job.sceneGraph.layers.map(l => ({ id: l.id, type: l.type, name: l.name, bbox: l.bbox, zIndex: l.zIndex })) }, null, 2)}</pre></details> : null}
      <InspectionViewer job={job} />
    </div>
  </details>;
}

/** A small non-blocking confirmation of the last action. */
export function Toast({ message }: { message: string }) {
  return <div className="ws-toast" role="status" aria-live="polite">{message ? <><Check size={14} />{message}</> : null}</div>;
}
