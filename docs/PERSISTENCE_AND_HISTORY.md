# Local recovery and editor history

## Three separate kinds of state

The current `ProjectDocument` is small serializable metadata, so it uses
`localStorage` under `frameflow:project:v1`. UI state (selection, zoom, tabs,
save status) is separate. Image Blobs belong in IndexedDB and never enter the
document or history. Base64 would expand image data and consume limited synchronous
localStorage capacity; documents instead reference stable `assetId` strings.

## Restore and save

`bootstrapEditor` validates saved JSON before creating the store. The focused
version-1 runtime validator follows the existing project's handwritten validation
approach: required fields, known enums/fonts, finite numbers, canvas/text limits,
unique IDs, and optional metadata. Unknown fields are rejected. No new schema or
persistence dependency was required. Unsupported/corrupt data opens a valid blank
design with a dismissible warning and leaves the original stored value untouched
until the user makes a document edit.

A valid document restores before the editor renders. Selection is null, history
is empty, and normal font loading and canvas Fit still run. The first variant
becomes active; there is currently no variant-switching UI or persisted preference.

Only a changed document reference schedules a 500 ms debounced save. The top bar
shows `Saving…`, then `Saved on this device` only after `setItem` succeeds, or
`Could not save` on failure. A new edit retries a failed save. A fresh default
project is also saved. No cloud/backend persistence is implied. Undo and redo
trigger this same path, but their stacks are never serialized.

localStorage writes are synchronous and thus cannot complete out of order.
A monotonically increasing request token also invalidates superseded timers and
prevents an old completion from reporting a newer request as saved. Pending edits
flush on `pagehide` or when the page becomes hidden; forced process termination
can still lose edits inside the debounce window. UI-only actions do not save.

## Bounded snapshot history

`historyReducer` wraps the existing document reducer. An action that returns the
same document creates no entry. A meaningful change stores the previous immutable
snapshot, retains at most 30 past documents, and clears redo. Undo/redo restore
snapshots directly, including exact fitted geometry; they never run Auto Layout
again. Structural sharing avoids copying unchanged text/variants. Snapshots contain
JSON and asset IDs only, never Blobs or object URLs.

Canvas dimensions, add/edit/typography/move/resize, duplicate/delete, and Auto Layout
are undoable. Selection, tabs, zoom/Fit, focus, and save status are not. Invalid
selection is cleared when a history traversal removes the selected element.

Text content continues updating the canvas live. Consecutive content-only updates
to the same variant/element within one second coalesce into one undo step. Blur
ends the session explicitly; another document operation also separates it. This
is a small deterministic grouping policy, not a complete word-level text editor.
Native input/textarea/select/contenteditable shortcuts and IME are left alone.
Outside those controls, Cmd/Ctrl+Z undoes, Cmd/Ctrl+Shift+Z redoes (Ctrl+Y also works).

Drag and side-handle resize already commit only once on release, so each gesture
naturally creates one entry. Auto Layout's atomic action does the same. No history
entry is created for transient pointer movement.

## IndexedDB assets

`createAssetRepository` owns native IndexedDB details: database `frameflow-assets`,
version 1, `assets` store keyed by ID. Each record contains `id`, `blob`, `mimeType`,
and `createdAt`. Put resolves only after transaction completion. Get returns a
record or `null`; has returns a boolean; deleting a missing ID is safe. Open,
blocked, version, quota/write, and aborted-transaction failures reject so callers
can report failure without clearing the document. Connections close after use.

There is no runtime image renderer/cache yet, so no object URLs are created.
When introduced, URLs must remain outside Redux and be revoked on release. Future
image flows must await successful Blob storage before committing a document that
references it. The repository does not automatically delete assets: future cleanup
must consider the current design, every variant, previews, and undo history.
Missing assets do not invalidate usable text metadata; future background UI must
provide a missing-image message and recovery action.

Browser tests compile the actual repository into an isolated test context and use
native IndexedDB with a tiny local SVG fixture. They verify exact Blob bytes/MIME,
recovery across reload, deletion/missing results, open/version failures, write
failure, transaction abort, and preservation of the prior record. This proves local
asset infrastructure only; no live AI persistence is claimed.

## Scope and limits

One local project per browser origin; no cross-tab merge/conflict resolution,
cloud backup, storage migration, or persisted history. Multiple tabs use last
successful writer wins. Browser storage can be cleared or evicted. History is
bounded to 30 operations; the schema permits up to 30 variants, 50 text elements
per variant, and 5,000 characters per element. Milestone 5 AI work is not started.
