/**
 * Seeds an isolated decomposition data directory for browser tests. No provider is ever contacted:
 * discovery outputs are replayed through the real phase 1–3 pipeline.
 *
 *   DECOMP_E2E_DATA=<empty dir>            target data directory (required)
 *   DECOMP_E2E_REPLAY_DIR=<data dir>       optional: replay a real cached Seedream discovery from this data directory
 *   DECOMP_E2E_REPLAY_JOB=<job id>         optional: the job whose cached Seedream result and source are replayed
 *
 * Without a replay source, a synthetic poster-like discovery (person, held phone, headline, panel, base) is used.
 * The fixture's source image is also written to <data>/upload-source.png for upload tests.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { loadDiscoveryFixture } from './e2eFixtures.js';
import { readDecompositionConfig, normalizeDecompositionOptions } from './config.js';
import { DecompositionRepository } from './repository.js';
import { ArtifactStore } from './artifactStore.js';
import { PipelineContext } from './context.js';
import { runPhase } from './pipeline.js';
import type { InferenceOutput } from './providers/inference.js';
import type { DecompositionReview, ProposalReviewTarget } from '@frameflow/shared';

const target = process.env.DECOMP_E2E_DATA;
if (!target) throw new Error('Set DECOMP_E2E_DATA to an empty directory.');
const replay = await loadDiscoveryFixture();
// The image a test uploads through the UI; the E2E worker answers discovery for it with the same fixture.
writeFileSync(join(target, 'upload-source.png'), replay.source);
const config = { ...readDecompositionConfig({ DECOMP_DATA_DIR: target, DECOMP_PROVIDER_MODE: 'live' }), discoveryFallback: 'none' as const };
const repo = new DecompositionRepository(config.dataDir), store = new ArtifactStore(config.dataDir, repo, config.maxJobBytes);
const meta = await sharp(replay.source).metadata();
const artifact = await store.write({ ownerId: 'operator', kind: 'source', mimeType: 'image/png', width: meta.width, height: meta.height }, replay.source);
repo.addSource({ id: 'e2e-source', ownerId: 'operator', originalArtifactId: artifact.artifactId, masterArtifactId: artifact.artifactId, originalSha256: artifact.sha256, workingMasterSha256: artifact.sha256, width: meta.width!, height: meta.height!, hasAlpha: Boolean(meta.hasAlpha), mimeType: 'image/png', orientationNormalized: false, metadata: {}, createdAt: Date.now() });
repo.createJob('operator', 'e2e-source', normalizeDecompositionOptions({}, config), 'e2e-proposal-review');
let job = repo.claimJob('e2e-seed', config.leaseMs, 'live')!;
job.data.verificationMode = 'live';
job = repo.updateJob(job, { workerId: 'e2e-seed', fence: job.fence, revision: job.revision });
const infer = async (model: string): Promise<InferenceOutput> => {
  if (model !== 'seedream') throw new Error(`E2E seed does not call ${model}.`);
  return Object.assign([...replay.outputs], { layers: replay.layers, requestId: replay.requestId });
};
for (let phase = 1; phase <= 3; phase++) {
  const context = new PipelineContext(repo.getJob(job.id)!, repo, store, config, undefined, 'e2e-seed');
  context.infer = infer as PipelineContext['infer'];
  await runPhase(context);
}
repo.releaseJob(job.id, 'e2e-seed', repo.getJob(job.id)!.fence);
const seeded = repo.getJob(job.id)!;
console.info(JSON.stringify({ event: 'e2e_seeded', jobId: seeded.id, state: seeded.state, gate: seeded.review?.gate, targets: (seeded.data.proposalTargets as { label: string }[]).map(t => t.label), replay: replay.requestId }));
// State fixtures live only in this isolated directory. Browser submissions still use the real review/retry routes,
// with their normal revision checks, limits and worker; creating fixtures avoids exhausting the upload rate limiter.
const stateJobs: Record<string, string> = {};
// editor-modes is seeded first (oldest), so it never pushes other fixtures out of the eight most recent designs.
for (const name of ['editor-modes', 'retry', 'stale', 'empty', 'narrow', 'limit', 'failed-limit']) {
  const fixture = repo.createJob('operator', 'e2e-source', { ...seeded.options, ...(name.includes('limit') ? { maxObjects: 2 } : {}), targetLabels: name === 'retry' || name === 'stale' ? ['e2e-outage'] : [] }, `e2e-${name}`);
  fixture.data = structuredClone(seeded.data);
  fixture.state = 'needs_review'; fixture.phase = 3; fixture.review = structuredClone(seeded.review);
  fixture.progress = 'Review discovered layers';
  if (name === 'retry' || name === 'stale') {
    fixture.phase = 2; fixture.state = 'failed'; fixture.review = undefined;
    fixture.error = { code: 'PROVIDER_RATE_LIMIT', message: 'E2E simulated rate limit.', retryable: true };
  }
  if (name === 'empty' || name === 'narrow') {
    fixture.data.proposals = []; fixture.data.discovery = undefined;
    fixture.data.proposalTargets = [{ id: 'manual-object', label: 'Object', proposalIds: [], approved: false, rejected: false, groupMode: 'single', role: 'object' } satisfies ProposalReviewTarget];
  }
  if (name === 'failed-limit') {
    const choices = (fixture.data.proposalTargets as ProposalReviewTarget[]).map(({ classification, ...target }, i) => { void classification; return { ...target, approved: i !== 1, rejected: i === 1, ...(i === 0 ? { label: 'Saved custom name', role: 'shape' as const } : {}) }; });
    fixture.data.reviewSubmission = { action: 'save-proposals', expectedRevision: fixture.revision, targets: choices } satisfies DecompositionReview;
    fixture.data.attempt = 1; fixture.state = 'failed'; fixture.review = undefined;
    fixture.error = { code: 'TARGET_LIMIT', message: 'Keep the approved targets within the object limit.', retryable: true };
  }
  stateJobs[name] = repo.updateJob(fixture).id;
}
writeFileSync(join(target, 'e2e-state-jobs.json'), JSON.stringify(stateJobs));
repo.close();
