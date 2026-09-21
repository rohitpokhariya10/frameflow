# FrameFlow — FreshFolks Assessment Master Brief

**Purpose:** Build a polished, focused design editor for the FreshFolks practical assessment.

**Deliverables:** A working live application, complete source code, and a short explanation of the approach.

**Document status:** Implementation specification. Features described here are requirements, not claims that an application has already been built or tested.

## 1. How to use this file with Codex

Place this file in the project root. Give Codex the following instruction:

> Read `FreshFolks-Assessment-Master-Brief.md` completely and use it as the project specification. Inspect the existing repository and its instructions first. Implement the application in the milestone order below, starting with the first incomplete milestone. Make actual code changes, run the relevant checks, and continue through the remaining milestones where access and credentials allow. Preserve working code. Explain important decisions briefly and maintain `IMPLEMENTATION_STATUS.md` with completed work, verification results, remaining work, and blockers. Do not stop after producing a plan. If Gemini credentials or deployment access are unavailable, finish all independent work, clearly identify the blocked live checks, and never substitute a mock result for a successful integration.

The implementation should be understandable enough for the candidate to explain in an interview. Keep the code focused, the behavior real, and the presentation intentional.

## 2. What FreshFolks actually requested

| Assessment requirement | Required implementation | Evidence a reviewer can observe |
| --- | --- | --- |
| Select poster, banner, or custom dimensions | Presets and validated custom width/height | Canvas and exported dimensions match the selection |
| Add text | Heading, subheading, and body actions | Newly added text is editable and selected |
| Move and position elements | Dragging plus numeric position controls | Coordinates remain correct at different zoom levels |
| Resize text | Width reflow and font-size controls | Text changes predictably without distorted glyphs |
| Place elements inside a frame | Frame-aware rendering and boundary handling | Elements stay recoverable and overflow is visible in the UI |
| Auto Layout for overflowing text | Measured wrapping, repositioning, and bounded font reduction | A long venue name fits without losing words |
| Generate a themed image/design | A real Gemini integration behind the backend | The user's prompt produces new artwork |
| Adapt the same design to another format | Reference-image recomposition plus deterministic text reflow | Portrait and landscape retain the theme and exact editable wording |
| Share the completed assessment | Live URL, source repository, explanation | A reviewer can run and assess the complete flow |

FreshFolks did not ask for a full Canva clone. The quality of these interactions matters more than feature count.

## 3. Product idea and scope

**Product name:** FrameFlow.

**Product promise:** Create a design, fix overflowing text, and adapt it to another format while keeping the content editable.

The three memorable interactions should be:

1. A long venue name visibly overflows; **Auto Layout** fixes it cleanly.
2. **Adapt format** turns a portrait design into a related landscape composition while preserving every text string.
3. The user compares the two versions, returns to either, and exports a clean image.

### Priority rules

| Priority | Scope |
| --- | --- |
| P0 — assessment requirements | Canvas sizing, text creation/editing/positioning/resizing, real Auto Layout, real AI generation, reference-based adaptation, complete submission |
| P1 — submission polish | Cohesive UI, local recovery, undo/redo, PNG export, one editable example, source/result comparison, useful loading and error states |
| P2 — only after P0 and P1 pass | Inline text editing, simple snapping, project-file import/export, additional example styles |

P1 items are proposed product improvements, not additional requirements attributed to FreshFolks. Implement them after the two core capabilities work.

Do not build accounts, payments, teams, collaboration, a template marketplace, a server database, arbitrary shape tools, image filters, video editing, or a full layer-management system. A small text-element list for selecting canvas content is sufficient.

## 4. The central architecture decision

Compose the final design from two parts:

- **AI artwork:** The background, illustration, decorative motifs, lighting, texture, and visual style.
- **Editable text:** Names, dates, venue, headings, and supporting copy rendered as native canvas text elements.

This is how the application preserves content reliably. The model should not be responsible for reproducing an exact venue address inside a flattened image.

The generation panel accepts a visual-theme prompt and optional structured event details. Event details become editable elements. Do not require a second AI call to extract details from prose. Tell users to put exact wording in the content fields; leave unspecified fields empty.

For example, generate floral wedding artwork and overlay:

- Eyebrow: `Together with their families`
- Title: `Aarav & Meera`
- Date: `12 December 2026 · 7:00 PM`
- Venue: `The Grand Royal Wedding Palace, Connaught Place, New Delhi, India`

These are fictional demonstration details. Do not insert them into an unrelated user design automatically.

When adapting, recompose the artwork using the current background as a visual reference. Separately lay out copies of the editable text in the target frame. Text content must remain exactly equal; visual similarity of generated artwork remains best effort and must be checked in the preview.

## 5. Technology choices

Preserve the stack proposed in the supplied brief unless a concrete compatibility issue requires a documented change.

