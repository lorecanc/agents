# Design System Registry

Available design systems for the Slides Agent.

| Name | Has Fonts | Palette | Typography |
|---|---|---|---|
| `default-light` | No (Google Fonts) | Slate blue, white, amber accent | Inter + Merriweather |
| `default-dark` | No (Google Fonts) | Charcoal, dark blue, cyan accent | Inter + Merriweather |

## Usage

The agent resolves a design system in this priority order:
1. User explicitly requests one — e.g. "use the default-dark design system"
2. Query match — if topic/brand matches a system name
3. User preference from conversation context
4. Default: `default-light`

## Adding a design system

Create a directory under `.opencode/office/slides/design/<name>/` with:
- `colors.md` — palette token definitions, background-foreground rules
- `typography.md` — font families, weights, usage rules, `@font-face` definitions
- `fonts/` (optional) — `.woff2` font files for PPTX embedding; if absent, Google Fonts CDN fallback is used
