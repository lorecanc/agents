import assert from "node:assert/strict"
import { test } from "node:test"
import { registerHooks } from "node:module"

// @opencode-ai/plugin is not installed in this repo. Register sync module hooks
// BEFORE the dynamic imports below so every tool module resolves against a stub
// whose `tool(def)` returns `def` and whose `tool.schema` is a self-returning
// Proxy (covers .string/.enum/.array/.record/.int/.min/.max/.optional/.describe).
const STUB_SOURCE = `
const selfReturning = () => new Proxy(function () {}, {
  get(_target, prop) {
    if (prop === "then") return undefined
    return selfReturning()
  },
  apply() {
    return selfReturning()
  },
})
export const tool = Object.assign((def) => def, { schema: selfReturning() })
`

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@opencode-ai/plugin") {
      return { url: "opencode-plugin-stub://plugin", shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.startsWith("opencode-plugin-stub:")) {
      return { format: "module", source: STUB_SOURCE, shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})

const loadTool = async (name) => (await import(`./${name}.ts`)).default

test("stub hooks expose execute on guarded tool modules", async () => {
  const docList = await loadTool("doc_list")
  assert.equal(typeof docList.execute, "function")
})

test("doc_list rejects projectName traversal before spawning python", async () => {
  const docList = await loadTool("doc_list")
  const result = await docList.execute({ projectName: "../escape" }, {})
  assert.ok(result.startsWith("Error: Invalid"), result)
  assert.ok(result.includes("projectName"), result)
})

test("doc_create rejects projectName traversal before any tmp write", async () => {
  const docCreate = await loadTool("doc_create")
  // Guards are the first statements of execute(), so this returns before the
  // tmpFile write and no filesystem access happens.
  const result = await docCreate.execute({ projectName: "../escape" }, {})
  assert.ok(result.startsWith("Error: Invalid"), result)
  assert.ok(result.includes("projectName"), result)
})

test("slide_generate_image rejects projectName traversal", async () => {
  const generateImage = await loadTool("slide_generate_image")
  const result = await generateImage.execute(
    { projectName: "../escape", assetName: "hero.jpg", prompt: "x", imageType: "diagram" },
    {},
  )
  assert.ok(result.startsWith("Error: Invalid"), result)
  assert.ok(result.includes("projectName"), result)
})

test("slide_generate_image rejects assetName path separators", async () => {
  const generateImage = await loadTool("slide_generate_image")
  const result = await generateImage.execute(
    { projectName: "proj", assetName: "a/b.png", prompt: "x", imageType: "diagram" },
    {},
  )
  assert.ok(result.startsWith("Error: Invalid"), result)
  assert.ok(result.includes("assetName"), result)
})

test("slide_screenshot rejects slideName traversal", async () => {
  const screenshot = await loadTool("slide_screenshot")
  const result = await screenshot.execute(
    { projectName: "proj", slideName: "../evil" },
    {},
  )
  assert.ok(result.startsWith("Error: Invalid"), result)
  assert.ok(result.includes("slideName"), result)
})

test("slide_assemble_pptx reports the offending slideNames index", async () => {
  const assemble = await loadTool("slide_assemble_pptx")
  const result = await assemble.execute(
    {
      projectName: "proj",
      templatePath: "/tmp/template.pptx",
      slideNames: ["ok", "../bad"],
      layoutMap: {},
      outputFilename: "deck",
    },
    {},
  )
  assert.ok(result.startsWith("Error: Invalid"), result)
  assert.ok(result.includes("slideNames[1]"), result)
})

test("slide_build_pptx reports the offending slideNames index", async () => {
  const buildPptx = await loadTool("slide_build_pptx")
  const result = await buildPptx.execute(
    {
      projectName: "proj",
      slideNames: ["ok", "../bad"],
      outputFilename: "deck",
    },
    {},
  )
  assert.ok(result.startsWith("Error: Invalid"), result)
  assert.ok(result.includes("slideNames[1]"), result)
})

test("slide_compile_theme rejects designSystem traversal", async () => {
  const compileTheme = await loadTool("slide_compile_theme")
  const result = await compileTheme.execute(
    { projectName: "proj", designSystem: "../evil" },
    {},
  )
  assert.ok(result.startsWith("Error: Invalid"), result)
  assert.ok(result.includes("designSystem"), result)
})

test("slide_compile_composition rejects preset traversal", async () => {
  const compileComposition = await loadTool("slide_compile_composition")
  const result = await compileComposition.execute(
    { projectName: "proj", preset: "../x" },
    {},
  )
  assert.ok(result.startsWith("Error: Invalid"), result)
  assert.ok(result.includes("preset"), result)
})

test("slide_analyze_template rejects designName traversal", async () => {
  const analyzeTemplate = await loadTool("slide_analyze_template")
  const result = await analyzeTemplate.execute(
    { templatePath: "/tmp/template.pptx", designName: "../evil" },
    {},
  )
  assert.ok(result.startsWith("Error: Invalid"), result)
  assert.ok(result.includes("designName"), result)
})

test("slide_create_thumbnails rejects outputPrefix traversal", async () => {
  const thumbnails = await loadTool("slide_create_thumbnails")
  const result = await thumbnails.execute(
    { pptxPath: "missing.pptx", outputPrefix: "../x" },
    {},
  )
  assert.ok(result.startsWith("Error: Invalid"), result)
  assert.ok(result.includes("outputPrefix"), result)
})

test("slide_create_thumbnails accepts an undefined outputPrefix", async () => {
  const thumbnails = await loadTool("slide_create_thumbnails")
  const result = await thumbnails.execute({ pptxPath: "missing.pptx" }, {})
  assert.ok(!result.startsWith("Error: Invalid"), result)
  assert.ok(result.startsWith("Error: PPTX file not found"), result)
})

test("slide_build_pptx passes guards and reaches the project lookup", async () => {
  const buildPptx = await loadTool("slide_build_pptx")
  const result = await buildPptx.execute(
    {
      projectName: "no_such_project",
      slideNames: ["slide_01"],
      outputFilename: "deck",
    },
    {},
  )
  assert.ok(result.startsWith("Error: Project directory not found"), result)
})

test("slide_generate_image passes guards and reaches the API key check", async () => {
  const generateImage = await loadTool("slide_generate_image")
  const gemini = process.env.GEMINI_API_KEY
  const google = process.env.GOOGLE_API_KEY
  delete process.env.GEMINI_API_KEY
  delete process.env.GOOGLE_API_KEY
  try {
    const result = await generateImage.execute(
      { prompt: "x", imageType: "diagram", projectName: "proj", assetName: "hero.jpg" },
      {},
    )
    assert.ok(result.startsWith("Error: No Gemini API key"), result)
  } finally {
    if (gemini !== undefined) process.env.GEMINI_API_KEY = gemini
    if (google !== undefined) process.env.GOOGLE_API_KEY = google
  }
})
