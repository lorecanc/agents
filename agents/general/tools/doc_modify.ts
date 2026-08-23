import { tool } from "@opencode-ai/plugin"

export default tool({
  description:
    "Edit a document's HTML source. Supports search_and_replace (preferred, batch exact-match replacements), replace (replace a line range), insert (insert content before/after a line), and delete (remove a line range). Always call doc_view first to see current content.",
  args: {
    projectName: tool.schema
      .string()
      .describe("Name of the project folder containing the document."),
    documentName: tool.schema
      .string()
      .describe("Name of the document to edit (without extension)."),
    operation: tool.schema
      .string()
      .describe("Edit mode: 'search_and_replace' (batch), 'replace' (lines), 'insert', or 'delete'."),
    replacements: tool.schema
      .string()
      .optional()
      .describe("JSON array of {old_content, new_content} objects. Required for search_and_replace."),
    startLine: tool.schema
      .number()
      .optional()
      .describe("Starting line number (1-based). Required for line operations."),
    endLine: tool.schema
      .number()
      .optional()
      .describe("Ending line number (inclusive). Required for replace and delete."),
    newContent: tool.schema
      .string()
      .optional()
      .describe("New HTML content. Required for replace and insert."),
    after: tool.schema
      .boolean()
      .optional()
      .describe("For insert only: insert AFTER start_line instead of before."),
  },
  async execute(args, context) {
    const path = await import("path")
    const { spawn } = await import("child_process")
    const { getPythonPath } = await import("./_python.js")
    const { opencodePath } = await import("./_paths.js")

    const scriptDir = opencodePath("docx", "scripts")
    const script = path.join(scriptDir, "modify_document.py")

    const callArgs: Record<string, any> = {}
    if (args.replacements) {
      try {
        callArgs.replacements = JSON.parse(args.replacements)
      } catch {
        callArgs.replacements = args.replacements
      }
    }
    if (args.startLine !== undefined) callArgs.start_line = args.startLine
    if (args.endLine !== undefined) callArgs.end_line = args.endLine
    if (args.newContent !== undefined) callArgs.new_content = args.newContent
    if (args.after !== undefined) callArgs.after = args.after

    return new Promise((resolve, reject) => {
      const proc = spawn(getPythonPath(), [
        script,
        args.projectName,
        args.documentName,
        args.operation,
        JSON.stringify(callArgs),
      ], {
        timeout: 30000,
      })
      let stdout = ""
      let stderr = ""
      proc.stdout.on("data", (d) => (stdout += d))
      proc.stderr.on("data", (d) => (stderr += d))
      proc.on("close", (code) => {
        if (code === 0) {
          try {
            const result = JSON.parse(stdout)
            return resolve(`Edit applied: ${result.operation} (${result.count || ""})`)
          } catch {
            return resolve(stdout || "Edit applied.")
          }
        }
        resolve(`Edit failed: ${stderr || stdout || "unknown error"}`)
      })
      proc.on("error", (err) => resolve(`Error: ${err.message}`))
    })
  },
})
