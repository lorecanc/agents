import { tool } from "@opencode-ai/plugin"

export default tool({
  description:
    "Restore the working HTML source of a document to the state it was in at a previous DOCX export. Every DOCX export saves a companion .snapshot.html file alongside it. This tool reads the snapshot and writes it back as the canonical .source.html.",
  args: {
    projectName: tool.schema
      .string()
      .describe("Name of the project folder containing the document."),
    docxFilename: tool.schema
      .string()
      .describe("Filename of the DOCX export to restore from, e.g. 'report.docx' or 'report_v2.docx'."),
  },
  async execute(args, context) {
    const path = await import("path")
    const { spawn } = await import("child_process")
    const { getPythonPath } = await import("./_python.js")
    const { opencodePath } = await import("./_paths.js")

    const scriptDir = opencodePath("docx", "scripts")
    const script = path.join(scriptDir, "restore_document.py")

    return new Promise((resolve, reject) => {
      const proc = spawn(getPythonPath(), [script, args.projectName, args.docxFilename], { timeout: 10000 })
      let stdout = ""
      let stderr = ""
      proc.stdout.on("data", (d) => (stdout += d))
      proc.stderr.on("data", (d) => (stderr += d))
      proc.on("close", (code) => {
        if (code === 0) {
          try {
            const result = JSON.parse(stdout)
            return resolve(`Restored '${result.document}' to version in '${result.restored_from}'. Source: ${result.source_path}`)
          } catch {
            return resolve(stdout || "Restore complete.")
          }
        }
        resolve(`Restore failed: ${stderr || stdout || "unknown error"}`)
      })
      proc.on("error", (err) => resolve(`Error: ${err.message}`))
    })
  },
})