| Area | Choice | Reason |
| --- | --- | --- |
| Frontend | React, TypeScript, Vite | Focused application with fast local iteration |
| State | Redux Toolkit | Shared document, properties, selection, and history |
| Canvas | Konva and react-konva | Rendering, selection, dragging, and resize handles |
| Styling | Tailwind CSS, selected shadcn/ui primitives, Lucide | Accessible controls with a custom visual system |
| Backend | Node.js, Express, TypeScript | Small server for validated AI requests and secrets |
| AI | Gemini through the official JavaScript SDK | Initial artwork and image-conditioned adaptation |
| Validation | Shared runtime schemas, such as Zod | Consistent API and saved-document validation |
| Document persistence | localStorage | Small, serializable project metadata |
| Image persistence | IndexedDB behind a small asset repository | Browser-local image blobs without filling localStorage |
| Tests | Vitest and focused Playwright flows | Layout/state correctness plus real browser interactions |

Use compatible stable dependency versions, commit the lockfile, and document the supported Node version. Do not scatter version guesses or provider-specific code throughout the project.

**Clarification of the original persistence proposal:** Keep localStorage for document JSON. Use IndexedDB only for image blobs. It is browser storage, not a backend database or account system. Do not store full generated images as base64 strings in localStorage.

## 6. Visual direction

Build a creative editor that opens directly into a usable workspace. Avoid a marketing landing page or a generic dashboard.

Use a calm, editorial visual identity: warm neutrals, a deep green accent, crisp controls, restrained shadows, and a generous canvas area.

| Token | Starting value |
| --- | --- |
| Application chrome | `#F8F8F5` |
| Panels | `#FFFFFF` |
| Workspace | `#EEEDE8` |
| Primary text | `#1F2925` |
| Secondary text | `#626C65` |
| Border | `#E0E4DE` |
| Primary action | `#285443` with white text |
| Selected surface | `#ECF4EF` |
| Error | `#B42318` |

These are design starting points; check contrast in the implemented UI. Use a consistent spacing scale, approximately 8 px control radii, and short, restrained transitions. Respect reduced-motion preferences.

Use a neutral sans-serif for controls and a locally bundled editorial serif option for poster text. Include the font licenses. Load actual font weights instead of relying on accidental browser synthesis.

### Workspace structure

| Region | Contents |
| --- | --- |
| Top bar | FrameFlow, project name, dimensions, undo/redo, save status, Export |
| Left panel | Design, Text, and AI tabs |
| Canvas area | Centered frame, zoom/fit controls, overflow indicators, selection |
| Right panel | Selected text content, typography, position, Auto Layout |
| Compact version switcher | Original and adapted variants; Compare action |

Suggested desktop sizes: 56 px top bar, 248 px left panel, and 280 px right panel. Treat these as responsive layout tokens, not fixed requirements that cause overlap.

At 1366 × 768, the editor must feel comfortable. Around 1024 px, collapse one panel into a drawer. On narrow screens, provide a readable preview and accessible panel toggles or a clear desktop-editing message; a full mobile editor is outside scope.

The initial state shows a blank poster with visible **Add heading**, **Create with AI**, and **Open wedding example** actions. Loading an example must not silently overwrite an existing project.

## 7. Canvas and element behavior

### Presets

| Preset | Logical size | Aspect ratio |
| --- | --- | --- |
| Poster | 1080 × 1350 | 4:5 |
| Square | 1080 × 1080 | 1:1 |
| Landscape banner | 1600 × 900 | 16:9 |
| Story | 1080 × 1920 | 9:16 |
| Custom | Validated user dimensions | Computed |

Start with dimensions from 256 to 4096 pixels per side and a maximum area of 12 million pixels. These are application limits chosen to bound rendering and export memory, not provider limits. Reject blank, fractional, negative, nonfinite, and out-of-range values with inline feedback.

Store all document coordinates in logical canvas pixels. Zoom changes the viewport only. Convert pointer coordinates through the inverse stage transform; never save screen coordinates as document positions.

Keep artwork clipped to the frame. Draw selection handles and overflow feedback in an editor overlay that is excluded from export. Allow partial overflow while editing, but clamp dragging so at least a small selectable part remains in view. The element list and numeric controls must let users recover every element.

Changing dimensions locally and AI adaptation are different operations:

- **Resize canvas:** Apply local frame changes, preserve text, and flag any remaining overflow. Existing artwork uses a preview fit policy. No AI request is implied.
- **Adapt format:** Generate recomposed artwork and create a new, editable target variant.

### Text controls

Users can add heading/subheading/body text, select, drag, edit, resize, recolor, change alignment, change font family/weight, duplicate, and delete.

Use the right-panel textarea as the dependable editing path. Inline editing is optional polish after the core flow passes. Text typed in an input must never trigger global Delete, Backspace, or canvas shortcuts.

Define resize behavior explicitly:

- Side handles change text-box width and reflow text without changing font size.
- Font-size controls change the size of the glyphs.
- Corner handles, if shipped, scale width and font size uniformly, then normalize the result. Disable them until this behavior is correct.
- Rotation and vertical stretching are outside the initial scope.

Konva transforms change scale values. Convert the result into the intended document width/font size, normalize node scale back to 1, and commit one document action at the end of the gesture. Derive text height from measurement; do not independently stretch it.

