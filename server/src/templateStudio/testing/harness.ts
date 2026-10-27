/** Test harness: a throwaway Template Studio store in the OS temp folder, with providers that never leave the process. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseStudioEnv } from '../config.js';
import { openStudioStore } from '../store.js';

export function tempStudio(vars: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'template-studio-test-'));
  const env = parseStudioEnv({ OPENAI_API_KEY: 'test-key-not-used', ...vars }, dir);
  return { dir, env, db: openStudioStore(dir), storageDir: env.assetStorageDir };
}
