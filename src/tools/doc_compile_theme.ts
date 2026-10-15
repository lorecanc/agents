import { tool } from "@opencode-ai/plugin"
import { safeProjectSegment } from "./_safeName.js"

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

const GOOGLE_FONTS_IMPORT: Record<string, string> = {
  "default-light":
    '@import url("https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Merriweather:wght@400;700&family=IBM+Plex+Mono:wght@400;500&display=swap");',
  "default-dark":
    '@import url("https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@400;500;700&family=IBM+Plex+Mono:wght@400;500&display=swap");',
}

// ── Markdown Parsers for Custom Design Systems ────────────────────

function parseColorsMd(content: string): { accent: string | null; accentSecondary: string | null; bgLight: string | null; bgDark: string | null; textLight: string | null; textDark: string | null; border: string | null; surface: string | null } {
  const result = { accent: null as string | null, accentSecondary: null as string | null, bgLight: null as string | null, bgDark: null as string | null, textLight: null as string | null, textDark: null as string | null, border: null as string | null, surface: null as string | null }

  const globalTokensSection = content.match(/#+\s*[1A]\.\s*Global Color Tokens[\s\S]*?(?=#+\s*\d\.|##|$)/i)
  if (globalTokensSection) {
    const hexRegex = /`([^`]+)`\s*\|\s*`(#[0-9a-fA-F]{6})`/g
    let match
    while ((match = hexRegex.exec(globalTokensSection[0])) !== null) {
      const name = match[1].trim()
      const hex = match[2].trim()
      if (/brand red/i.test(name)) { result.accent = hex }
      else if (/teal|cyan/i.test(name) && !result.accentSecondary) { result.accentSecondary = hex }
      else if (/white/i.test(name)) { result.bgLight = hex }
      else if (/black/i.test(name)) { result.bgDark = hex; result.textLight = hex }
      else if (/^accent1$/i.test(name) && !result.accent) { result.accent = hex }
      else if (/^accent2$/i.test(name) && !result.accentSecondary) { result.accentSecondary = hex }
      else if (/^lt1$/i.test(name)) { result.bgLight = hex }
      else if (/^dk1$/i.test(name)) { result.textDark = hex; result.textLight = hex }
      else if (/^dk2$/i.test(name) && !result.bgDark) { result.bgDark = hex }
      else if (/^lt2$/i.test(name) && !result.surface) { result.surface = hex }
    }
  }

  // Theme Architecture section
  const themeArchSection = content.match(/#+\s*(?:2|B)\.\s*Theme Architecture[\s\S]*?(?=##|$)/i)
  if (themeArchSection) {
    const accentMatch = themeArchSection[0].match(/Accent:\s*`(#[0-9a-fA-F]{6})`/i)
    if (accentMatch && !result.accent) result.accent = accentMatch[1]
    const accent2Match = themeArchSection[0].match(/Accent Secondary:\s*`(#[0-9a-fA-F]{6})`/i)
    if (accent2Match && !result.accentSecondary) result.accentSecondary = accent2Match[1]
    const bgMatch = themeArchSection[0].match(/Background Light:\s*`(#[0-9a-fA-F]{6})`/i)
    if (bgMatch && !result.bgLight) result.bgLight = bgMatch[1]
    const bgDarkMatch = themeArchSection[0].match(/Background Dark:\s*`(#[0-9a-fA-F]{6})`/i)
    if (bgDarkMatch && !result.bgDark) result.bgDark = bgDarkMatch[1]
    const borderMatch = themeArchSection[0].match(/Borders?:\s*`(#[0-9a-fA-F]{6})`/i)
    if (borderMatch) result.border = borderMatch[1]
  }

  // Color Tokens table (default style)
  const colorTokensSection = content.match(/#+\s*(?:Color Tokens)[\s\S]*?(?=#+\s|##|$)/i)
  if (colorTokensSection) {
    const rowRegex = /\|`([^`]+)`\s*\|\s*`(#[0-9a-fA-F]{6})`\s*\|([^|]*)\|/g
    let rowMatch
    while ((rowMatch = rowRegex.exec(colorTokensSection[0])) !== null) {
      const token = rowMatch[1].trim()
      const hex = rowMatch[2].trim()
      const role = rowMatch[3].trim()
      if (/white|page background/i.test(role) || /white|page background/i.test(token)) { result.bgLight = hex }
      else if (/slate 50|surface|card background/i.test(role) || /surface|card background/i.test(token)) { result.surface = hex }
      else if (/slate 900|primary text/i.test(role) || /primary text/i.test(token)) { result.textDark = hex }
      else if (/slate 500|secondary text/i.test(role) || /secondary text/i.test(token)) { result.textLight = hex }
      else if (/blue 600|primary accent/i.test(role) || /primary accent/i.test(token)) { result.accent = hex }
      else if (/amber|secondary accent/i.test(role) || /secondary accent/i.test(token)) { result.accentSecondary = hex }
      else if (/slate 200|border/i.test(role) || /border/i.test(token)) { result.border = hex }
      else if (/charcoal|page background/i.test(role)) { result.bgDark = hex }
      else if (/slate 800|surface|card background/i.test(role)) { result.surface = hex }
      else if (/white|primary text/i.test(role)) { result.textDark = hex }
      else if (/slate 300|secondary text/i.test(role)) { result.textLight = hex }
      else if (/cyan|primary accent/i.test(role)) { result.accent = hex }
      else if (/amber|secondary accent/i.test(role)) { result.accentSecondary = hex }
      else if (/slate 700|border/i.test(role)) { result.border = hex }
    }
  }

  // CSS Implementation section
  const cssSection = content.match(/```css\n([\s\S]*?)```/)
  if (cssSection) {
    const cssText = cssSection[1]
    const cssAccent = cssText.match(/--c-accent:\s*(#[0-9a-fA-F]{6})/i)
    if (cssAccent && !result.accent) result.accent = cssAccent[1]
    const cssAccent2 = cssText.match(/--c-accent-secondary:\s*(#[0-9a-fA-F]{6})/i)
    if (cssAccent2 && !result.accentSecondary) result.accentSecondary = cssAccent2[1]
    const cssBg = cssText.match(/--c-bg:\s*(#[0-9a-fA-F]{6})/i)
    if (cssBg && !result.bgLight) result.bgLight = cssBg[1]
    const cssTextMatch = cssText.match(/--c-text:\s*(#[0-9a-fA-F]{6})/i)
    if (cssTextMatch && !result.textDark) result.textDark = cssTextMatch[1]
  }

  return result
}

function extractColorCssBlock(colorsMdContent: string): string {
  const cssSection = colorsMdContent.match(/```css\n([\s\S]*?)```/)
  if (cssSection) return cssSection[1].trim()
  return ""
}

function parseTypographyMd(content: string): { display: string | null; heading: string | null; body: string | null; mono: string | null } {
  const result = { display: null as string | null, heading: null as string | null, body: null as string | null, mono: null as string | null }

  const tableSection = content.match(/\|\s*Family\s*\|[\s\S]*?(?=#+\s|$)/i)
  if (tableSection) {
    const rows = tableSection[0].split('\n').filter(l => l.includes('|') && !l.includes('---') && !l.includes('Family'))
    for (const row of rows) {
      const cols = row.split('|').map(c => c.trim()).filter(Boolean)
      if (cols.length >= 3) {
        const family = cols[0].replace(/\*\*/g, '').trim()
        const usage = cols[2].replace(/\*\*/g, '').trim()
        if (/headline|cover|title|display|hero/i.test(usage)) { result.display = family }
        else if (/subtitle|sub-cover|condensed|label|heading|section/i.test(usage)) { result.heading = family }
        else if (/body|paragraph|long text/i.test(usage)) { result.body = family }
      }
    }
  }

  // Parse CSS custom property block for fallback
  const cssMatch = content.match(/```css\n([\s\S]*?)```/)
  if (cssMatch) {
    const cssText = cssMatch[1]
    const cssDisplay = cssText.match(/--font-display:\s*'([^']+)'/i)
    if (cssDisplay && !result.display) result.display = cssDisplay[1]
    const cssHeading = cssText.match(/--font-heading:\s*'([^']+)'/i)
    if (cssHeading && !result.heading) result.heading = cssHeading[1]
    const cssBody = cssText.match(/--font-body:\s*'([^']+)'/i)
    if (cssBody && !result.body) result.body = cssBody[1]
    const cssMono = cssText.match(/--font-mono:\s*'([^']+)'/i)
    if (cssMono && !result.mono) result.mono = cssMono[1]
  }

  return result
}

// ── Font Face Generation ──────────────────────────────────────────

function generateFontFaces(fontsDir: string): string {
  const fs = require("fs")
  const path = require("path")

  const files = fs.readdirSync(fontsDir).filter((f: string) => f.endsWith(".woff2") || f.endsWith(".ttf"))

  if (files.length === 0) return ""

  const faceMap: Record<string, { family: string; weight: number; style: string }> = {
    "BaikalExp-Medium.woff2": { family: "Baikal Exp", weight: 500, style: "normal" },
    "BaikalExtraCond-SemiBold.woff2": { family: "Baikal ExtraCond", weight: 600, style: "normal" },
    "BaikalNormal-Regular.woff2": { family: "Baikal Normal", weight: 400, style: "normal" },
    "BaikalNormal-RegularItalic.woff2": { family: "Baikal Normal", weight: 400, style: "italic" },
    "BaikalNormal-Medium.woff2": { family: "Baikal Normal", weight: 500, style: "normal" },
    "BaikalNormal-SemiBold.woff2": { family: "Baikal Normal", weight: 600, style: "normal" },
    "BaikalNormal-Bold.woff2": { family: "Baikal Normal", weight: 700, style: "normal" },
  }

  const lines: string[] = []

  for (const file of files) {
    const mapping = faceMap[file]
    if (!mapping) continue
    lines.push(
      `@font-face {\n  font-family: '${mapping.family}';\n  src: url('assets/fonts/${file}') format('woff2');\n  font-weight: ${mapping.weight};\n  font-style: ${mapping.style};\n}\n`,
    )
  }

  return lines.join("\n")
}

// ── Semantic Document Component Classes ───────────────────────────

const DOC_COMPONENT_CSS = `
/* ── Layout Components ─────────────────────────────────────── */

.doc-header-band {
  background: var(--color-accent);
  color: var(--color-bg);
  padding: 18pt 24pt;
}

.doc-sidebar {
  background: var(--color-surface);
  border-right: 1pt solid var(--color-border);
  padding: 12pt;
  width: 30%;
}

.doc-section-divider {
  border-top: 1pt solid var(--color-border);
  margin: 14pt 0;
}

.doc-section-divider-accent {
  border-top: 2pt solid var(--color-accent);
  margin: 14pt 0;
}

/* ── Callout / Highlight ───────────────────────────────────── */

.doc-callout {
  background: var(--color-surface);
  border-left: 3pt solid var(--color-accent);
  padding: 10pt 14pt;
  margin: 10pt 0;
}

.doc-callout-accent {
  background: var(--color-accent);
  color: var(--color-bg);
  padding: 10pt 14pt;
  margin: 10pt 0;
}

/* ── Typography ────────────────────────────────────────────── */

.doc-kicker {
  font-family: var(--font-mono);
  font-size: 9pt;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--color-accent);
}

.doc-display {
  font-family: var(--font-display);
}

.doc-heading {
  font-family: var(--font-heading);
}

.doc-mono {
  font-family: var(--font-mono);
}

.doc-text-muted {
  color: var(--color-text-secondary);
}

/* ── Tables ────────────────────────────────────────────────── */

.doc-table-header {
  background: var(--color-accent);
  color: var(--color-bg);
  font-weight: 700;
}

.doc-table-alt-row {
  background: var(--color-surface);
}

/* ── Background Context ────────────────────────────────────── */

.bg-accent {
  background: var(--color-accent);
  color: var(--color-bg);
}

.bg-accent-secondary {
  background: var(--color-accent-secondary);
  color: var(--color-bg);
}

.bg-surface {
  background: var(--color-surface);
  color: var(--color-text-primary);
}

.bg-dark {
  background: var(--color-text-primary);
  color: var(--color-bg);
}
`

// ── Main Tool ─────────────────────────────────────────────────────

export default tool({
  description:
    "Compile a design system into theme CSS for a document project. Reads .opencode/office/docs/design/<name>/colors.md and typography.md to resolve tokens. Copies local fonts, generates @font-face, and includes document component classes. The returned CSS block should be inlined in the document HTML <style> tag.",
  args: {
    projectName: tool.schema
      .string()
      .describe("Name of the document project folder under ./projects/"),
    designSystem: tool.schema
      .string()
      .describe(
        "Design system name (e.g. 'default-light', 'default-dark'). Must match a directory in .opencode/office/docs/design/.",
      ),
    themeMode: tool.schema
      .enum(["light", "dark"])
      .optional()
      .describe("Theme mode override. Defaults to 'light'; default-dark defaults to 'dark'."),
    tokens: tool.schema
      .record(tool.schema.string(), tool.schema.string())
      .optional()
      .describe(
        "Optional token overrides. Provide any subset of COLOR_BG, COLOR_ACCENT, FONT_BODY, etc.",
      ),
  },
  async execute(args, context) {
    let designSystem
    try {
      designSystem = safeProjectSegment(args.designSystem, "designSystem")
    } catch (e) {
      return `Error: ${e.message}`
    }
    let projectName
    try {
      projectName = safeProjectSegment(args.projectName)
    } catch (e) {
      return `Error: ${e.message}`
    }

    const fs = await import("fs")
    const path = await import("path")
    const { opencodePath } = await import("./_paths.js")

    const designRoot = opencodePath("..", "office", "docs", "design")

    const dsDir = path.join(designRoot, designSystem)

    if (!fs.existsSync(dsDir)) {
      const available = listDirs(designRoot)
      return `Error: Design system "${designSystem}" not found in .opencode/office/docs/design/. Available: ${available.join(", ")}`
    }

    // ── Resolve tokens ─────────────────────────────────────────
    const isBuiltin = designSystem in DEFAULTS
    let tokens: TokenMap

    if (isBuiltin) {
      const base = DEFAULTS[designSystem]
      const overrides = (args.tokens as Partial<TokenMap> | undefined) || {}
      tokens = { ...base, ...overrides }
    } else {
      const colorsPath = path.join(dsDir, "colors.md")
      const typographyPath = path.join(dsDir, "typography.md")

      if (!fs.existsSync(colorsPath) && !fs.existsSync(typographyPath)) {
        return `Error: Custom design system "${designSystem}" has no colors.md or typography.md files.`
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
        COLOR_ACCENT: overrides.COLOR_ACCENT || parsedColors.accent || "#2563eb",
        COLOR_ACCENT_SECONDARY: overrides.COLOR_ACCENT_SECONDARY || parsedColors.accentSecondary || "#22d3ee",
        COLOR_BORDER: overrides.COLOR_BORDER || parsedColors.border || "#e2e8f0",
        FONT_DISPLAY: overrides.FONT_DISPLAY || parsedFonts.display || "Inter",
        FONT_HEADING: overrides.FONT_HEADING || parsedFonts.heading || parsedFonts.body || "Inter",
        FONT_BODY: overrides.FONT_BODY || parsedFonts.body || "Inter",
        FONT_MONO: overrides.FONT_MONO || parsedFonts.mono || "IBM Plex Mono",
      }
    }

    const mode = args.themeMode ||
      (designSystem === "default-dark" ? "dark" : "light")

    const dsName = designSystem

    // ── Fonts: local files or Google Fonts import ──────────────
    const fontsDir = path.join(dsDir, "fonts")
    const hasLocalFonts = fs.existsSync(fontsDir) && fs.readdirSync(fontsDir).length > 0

    let fontFaceDeclarations = ""
    let googleFontsImport = ""

    if (hasLocalFonts) {
      fontFaceDeclarations = generateFontFaces(fontsDir)
    } else {
      googleFontsImport = GOOGLE_FONTS_IMPORT[designSystem] || GOOGLE_FONTS_IMPORT["default-light"]
    }

    // ── Brand interaction classes ─────────────────────────────
    let brandInteractionClasses = ""
    if (!isBuiltin) {
      const colorsPath = path.join(dsDir, "colors.md")
      if (fs.existsSync(colorsPath)) {
        const colorsMd = fs.readFileSync(colorsPath, "utf-8")
        brandInteractionClasses = extractColorCssBlock(colorsMd)
      }
    }

    // ── Compile template ───────────────────────────────────────
    const templatePath = opencodePath("_doc_theme.template.css")
    let cssOutput = ""

    if (fs.existsSync(templatePath)) {
      cssOutput = fs.readFileSync(templatePath, "utf-8")
    } else {
      cssOutput = `/* Document Theme: {{DESIGN_SYSTEM_NAME}} ({{THEME_MODE}} mode) */\n:root {\n  --color-bg: {{COLOR_BG}};\n  --color-surface: {{COLOR_SURFACE}};\n  --color-text-primary: {{COLOR_TEXT_PRIMARY}};\n  --color-text-secondary: {{COLOR_TEXT_SECONDARY}};\n  --color-accent: {{COLOR_ACCENT}};\n  --color-accent-secondary: {{COLOR_ACCENT_SECONDARY}};\n  --color-border: {{COLOR_BORDER}};\n  --font-display: '{{FONT_DISPLAY}}', serif;\n  --font-heading: '{{FONT_HEADING}}', sans-serif;\n  --font-body: '{{FONT_BODY}}', sans-serif;\n  --font-mono: '{{FONT_MONO}}', monospace;\n}\n{{FONT_FACE_DECLARATIONS}}\n{{GOOGLE_FONTS_IMPORT}}\n{{BRAND_INTERACTION_CLASSES}}\n{{DOC_COMPONENTS}}`
    }

    cssOutput = cssOutput
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
      .replace("{{FONT_FACE_DECLARATIONS}}", fontFaceDeclarations || "/* No local font files — using Google Fonts CDN */")
      .replace("{{GOOGLE_FONTS_IMPORT}}", googleFontsImport ? `/* Google Fonts */\n${googleFontsImport}` : "")
      .replace("{{BRAND_INTERACTION_CLASSES}}", brandInteractionClasses ? `/* ── Brand Interaction Classes (${dsName}) ──────────────── */\n${brandInteractionClasses}` : "")
      .replace("{{DOC_COMPONENTS}}", DOC_COMPONENT_CSS)

    // ── Write _theme.css to project documents directory ─────────
    const projectsRoot = path.join(process.cwd(), "projects")
    const projectDir = path.join(projectsRoot, projectName, "documents")
    fs.mkdirSync(projectDir, { recursive: true })

    const themePath = path.join(projectDir, "_theme.css")
    fs.writeFileSync(themePath, cssOutput, "utf-8")
    const size = fs.statSync(themePath).size

    // ── Copy local fonts if present ────────────────────────────
    if (hasLocalFonts) {
      const destFontsDir = path.join(projectDir, "assets", "fonts")
      fs.mkdirSync(destFontsDir, { recursive: true })
      for (const file of fs.readdirSync(fontsDir)) {
        fs.copyFileSync(path.join(fontsDir, file), path.join(destFontsDir, file))
      }
    }

    // ── Return summary ─────────────────────────────────────────
    const fontNote = hasLocalFonts
      ? `Local fonts (${dsName}/fonts/) → assets/fonts/ with @font-face`
      : `Google Fonts: ${tokens.FONT_DISPLAY} + ${tokens.FONT_BODY}`

    const tokenSummary = [
      `COLOR_BG: ${tokens.COLOR_BG}`,
      `COLOR_SURFACE: ${tokens.COLOR_SURFACE}`,
      `COLOR_TEXT_PRIMARY: ${tokens.COLOR_TEXT_PRIMARY}`,
      `COLOR_TEXT_SECONDARY: ${tokens.COLOR_TEXT_SECONDARY}`,
      `COLOR_ACCENT: ${tokens.COLOR_ACCENT}`,
      `COLOR_ACCENT_SECONDARY: ${tokens.COLOR_ACCENT_SECONDARY}`,
      `COLOR_BORDER: ${tokens.COLOR_BORDER}`,
      `FONT_DISPLAY: ${tokens.FONT_DISPLAY}`,
      `FONT_HEADING: ${tokens.FONT_HEADING}`,
      `FONT_BODY: ${tokens.FONT_BODY}`,
      `FONT_MONO: ${tokens.FONT_MONO}`,
    ].join(", ")

    const lines = [
      `Theme compiled from "${dsName}" (${mode} mode)`,
      `Theme CSS: ${themePath} (${size} bytes) — copy the contents inside document <head> <style> tag`,
      `Tokens: ${tokenSummary}`,
      fontNote,
    ]

    if (hasLocalFonts) {
      lines.push(`Font files copied to ${destFontsDir} — will be embedded in DOCX on convert`)
    }

    if (brandInteractionClasses) {
      lines.push(`Brand interaction classes injected (${dsName}-specific)`)
    }

    lines.push(`Document components active: .doc-header-band, .doc-sidebar, .doc-callout, .doc-section-divider, .doc-table-header, etc.`)

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
