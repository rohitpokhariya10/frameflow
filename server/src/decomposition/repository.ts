import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { DecompositionArtifactRef, DecompositionClientContext, DecompositionJobSummary, DecompositionManifest, DecompositionOptions, DecompositionReview, DecompositionReviewRequest, DecompositionState } from '@frameflow/shared';
import { DecompositionError } from './errors.js';
export interface ArtifactRecord extends DecompositionArtifactRef { ownerId: string; jobId?: string; storageKey: string; kind: string; createdAt: number; retentionState: 'active' | 'pinned' | 'deleted' }
export interface SourceAsset { id: string; ownerId: string; originalArtifactId: string; masterArtifactId: string; originalSha256: string; workingMasterSha256: string; width: number; height: number; mimeType: string; orientationNormalized: boolean; hasAlpha: boolean; metadata: Record<string, unknown>; createdAt: number }
export interface JobRecord {
  id: string; ownerId: string; sourceId: string; state: DecompositionState; revision: number; phase: number; options: DecompositionOptions; optionsHash: string; idempotencyKey: string;
  data: Record<string, unknown>; warnings: string[]; review?: DecompositionReviewRequest; manifest?: DecompositionManifest; error?: { code: string; message: string; retryable: boolean }; progress: string; context?: DecompositionClientContext;
  callsUsed: number; deadlineAt: number; createdAt: number; updatedAt: number; expiresAt: number; cancelRequested: boolean; tombstonedAt?: number; leaseOwner?: string; leaseUntil: number; fence: number; reviewStartedAt?: number;
}
export interface Lease { workerId: string; fence: number; revision: number }
export interface StepRecord { id: string; jobId: string; phase: number; objectId: string; inputHash: string; attempt: number; status: 'running' | 'completed' | 'failed' | 'skipped'; outputArtifactIds: string[]; leaseOwner?: string; leaseUntil: number; fence: number; createdAt: number; updatedAt: number }
export interface ProviderRequestRecord {
  id: string; jobId: string; stepId: string; endpoint: string; inputHash: string; adapterVersion: string; seed?: number; sentSeed?: number; returnedSeed?: number;
  status: 'SUBMITTING' | 'SUBMISSION_UNKNOWN' | 'QUEUED' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'CANCELLED'; providerRequestId?: string;
  output?: unknown; nextPollAt: number; attempts: number; createdAt: number; updatedAt: number; diagnostic?: string;
}
export interface JobEvent { sequence: number; jobId: string; revision: number; phase: number; event: string; message: string; code?: string; createdAt: number }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const terminal = new Set<DecompositionState>(['completed','partial','failed','cancelled']);
function decode<T>(row: unknown): T | undefined { return row ? JSON.parse((row as { json: string }).json) as T : undefined; }
/** All mutation transactions are synchronous; no transaction spans provider/image IO. */
/** Mirrors retryJob's rules exactly (single explicit retry, call budget, retryable states) so the UI never offers a retry the server will refuse. */
export function retryAvailability(job: JobRecord): NonNullable<DecompositionJobSummary['retry']> {
  const attempt = Number(job.data.attempt ?? 0), limit = 1;
  if (attempt >= limit) return { available: false, reason: 'RETRY_LIMIT', attempt, limit };
  if (job.callsUsed >= job.options.maxCalls) return { available: false, reason: 'CALL_BUDGET', attempt, limit };
  if (!['failed', 'needs_review', 'partial'].includes(job.state)) return { available: false, reason: 'NOT_RETRYABLE_STATE', attempt, limit };
  return { available: true, attempt, limit };
}
export class DecompositionRepository {
  readonly db: Database.Database;
  constructor(readonly dataDir: string) {
    mkdirSync(dataDir,{recursive:true,mode:0o700}); this.db = new Database(resolve(dataDir,'decomposition.sqlite'));
    this.db.pragma('journal_mode = WAL'); this.db.pragma('foreign_keys = ON'); this.db.pragma('busy_timeout = 5000'); this.migrate();
    this.db.prepare('INSERT OR IGNORE INTO owners(id, created_at) VALUES (?,?)').run('operator',Date.now());
  }
  private migrate() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);`);
    if (this.db.prepare('SELECT version FROM schema_migrations WHERE version=1').get()) return;
    this.db.transaction(() => {
      this.db.exec(`
      CREATE TABLE owners(id TEXT PRIMARY KEY,created_at INTEGER NOT NULL);
      CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES owners(id),expires_at INTEGER NOT NULL,revoked_at INTEGER);
      CREATE TABLE source_assets(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES owners(id),created_at INTEGER NOT NULL,json TEXT NOT NULL);
      CREATE TABLE decomposition_jobs(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES owners(id),source_id TEXT NOT NULL REFERENCES source_assets(id),idempotency_key TEXT NOT NULL,options_hash TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL,phase INTEGER NOT NULL,lease_owner TEXT,lease_until INTEGER NOT NULL DEFAULT 0,fence INTEGER NOT NULL DEFAULT 0,tombstoned_at INTEGER,json TEXT NOT NULL,UNIQUE(owner_id,idempotency_key));
      CREATE INDEX jobs_due ON decomposition_jobs(state,lease_until);
      CREATE TABLE decomposition_steps(id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES decomposition_jobs(id),phase INTEGER NOT NULL,object_id TEXT NOT NULL,input_hash TEXT NOT NULL,attempt INTEGER NOT NULL,json TEXT NOT NULL,UNIQUE(job_id,phase,object_id,input_hash,attempt));
      CREATE TABLE provider_requests(id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES decomposition_jobs(id),step_id TEXT NOT NULL,input_hash TEXT NOT NULL,status TEXT NOT NULL,json TEXT NOT NULL,UNIQUE(step_id,input_hash));
      CREATE TABLE artifacts(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES owners(id),job_id TEXT REFERENCES decomposition_jobs(id),storage_key TEXT NOT NULL UNIQUE,bytes INTEGER NOT NULL,retention_state TEXT NOT NULL,json TEXT NOT NULL);
      CREATE TABLE job_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT NOT NULL REFERENCES decomposition_jobs(id),revision INTEGER NOT NULL,phase INTEGER NOT NULL,event TEXT NOT NULL,message TEXT NOT NULL,code TEXT,created_at INTEGER NOT NULL);
      CREATE TABLE worker_heartbeats(id TEXT PRIMARY KEY,updated_at INTEGER NOT NULL);
      CREATE TABLE account_budget(id INTEGER PRIMARY KEY CHECK(id=1),calls_used INTEGER NOT NULL);
      INSERT INTO account_budget VALUES(1,0);`);
      this.db.prepare('INSERT INTO schema_migrations VALUES(1,?)').run(Date.now());
    })();
  }
  close() { this.db.close(); }
  async backup(destination: string) { await this.db.backup(destination); }
  createOwner(id: string) { this.db.prepare('INSERT OR IGNORE INTO owners VALUES(?,?)').run(id,Date.now()); }
  createSession(tokenHash: string, ownerId: string, expiresAt: number) { this.db.prepare('INSERT INTO sessions VALUES(?,?,?,NULL)').run(tokenHash,ownerId,expiresAt); }
  sessionOwner(tokenHash: string) { const row = this.db.prepare('SELECT owner_id FROM sessions WHERE token_hash=? AND expires_at>? AND revoked_at IS NULL').get(tokenHash,Date.now()) as {owner_id:string}|undefined; return row?.owner_id; }
  revokeSession(tokenHash: string) { this.db.prepare('UPDATE sessions SET revoked_at=? WHERE token_hash=?').run(Date.now(),tokenHash); }
  addSource(source: SourceAsset) { this.db.prepare('INSERT INTO source_assets VALUES(?,?,?,?)').run(source.id,source.ownerId,source.createdAt,JSON.stringify(source)); return source; }
  getSource(id: string, ownerId?: string) { const source = decode<SourceAsset>(this.db.prepare('SELECT json FROM source_assets WHERE id=?').get(id)); return source && (!ownerId || source.ownerId === ownerId) ? source : undefined; }
  addArtifact(artifact: ArtifactRecord, maxJobBytes = 512*1024*1024) {
    return this.db.transaction(() => {
      if (artifact.jobId) { const job = this.getJob(artifact.jobId); if (!job || job.ownerId !== artifact.ownerId || job.tombstonedAt || job.cancelRequested) throw new DecompositionError('JOB_CANCELLED','This job no longer accepts artifacts.',409); if (this.artifactBytes(artifact.jobId) + artifact.bytes > maxJobBytes) throw new DecompositionError('DISK_QUOTA','Job artifact storage limit reached.',507); }
      this.db.prepare('INSERT INTO artifacts VALUES(?,?,?,?,?,?,?)').run(artifact.artifactId,artifact.ownerId,artifact.jobId ?? null,artifact.storageKey,artifact.bytes,artifact.retentionState,JSON.stringify(artifact)); return artifact;
    })();
  }
  getArtifact(id: string, ownerId?: string) { const a = decode<ArtifactRecord>(this.db.prepare("SELECT json FROM artifacts WHERE id=? AND retention_state!='deleted'").get(id)); if (!a || (ownerId && a.ownerId !== ownerId)) return; if (a.jobId && this.getJob(a.jobId)?.tombstonedAt) return; return a; }
  listArtifacts(jobId: string) { return (this.db.prepare("SELECT json FROM artifacts WHERE job_id=? AND retention_state!='deleted'").all(jobId)).map((row) => decode<ArtifactRecord>(row)!); }
  artifactBytes(jobId: string) { return (this.db.prepare("SELECT COALESCE(SUM(bytes),0) AS total FROM artifacts WHERE job_id=? AND retention_state!='deleted'").get(jobId) as {total:number}).total; }
  markArtifactDeleted(id: string) { this.db.prepare("UPDATE artifacts SET retention_state='deleted' WHERE id=?").run(id); }
  createJob(ownerId: string, sourceId: string, options: DecompositionOptions, idempotencyKey: string, context?: DecompositionClientContext, limits: {timeoutMs?:number;retentionDays?:number;maxQueue?:number} = {}) {
    return this.db.transaction(() => {
      const optionsHash = hash({sourceId,options,context}); const existing = decode<JobRecord>(this.db.prepare('SELECT json FROM decomposition_jobs WHERE owner_id=? AND idempotency_key=?').get(ownerId,idempotencyKey));
      if (existing) { if (existing.optionsHash !== optionsHash) throw new DecompositionError('IDEMPOTENCY_CONFLICT','This idempotency key belongs to different input.',409); return existing; }
      if (!this.getSource(sourceId,ownerId)) throw new DecompositionError('SOURCE_NOT_FOUND','Source image not found.',404);
      const queued = (this.db.prepare("SELECT COUNT(*) AS n FROM decomposition_jobs WHERE state IN ('queued','running','needs_review') AND tombstoned_at IS NULL").get() as {n:number}).n;
      if (queued >= (limits.maxQueue ?? 20)) throw new DecompositionError('QUEUE_FULL','The decomposition queue is full. Finish or delete an existing job.',429,true);
      const now = Date.now(); const job: JobRecord = { id:randomUUID(),ownerId,sourceId,state:'queued',revision:1,phase:0,options,optionsHash,idempotencyKey,data:{},warnings:[],progress:'Queued',context,callsUsed:0,deadlineAt:now+(limits.timeoutMs ?? 1200000),createdAt:now,updatedAt:now,expiresAt:now+(limits.retentionDays ?? 7)*86400000,cancelRequested:false,leaseUntil:0,fence:0 };
      this.db.prepare('INSERT INTO decomposition_jobs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(job.id,ownerId,sourceId,idempotencyKey,optionsHash,job.state,job.revision,0,null,0,0,null,JSON.stringify(job));
      this.event(job,'queued','Queued for decomposition'); return job;
    })();
  }
  getJob(id: string, ownerId?: string) { const job = decode<JobRecord>(this.db.prepare('SELECT json FROM decomposition_jobs WHERE id=?').get(id)); return job && (!ownerId || job.ownerId === ownerId) ? job : undefined; }
  listJobs(ownerId: string) { return this.db.prepare('SELECT json FROM decomposition_jobs WHERE owner_id=? AND tombstoned_at IS NULL ORDER BY rowid DESC LIMIT 100').all(ownerId).map((row) => decode<JobRecord>(row)!); }
  /** Completed Qwen outputs only; never reuse another owner's, expired, mock, or tombstoned work. */
  findReusableQwen(ownerId: string, fingerprint: string, currentJobId: string): JobRecord | undefined {
    return decode<JobRecord>(this.db.prepare(`SELECT json FROM decomposition_jobs
      WHERE owner_id=? AND id!=? AND tombstoned_at IS NULL
      AND json_extract(json,'$.expiresAt')>?
      AND json_extract(json,'$.data.verificationMode')='live'
      AND json_extract(json,'$.data.qwenInference.qwen.requestFingerprint')=?
      AND json_extract(json,'$.data.qwenInference.qwen.sentSeed')=json_extract(json,'$.data.qwenInference.qwen.returnedSeed')
      ORDER BY rowid DESC LIMIT 1`).get(ownerId, currentJobId, Date.now(), fingerprint));
  }
  /** Completed Seedream discovery only. The endpoint has no seed, so reuse is keyed purely on the exact request fingerprint. */
  findReusableSeedream(ownerId: string, fingerprint: string, currentJobId: string): JobRecord | undefined {
    return decode<JobRecord>(this.db.prepare(`SELECT json FROM decomposition_jobs
      WHERE owner_id=? AND id!=? AND tombstoned_at IS NULL
      AND json_extract(json,'$.expiresAt')>?
      AND json_extract(json,'$.data.verificationMode')='live'
      AND json_extract(json,'$.data.seedreamInference.seedream.requestFingerprint')=?
      ORDER BY rowid DESC LIMIT 1`).get(ownerId, currentJobId, Date.now(), fingerprint));
  }
  private persist(job: JobRecord) { this.db.prepare('UPDATE decomposition_jobs SET state=?,revision=?,phase=?,lease_owner=?,lease_until=?,fence=?,tombstoned_at=?,json=? WHERE id=?').run(job.state,job.revision,job.phase,job.leaseOwner ?? null,job.leaseUntil,job.fence,job.tombstonedAt ?? null,JSON.stringify(job),job.id); }
  updateJob(job: JobRecord, lease?: Lease) {
    return this.db.transaction(() => {
      const current = this.getJob(job.id); if (!current || current.tombstonedAt || (current.cancelRequested && job.state !== 'cancelled' && job.state !== 'cancel_requested')) throw new DecompositionError('JOB_CANCELLED','Job cancelled or deleted.',409);
      if (lease && (current.leaseOwner !== lease.workerId || current.fence !== lease.fence || current.revision !== lease.revision || current.leaseUntil <= Date.now())) throw new DecompositionError('STALE_LEASE','Worker lease or job revision is stale.',409);
      if (!lease && current.revision !== job.revision) throw new DecompositionError('STALE_REVISION','Reload the latest job revision.',409);
      const next = {...job,callsUsed:current.callsUsed,leaseUntil:current.leaseUntil,revision:current.revision+1,updatedAt:Date.now()};
      if (next.state === 'needs_review' && current.state !== 'needs_review') next.reviewStartedAt = Date.now();
      if (next.state === 'needs_review' || terminal.has(next.state)) { next.leaseOwner = undefined; next.leaseUntil = 0; }
      this.persist(next); this.event(next,'checkpoint',next.progress,next.error?.code); return next;
    })();
  }
  /** A worker only claims jobs created for its provider mode, so a stray mock/live worker cannot fail the other mode's jobs. */
  claimJob(workerId: string, leaseMs = 60000, providerMode?: 'mock' | 'live'): JobRecord | undefined {
    return this.db.transaction(() => {
      const now = Date.now(); const active = this.db.prepare("SELECT id FROM decomposition_jobs WHERE state IN ('running','cancel_requested') AND lease_until>? AND tombstoned_at IS NULL").get(now); if(active)return; const current = decode<JobRecord>(this.db.prepare("SELECT json FROM decomposition_jobs WHERE state IN ('queued','running','cancel_requested') AND lease_until<=? AND tombstoned_at IS NULL AND (? IS NULL OR COALESCE(json_extract(json,'$.data.verificationMode'),'live')=?) ORDER BY rowid LIMIT 1").get(now, providerMode ?? null, providerMode ?? null)); if (!current) return;
      const job: JobRecord = {...current,state:current.cancelRequested?'cancel_requested':'running',leaseOwner:workerId,leaseUntil:now+leaseMs,fence:current.fence+1,updatedAt:now}; this.persist(job); return job;
    })();
  }
  heartbeat(jobId: string, workerId: string, fence: number, leaseMs = 60000) { return this.db.transaction(() => { const job = this.getJob(jobId); if (!job || job.tombstonedAt || job.leaseOwner !== workerId || job.fence !== fence || job.leaseUntil <= Date.now()) return false; job.leaseUntil = Date.now()+leaseMs; this.persist(job); this.workerHeartbeat(workerId); return true; })(); }
  releaseJob(jobId: string, workerId: string, fence: number) { const job = this.getJob(jobId); if (job && job.leaseOwner === workerId && job.fence === fence) {job.leaseUntil=0;job.leaseOwner=undefined;this.persist(job);} }
  cancelJob(id: string, ownerId: string) { return this.db.transaction(() => { const job = this.requireOwnedJob(id,ownerId); if (terminal.has(job.state)) return job; job.cancelRequested=true;job.state='cancel_requested';job.revision++;job.updatedAt=Date.now();this.persist(job);this.event(job,'cancel_requested','Cancellation requested; existing inference may still be charged.');return job; })(); }
  reviewJob(id: string, ownerId: string, correction: DecompositionReview) {
    return this.db.transaction(() => { const job = this.requireOwnedJob(id,ownerId); if (job.state !== 'needs_review' || job.revision !== correction.expectedRevision) throw new DecompositionError('STALE_REVISION','Review changed. Reload the latest masks before applying corrections.',409);
      if (job.data.reviewWorkflow === 2 && !job.review?.actions.includes(correction.action)) throw new DecompositionError('REVIEW_ACTION_NOT_ALLOWED','This action is not allowed at the current review gate.',409);
      job.data.reviewSubmission=correction; job.data.reviewRevision=job.revision+1; job.phase = ['save-proposals','approve-proposals'].includes(correction.action) ? 3 : correction.action === 'approve-result' ? 4 : correction.action === 'approve-generation' ? 7 : correction.action === 'accept-visible-only' ? Math.min(job.phase,5) : Math.min(job.phase,4);
      if (correction.action === 'accept-visible-only') { job.options.completeHiddenObjects=false; job.options.reconstructBackground=false;job.warnings.push('User accepted visible-only output.'); }
      job.deadlineAt += Date.now() - (job.reviewStartedAt ?? Date.now());job.reviewStartedAt=undefined;job.review=undefined;job.manifest=undefined;job.error=undefined;job.state='queued';job.progress='Review saved; queued to resume';job.revision++;job.fence++;job.leaseOwner=undefined;job.leaseUntil=0;job.updatedAt=Date.now();this.persist(job);this.event(job,'review_saved',job.progress);return job;
    })();
  }
  retryJob(id: string, ownerId: string, expectedRevision: number, reconcile?: {requestId: string;providerRequestId?:string;allowNewAttempt?:boolean}) {
    return this.db.transaction(() => {const job=this.requireOwnedJob(id,ownerId);if(job.revision!==expectedRevision || !['failed','needs_review','partial'].includes(job.state))throw new DecompositionError('STALE_REVISION','Only the current failed/review/partial job can be retried.',409);if(Number(job.data.attempt??0)>=1)throw new DecompositionError('RETRY_LIMIT','The explicit retry limit was reached. Preserve current assets or start a new reviewed job.',409);if(job.callsUsed>=job.options.maxCalls)throw new DecompositionError('CALL_BUDGET','The job call budget is exhausted.',409);
      if(reconcile){ const request=decode<ProviderRequestRecord>(this.db.prepare('SELECT json FROM provider_requests WHERE id=? AND job_id=?').get(reconcile.requestId,id));if(!request||request.status!=='SUBMISSION_UNKNOWN')throw new DecompositionError('INVALID_RECONCILIATION','Unknown ambiguous request.',409);if(reconcile.providerRequestId){request.providerRequestId=reconcile.providerRequestId;request.status='QUEUED';this.writeProvider(request);}else if(reconcile.allowNewAttempt){this.db.prepare('UPDATE provider_requests SET step_id=? WHERE id=?').run(`${request.stepId}:reconciled:${request.id}`,request.id);}else throw new DecompositionError('INVALID_RECONCILIATION','Supply the accepted provider request ID or explicitly authorize a new attempt.');}
      job.data.attempt=Number(job.data.attempt??0)+1;job.state='queued';job.error=undefined;job.review=undefined;job.manifest=undefined;job.revision++;job.fence++;job.deadlineAt=Date.now()+1200000;job.leaseOwner=undefined;job.leaseUntil=0;job.progress='Retry queued';this.persist(job);this.event(job,'retry',job.progress);return job;})();
  }
  deleteJob(id: string, ownerId: string) {return this.db.transaction(()=>{const job=this.requireOwnedJob(id,ownerId);job.tombstonedAt=Date.now();job.cancelRequested=true;job.state='cancel_requested';job.revision++;job.fence++;job.leaseUntil=0;job.leaseOwner=undefined;this.persist(job);this.event(job,'deleted','Job deleted; late publication blocked.');return job;})();}
  requireOwnedJob(id: string, ownerId: string) {const job=this.getJob(id,ownerId);if(!job||job.tombstonedAt)throw new DecompositionError('JOB_NOT_FOUND','Job not found.',404);return job;}
  event(job: JobRecord, event: string, message: string, code?: string) {this.db.prepare('INSERT INTO job_events(job_id,revision,phase,event,message,code,created_at) VALUES(?,?,?,?,?,?,?)').run(job.id,job.revision,job.phase,event,message.slice(0,1000),code??null,Date.now());}
  events(jobId: string, after=0): JobEvent[] {return (this.db.prepare('SELECT * FROM job_events WHERE job_id=? AND sequence>? ORDER BY sequence LIMIT 200').all(jobId,after) as {sequence:number;job_id:string;revision:number;phase:number;event:string;message:string;code?:string;created_at:number}[]).map((r)=>({sequence:r.sequence,jobId:r.job_id,revision:r.revision,phase:r.phase,event:r.event,message:r.message,code:r.code,createdAt:r.created_at}));}
  createStep(job: JobRecord, phase: number, inputHash: string, objectId='',attempt=1): StepRecord {const existing=decode<StepRecord>(this.db.prepare('SELECT json FROM decomposition_steps WHERE job_id=? AND phase=? AND object_id=? AND input_hash=? AND attempt=?').get(job.id,phase,objectId,inputHash,attempt));if(existing){if(existing.status==='running'){existing.leaseOwner=job.leaseOwner;existing.leaseUntil=job.leaseUntil;existing.fence=job.fence;this.db.prepare('UPDATE decomposition_steps SET json=? WHERE id=?').run(JSON.stringify(existing),existing.id);}return existing;}const now=Date.now();const step:StepRecord={id:randomUUID(),jobId:job.id,phase,objectId,inputHash,attempt,status:'running',outputArtifactIds:[],leaseOwner:job.leaseOwner,leaseUntil:job.leaseUntil,fence:job.fence,createdAt:now,updatedAt:now};this.db.prepare('INSERT INTO decomposition_steps VALUES(?,?,?,?,?,?,?)').run(step.id,job.id,phase,objectId,inputHash,attempt,JSON.stringify(step));return step;}
  updateStep(step: StepRecord, lease: Lease) {const job=this.getJob(step.jobId);if(!job||job.tombstonedAt||job.cancelRequested||job.fence!==lease.fence||job.leaseOwner!==lease.workerId||job.revision!==lease.revision||job.leaseUntil<=Date.now())throw new DecompositionError('STALE_LEASE','Cannot publish a stale step.',409);step.updatedAt=Date.now();this.db.prepare('UPDATE decomposition_steps SET json=? WHERE id=?').run(JSON.stringify(step),step.id);return step;}
  steps(jobId:string){return this.db.prepare('SELECT json FROM decomposition_steps WHERE job_id=? ORDER BY phase,attempt').all(jobId).map((row)=>decode<StepRecord>(row)!);}
  getProviderRequest(stepId:string,inputHash:string){return decode<ProviderRequestRecord>(this.db.prepare('SELECT json FROM provider_requests WHERE step_id=? AND input_hash=?').get(stepId,inputHash));}
  providerRequests(jobId:string){return this.db.prepare('SELECT json FROM provider_requests WHERE job_id=?').all(jobId).map((row)=>decode<ProviderRequestRecord>(row)!);}
  reserveProviderRequest(input:{jobId:string;stepId:string;endpoint:string;inputHash:string;adapterVersion:string;seed?:number;sentSeed?:number},maxGlobalCalls:number,maxConcurrent:number):ProviderRequestRecord{
    return this.db.transaction(()=>{const existing=this.getProviderRequest(input.stepId,input.inputHash);if(existing)return existing;const job=this.getJob(input.jobId);if(!job||job.cancelRequested||job.tombstonedAt)throw new DecompositionError('JOB_CANCELLED','Job cancelled.',409);const step=decode<StepRecord>(this.db.prepare('SELECT json FROM decomposition_steps WHERE id=? AND job_id=?').get(input.stepId,input.jobId));if(!step||job.state!=='running'||!job.leaseOwner||job.leaseUntil<=Date.now()||step.fence!==job.fence||step.leaseOwner!==job.leaseOwner)throw new DecompositionError('STALE_LEASE','A current worker lease is required before reserving inference.',409);if(job.deadlineAt<=Date.now())throw new DecompositionError('DEADLINE_EXCEEDED','Job active deadline exceeded.',408);const global=(this.db.prepare('SELECT calls_used FROM account_budget WHERE id=1').get() as {calls_used:number}).calls_used;if(job.callsUsed>=job.options.maxCalls||global>=maxGlobalCalls)throw new DecompositionError('CALL_BUDGET','The configured call reservation budget is exhausted.',409);const active=(this.db.prepare("SELECT COUNT(*) n FROM provider_requests WHERE status IN ('SUBMITTING','QUEUED','IN_PROGRESS')").get() as {n:number}).n;if(active>=maxConcurrent)throw new DecompositionError('MODEL_BUSY','The model request limit is occupied.',429,true);const now=Date.now();const request:ProviderRequestRecord={...input,id:randomUUID(),status:'SUBMITTING',nextPollAt:now,attempts:0,createdAt:now,updatedAt:now};this.db.prepare('INSERT INTO provider_requests VALUES(?,?,?,?,?,?)').run(request.id,input.jobId,input.stepId,input.inputHash,request.status,JSON.stringify(request));job.callsUsed++;this.persist(job);this.db.prepare('UPDATE account_budget SET calls_used=calls_used+1 WHERE id=1').run();return request;})();
  }
  private writeProvider(request:ProviderRequestRecord){this.db.prepare('UPDATE provider_requests SET status=?,json=? WHERE id=?').run(request.status,JSON.stringify(request),request.id);}
  updateProviderRequest(id:string,patch:Partial<ProviderRequestRecord>){const request=decode<ProviderRequestRecord>(this.db.prepare('SELECT json FROM provider_requests WHERE id=?').get(id));if(!request)throw new DecompositionError('REQUEST_NOT_FOUND','Provider request not found.',404);const next={...request,...patch,id:request.id,jobId:request.jobId,updatedAt:Date.now()};this.writeProvider(next);return next;}
  workerHeartbeat(id:string){this.db.prepare('INSERT INTO worker_heartbeats VALUES(?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at').run(id,Date.now());}
  workerFresh(maxAgeMs=90000){const row=this.db.prepare('SELECT MAX(updated_at) t FROM worker_heartbeats').get() as {t:number|null};return !!row.t && row.t>Date.now()-maxAgeMs;}
  summarize(job:JobRecord):DecompositionJobSummary{const source=this.getSource(job.sourceId);return{sourceWidth:source?.width,sourceHeight:source?.height,sourcePreviewArtifactId:source?.masterArtifactId,reviewSubmission:job.data.reviewSubmission as DecompositionReview | undefined,candidates:job.data.candidates as DecompositionJobSummary['candidates'],proposals:job.data.proposals as DecompositionJobSummary['proposals'],proposalTargets:job.data.proposalTargets as DecompositionJobSummary['proposalTargets'],discovery:job.data.discovery as DecompositionJobSummary['discovery'],sceneGraph:job.data.sceneGraph as DecompositionJobSummary['sceneGraph'],retry:retryAvailability(job),refined:job.data.refined as DecompositionJobSummary['refined'],id:job.id,sourceId:job.sourceId,state:job.state,revision:job.revision,phase:job.phase,options:job.options,warnings:job.warnings,review:job.review,error:job.error,progress:job.progress,callsUsed:job.callsUsed,createdAt:new Date(job.createdAt).toISOString(),updatedAt:new Date(job.updatedAt).toISOString(),expiresAt:new Date(job.expiresAt).toISOString(),context:job.context,artifacts:this.listArtifacts(job.id).map(({artifactId,relativePath,sha256,mimeType,bytes,width,height})=>({artifactId,relativePath,sha256,mimeType,bytes,width,height})),manifest:job.manifest};}
}
