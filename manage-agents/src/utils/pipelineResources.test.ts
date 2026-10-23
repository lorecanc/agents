import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { checkPipelineResources, discoverCompanionResourcePaths, exportAgents, findAgentFiles } from "./agents.js"
import { checkPipelineBundles, refreshStampedPipelinesFromSource } from "./pipelineProfiles.js"

function write(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

function agentFile(permission: Record<string, string>) {
  const lines = Object.entries(permission).map(([key, value]) => `  ${key}: ${value}`)
  return `---\ndescription: test agent\nmode: subagent\nmodel: x/y\npermission:\n${lines.join("\n")}\n---\n\nBody.\n`
}

/** A workspace whose canonical pipeline uses a tool (`pipeline_env`) no agent permits yet. */
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
  write(path.join(root, "src", "plugins", "pipeline-guard.js"), `import { a } from "../tools/_pipeline_core.js"\nexport default a\n`)
  return root
}

const PIPELINE_PAYLOAD = [
  "plugins/pipeline-guard.js",
  "tools/_pipeline_core.js",
  "tools/_pipeline_env.js",
  "tools/_pipeline_run.js",
  "tools/_pipeline_services.js",
  "tools/_safeName.js",
  "tools/pipeline_env.ts",
  "tools/pipeline_state.ts",
  "tools/pipeline_verify.ts"
]

test("pipeline companions include every pipeline_*.ts tool and traced helpers, never tests", () => {
  const root = workspace()
  const agents = findAgentFiles(root, "src").filter(agent => agent.category === "pipeline")
  const found = discoverCompanionResourcePaths(path.join(root, "src"), ["pipeline"], undefined, agents)
  assert.deepEqual(found.filter(file => /^(?:tools|plugins)\//.test(file)), PIPELINE_PAYLOAD)
})

test("OpenCode export installs the guard plugin and all pipeline tools as siblings", () => {
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

test("stamped pipelines are refreshed with new tools and checked against the canonical copy", () => {
  const root = workspace()
  const stamped = path.join(root, "export", "categories", "go-pipeline")
  write(path.join(stamped, "agents", "go-pipeline-orchestrator.md"), agentFile({ pipeline_state: "allow" }))
  write(path.join(stamped, "tools", "pipeline_state.ts"), `stale\n`)
  write(path.join(root, "export", "categories", "kimi-pipeline", "tools", "pipeline_state.ts"), `orphan\n`)

  const before = checkPipelineBundles(root)
  const go = before.find(check => check.category === "go-pipeline")!
  assert.ok(go.problems.some(problem => problem.kind === "stale-companion" && problem.path === "tools/pipeline_state.ts"))
  assert.ok(go.problems.some(problem => problem.kind === "missing-companion" && problem.path === "tools/pipeline_env.ts"))
  assert.ok(go.problems.some(problem => problem.kind === "missing-companion" && problem.path === "plugins/pipeline-guard.js"))
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
