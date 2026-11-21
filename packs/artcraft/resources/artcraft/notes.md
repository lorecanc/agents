# ArtCraft suite — install context and version snapshot

Human-facing reference for the pack's content. The skills carry the workflow knowledge; this file
carries how the suite gets onto a machine and which versions the pack was authored against.

## Install

- 17 apps come from the ArtCraft APT repository (`deb https://getartcraft.com/apt stable main`,
  signing key published on artcraftwiki.com). `sudo apt update && sudo apt upgrade` updates them.
- `solidcraft` (Tangency Labs) and `mailcraft` (UCS Care Group) are not in APT: install from their
  GitHub release tarballs (`*-linux-x86_64.tar.gz`, verify `SHA256SUMS.txt`) into `~/.local/bin`.
- Every CLI must be on `PATH` for the MCP definitions (bare command names) to start. A missing CLI
  surfaces as a failed server startup in `opencode mcp list`.
- The CLIs are headless: no window opens when an agent drives them.

## Version snapshot (2026-11-21, Ubuntu 26.04)

| App | Version | Tools | Notes |
|---|---|---|---|
| anicraft | 0.2.1 | 5 | |
| cadcraft | 0.20.1 | 12 | |
| craft-anything | 0.6.1 | 30 | fal.ai asset budget |
| deckcraft | 0.18.1 | 25 | |
| designcraft | 0.20.1 | 26 | needs automation roots |
| effectcraft | 0.24.1 | 27 | needs automation roots |
| figcraft | 0.18.1 | 19 | |
| filmcraft | 0.20.1 | 17 | |
| gridcraft | 0.19.1 | 22 | |
| lightcraft | 0.21.1 | 17 | `--compact`; `catalog.lock` vs desktop app |
| mailcraft | 0.13.0 | 20 | tarball install |
| materialcraft | 0.4.1 | 20 | needs automation roots |
| pdfcraft | 0.21.1 | 208 | largest server |
| photocraft | 0.23.1 | 26 | needs automation roots; repeatable read roots |
| solidcraft | 0.44.1 | 23 | tarball install; fast release cadence |
| soundcraft | 0.20.1 | 17 | needs automation roots; `APP_ONLY` tools |
| texturecraft | 0.6.1 | 22 | needs automation roots |
| vectorcraft | 0.24.1 | 33 | |
| wordcraft | 0.18.1 | 18 | |

Total: 19 servers, 587 tools. Regenerate `inventory/` after upgrading:
`python3 tools/artcraft/inventory.py` from the pack root.

## Maintenance rules

- `skills/artcraft/references/servers.json` is the single source used to enable servers: no
  `disabled`, automation-root placeholders, and `"codemode": false` (catalog policy — the flow
  and pipeline agents deny the Code Mode `execute` tool). The pack's `opencode.json` holds the
  same commands with `"disabled": true` and no automation roots. Change both together.
- The servers speak line-delimited JSON-RPC (ndjson) on stdio, not LSP Content-Length framing.
  `mcp-smoke.py` in this directory speaks it; use it to verify an install
  (`python3 mcp-smoke.py <path/to/opencode.json>`).
- The V2 config field is `disabled` (`true` = configured but not connected). An `enabled` field is
  ignored by OpenCode V2.

## Third-party per-app skills

The community repo `midasmatterhorn/artcraft-skills` publishes one skill per app (19 total), each
pinned to an app release. This pack ships its own workflow-oriented `artcraft-<server>` skills. When using a
community skill, check its release pin against the installed app.
