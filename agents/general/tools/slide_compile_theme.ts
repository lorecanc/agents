import { tool } from "@opencode-ai/plugin"

//
// Token mappings for built-in systems.
// Custom systems are parsed from colors.md + typography.md.
//

interface TokenMap {
  COLOR_BG: string
  COLOR_SURFACE: string
  COLOR_TEXT_PRIMARY: string
  COLOR_TEXT_SECONDARY: string
  COLOR_ACCENT: string
  COLOR_ACCENT_SECONDARY: string
  COLOR_BORDER: string
  FONT_DISPLAY: string
  FONT_HEADING: string
  FONT_BODY: string
  FONT_MONO: string
}

const DEFAULTS: Record<string, TokenMap> = {
  "default-light": {
    COLOR_BG: "#ffffff",
    COLOR_SURFACE: "#f8fafc",
    COLOR_TEXT_PRIMARY: "#0f172a",
    COLOR_TEXT_SECONDARY: "#64748b",
    COLOR_ACCENT: "#2563eb",
    COLOR_ACCENT_SECONDARY: "#f59e0b",
    COLOR_BORDER: "#e2e8f0",
    FONT_DISPLAY: "Merriweather",
    FONT_HEADING: "Inter",
    FONT_BODY: "Inter",
    FONT_MONO: "IBM Plex Mono",
  },
  "default-dark": {
    COLOR_BG: "#0f172a",
    COLOR_SURFACE: "#1e293b",
    COLOR_TEXT_PRIMARY: "#ffffff",
    COLOR_TEXT_SECONDARY: "#cbd5e1",
    COLOR_ACCENT: "#22d3ee",
    COLOR_ACCENT_SECONDARY: "#fbbf24",
    COLOR_BORDER: "#334155",
    FONT_DISPLAY: "Space Grotesk",
    FONT_HEADING: "Space Grotesk",
    FONT_BODY: "Inter",
    FONT_MONO: "IBM Plex Mono",
  },
}

const GOOGLE_FONTS_CDN: Record<string, string> = {
  "default-light":
    '<link rel="preconnect" href="https://fonts.googleapis.com">\n<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Merriweather:wght@400;700&family=IBM+Plex+Mono:wght@400;500&display=swap">',
  "default-dark":
    '<link rel="preconnect" href="https://fonts.googleapis.com">\n<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@400;500;700&family=IBM+Plex+Mono:wght@400;500&display=swap">',
}

// ── Markdown Parsers for Custom Design Systems ────────────────────

