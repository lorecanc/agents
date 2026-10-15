import { tool } from "@opencode-ai/plugin"
import { safeProjectSegment } from "./_safeName.js"

export default tool({
  description:
    "List all documents in a project folder. Shows .source.html files (canonical source), associated DOCX exports with snapshot info, and converted formats (PDF, Markdown, TXT).",
  args: {
    projectName: tool.schema
      .string()
      .describe("Name of the project folder to list documents from."),
  },
  async execute(args, context) {
    let projectName
    try {
      projectName = safeProjectSegment(args.projectName)
    } catch (e) {
      return `Error: ${e.message}`
    }

    const path = await import("path")
    const { spawn } = await import("child_process")
    const { getPythonPath } = await import("./_python.js")
    const { opencodePath } = await import("./_paths.js")

    const scriptDir = opencodePath("docx", "scripts")
    const script = path.join(scriptDir, "list_documents.py")

    return new Promise((resolve, reject) => {
      const proc = spawn(getPythonPath(), [script, projectName], { timeout: 10000 })
      let stdout = ""
      let stderr = ""
      proc.stdout.on("data", (d) => (stdout += d))
      proc.stderr.on("data", (d) => (stderr += d))
      proc.on("close", (code) => {
        if (code === 0) {
          try {
            const result = JSON.parse(stdout)
            let msg = `Project: ${result.project}\nPath: ${result.path}\n\nDocuments (${result.documents.length}):\n\n`
            for (const doc of result.documents) {
              msg += `  ${doc.name}\n`
              msg += `    Source: ${doc.source.filename} (${doc.source.size} bytes)\n`
              if (doc.docx_exports.length > 0) {
                msg += `    DOCX exports:\n`
                for (const exp of doc.docx_exports) {
                  msg += `      - ${exp.filename} (${exp.size} bytes)${exp.has_snapshot ? " [snapshot]" : ""}\n`
                }
              } else {
                msg += `    DOCX exports: none\n`
              }
              if (Object.keys(doc.other_formats).length > 0) {
                const formats = Object.entries(doc.other_formats).map(([k, v]: [string, any]) => `${k} (${v.size} bytes)`).join(", ")
                msg += `    Other formats: ${formats}\n`
              }
              msg += "\n"
            }
            return resolve(msg)
          } catch {
            return resolve(stdout || "Documents listed.")
          }
        }
        resolve(`List failed: ${stderr || stdout || "unknown error"}`)
      })
      proc.on("error", (err) => resolve(`Error: ${err.message}`))
    })
  },
})
