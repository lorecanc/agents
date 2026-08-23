import { tool } from "@opencode-ai/plugin"

export default tool({
  description:
    "Create a new document from HTML or Markdown content. Saves .source.html (canonical source), runs validation, and generates a preview image. Supports html and markdown content types.",
  args: {
    projectName: tool.schema
      .string()
      .describe("Name of the project folder (creates/uses projects/<name>/documents/). Use lowercase_with_underscores."),
    documentName: tool.schema
      .string()
      .describe("Name of the document file without extension (e.g. 'quarterly_report')."),
    contentType: tool.schema
      .string()
      .describe("Content type: 'html' or 'markdown'."),
    content: tool.schema
      .string()
      .describe("The full document content (HTML or Markdown string)."),
    overwrite: tool.schema
      .boolean()
      .optional()
      .describe("If true, overwrites existing document. Default false."),
  },
  async execute(args, context) {
    const path = await import("path")
    const fs = await import("fs")
    const os = await import("os")
    const { spawn } = await import("child_process")
    const { getPythonPath } = await import("./_python.js")
    const { opencodePath } = await import("./_paths.js")

    const tmpFile = path.join(os.tmpdir(), `doc_create_${Date.now()}.html`)
    fs.writeFileSync(tmpFile, args.content, "utf-8")

    const scriptDir = opencodePath("docx", "scripts")
    const script = path.join(scriptDir, "create_document.py")
    const overwriteFlag = args.overwrite ? "true" : "false"

    return new Promise((resolve, reject) => {
      const proc = spawn(getPythonPath(), [
        script,
        args.projectName,
        args.documentName,
        args.contentType,
        tmpFile,
        overwriteFlag,
      ], {
        timeout: 60000,
      })
      let stdout = ""
      let stderr = ""
      proc.stdout.on("data", (d) => (stdout += d))
      proc.stderr.on("data", (d) => (stderr += d))
      proc.on("close", (code) => {
        fs.unlinkSync(tmpFile)
        if (code === 0) {
          try {
            const result = JSON.parse(stdout)
            if (result.preview_path) {
              return resolve(`Document created successfully.\nProject: ${result.project}\nDocument: ${result.document}\nFiles: ${result.files.join(", ")}\nPreview: ${result.preview_path}`)
            }
            return resolve(`Document created successfully.\nProject: ${result.project}\nDocument: ${result.document}\nFiles: ${result.files.join(", ")}`)
          } catch {
            return resolve(stdout || "Document created.")
          }
        }
        resolve(`Failed to create document: ${stderr || stdout || "unknown error"}`)
      })
      proc.on("error", (err) => {
        fs.unlinkSync(tmpFile)
        resolve(`Error: ${err.message}`)
      })
    })
  },
})
