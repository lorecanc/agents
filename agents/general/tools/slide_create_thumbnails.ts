import { tool } from "@opencode-ai/plugin"
import { safeProjectSegment } from "./_safeName.js"

export default tool({
  description:
    "Create a visual thumbnail grid image of PowerPoint slides for quick analysis and reference.",
  args: {
    pptxPath: tool.schema
      .string()
      .describe(
        "Absolute or project-relative path to the .pptx file to thumbnail",
      ),
    outputPrefix: tool.schema
      .string()
      .optional()
      .describe(
        "Optional prefix for output files (default: '<pptx-stem>_thumbnails')",
      ),
    columns: tool.schema
      .number()
      .int()
      .min(3)
      .max(6)
      .optional()
      .describe("Number of columns in the grid (3-6, default 5)"),
  },
  async execute(args, context) {
    let outputPrefix: string | undefined
    if (args.outputPrefix) {
      try {
        outputPrefix = safeProjectSegment(args.outputPrefix, "outputPrefix")
      } catch (e) {
        return `Error: ${e.message}`
      }
    }

    const path = await import("path")
    const fs = await import("fs")
    const { spawn } = await import("child_process")
    const { getPythonPath } = await import("./_python.js")

    const { opencodePath } = await import("./_paths.js")

    const pptxPath = path.isAbsolute(args.pptxPath)
      ? args.pptxPath
      : path.join(process.cwd(), args.pptxPath)

    if (!fs.existsSync(pptxPath)) {
      return `Error: PPTX file not found at ${pptxPath}`
    }

    const stem = path.parse(pptxPath).name
    const prefix = outputPrefix || path.join(path.dirname(pptxPath), `${stem}_thumbnails`)
    const cols = args.columns || 5

    const thumbnailScript = opencodePath("pptx", "thumbnail.py")

    return new Promise((resolve, reject) => {
      const proc = spawn(
        getPythonPath(),
        [thumbnailScript, pptxPath, prefix, "--cols", String(cols)],
        { timeout: 60_000 },
      )

      let stdout = ""
      let stderr = ""
      proc.stdout.on("data", (d) => (stdout += d))
      proc.stderr.on("data", (d) => (stderr += d))

      proc.on("close", (code) => {
        if (code === 0) {
          resolve(
            `Thumbnail grid created.\n${stdout.trim() || "Check: " + prefix + ".jpg"}`,
          )
        } else {
          resolve(`Thumbnail generation error:\n${stderr || stdout}`)
        }
      })
      proc.on("error", (err) => resolve(`Thumbnail error: ${err.message}`))
    })
  },
})
