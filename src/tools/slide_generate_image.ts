import { tool } from "@opencode-ai/plugin"
import { safeProjectSegment } from "./_safeName.js"

export default tool({
  description:
    "Generate AI images using Google Gemini models. Supports diagrams (flowcharts, org charts) via Gemini Pro and concept art via Gemini Flash.",
  args: {
    prompt: tool.schema
      .string()
      .describe(
        "Detailed description of the image to generate. Be specific about layout, colors, style, and text.",
      ),
    imageType: tool.schema
      .enum(["diagram", "concept_art"])
      .describe(
        "Type: 'diagram' for flowcharts/org charts, 'concept_art' for illustrations",
      ),
    projectName: tool.schema
      .string()
      .describe("Name of the presentation project"),
    assetName: tool.schema
      .string()
      .describe(
        "Filename with extension for the generated image (e.g. 'hero.jpg'). Saved in projects/<name>/presentations/assets/.",
      ),
    width: tool.schema
      .number()
      .int()
      .optional()
      .describe("Image width in pixels (default 1024)"),
    height: tool.schema
      .number()
      .int()
      .optional()
      .describe("Image height in pixels (default 1024)"),
    style: tool.schema
      .string()
      .optional()
      .describe(
        "Optional style modifier: 'minimalist', 'professional', 'hand-drawn', 'technical'",
      ),
  },
  async execute(args, context) {
    let projectName
    try {
      projectName = safeProjectSegment(args.projectName)
    } catch (e) {
      return `Error: ${e.message}`
    }
    let assetName
    try {
      assetName = safeProjectSegment(args.assetName, "assetName")
    } catch (e) {
      return `Error: ${e.message}`
    }

    const path = await import("path")
    const fs = await import("fs")
    const { spawn } = await import("child_process")
    const { getPythonPath } = await import("./_python.js")

    const hasApiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
    if (!hasApiKey) {
      return "Error: No Gemini API key found. Set GEMINI_API_KEY or GOOGLE_API_KEY environment variable."
    }

    const projectsRoot = path.join(process.cwd(), "projects")
    const assetsDir = path.join(
      projectsRoot,
      projectName,
      "presentations",
      "assets",
    )
    fs.mkdirSync(assetsDir, { recursive: true })

    const outputPath = path.join(assetsDir, assetName)

    // Build a self-contained Python generation script
    const script = `
import json, sys, os, io
from urllib.request import Request, urlopen

model = "gemini-3-pro-image-preview" if "${args.imageType}" == "diagram" else "gemini-2.5-flash-image"
prompt = ${JSON.stringify(args.prompt)}
style = ${JSON.stringify(args.style || "")}
width = ${args.width || 1024}
height = ${args.height || 1024}

if "${args.imageType}" == "diagram":
    prompt = f"Technical diagram: {prompt}. Clear labels, professional layout, high contrast."
else:
    prompt = f"High-quality illustration: {prompt}"

if style:
    prompt = f"{prompt} Style: {style}"

api_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"

body = json.dumps({
    "contents": [{"parts": [{"text": prompt}]}],
    "generationConfig": {
        "responseModalities": ["Text", "Image"],
        "imageConfig": {"aspectRatio": "1:1"}
    }
}).encode("utf-8")

req = Request(url, data=body, headers={"Content-Type": "application/json"})
with urlopen(req, timeout=120) as resp:
    data = json.loads(resp.read())

# Extract image from response
image_bytes = None
for part in data.get("candidates", [{}])[0].get("content", {}).get("parts", []):
    if "inlineData" in part and part["inlineData"].get("mimeType", "").startswith("image/"):
        import base64
        image_bytes = base64.b64decode(part["inlineData"]["data"])
        break

if not image_bytes:
    print("ERROR: No image data in response")
    sys.exit(1)

from PIL import Image
img = Image.open(io.BytesIO(image_bytes))
if img.width > 1024 or img.height > 1024:
    new_size = (int(img.width * 0.75), int(img.height * 0.75))
    img = img.resize(new_size, Image.Resampling.LANCZOS)
img.save("${outputPath}", "JPEG", quality=80, optimize=True)
print(f"Image saved to ./assets/${assetName}")
`

    return new Promise((resolve) => {
      const proc = spawn(
        getPythonPath(),
        ["-c", script],
        {
          env: { ...process.env },
          timeout: 120_000,
          cwd: path.join(process.cwd(), "projects", projectName, "presentations"),
        },
      )

      let stdout = ""
      let stderr = ""
      proc.stdout.on("data", (d) => (stdout += d))
      proc.stderr.on("data", (d) => (stderr += d))

      proc.on("close", (code) => {
        if (code === 0 && stdout.includes("Image saved")) {
          resolve(stdout.trim())
        } else {
          resolve(`Image generation failed:\n${stderr || stdout || "unknown error"}`)
        }
      })
      proc.on("error", (err) => resolve(`Generation error: ${err.message}`))
    })
  },
})
