import { tool } from "@opencode-ai/plugin"
import { safeProjectSegment } from "./_safeName.js"
import { execSync } from "node:child_process"

interface DecorationBlock {
  [className: string]: string
}

interface Decorations {
  dividers: DecorationBlock
  brackets: DecorationBlock
  stripes: DecorationBlock
  orbs: DecorationBlock
  patterns: DecorationBlock
  shapes: DecorationBlock
}

interface Preset {
  name: string
  description: string
  decorations: Decorations
  pptx?: {
    patterns?: Array<{
      type: string
      dotSize?: number
      lineWidth?: number
      spacing: number
      offset?: number
      opacity: number
    }>
    orbs?: Array<{
      size: string
      diameter: number
      blurRadius: number
      opacity: number
    }>
  }
}

interface ThemeColors {
  accent: string
  accentSecondary: string
  bg: string
  surface: string
}

function buildDecorationBlock(entries: [string, string][]): string {
  const lines: string[] = []
  for (const [className, rule] of entries) {
    if (!rule || rule.trim() === "") {
      lines.push(`/* ${className} — not used in this preset */`)
    } else {
      lines.push(`.${className} { ${rule} }`)
    }
  }
  return lines.join("\n")
}

function compilePresetCss(preset: Preset): string {
  const dividers = buildDecorationBlock(Object.entries(preset.decorations.dividers))
  const brackets = buildDecorationBlock(Object.entries(preset.decorations.brackets))
  const stripes  = buildDecorationBlock(Object.entries(preset.decorations.stripes))
  const orbs     = buildDecorationBlock(Object.entries(preset.decorations.orbs))
  const patterns = buildDecorationBlock(Object.entries(preset.decorations.patterns))
  const shapes   = buildDecorationBlock(Object.entries(preset.decorations.shapes))

  return [
    `/* ================================================================`,
    `   Decoration Preset: ${preset.name}`,
    `   ${preset.description}`,
    `   ──────────────────────────────────────────────────────────────── */`,
    ``,
    `/* ── Dividers ─────────────────────────────────── */`,
    dividers,
    ``,
    `/* ── Corner Brackets ──────────────────────────── */`,
    brackets,
    ``,
    `/* ── Accent Stripes ───────────────────────────── */`,
    stripes,
    ``,
    `/* ── Depth Orbs ───────────────────────────────── */`,
    orbs,
    ``,
    `/* ── Surface Patterns ─────────────────────────── */`,
    patterns,
    ``,
    `/* ── Geometric Shapes ─────────────────────────── */`,
    shapes,
  ].join("\n")
}

