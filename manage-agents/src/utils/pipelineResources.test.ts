import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { checkPipelineResources, discoverCompanionResourcePaths, exportAgents, findAgentFiles, mergeOpenCodePluginsConfig, organizeAgents, traceRelativeToolDependencies } from "./agents.js"
import { DEFAULT_COMPANION_LINKS } from "./companionLinks.js"

function write(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

function agentFile(permission: Record<string, string>) {
  const lines = Object.entries(permission).map(([key, value]) => `  ${key}: ${value}`)
  return `---\ndescription: test agent\nmode: subagent\nmodel: x/y\npermission:\n${lines.join("\n")}\n---\n\nBody.\n`
}

/** A workspace whose canonical pipeline uses V2 plugin directories and tools no agent permits yet. */
function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-resources-"))
  write(path.join(root, "src", "agents", "pipeline-orchestrator.md"), agentFile({ pipeline_state: "allow" }))
  write(path.join(root, "src", "agents", "pipeline-executor.md"), agentFile({ dev_verify: "allow" }))
  write(path.join(root, "src", "tools", "pipeline_state.ts"), `import { a } from "./_pipeline_core.js"\nexport default a\n`)
  write(path.join(root, "src", "tools", "dev_verify.ts"), `import { b } from "./_run.js"\nexport default b\n`)
  write(path.join(root, "src", "tools", "dev_env.ts"), `import { c } from "./_env.js"\nexport default c\n`)
  write(path.join(root, "src", "tools", "_pipeline_core.js"), `export const a = 1\n`)
  write(path.join(root, "src", "tools", "_run.js"), `import { a } from "./_pipeline_core.js"\nimport { safe } from "./_safeName.js"\nexport const b = a + safe\n`)
  write(path.join(root, "src", "tools", "_env.js"), `import { a } from "./_services.js"\nexport const c = a\n`)
  write(path.join(root, "src", "tools", "_services.js"), `export const a = 2\n`)
  write(path.join(root, "src", "tools", "_safeName.js"), `export const safe = 3\n`)
  write(path.join(root, "src", "tools", "_pipeline_core.test.mjs"), `// test\n`)
  write(path.join(root, "src", "tools", "_testutil.mjs"), `// util\n`)
  write(path.join(root, "src", "tools", "doc_view.ts"), `export default 1\n`)
  write(path.join(root, "src", "plugins", "pipeline-guard", "index.ts"), `import { a } from "../../tools/_pipeline_core.js"\nexport default a\n`)
  write(path.join(root, "src", "plugins", "pipeline-tools", "index.ts"), `import { c } from "../../tools/dev_env.js"\nexport default c\n`)
  write(path.join(root, "src", "plugins", "doc-tools", "index.ts"), `export default 1\n`)
  write(path.join(root, "src", "plugins", "slide-tools", "index.ts"), `export default 1\n`)
  return root
}

const PIPELINE_PAYLOAD = [
  "plugins/doc-tools/index.ts",
  "plugins/pipeline-guard/index.ts",
  "plugins/pipeline-tools/index.ts",
  "plugins/slide-tools/index.ts",
  "tools/_env.js",
  "tools/_pipeline_core.js",
  "tools/_run.js",
  "tools/_safeName.js",
  "tools/_services.js",
  "tools/dev_env.ts",
  "tools/dev_verify.ts",
  "tools/pipeline_state.ts"
]

