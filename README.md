# FrameFlow

A calm creative editor for the FreshFolks assessment. Milestones 0–6 provide canvas
sizing, interactive text editing, measured Auto Layout, local recovery, undo/redo,
artwork generation, and reference-based format adaptation. Exact-size PNG export
and M7 reviewer UI polish are complete. **Real generation and portrait→landscape adaptation are verified with Cloudflare Workers AI**;
Gemini remains an alternate but this project's Gemini model has zero Free Tier quota.
The full assessment is not yet finished or deployed. See the current live verification
result in [implementation status](IMPLEMENTATION_STATUS.md).

## What FrameFlow solves

An event design needs accurate, editable wording and a composition that works in
more than one format. FrameFlow keeps text separate from AI artwork, so names,
dates and long venue lines stay exact while the artwork can be recomposed.

## Features and assessment mapping

| Requirement | Where to try it |
| --- | --- |
| Configurable canvas | Design → presets or Custom size |
| Editable text and typography | Text panel and right-hand inspector |
| Overflow handling | Select text → Auto Layout |
| AI artwork generation | AI → Generate → preview → Use this design |
| Reference-based portrait → landscape | AI → Adapt format → Landscape → compare → Use this version |
| Preserve exact wording | App-rendered text stays editable above generated artwork |
| Keep both compositions | Version selector and Compare versions |
| Local recovery and undo/redo | Browser save status and top-bar history controls |
| PNG download (additional feature) | Export PNG at exact logical canvas dimensions |

## Suggested reviewer flow

1. Open a Poster and add a heading. Replace its content with
   “The Grand Royal Wedding Palace, Connaught Place, New Delhi, India”. Move it
   near the edge, then use **Auto Layout** to fit it without changing the words.
2. Open **AI → Generate**. Describe an ivory floral wedding design, choose a style,
   and enter exact event wording. Review the preview before **Use this design**.
3. Choose **Adapt format → Landscape**. Review the new composition beside its
   source, then select **Use this version**. Switch between both versions.
4. Edit the wording, try Undo/Redo, refresh to check recovery, and **Export PNG**.

Live AI actions use the configured account's allocation. The automated suites mock
those actions; the completed M5/M6 live verification is recorded separately.

## Run locally

Use Node **22.12+** (Node 22 LTS recommended; `.nvmrc` provided) and npm.
The implementation was verified with Node 26.3.0 and npm 11.16.0.

```sh
npm install
npm run dev
```

Open http://127.0.0.1:5173. Vite proxies `/api` to the Express server on port 3001.
No credentials are needed for editing or automated mocked tests. To enable AI,
copy `server/.env.example` to ignored `server/.env`, leave `AI_PROVIDER=cloudflare`,
and fill `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. The model defaults to
`@cf/black-forest-labs/flux-2-klein-4b` via `CLOUDFLARE_IMAGE_MODEL`. Restart the server.
The token needs Workers AI access for that account. Keep credentials server-side.

To select the existing alternate, set `AI_PROVIDER=gemini` and `GEMINI_API_KEY`;
`GEMINI_IMAGE_MODEL` defaults to `gemini-3.1-flash-image`. Omitting `AI_PROVIDER`
retains Gemini for older setups. There is no automatic provider fallback. Health
reports the active provider and whether its credentials are present; missing selected
credentials disable generation even when the other provider has credentials.
For split deployment, Vercel uses `VITE_API_BASE_URL=https://<render-service>/api`;
Render uses the exact frontend `CLIENT_ORIGIN` and `TRUST_PROXY_HOPS=1`.
See [AI generation](docs/AI_GENERATION.md) for configuration and verification limits.

Choose Poster, Square, Landscape, or Story in Design. Custom size accepts integer
sides from 256–4096 px with at most 12,000,000 total pixels. Apply changes the
logical canvas and fits it to the workspace. The +/− controls change display zoom;
Fit restores a centered view. Resizing the workspace also refits the canvas.

Click **Add heading** on the empty canvas, or open **Text** to add a heading,
subheading, or body. Select on the canvas or in the element list. Drag to move;
the two side handles change width and reflow words without changing font size.
Use the inspector to edit exact content (including newlines), family, size,
weight, color, alignment, X/Y, and width. Valid numbers apply while typing, with one undo per focus session.
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

