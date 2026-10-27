import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { newId, openStudioStore, validId } from './store.js';

describe('Template Studio store', () => {
  it('keeps every record across a restart (a new process opening the same folder)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'template-studio-store-'));
    const first = openStudioStore(dir);
    const at = new Date().toISOString();
    const template = first.templates.insert({ id: newId('tpl'), name: 'Blue studio', creatorGuidance: null, status: 'ready', currentProfileVersionId: null, thumbnailAssetId: null, brandKitId: null, references: [], createdAt: at, updatedAt: at });
    first.templates.update(template.id, { name: 'Blue studio v2' });
    const reopened = openStudioStore(dir);
    expect(reopened.templates.get(template.id)?.name).toBe('Blue studio v2');
    expect(JSON.parse(readFileSync(join(dir, 'db', 'templates.json'), 'utf8'))).toHaveLength(1);
  });

  it('refuses data written by an unknown schema instead of overwriting it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'template-studio-store-'));
    openStudioStore(dir);
    writeFileSync(join(dir, 'db', 'meta.json'), JSON.stringify({ schema: 'template-studio-db/99' }));
    expect(() => openStudioStore(dir)).toThrow(/template-studio-db\/99/);
  });

  it('only accepts its own ids in routes (no paths, no traversal)', () => {
    expect(validId(newId('pst'))).toBe(true);
    for (const bad of ['../etc/passwd', 'pst_..', 'pst_00', '', 'PST_00000000000000000000']) expect(validId(bad)).toBe(false);
  });
});