test("pipeline companions include V2 plugin directory files, tools and traced helpers, never tests", () => {
  const root = workspace()
  const agents = findAgentFiles(root, "src").filter(agent => agent.category === "pipeline")
  const found = discoverCompanionResourcePaths(path.join(root, "src"), ["pipeline"], undefined, agents)
  assert.deepEqual(found.filter(file => /^(?:tools|plugins)\//.test(file)), PIPELINE_PAYLOAD)
})

test("plugin-imported tools trace opencodePath assets and transitive helper imports", (t) => {
  const root = workspace()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const sourceRoot = path.join(root, "src")
  write(path.join(sourceRoot, "plugins", "doc-tools", "index.ts"), `import { render } from "../../tools/doc_render.js"\nexport default render\n`)
  write(path.join(sourceRoot, "tools", "doc_render.ts"), `import { python } from "./_python.js"\nexport const theme = opencodePath("assets", "_doc_theme.template.css")\nexport default python\n`)
  write(path.join(sourceRoot, "tools", "_python.js"), `import { paths } from "./_paths.js"\nexport const python = paths\n`)
  write(path.join(sourceRoot, "tools", "_paths.js"), `export const paths = {}\n`)
  write(path.join(sourceRoot, "tools", "assets", "_doc_theme.template.css"), `body {}\n`)

  const expected = [
    "plugins/doc-tools/index.ts",
    "tools/_paths.js",
    "tools/_python.js",
    "tools/assets/_doc_theme.template.css",
    "tools/doc_render.ts"
  ]
  assert.deepEqual([...traceRelativeToolDependencies(sourceRoot, ["plugins/doc-tools/index.ts"])].sort(), expected)
  const agents = findAgentFiles(root, "src").filter(agent => agent.category === "pipeline")
  const discovered = discoverCompanionResourcePaths(sourceRoot, ["pipeline"], undefined, agents)
  assert.ok(expected.every(file => discovered.includes(file)))
})

test("OpenCode export installs the V2 plugin directories and all pipeline tools as siblings", () => {
  const root = workspace()
  const config = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-resources-xdg-"))
  const previous = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = config
  try {
    const agents = findAgentFiles(root, "src").filter(agent => agent.category === "pipeline")
    const result = exportAgents(agents, undefined, path.join(root, "src"))
    const installed = result.domainResources.map(file => path.relative(path.join(config, "opencode"), file).split(path.sep).join("/")).sort()
    assert.deepEqual(installed.filter(file => /^(?:tools|plugins)\//.test(file)), PIPELINE_PAYLOAD)
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previous
  }
})

test("exportAgents and checkPipelineResources accept index.js V2 plugin directories", (t) => {
  const root = workspace()
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-resources-js-xdg-"))
  const previous = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = xdg
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previous
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(xdg, { recursive: true, force: true })
  })

  write(path.join(root, "src", "plugins", "js-only", "index.js"), "export default 1\n")
  const linksPath = path.join(root, ".agent-manager", "companion-links.json")
  fs.mkdirSync(path.dirname(linksPath), { recursive: true })
  const links = structuredClone(DEFAULT_COMPANION_LINKS)
  links.categories.pipeline.plugins.push("plugins/js-only")
  fs.writeFileSync(linksPath, JSON.stringify(links))

  const agents = findAgentFiles(root, "src").filter(agent => agent.category === "pipeline")
  const problems = checkPipelineResources(path.join(root, "src"), agents)
  const result = exportAgents(agents, undefined, path.join(root, "src"))
  const config = JSON.parse(fs.readFileSync(path.join(xdg, "opencode", "opencode.json"), "utf8"))

  assert.deepEqual({
    exportedIndexJs: result.domainResources.some(file => file.endsWith(path.join("plugins", "js-only", "index.js"))),
    registeredPlugin: config.plugins.includes("./plugins/js-only"),
    checkerAcceptsPlugin: !problems.some(problem => problem.kind === "missing-companion" && problem.path.startsWith("plugins/js-only/"))
  }, { exportedIndexJs: true, registeredPlugin: true, checkerAcceptsPlugin: true })
})

test("checkPipelineResources reports permitted tools and helper imports that are not shipped", () => {
  const root = workspace()
  write(path.join(root, "src", "agents", "pipeline-ops.md"), agentFile({ dev_smoke: "allow", dev_serve: "deny" }))
  fs.rmSync(path.join(root, "src", "tools", "_services.js"))
  const agents = findAgentFiles(root, "src").filter(agent => agent.category === "pipeline")
  const problems = checkPipelineResources(path.join(root, "src"), agents)
  assert.deepEqual(problems.map(problem => `${problem.kind} ${problem.path}`).sort(), [
    "missing-dependency tools/_services.js",
    "missing-tool tools/dev_smoke.ts"
  ])
})

test("checkPipelineResources reports a symlinked top-level tool", { skip: process.platform === "win32" }, (t) => {
  const root = workspace()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const sourceRoot = path.join(root, "src")
  const agents = findAgentFiles(root, "src").filter(agent => agent.category === "pipeline")
  write(path.join(root, "external-tool.ts"), "export default 1\n")
  fs.symlinkSync(path.join(root, "external-tool.ts"), path.join(sourceRoot, "tools", "doc_symlink.ts"))

  const problems = checkPipelineResources(sourceRoot, agents)
  assert.ok(problems.some(problem => problem.kind === "missing-dependency" && problem.path === "tools/doc_symlink.ts"))
})

test("checkPipelineResources reports missing helpers and opencodePath assets from shipped tools", (t) => {
  const root = workspace()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  write(path.join(root, "src", "tools", "doc_broken.ts"), `import { helper } from "./_missing_helper.js"\nexport const theme = opencodePath("./missing.css")\nexport const nestedTheme = opencodePath("nested", "missing.css")\nexport default helper\n`)

  const agents = findAgentFiles(root, "src").filter(agent => agent.category === "pipeline")
  const problems = checkPipelineResources(path.join(root, "src"), agents)
  assert.deepEqual(
    problems.filter(problem => problem.kind === "missing-dependency").map(problem => problem.path).sort(),
    ["tools/_missing_helper.js", "tools/missing.css", "tools/nested/missing.css"]
  )
})

test("checkPipelineResources does not resolve opencodePath assets outside tools/", (t) => {
  const root = workspace()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  write(path.join(root, "src", "root_asset.css"), "body {}\n")
  write(path.join(root, "src", "tools", "doc_nested.ts"), `export const theme = opencodePath("nested/../../root_asset.css")\n`)

  const agents = findAgentFiles(root, "src").filter(agent => agent.category === "pipeline")
  const problems = checkPipelineResources(path.join(root, "src"), agents)
  assert.ok(problems.some(problem => problem.kind === "missing-dependency" && problem.path === "root_asset.css"))
})

test("checkPipelineResources reports a plugin directory without index.ts", () => {
  const root = workspace()
  fs.rmSync(path.join(root, "src", "plugins", "pipeline-guard", "index.ts"))
  const agents = findAgentFiles(root, "src").filter(agent => agent.category === "pipeline")
  const problems = checkPipelineResources(path.join(root, "src"), agents)
  assert.ok(problems.some(problem => problem.kind === "missing-companion" && problem.path === "plugins/pipeline-guard/index.ts"))
})

test("checkPipelineResources compares plugin directories byte-for-byte and reports extra files", () => {
  const root = workspace()
  const bundle = path.join(root, "export", "categories", "pipeline")
  fs.cpSync(path.join(root, "src"), bundle, { recursive: true })
  fs.writeFileSync(path.join(bundle, "plugins", "pipeline-guard", "index.ts"), "drifted\n")
  fs.rmSync(path.join(bundle, "plugins", "slide-tools", "index.ts"))
  write(path.join(bundle, "plugins", "pipeline-guard", "extra.ts"), "export default 1\n")

  const agents = findAgentFiles(root, "src").filter(agent => agent.category === "pipeline")
  const problems = checkPipelineResources(bundle, agents, { root: path.join(root, "src"), agents })
  assert.ok(problems.some(problem => problem.kind === "stale-companion" && problem.path === "plugins/pipeline-guard/index.ts"))
  assert.ok(problems.some(problem => problem.kind === "extra-companion" && problem.path === "plugins/pipeline-guard/extra.ts"))
  assert.ok(problems.some(problem => problem.kind === "missing-companion" && problem.path === "plugins/slide-tools/index.ts"))
})

test("organizeAgents leaves the pipeline to its category manifest", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-organize-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  write(path.join(root, "src", "agents", "pipeline-orchestrator.md"), agentFile({ read: "allow" }))
  write(path.join(root, ".agent-manager", "categories", "pipeline.json"), "{}\n")
  fs.mkdirSync(path.join(root, "export"), { recursive: true })
  const agents = findAgentFiles(root, "src")
  for (const current of agents) {
    current.category = "pipeline"
    current.targetPath = path.join(root, "export", "categories", "pipeline", "agents", current.filename)
  }
  const organized = organizeAgents(root, agents)
  assert.equal(organized.copied.length, 0)
  assert.match(organized.skipped[0], /manifest-backed/)
  assert.equal(fs.existsSync(path.join(root, "export", "categories", "pipeline", "agents", "pipeline-orchestrator.md")), false)
})

test("mergeOpenCodePluginsConfig emits deduped config-relative plugin directories", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-plugin-merge-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const opencodeRoot = path.join(root, "opencode")
  for (const name of ["pipeline-guard", "doc-tools"]) {
    write(path.join(opencodeRoot, "plugins", name, "index.ts"), "export default 1\n")
  }
  fs.writeFileSync(path.join(opencodeRoot, "opencode.json"), JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    timeout: 123,
    plugins: ["./plugins/pipeline-guard/index.ts", "third-party-plugin"]
  }, null, 2) + "\n")

  mergeOpenCodePluginsConfig(opencodeRoot, [
    "./plugins/pipeline-guard",
    "./plugins/doc-tools/index.ts",
    "./plugins/doc-tools",
    "./plugins/pipeline-guard" + ".js"
  ])
  const config = JSON.parse(fs.readFileSync(path.join(opencodeRoot, "opencode.json"), "utf8"))
  assert.deepEqual(config.plugins, ["./plugins/pipeline-guard", "third-party-plugin", "./plugins/doc-tools"])
  assert.equal(config.timeout, 123)
  assert.equal(Object.prototype.hasOwnProperty.call(config, "plugin"), false)
  for (const plugin of config.plugins) {
    assert.equal(/\.(?:ts|js|mjs)$/i.test(plugin), false, `${plugin} must be a directory path`)
  }
})
