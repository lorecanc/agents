import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { checkPipelineResources, discoverCompanionResourcePaths, exportAgents, findAgentFiles, mergeOpenCodePluginsConfig, organizeAgents } from "./agents.js"
import { checkPipelineBundles, refreshStampedPipelinesFromSource } from "./pipelineProfiles.js"
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
  write(path.join(root, "src", "agents", "pipeline-executor.md"), agentFile({ pipeline_verify: "allow" }))
  write(path.join(root, "src", "tools", "pipeline_state.ts"), `import { a } from "./_pipeline_core.js"\nexport default a\n`)
  write(path.join(root, "src", "tools", "pipeline_verify.ts"), `import { b } from "./_pipeline_run.js"\nexport default b\n`)
  write(path.join(root, "src", "tools", "pipeline_env.ts"), `import { c } from "./_pipeline_env.js"\nexport default c\n`)
  write(path.join(root, "src", "tools", "_pipeline_core.js"), `export const a = 1\n`)
  write(path.join(root, "src", "tools", "_pipeline_run.js"), `import { a } from "./_pipeline_core.js"\nimport { safe } from "./_safeName.js"\nexport const b = a + safe\n`)
  write(path.join(root, "src", "tools", "_pipeline_env.js"), `import { a } from "./_pipeline_services.js"\nexport const c = a\n`)
  write(path.join(root, "src", "tools", "_pipeline_services.js"), `export const a = 2\n`)
  write(path.join(root, "src", "tools", "_safeName.js"), `export const safe = 3\n`)
  write(path.join(root, "src", "tools", "_pipeline_core.test.mjs"), `// test\n`)
  write(path.join(root, "src", "tools", "_pipeline_testutil.mjs"), `// util\n`)
  write(path.join(root, "src", "tools", "doc_view.ts"), `export default 1\n`)
  write(path.join(root, "src", "plugins", "pipeline-guard", "index.ts"), `import { a } from "../../tools/_pipeline_core.js"\nexport default a\n`)
  write(path.join(root, "src", "plugins", "pipeline-tools", "index.ts"), `import { c } from "../../tools/pipeline_env.js"\nexport default c\n`)
  write(path.join(root, "src", "plugins", "doc-tools", "index.ts"), `export default 1\n`)
  write(path.join(root, "src", "plugins", "slide-tools", "index.ts"), `export default 1\n`)
  return root
}

const PIPELINE_PAYLOAD = [
  "plugins/doc-tools/index.ts",
  "plugins/pipeline-guard/index.ts",
  "plugins/pipeline-tools/index.ts",
  "plugins/slide-tools/index.ts",
  "tools/_pipeline_core.js",
  "tools/_pipeline_env.js",
  "tools/_pipeline_run.js",
  "tools/_pipeline_services.js",
  "tools/_safeName.js",
  "tools/pipeline_env.ts",
  "tools/pipeline_state.ts",
  "tools/pipeline_verify.ts"
]

