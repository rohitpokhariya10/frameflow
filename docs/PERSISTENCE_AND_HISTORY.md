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
becomes active; the M6 version selector can switch to any restored variant. The
preference is not persisted.

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
Numeric inspector updates carry a unique focus-session ID in action metadata.
Font size, X, Y, and width update live but coalesce across pauses until blur or
another document operation. New fields/sessions cannot merge; action IDs are not
persisted. Undo/redo closes grouping, and no-ops still preserve redo.
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

M5/M6 decode artwork through temporary object URLs outside Redux and revoke the URLs
after decoding. Both operations await successful Blob storage before publishing previews
or committing a document that references the new asset. Applied/history assets are
retained. Only unapplied preview assets are deleted on discard/cancellation; general
orphan cleanup must account for every variant and history snapshot. Missing artwork
shows a recovery message while keeping usable text metadata. Adaptation reads the
source Blob without altering it, and stores output under a new asset ID.

Browser tests compile the actual repository into an isolated test context and use
native IndexedDB with a tiny local SVG fixture. They verify exact Blob bytes/MIME,
recovery across reload, deletion/missing results, open/version failures, write
failure, transaction abort, and preservation of the prior record. This proves local
asset infrastructure independently. M5/M6 separately verified real generated/adapted
artwork persistence, as recorded in implementation status.

## Scope and limits

One local project per browser origin; no cross-tab merge/conflict resolution,
cloud backup, storage migration, or persisted history. Multiple tabs use last
successful writer wins. Browser storage can be cleared or evicted. History is
bounded to 30 operations; the schema permits up to 30 variants, 50 text elements
per variant, and 5,000 characters per element. M5 generation and M6 reference
adaptation are implemented. Applying an adapted
variant is one history transaction; undo/redo restores document references without
provider calls. Source and target variants survive reload through schema v1.
