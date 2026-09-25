import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import type { ArtifactRecord, DecompositionRepository } from './repository.js';
import { DecompositionError } from './errors.js';
export interface ArtifactInput { ownerId: string; jobId?: string; kind: string; mimeType: string; width?: number; height?: number; relativePath?: string }
const extensions: Record<string,string> = {'image/png':'png','image/jpeg':'jpg','image/webp':'webp','application/json':'json','text/plain':'txt','application/zip':'zip'};
export class ArtifactStore {
  readonly root: string;
  constructor(dataDir: string, readonly repository: DecompositionRepository, readonly maxJobBytes = 512*1024*1024) { this.root = resolve(dataDir,'artifacts'); }
  path(storageKey: string) {
    if (!/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\.[a-z0-9]+$/.test(storageKey)) throw new DecompositionError('INVALID_PATH','Invalid artifact path.',400);
    const file = resolve(this.root,storageKey); if (!file.startsWith(`${this.root}${sep}`)) throw new DecompositionError('INVALID_PATH','Invalid artifact path.',400); return file;
  }
  async write(input: ArtifactInput, bytes: Buffer): Promise<ArtifactRecord> {
    if (bytes.length > 128*1024*1024) throw new DecompositionError('ARTIFACT_TOO_LARGE','Artifact exceeds the file limit.',413);
    if (!/^[a-zA-Z0-9_-]+$/.test(input.ownerId) || (input.jobId && !/^[a-zA-Z0-9_-]+$/.test(input.jobId))) throw new DecompositionError('INVALID_PATH','Invalid artifact scope.');
    const extension=extensions[input.mimeType]; if(!extension)throw new DecompositionError('INVALID_MIME','Unsupported artifact content type.');
    const id=randomUUID(); const storageKey=`${input.ownerId}/${input.jobId ?? 'sources'}/${id}.${extension}`;const file=this.path(storageKey);await mkdir(dirname(file),{recursive:true,mode:0o700});const temporary=`${file}.${randomUUID()}.tmp`;
    const record:ArtifactRecord={...input,artifactId:id,storageKey,relativePath:input.relativePath ?? `${input.kind}/${id}.${extension}`,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,width:input.width??0,height:input.height??0,createdAt:Date.now(),retentionState:'active'};
    const handle=await open(temporary,'wx',0o600);
    try {await handle.writeFile(bytes);await handle.sync();} catch(error){await handle.close();await unlink(temporary).catch(()=>{});throw error;}await handle.close();
    await rename(temporary,file);
    try {return this.repository.addArtifact(record,this.maxJobBytes);}catch(error){await unlink(file).catch(()=>{});throw error;}
  }
  async read(record: ArtifactRecord) { const bytes=await readFile(this.path(record.storageKey));if(bytes.length!==record.bytes||createHash('sha256').update(bytes).digest('hex')!==record.sha256)throw new DecompositionError('ARTIFACT_CORRUPT','Stored artifact failed integrity verification.',500);return bytes; }
  stream(record:ArtifactRecord){return createReadStream(this.path(record.storageKey));}
  async remove(record:ArtifactRecord){await unlink(this.path(record.storageKey)).catch((error:NodeJS.ErrnoException)=>{if(error.code!=='ENOENT')throw error;});this.repository.markArtifactDeleted(record.artifactId);}
  /** Reconcile only old unreferenced writes; active writes cannot be collected. */
  async reconcileOrphans(olderThanMs=3600000){
    const cutoff=Date.now()-olderThanMs;let removed=0;
    const visit=async(directory:string):Promise<void>=>{for(const entry of await readdir(directory,{withFileTypes:true}).catch(()=>[])){const file=resolve(directory,entry.name);if(entry.isDirectory()){await visit(file);continue;}if(!entry.isFile()||(await stat(file)).mtimeMs>cutoff)continue;const key=file.slice(this.root.length+1);const row=this.repository.db.prepare("SELECT id FROM artifacts WHERE storage_key=? AND retention_state!='deleted'").get(key);if(!row){await unlink(file);removed++;}}};await visit(this.root);return removed;
  }
  async cleanupExpired(){let removed=0;const rows=this.repository.db.prepare('SELECT json FROM decomposition_jobs WHERE tombstoned_at IS NOT NULL').all() as {json:string}[];for(const row of rows){const job=JSON.parse(row.json) as {id:string};for(const artifact of this.repository.listArtifacts(job.id)){await this.remove(artifact);removed++;}}return removed;}
}