Keep transient drag/resize state in the interaction layer. Commit meaningful results to Redux on completion. A drag should produce one undo step, not hundreds.

## 8. State and data contracts

Keep the document separate from UI state and runtime resources. The following types describe the important boundaries; refine them without introducing unnecessary abstraction.

```ts
type TextRole = 'eyebrow' | 'title' | 'date' | 'venue' | 'body' | 'custom';

interface TextElement {
  id: string;
  type: 'text';
  role: TextRole;
  text: string;
  x: number;
  y: number;
  width: number;
  fontFamily: string;
  fontSize: number;
  fontWeight: 400 | 600 | 700;
  fill: string;
  align: 'left' | 'center' | 'right';
  lineHeight: number;
  letterSpacing: number;
}

interface DesignVariant {
  id: string;
  name: string;
  revision: number;
  canvas: { width: number; height: number; backgroundColor: string };
  elements: TextElement[];
  background?: {
    assetId: string;
    fit: 'cover' | 'contain';
    focalPoint: { x: number; y: number }; // Normalized 0..1.
  };
  sourceVariantId?: string;
  generation?: {
    mode: 'live' | 'example';
    model?: string;
    promptUsed: string;
    sourceAssetId?: string;
    requestedAspectRatio: string;
    returnedWidth: number;
    returnedHeight: number;
  };
}

interface ProjectDocument {
  schemaVersion: 1;
  id: string;
  name: string;
  originalPrompt?: string;
  styleBrief?: {
    theme: string;
    palette: string[];
    motifs: string[];
    mood: string;
  };
  variants: DesignVariant[];
  createdAt: string;
  updatedAt: string;
}
```

Store selected element, active variant, zoom, active tab, open dialogs, and request status separately. Persist the active variant preference if useful, but do not make selection and panel changes undoable document edits.

Element IDs can remain the same across adapted variants and are scoped to their variant. This makes content-preservation checks straightforward. Names, date, and venue live in the text elements; do not maintain a second conflicting copy in AI metadata.

Never put Konva nodes, DOM nodes, image elements, blobs, object URLs, promises, or AbortControllers in Redux or saved JSON. Keep runtime images and object URLs in an asset cache keyed by `assetId`.

Suggested boundaries:

- `editorSlice`: project document and document operations.
- `uiSlice`: selection, active variant, panels, and viewport.
- `aiSlice`: request status and small request metadata.
- History utility: bounded document snapshots or patches; asset IDs only.

Use selectors and typed hooks. Keep persistence and network calls outside reducers.

## 9. Auto Layout: the core algorithm

### Contract

Auto Layout operates on the selected text element and a target rectangle. For normal editing, the target is the safe canvas region. For adaptation, it can be a smaller reserved text region.

It must preserve the exact text string, including explicit paragraph breaks. Wrapping is a presentation result; do not rewrite the content to insert or remove words.

```ts
type LayoutResult =
  | { status: 'unchanged'; element: TextElement }
  | {
      status: 'fitted';
      element: TextElement;
      changes: Array<'wrapped' | 'widened' | 'moved' | 'font-reduced'>;
    }
  | { status: 'unresolved'; element: TextElement; reason: string };

// Keep the algorithm testable by injecting the measurement adapter.
// fitText(element, targetBounds, options, measureText): LayoutResult
```

### Measurement rules

Wait for the relevant fonts before measuring. Use the same font family, loaded weight, size, line height, letter spacing, width, and wrapping policy as the renderer.

An offscreen Konva text measurement adapter is an appropriate implementation. Use public APIs, no fixed clipping height, and no dependency on private internal text arrays. Share wrapping decisions with rendering or verify the final candidate using the renderer. Do not estimate text width from character count.

Support explicit newlines and long unbroken tokens. If custom splitting is necessary, preserve grapheme clusters so emoji and combined characters are not cut apart. Validate the actual fonts and scripts the application claims to support.

### Deterministic fitting strategy

1. Validate the input and measure its current rendered bounds.
2. If it already fits the target rectangle, return `unchanged`.
3. Calculate a preferred width bounded by the available region. If the box is extremely narrow, allow widening before shrinking text.
4. Try a small, deterministic set of widths: the bounded preferred width, then the full available width. At the original font size, wrap and measure each candidate.
5. If a candidate fits, clamp its x/y inside the target rectangle. Repositioning should solve a near-bottom or near-right problem before reducing font size.
6. If no candidate fits, search for the largest fitting font size at the full usable width. Use a bounded binary search or an equivalent finite search; preserve line height.
7. Re-measure the chosen result, including rounding tolerance, and verify that all edges fit.
8. If readable text cannot fit, return `unresolved` and keep the original element unchanged. Offer a larger frame or shorter copy; never delete content or pretend the operation succeeded.
9. Apply a successful result as one undoable operation.

Starting constants, in logical pixels:

```text
SAFE_MARGIN = clamp(round(min(canvasWidth, canvasHeight) * 0.04), 12, 96)
AUTO_FONT_FLOOR = clamp(round(min(canvasWidth, canvasHeight) * 18 / 1080), 10, 32)
EFFECTIVE_FONT_FLOOR = min(originalFontSize, AUTO_FONT_FLOOR)
FIT_TOLERANCE = 1
```

