# FrameFlow

A calm creative editor for the FreshFolks assessment. **Milestones 0 and 1 only:**
editor workspace, canvas sizing, and viewport zoom. The complete assessment is
not yet finished or deployed.

## Run locally

Use Node **22.12+** (Node 22 LTS recommended; `.nvmrc` provided) and npm.
The implementation was verified with Node 26.3.0 and npm 11.16.0.

```sh
npm install
npm run dev
```

Open http://127.0.0.1:5173. Vite proxies `/api` to the Express server on port 3001.
No credentials or environment files are needed for these milestones. Optional
server configuration is documented in `server/.env.example`.

Choose Poster, Square, Landscape, or Story in Design. Custom size accepts integer
sides from 256–4096 px with at most 12,000,000 total pixels. Apply changes the
logical canvas and fits it to the workspace. The +/− controls change display zoom;
Fit restores a centered view. Resizing the workspace also refits the canvas.

## Commands

| Command | Runs |
| --- | --- |
| `npm run dev` | Vite frontend and Express/tsx watcher together |
| `npm run build` | Shared declarations/JS, checked Vite production client, compiled Express server |
| `npm start` | Built Express server, serving the client and `/api` on http://127.0.0.1:3001 (build first) |
| `npm run typecheck` | TypeScript checks in all three workspaces |
| `npm run lint` | ESLint with TypeScript and React Hooks rules; zero warnings allowed |
| `npm test` | Vitest validation, viewport, and Redux boundary tests |
| `npm run test:e2e` | Playwright Chromium flows at 1440×900 and 1366×768; starts dev servers automatically |

Before first browser test, run `npx playwright install chromium`. Screenshots and
failure traces go to ignored `test-results/` directories. Use `npm ci` for a
lockfile-exact install in CI.
If Chromium downloads are unavailable and Chrome is installed, run
`PLAYWRIGHT_CHANNEL=chrome npm run test:e2e` instead.
To check the built app through Express, run `npm run build`, then
`PLAYWRIGHT_PRODUCTION=1 npm run test:e2e` (combine with the channel override if needed).

## Boundaries and decisions

- `client/src/features/editor/`: shell, accessible tabs, presets, custom form.
- `client/src/features/canvas/`: React Konva frame and reusable fit calculation.
- `client/src/store/`: serializable document state in `editorSlice`; selection,
  tabs, active variant, and viewport state in `uiSlice`.
- `shared/src/index.ts`: document contracts and strict canvas-size validation.
  Vite consumes this small TypeScript workspace directly; build also emits JS
  and declarations for later backend integration.
- `server/src/index.ts`: Express health endpoint and same-origin production
  static serving. `/api/health` truthfully returns `aiAvailable: false`.
- `client/src/styles.css`: Tailwind v4 plus project-specific visual tokens and
  editor styles. Neutral system sans-serif, no remote fonts or added font licenses.

Document dimensions and eventual element positions always use **logical pixels**.
Konva's stage scale controls display only. The DOM empty-state content sits above
the stage and is not part of the document. Reducers perform no timestamp or random
ID generation and make no network calls. IDs/timestamps enter via initialization
or action payloads; runtime objects stay outside Redux. Invalid sizes are rejected
again at the reducer boundary.

No generic UI kit, monorepo framework, or Gemini dependencies were added. Konva's
documented minimal bundle registers only the rectangle needed in this milestone;
later milestones should register their shapes explicitly.

## Current limits

Text editing is next (Milestone 2). AI, persistence/history, adaptation, export,
and the wedding example belong to later milestones. Disabled controls and
upcoming panels make that explicit. **Create with AI** opens its upcoming panel;
it does not generate artwork. The local save label says **Not saved yet** because
refresh starts a new blank document. No undo/redo buttons are shown.

At 1050 px and below the currently empty properties panel is hidden. Below 700 px
the design controls give way to a preview and desktop-editing notice. Interactive
responsive drawers are deferred with the full properties panel.

The [master brief](FreshFolks-Assessment-Master-Brief.md) is preserved unchanged.
See [implementation status](IMPLEMENTATION_STATUS.md) for actual verification and
remaining milestones.