function parseColorsMd(content: string): { accent: string | null; accentSecondary: string | null; bgLight: string | null; bgDark: string | null; textLight: string | null; textDark: string | null; border: string | null; surface: string | null } {
  const result = { accent: null as string | null, accentSecondary: null as string | null, bgLight: null as string | null, bgDark: null as string | null, textLight: null as string | null, textDark: null as string | null, border: null as string | null, surface: null as string | null }

  // Extract all hex codes with their names from the Global Color Tokens table
  const globalTokensSection = content.match(/#+\s*1\.\s*Global Color Tokens[\s\S]*?(?=#+\s*2\.|\n##|$)/i)
  if (globalTokensSection) {
    const hexRegex = /`([^`]+)`\s*\|\s*`(#[0-9a-fA-F]{6})`/g
    let match
    while ((match = hexRegex.exec(globalTokensSection[0])) !== null) {
      const name = match[1].trim()
      const hex = match[2].trim()
      // Map known design-system-specific color names to roles, then fall back to generic OOXML token names
      if (/brand red/i.test(name)) { result.accent = hex }
      else if (/teal|cyan/i.test(name) && !result.accentSecondary) { result.accentSecondary = hex }
      else if (/white/i.test(name)) { result.bgLight = hex }
      else if (/black/i.test(name)) { result.bgDark = hex; result.textLight = hex }
      // Generic OOXML theme token names (for auto-generated template design systems)
      else if (/^accent1$/i.test(name) && !result.accent) { result.accent = hex }
      else if (/^accent2$/i.test(name) && !result.accentSecondary) { result.accentSecondary = hex }
      else if (/^lt1$/i.test(name)) { result.bgLight = hex }
      else if (/^dk1$/i.test(name)) { result.textDark = hex; result.textLight = hex }
      else if (/^dk2$/i.test(name) && !result.bgDark) { result.bgDark = hex }
      else if (/^lt2$/i.test(name) && !result.surface) { result.surface = hex }
    }
  }

  // Extract foreground colors from Base/Construction table
  const baseSection = content.match(/#+\s*[AB]\.\s*Base[\s\S]*?Construction Colors[\s\S]*?(?=#+\s*[BC]\.|##|$)/i)
  if (baseSection) {
    // Find Brand Red row to confirm accent
    const brandRedRow = baseSection[0].match(/\*\*Brand Red\*\*[^|]*\|\s*([^|]+)/i)
    if (brandRedRow && !result.accent) {
      const hexMatch = brandRedRow[1].match(/#[0-9a-fA-F]{6}/)
      if (hexMatch) result.accent = hexMatch[0]
    }
  }

  // Extract Border color from Theme Architecture section
  const themeArchSection = content.match(/#+\s*4\.\s*Theme Architecture[\s\S]*?(?=##|$)/i)
  if (themeArchSection) {
    const borderMatch = themeArchSection[0].match(/Borders?:\s*`(#[0-9a-fA-F]{6})`/i)
    if (borderMatch) result.border = borderMatch[1]
  }

  return result
}

function extractColorCssBlock(colorsMdContent: string): string {
  // Extract the CSS Implementation section (section 3)
  const cssSection = colorsMdContent.match(/```css\n([\s\S]*?)```/)
  if (cssSection) return cssSection[1].trim()
  return ""
}

function parseTypographyMd(content: string): { display: string | null; heading: string | null; body: string | null; mono: string | null } {
  const result = { display: null as string | null, heading: null as string | null, body: null as string | null, mono: null as string | null }

  // Parse the Font Families table
  const tableSection = content.match(/\|\s*Family\s*\|[\s\S]*?(?=#+\s|$)/i)
  if (tableSection) {
    const rows = tableSection[0].split('\n').filter(l => l.includes('|') && !l.includes('---') && !l.includes('Family'))
    for (const row of rows) {
      const cols = row.split('|').map(c => c.trim()).filter(Boolean)
      if (cols.length >= 3) {
        const family = cols[0].replace(/\*\*/g, '').trim()
        const usage = cols[2].replace(/\*\*/g, '').trim()
        if (/headline|cover|title|display|hero/i.test(usage)) { result.display = family }
        else if (/subtitle|sub-cover|condensed|label|heading/i.test(usage)) { result.heading = family }
        else if (/body|paragraph|long text/i.test(usage)) { result.body = family }
      }
    }
  }

  return result
}

// ── Font Face Generation ──────────────────────────────────────────

function generateFontFaces(fontsDir: string): string {
  const fs = require("fs")
  const path = require("path")

  const files = fs.readdirSync(fontsDir).filter((f: string) => f.endsWith(".woff2"))

  if (files.length === 0) return ""

  const WEIGHT_MAP: Record<string, number> = {
    Thin: 100, Hairline: 100,
    ExtraLight: 200, UltraLight: 200,
    Light: 300,
    Regular: 400, Normal: 400,
    Medium: 500,
    SemiBold: 600, DemiBold: 600,
    Bold: 700,
    ExtraBold: 800, UltraBold: 800,
    Black: 900, Heavy: 900,
  }

  function parseWeight(variant: string): number {
    for (const [name, w] of Object.entries(WEIGHT_MAP)) {
      if (variant.startsWith(name)) return w
    }
    return 400
  }

  const lines: string[] = []

  for (const file of files) {
    const stem = file.replace(/\.woff2$/g, "")
    const hyphenIdx = stem.lastIndexOf("-")
    if (hyphenIdx === -1) continue

    const basePart = stem.substring(0, hyphenIdx)
    const variantPart = stem.substring(hyphenIdx + 1)

    // Insert space before uppercase letters: BaikalNormal → Baikal Normal
    const familyBase = basePart.replace(/([a-z])([A-Z])/g, "$1 $2")

    // Detect italic
    let weightVariant = variantPart
    let isItalic = false
    if (weightVariant.endsWith("Italic") || weightVariant.endsWith("Oblique")) {
      isItalic = true
      weightVariant = weightVariant.replace(/Italic$/g, "").replace(/Oblique$/g, "")
    }
    // Handle abbreviated endings: ExtBdIta, ExtLtIta, SemBdIta
    if (weightVariant.endsWith("Ita")) {
      isItalic = true
      weightVariant = weightVariant.replace(/Ita$/g, "")
    }

    // Normalise abbreviated variant names
    weightVariant = weightVariant
      .replace(/^ExtBd$/g, "ExtraBold")
      .replace(/^ExtLt$/g, "ExtraLight")
      .replace(/^SemBd$/g, "SemiBold")

    const weight = parseWeight(weightVariant)
    const style = isItalic ? "italic" : "normal"
    // Font-family matches PPTX naming: "Baikal Normal Regular"
    const family = `${familyBase} ${variantPart}`

    lines.push(
      `@font-face {\n  font-family: '${family}';\n  src: url('./assets/fonts/${file}') format('woff2');\n  font-weight: ${weight};\n  font-style: ${style};\n  font-display: swap;\n}\n`,
    )
  }

  return lines.join("\n")
}

// ── Semantic Slide Component Classes ──────────────────────────────

const SLIDE_COMPONENT_CSS = `
/* ── Semantic Slide Components ─────────────────────────────── */

/* Stat: big number + label (for key metrics) */
.stat-value {
  font-family: var(--font-display);
  font-size: var(--text-3xl);
  font-weight: 700;
  color: var(--color-accent);
  line-height: 1;
}
.stat-desc {
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
}

/* Slide card: content container with surface background */
.slide-card {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: 1.5rem;
}
.slide-card-accent {
  border-top: 3px solid var(--color-accent);
}

/* Slide badge: pill label / kicker */
.slide-badge {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  padding: 0.25rem 0.75rem;
  border-radius: var(--radius-full);
  color: var(--color-accent);
  background: rgba(var(--rgb-accent), 0.1);
}

/* Section divider */
.section-divider {
  width: 100%;
  height: 1px;
  background: var(--color-border);
}
.section-divider-accent {
  width: 100%;
  height: 2px;
  background: linear-gradient(90deg, var(--color-accent), transparent);
}

/* Timeline node */
.timeline-node {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
}
.timeline-dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--color-accent);
  flex-shrink: 0;
  margin-top: 0.35em;
}
.timeline-line {
  width: 2px;
  flex: 1;
  background: var(--color-border);
  margin-left: 5px;
  min-height: 1.5rem;
}

/* Icon wrapper (for inline SVG icons) */
.icon-circle {
  width: 2.5rem;
  height: 2.5rem;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.icon-circle-accent {
  background: var(--color-accent);
  color: var(--color-bg);
}
.icon-circle-muted {
  background: var(--color-surface);
  color: var(--color-accent);
  border: 1px solid var(--color-border);
}
`

// ── Main Tool ─────────────────────────────────────────────────────

export default tool({
  description:
    "Compile a design system into a _theme.css file for a slide project. Reads .opencode/office/slides/design/<name>/colors.md and typography.md to resolve tokens. Copies local fonts, generates @font-face, and includes brand interaction classes for custom systems.",
  args: {
    projectName: tool.schema
      .string()
      .describe("Name of the presentation project folder under ./projects/"),
    designSystem: tool.schema
      .string()
      .describe(
        "Design system name (e.g. 'default-light', 'default-dark'). Must match a directory in .opencode/office/slides/design/.",
      ),
    themeMode: tool.schema
      .enum(["light", "dark"])
      .optional()
      .describe("Theme mode override. Built-in systems may default to 'dark', custom to 'light'."),
    tokens: tool.schema
      .record(tool.schema.string(), tool.schema.string())
      .optional()
      .describe(
        "Optional token overrides. Provide any subset of COLOR_BG, COLOR_ACCENT, FONT_BODY, etc.",
      ),
  },
  async execute(args, context) {
    const fs = await import("fs")
    const path = await import("path")
    const { opencodePath } = await import("./_paths.js")

    const designRoot = opencodePath("..", "office", "slides", "design")

    const dsDir = path.join(designRoot, args.designSystem)

    if (!fs.existsSync(dsDir)) {
      const available = listDirs(designRoot)
      return `Error: Design system "${args.designSystem}" not found in .opencode/office/slides/design/. Available: ${available.join(", ")}`
    }

    // ── Resolve tokens ─────────────────────────────────────────
    const isBuiltin = args.designSystem in DEFAULTS
    let tokens: TokenMap

    if (isBuiltin) {
      const base = DEFAULTS[args.designSystem]
      const overrides = (args.tokens as Partial<TokenMap> | undefined) || {}
      tokens = { ...base, ...overrides }
    } else {
      // Custom design system — parse colors.md and typography.md
      const colorsPath = path.join(dsDir, "colors.md")
      const typographyPath = path.join(dsDir, "typography.md")

      if (!fs.existsSync(colorsPath) && !fs.existsSync(typographyPath)) {
        return `Error: Custom design system "${args.designSystem}" has no colors.md or typography.md files.`
      }

      let colorsMd = ""
      let typographyMd = ""
      try { colorsMd = fs.readFileSync(colorsPath, "utf-8") } catch {}
      try { typographyMd = fs.readFileSync(typographyPath, "utf-8") } catch {}

      const parsedColors = parseColorsMd(colorsMd)
      const parsedFonts = parseTypographyMd(typographyMd)

      const overrides = (args.tokens as Partial<TokenMap> | undefined) || {}

      tokens = {
        COLOR_BG: overrides.COLOR_BG || parsedColors.bgLight || "#ffffff",
        COLOR_SURFACE: overrides.COLOR_SURFACE || parsedColors.surface || "#f8fafc",
        COLOR_TEXT_PRIMARY: overrides.COLOR_TEXT_PRIMARY || parsedColors.textDark || "#000000",
        COLOR_TEXT_SECONDARY: overrides.COLOR_TEXT_SECONDARY || "#64748b",
        COLOR_ACCENT: overrides.COLOR_ACCENT || parsedColors.accent || "#e60000",
        COLOR_ACCENT_SECONDARY: overrides.COLOR_ACCENT_SECONDARY || parsedColors.accentSecondary || "#008596",
        COLOR_BORDER: overrides.COLOR_BORDER || parsedColors.border || "#e4e4e7",
        FONT_DISPLAY: overrides.FONT_DISPLAY || parsedFonts.display || "Inter",
        FONT_HEADING: overrides.FONT_HEADING || parsedFonts.heading || parsedFonts.body || "Inter",
        FONT_BODY: overrides.FONT_BODY || parsedFonts.body || "Inter",
        FONT_MONO: overrides.FONT_MONO || parsedFonts.mono || "IBM Plex Mono",
      }
    }

    const mode = args.themeMode ||
      (       args.designSystem === "default-dark" ? "dark" : "light")

    const dsName = args.designSystem

    // ── Fonts: local files or Google CDN ───────────────────────
    const fontsDir = path.join(dsDir, "fonts")
    const hasLocalFonts = fs.existsSync(fontsDir)

    let fontFaceDeclarations = ""

    if (hasLocalFonts) {
      fontFaceDeclarations = generateFontFaces(fontsDir)
    }

    // ── Brand interaction classes (design-system-specific) ───
    let brandInteractionClasses = ""
    if (!isBuiltin) {
      const colorsPath = path.join(dsDir, "colors.md")
      if (fs.existsSync(colorsPath)) {
        const colorsMd = fs.readFileSync(colorsPath, "utf-8")
        brandInteractionClasses = extractColorCssBlock(colorsMd)
      }
    }

    // ── Compile template ───────────────────────────────────────
    const templatePath = opencodePath("_theme.template.css")
    let template = ""

    if (fs.existsSync(templatePath)) {
      template = fs.readFileSync(templatePath, "utf-8")
    } else {
      // Fallback
      template = `:root {\n  --color-bg: {{COLOR_BG}};\n  --color-accent: {{COLOR_ACCENT}};\n  --font-body: '{{FONT_BODY}}', sans-serif;\n}\n{{FONT_FACE_DECLARATIONS}}\n{{BRAND_INTERACTION_CLASSES}}\n{{SLIDE_COMPONENTS}}`
    }

    template = template
      .replace("{{DESIGN_SYSTEM_NAME}}", dsName)
      .replace("{{THEME_MODE}}", mode)
      .replace("{{COLOR_BG}}", tokens.COLOR_BG)
      .replace("{{COLOR_SURFACE}}", tokens.COLOR_SURFACE)
      .replace("{{COLOR_TEXT_PRIMARY}}", tokens.COLOR_TEXT_PRIMARY)
      .replace("{{COLOR_TEXT_SECONDARY}}", tokens.COLOR_TEXT_SECONDARY)
      .replace("{{COLOR_ACCENT}}", tokens.COLOR_ACCENT)
      .replace("{{COLOR_ACCENT_SECONDARY}}", tokens.COLOR_ACCENT_SECONDARY)
      .replace("{{COLOR_BORDER}}", tokens.COLOR_BORDER)
      .replace("{{RGB_ACCENT}}", hexToRgb(tokens.COLOR_ACCENT))
      .replace("{{RGB_ACCENT_SECONDARY}}", hexToRgb(tokens.COLOR_ACCENT_SECONDARY))
      .replace("{{FONT_DISPLAY}}", tokens.FONT_DISPLAY)
      .replace("{{FONT_HEADING}}", tokens.FONT_HEADING)
      .replace("{{FONT_BODY}}", tokens.FONT_BODY)
      .replace("{{FONT_MONO}}", tokens.FONT_MONO)
      .replace("{{FONT_FACE_DECLARATIONS}}", fontFaceDeclarations)
      .replace("{{PRESET_CSS}}", "")
      .replace("{{BRAND_INTERACTION_CLASSES}}", brandInteractionClasses ? `/* ── Brand Interaction Classes (${dsName}) ──────────────── */\n${brandInteractionClasses}` : "")
      .replace("{{SLIDE_COMPONENTS}}", SLIDE_COMPONENT_CSS)

    // ── Write _theme.css ───────────────────────────────────────
    const projectsRoot = path.join(process.cwd(), "projects")
    const projectDir = path.join(projectsRoot, args.projectName, "presentations")
    fs.mkdirSync(projectDir, { recursive: true })

    const themePath = path.join(projectDir, "_theme.css")
    fs.writeFileSync(themePath, template, "utf-8")
    const size = fs.statSync(themePath).size

    // ── Copy local fonts if present ────────────────────────────
    if (hasLocalFonts) {
      const destFontsDir = path.join(projectDir, "assets", "fonts")
      fs.mkdirSync(destFontsDir, { recursive: true })
      for (const file of fs.readdirSync(fontsDir)) {
        fs.copyFileSync(path.join(fontsDir, file), path.join(destFontsDir, file))
      }
    }

    // ── Copy design assets (images, etc.) if present ───────────
    const designAssetsDir = path.join(dsDir, "assets")
    if (fs.existsSync(designAssetsDir)) {
      const destAssetsDir = path.join(projectDir, "assets")
      for (const file of fs.readdirSync(designAssetsDir)) {
        const src = path.join(designAssetsDir, file)
        if (fs.statSync(src).isFile()) {
          fs.copyFileSync(src, path.join(destAssetsDir, file))
        }
      }
    }

    // ── Return summary ─────────────────────────────────────────
    const fontNote = hasLocalFonts
      ? `Local fonts (${dsName}/fonts/) → assets/fonts/ with @font-face`
      : `Google Fonts CDN (no local fonts in ${dsName}/)`

    const lines = [
      `Theme compiled from "${dsName}" (${mode} mode)`,
      `Saved: ${themePath} (${size} bytes)`,
      `Tokens: accent=${tokens.COLOR_ACCENT}, bg=${tokens.COLOR_BG}, display="${tokens.FONT_DISPLAY}", body="${tokens.FONT_BODY}"`,
      fontNote,
    ]

    if (hasLocalFonts) {
      lines.push(`Font families available via CSS: var(--font-display), var(--font-heading), var(--font-body)`)
    } else {
      const cdn = GOOGLE_FONTS_CDN[args.designSystem] || GOOGLE_FONTS_CDN["default-light"]
      lines.push(`Google Fonts CDN for slide <head>: ${cdn}`)
    }

    if (brandInteractionClasses) {
      lines.push(`Brand interaction classes injected (${dsName})`)
    }

    lines.push(`Utility classes active: layout (.gd-*), typography (.h-*, .b-*), spacing (.p-*, .mb-*), grid (.z-*), surfaces (.bg-*, .rounded-*, .border-*)`)
    lines.push(`Decoration preset: _preset.css (compiled separately by slide_compile_composition)`)
    lines.push(`Semantic components: .stat-value, .slide-card, .slide-badge, .label, .kicker, .timeline-node, .icon-circle`)

    return lines.join("\n")
  },
})

// ── Helpers ───────────────────────────────────────────────────────

function hexToRgb(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `${r}, ${g}, ${b}`
}

function listDirs(root: string): string[] {
  const fs = require("fs")
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d: { isDirectory: () => boolean }) => d.isDirectory())
      .map((d: { name: string }) => d.name)
  } catch {
    return []
  }
}