For adaptation, calculate the readable floor from the target canvas, not from the tiny reserved rectangle. Do not enlarge an intentionally smaller existing font merely to meet a floor.

Use named constants and document the reason for limits. Begin with at most 50 text elements and 5,000 characters per element to bound pathological inputs.

### Invariants

- The input is not mutated.
- No text is lost, truncated, or replaced with ellipses.
- The result is finite and has positive dimensions.
- A successful result lies inside its target rectangle within the tolerance.
- Repeating Auto Layout on a fitted result makes no further change.
- No AI request is made.
- Single-element fitting does not claim to solve collisions with unrelated elements. Template adaptation supplies separate text regions for that purpose.

### Interaction feedback

Show **Auto Layout** whenever text is selected. Derive an overflow warning from measured bounds, including content that would be visually clipped.

After fitting, display factual feedback such as `Wrapped and moved inside the frame` or `Font reduced from 48 to 42`. If unchanged, say `This text already fits`. If unresolved, retain the original and show the reason with a useful next action.

## 10. AI generation

The AI panel contains a prompt, theme suggestions, format selection, optional content fields, and a primary **Generate design** button.

Use simple status states: idle, generating, ready, and error. Provide a cancel action, retry, and a visible explanation of failures. Do not invent percentage progress or provider processing stages.

### Generation sequence

1. Validate the prompt and chosen canvas dimensions.
2. Prepare the target text layout and identify a quiet region for copy.
3. Send the visual prompt, style brief, target format, and quiet-region description to the backend.
4. Generate decorative artwork without event wording baked into it.
5. Validate and decode the returned image, record its real dimensions, and store it as an asset.
6. Show the composed preview with editable text over the artwork.
7. Apply the preview only through an explicit user action. Preserve an existing design until then.

Suggested original prompt template:

```text
Create background artwork for an editable {theme} design.
Visual direction: {userVisualPrompt}.
Palette: {palette}. Motifs: {motifs}. Mood: {mood}.
Target format: {targetAspectRatio}.
Reserve {quietRegionDescription} as calm, low-detail space for text.
Keep decorative elements away from that region.
Do not add event wording, letters, logos, or signatures to the artwork.
```

This is an application prompt, not a guarantee of model compliance. Preview the result and allow regeneration if unwanted lettering or decoration interferes with readability.

## 11. Adapt the design to a new format

The **Adapt format** flow must preserve the source variant and create a new target variant.

### Required sequence

1. Capture the source variant ID and revision, exact text elements, current artwork, and original style brief.
2. Choose the target dimensions and calculate a deterministic target text layout.
3. Send the source artwork bytes as a visual reference, together with the style brief and target composition instructions.
4. Receive new artwork and assemble it with the reflowed editable text.
5. Display source and result side by side at their natural aspect ratios.
6. Show any unresolved layout issues. Do not hide them behind a success message.
7. On **Use this version**, save the new variant in one history transaction. Keep the original available.

Suggested adaptation prompt:

```text
Recompose the supplied reference artwork for a {targetAspectRatio} design.
Preserve its visual identity, palette, subject, decorative motifs, and mood.
Original visual brief: {originalPromptAndStyleBrief}.
Rearrange the composition to suit the new frame and reserve
{targetQuietRegionDescription} for editable text added by the application.
Extend or rearrange the artwork naturally. Avoid stretching or losing the
main subject. Do not add event text, lettering, logos, or signatures.
```

### Text recomposition policy

Use a small set of hand-authored layout rules; a general design engine is outside scope.

| Format | Text arrangement | Artwork direction |
| --- | --- | --- |
| Portrait/story | Centered vertical stack with separate eyebrow, title, date, and venue regions | Decorative border/corners; calm center |
| Square | Compact centered stack with balanced whitespace | Motifs around the perimeter |
| Landscape/banner | Text stack in the right portion, with appropriate left alignment | Main decorative composition toward the left |

Express the reserved regions as normalized rectangles and convert them to target logical pixels. Run the same Auto Layout engine inside each region. Regions must not overlap.

Preserve font family, weight, color, and every text string. Resize typography to retain hierarchy and legibility. A semantic role used more than once needs separate ordered subregions; do not stack duplicates on top of each other.

For custom text elements, first map their normalized positions and widths into the target frame, then fit them to safe bounds. Detect overlaps and flag them for adjustment when necessary. Do not claim arbitrary multi-element layouts are automatically perfect.

### Exact dimensions and provider limitations

The canvas size and generated image size are separate concepts. The provider may support named aspect ratios and resolution tiers rather than arbitrary pixel dimensions. Choose supported settings, read the actual returned dimensions, and compose onto the exact target canvas.

For a custom ratio, choose the nearest supported ratio using a documented policy, such as minimizing the absolute log-ratio difference. Use aspect-preserving cover or contain in the preview. Prefer contain or regeneration if cover would remove a main subject. Never stretch the image.