In **AI**, describe the artwork, choose a theme/format, and optionally enter exact
event wording. Generate first creates a preview. **Use this design** applies it as
one undoable change; Regenerate and Discard leave the document unchanged. Wording
stays editable, while artwork is stored in IndexedDB and restored after refresh.

## Commands

| Command | Runs |
| --- | --- |
| `npm run dev` | Vite frontend and Express/tsx watcher together |
| `npm run build` | Shared declarations/JS, checked Vite production client, compiled Express server |
| `npm start` | Built Express server, serving the client and `/api` on http://127.0.0.1:3001 (build first) |
| `npm run typecheck` | TypeScript checks in all three workspaces plus browser tests/config |
| `npm run lint` | ESLint with TypeScript and React Hooks rules; zero warnings allowed |
| `npm test` | Vitest validation, layout, history/persistence, AI state/assets, and mocked backend/provider tests |
| `npm run test:e2e` | Playwright Chromium flows at 1440×900 and 1366×768; starts dev servers automatically |

Before first browser test, run `npx playwright install chromium`. Screenshots and
failure traces go to ignored `test-results/` directories. Use `npm ci` for a
lockfile-exact install in CI.
If Chromium downloads are unavailable and Chrome is installed, run
`PLAYWRIGHT_CHANNEL=chrome npm run test:e2e` instead.
To check the built app through Express, run `npm run build`, then
`PLAYWRIGHT_PRODUCTION=1 npm run test:e2e` (combine with the channel override if needed).

## Tech stack and architecture

React, TypeScript, Redux Toolkit and Konva render and edit the browser document.
Vite builds the client. Express runs the AI endpoints; shared TypeScript contracts
validate requests and documents. Vitest and Playwright cover domain, API and browser
flows. IndexedDB stores artwork, and localStorage stores the serializable project.

AI produces artwork only. FrameFlow renders editable text using bundled fonts,
measures overflow with the same renderer, and handles layout itself. This keeps
wording reliable and avoids depending on image generation for typography.

## Project structure and decisions

- `client/src/features/editor/`: shell, accessible tabs, presets, custom form.
- `client/src/features/canvas/`: React Konva frame, focused text-node interactions,
  side-only Transformer, and reusable fit calculation.
- `client/src/features/text/`: insertion/list, inspector, actions, real text
  measurement for position bounds, and font loading.
- `client/src/store/`: serializable document state in `editorSlice`; selection,
  tabs, active variant, and viewport state in `uiSlice`.
- `shared/src/index.ts` / `text.ts`: document contracts, canvas-size validation,
  text defaults/limits, typography validation, and recoverable position bounds.
  Development consumes TypeScript; production uses built shared JavaScript.
- `server/src/app.ts`: validated AI endpoint, health/configuration flag, CORS,
  limits, provider selection, and safe errors. REST/SDK mapping stays in the two
  provider adapters under `server/src/providers/`.
  Built Express also retains same-origin static serving for production checks.
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

No generic UI kit or monorepo framework was added. The official Gemini SDK is a
server-only dependency. Konva's minimal bundle registers Rect, Text, Image, and Transformer.

## Fonts

Inter (UI/sans text) and Lora (editorial serif) are self-hosted using
`@fontsource/inter` and `@fontsource/lora` 5.3.0. Only normal Latin assets at real
400/600/700 weights are imported. The app waits for these six faces before drawing
text; a failed font load offers a retry instead of silently measuring a fallback.
No runtime requests to Google Fonts or another font CDN are needed. Both fonts
use SIL OFL 1.1; unmodified licenses ship in
[`client/public/licenses/`](client/public/licenses/). Other scripts/emoji may use
OS fallback fonts, so their appearance can differ between devices.

## Adapt a design

Create/apply artwork, then open **AI → Adapt format**. Choose Landscape, Poster,
Story, Square or Custom, and select **Adapt artwork**. FrameFlow uses the existing
artwork as a visual reference while preserving every editable text string.

