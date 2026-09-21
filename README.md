# FrameFlow

A calm creative editor for the FreshFolks assessment. **Milestones 0–4 complete:**
editor workspace, canvas sizing, interactive text editing, deterministic Auto Layout,
local recovery, and undo/redo.
The complete assessment is not yet finished or deployed.

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

Click **Add heading** on the empty canvas, or open **Text** to add a heading,
subheading, or body. Select on the canvas or in the element list. Drag to move;
the two side handles change width and reflow words without changing font size.
Use the inspector to edit exact content (including newlines), family, size,
weight, color, alignment, X/Y, and width. Numbers apply on Enter or blur.
Duplicate offsets and selects a copy. Delete/Backspace remove the selection only
when the canvas or element list owns focus; typing in form fields is protected.
Escape or clicking the empty canvas/workspace deselects.

Use **Auto Layout** to fit selected text inside the safe frame without changing its
wording. It tries movement and width changes before reducing font size, and reports
when readable fitting is impossible. A second successful run makes no change.

Edits save locally after a short debounce. Wait for **Saved on this device** before
closing. Refresh restores the current design; history starts empty. Use Undo/Redo
or Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z outside typing controls. Content updates group
within a one-second typing session, ending on blur. Browser storage is not a backup.

## Commands

| Command | Runs |
| --- | --- |
| `npm run dev` | Vite frontend and Express/tsx watcher together |
| `npm run build` | Shared declarations/JS, checked Vite production client, compiled Express server |
| `npm start` | Built Express server, serving the client and `/api` on http://127.0.0.1:3001 (build first) |
| `npm run typecheck` | TypeScript checks in all three workspaces plus browser tests/config |
| `npm run lint` | ESLint with TypeScript and React Hooks rules; zero warnings allowed |
| `npm test` | Vitest validation, viewport, text operations, and Redux boundary tests |
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
- `client/src/features/canvas/`: React Konva frame, focused text-node interactions,
  side-only Transformer, and reusable fit calculation.
- `client/src/features/text/`: insertion/list, inspector, actions, real text
  measurement for position bounds, and font loading.
- `client/src/store/`: serializable document state in `editorSlice`; selection,
  tabs, active variant, and viewport state in `uiSlice`.
- `shared/src/index.ts` / `text.ts`: document contracts, canvas-size validation,
  text defaults/limits, typography validation, and recoverable position bounds.
  Vite consumes this small TypeScript workspace directly; build also emits JS
  and declarations for later backend integration.
- `server/src/index.ts`: Express health endpoint and same-origin production
  static serving. `/api/health` truthfully returns `aiAvailable: false`.
- `client/src/styles.css`: Tailwind v4 plus project-specific visual tokens and
  editor styles, preserving the warm-neutral/deep-green shell.

Document dimensions and element positions always use **logical pixels**.
Konva's stage scale controls display only. The DOM empty-state content sits above
the stage and is not part of the document. Reducers perform no timestamp or random
ID generation and make no network calls. IDs/timestamps enter via initialization
or action payloads; runtime objects stay outside Redux. Invalid sizes are rejected
again at the reducer boundary.

Dragging and resizing update the local Konva node during the gesture, then commit
one document action on release. Width transforms normalize scale back to 1 on
every move and on release, keeping glyphs undistorted. Rotation/corner/vertical
handles are disabled. Text height is derived by Konva; no height, node refs,
measurements, or transform scale is saved in the document. The selection belongs
to UI state. Changing a canvas preset preserves every existing text property.

No generic UI kit, monorepo framework, or Gemini dependencies were added. Konva's
minimal bundle explicitly registers Rect, Text, and Transformer.

## Fonts

Inter (UI/sans text) and Lora (editorial serif) are self-hosted using
`@fontsource/inter` and `@fontsource/lora` 5.3.0. Only normal Latin assets at real
400/600/700 weights are imported. The app waits for these six faces before drawing
text; a failed font load offers a retry instead of silently measuring a fallback.
No runtime requests to Google Fonts or another font CDN are needed. Both fonts
use SIL OFL 1.1; unmodified licenses ship in
[`client/public/licenses/`](client/public/licenses/). Other scripts/emoji may use
OS fallback fonts, so their appearance can differ between devices.

## Current limits

Milestone 5 AI generation is next and has not started. Adaptation, export, and the
wedding example remain later scope. **Create with AI** opens its upcoming panel.
The current project persists in localStorage; native IndexedDB asset storage is
verified with a local fixture, without an image-generation/rendering feature yet.
Undo/redo retains up to 30 document operations during this session.

Text editing is limited to 50 elements/frame and 5,000 characters/element. Font
size is 8–512 logical px; width is 32–8192 px. Numeric size controls clamp to those
bounds; empty/nonfinite numbers are rejected. Movement permits partial overflow
while retaining up to 24 logical px of the text box inside the frame. Elements
already outside the frame after a preset change remain recoverable from the list
and position fields. Auto Layout is explicit and never rewrites content. Collision detection and
inline text editing are outside current scope.

At 701–1050 px the empty inspector is hidden; selecting text reveals a closable
inspector over the right side. Below 700 px the design controls give way to a
preview and desktop-editing notice. Full mobile editing remains outside scope.

The [master brief](FreshFolks-Assessment-Master-Brief.md) is preserved unchanged.
See [implementation status](IMPLEMENTATION_STATUS.md) for actual verification and
remaining milestones.

See [Auto Layout](docs/AUTO_LAYOUT.md) and [persistence/history](docs/PERSISTENCE_AND_HISTORY.md) for implementation details and limits.
