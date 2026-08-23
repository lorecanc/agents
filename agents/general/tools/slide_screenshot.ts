import { tool } from "@opencode-ai/plugin"

export default tool({
  description:
    "Take a screenshot of an HTML slide (1280x720) using Playwright. Returns the file path of the saved screenshot.",
  args: {
    projectName: tool.schema
      .string()
      .describe("Name of the presentation project folder under ./projects/"),
    slideName: tool.schema
      .string()
      .describe("Slide filename (e.g. 'slide_01' or 'slide_01.html')"),
    outputPath: tool.schema
      .string()
      .optional()
      .describe("Optional output image path (.jpg or .png). Defaults to a temp file."),
  },
  async execute(args, context) {
    const path = await import("path")
    const fs = await import("fs")
    const os = await import("os")
    const { spawn } = await import("child_process")

    const projectsRoot = path.join(process.cwd(), "projects")
    const projectDir = path.join(
      projectsRoot,
      args.projectName,
      "presentations",
    )
    const slideFilename = args.slideName.endsWith(".html")
      ? args.slideName
      : `${args.slideName}.html`
    const slidePath = path.join(projectDir, slideFilename)

    if (!fs.existsSync(slidePath)) {
      return `Error: Slide not found at ${slidePath}`
    }

    const screenshotPath =
      args.outputPath ||
      path.join(os.tmpdir(), `slide_screenshot_${Date.now()}.jpg`)

    // Use Playwright via a small inline script to screenshot the slide
    const script = `
      const { chromium } = require("playwright");
      (async () => {
        const browser = await chromium.launch({ headless: true });
        const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
        await page.goto("file://${slidePath}", { waitUntil: "load", timeout: 20000 });
        await page.waitForTimeout(800);
        await page.screenshot({
          path: "${screenshotPath}",
          clip: { x: 0, y: 0, width: 1280, height: 720 },
          type: "jpeg",
          quality: 80,
        });
        await browser.close();
        console.log("OK " + "${screenshotPath}");
      })().catch(e => { console.error(e.message); process.exit(1); });
    `

    const { opencodePath } = await import("./_paths.js")

    return new Promise((resolve, reject) => {
      const proc = spawn("node", ["-e", script], {
        cwd: opencodePath(".."),
        timeout: 30000,
      })
      let stdout = ""
      let stderr = ""
      proc.stdout.on("data", (d) => (stdout += d))
      proc.stderr.on("data", (d) => (stderr += d))
      proc.on("close", (code) => {
        if (code === 0) resolve(`Screenshot saved to: ${screenshotPath}`)
        else resolve(`Screenshot failed: ${stderr || "unknown error"}`)
      })
      proc.on("error", (err) => resolve(`Screenshot error: ${err.message}`))
    })
  },
})
