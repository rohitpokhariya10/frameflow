/** Small presentational pieces shared by the Template Studio screens. */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, CircleDashed, LoaderCircle, XCircle } from 'lucide-react';
import type { StudioJob, StudioMoney } from '@frameflow/shared';
import { getJob } from './api';

export function StepCard({ step, title, hint, children, aside, id }: { step?: number | string; title: string; hint?: ReactNode; children: ReactNode; aside?: ReactNode; id?: string }) {
  return <section className="ts-card" aria-labelledby={id}>
    <header className="ts-card-head">
      {step !== undefined && <span className="ts-step-number" aria-hidden="true">{step}</span>}
      <div className="ts-card-title"><h3 id={id}>{title}</h3>{hint && <p>{hint}</p>}</div>
      {aside && <div className="ts-card-aside">{aside}</div>}
    </header>
    <div className="ts-card-body">{children}</div>
  </section>;
}

export function PageHeading({ kicker, title, children, actions }: { kicker: string; title: string; children?: ReactNode; actions?: ReactNode }) {
  return <div className="ts-page-heading"><div><p className="ts-kicker">{kicker}</p><h2>{title}</h2>{children && <p className="ts-lead">{children}</p>}</div>{actions && <div className="ts-heading-actions">{actions}</div>}</div>;
}

export type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'accent';
export const Badge = ({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) => <span className={`ts-badge ts-badge-${tone}`}>{children}</span>;

export function Field({ label, hint, children, htmlFor }: { label: string; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return <div className="ts-field"><label htmlFor={htmlFor}>{label}</label>{children}{hint && <small>{hint}</small>}</div>;
}

export const Alert = ({ tone = 'danger', children }: { tone?: 'danger' | 'warn' | 'info' | 'ok'; children: ReactNode }) =>
  <div className={`ts-alert ts-alert-${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>{tone === 'danger' ? <XCircle size={16} aria-hidden="true" /> : tone === 'warn' ? <AlertTriangle size={16} aria-hidden="true" /> : <CheckCircle2 size={16} aria-hidden="true" />}<div>{children}</div></div>;

export const Empty = ({ icon, title, children, action }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) =>
  <div className="ts-empty">{icon}<h3>{title}</h3>{children && <p>{children}</p>}{action}</div>;

/** Rupees first (the client's currency), dollars beside them: the provider's own unit. */
export const Money = ({ value, prefix }: { value: StudioMoney; prefix?: string }) => <span className="ts-money">{prefix}{value.inr} <small>{value.usd}</small></span>;

export function Spinner({ label }: { label: string }) { return <span className="ts-spinner" role="status"><LoaderCircle size={16} className="ws-spin" aria-hidden="true" />{label}</span>; }

const STATUS_ICON = { running: LoaderCircle, done: CheckCircle2, failed: XCircle, outcome_unknown: AlertTriangle, waiting: CircleDashed, skipped: CircleDashed } as const;
const EXPECTED: Record<string, string[]> = {
  analyse_template: ['Studying the reference posters'],
  generate_poster: ['Looking at your products', 'Art direction', 'Generating the image', 'Adding text and logo', 'Quality review'],
  review_poster: ['Quality review'],
  make_cutout: ['Finding the product (SAM-3 mask)'],
};

/** Polls a job until it ends; onDone runs once at the end (also when the job had already ended). */
export function useJob(jobId: string | null | undefined, onDone?: (job: StudioJob) => void, refresh = 0) {
  const [job, setJob] = useState<StudioJob | null>(null), [error, setError] = useState('');
  const done = useRef(onDone);
  useEffect(() => { done.current = onDone; }, [onDone]);
  useEffect(() => {
    if (!jobId) return;
    let alive = true, timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const next = await getJob(jobId);
        if (!alive) return;
        setJob(next); setError('');
        if (next.terminal) { done.current?.(next); return; }
      } catch (e) { if (alive) setError(e instanceof Error ? e.message : 'Lost track of the job.'); }
      timer = setTimeout(() => void tick(), 1200);
    };
    void tick();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [jobId, refresh]);
  return { job: job?.id === jobId ? job : null, error };
}

/** A job's steps as they run: what is happening now, never an invented spend (cost appears once recorded). */
export function JobSteps({ job }: { job: StudioJob }) {
  const expected = EXPECTED[job.kind] ?? [];
  const seen = new Map(job.stages.map(s => [s.label, s]));
  const labels = [...expected, ...job.stages.map(s => s.label).filter(l => !expected.includes(l))];
  return <ol className="ts-steps">
    {labels.map(label => {
      const s = seen.get(label), status = s?.status ?? (job.terminal ? 'skipped' : 'waiting');
      const Icon = STATUS_ICON[status as keyof typeof STATUS_ICON] ?? CircleDashed;
      return <li key={label} className={`ts-step is-${status}`}>
        <Icon size={17} className={status === 'running' ? 'ws-spin' : undefined} aria-hidden="true" />
        <span>{label}</span>
        <small>{status === 'running' ? (s?.paid ? 'in progress · paid call' : 'in progress') : status === 'done' && s?.durationMs != null ? `${(s.durationMs / 1000).toFixed(1)} s` : status === 'outcome_unknown' ? 'outcome unknown (may be billed; not repeated)' : status === 'failed' ? 'failed' : status === 'skipped' ? 'not run' : 'waiting'}</small>
      </li>;
    })}
  </ol>;
}

export const fmtDate = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
