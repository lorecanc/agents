# Document Design System Registry

Available design systems for the Docs Agent.

| Name | Has Fonts | Palette | Typography |
|---|---|---|---|
| `default-light` | No (Google Fonts) | Slate blue, white, amber accent | Inter + Merriweather |
| `default-dark` | No (Google Fonts) | Charcoal, dark blue, cyan accent | Space Grotesk + Inter |

## Usage

The agent resolves a design system in this priority order:
1. User explicitly requests one — e.g. "use the default-dark design system"
2. Query match — if topic/brand matches a system name
3. User preference from conversation context
4. Default: `default-light`

## Adding a design system

Create a directory under `.opencode/office/docs/design/<name>/` with:
- `colors.md` — palette token definitions, background-foreground rules
- `typography.md` — font families, weights, usage rules
- `fonts/` (optional) — `.woff2` font files for DOCX embedding; if absent, Google Fonts CDN fallback is used

## How tokenized CSS works with DOCX

The DOCX converter (tinycss2) does NOT resolve CSS `var()` in inline styles.
The compiled theme provides:
1. **CSS custom properties** in `<style>` — for browser preview
2. **Concrete utility classes** (`.doc-accent`, `.bg-accent`, `.font-display`, etc.) — resolved by the converter
3. **Resolved token values** — agents use concrete hex values in inline styles