A crop alone must not be presented as AI adaptation. If the configured model cannot perform reference-image editing, show an unavailable/error state and choose a supported model before marking the integration complete.

### Race conditions

Track a request ID plus source project/variant/revision. Cancelling, opening another project, or changing the source must prevent a late response from silently replacing current work. Keep a valid result as a separately labelled preview when practical, or discard it safely.

Cancelling the UI request does not guarantee that the provider has stopped processing or charging. Do not automatically repeat expensive generation requests after an ambiguous timeout.

## 12. Backend and API contracts

Keep the backend small: routes, validation, a controller/service boundary, a Gemini provider adapter, and centralized errors. Do not build a generic multi-provider framework.

### Endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Server health and a nonsecret AI-availability flag |
| `POST /api/ai/generate` | Generate artwork for a theme and target format |
| `POST /api/ai/adapt` | Recompose supplied reference artwork for a target format |

Example application contracts below are not Gemini SDK payloads. The provider adapter translates them into the currently supported SDK shape.

```ts
interface GenerateRequest {
  prompt: string;
  target: { width: number; height: number };
  styleBrief: {
    theme: string;
    palette: string[];
    motifs: string[];
    mood: string;
  };
  quietRegion: { x: number; y: number; width: number; height: number };
}

interface AdaptRequest extends GenerateRequest {
  referenceImage: {
    mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
    base64: string;
  };
}

interface ImageResponse {
  requestId: string;
  image: {
    mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
    base64: string;
    width: number;
    height: number;
  };
  generation: {
    mode: 'live';
    model: string;
    requestedAspectRatio: string;
    promptUsed: string;
  };
}

interface ApiError {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    requestId: string;
  };
}
```

`quietRegion` uses normalized coordinates and must lie inside `[0, 1]` on both axes. The backend validates dimensions, chooses the provider ratio, and builds the final instructions. Do not trust the frontend to enforce provider constraints.

Base64 is acceptable as a bounded transport format for this small project. Decode it immediately in the asset layer; do not retain it in Redux or persist it in the document. The adapt endpoint receives bytes from the client's asset repository, so it does not depend on temporary server files surviving a restart.

### Validation and operational behavior

- Require a nonblank visual prompt, with a configurable maximum around 2,000 characters.
- Bound every style field and validate finite dimensions and normalized regions.
- Accept only supported raster MIME types. Inspect decoded file signatures and dimensions rather than trusting the label alone.
- Set explicit request-body, decoded-image, and pixel-count limits. For example, an 8 MiB reference limit needs a larger JSON body limit because base64 expands the payload.
- Do not accept arbitrary image URLs or create a general-purpose URL-fetching proxy.
- Keep the Gemini key on the server. Never use a `VITE_` variable for a secret.
- Add a small per-client rate limit and a bounded number of simultaneous provider calls. Configure proxy trust correctly for the chosen host.
- Keep the public demo within a configured provider budget/quota. Do not automatically generate on page load.
- Use configurable request timeouts compatible with the host. Explain timeout failures and let the user choose whether to retry.
- Log request ID, duration, outcome, and safe error details. Avoid logging image payloads, keys, or complete user prompts.
- Abort provider requests when supported; ignore stale client responses regardless.

Map errors deliberately: invalid input, oversized image, missing configuration, quota/rate limit, timeout, provider refusal, and a response with no usable image. A text-only provider response is not a successful image generation.

Keep failed generation or adaptation from clearing existing work. Provide useful UI messages, such as `The image service is temporarily unavailable. Your design is unchanged.`

### Provider configuration

Use an environment-controlled image-capable model. The official image documentation checked on 21 September 2026 includes `gemini-3.1-flash-image`, the `@google/genai` SDK, image input, and output aspect-ratio controls. Verify availability for the actual account before implementation and recheck if building later.

Do not mix request fields from different Gemini API surfaces. Follow the current official example for the chosen SDK route, type-check it, and run a real generation-and-adaptation smoke test. Keep the mapping isolated in `geminiProvider.ts`.

Suggested environment example:

```dotenv
# Server only. Fill the key outside source control.
GEMINI_API_KEY=
GEMINI_IMAGE_MODEL=gemini-3.1-flash-image
PORT=3001
AI_TIMEOUT_MS=120000

# Required only if the frontend uses a different origin.
CLIENT_ORIGIN=http://localhost:5173

# Public frontend setting. No secret values here.
VITE_API_BASE_URL=/api
```

The model name is a verified starting point, not a permanent guarantee. Document the model actually tested. Do not invent access, pricing, or free quota.

## 13. Local saving and recovery

Use a small persistence service with a versioned schema and debounced saves, approximately 500 ms after meaningful changes. Do not save on every pointer movement.

Store document JSON in a key such as `frameflow:project:v1`; save blobs separately in IndexedDB under stable asset IDs.

For a document containing a new image:

1. Write the image blob successfully.
2. Persist the document referencing its asset ID.
3. Mark the matching document revision as saved.

Serialize save operations so an older asynchronous save cannot mark a newer document as saved. A failed metadata write may leave an orphan asset, but must not replace the last valid document with a broken reference.

