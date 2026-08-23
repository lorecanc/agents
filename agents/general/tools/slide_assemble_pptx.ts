import { tool } from "@opencode-ai/plugin"

export default tool({
  description:
    "Assemble a .pptx presentation from a corporate template by populating placeholders with content from authored HTML slides. Preserves the template's slide master, layouts, and theme.",
  args: {
    projectName: tool.schema
      .string()
      .describe("Name of the presentation project folder under ./projects/"),
    templatePath: tool.schema
      .string()
      .describe("Absolute path to the corporate .pptx template file"),
    slideNames: tool.schema
      .array(tool.schema.string())
      .describe(
        "Ordered list of slide filenames, e.g. ['slide_01', 'slide_02']",
      ),
    layoutMap: tool.schema
      .record(tool.schema.string(), tool.schema.string())
      .describe(
        "Mapping of slide filename to layout name from the catalog, e.g. {'slide_01.html': 'title_centered_01'}",
      ),
    outputFilename: tool.schema
      .string()
      .describe(
        "Output filename stem, e.g. 'my_deck' (saved as my_deck.pptx inside the project folder)",
      ),
  },
  async execute(args, context) {
    const path = await import("path")
    const fs = await import("fs")
    const { spawn } = await import("child_process")
    const { getPythonPath } = await import("./_python.js")

    const { opencodePath } = await import("./_paths.js")

    const projectsRoot = path.join(process.cwd(), "projects")
    const projectDir = path.join(projectsRoot, args.projectName, "presentations")

    if (!fs.existsSync(projectDir)) {
      return `Error: Project directory not found: ${projectDir}`
    }

    const outputStem = path.parse(args.outputFilename).name
    let outputPath = path.join(projectDir, `${outputStem}.pptx`)

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

    const slidePaths: string[] = []
    for (const name of args.slideNames) {
      const filename = name.endsWith(".html") ? name : `${name}.html`
      const sp = path.join(projectDir, filename)
      if (!fs.existsSync(sp))
        return `Error: Slide not found: ${filename} (looked in ${projectDir})`
      slidePaths.push(sp)
    }

    // Build layout map keyed by filename
    const layoutMap: Record<string, string> = {}
    for (const [slideName, layoutName] of Object.entries(args.layoutMap)) {
      const filename = slideName.endsWith(".html") ? slideName : `${slideName}.html`
      layoutMap[filename] = layoutName
    }

    const scriptPy = opencodePath("..", "office", "slides", "scripts", "assemble_from_template.py")

    if (!fs.existsSync(scriptPy)) {
      return `Error: assemble_from_template.py not found at ${scriptPy}`
    }

    return new Promise((resolve) => {
      const proc = spawn(
        getPythonPath(),
        [
          scriptPy,
          "--template", args.templatePath,
          "--output", outputPath,
          "--layout-map", JSON.stringify(layoutMap),
          "--slides",
          ...slidePaths,
        ],
        {
          cwd: process.cwd(),
          timeout: 120_000,
        },
      )

      let stdout = ""
      let stderr = ""
      proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()))
      proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()))

      proc.on("close", (code: number) => {
        if (code === 0) {
          // Save HTML snapshot
          const snapshotDir = `${outputPath}.slides`
          fs.mkdirSync(snapshotDir, { recursive: true })
          for (let i = 0; i < slidePaths.length; i++) {
            const dest = path.join(snapshotDir, `${i + 1}.html`)
            fs.copyFileSync(slidePaths[i], dest)
          }
          resolve(
            `Presentation saved to: ${outputPath}\nSnapshot saved to: ${snapshotDir}\nAssembled ${slidePaths.length} slide(s) using corporate template master`,
          )
        } else {
          resolve(`Error assembling presentation:\n${stderr || stdout}`)
        }
      })
      proc.on("error", (err: Error) => resolve(`Error: ${err.message}`))
    })
  },
})
