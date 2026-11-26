---
name: artcraft
description: Route ambiguous or multi-app ArtCraft work to the appropriate app
  skills, coordinate deliverables between apps, or configure project MCP
  connections.
---

# ArtCraft

When the user names an app, load its skill directly. For an open-ended request, choose the app
that owns the editable deliverable. A report that reflows belongs in WordCraft, a fixed spread
with linked text frames in DesignCraft, and a correction to a supplied PDF in PDFCraft.

## Choose an app

Use the skill ID in the last column. The group names are shortcuts for project configuration.
Loading a skill reads its guidance. Enable connections when the user requests project setup.

| Deliverable or task | Group | MCP server | App skill |
|---|---|---|---|
| Word-processor documents | office | `wordcraft` | `artcraft-wordcraft` |
| Presentations and slides | office | `deckcraft` | `artcraft-deckcraft` |
| Page layout, print material | office | `designcraft` | `artcraft-designcraft` |
| Spreadsheets | office | `gridcraft` | `artcraft-gridcraft` |
| PDF editing | office | `pdfcraft` | `artcraft-pdfcraft` |
| Mail, calendar, contacts, tasks | office | `mailcraft` | `artcraft-mailcraft` |
| Image editing | visual | `photocraft` | `artcraft-photocraft` |
| Vector illustration | visual | `vectorcraft` | `artcraft-vectorcraft` |
| UI design, mockups, prototypes | visual | `figcraft` | `artcraft-figcraft` |
| Photo library, raw developing | visual | `lightcraft` | `artcraft-lightcraft` |
| Audio workstations | motion | `soundcraft` | `artcraft-soundcraft` |
| Video editing | motion | `filmcraft` | `artcraft-filmcraft` |
| Motion graphics, compositing | motion | `effectcraft` | `artcraft-effectcraft` |
| 2D animation | motion | `anicraft` | `artcraft-anicraft` |
| Parametric 3D CAD | 3d | `solidcraft` | `artcraft-solidcraft` |
| 2D/3D drafting, AutoCAD-style | 3d | `cadcraft` | `artcraft-cadcraft` |
| Procedural PBR materials | 3d | `materialcraft` | `artcraft-materialcraft` |
| 3D texture painting, baking | 3d | `texturecraft` | `artcraft-texturecraft` |
| Investigate software behavior or generate game assets | — | `craft-anything` | `artcraft-craft-anything` |

## Work across apps

Load each participating skill when its part begins. Choose an exchange format that preserves
what the receiving app needs to edit. For a retouched photo in a deck, export the selected image from PhotoCraft at the size
and transparency the slide needs. Place it in DeckCraft and check the crop in the rendered slide.
For a chart that must remain editable, carry GridCraft's checked values, series labels and units
into a native DeckCraft chart.

Use the connected server's descriptions for current parameters and units. Search its command
catalog if a dedicated tool is missing. After a partial batch, inspect what was applied before
retrying.

## Enable servers in a project

The pack defines its servers as disabled by default. When enabling servers for a project:

1. Select the requested server names, or expand the requested group using the Group column above.
   `all` includes every server, including `craft-anything`.
2. Read [the project server definitions](references/servers.json) relative to this skill.
   Replace every `<PROJECT_DIR>` in the selected objects with the absolute project root
   so file operations use the intended workspace.
3. In Codex, merge each selected server into the project's `.codex/config.toml` under
   `[mcp_servers."<server-name>"]`. Use the first element of the resolved command array as
   `command`, the remaining elements as `args`, and set `enabled = true`. Keep each automation
   root from the template. Preserve the other servers and project settings. From the project,
   check the configuration with `codex mcp list`, then start a trusted session and verify the
   selected server offers its tools in `/mcp`. To disable it, set `enabled = false`.
   For OpenCode, follow the steps below.
4. Merge those complete objects under `mcp.servers` in the project's `.opencode/opencode.json`,
   creating the file if needed. A project entry replaces the whole same-name server definition.
   Preserve unrelated configuration.
5. Run `opencode mcp list` from the project to check the selected connections. If the TUI has
   yet to pick up a new config, use `/reload`. For a startup failure, check the configured CLI
   on PATH and its startup message.
6. When asked to disable a server, set `"disabled": true` on its project entry, or remove the
   override to inherit the pack default.