On startup, validate the schema, restore the document, resolve images, recreate runtime object URLs, and wait for fonts before showing final layout measurements.

Handle malformed JSON, unsupported schema versions, unavailable browser storage, quota failures, and missing assets. Preserve usable text and show an actionable message when an image cannot be recovered.

Use truthful status labels: `Saving…`, `Saved on this device`, and `Could not save`. This is device-local persistence; do not imply cloud synchronization. Browser storage can be cleared or evicted.

Do not delete an asset still referenced by the current document, another variant, an active preview, or undo history. Clean only proven unreferenced assets. Revoke object URLs when their runtime resources are released.

## 14. Undo, export, and keyboard behavior

### Undo and redo

Use a bounded history, initially around 30 document operations. Include text changes, drag/resize commits, Auto Layout, applying AI results, and applying adapted variants.

Group a text-editing session sensibly. Selection, panel changes, hover state, and zoom should not fill history. Never copy image blobs into history snapshots. Undoing AI work changes document references; it must not make a new provider call.

### PNG export

Export the active variant at its exact logical canvas dimensions, independently of viewport zoom and device pixel ratio. Render through a dedicated export stage or equivalent clean scene derived from the document.

- Wait for fonts and image decoding.
- Include the background and all intended text.
- Exclude selection, grid, warnings, helpers, and panel UI.
- Use same-origin or locally decoded assets so canvas export is not tainted.
- Avoid a viewport screenshot as the export implementation.
- Keep pixel limits explicit to prevent accidental memory exhaustion.
- Use a filename such as `frameflow-wedding-1600x900.png`.

### Keyboard and accessibility

Support Delete/Backspace, Escape, undo/redo, and small arrow-key nudges when the canvas selection owns focus. Do not intercept typing, contenteditable behavior, IME composition, or browser shortcuts unnecessarily.

Provide labelled controls, visible focus, useful tooltips, dialog focus management, and an accessible element list. Canvas content must also be selectable and editable through normal DOM controls. Announce request completion and errors without excessive live-region updates.

## 15. Code organization

Use one repository with npm workspaces or an equally simple arrangement. Avoid adding a heavy monorepo framework.

| Location | Responsibility |
| --- | --- |
| `client/src/features/editor/` | Editor shell and document actions |
| `client/src/features/canvas/` | Stage, text nodes, selection, coordinate conversion |
| `client/src/features/text/` | Add-text actions and properties controls |
| `client/src/features/ai/` | Prompt form, request states, generation/adaptation previews |
| `client/src/features/variants/` | Version switcher and source/result comparison |
| `client/src/components/ui/` | Small shared controls |
| `client/src/store/` | Typed store, slices, selectors, history |
| `client/src/lib/layout/` | Auto Layout, measurement adapter, template regions |
| `client/src/lib/assets/` | Blob repository and runtime image cache |
| `client/src/lib/persistence/` | Validation, loading, saving, migrations |
| `client/src/lib/export/` | Clean document-to-PNG rendering |
| `client/src/services/` | Typed application API client |
| `server/src/routes/` | API routing |
| `server/src/services/` | Generation/adaptation orchestration |
| `server/src/providers/geminiProvider.ts` | All Gemini-specific mapping |
| `server/src/middleware/` | Validation errors, limits, central error handling |
| `server/src/config/` | Validated environment settings |
| `shared/` | Small shared schemas and API/document types |
| `tests/e2e/` | Reviewer-critical browser flows |
| `docs/` | Architecture notes, evidence, and submission notes |

Keep `App.tsx` small. Avoid blanket `any`, disabled type checking, reducer side effects, unexplained magic numbers, and duplicated layout logic.

Provide root scripts for `dev`, `build`, `start`, `typecheck`, `lint`, `test`, and `test:e2e`. The README must state exactly what each runs.

## 16. Build milestones and exit conditions

Work in vertical increments. Create visible loading/error states with the related feature, rather than leaving all state handling until the final day.

| Milestone | Build | Exit condition |
| --- | --- | --- |
| 0. Repository review | Inspect existing code/instructions, choose compatible packages, create status file | Setup decisions and commands are documented; existing work is preserved |
| 1. Editor foundation | Workspace shell, visual tokens, canvas presets, custom sizes, zoom-to-fit | A correctly sized frame works at laptop widths |
| 2. Text editing | Document state, text creation, selection, drag, width resize, typography controls | All text operations behave correctly at two zoom levels |
| 3. Auto Layout | Measurement adapter, overflow detection, fit algorithm, feedback | Long venue, edge placement, and impossible-fit cases pass |
| 4. Local recovery | Blob repository, versioned saves, history | Edits and artwork survive refresh; undo/redo restores valid states |
| 5. AI generation | Express API, validation, provider adapter, preview/apply flow | One real image can be generated and used; failures preserve the design |
| 6. Adaptation | Reference-image request, target text layout, variant preservation, compare | Real portrait-to-landscape adaptation preserves exact text and related artwork |
| 7. Presentation polish | PNG export, editable example, keyboard handling, responsive panels | The complete reviewer journey works without coaching |
| 8. Release | Focused tests, README, screenshots, deployment, fresh-browser verification | Live URL, source URL, and truthful submission notes are ready |

