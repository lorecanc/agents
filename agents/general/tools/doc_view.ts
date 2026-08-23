import { tool } from "@opencode-ai/plugin"

export default tool({
  description:
    "View the content of an existing document (reads from .source.html file). Optionally specify a view range to see only part of the document. Returns the HTML or Markdown content with line numbers.",
  args: {
    projectName: tool.schema
      .string()
      .describe("Name of the project folder containing the document."),
    documentName: tool.schema
      .string()
      .describe("Name of the document to view (without extension)."),
    startLine: tool.schema
      .number()
      .optional()
      .describe("Optional start line number (1-based) for a range view."),
    endLine: tool.schema
      .number()
      .optional()
      .describe("Optional end line number (1-based, inclusive) for a range view."),
  },
  async execute(args, context) {
    const path = await import("path")
    const { spawn } = await import("child_process")
    const { getPythonPath } = await import("./_python.js")
    const { opencodePath } = await import("./_paths.js")

    const scriptDir = opencodePath("docx", "scripts")
    const script = path.join(scriptDir, "view_document.py")

    const procArgs = [script, args.projectName, args.documentName]
    if (args.startLine && args.endLine) {
      procArgs.push(String(args.startLine), String(args.endLine))
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(getPythonPath(), procArgs, { timeout: 10000 })
      let stdout = ""
      let stderr = ""
      proc.stdout.on("data", (d) => (stdout += d))
      proc.stderr.on("data", (d) => (stderr += d))
      proc.on("close", (code) => {
        if (code === 0) {
          try {
            const result = JSON.parse(stdout)
            const header = `# Document: ${result.document}\nProject: ${result.project}\nSource: ${result.filename} (${result.total_lines} lines)\nViewing: lines ${result.view_start}-${result.view_end} of ${result.total_lines}\n\n---\n`
            return resolve(header + result.content)
          } catch {
            return resolve(stdout || "Document content.")
          }
        }
        resolve(`View failed: ${stderr || stdout || "unknown error"}`)
      })
      proc.on("error", (err) => resolve(`Error: ${err.message}`))
    })
  },
})
