import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['{client,shared,server}/src/**/*.test.ts'] } });
