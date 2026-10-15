---
name: docx
description: DOCX document creation, editing, and conversion. Covers HTML-to-DOCX conversion, auto-versioning with snapshot backups, multi-format export (PDF/MD/TXT), and file layout conventions.
---

## What I do

- **Design system compilation**: `doc_compile_theme` resolves color/font tokens from `.opencode/office/docs/design/` and writes `_theme.css` + copies fonts to the project.
- **HTML → DOCX conversion**: Uses python-docx with full inline CSS support (fonts, colors, borders, padding, margins, alignment, background colors). Handles tables (colspan, border-collapse, column widths), images (local, URL, data URI, SVG rasterization), lists (ul/ol with nesting), and page geometry (A4/Letter, margins from @page CSS).
- **Font embedding**: Font files from `documents/assets/fonts/` are automatically embedded in DOCX exports (`.woff2`, `.ttf`, `.otf`). Font families are registered in the font table for cross-platform fidelity.
- **Auto-versioning**: Every DOCX export is auto-versioned (report.docx, report_v2.docx, report_v3.docx). Each export gets a companion `.snapshot.html` for rollback.
- **Multi-format export**: PDF via weasyprint, Markdown via html2text, TXT via BeautifulSoup.
- **File layout**: Projects live under `projects/<name>/documents/` with `.source.html` as the canonical source.

## Key tools

- `doc_compile_theme` — compile design system tokens into _theme.css + copy fonts (run FIRST)
- `doc_create` — create .source.html from HTML + validation + preview
- `doc_convert` — convert .source.html to DOCX/PDF/MD/TXT (embeds fonts automatically)
- `doc_modify` — edit via search_and_replace or line operations
- `doc_view` — view document source
- `doc_list` — list documents with export info
- `doc_restore` — restore from DOCX snapshot

## File layout

```
projects/<project_name>/documents/
  _theme.css                    Compiled design system theme
  <doc_name>.source.html        Canonical source
  <doc_name>.docx               Export (auto-versioned, fonts embedded)
  <doc_name>.docx.snapshot.html Version history snapshot
  <doc_name>_v2.docx
  <doc_name>.pdf                PDF export
  <doc_name>.md                 Markdown export
  <doc_name>.txt                TXT export
  assets/
    fonts/                      Font files (copied by doc_compile_theme)
      BaikalExp-Medium.woff2
      ...
    logo.png
```

## Workflow

1. `doc_compile_theme(projectName, designSystem)` — resolve colors/fonts
2. Design and write HTML document using resolved token values + utility classes
3. `doc_create(projectName, documentName, "html", content)` — validate + save
4. `doc_convert(projectName, documentName, "docx")` — convert (fonts auto-embedded)
5. Optionally: `doc_convert(projectName, documentName, "pdf")` for PDF

## Conversion notes

- **CSS support**: Tables (flex→2col, border-collapse), images (base64, local, URL, SVG→PNG), @page (A4/Letter, margins), inline styles, class-based styles via tinycss2, lists (ul/ol), page breaks (Playwright auto-detection).
- **Unsupported**: Flex/grid positioning, floats, pseudo-elements, advanced selectors, background-image, gradients, box-shadow, border-radius, transform, em/rem/vh/vw units.
- **Validation**: Run `doc_create` which validates HTML against the unsupported-CSS list before saving.
