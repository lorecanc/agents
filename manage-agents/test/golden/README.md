# Golden export (phase 0 of the engine/catalog split)

`export-before.json` freezes what `manage-agents export --all --yes` installs today into an OpenCode config
directory, before the pack installer replaces it:

- `structure`: installed files, agent/command/skill/plugin IDs, `opencode.json` top-level keys, plugin entries and
  MCP server names. `golden.test.ts` re-runs the export into a throwaway `HOME`/`XDG_CONFIG_HOME` and requires the
  same structure.
- `hashes`: SHA-256 of every installed file. Not asserted by the test (content edits are legitimate); used for the
  byte-level comparison when the catalog is migrated to packs.

Refresh after an intentional structural change:

```sh
cd manage-agents && node --import tsx test/golden/inventory.ts capture
```

## Known exceptions in the current export

- `src/opencode.json` declares MCP servers, but the global export does not install them: only `plugins` are merged
  into the user's `opencode.json`, plus `experimental.todo`.
- `.resource-export-manifest.json` and `opencode.json.bak` are bookkeeping, excluded from the inventory.
- Agent prompts reference `~/.config/opencode/skills/*` with an absolute path; they break under a custom
  `XDG_CONFIG_HOME` or `--target`. The pack contract forbids this.