Review Source and Target at their natural aspect ratios. **Use this version** adds
and selects a new variant, keeping the original. The version selector and **Compare
versions** let you return to either composition. Apply is one undo step; redo never
calls AI. Both versions and their artwork survive refresh. Stale results require
regeneration or discard. See [AI adaptation](docs/AI_ADAPTATION.md) for architecture,
reference constraints and the real verification result.

## Export a PNG

Click **Export PNG** to download the active version at its exact logical canvas
size, independent of Fit, editor zoom, or screen pixel density. All four presets
and valid custom sizes (256–4096 px per side, up to 12 million pixels) are supported.
The PNG includes background color, aspect-preserving artwork fit/crop, and text
using the editor's typography, wrapping, and coordinates. Selection handles,
comparison frames, and editor UI are excluded. Fonts and artwork must load first;
failures show a retryable message instead of knowingly downloading an incomplete image.

Names use `frameflow-poster-1080x1350.png`, `frameflow-landscape-1600x900.png`, or
`frameflow-custom-1000x1000.png`. Preset names are inferred from dimensions; no
user text or project IDs enter the filename. Export captures the active version at
the click, including when comparing versions; unapplied AI previews are not exported.
Export does not change selection, zoom, saved content, active version, or history.
Temporary nodes/canvases and object URLs are released. No server or AI call is needed.

Large exports use browser memory and can fail on constrained devices; close other
tabs and retry. Browser download permissions and disk-space failures after download
handoff cannot be detected reliably by a web page. Check your browser's downloads.
Existing overlaps or off-canvas text are exported as composed, without automatic
layout changes; scripts/emoji using OS fallback fonts can differ between devices.

## Current limits

Routine AI tests use explicit mocks. The Gemini alternate remains blocked by this
project’s zero Free Tier image quota. Cloudflare uses its account’s available allocation;
free usage is limited, and provider quota/errors never trigger automatic retries.
The preloaded wedding example remains outside the completed M7 polish scope. Adaptation preserves visual
identity best-effort; custom text layouts may need adjustment. The current project
persists in localStorage; image Blobs use IndexedDB.
Generated previews may crop artwork to preserve aspect ratio. Inspect results for
unwanted lettering and readable text space before applying.
Undo/redo retains up to 30 document operations during this session.

Text editing is limited to 50 elements/frame and 5,000 characters/element. Font
size is 8–512 logical px; width is 32–8192 px. Numeric size controls retain unsupported
or incomplete drafts locally; only valid values enter the document, and blur restores
the last valid value. Movement permits partial overflow
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

## API endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Service readiness; no credentials returned |
| `POST /api/ai/generate` | Validated artwork generation request |
| `POST /api/ai/adapt` | Validated reference-image adaptation request |

The server validates size and payload bounds and handles timeouts, concurrency and
rate limits. Provider details stay server-side; the editor shows concise errors.
See [generation](docs/AI_GENERATION.md) and [adaptation](docs/AI_ADAPTATION.md) for contracts.

## Environment variables and security

Use [server/.env.example](server/.env.example) as the configuration reference.
`AI_PROVIDER` selects Cloudflare or Gemini. Cloudflare uses `CLOUDFLARE_ACCOUNT_ID`,
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_IMAGE_MODEL`; the alternate uses `GEMINI_API_KEY`
and `GEMINI_IMAGE_MODEL`. `AI_TIMEOUT_MS`, `PORT`, `CLIENT_ORIGIN` and
`TRUST_PROXY_HOPS` control server operation. Optional client `VITE_API_BASE_URL`
selects a separate API origin; never put a credential in a `VITE_` variable.

Keep `.env` local and ignored. Tokens remain on the server and never enter the
project document or browser bundle. Saved designs are local to the browser;
clearing browser storage removes them. Exported PNGs contain the visible design.

## Deployment and live demo

Not deployed yet. Live frontend/API URLs and production verification will be added
after the deployment task. Current local setup and production-build test commands
above are usable now; no hosted availability is claimed.

## Source repository

[rohitpokhariya10/frameflow](https://github.com/rohitpokhariya10/frameflow)
