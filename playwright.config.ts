import { defineConfig } from '@playwright/test';

const production = Boolean(process.env.PLAYWRIGHT_PRODUCTION);
const baseURL = production ? 'http://127.0.0.1:3001' : 'http://127.0.0.1:5173';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  use: { baseURL, trace: 'retain-on-failure', channel: process.env.PLAYWRIGHT_CHANNEL },
  projects: [
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } } },
    { name: 'laptop', use: { browserName: 'chromium', viewport: { width: 1366, height: 768 } } },
  ],
  webServer: production
    ? { command: 'npm start', url: `${baseURL}/api/health`, reuseExistingServer: !process.env.CI, timeout: 30_000 }
    : [
      { command: 'npm run dev -w @frameflow/server', url: 'http://127.0.0.1:3001/api/health', reuseExistingServer: !process.env.CI, timeout: 30_000 },
      { command: 'npm run dev -w @frameflow/client', url: baseURL, reuseExistingServer: !process.env.CI, timeout: 30_000 },
    ],
});
