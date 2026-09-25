import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import type { DecompositionOptions } from '@frameflow/shared';
import { DecompositionError } from './errors.js';
export interface DecompositionConfig {
  providerMode: 'mock' | 'live'; enabled: boolean; production: boolean; dataDir: string; falKey?: string; authMode: 'local-operator' | 'development'; passwordHash?: string;
  allowedOrigins: string[]; analysisMaxSide: number; maxObjects: number; maxHiddenObjects: number; jobConcurrency: number; modelConcurrency: number;
  maxCallsPerJob: number; maxAccountCalls: number; phaseTimeoutMs: number; jobTimeoutMs: number; retentionDays: number; allowEraseFallback: boolean;
  maxUploadBytes: number; minSide: number; maxSide: number; maxPixels: number; maxArtifactBytes: number; maxJobBytes: number; maxQueue: number;
  leaseMs: number; sessionMs: number; trustedMediaHosts: string[];
}
const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export function readDecompositionConfig(env = process.env): DecompositionConfig {
  const enabled = env.DECOMPOSITION_ENABLED === 'true'; const production = env.NODE_ENV === 'production';
  const number = (name: string, fallback: number, min: number, max: number) => { const value = Number(env[name] ?? fallback); if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}.`); return value; };
  const providerMode = env.DECOMP_PROVIDER_MODE ?? 'live';
  if (!['mock','live'].includes(providerMode) || (production && providerMode === 'mock')) throw new Error('DECOMP_PROVIDER_MODE must be live, or mock in development only.');
  const authMode = env.DECOMP_AUTH_MODE ?? 'local-operator';
  if (authMode !== 'local-operator' && authMode !== 'development') throw new Error('DECOMP_AUTH_MODE must be local-operator or development.');
  if (enabled && production && (!env.DECOMP_DATA_DIR || authMode === 'development')) throw new Error('Production decomposition requires DECOMP_DATA_DIR and local-operator authentication.');
  const dataDir = resolve(serverRoot, env.DECOMP_DATA_DIR ?? 'data/decomposition');
  let passwordHash = env.DECOMP_OPERATOR_PASSWORD_HASH?.trim();
  const credentialFile = resolve(dataDir, 'operator.json');
  if (!passwordHash && existsSync(credentialFile)) { const stored = JSON.parse(readFileSync(credentialFile, 'utf8')) as { passwordHash?: string }; passwordHash = stored.passwordHash; }
  if (enabled && production && !passwordHash) throw new Error('Run decomp:setup or configure DECOMP_OPERATOR_PASSWORD_HASH before enabling production decomposition.');
  const origins = ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:3001', 'http://127.0.0.1:3001', ...(env.CLIENT_ORIGIN ? [env.CLIENT_ORIGIN.replace(/\/$/, '')] : [])];
  return { providerMode: providerMode as 'mock' | 'live', enabled, production, dataDir, falKey: env.FAL_KEY?.trim() || undefined, authMode, passwordHash, allowedOrigins: origins,
    analysisMaxSide: number('DECOMP_ANALYSIS_MAX_SIDE',1024,256,2048), maxObjects: number('DECOMP_MAX_OBJECTS',6,1,12), maxHiddenObjects: number('DECOMP_MAX_HIDDEN_OBJECTS',2,0,2),
    jobConcurrency: number('DECOMP_JOB_CONCURRENCY',1,1,1), modelConcurrency: number('DECOMP_MODEL_CONCURRENCY',2,1,2), maxCallsPerJob: number('DECOMP_MAX_CALLS_PER_JOB',20,1,100), maxAccountCalls: number('DECOMP_MAX_ACCOUNT_CALLS',1000,1,100000),
    phaseTimeoutMs: number('DECOMP_PHASE_TIMEOUT_MS',300000,1000,1800000), jobTimeoutMs: number('DECOMP_JOB_TIMEOUT_MS',1200000,1000,7200000), retentionDays: number('DECOMP_ARTIFACT_RETENTION_DAYS',7,1,365), allowEraseFallback: env.DECOMP_ALLOW_ERASE_FALLBACK !== 'false',
    maxUploadBytes: number('DECOMP_MAX_UPLOAD_BYTES',25*1024*1024,1024,128*1024*1024), minSide: 256, maxSide: 4096, maxPixels: 12000000, maxArtifactBytes: 128*1024*1024, maxJobBytes: number('DECOMP_MAX_JOB_BYTES',512*1024*1024,1024*1024,2*1024*1024*1024), maxQueue: number('DECOMP_MAX_QUEUE',20,1,100), leaseMs: 60000, sessionMs: 12*60*60*1000,
    trustedMediaHosts: (env.DECOMP_TRUSTED_MEDIA_HOSTS ?? 'fal.media,*.fal.media').split(',').map((host) => host.trim()).filter(Boolean) };
}
export function normalizeDecompositionOptions(value: unknown, config: DecompositionConfig): DecompositionOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DecompositionError('INVALID_OPTIONS','Supply decomposition options.');
  const v = value as Record<string, unknown>; const keys = new Set(['maxObjects','targetLabels','qualityProfile','completeHiddenObjects','reconstructBackground','allowEraseFallback','maxCalls']);
  if (Object.keys(v).some((key) => !keys.has(key))) throw new DecompositionError('INVALID_OPTIONS','Unknown decomposition option.');
  const bounded = (key: string, fallback: number, max: number) => { const n = v[key] ?? fallback; if (!Number.isSafeInteger(n) || Number(n) < 1) throw new DecompositionError('INVALID_OPTIONS',`${key} must be a positive integer.`); return Math.min(Number(n),max); };
  for (const key of ['completeHiddenObjects','reconstructBackground','allowEraseFallback']) if (v[key] !== undefined && typeof v[key] !== 'boolean') throw new DecompositionError('INVALID_OPTIONS',`${key} must be true or false.`);
  if (v.qualityProfile !== undefined && !['faithful','refined'].includes(String(v.qualityProfile))) throw new DecompositionError('INVALID_OPTIONS','Select faithful or refined quality.');
  const labels = v.targetLabels ?? []; if (!Array.isArray(labels) || labels.length > config.maxObjects || !labels.every((label) => typeof label === 'string' && label.trim().length > 0 && label.length <= 100)) throw new DecompositionError('INVALID_OPTIONS','Use short target labels within the object limit.');
  return { maxObjects: bounded('maxObjects',config.maxObjects,config.maxObjects), targetLabels: labels.map((label: string) => label.trim()), qualityProfile: v.qualityProfile === 'refined' ? 'refined' : 'faithful', completeHiddenObjects: v.completeHiddenObjects === true, reconstructBackground: v.reconstructBackground !== false, allowEraseFallback: config.allowEraseFallback && v.allowEraseFallback !== false, maxCalls: bounded('maxCalls',config.maxCallsPerJob,config.maxCallsPerJob) };
}
