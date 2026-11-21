# anicraft

CLI: `anicraft-cli mcp` · 5 tool · dumped 2026-11-21

- `anicraft_commands` — Lists the commands anicraft_run accepts: id, label, menu, shortcut, a summary of their params, and whether they change the document. Optionally only those whose id or label contains `filter`.
- `anicraft_run` — Runs one command (see anicraft_commands) with its params and returns its result, plus the document revision and current frame. Commands that would lose work or replace a file need "confirm": true in params.
- `anicraft_run_script` — Runs commands in order and returns each result. Stops at the first error and says which step failed; the steps before it stay done (undo them with edit.undo).
- `anicraft_document` — The open document: stage size and frame rate, scenes, the current scene's layers and keyframes, library symbols, and the current scene, frame, layer and selection.
- `anicraft_render` — A frame of the current scene as a PNG picture, exactly as exported. `frame` is 0-based (default: the current frame); `scale` defaults to 0.5 of the stage size.
