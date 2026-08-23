---
name: slides-theming
description: "Design system resolution and theme compilation workflow for the Slides Agent. Resolves tokens from .opencode/office/slides/design/, compiles _theme.css, handles local fonts vs Google Fonts CDN fallback."
license: MIT
compatibility: opencode
---

# Slides Theme Resolution

## Resolution Priority

When creating a new presentation, resolve the theme in this order:

1. **User explicitly requests a design system** — use it directly
2. **Topic/brand matches a system name** — e.g. "tech startup deck" → `default-dark`
3. **User preference from conversation** — e.g. "I prefer dark themes" → `default-dark`
4. **Context-appropriate default**: `default-dark` for tech/modern topics, `default-light` for corporate/formal

## How to apply a theme

Call the `slide_compile_theme` tool:

```
slide_compile_theme(
  projectName: "my_pitch",
  designSystem: "default-light", // from .opencode/office/slides/design/default-light/
  themeMode: "light",           // optional, defaults to light
  tokens: {}                    // optional overrides
)
```

The tool:
1. Reads `colors.md` + `typography.md` from `.opencode/office/slides/design/<name>/`
2. **Built-in systems** (`default-light`, `default-dark`): uses hardcoded token maps
3. **Custom systems**: parses the markdown files to extract brand colors and font families, maps them to standard tokens
4. If `fonts/` directory exists → copies `.woff2` files to `assets/fonts/` and generates `@font-face` declarations in `_theme.css`
5. If no `fonts/` → includes a note to use the Google Fonts CDN `<link>` in slide `<head>`
6. Injects brand-specific interaction classes (`bg-base-red`, `bg-supp-teal`, etc.) from the design system's `colors.md`
7. Includes semantic slide component classes (`.stat-value`, `.slide-card`, `.slide-badge`, `.timeline-dot`, `.timeline-line`, `.icon-circle`, etc.)
8. Writes `_theme.css` to the project

## What `_theme.css` contains

A single, complete CSS file that every slide reuses:

| Section | Content |
|---|---|
| Design tokens | `--color-bg`, `--color-accent`, `--font-display`, etc. |
| Canvas + base elements | h1-h6, p, ul, ol, body |
| Utility classes | `.bg-accent`, `.bg-surface`, `.kicker`, `.label`, `.display`, `.mono` |
| `@font-face` | Injected if fonts/ exists |
| Brand interaction classes | Custom systems: `bg-base-red`, `bg-supp-teal`, etc. |
| Semantic components | `.stat-value`, `.slide-card`, `.slide-badge`, `.timeline-dot`, `.timeline-line`, `.icon-circle`, etc. |

**Slides must NOT redefine anything in `_theme.css`** — they only add slide-specific positioning CSS.

## Available design systems

Check `.opencode/office/slides/design/index.md` for the current registry.

### Built-in defaults

| System | Mode | Accent | Style |
|---|---|---|---|
| `default-light` | Light | Blue `#2563eb` | Corporate, professional |
| `default-dark` | Dark | Cyan `#22d3ee` | Tech, modern |

### Custom / brand systems

Any directory under `.opencode/office/slides/design/` (except `default-*`) is a brand design system. These must have `colors.md` and `typography.md` files. The tool parses them to extract brand tokens.

## Custom tokens

To override specific tokens without a full design system, use `default-light` as base and pass overrides:

```
slide_compile_theme(
  projectName: "my_pitch",
  designSystem: "default-light",
  tokens: {
    COLOR_ACCENT: "#e60000",
    COLOR_BG: "#000000",
    FONT_DISPLAY: "Space Grotesk"
  }
)
```

## Google Fonts CDN injection

When the design system has no `fonts/` directory, add the CDN `<link>` to every slide's `<head>`. The `slide_compile_theme` output will include the appropriate CDN snippet.

For systems with local fonts, do NOT add Google Fonts CDN links — the `@font-face` declarations reference local `./assets/fonts/` paths and are already in `_theme.css`.