Prepare the blob persistence path at milestone 4 using local fixtures; connect live assets at milestone 5. Do not wait for a paid API call to validate storage or canvas behavior.

After each milestone, update `IMPLEMENTATION_STATUS.md` with the completed behavior, commands/checks run, concrete results, and remaining blockers. Continue to the next milestone when its prerequisites are met.

## 17. Verification that matters

Use targeted tests for the risky behavior. Avoid large test suites that merely repeat the implementation or snapshot generic controls.

### Auto Layout tests

| Case | Required result |
| --- | --- |
| `Wedding` already fits | No change |
| `The Royal Wedding Celebration` in a narrow region | Natural wrapping without lost text |
| Full long venue from the example | Fits in safe bounds at a readable size |
| Text near the right edge | Repositioned/wrapped inside the frame |
| Text near the bottom | Moved up before unnecessary font reduction |
| Extremely narrow box that overflows | Widened when space allows; avoids needless single-letter columns |
| Newlines and a long unbroken token | Content preserved and overflow handled |
| Supported emoji/combined characters | No broken grapheme splitting |
| Text too large to fit at the minimum | Explicit unresolved result; original retained |
| Run Auto Layout twice | Second result unchanged |
| Empty text | Safe no-op |

Unit-test the pure fitting logic with a measurement adapter. Add browser checks using the actual loaded fonts and renderer; mocked character widths alone cannot prove that text fits visually.

### Integration and browser checks

- Add, edit, drag, width-resize, duplicate, and delete text; verify correct undo grouping.
- Repeat placement at two zoom levels and after a viewport resize.
- Refresh a project containing an image and edited text; verify content and assets restore.
- Reject invalid dimensions, unsupported image input, and oversized payloads.
- Exercise missing key, provider refusal, quota failure, timeout, and no-image responses.
- Start adaptation, change the source or cancel, and verify a late response cannot overwrite work.
- Assert source and target text strings are identical, keyed by element ID, after adaptation.
- Verify source and target variants remain independently editable.
- Export while zoomed out and check exact PNG dimensions and absence of selection UI.
- Confirm keyboard shortcuts do not delete text elements while editing a textarea.

Mock the provider in automated tests and label those tests as mocked. Separately record one real generation and one real reference-based adaptation using the configured model. A mock test cannot satisfy the live integration gate.

For visual continuity, inspect palette, motifs, subject, event mood, readable text regions, and composition. Do not replace this with an invented numerical similarity score.

Review screenshots at 1440 × 900 and 1366 × 768. Verify the panel-collapse behavior around 1024 px. Fix clipping, hidden actions, poor contrast, and accidental scrollbars.

## 18. Demonstration flow

Prepare a short demonstration that makes the engineering visible. Allow for real provider latency; do not promise a fixed completion time.

1. Open the app and choose the portrait poster preset.
2. Open the editable wedding example or add the example copy manually.
3. Move the long venue close to the right/bottom edge so the overflow indicator appears.
4. Click **Auto Layout** and show the text wrapping inside the safe region.
5. Undo and redo the operation once to demonstrate reliable state handling.
6. Generate fresh wedding artwork from an edited prompt and apply it.
7. Choose **Adapt format → Landscape banner**.
8. Compare the portrait and landscape compositions; point out the unchanged names, date, and venue.
9. Use the landscape version and edit its venue to prove it remains editable.
10. Export a 1600 × 900 PNG, then refresh to demonstrate local recovery.

The bundled example lets reviewers explore the editor immediately. Label it `Example design`. If a prerecorded AI result is available for comparison, label it as an example too. Keep real generation clearly separate and never switch to examples silently after a provider failure.

If credentials are missing during development, the editor and labelled examples can still work. The assessment's live AI functionality remains incomplete until a real generation/adaptation pair has passed.

## 19. Deployment and submission

### Deployment plan

Prefer one Node deployment serving the built Vite frontend and `/api` from the same origin, provided the host supports the required runtime and request duration. This keeps configuration small. Use a Vite development proxy locally.

If the chosen host requires separate services, configure the frontend API base URL and an exact backend CORS allowlist. Do not hardcode a localhost URL in the production build.

Store the provider key in the host's server environment. Commit `.env.example`, ignore actual secrets, and confirm the browser bundle and network responses do not expose the key.

Check the production host's current request timeout and memory limits before selecting it. Use a host compatible with the actual image-generation flow; only introduce a job queue if a demonstrated hosting constraint requires it.

Before submission, open the live URL in a fresh browser session and run the core editor, generation, adaptation, refresh, and export flow. Verify production asset loading, API routing, and errors. Do not invent a deployed URL or claim deployment succeeded without checking it.

### Repository deliverables

- Complete frontend, backend, shared types, and lockfile.
- Setup instructions and `.env.example` without secrets.
- `README.md` with features, architecture, local commands, live link, and limitations.
- `IMPLEMENTATION_STATUS.md` showing actual completion and verification.
- `docs/APPROACH.md` explaining Auto Layout, AI adaptation, storage, and trade-offs.
- A few screenshots and, if practical, a short demo recording with real/example states clearly identified.
- Tests covering the critical behavior above.

