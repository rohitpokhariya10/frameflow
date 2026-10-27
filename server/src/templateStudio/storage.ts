/**
 * Local file storage rooted at the studio's files directory (Generator storage.ts). Callers pass relative paths produced by
 * this application only; resolution still refuses anything that would escape the root (absolute paths, "..", empty parts).
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class StoragePathError extends Error {
  constructor(rel: string) { super(`Refusing storage path outside the asset root: ${JSON.stringify(rel)}`); this.name = 'StoragePathError'; }
}

export function resolveStoragePath(root: string, rel: string): string {
  if (!rel || path.isAbsolute(rel) || rel.includes('\0') || rel.includes('\\')) throw new StoragePathError(rel);
  const parts = rel.split('/');
  if (parts.some(p => p === '' || p === '.' || p === '..')) throw new StoragePathError(rel);
  const absRoot = path.resolve(root), abs = path.resolve(absRoot, rel);
  if (!abs.startsWith(absRoot + path.sep)) throw new StoragePathError(rel);
  return abs;
}

/** Write via temp file + rename so readers never see partial files. */
export async function writeStorageFile(root: string, rel: string, data: Buffer): Promise<void> {
  const abs = resolveStoragePath(root, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.${randomUUID()}.tmp`;
  try { await writeFile(tmp, data, { flag: 'wx' }); await rename(tmp, abs); }
  catch (err) { await rm(tmp, { force: true }); throw err; }
}

export async function readStorageFile(root: string, rel: string): Promise<Buffer> { return readFile(resolveStoragePath(root, rel)); }
export async function removeStorageFile(root: string, rel: string): Promise<void> { await rm(resolveStoragePath(root, rel), { force: true }); }
