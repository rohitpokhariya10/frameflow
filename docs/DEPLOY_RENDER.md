# Deploying FrameFlow on one Render Free web service

FrameFlow runs as **one Node.js web service**: the React frontend and the Express backend share one process, one port and one public URL. `npm run build` builds `shared`, then the client (`client/dist`), then the server (`server/dist`). `npm start` runs `server/dist/index.js`, which listens on Render's `PORT` at `0.0.0.0` and serves:

- `/api/…`: every backend route, including:
  - `/api/health`;
  - `/api/layerize-experiment/…`: offer and product templates, Reuse Template, Create Offer Creative, uploads, decomposition, editor handoff and exports;
  - `/api/template-studio/…`.

  A missing API route answers a JSON 404.
- `/assets/…` and the other built files from `client/dist`; a missing file answers 404.
- every other address (`/`, page refreshes, client-side views): `index.html`.

The frontend calls the API with relative `/api/…` addresses, so there is no second service, no CORS setup and no `VITE_API_BASE_URL`. Local development is unchanged: Vite on 5173 proxies `/api` to the server on 3001.

## Dashboard settings

**New → Web Service**, connect the GitHub repository, then:

| Field | Value |
| --- | --- |
| Repository | `rohitpokhariya10/PL-Testing` |
| Branch | `main` |
| Language | Node |
| Root Directory | *(blank)* |
| Build Command | `npm ci && npm run build` |
| Start Command | `npm start` |
| Instance Type | **Free** |
| Health Check Path *(Advanced)* | `/api/health` |
| Auto-Deploy *(Advanced)* | Your choice; with "On Commit", every push to `main` redeploys and clears saved files |

Node 22 comes from `.nvmrc`. To pin it in the dashboard as well, add `NODE_VERSION=22`.

### Environment variables

| Key | Value | Notes |
| --- | --- | --- |
| `NODE_ENV` | `production` | Production behaviour. `.npmrc` keeps the build tools installed although this also applies to the build |
| `LAYERIZE_EXPERIMENT` | `1` | Turns on the template, decomposition and Template Studio APIs; without it those routes don't exist |
| `TRUST_PROXY_HOPS` | `1` | Render's proxy, so per-visitor limits see the real address |
| `FRAMEFLOW_ACCESS_PASSWORD` | *a long random secret* | **Required before adding any AI key.** The browser asks for it once (user name `frameflow`, or `FRAMEFLOW_ACCESS_USER`) |
| `OPENAI_API_KEY` | *secret, optional* | Template analysis, AI Art Director, planning and image generation |
| `FAL_KEY` | *secret, optional* | Seedream Layerize decomposition and segmentation |

**Leave unset:**
- `CLIENT_ORIGIN`: the server uses `RENDER_EXTERNAL_URL`, the exact `https://<name>.onrender.com` address Render sets. If you set `CLIENT_ORIGIN`, it must be exactly that address, or your custom domain.
- `FRAMEFLOW_DATA_DIR`: there's no disk on Free; if set anyway, it is ignored with a warning.
- `VITE_API_BASE_URL`.
- `DECOMPOSITION_ENABLED`.
- `PORT`: Render sets it.

Without `OPENAI_API_KEY` and `FAL_KEY`, the free features still work (templates, uploads, local text recognition, the free arrangement, the editor, export), and AI features report themselves unavailable. No paid call is possible then.

## Security of paid AI endpoints

The app has no user accounts, and its template, decomposition and AI routes start paid OpenAI and fal work. Every paid operation is a `POST`. Three layers protect them:

1. **Access password.** With `FRAMEFLOW_ACCESS_PASSWORD` set, every page, asset and API request needs it; only `/api/health` stays open. It is HTTP Basic over Render's HTTPS: the browser asks once and sends it with the app's own requests. An address with 20 failed attempts in 15 minutes is refused until they expire.
2. **Fail-safe.** A production server that holds a paid key (`OPENAI_API_KEY`, `FAL_KEY`, `GEMINI_API_KEY` or `CLOUDFLARE_API_TOKEN`) but no access password refuses every API request that changes something (`403 ACCESS_PASSWORD_REQUIRED`). A forgotten password setting cannot open paid work to visitors.
3. **Origin rules.** Requests that change something must come from the app's own address (`RENDER_EXTERNAL_URL` or `CLIENT_ORIGIN`), so other websites can't drive the API from a visitor's browser.

Spending is also capped by Template Studio's budgets (`STUDIO_MAX_JOB_BUDGET_USD`, `STUDIO_MAX_TEMPLATE_BUDGET_USD`, `STUDIO_DAILY_BUDGET_USD`; defaults 1, 1 and 5 USD), and the product flows ask for cost approval before each paid step. Anyone who knows the password can still approve paid work, so share it only with the people meant to use it.

## Render Free limits

- **Saved files are temporary.** Free has no persistent disk. Templates, uploads, creatives, decomposition runs and Template Studio data are written to the service's own folder (`artifacts/`) and are lost whenever the service restarts, redeploys or spins down. The log says so at startup: `FrameFlow storage: No persistent disk …`. Use it for testing; keep originals elsewhere.
- **Spin-down.** A Free service stops after about 15 minutes without traffic, and the next visit waits for it to start again (often a minute). That restart also clears saved files and stops any job in progress.
- **Small machine.** 512 MB of memory and a fraction of a CPU. Text recognition, large uploads and image processing are slow, and very large images may run out of memory. Free instance hours are limited per month.
- **Client material.** Confidential templates should not be uploaded to a temporary, publicly reachable service. Uploads stay protected by the access password, but nothing is backed up.

## Later: keeping files (paid)

To keep saved files, the service needs a paid instance type (Starter or higher) plus a persistent disk. The disk is billed per GB each month; see Render's pricing. Then:
1. Add a disk with **Mount Path** `/var/data` (10 GB or more; local data is about 2.4 GB today).
2. Add `FRAMEFLOW_DATA_DIR=/var/data/frameflow`.

All file stores then live under `/var/data/frameflow/artifacts/…`, using the same layout as the repository's local `artifacts/` folder, so a local folder can be copied over as it is. Render applies these limits to a service with a disk:
- it runs as one instance;
- each deploy briefly stops it;
- the disk exists only while the service runs, not during the build.

Nothing in the code has to change.

## Checking a deployment

- `https://<name>.onrender.com/api/health` → `{"status":"ok", …}`, with no password needed.
- Opening `https://<name>.onrender.com/` asks for the user name `frameflow` and the access password, then shows the app.
- The log shows `FrameFlow server: … (data: …/artifacts; access: password required (FRAMEFLOW_ACCESS_PASSWORD))`, and on Free the storage warning.

The same production setup can be tried locally without paid calls (no keys set):

```sh
npm ci && npm run build
NODE_ENV=production PORT=10000 LAYERIZE_EXPERIMENT=1 CLIENT_ORIGIN=http://127.0.0.1:10000 \
  FRAMEFLOW_ACCESS_PASSWORD=try-it npm start
```

Then open `http://127.0.0.1:10000` and sign in as `frameflow` / `try-it`.
