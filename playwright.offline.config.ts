import { defineConfig } from '@playwright/test';

/** Full built-client regressions plus a real local API journey. All server providers are injected fakes. */
const port = 3317, baseURL = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: './tests', testMatch: ['e2e/**/*.spec.ts', 'e2e-image-templates/**/*.spec.ts'],
  outputDir: 'test-results/offline', fullyParallel: true, workers: 2,
  use: { baseURL, trace: 'retain-on-failure', channel: process.env.PLAYWRIGHT_CHANNEL },
  projects: [
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } } },
    { name: 'laptop', use: { browserName: 'chromium', viewport: { width: 1366, height: 768 } } },
    { name: 'wide', testMatch: ['e2e-image-templates/**/*.spec.ts', 'e2e/themes.spec.ts'], use: { browserName: 'chromium', viewport: { width: 1920, height: 1080 } } },
  ],
  webServer: {
    command: 'node --conditions=development --import tsx tests/fixtures/imageTemplateOfflineServer.ts',
    url: `${baseURL}/api/health`, reuseExistingServer: false, timeout: 30_000,
    env: { FRAMEFLOW_OFFLINE_E2E: '1', FRAMEFLOW_OFFLINE_PORT: String(port), OPENAI_API_KEY: '', FAL_KEY: '', GEMINI_API_KEY: '', CLOUDFLARE_API_TOKEN: '' },
  },
});