### README content

Include the live URL and a quick-start near the top. Explain:

1. What the application does and how to try the core flow.
2. The frontend, state, canvas, backend, and provider boundaries.
3. How text is measured, wrapped, repositioned, and reduced only when necessary.
4. Why AI artwork and editable text are separate.
5. How reference-based adaptation and target text regions preserve continuity.
6. Why browser-local persistence fits this assessment.
7. How to run, test, configure, and deploy the application.
8. What was tested live, what was mocked, and what remains limited.

Document honest limitations: artwork similarity is best effort; arbitrary custom layouts may need manual adjustment; browser storage is local; provider availability and latency vary. Only list limitations that actually apply to the delivered implementation.

### Short approach explanation template

Use this only after verifying that it matches the implemented application:

> I built FrameFlow around the two main assessment flows: a text editor with deterministic Auto Layout, and AI-assisted adaptation between design formats. React, Redux Toolkit, and Konva manage the editor, while an Express service keeps the Gemini integration and API key on the server. Auto Layout measures text, wraps it, repositions it inside the available region, and reduces font size only when necessary. AI generates decorative artwork; event wording stays in editable text layers. Adaptation uses the existing artwork as a reference and reflows those text layers into the target composition, preserving the exact content. I used browser-local document and image storage to keep the project focused on the editor. The submission includes the source code, setup instructions, verification notes, and a live demo.

Submission fields to fill with real values:

| Field | Value to provide after completion |
| --- | --- |
| Live application | Verified deployed URL |
| Source code | Repository URL with working reviewer access |
| Demo recording | Optional real recording URL |
| Approach | Short explanation matching the implementation |
| Limitations | Concrete remaining limitations, if any |

## 20. Definition of done

The project is submission-ready only when all applicable items below are verified:

- [ ] Preset and custom canvas sizing work with correct logical dimensions.
- [ ] Text can be added, selected, edited, moved, resized, and deleted.
- [ ] Dragging and selection remain correct at different zoom levels.
- [ ] Auto Layout solves the long-venue scenario without deleting content.
- [ ] Already-fitting and impossible-fitting text receive truthful outcomes.
- [ ] A real Gemini request generates usable artwork from a user prompt.
- [ ] A real adaptation uses reference artwork and creates a related target composition.
- [ ] Every editable text string is preserved exactly during adaptation.
- [ ] Source and target remain available and editable.
- [ ] No stretching or simple crop is misrepresented as AI adaptation.
- [ ] Failures and late responses cannot destroy or overwrite current work.
- [ ] Document and image recovery work after refresh.
- [ ] Undo/redo and exact-size PNG export work.
- [ ] Example content and mock tests are clearly distinguished from live AI behavior.
- [ ] Type checking, build, and relevant tests pass without unresolved critical errors.
- [ ] The live site works from a fresh browser session.
- [ ] The repository, README, explanation, and real submission links are ready.

If a required capability is blocked, record it plainly. Do not mark the project complete because its UI is finished.

## 21. Engineering rules for Codex

1. Implement the requested behavior in working code; avoid decorative controls without actions.
2. Preserve the approved stack and scope unless a concrete issue justifies a change.
3. Read existing repository instructions and inspect existing work before editing.
4. Keep domain logic testable and separate from rendering and network side effects.
5. Use real text measurement and a finite fitting algorithm.
6. Keep authoritative content in editable text layers.
7. Use the source image during AI adaptation; do not quietly replace that flow with prompt-only regeneration.
8. Make asset handling, async races, and persistence explicit.
9. Explain important trade-offs briefly enough for interview preparation.
10. Verify core behavior before adding optional features.
11. Continue through independent work when an external dependency is blocked; identify the exact blocker and never invent successful checks.
12. Report what changed, how it was checked, and any remaining limitation after each milestone.

The intended result is a focused application whose interactions, code, and explanation all demonstrate an understanding of FreshFolks' actual product problem.

## 22. Official implementation references

Checked on **21 September 2026**. Revisit the provider documentation at implementation time because SDK payloads and model availability can change.

- [Gemini image generation and editing](https://ai.google.dev/gemini-api/docs/image-generation): Current SDK examples, image input, supported output configurations, and model selection.
- [Konva text resizing](https://konvajs.org/docs/select_and_transform/Resize_Text.html): Scale normalization when changing text-box width.
- [Konva React Transformer](https://konvajs.org/docs/react/Transformer.html): React integration for selection and transform handles.
- [Konva high-quality export](https://konvajs.org/docs/data_and_serialization/High-Quality-Export.html): Canvas export and pixel-ratio controls.
- [MDN browser storage quotas and eviction](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria): Storage limits, quota errors, and browser-local persistence behavior.

The layout algorithm, component boundaries, UI direction, and scope in this file are project-specific design decisions. The references support implementation details; they do not guarantee a hiring outcome or claim the application has been completed.