test("pipeline companions include V2 plugin directory files, tools and traced helpers, never tests", () => {
  const root = workspace()
  const agents = findAgentFiles(root, "src").filter(agent => agent.category === "pipeline")
  const found = discoverCompanionResourcePaths(path.join(root, "src"), ["pipeline"], undefined, agents)
  assert.deepEqual(found.filter(file => /^(?:tools|plugins)\//.test(file)), PIPELINE_PAYLOAD)
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
  write(path.join(root, "src", "agents", "pipeline-ops.md"), agentFile({ pipeline_smoke: "allow", pipeline_serve: "deny" }))
  fs.rmSync(path.join(root, "src", "tools", "_pipeline_services.js"))
  const agents = findAgentFiles(root, "src").filter(agent => agent.category === "pipeline")
  const problems = checkPipelineResources(path.join(root, "src"), agents)
  assert.deepEqual(problems.map(problem => `${problem.kind} ${problem.path}`).sort(), [
    "missing-dependency tools/_pipeline_services.js",
    "missing-tool tools/pipeline_smoke.ts"
  ])
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
  const stamped = path.join(root, "export", "categories", "go-pipeline")
  fs.cpSync(path.join(root, "src"), stamped, { recursive: true })
  fs.writeFileSync(path.join(stamped, "plugins", "pipeline-guard", "index.ts"), "drifted\n")
  fs.rmSync(path.join(stamped, "plugins", "slide-tools", "index.ts"))
  write(path.join(stamped, "plugins", "pipeline-guard", "extra.ts"), "export default 1\n")

  const agents = findAgentFiles(root, "src").filter(agent => agent.category === "pipeline")
  const problems = checkPipelineResources(stamped, agents, { root: path.join(root, "src"), agents })
  assert.ok(problems.some(problem => problem.kind === "stale-companion" && problem.path === "plugins/pipeline-guard/index.ts"))
  assert.ok(problems.some(problem => problem.kind === "extra-companion" && problem.path === "plugins/pipeline-guard/extra.ts"))
  assert.ok(problems.some(problem => problem.kind === "missing-companion" && problem.path === "plugins/slide-tools/index.ts"))
})

test("stamped pipelines are refreshed with new plugin directories and checked against the canonical copy", () => {
  const root = workspace()
  const stamped = path.join(root, "export", "categories", "go-pipeline")
  write(path.join(stamped, "agents", "go-pipeline-orchestrator.md"), agentFile({ pipeline_state: "allow" }))
  write(path.join(stamped, "tools", "pipeline_state.ts"), `stale\n`)
  write(path.join(root, "export", "categories", "kimi-pipeline", "tools", "pipeline_state.ts"), `orphan\n`)

  const before = checkPipelineBundles(root)
  const go = before.find(check => check.category === "go-pipeline")!
  assert.ok(go.problems.some(problem => problem.kind === "stale-companion" && problem.path === "tools/pipeline_state.ts"))
  assert.ok(go.problems.some(problem => problem.kind === "missing-companion" && problem.path === "tools/pipeline_env.ts"))
  assert.ok(go.problems.some(problem => problem.kind === "missing-companion" && problem.path === "plugins/pipeline-guard/index.ts"))
  assert.deepEqual(before.find(check => check.category === "kimi-pipeline"), { category: "kimi-pipeline", resourceRoot: path.join(root, "export", "categories", "kimi-pipeline"), orphan: true, problems: [] })
  assert.deepEqual(before.find(check => check.category === "pipeline")?.problems, [])

  refreshStampedPipelinesFromSource(root, "go-pipeline")
  const after = checkPipelineBundles(root, ["go-pipeline"])
  assert.equal(after.length, 1)
  assert.deepEqual(after[0].problems, [])
  for (const file of PIPELINE_PAYLOAD) assert.ok(fs.existsSync(path.join(stamped, ...file.split("/"))), file)
  assert.equal(fs.existsSync(path.join(stamped, "tools", "_pipeline_testutil.mjs")), false)
  assert.equal(fs.existsSync(path.join(stamped, "tools", "_pipeline_core.test.mjs")), false)
})

test("organizeAgents skips canonical pipeline and checkPipelineBundles flags orphan export/categories/pipeline", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-organize-orphan-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  write(path.join(root, "src", "agents", "pipeline-orchestrator.md"), agentFile({ read: "allow" }))
  fs.mkdirSync(path.join(root, "export"), { recursive: true })
  const agents = findAgentFiles(root, "src")
  for (const current of agents) {
    current.category = "pipeline"
    current.targetPath = path.join(root, "export", "categories", "pipeline", "agents", current.filename)
  }
  const organized = organizeAgents(root, agents)
  const orphan = path.join(root, "export", "categories", "pipeline")
  const createdCanonicalPipelineCopy = fs.existsSync(path.join(orphan, "agents", "pipeline-orchestrator.md"))
  write(path.join(orphan, "agents", "pipeline-orchestrator.md"), agentFile({ read: "allow" }))

  const checks = checkPipelineBundles(root)
  const orphanReported = checks.some(check =>
    path.resolve(check.resourceRoot) === path.resolve(orphan) && check.problems.length > 0
  )
  assert.deepEqual({
    copied: organized.copied.length,
    createdCanonicalPipelineCopy,
    orphanReported
  }, { copied: 0, createdCanonicalPipelineCopy: false, orphanReported: true })
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
