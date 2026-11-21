# photocraft

CLI: `photocraft-cli mcp` · 26 tool · dumped 2026-11-21

- `command_batch` — Run several engine commands in one call, in order (fewer round trips). Returns {completed, failed, results:[{ok, result|error}]}; stops at the first error unless stop_on_error is false. Not an atomic transaction: earlier successful steps stay applied (no rollback).
- `command_list` — List engine commands. Returns a JSON array (no wrapper object) of {id, label, menu: [path], shortcut: string|null, params: doc string, enabled: bool, disabledReason: string|null, needsDocument: bool}. `disabledReason` says why a command is off (null when enabled); `needsDocument` is true when it is off because no document is open: create or open one first (doc_new, doc_open).
- `command_run` — Run an engine command by id with JSON params (see command_list). Returns the command's JSON result. Long commands (filters, Content-Aware Fill/Scale, Photomerge, brush import) wait to finish unless `wait` is false: then they run as a background job and the result is {job: id} (see jobs_list, jobs_cancel). A waited long command reports progress, cancelling the request cancels it, and other calls are served meanwhile.
- `control_call` — Bridge mode: call any control-protocol method (docs/control-protocol.md) with raw params.
- `doc_close` — Close a document (default: the active one) without saving.
- `doc_export` — Export the document to another format (same as doc_save with an explicit path/format).
- `doc_export_data_sets` — Export every data set of the document as its own flattened file beneath the write root (the capability-scoped Export Data Sets). The batch is planned first, so colliding filenames are refused before any file is written.
- `doc_export_layers` — Export top-level layers as files (groups merged). Returns files and skipped: [{layer, name, reason}] for hidden layers (visible_only) and adjustments with no pixels of their own. Workspace exports resolve beneath the write root, also return count of written files, and reject existing files instead of overwriting them. Trusted-local/bridge exports use the engine command's file access policy.
- `doc_import_data_sets` — Import a data set CSV from the read root into the document (the capability-scoped Import Variable Data Sets).
- `doc_inspect` — Document state as JSON: layer tree (top to bottom), history, selection, active layer.
- `doc_new` — Create a new document (defaults: 1920x1080 RGB 8-bit white).
- `doc_open` — Open an image or document file and make it active. Returns index, size and import warnings.
- `doc_place` — Place a file into the document as a Smart Object layer (Place Embedded), reading `path` beneath the read root. `scale` (percent), `fit`, `center` and `approve_high_memory` (one-shot PSD/PSB consent, default false) are the command's own.
- `doc_render_preview` — Render the flattened document and return it as a PNG image (bridge mode: window screenshot).
- `doc_replace_smart_object` — Replace a Smart Object's contents with the file at `path` beneath the read root, keeping its transform and filters (the capability-scoped Replace Contents). `layer` is the Smart Object's id or name (default: the active layer).
- `doc_save` — Save the document. `.pcraft` is the lossless native format (incremental); other extensions (psd, png, jpg, tif, webp, exr, …) export. Without `path` only a PSD, PSB or .pcraft document is written back to its own file. `pcraftFullComposite` requests `composite/full.png`, which may be omitted; check the manifest's `full_composite` member. Returns warnings about anything the format cannot hold.
- `doc_select` — Make the document at `index` active.
- `jobs_cancel` — Cancel a background job by id (or every running job when `job` is omitted). The document is left unchanged.
- `jobs_list` — List background jobs: running ones with progress (0-1), message and elapsed time, then the last few that ended (state done|failed|cancelled with their result or error). Finished jobs are applied first.
- `render_preview` — Render a bounded flattened PNG preview (bridge mode: app window screenshot).
- `session_list` — List open documents (index, name, size, dirty) and the active index.
- `ui_inspect` — Bridge mode: full UI state of the live app (tool, panels, views, dialogs, windows). For the menu tree, call `control_call` with method `ui.menu.list`.
- `ui_menu_invoke` — Bridge mode: activate a menu item by id.
- `ui_pointer` — Bridge mode: send pointer events (document coordinates) to the active tool; with a Color Picker open they sample the image into it instead.
- `ui_screenshot` — Bridge mode: screenshot of the live app window as PNG.
- `ui_set` — Bridge mode: change UI state (tool, panels, dock, zoom, center, fit, theme, brush settings; see `fields`). Unknown fields are an error.
