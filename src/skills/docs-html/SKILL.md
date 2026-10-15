---
name: docs-html
description: HTML document authoring rules for A4 page layout. Covers CSS constraints, layout patterns (sidebar, header band, callouts), typography defaults, and validation rules for DOCX conversion.
---

## What I do

Generate complete HTML documents (A4 format) that convert cleanly to DOCX. Use semantic HTML, table-based layouts, and design system tokens. No flex, no grid, no positioning.

## Design system integration

Before writing HTML, the parent agent MUST run `doc_compile_theme(projectName, designSystem)`. This:
1. Resolves color/font tokens from `.opencode/office/docs/design/<name>/`
2. Writes `_theme.css` to the project's `documents/` folder
3. Copies font files to `documents/assets/fonts/`

**Include the contents of `_theme.css` inside the document `<head>` `<style>` tag.**

**CRITICAL: Use resolved hex values in inline styles, NOT `var()` references.** The DOCX converter does not resolve CSS custom properties. Example:
```html
<!-- CORRECT — concrete values -->
<h1 style="color: #2563eb; font-family: 'Inter', sans-serif;">Title</h1>
<div style="background: #f8fafc;">Callout</div>

<!-- WRONG — var() references -->
<h1 style="color: var(--color-accent);">Title</h1>
```

## Core rules

1. **Return ONLY the complete HTML document** — no markdown fences, no explanations, no tool calls.
2. **Include compiled _theme.css** as a `<style>` block in `<head>` — this defines utility classes (`.doc-header-band`, `.doc-callout`, etc.) and CSS custom properties for browser preview.
3. **A4 page settings** via `@page` in `<head>`:
   ```html
   <style>
     @page { size: 210mm 297mm; margin: 6.35mm 8.47mm 7.06mm 8.47mm; }
     @media screen {
       body { margin: 0; background: #f3f3f3; }
       .page-screen { width: 794px; min-height: 1123px; margin: 0 auto; box-sizing: border-box; padding: 24px 32px 27px 32px; background: {{COLOR_BG}}; }
     }
   </style>
   ```
4. **Safe content width** = 794px − left_padding − right_padding (default: 794 − 64 = 730px).
5. **Use a single-cell wrapper table** (`width:730px; margin:auto`) to constrain content.
6. **Never use**: `display: flex/grid`, `position`, `float`, `::before/::after`, `#id selectors`, `background-image`, `box-shadow`, `border-radius`, `transform`, `em/rem/%/vh/vw` units.
7. **Typography defaults**: Use `FONT_BODY` at 11pt for body, `FONT_HEADING` for headings, `COLOR_ACCENT` for accent elements, `COLOR_TEXT_SECONDARY` for muted text.

## Design vocabulary

- **Header band**: Top area with accent color background, prominent title (20–24pt), optional subtitle, compact metadata (author/date). Use `.doc-header-band` or equivalent inline styles with `COLOR_ACCENT` background.
- **Sidebar**: Use a two-column table with ~30–35% sidebar width. Use `.doc-sidebar` class. **End the sidebar where sidebar content ends** — everything below flows full-width.
- **Section headers**: Use `FONT_HEADING`, accent color (`COLOR_ACCENT`), and a thin divider (`.doc-section-divider` or `.doc-section-divider-accent`).
- **Callout / highlight module**: Use `.doc-callout` (surface + accent left border) or `.doc-callout-accent` (accent background + white text). 2×2 metric tile grid or key-points box using tables with background colors.
- **Lists**: Use `<ul>`/`<ol>` with standard padding.
- **Tables**: Use `.doc-table-header` (accent bg + white text) for header rows, `.doc-table-alt-row` for alternating rows.
- **Kicker / labels**: Use `.doc-kicker` for mono uppercase labels.

## Layout patterns

| Content type | Layout |
|---|---|
| Title + metadata | Header band + single column |
| Summary + details | Two-column (sidebar + main) |
| Data-rich | Section headers + tables |
| Multi-section | Single column with divider rules |
| Charts + text | Full-width with centered images |

## Validation

Before returning HTML, verify:
- [ ] `_theme.css` contents are in a `<style>` block in `<head>`
- [ ] All colors/fonts use resolved hex values from the design system (not `var()`)
- [ ] `@page` with explicit size (210mm 297mm) and margins (mm) in `<head>`
- [ ] Content width matches page width minus margins
- [ ] No flex/grid/position/float CSS
- [ ] No `background-image`, `box-shadow`, `border-radius`, `transform`
- [ ] No `em`, `rem`, `%`, `vh`, `vw` units in CSS
- [ ] All text in semantic tags (`<p>`, `<h1>`–`<h6>`, `<ul>`, `<ol>`)
- [ ] Tables used for layout (not flex/grid)
  - [ ] Design system utility classes used where appropriate (.doc-header-band, .doc-table-header, etc.)
- [ ] No `var()` in inline styles — use resolved hex values

## Cross-compatibility with slides _theme.css

When the slide and document design systems share the same color/font tokens, these `_theme.css` utility classes are DOCX-safe and may be used:
- Typography: `.h-xl`, `.h-lg`, `.h-md`, `.h-sm`, `.b-lg`, `.b-md`, `.b-sm` (use inline `font-family` + `font-size` with resolved values instead of class names)
- Spacing: `.p-xs` through `.p-2xl`, `.px-*`, `.py-*`, `.pt-*`, `.mb-*` (ensure values are in pt, not em/rem)
- Surfaces: `.bg-accent`, `.bg-surface`, `.bg-dark` (with resolved hex inline)
- Text: `.text-accent`, `.text-secondary` (with resolved hex inline)

**Not DOCX-safe** (PPTX only):
- Layout: `.gd-row`, `.gd-col`, `.gd-*`, `.gd-sidebar-l/r`, `.gap-*`, `.items-*`, `.justify-*`
- Grid: `.z-safe`, `.z-bg`, `.z-grid-*`
