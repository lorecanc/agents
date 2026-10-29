import { tool } from "@opencode-ai/plugin"
import { createHash } from "node:crypto"
import { safeProjectSegment } from "./_safeName.js"

export default tool({
  description:
    "Download an image from a URL into the project's assets folder. Validates the downloaded content is a real image.",
  args: {
    projectName: tool.schema
      .string()
      .describe("Name of the presentation project folder under ./projects/"),
    url: tool.schema
      .string()
      .describe("Direct image URL to download (http/https)"),
    imageName: tool.schema
      .string()
      .describe("Desired filename with extension (e.g. 'logo.png')"),
    sha256: tool.schema
      .string()
      .optional()
      .describe("Expected SHA-256 hex digest of the downloaded image"),
    md5: tool.schema
      .string()
      .optional()
      .describe("Expected MD5 hex digest of the downloaded image"),
  },
  async execute(args, context) {
    if (args.sha256 !== undefined && !/^[a-f0-9]{64}$/i.test(args.sha256)) {
      return "Error: Invalid sha256 digest; expected 64 hexadecimal characters."
    }
    if (args.md5 !== undefined && !/^[a-f0-9]{32}$/i.test(args.md5)) {
      return "Error: Invalid md5 digest; expected 32 hexadecimal characters."
    }

    let projectName
    try {
      projectName = safeProjectSegment(args.projectName)
    } catch (e) {
      return `Error: ${e.message}`
    }
    let imageName
    try {
      imageName = safeProjectSegment(args.imageName, "imageName")
    } catch (e) {
      return `Error: ${e.message}`
    }

    const path = await import("path")
    const fs = await import("fs")

    const projectsRoot = path.join(process.cwd(), "projects")
    const assetsDir = path.join(
      projectsRoot,
      projectName,
      "presentations",
      "assets",
    )
    fs.mkdirSync(assetsDir, { recursive: true })

    const outputPath = path.join(assetsDir, imageName)

    const response = await fetch(args.url, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
      signal: AbortSignal.timeout(30000),
    })
    if (!response.ok) return `Error: HTTP ${response.status} — ${response.statusText}`

    const buffer = new Uint8Array(await response.arrayBuffer())
    const sha256 = createHash("sha256").update(buffer).digest("hex")
    const md5 = createHash("md5").update(buffer).digest("hex")
    if (args.sha256 && sha256.toLowerCase() !== args.sha256.toLowerCase()) {
      return `Error: SHA-256 checksum mismatch; expected ${args.sha256}, got ${sha256}.`
    }
    if (args.md5 && md5.toLowerCase() !== args.md5.toLowerCase()) {
      return `Error: MD5 checksum mismatch; expected ${args.md5}, got ${md5}.`
    }

    // Reject HTML responses
    const head = new TextDecoder().decode(buffer.slice(0, 100)).toLowerCase()
    if (head.startsWith("<!doctype") || head.startsWith("<html")) {
      return "Error: URL did not return an image (got HTML). Use a direct image URL."
    }

    // Validate via file extension / known image signatures
    const ext = path.extname(imageName).toLowerCase()
    const validExts = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico"]
    if (!validExts.includes(ext)) {
      return `Error: Unrecognized image extension '${ext}'. Use .png, .jpg, .jpeg, .gif, .webp, .svg, or .bmp.`
    }

    // For SVG, verify it contains <svg tag
    if (ext === ".svg") {
      const text = new TextDecoder().decode(buffer).slice(0, 200).toLowerCase()
      if (!text.includes("<svg") && !text.includes("<?xml")) {
        return "Error: Downloaded file is not a valid SVG."
      }
    }

    fs.writeFileSync(outputPath, buffer)
    return `Downloaded image to: ${outputPath} (SHA-256: ${sha256}, MD5: ${md5})`
  },
})
