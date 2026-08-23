import { tool } from "@opencode-ai/plugin"

export default tool({
  description:
    "Analyze a corporate .pptx template (one-time): extracts theme colors/fonts, catalogs slide layouts, generates HTML skeletons, and creates a design system directory. Idempotent — skips if template fingerprint hasn't changed.",
  args: {
    templatePath: tool.schema
      .string()
      .describe("Absolute path to the corporate .pptx template file"),
    designName: tool.schema
      .string()
      .describe("Name for the design system directory (e.g. 'acme-corp')"),
    force: tool.schema
      .boolean()
      .optional()
      .describe("Re-analyze even if template fingerprint hasn't changed"),
  },
  async execute(args, context) {
    const path = await import("path")
    const fs = await import("fs")
    const { spawn } = await import("child_process")
    const { getPythonPath } = await import("./_python.js")

    const { opencodePath } = await import("./_paths.js")

    const designDir = opencodePath("..", "office", "slides", "design")

    const scriptPy = opencodePath("..", "office", "slides", "scripts", "analyze_slide_master.py")

    if (!fs.existsSync(scriptPy)) {
      return `Error: analyze_slide_master.py not found at ${scriptPy}`
    }

    const cmdArgs = [
      scriptPy,
      "--input", args.templatePath,
      "--design-name", args.designName,
      "--output-dir", designDir,
    ]

    if (args.force) {
      cmdArgs.push("--force")
    }

    return new Promise((resolve) => {
      const proc = spawn(getPythonPath(), cmdArgs, {
        cwd: process.cwd(),
        timeout: 120_000,
      })

      let stdout = ""
      let stderr = ""
      proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()))
      proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()))

      proc.on("close", (code: number) => {
        if (code === 0) {
          resolve(stdout.trim())
        } else {
          resolve(`Error analyzing template:\n${stderr || stdout}`)
        }
      })
      proc.on("error", (err: Error) => resolve(`Error: ${err.message}`))
    })
  },
})
