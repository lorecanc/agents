---
name: slides-composition
description: "Composition layer for slide generation: spatial grid vocabulary, decoration classes, background layering, canonical skeleton, and writer self-check procedure."
license: MIT
compatibility: opencode
---

# Slide Composition

Composition is Layer 2 of the slide pipeline — spatial layout and visual atmosphere, independent of the theming layer (colors/fonts).

## Layer Architecture

```
Layer 1 (Theming)     → _theme.css    — colors, fonts, design tokens, grid
Layer 2 (Composition) → _preset.css   — preset-dependent decorations
                      → recipe.json   — per-deck composition contract
Layer 3 (Content)     → HTML writer   — text, images, data
```

## Styling Stack (per slide `<head>`)

```html
<link rel="stylesheet" href="./_theme.css">
{{GOOGLE_FONTS_CDN}}
<!-- Optional: preset-dependent decorations -->
<link rel="stylesheet" href="./_preset.css">
```

## Background Layering Structure

> **IMPORTANT**: `z-bg` is `position: absolute` — it is OUT of normal document flow. It does NOT push `z-safe` down. `z-safe` always starts at position (0,0) as if `z-bg` were not there.

#### CSS-Only Mode (HTML preview / browser)

```html
<div class="z-bg">
  <div class="z-bg-layer z-bg-pattern deco-pattern-dots"></div>
  <div class="z-bg-layer z-bg-gradient"
       style="background: radial-gradient(...)"></div>
  <div class="z-bg-layer z-bg-deco">
    <div class="deco-orb deco-orb-lg" style="top:-80px;right:-120px;background:var(--color-accent);"></div>
  </div>
</div>
<!-- Frame decorations BEFORE z-safe for correct PPTX ordering -->
<div class="deco-stripe-top" style="..."></div>
<div class="z-safe z-content">
  <!-- header, body, footer zones -->
</div>
```

#### PNG Mode (PPTX-compatible)

```html
<div class="z-bg" style="position:relative; width:1280px; height:720px; overflow:hidden;">
  <!-- Layer 1: Pre-rasterized pattern as <img> -->
  <img src="./assets/pattern-dots.png"
       style="position:absolute; top:0; left:0; width:1280px; height:720px; opacity:0.15;">

  <!-- Layer 2: Pre-rasterized gradient as <img> -->
  <img src="./assets/bg-gradient-cover.png"
       style="position:absolute; top:0; left:0; width:1280px; height:720px;">

  <!-- Layer 3: Pre-rasterized blurred orb as <img> -->
  <img src="./assets/orb-lg-accent-blurred.png"
       style="position:absolute; top:10%; left:70%; width:400px; height:400px;">

  <!-- Solid overlays remain as <div> (these convert correctly to PPTX shapes) -->
  <div style="position:absolute; top:0; left:0; width:1280px; height:720px; background:rgba(0,0,0,0.3);"></div>
</div>

<!-- Frame decorations: placed BEFORE z-safe for correct PPTX ordering -->
<div class="deco-stripe-top" style="position:absolute; top:0; left:0; width:100%; height:6px; background:var(--color-accent);"></div>
<div class="deco-bracket-tl" style="position:absolute; top:24px; left:24px; width:48px; height:48px;
     border-top:3px solid var(--color-accent); border-left:3px solid var(--color-accent);"></div>

<div class="z-safe z-content" style="position:relative; width:1280px; height:720px; padding:48px; box-sizing:border-box; display:flex; flex-direction:column;">
  <!-- header, body, footer zones -->
</div>
```

> **PPTX export compatibility**:
> - CSS gradients on `z-bg-gradient` layers are **NOT supported** in PPTX export. They silently vanish. Use pre-rendered gradient PNGs with `<img>` tags instead (see PNG Mode above).
> - CSS `filter: blur()` on `deco-orb-*` elements is **NOT supported**. Orbs appear as sharp-edged shapes in PPTX. Use pre-rendered orb PNGs instead.
> - CSS `background-image` patterns (dots, diagonals, crosses via repeating gradients) are **NOT supported**. Use pre-rendered pattern PNGs instead.
> - HTML `z-index` layering does **NOT** survive PPTX export. Elements render in DOM order. Always place frame decorations **before** `z-safe` content in the DOM so they render behind content in PPTX.

