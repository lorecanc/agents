import { tool } from "@opencode-ai/plugin"
import { safeProjectSegment } from "./_safeName.js"

export default tool({
  description:
    "Convert HTML slides to an editable .pptx PowerPoint presentation using dom-to-pptx. Output is auto-versioned (my_deck.pptx, my_deck_v2.pptx, ...).",
  args: {
    projectName: tool.schema
      .string()
      .describe("Name of the presentation project folder under ./projects/"),
    slideNames: tool.schema
      .array(tool.schema.string())
      .describe(
        "Ordered list of slide filenames to include, e.g. ['slide_01', 'slide_02']",
      ),
    outputFilename: tool.schema
      .string()
      .describe(
        "Output filename stem, e.g. 'my_deck' (saved as my_deck.pptx inside the project folder)",
      ),
    layout: tool.schema
      .string()
      .optional()
      .describe(
        "Layout: LAYOUT_16x9_1280 (default), LAYOUT_16x9_1920, LAYOUT_16x9, LAYOUT_4x3, or LAYOUT_16x10",
      ),
  },
  async execute(args, context) {
    let projectName
    try {
      projectName = safeProjectSegment(args.projectName)
    } catch (e) {
      return `Error: ${e.message}`
    }
    const path = await import("path")
    const fs = await import("fs")
    const { spawn } = await import("child_process")

    let slideNames: string[]
    try {
      slideNames = args.slideNames.map((n, i) => safeProjectSegment(n, `slideNames[${i}]`))
    } catch (e) {
      return `Error: ${e.message}`
    }

    const projectsRoot = path.join(process.cwd(), "projects")
    const projectDir = path.join(
      projectsRoot,
      projectName,
      "presentations",
    )

    if (!fs.existsSync(projectDir)) {
      return `Error: Project directory not found: ${projectDir}`
    }

    const layout = args.layout || "LAYOUT_16x9_1280"
    let outputStem
    try {
      outputStem = safeProjectSegment(path.parse(args.outputFilename).name, "outputFilename")
    } catch (e) {
      return `Error: ${e.message}`
    }
    let outputPath = path.join(projectDir, `${outputStem}.pptx`)

    // Auto-version if file exists
    if (fs.existsSync(outputPath)) {
      let n = 2
      while (true) {
        const candidate = path.join(projectDir, `${outputStem}_v${n}.pptx`)
        if (!fs.existsSync(candidate)) {
          outputPath = candidate
          break
        }
        n++
      }
    }

    // Resolve slide paths
    const slidePaths: string[] = []
    for (const name of slideNames) {
      const filename = name.endsWith(".html") ? name : `${name}.html`
      const sp = path.join(projectDir, filename)
      if (!fs.existsSync(sp))
        return `Error: Slide not found: ${filename} (looked in ${projectDir})`
      slidePaths.push(sp)
    }

    const { opencodePath } = await import("./_paths.js")

    const runnerJs = opencodePath("pptx", "html2pptx_runner.js")

    const tmpDir = path.join(process.cwd(), "projects", projectName, ".tmp")
    fs.mkdirSync(tmpDir, { recursive: true })

    const nodeModulesPath = opencodePath("..", "node_modules")
    const nodePaths = [
      fs.existsSync(nodeModulesPath) ? nodeModulesPath : null,
      path.join(process.cwd(), "node_modules"),
    ].filter((d): d is string => d !== null && fs.existsSync(d))

    return new Promise((resolve, reject) => {
      const proc = spawn(
        process.execPath,
        [
          runnerJs,
          "--output", outputPath,
          "--layout", layout,
          "--tmp-dir", tmpDir,
          "--",
          ...slidePaths,
        ],
        {
          cwd: process.cwd(),
          env: { ...process.env, NODE_PATH: nodePaths.join(path.delimiter) },
          timeout: 300_000,
        },
      )

      let stdout = ""
      let stderr = ""
      proc.stdout.on("data", (d) => (stdout += d))
      proc.stderr.on("data", (d) => (stderr += d))

      proc.on("close", (code) => {
        if (code === 0) {
          const snapshotDir = `${outputPath}.slides`
          resolve(
            `Presentation saved to: ${outputPath}\nSnapshot saved to: ${snapshotDir}\nConverted ${slidePaths.length} slide(s)`,
          )
        } else {
          resolve(`Error converting HTML to PPTX:\n${stderr || stdout}`)
        }
      })
      proc.on("error", (err) => resolve(`Build error: ${err.message}`))
    })
  },
})
