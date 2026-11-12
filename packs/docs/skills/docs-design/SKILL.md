---
name: docs-design
description: Document design principles — professional formatting, visual hierarchy, brand consistency, section structure, and layout patterns for A4 business documents.
---

## What I do

Guide the design of professional A4 documents: reports, proposals, contracts, memos, and documentation. Ensure visual hierarchy, brand consistency, and readability. Use the document design system (via `doc_compile_theme`) as the source of truth for colors and fonts.

## Design systems

Always resolve colors and fonts from a design system via `doc_compile_theme` instead of choosing them ad-hoc.

- `doc_compile_theme(projectName, designSystem)` resolves tokens from `.opencode/office/docs/design/<name>/colors.md` and `typography.md`
- Available systems: `default-light`, `default-dark`
- The tool writes `_theme.css` to the project and copies fonts to `assets/fonts/`
- **Copy the `_theme.css` contents into the document's `<head>` `<style>` tag**
- **Use resolved hex values (not `var()` references) in inline styles** — the DOCX converter does not resolve CSS variables

### Resolved tokens (use these concrete values in inline styles):

| Token | Used for |
|---|---|
| `COLOR_ACCENT` | Headers, section marks, table headers, callout borders |
| `COLOR_BG` | Page background |
| `COLOR_SURFACE` | Sidebar backgrounds, table alt-rows, callout backgrounds |
| `COLOR_TEXT_PRIMARY` | Body text |
| `COLOR_TEXT_SECONDARY` | Muted text, metadata |
| `COLOR_BORDER` | Table borders, section dividers |
| `FONT_DISPLAY` | Title / cover text |
| `FONT_HEADING` | Section headings (h2-h4) |
| `FONT_BODY` | Body text, tables |
| `FONT_MONO` | Code, labels, kickers |

### Utility classes (from compiled _theme.css):

- `.doc-header-band` — accent background header
- `.doc-sidebar` — surface background sidebar
- `.doc-callout` / `.doc-callout-accent` — highlight boxes
- `.doc-section-divider` / `.doc-section-divider-accent` — dividers
- `.doc-table-header` / `.doc-table-alt-row` — table styling
- `.doc-kicker`, `.doc-display`, `.doc-heading`, `.doc-mono`, `.doc-text-muted` — typography
- `.bg-accent`, `.bg-accent-secondary`, `.bg-surface`, `.bg-dark` — background context

## Design principles

1. **Visual Hierarchy**: Use typography (size, weight, color) to guide the reader through the document. Title > Section heading > Subsection > Body.
2. **Brand Consistency**: Apply consistent accent color from the design system for headers, section marks, table headers, and callouts. Use the same font family throughout.
3. **Scannability**: Use bullet lists, callout boxes, and short paragraphs. Readers scan before they read.
4. **Breathability**: Adequate margins (18–24pt), line spacing (1.15–1.5), and section spacing (8–14pt between sections).
5. **Structure**: Every document needs a clear header (title + subtitle + metadata), body sections with divider rules, and optional footer.

## Document types and their formats

| Type | Formatting |
|---|---|
| **Business Proposal** | Accent header band, sidebar for pricing/features, executive summary |
| **Report** | Section dividers, data tables with alternating row colors, chart callouts |
| **Contract** | Formal, section numbering, signature blocks |
| **Memo** | Compact, header band, no sidebar, direct style |
| **Documentation** | Clean, hierarchical TOC |

Fonts for each type are resolved from the design system — don't hardcode.

## Default design features

1. **Branded header band**: Top area with accent color (use `COLOR_ACCENT`), title 20–24pt, subtitle 11–12pt, metadata line 9.5–10.5pt in `COLOR_TEXT_SECONDARY`.
2. **Structured layout**: Prefer two-column or sidebar + main (30–35% sidebar, 65–70% main). Use tables for layout.
3. **Section hierarchy**: Headers with accent color + thin divider (1pt solid `COLOR_BORDER`). Consistent spacing.
4. **Highlight module**: At least one compact callout — 2×2 metric grid or key-points box using tables with background colors.
5. **Typography**: Body 11pt, muted text in `COLOR_TEXT_SECONDARY`, consistent bullet padding.
6. **Tables**: Clear borders (0.5–1pt), header row in accent color with white text (use `.doc-table-header`), alt-row shading (use `.doc-table-alt-row`).

## Image handling

- Images should be referenced as local paths (`assets/logo.png`) or web URLs.
- For documents, use `<img>` tags with explicit width/height or style `width:100%`.
- Charts: generate via matplotlib (SVG format), save to `assets/`, reference in HTML.
- Do not use CSS `background-image`.

## Cost control

- Hard ceiling of 3 consecutive modifications on the same document.
- Do not edit for cosmetic preferences or wording tweaks unless the user asks.
