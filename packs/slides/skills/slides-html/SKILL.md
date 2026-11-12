---
name: slides-html
description: "HTML slide authoring rules for the slides-html-writer subagent. Covers layout, design vocabulary, technical requirements, and validation rules for 1280×720 slide HTML documents."
license: MIT
compatibility: opencode
---

# Slide HTML Authoring

> **Base skill**: This is the canonical reference for slide HTML rules. The `slides-template-html` skill inherits all rules from this document and adds only template-specific constraints (spatial contracts, data-bg resolution, placeholder preservation).

## Core Rule
Return ONLY the complete HTML document — no markdown fences, no explanations, no tool calls.

## Styling stack

Every slide uses this fixed stack:

| File | Purpose |
|---|---|
| **_theme.css** (primary) | All layout, typography, spacing, colors — the single CSS source |
| **_preset.css** (optional) | Decoration classes (compiled from slides-composition) |

- **_theme.css is the single CSS source** — use utility classes from `_theme.css` for all layout, spacing, sizing, typography, and color. A slide should average 5-15 lines of custom CSS in `<style>`, not 150.
- **`<style>` blocks** are only for: slide-specific absolute positioning, grid dimensions unique to that slide, or one-off decorative elements.
- **Never** redefine `@font-face`, `:root` CSS custom properties, or any class that already exists in `_theme.css`.

## Utility class reference (from `_theme.css`)

| Category | Classes |
|---|---|
| **Layout** | `.gd-row`, `.gd-col`, `.gd-1`, `.gd-2`, `.gd-3`, `.gd-4`, `.gd-center`, `.gd-wrap`, `.gd-end`, `.gd-sidebar-l`, `.gd-sidebar-r`, `.gap-xs`, `.gap-sm`, `.gap-md`, `.gap-lg`, `.gap-xl`, `.gap-2xl`, `.items-start`, `.items-center`, `.items-end`, `.justify-center`, `.justify-end`, `.justify-between` |
| **Typography** | `.h-xl`, `.h-lg`, `.h-md`, `.h-sm`, `.b-lg`, `.b-md`, `.b-sm`, `.display`, `.mono`, `.label`, `.kicker`, `.text-left`, `.text-center`, `.text-right`, `.text-accent`, `.text-secondary`, `.text-bold`, `.text-semibold` |
| **Spacing** | `.p-xs`, `.p-sm`, `.p-md`, `.p-lg`, `.p-xl`, `.p-2xl`, `.px-xs`, `.px-sm`, `.px-md`, `.px-lg`, `.px-xl`, `.px-2xl`, `.py-xs`, `.py-sm`, `.py-md`, `.py-lg`, `.py-xl`, `.py-2xl`, `.pt-xs`, `.pt-sm`, `.pt-md`, `.pt-lg`, `.pt-xl`, `.pt-2xl`, `.mb-xs`, `.mb-sm`, `.mb-md`, `.mb-lg`, `.mb-xl`, `.mb-2xl` |
| **Surfaces** | `.bg-accent`, `.bg-accent-secondary`, `.bg-surface`, `.bg-dark`, `.rounded-sm`, `.rounded-md`, `.rounded-lg`, `.rounded-full`, `.border`, `.border-accent`, `.border-bottom-accent`, `.accent-bar-top`, `.accent-bar-left` |
| **Grid** | `.z-safe`, `.z-header`, `.z-body`, `.z-footer`, `.z-bg`, `.z-bg-layer`, `.z-bg-pattern`, `.z-bg-gradient`, `.z-bg-deco`, `.z-content`, `.z-grid-full`, `.z-grid-split`, `.z-grid-golden`, `.z-grid-golden-rev`, `.z-grid-thirds`, `.z-grid-quarters` |

Use `_theme.css` classes: `.gd-row`, `.gd-col`, `.gd-1`, `.items-center`, `.gap-md`, `.p-lg`, etc.

## Template-based authoring

When the task brief includes a template HTML document, work within its structure instead of writing from scratch. Templates use a two-zone convention:

- **`═══ FISSO`** zones (fixed structure) — do NOT modify. These contain pre-calculated proportions, grid classes, zone heights, decoration positions, and spacing that guarantee correct visual output.
- **`≈≈≈ ADATTA`** zones (adaptable content) — full creative freedom. Replace placeholder text, choose icons, adjust per-item colors, add/remove content elements within the container.

### Template meta block

Every template starts with an HTML comment containing metadata:
```
TEMPLATE: <name>
Role: cover|content|data|section|closing
Grid: z-grid-<type>
Variants: <allowed grid/background variants>
Items: <range of content items>
```
Read this first — it tells you the allowed grid variants and item ranges.

### What you CAN change in FISSO zones

- Toggle the grid class within the template's declared variants (e.g., `z-grid-split` → `z-grid-thirds` when meta says "2-4 metrics")
- Remove a decoration if it clashes with a specific content need (document why in a comment)

### What you MUST NOT change in FISSO zones

- Zone heights (header 96px, body flex:1, footer 48px)
- `z-safe` padding (48px outer margin)
- Grid gap values
- Decoration position/style attributes
- The layered background structure (`z-bg` wrapper and child order)
- Font-family assignments (`.display` for titles, `.mono` for code)

### Density notes in ADATTA zones

Every ADATTA zone includes a `max N parole` or `max N chars` hint and a commented example showing correct text density. Target 70-85% of the maximum — never exceed it.

## Layout derivation

When NO template is provided, derive layout from content structure:

- **Two opposing concepts** (problem vs solution, before vs after) → split panel with vertical divider
- **Five or more items** → multi-row grid (2×3, 2×4); single row only for ≤4 items
- **Single dominant message/metric** → hero layout: key element large and centered
- **Sequential/temporal content** → numbered steps or horizontal/vertical timeline
- **Closing/action-oriented slide** → visually distinct CTA block
- **Comparative content** → side-by-side columns or comparison table

## Density requirements

- **No slide should have more than 35% empty vertical space** below the last content element
- **Every card/item must have**: a unique specific title + at least 2 substantive sentences
- **Cards must never have a fixed `height`** — use `min-height` only as a floor
- **Fewer than 4 content items?** Add a complementary secondary section

## Design vocabulary — content level

These are for elements **inside content containers** (cards, placeholders). For slide-level frame decorations, see the `slides-composition` skill.

Available in `_theme.css`:

| Class | Use for |
|---|---|
| `.accent-bar-top` | Thin 3px horizontal accent bar at top of card |
| `.accent-bar-left` | Thin 3px vertical accent bar at left of card |
| `.kicker` | Small all-caps badge/pill above a heading |
| `.slide-card` | Content card with surface bg, border, rounded corners |
| `.slide-card-accent` | Card with accent-color top border |
| `.slide-badge` | Pill/badge labels |
| `.section-divider` | Horizontal rule between sections |
| `.section-divider-accent` | Accent-to-transparent gradient divider |
| `.stat-value` | Big numbers (600M, 73.8M) |
| `.stat-desc` | Label below a stat value |
| `.timeline-node` | Timeline row |
| `.timeline-dot` | Timeline bullet |
| `.timeline-line` | Timeline vertical connector |
| `.icon-circle` | Circular icon background |
| `.icon-circle-accent` | Icon circle with accent bg |
| `.icon-circle-muted` | Icon circle with surface bg |

## Icons — inline SVG only

Use inline SVG for icons, wrapped in `.icon-circle`, `.icon-circle-accent`, or `.icon-circle-muted` for branded circle backgrounds.

- Inline SVG elements (e.g. `<svg>...</svg>`) are the only acceptable icon format.
- Simple geometric shapes (circles, rectangles, triangles) as CSS or minimal SVG decorations **are** acceptable — e.g. a `<div>` with `border-radius: 50%` for a dot, or a `<div>` with border tricks for a triangle.
- Do not hand-craft complex SVG paths for logos or detailed illustrations — use `.placeholder` containers or refer to existing asset files instead.

## Allowed Libraries

