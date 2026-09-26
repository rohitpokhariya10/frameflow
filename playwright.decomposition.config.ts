import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

/**
 * Isolated decomposition browser tests. A fresh data directory is seeded per run (replaying cached discovery
 * outputs through the real pipeline), and the API/worker run WITHOUT a fal key, so no paid call is possible. The
 * worker uses the deterministic E2E fake for SAM/BiRefNet (server/src/decomposition/e2eWorker.ts).
 * Set DECOMP_E2E_REPLAY_DIR + DECOMP_E2E_REPLAY_JOB to replay a real cached Seedream discovery instead of the
 * synthetic poster.
 */
process.env.DECOMP_E2E_DATA ??= mkdtempSync(join(tmpdir(), 'frameflow-decomp-e2e-'));
const apiPort = 3211, clientPort = 5211;
const baseURL = `http://127.0.0.1:${clientPort}`;
const serverEnv = {
  DECOMP_E2E_DATA: process.env.DECOMP_E2E_DATA, DECOMP_E2E_REPLAY_DIR: process.env.DECOMP_E2E_REPLAY_DIR ?? '', DECOMP_E2E_REPLAY_JOB: process.env.DECOMP_E2E_REPLAY_JOB ?? '',
  DECOMP_DATA_DIR: process.env.DECOMP_E2E_DATA, DECOMPOSITION_ENABLED: 'true', DECOMP_PROVIDER_MODE: 'live', DECOMP_AUTH_MODE: 'development',
  PORT: String(apiPort), CLIENT_ORIGIN: baseURL, FAL_KEY: '', DECOMP_E2E_FAKE_PROVIDER: '1',
};
const tsx = 'node --conditions=development --import tsx';

export default defineConfig({
  testDir: './tests/e2e-decomposition',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  use: { baseURL, trace: 'retain-on-failure', viewport: { width: 1440, height: 1000 } },
  projects: [{ name: 'decomposition', use: { browserName: 'chromium' } }],
  webServer: [
    {
      command: `${tsx} server/src/decomposition/e2eSeed.ts && npx concurrently -k -n api,worker "${tsx} server/src/index.ts" "${tsx} server/src/decomposition/e2eWorker.ts"`,
      url: `http://127.0.0.1:${apiPort}/api/health`, reuseExistingServer: false, timeout: 120_000, env: serverEnv,
    },
    { command: 'npm run dev -w @frameflow/client', url: baseURL, reuseExistingServer: false, timeout: 60_000, env: { FRAMEFLOW_CLIENT_PORT: String(clientPort), FRAMEFLOW_API_URL: `http://127.0.0.1:${apiPort}` } },
  ],
});
