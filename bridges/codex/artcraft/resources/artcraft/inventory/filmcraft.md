# filmcraft

CLI: `filmcraft-cli mcp` · 17 tool · dumped 2026-11-21

- `command_batch` — Run several commands in order: {steps: [{id, params?}], stop_on_error?: true}. Returns {completed, failed, results: [{ok, result | error}]}; each edit is its own undo step.
- `command_list` — List every command (id, label, menu path, shortcut, parameter doc, enabled now). Menus, shortcuts, panels and timeline gestures all map to these ids.
- `command_run` — Run a command by id with JSON params, e.g. {"id":"timeline.razor","params":{"seconds":3.5}} or {"id":"effects.apply","params":{"effect":"Gaussian Blur"}}. Undoable edits land in History.
- `doc_inspect` — The project as JSON: the tree (as project_inspect) plus the active sequence (as sequence_inspect; null when there is none).
- `media_import` — Import media files by absolute path (MP4/MOV, WAV/MP3/FLAC/AIFF/Ogg, PNG/JPEG/…).
- `project_inspect` — Project tree (bins and items with ids, types, durations), active sequence, source clip.
- `render_frame` — Render the active sequence's frame (at `seconds` or the playhead) and return it as PNG.
- `render_preview` — The active sequence's frame at `seconds` (default: the playhead) as PNG, same as render_frame (bridge mode: Program monitor screenshot).
- `sequence_inspect` — The active sequence as JSON: settings, tracks, clips (ids, start/duration in ticks and frames, effects), transitions, markers, in/out, playhead, selection. 254016000000 ticks = 1 second.
- `ui_click` — Live app: click an element by id or at x,y (points). Supports right/middle button, double-click (count=2) and modifiers.
- `ui_control` — Live app: call any control-channel method directly (ui.set, ui.scroll, ui.timeline.hit, ui.timeline.locate, ui.playback, ui.panel.show, ui.menu.list, …).
- `ui_drag` — Live app: press-drag-release from one point/element to another (move clips, trim edges, scrub, resize panels, drop project items onto tracks).
- `ui_elements` — Live app: every on-screen interactive element with id, label and rect (points). Use ids with ui_click/ui_drag.
- `ui_inspect` — Live app: UI state (tool, workspace, panels, timeline zoom, playback, selection, fps).
- `ui_key` — Live app: press a key or shortcut (e.g. `Space`, `L`, `Cmd+K`, `Shift+Delete`, `Cmd+Z`).
- `ui_screenshot` — Live app: screenshot of the window or one panel (PNG).
- `ui_type` — Live app: type text into the focused field.
