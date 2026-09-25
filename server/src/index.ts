import express from 'express';
import { createApp, readConfig } from './app.js';
import { createDecompositionRouter } from './decomposition/router.js';
import { readDecompositionConfig } from './decomposition/config.js';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';

const app = createApp(readConfig(), undefined, console.info, undefined, createDecompositionRouter(readDecompositionConfig()));

const clientDist = fileURLToPath(new URL('../../client/dist/', import.meta.url));
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('/{*path}', (_request, response) => response.sendFile(path.join(clientDist, 'index.html')));
}

const port = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535.');
app.listen(port, '0.0.0.0', () => console.log(`FrameFlow server: http://127.0.0.1:${port}`));
