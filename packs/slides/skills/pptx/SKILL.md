---
name: pptx
description: "Presentation creation, editing, and analysis. Use when working with .pptx files: creating new presentations, modifying content, working with layouts, adding speaker notes, or any other presentation tasks."
license: MIT
compatibility: opencode
---

# PPTX creation, editing, and analysis

## Overview

A .pptx file is a ZIP archive containing XML files and resources. You have different workflows for different tasks.

## Reading and analyzing content

### Text extraction
```bash
python -m markitdown path-to-file.pptx
```

### Raw XML access
Unpack: `python tools/pptx/ooxml/scripts/unpack.py <office_file> <output_dir>`

Key files:
- `ppt/presentation.xml` — Main presentation metadata
- `ppt/slides/slide{N}.xml` — Individual slide contents
- `ppt/notesSlides/notesSlide{N}.xml` — Speaker notes
- `ppt/comments/modernComment_*.xml` — Comments
- `ppt/theme/theme1.xml` — Colors and fonts

**Note**: Run all commands from the `.opencode/` directory (or `~/.config/opencode/`).

## Creating a new presentation (html2pptx workflow)

### Design Principles
- Choose a color palette that matches the content and mood
- Use web-safe fonts: Arial, Helvetica, Times New Roman, Georgia, Courier New, Verdana, Tahoma, Trebuchet MS, Impact
- Create clear visual hierarchy through size, weight, and color
- Ensure strong contrast and readability

### Workflow
1. Read `html2pptx.md` for detailed syntax and formatting rules
2. Create HTML files for each slide (1280×720px for 16:9)
3. Use `<p>`, `<h1>`-`<h6>`, `<ul>`, `<ol>` for ALL text content
4. NEVER use manual bullet symbols (•, -, *)
5. Use `class="placeholder"` for chart/table areas
6. Convert to PPTX using `node tools/pptx/html2pptx_runner.js`
7. Validate with thumbnail grid: `python tools/pptx/thumbnail.py output.pptx`

### Critical Rules
- ALL text must be inside `<p>`, `<h1>`-`<h6>`, `<ul>`, `<ol>` tags
- NEVER leave bare text nodes in `<div>`
- Use `display: flex` on body
- Fonts: loaded via local `.woff2` files (`@font-face` from `_theme.css`) or Google Fonts CDN fallback
- NEVER use CSS `background-image` — use `<img>` with `object-fit: cover`

## Editing an existing presentation (OOXML)

1. Read `skills/pptx/ooxml.md` for detailed guidance
2. Unpack: `python tools/pptx/ooxml/scripts/unpack.py <file> <dir>`
3. Edit XML files in `ppt/slides/`
4. Validate: `python tools/pptx/ooxml/scripts/validate.py <dir> --original <file>`
5. Pack: `python tools/pptx/ooxml/scripts/pack.py <input_dir> <output.pptx>`

## Creating a presentation using a template

1. Extract template text: `python -m markitdown template.pptx`
2. Create thumbnail grids: `python tools/pptx/thumbnail.py template.pptx`
3. Analyze and create template inventory
4. Duplicate/reorder: `python tools/pptx/rearrange.py template.pptx working.pptx 0,34,34,50`
5. Extract text inventory: `python tools/pptx/inventory.py working.pptx text-inventory.json`
6. Generate replacement text JSON and apply: `python tools/pptx/replace.py working.pptx replacement.json output.pptx`

## Thumbnail Grids

```bash
python tools/pptx/thumbnail.py template.pptx [output_prefix] [--cols 4]
```

Features: 5 columns default, 30 slides per grid, 0-indexed slides.

## Code Style
- Write concise code, avoid verbose variable names
- Avoid unnecessary print statements

## Dependencies
- **markitdown**: `pip install "markitdown[pptx]"`
- **pptxgenjs**: `npm install pptxgenjs`
- **playwright**: `npm install playwright`
- **sharp**: `npm install sharp`
- **python-pptx**, **Pillow**, **defusedxml**: `pip install python-pptx Pillow defusedxml`