Layer order (CSS mode): `z-bg-pattern` (z:0) → `z-bg-gradient` (z:1) → `z-bg-deco` (z:2) → frame decorations → `z-content` (z:3).

## Dual-Mode System

The composition system supports two output modes:

| Mode | Use Case | Implementation |
|---|---|---|
| **CSS-only** | HTML preview in browser | `_preset.css` classes applied to `<div>` elements |
| **PNG** | PPTX export | Pre-rasterized PNGs via `<img>` tags |

The writer agent selects the appropriate mode based on the `pptxCompatible` flag in the recipe:
- `pptxCompatible: false` (default) → CSS-only mode, frame decorations before `z-safe`
- `pptxCompatible: true` → PNG mode, frame decorations before `z-safe`

## Decoration Vocabulary (`_preset.css`)

All classes prefixed `deco-`. Two-tier usage rule:

> **Content-level** elements (inside cards, placeholders, semantic structure) → use `_theme.css` classes (`.accent-bar-top`, `.section-divider`, `.slide-card-accent`).
>
> **Composition-level** elements (slide-level atmosphere, background layers, decorative framing) → use `_preset.css` classes (`.deco-stripe-top`, `.deco-line-h`, `.deco-bracket-*`).
>
> **Never** mix `deco-*` inside a `.slide-card` or use `accent-bar-*` as a slide-level frame.

### Class Summary

| Class | Type | Description |
|---|---|---|
| `.deco-line-h` | Divider | Horizontal gradient line |
| `.deco-line-v` | Divider | Vertical gradient line |
| `.deco-bracket-tl/tr/bl/br` | Corner | L-shaped corner bracket |
| `.deco-stripe-top` | Stripe | Full-width top accent bar |
| `.deco-stripe-left` | Stripe | Full-height left accent bar |
| `.deco-orb-sm` | Orb | 200px blurred circle (**blur not supported in PPTX** — pre-render as PNG) |
| `.deco-orb-lg` | Orb | 400px blurred circle (**blur not supported in PPTX** — pre-render as PNG) |
| `.deco-pattern-dots` | Pattern | Dot grid background (**CSS pattern not supported in PPTX** — pre-render as PNG) |
| `.deco-pattern-diagonals` | Pattern | Diagonal line pattern (**CSS pattern not supported in PPTX** — pre-render as PNG) |
| `.deco-pattern-crosses` | Pattern | Cross/plus grid pattern (**CSS pattern not supported in PPTX** — pre-render as PNG) |
| `.deco-shape-circle` | Shape | Outlined or filled circle |
| `.deco-shape-triangle` | Shape | Triangle |
| `.deco-shape-hex` | Shape | Hexagon |

## Presets

The preset changes the implementation of `deco-*` classes, not the class names. All three presets share the same vocabulary.

| Preset | Style | Lines | Brackets | Orbs | Patterns |
|---|---|---|---|---|---|
| `geometric-minimal` | Corporate, formal | 1px, 60% opacity | 16px arms, 1px stroke | blur(100px), 0.08 | 2px dots, 24px spacing |
| `editorial` | Thought leadership | 2px gradient, 50% | Empty (unused) | blur(120px), 0.06 | None |
| `bold-shapes` | Creative, pitch | 4px solid, 100% | 32px arms, 3px stroke | blur(60px), 0.18 | 2px dots, 16px spacing |

## Writer Self-Check Procedure

Before returning HTML, verify all composition directives from the recipe:

```
COMPOSITION SELF-CHECK (verify all before returning):

□ GRID: Does the main content area use the grid class from the recipe?
  Expected: "{recipe.slides[N].grid}"
  Check: look for the class on the body content wrapper

□ DECORATIONS: Are exactly the decorations from the recipe applied?
  Expected: {recipe.slides[N].decorations}
  Check: each decoration class appears as an element in the HTML
  Violation: extra decorations not in the recipe, or missing ones

□ BACKGROUND: Does the background follow the layered structure?
  Expected base: "{recipe.slides[N].background.base}"
  Expected pattern: "{recipe.slides[N].background.pattern}"
  Check: .z-bg wrapper with correct .z-bg-layer children

□ WEIGHT: Does the visual density match the target?
  Expected weight: "{recipe.slides[N].visualWeight}"
  Expected whitespace: "{recipe.slides[N].whitespaceTarget}"
  If "light": ≥40% whitespace, large text, minimal items
  If "heavy": ≤25% whitespace, dense grid, multiple items
  If "medium": between the two

□ DECORATION FAMILY: Are all decorative elements from the correct family?
  Expected family: "{recipe.deckRules.decorationFamily}"
  Violation: using decorations from a different preset family
```

## Canonical Slide Skeleton

> **`z-bg` is `position: absolute` (out of flow).** `z-safe` starts at the top-left of the canvas — it is NOT pushed below `z-bg`. Both occupy the same 1280×720 space, with content layered on top of the background via z-index.

### CSS-Only Skeleton (pptxCompatible: false)

```html
<body style="width:1280px;height:720px;margin:0;padding:0;overflow:hidden;">
  <!-- COMPOSITION: background layers (position:absolute — out of flow) -->
  <div class="z-bg">
    <div class="z-bg-layer z-bg-pattern"></div>
    <div class="z-bg-layer z-bg-gradient"></div>
    <div class="z-bg-layer z-bg-deco"></div>
  </div>

  <!-- COMPOSITION: frame decorations (before z-safe for PPTX compatibility) -->
  <div class="deco-stripe-top"></div>
  <div class="deco-bracket-tl"></div>

  <!-- COMPOSITION: safe content area (starts at y=0, layered above background) -->
  <div class="z-safe z-content">
    <div class="z-header"></div>
    <div class="z-body"></div>
    <div class="z-footer"></div>
  </div>
</body>
```

### PNG Skeleton (pptxCompatible: true)

```html
<body style="width:1280px;height:720px;margin:0;padding:0;overflow:hidden;">
  <!-- COMPOSITION: pre-rasterized background layers as <img> -->
  <div class="z-bg" style="position:relative;width:1280px;height:720px;overflow:hidden;">
    <img src="./assets/pattern-dots.png" style="position:absolute;top:0;left:0;width:1280px;height:720px;opacity:0.15;">
    <img src="./assets/bg-gradient-cover.png" style="position:absolute;top:0;left:0;width:1280px;height:720px;">
    <img src="./assets/orb-lg-accent-blurred.png" style="position:absolute;top:10%;left:70%;width:400px;height:400px;">
  </div>

  <!-- COMPOSITION: frame decorations (before z-safe for PPTX DOM order) -->
  <div class="deco-stripe-top" style="position:absolute;top:0;left:0;width:100%;height:6px;background:var(--color-accent);"></div>
  <div class="deco-bracket-tl" style="position:absolute;top:24px;left:24px;width:48px;height:48px;border-top:3px solid var(--color-accent);border-left:3px solid var(--color-accent);"></div>

  <!-- COMPOSITION: safe content area -->
  <div class="z-safe z-content" style="position:relative;width:1280px;height:720px;padding:48px;box-sizing:border-box;display:flex;flex-direction:column;">
    <div class="z-header"></div>
    <div class="z-body"></div>
    <div class="z-footer"></div>
  </div>
</body>
```

## Backward Compatibility

Legacy projects (those without `_preset.css`) should be written using the standard free-form approach without composition directives. Do not retroactively add composition to a legacy deck unless the user explicitly asks to redesign or apply a composition system.
