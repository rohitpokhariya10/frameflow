/**
 * Browser-test worker ONLY. Runs the real pipeline with the deterministic fake SAM 3.1/BiRefNet (e2eFakeProvider.ts)
 * so review flows can be exercised without paid inference. It refuses to start in production, with a fal key present,
 * or without DECOMP_E2E_FAKE_PROVIDER=1. Every fake call is appended to <dataDir>/e2e-fake-calls.log.
 */
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { readDecompositionConfig } from './config.js';
import { DecompositionRepository } from './repository.js';
import { ArtifactStore } from './artifactStore.js';
import { DecompositionWorker } from './worker.js';
import { fakeBiRefNet, fakeSam } from './e2eFakeProvider.js';
import { loadDiscoveryFixture } from './e2eFixtures.js';
import { ProviderError } from './providers/adapters.js';
import type { PipelineContext } from './context.js';

const config = readDecompositionConfig();
if (process.env.DECOMP_E2E_FAKE_PROVIDER !== '1' || config.production || config.falKey || config.providerMode !== 'live') throw new Error('The E2E worker requires DECOMP_E2E_FAKE_PROVIDER=1, no FAL_KEY, live mode and a non-production environment.');
const log = join(config.dataDir, 'e2e-fake-calls.log');
// Discovery for uploaded images is answered from the same fixture the seed used (real replay or synthetic poster).
const fixture = await loadDiscoveryFixture();
async function prepare(context: PipelineContext) {
  context.infer = async (model, request) => {
    context.check();
    appendFileSync(log, `${JSON.stringify({ jobId: context.job.id, model, key: request.key, prompt: request.prompt, points: request.points?.length ?? 0, box: !!request.boxes?.length })}\n`);
    // Test hooks via the optional "what to look for" labels: simulate an empty discovery or a provider outage.
    const labels = context.job.options.targetLabels ?? [];
    if (labels.includes('e2e-empty') && (model === 'seedream' || model === 'qwen')) throw new ProviderError('PROVIDER_UNAVAILABLE', 'E2E simulated: nothing discovered.');
    if (labels.includes('e2e-outage') && model === 'seedream') throw new ProviderError('PROVIDER_RATE_LIMIT', 'E2E simulated rate limit.', true, 429);
    if (model === 'seedream') return Object.assign([...fixture.outputs], { layers: fixture.layers, requestId: fixture.requestId });
    if (model === 'sam3') return fakeSam(request);
    if (model === 'birefnet') return fakeBiRefNet(request);
    throw new Error(`The E2E fake provider does not implement ${model}.`);
  };
}

const repository = new DecompositionRepository(config.dataDir);
const store = new ArtifactStore(config.dataDir, repository, config.maxJobBytes);
const worker = new DecompositionWorker(repository, store, config, undefined, prepare);
process.on('SIGTERM', () => worker.stop()); process.on('SIGINT', () => worker.stop());
console.info(JSON.stringify({ event: 'decomposition_e2e_worker_started', workerId: worker.id, fakeProvider: true }));
await worker.run(); repository.close();
