import { tool } from "@opencode-ai/plugin"
import { safeProjectSegment } from "./_safeName.js"

export default tool({
  description:
    "Convert a document to different formats. Reads the .source.html file and converts to PDF (high-quality, print-ready), DOCX (Word, auto-versioned), Markdown, or TXT. DOCX exports are auto-versioned with snapshot backups.",
  args: {
    projectName: tool.schema
      .string()
      .describe("Name of the project folder containing the document."),
    documentName: tool.schema
      .string()
      .describe("Name of the document to convert (without extension)."),
    outputFormat: tool.schema
      .string()
      .describe("Target format: 'pdf', 'docx', 'markdown', or 'txt'."),
    overwrite: tool.schema
      .boolean()
      .optional()
      .describe("If true (default), overwrites existing converted file for non-DOCX formats."),
  },
  async execute(args, context) {
    let projectName
    try {
      projectName = safeProjectSegment(args.projectName)
    } catch (e) {
      return `Error: ${e.message}`
    }
    let documentName
    try {
      documentName = safeProjectSegment(args.documentName, "documentName")
    } catch (e) {
      return `Error: ${e.message}`
    }

    const path = await import("path")
    const { spawn } = await import("child_process")
    const { getPythonPath } = await import("./_python.js")
    const { opencodePath } = await import("./_paths.js")

    const scriptDir = opencodePath("docx", "scripts")
    const script = path.join(scriptDir, "convert_document.py")
    const overwriteFlag = args.overwrite !== false ? "true" : "false"

    return new Promise((resolve, reject) => {
      const proc = spawn(getPythonPath(), [
        script,
        projectName,
        documentName,
        args.outputFormat,
        overwriteFlag,
      ], {
        timeout: 120000,
      })
      let stdout = ""
      let stderr = ""
      proc.stdout.on("data", (d) => (stdout += d))
      proc.stderr.on("data", (d) => (stderr += d))
      proc.on("close", (code) => {
        if (code === 0) {
          try {
            const result = JSON.parse(stdout)
            return resolve(`Converted to ${args.outputFormat.toUpperCase()}.\nOutput: ${result.output_path}`)
          } catch {
            return resolve(stdout || "Conversion complete.")
          }
        }
        resolve(`Conversion failed: ${stderr || stdout || "unknown error"}`)
      })
      proc.on("error", (err) => resolve(`Error: ${err.message}`))
    })
  },
})
