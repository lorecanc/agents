# soundcraft

CLI: `soundcraft-cli mcp` · 17 tool · dumped 2026-11-21

- `list_commands` — List SoundCraft commands (id, label, menu path, shortcut, params doc, enabled).
- `execute` — Run one command by id with JSON params. Returns the command's result.
- `batch` — Run up to 1000 commands in order; stops at the first error unless keep_going. Larger batches are rejected before any command runs.
- `inspect_session` — The whole session as JSON: tracks (clips, inserts, sends, automation), busses, markers, groups, selection, transport.
- `new_session` — Start a new session (optionally the built-in demo).
- `open_session` — Open a .scraft session file.
- `save_session` — Save the session (path required the first time; replace: true to save over another existing file).
- `import_audio` — Import an audio file (WAV, AIFF, FLAC, MP3, OGG, AAC/M4A, ALAC, CAF) onto a new or existing track.
- `bounce_mix` — Render the mix to an audio file. Returns peak dBFS and integrated LUFS.
- `parity` — Feature-parity report against the incumbent's menu catalog.
- `screenshot` — APP_ONLY. Screenshot the app window (PNG).
- `ui_inspect` — APP_ONLY. UI state: front window, panels, layout rectangles of tracks, dialogs.
- `ui_set` — APP_ONLY. Set UI state fields, e.g. {"window": "Mix"}.
- `menu_invoke` — APP_ONLY. Invoke a menu item like a click (may open its dialog), e.g. "Track > New...".
- `click` — APP_ONLY. Click at window coordinates (points).
- `drag` — APP_ONLY. Drag with the primary button.
- `key` — APP_ONLY. Press a key with modifiers.