function readThemeColors(themeCssPath: string): ThemeColors {
  const fs = require("fs")
  const colors: ThemeColors = {
    accent: "#2563eb",
    accentSecondary: "#f59e0b",
    bg: "#ffffff",
    surface: "#f8fafc",
  }
  try {
    const css = fs.readFileSync(themeCssPath, "utf-8")
    const hexMatch = /--color-accent:\s*(#[0-9a-fA-F]{6})/.exec(css)
    if (hexMatch) colors.accent = hexMatch[1]
    const secMatch = /--color-accent-secondary:\s*(#[0-9a-fA-F]{6})/.exec(css)
    if (secMatch) colors.accentSecondary = secMatch[1]
    const bgMatch = /--color-bg:\s*(#[0-9a-fA-F]{6})/.exec(css)
    if (bgMatch) colors.bg = bgMatch[1]
    const surfMatch = /--color-surface:\s*(#[0-9a-fA-F]{6})/.exec(css)
    if (surfMatch) colors.surface = surfMatch[1]
  } catch {
    // Use defaults
  }
  return colors
}

function generateAssetCommands(
  preset: Preset,
  theme: ThemeColors,
  assetsDir: string,
): Array<Record<string, unknown>> {
  const commands: Array<Record<string, unknown>> = []
  const pptx = preset.pptx
  if (!pptx) return commands

  // Pattern assets
  for (const pat of pptx.patterns || []) {
    const filename = `pattern-${pat.type}.png`
    commands.push({
      type: "pattern",
      output: `${assetsDir}/${filename}`,
      width: 1280,
      height: 720,
      pattern_type: pat.type,
      dot_size: pat.dotSize,
      line_width: pat.lineWidth,
      spacing: pat.spacing,
      offset: pat.offset,
      color: theme.accent,
      opacity: pat.opacity,
    })
  }

  // Orb assets
  for (const orb of pptx.orbs || []) {
    const filename = `orb-${orb.size}-accent-blurred.png`
    commands.push({
      type: "orb",
      output: `${assetsDir}/${filename}`,
      diameter: orb.diameter,
      blur_radius: orb.blurRadius,
      color: theme.accent,
      opacity: orb.opacity,
    })
  }

  // Default gradient assets (cover style)
  commands.push({
    type: "gradient",
    output: `${assetsDir}/bg-gradient-cover.png`,
    width: 1280,
    height: 720,
    gradient_type: "radial",
    cx: 0.2,
    cy: 0.5,
    colors: [theme.accent, theme.accentSecondary, theme.bg],
  })

  commands.push({
    type: "gradient",
    output: `${assetsDir}/bg-gradient-surface.png`,
    width: 1280,
    height: 720,
    gradient_type: "linear",
    angle: 135,
    colors: [theme.surface, theme.bg],
  })

  return commands
}

export default tool({
  description:
    "Compile a composition preset into _preset.css plus rasterized PNG assets (orbs, patterns, gradients) for PPTX compatibility. Grid system is now part of _theme.css — this tool handles only preset-specific decoration classes and asset generation.",
  args: {
    projectName: tool.schema
      .string()
      .describe("Name of the presentation project folder under ./projects/"),
    preset: tool.schema
      .enum(["geometric-minimal", "editorial", "bold-shapes"])
      .describe("Composition preset name"),
  },
  async execute(args, context) {
    let projectName
    try {
      projectName = safeProjectSegment(args.projectName)
    } catch (e) {
      return `Error: ${e.message}`
    }
    let presetName
    try {
      presetName = safeProjectSegment(args.preset, "preset")
    } catch (e) {
      return `Error: ${e.message}`
    }

    const fs = await import("fs")
    const path = await import("path")
    const { opencodePath } = await import("./_paths.js")

    const designRoot = opencodePath("..", "office", "slides", "design")
    const compDir = path.join(designRoot, "composition")
    const presetsDir = path.join(compDir, "presets")
    const presetPath = path.join(presetsDir, `${presetName}.json`)

    if (!fs.existsSync(presetPath)) {
      return `Error: Preset "${args.preset}" not found at ${presetPath}`
    }

    let preset: Preset
    try {
      preset = JSON.parse(fs.readFileSync(presetPath, "utf-8"))
    } catch {
      return `Error: Failed to parse preset JSON at ${presetPath}`
    }

    const projectsRoot = path.join(process.cwd(), "projects")
    const projectDir = path.join(projectsRoot, projectName, "presentations")
    const assetsDir = path.join(projectDir, "assets")
    fs.mkdirSync(projectDir, { recursive: true })
    fs.mkdirSync(assetsDir, { recursive: true })

    // Generate _preset.css with decoration classes
    const presetCss = compilePresetCss(preset)
    const presetDest = path.join(projectDir, "_preset.css")
    fs.writeFileSync(presetDest, presetCss, "utf-8")
    const presetSize = fs.statSync(presetDest).size

    // Read theme colors for PNG generation
    const themeCssPath = path.join(projectDir, "_theme.css")
    const theme = readThemeColors(themeCssPath)

    // Generate PNG asset commands
    const assetCommands = generateAssetCommands(preset, theme, assetsDir)

    // Render assets via Python script
    const renderScript = opencodePath("pptx", "render_comp_assets.py")
    let renderResult = ""
    let assetCount = 0
    if (assetCommands.length > 0) {
      try {
        const jsonInput = JSON.stringify(assetCommands)
        const python = "python3"
        renderResult = execSync(`${python} "${renderScript}"`, {
          input: jsonInput,
          encoding: "utf-8",
          timeout: 60000,
        }).trim()
        assetCount = assetCommands.length
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        renderResult = `Warning: PNG asset generation failed — ${msg}. Slides will use fallback CSS mode.`
      }
    }

    const lines = [
      `Composition preset: ${preset.name}`,
      `"${args.preset}": ${preset.description}`,
      `Saved: ${presetDest} (${presetSize} bytes) — decoration classes (include via <link href="./_preset.css">)`,
      `Grid system already in _theme.css — no separate _grid.css needed`,
      `Available deco classes: deco-line-h, deco-line-v, deco-bracket-tl/tr/bl/br, deco-stripe-top/left, deco-orb-sm/lg, deco-pattern-dots/diagonals/crosses, deco-shape-circle/triangle/hex`,
    ]

    if (assetCount > 0) {
      lines.push(`Rendered ${assetCount} PNG asset(s) to ${assetsDir}/`)
      for (const cmd of assetCommands) {
        const filename = (cmd.output as string).split("/").pop()
        lines.push(`  \u2022 ${filename}`)
      }
    } else if (renderResult) {
      lines.push(renderResult)
    }

    return lines.join("\n")
  },
})
