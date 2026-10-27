import express from 'express';
import { createApp, readConfig } from './app.js';
import { createDecompositionRouter } from './decomposition/router.js';
import { readDecompositionConfig } from './decomposition/config.js';
import { createLayerizeRouter, layerizeExperimentEnabled } from './decomposition/layerizeRouter.js';
import { createTemplateStudioRouter } from './templateStudio/router.js';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { prepareStorage } from './deployment.js';
import { describeAccess, readAccessConfig } from './access.js';

// Before any store is opened: where saved files go, and a warning when they will not outlast this process.
const storage = prepareStorage();
if (storage.warning) console.warn(`FrameFlow storage: ${storage.warning}`);
const access = readAccessConfig();
const experiment = layerizeExperimentEnabled();
const app = createApp(readConfig(), undefined, console.info, undefined, createDecompositionRouter(readDecompositionConfig()),
  experiment ? createLayerizeRouter() : undefined, undefined, experiment ? createTemplateStudioRouter() : undefined, access);

const clientDist = fileURLToPath(new URL('../../client/dist/', import.meta.url));
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  // Every other page address is the single-page app; a missing file (an old /assets/… chunk after a deploy) stays a 404.
  app.get('/{*path}', (request, response, next) => path.extname(request.path) ? next() : response.sendFile(path.join(clientDist, 'index.html')));
}

const port = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535.');
app.listen(port, '0.0.0.0', () => console.log(`FrameFlow server: http://127.0.0.1:${port} (data: ${storage.dir}; access: ${describeAccess(access)})`));
