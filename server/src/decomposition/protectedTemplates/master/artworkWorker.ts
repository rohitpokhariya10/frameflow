/**
 * The artwork split (artworkObjects.ts) off the server's main thread: a picture in, its base and objects out. The split
 * takes seconds on a full-size template; here the server keeps answering other requests meanwhile.
 */
import { parentPort } from 'node:worker_threads';
import { decodeRgba } from '../pixels.js';
import { splitArtwork, splitByLayers } from './artworkObjects.js';

export type ArtworkJob = { png: Uint8Array; layers?: { name: string; mask: Uint8Array }[]; options?: { region?: { x: number; y: number; width: number; height: number }; grounds?: string[] } };

parentPort?.on('message', async (job: ArtworkJob) => {
  try {
    const source = await decodeRgba(Buffer.from(job.png));
    parentPort!.postMessage({ split: job.layers ? await splitByLayers(source, job.layers) : await splitArtwork(source, job.options ?? {}) });
  } catch (error) { parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
});
