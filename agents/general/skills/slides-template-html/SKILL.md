---
name: slides-template-html
description: "HTML slide authoring rules for the slides-template-writer subagent. Covers constrained writing within corporate template layout skeletons, validation rules for 1280x720 slide documents."
license: MIT
compatibility: opencode
---

# Slide HTML Authoring — Template Constrained Mode

## Core Rule

Return ONLY the complete HTML document — no markdown fences, no explanations, no tool calls.

## Reading the Layout Contract

Every skeleton HTML starts with a spatial contract embedded as an HTML comment. It defines the exact bounds and capacity of every placeholder:

<!--
CONTRACT: layout_name
Category: content_2col
Viewport: 1280x720

idx=0  TITLE    (45,45)  1188x122px  ~80 chars @28pt
idx=1  BODY     (45,169)  585x447px  ~180 words @14pt
idx=2  BODY     (649,169)  585x447px  ~180 words @14pt
-->

**Interpretation:**
- `idx=0 TITLE`: 1188px wide, 122px tall. Fits about 80 characters at 28pt font.
- `idx=1 BODY`: 585x447px. Fits about 180 words at 14pt font.
- All coordinates are pixel positions (left, top) at 1280x720 viewport.
- `~X chars` = approximate maximum characters (for title/subtitle). `~X words` = approximate maximum words (for body text).

### Capacity Constraints

**YOU MUST RESPECT THESE CAPACITY LIMITS.** Writing more content than the placeholder can fit will cause overflow and your slide will be **rejected**.

| Capacity exceeds by | Consequence |
|---|---|
| 10-30% | May overflow subtly — hard to catch |
| 30-50% | Will overflow visibly — text clipped |
| 50%+ | Guaranteed rejection — validation will fail |

For safety, target **70-80% of the max capacity** to account for font rendering differences.

## Constrained mode: working within a skeleton

The task brief includes a complete HTML skeleton with pre-positioned `[data-placeholder]` containers. These containers come from the corporate PowerPoint template's slide layouts.

### MANDATORY constraints

1. **Never modify placeholder positioning**: Do not change `position`, `left`, `top`, `width`, `height`, `overflow`, or `box-sizing` on any element with `data-placeholder` attribute. These are pre-set to `overflow:hidden;box-sizing:border-box;`.
2. **Never add new placeholders**: The set of `data-placeholder` elements must remain exactly as in the skeleton.
3. **Never remove placeholders**: Every placeholder from the skeleton must remain present.
4. **Fill content into placeholders**: Replace comments (`<!-- TITLE content -->`) with real semantic HTML content. Match by `data-idx` attribute.
5. **Content must fit**: Ensure content does not overflow the placeholder bounds horizontally or vertically.
6. **Respect `data-bg` from the `<section>` tag**: The `<section class="slide-layout" data-bg="...">` tells you the slide's background brightness. ALWAYS apply a text color that contrasts:
   - `data-bg="light"` → dark text (`var(--color-text-primary)`, `var(--color-text-secondary)`)
   - `data-bg="dark"` → light text (`var(--color-bg)` or `#fff`) everywhere
   - `data-bg="unknown"` → dark text (safe default, same as light)

### What you CAN do

- **Add decorative elements** outside `[data-placeholder]` containers: accent bars, glowing orbs, grid backgrounds, corner brackets
- **Style within placeholders**: Use _theme.css classes for text alignment (`.text-left`, `.text-center`, `.text-right`), color (`.text-accent`, `.text-secondary`), size (`.h-xl` through `.b-sm`), spacing (`.p-*`, `.mb-*`)
- **Restructure content inside placeholders**: Add cards, stats, badges, timelines — as long as they fit within the placeholder bounds
- **Add icons** via inline SVG, wrapped in `.icon-circle` classes

## Common Rules (from `slides-html`)

All rules from the `slides-html` skill apply **except where overridden below**. This skill only documents template-specific additions. For the full reference, see `slides-html/SKILL.md`.

Inherited unchanged:
- **Styling stack**: `_theme.css` (primary) + `_preset.css` (optional). `<style>` blocks only for slide-specific positioning. Never redefine `@font-face`, `:root` variables, or theme classes.
- **Layout**: 1280×720px canvas with `overflow:hidden`
- **Typography**: Use `.h-xl`–`.b-sm`, `.display`, `.mono`, `.text-accent`, `.text-secondary`, `.text-bold`, `.text-semibold`
- **Surfaces**: `.bg-accent`, `.bg-surface`, `.bg-dark`, `.rounded-*`, `.border-accent`, `.accent-bar-top`, `.accent-bar-left`
- **Spacing**: `.p-*`, `.px-*`, `.py-*`, `.pt-*`, `.mb-*` (xs through 2xl)
- **Semantic components**: `.stat-value`, `.stat-desc`, `.slide-card`, `.slide-card-accent`, `.slide-badge`, `.section-divider`, `.section-divider-accent`, `.timeline-node`, `.timeline-dot`, `.timeline-line`, `.icon-circle`, `.icon-circle-accent`, `.icon-circle-muted`
- **Icons**: Inline SVG only, wrapped in `.icon-circle` classes. No emoji / Unicode symbols.
- **Images**: `./assets/{filename}` paths only, no base64. Use `<img>` tags, not CSS `background-image`. CSS gradients unsupported in PPTX — pre-render as PNG.
- **Text**: All visible text inside `<p>`, `<h1>`-`<h6>`, `<ul>`, `<ol>`, `<li>`. No naked text nodes in `<div>`.

## Overrides & template-specific rules

### Density
- **Fill every placeholder** with substantive content. Empty placeholders are unacceptable.
- **Target 70–80% of the contract's capacity** limit per placeholder.

### Template-specific validation
- Placeholder structure from skeleton is preserved exactly (positions, attributes unchanged)
- Content does not exceed the capacity hints in the contract comment
- No overflow horizontally or vertically (enforced by `overflow:hidden` on every placeholder)
- Every local image reference: file must exist in project folder