- **_theme.css**: The single CSS source — all layout, typography, spacing, colors, and grid utilities.
- **_preset.css**: Optional decoration classes (composition & grid presets compiled from slides-composition).
- **Charts**: Use `class="placeholder"` containers with explicit dimensions. The PPTX build step replaces them with native PptxGenJS charts. **Never render charts with Chart.js, ECharts, or Canvas API** — `<canvas>` elements are invisible in PPTX export.
- **Google Fonts**: Load via Google Fonts CDN (only for systems without local fonts).

## Layout: 1280 × 720

- **Always use Flexbox**: `display: flex;` on outermost container, `flex: 1;` on content wrapper
- Container must be exactly `width: 1280px; height: 720px;` (fixed — never min-height/auto)
- Set explicit height on chart containers (e.g. `height: 300px`)
- No element may overflow — content must fit within 1280×720 without scrollbars

## Technical requirements

- **No base64-encoded images** — use `./assets/{filename}` local paths
- **Full-slide backgrounds must use `<img>` tags**, not CSS-generated backgrounds (`linear-gradient`, `radial-gradient`, `repeating-*`). Use absolutely-positioned `<img>` with `object-fit: cover`. Pre-rendered PNGs can also use `background-image: url(...)` in inline style.
- **CSS gradients are NOT supported in PPTX export** (`linear-gradient`, `radial-gradient`, `conic-gradient`). When `pptxCompatible: false` (CSS-only mode, HTML preview), gradients are acceptable — they work in browser preview. When `pptxCompatible: true`, gradients must be pre-rendered as PNG using Sharp/SVG and referenced via `<img>` tag.
- **CSS `filter` effects** (`blur()`, `drop-shadow()`, `brightness()`, etc.) are NOT supported in PPTX export. Pre-render filtered elements as PNG.
- **CSS background-image patterns** (dots, diagonals, etc. generated via repeating CSS gradients) are NOT supported. Pre-render pattern backgrounds as PNG.
- **Minimize animations** — prefer static design (animations don't export to PPTX)
- **Fonts**: loaded via local `.woff2` files (`@font-face` from `_theme.css`) or Google Fonts CDN fallback (embedded in PPTX export)
- **Text wrapping rule** — always wrap text inside `<p>` tags, never naked text nodes inside `<div>`
- **At least 8px gap between pill/badge groups** (`gap: 8px` on flex container)
- **Never place styled badges/pills inline within flowing sentence text** — they must be on their own line or container
- **Be factual** — use placeholders like `{Insert metric here}` instead of fabricating data
- **CRITICAL — CSS Variables**: Only use `var(--...)` custom properties that are **explicitly listed in the "Theme context" section of your task brief**. If you need a color or token not listed there, use a hex value (e.g. `#1e293b`) or a `_theme.css` variable class (e.g. `.text-accent`). **Never invent or guess CSS variable names.** The theme context is the complete and exclusive list — there are no other variables available.

## Validation rules (must pass all)

- Return ONLY HTML (no markdown, no explanations)
- Include `<link rel="stylesheet" href="./_theme.css" />` in every document
- use `_theme.css` variables and classes — do NOT redefine: `@font-face`, `:root` tokens, `.slide-card`, `.stat-value`, `.slide-badge`, `.icon-circle`, `.kicker`, `.label`, `.display`, `.mono`, `.bg-accent`, `.bg-surface`, `.bg-dark`
- **NO invented CSS variables** — every `var(--...)` in the HTML must match a variable name from the task brief's "Theme context" list. If the brief says `--color-text-primary` exists but `--color-text` does not, you MUST NOT write `var(--color-text)`. Use `var(--color-text-primary)` or an explicit hex value instead.
- All icons must be inline SVG — no hand-crafted complex SVG paths for logos
- No emoji or Unicode symbols as icons
- All visible text must be in semantic tags (`<p>`, `<h1>`-`<h6>`, `<ul>`, `<ol>`, `<li>`, `<span>`)
- No naked text nodes directly inside `<div>`
- No overflow horizontally or vertically
- Keep text ≥5–10px above bottom edge (descender clipping)
- Every local image reference: path inside project folder, file exists, extension is `.png/.jpg/.jpeg/.gif/.bmp/.tiff/.tif/.webp`
