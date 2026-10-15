---
name: slides-design
description: "Slide design principles, visual asset selection strategy, and workflow best practices for creating professional presentation decks."
license: MIT
compatibility: opencode
---

# Slide Design Principles

## Core Design Principles

- **Visual First**: Humans process visuals 60,000x faster than text. Prioritize converting text concepts into diagrams, charts, or imagery. Avoid walls of text.
- **Text as Visual Element**: Use typography, color, size, and formatting to create visual hierarchy. Plain, unstyled text looks unprofessional.
- **Structural Integrity**: A pretty slide with poor logic is useless. Ensure clear narrative arc (Beginning, Middle, End) before designing.
- **Content Breathability**: Less is more. If content occupies >80% of vertical space, split into two slides.
- **Data Accuracy**: Visuals must be grounded in fact. Prioritize accuracy over aesthetics.
- **Just-in-Time Execution**: Don't hallucinate assets. Plan first, then generate assets, then build the slide.

## Visual Asset Selection Strategy

### Priority 1: Reuse Existing Assets
Before generating new assets, review conversation context for:
- Background/theme images previously downloaded (textures, patterns, gradients)
- Assets mentioned or provided by the user

**Do NOT reuse content images** (hero photos, UI screenshots, diagrams) from one slide on another. Only reuse background images for styling.

### Priority 2: Generate New Assets

| Content Type | Tool | Details |
|---|---|---|
| **Real World Facts** (logos, news, photos) | Web search → find URLs | Download with `slide_download_image` before use |
| **Background Images** (textures, patterns, hero) | Web search → find URLs | Download with `slide_download_image`; reference as `./assets/{filename}` |
| **Complex Diagrams** (flowcharts, pyramids, org charts) | `slide_generate_image` | `imageType: "diagram"` |
| **Concept Art** (illustrations, atmosphere) | `slide_generate_image` | `imageType: "concept_art"` |
| **Statistical Charts** (bar, line, pie, radar) | PptxGenJS | Use `class="placeholder"` containers — native PptxGenJS charts fill them at build time |
| **Simple Logic** (venn, matrix, timeline) | HTML/CSS | Use HTML/CSS shapes or pre-rendered PNG images |

**Image sourcing rule**: Never construct, guess, or recall image URLs from memory. Every URL must come from a tool result.

**SVG logo/icon ban**: Never draw logos, brand icons, or product icons as hand-crafted inline SVG.

## Slide Creation Workflow

1. **Clarify** (MANDATORY): Ask all clarifying questions with best-guess defaults. Wait for reply.
2. **Research** (Two-Stage):
   - Stage 1: Run multiple web searches in parallel for context, facts, brand signals
   - Stage 2: Fetch 1-2 high-value URLs for deeper content
   - Extract named specifics, concrete numbers, pain points, differentiators, real examples
3. **Theme**: Extract brand identity → pick palette → call `slide_compile_theme` to save `_theme.css`
4. **Content Strategy**: Plan narrative flow and key messages for each slide
5. **Execution**:
   - For new slides: author HTML → screenshot → iterate
   - For updates: regenerate affected HTML slides → rebuild PPTX
   - Batch independent slide updates in parallel when possible
   - Inspect screenshots for critical defects only (overflow, broken layout, missing images, unreadable contrast)

## Cost Control
- Hard ceiling: 3 consecutive modifications on the same slide (emergency cap, not budget)
- Do not edit for non-critical issues
- The ideal number of post-generation edits is zero

## Template Usage
- Save a slide as template: `save_as_template_key`
- Reuse template for similar slides: `existing_template_key`
- **Do NOT use `existing_template_key` for targeted edits** — it restructures the slide
- Templates represent LAYOUT PATTERNS, not individual slides

## First Slide (Cover)
- Must look strong and impactful
- Prefer downloading/generating large, high-impact assets (hero image, logo, bold visual)
- Not text-only — needs a clear visual anchor

## Design Consistency
- Reuse the same theme (colors, fonts, spacing) across all slides via `_theme.css`
- Match visual style (palette, font-family, spacing) — don't mindlessly copy layout structure
- Every slide should use a layout that fits its own content
- Composition layer: when a project has `_preset.css`, slide-level decorations come from the composition preset. Grid system is in `_theme.css`.
