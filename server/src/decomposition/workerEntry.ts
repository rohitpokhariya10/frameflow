import { readDecompositionConfig } from './config.js';
import { DecompositionRepository } from './repository.js';
import { ArtifactStore } from './artifactStore.js';
import { createFalTransport, DurableFalClient } from './providers/falClient.js';
import { DecompositionWorker } from './worker.js';

const config = readDecompositionConfig();
if (!config.enabled) { console.info('Decomposition is disabled. Set DECOMPOSITION_ENABLED=true after setup.'); process.exit(0); }
const repository = new DecompositionRepository(config.dataDir);
const store = new ArtifactStore(config.dataDir, repository, config.maxJobBytes);
const provider = config.providerMode === 'live' && config.falKey ? new DurableFalClient(repository, createFalTransport(config.falKey, { mediaHosts: config.trustedMediaHosts, maxBytes: config.maxArtifactBytes }), { maxGlobalCalls: config.maxAccountCalls, maxConcurrent: config.modelConcurrency, phaseTimeoutMs: config.phaseTimeoutMs }) : undefined;
const worker = new DecompositionWorker(repository, store, config, provider);
process.on('SIGTERM', () => worker.stop()); process.on('SIGINT', () => worker.stop());
console.info(JSON.stringify({ event: 'decomposition_worker_started', workerId: worker.id, configured: Boolean(provider) }));
await worker.run(); repository.close();
