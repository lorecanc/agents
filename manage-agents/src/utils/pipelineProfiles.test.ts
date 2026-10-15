import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { parseAgentFile, saveAgentFile } from "./agents.js"
import {
  applyPipelineProfile,
  DEFAULT_PIPELINE_PROFILES,
  extractPipelineRole,
  loadPipelineProfiles,
  PIPELINE_ROLES,
  resolveProfileRoleSpec,
  savePipelineProfiles,
  syncPipelineProfile
} from "./pipelineProfiles.js"

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-profiles-"))
  fs.mkdirSync(path.join(root, "src", "agents"), { recursive: true })
  fs.mkdirSync(path.join(root, "export"), { recursive: true })
  return root
}

function agent(root: string, category: string, role: string, frontmatter: Record<string, unknown> = {}): string {
  const filePath = path.join(root, "src", "agents", `${category}-${role}.md`)
  saveAgentFile(filePath, { description: role, model: "old/model", ...frontmatter }, `Body for ${role}`)
  return filePath
}

test("defaults, role list, and profile persistence are available in workspace", () => {
  const root = workspace()
  assert.equal(loadPipelineProfiles(root).baseCategory, "pipeline")
  assert.equal(PIPELINE_ROLES.length, 21)
  const config = structuredClone(DEFAULT_PIPELINE_PROFILES)
  config.profiles.custom = { description: "Custom", roles: { executor: { model: "test/model" } } }
  assert.equal(savePipelineProfiles(root, config), path.join(root, ".agent-manager", "pipeline-profiles.json"))
  assert.deepEqual(loadPipelineProfiles(root), config)
})

test("role extraction and profile model resolution use role, group, then all defaults", () => {
  assert.equal(extractPipelineRole("pipeline-orchestrator.md"), "orchestrator")
  assert.equal(extractPipelineRole("nested/go-pipeline-fast_lane.md", "go-pipeline"), "fast_lane")
  assert.equal(extractPipelineRole("other-orchestrator.md"), null)
  const profile = {
    description: "test",
    roles: { executor: { model: "role/model" } },
    defaults: { execution: { model: "group/model" }, all: { model: "all/model" } }
  }
  assert.deepEqual(resolveProfileRoleSpec(profile, "executor"), { model: "role/model" })
  assert.deepEqual(resolveProfileRoleSpec(profile, "tester"), { model: "group/model" })
  assert.deepEqual(resolveProfileRoleSpec(profile, "unknown"), { model: "all/model" })
  assert.equal(resolveProfileRoleSpec({ description: "empty" }, "unknown"), null)
})

test("apply updates matching base pipeline agents and synchronizes model variants", () => {
  const root = workspace()
  const orchestrator = agent(root, "pipeline", "orchestrator", { variant: "old" })
  const planner = agent(root, "pipeline", "planner")
  const executor = agent(root, "pipeline", "executor", { variant: "old" })
  agent(root, "other-pipeline", "executor")
  const result = applyPipelineProfile(root, "cp_nightly")
  assert.equal(result.updated.length, 3)
  assert.equal(parseAgentFile(orchestrator, root)!.frontmatter.variant, "high")
  assert.equal(parseAgentFile(planner, root)!.frontmatter.model, "github-copilot/gemini-4-argon")
  assert.equal(parseAgentFile(executor, root)!.frontmatter.variant, "medium")
  assert.throws(() => applyPipelineProfile(root, "missing"), /Unknown pipeline profile/)
})

test("sync forks base agents, applies selected profile, and copies companion links", () => {
  const root = workspace()
  agent(root, "pipeline", "orchestrator")
  agent(root, "pipeline", "executor")
  const sourceFiles: Record<string, string> = {
    "plugins/pipeline-guard.js": "pipeline plugin\n",
    "commands/pipeline-bug.md": "Pipeline: use @pipeline-orchestrator\n",
    "skills/code-review-antipatterns/SKILL.md": "review skill\n",
    "tools/pipeline_commit.ts": "commit tool\n",
    "tools/pipeline_serve.ts": "serve tool\n",
    "tools/pipeline_smoke.ts": "smoke tool\n",
    "tools/pipeline_state.ts": "state tool\n",
    "tools/pipeline_verify.ts": "verify tool\n"
  }
  for (const [relative, content] of Object.entries(sourceFiles)) {
    const filePath = path.join(root, "src", relative)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, content)
  }
  const manager = path.join(root, ".agent-manager")
  fs.mkdirSync(manager, { recursive: true })
  fs.writeFileSync(path.join(manager, "companion-links.json"), JSON.stringify({
    version: 1,
    categories: {
      pipeline: { plugins: ["plugins/pipeline-guard.js"], commands: ["commands/pipeline-bug.md"], skills: ["skills/code-review-antipatterns"], tools: ["tools/pipeline_commit.ts", "tools/pipeline_serve.ts", "tools/pipeline_smoke.ts", "tools/pipeline_state.ts", "tools/pipeline_verify.ts"] },
      "go-pipeline": { plugins: [], commands: [], skills: [], tools: [] }
    }
  }))
  const result = syncPipelineProfile(root, "go", "go")
  assert.equal(result.targetCategory, "go-pipeline")
  assert.equal(result.baseCategory, "pipeline")
  assert.equal(result.profileName, "go")
  assert.equal(result.synced.length, 2)
  const target = parseAgentFile(path.join(root, "export", "categories", "go-pipeline", "agents", "go-pipeline-executor.md"), root)!
  assert.equal(target.model, "opencode-go/deepseek-v4.1-flash")
  assert.equal(target.body.trim(), "Body for executor")
  const links = JSON.parse(fs.readFileSync(path.join(manager, "companion-links.json"), "utf8"))
  assert.deepEqual(links.categories["go-pipeline"].plugins, ["plugins/pipeline-guard.js"])
  assert.deepEqual(links.categories["go-pipeline"].commands, ["commands/pipeline-bug.md"])
  assert.deepEqual(links.categories["go-pipeline"].skills, ["skills/code-review-antipatterns"])
  assert.deepEqual(links.categories["go-pipeline"].tools, ["tools/pipeline_commit.ts", "tools/pipeline_serve.ts", "tools/pipeline_smoke.ts", "tools/pipeline_state.ts", "tools/pipeline_verify.ts"])
  for (const relative of [
    "agents/go-pipeline-orchestrator.md", "agents/go-pipeline-executor.md", "commands/go-bug.md",
    "plugins/pipeline-guard.js", "skills/code-review-antipatterns/SKILL.md", ...Object.keys(sourceFiles).filter(file => file.startsWith("tools/"))
  ]) assert.equal(fs.readFileSync(path.join(result.outputDir, relative), "utf8").length > 0, true, `${relative} should be stamped`)
  assert.match(fs.readFileSync(path.join(result.outputDir, "commands/go-bug.md"), "utf8"), /go-pipeline-orchestrator/)
})

test("sync inherits default companion links and persists them when no config exists", () => {
  const root = workspace()
  agent(root, "pipeline", "orchestrator")
  const manager = path.join(root, ".agent-manager")
  assert.equal(fs.existsSync(path.join(manager, "companion-links.json")), false)

  for (const relative of [
    "plugins/pipeline-guard.js", "commands/pipeline-bug.md", "commands/pipeline-feature.md", "commands/pipeline-ops.md",
    "commands/pipeline-refactor.md", "commands/pipeline-research.md", "skills/code-review-antipatterns/SKILL.md",
    "tools/pipeline_commit.ts", "tools/pipeline_serve.ts", "tools/pipeline_smoke.ts", "tools/pipeline_state.ts", "tools/pipeline_verify.ts"
  ]) {
    const filePath = path.join(root, "src", relative)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, `${relative}\n`)
  }

  const result = syncPipelineProfile(root, "go", "go")

  const links = JSON.parse(fs.readFileSync(path.join(manager, "companion-links.json"), "utf8"))
  assert.deepEqual(links.categories.pipeline, {
    plugins: ["plugins/pipeline-guard.js"],
    commands: ["commands/pipeline-bug.md", "commands/pipeline-feature.md", "commands/pipeline-ops.md", "commands/pipeline-refactor.md", "commands/pipeline-research.md"],
    skills: ["skills/code-review-antipatterns"],
    tools: ["tools/pipeline_commit.ts", "tools/pipeline_serve.ts", "tools/pipeline_smoke.ts", "tools/pipeline_state.ts", "tools/pipeline_verify.ts"]
  })
  assert.equal(fs.readFileSync(path.join(result.outputDir, "plugins/pipeline-guard.js"), "utf8"), "plugins/pipeline-guard.js\n")
  assert.equal(fs.readFileSync(path.join(result.outputDir, "commands/go-bug.md"), "utf8").includes("commands/pipeline-bug.md"), false)
  assert.equal(fs.readFileSync(path.join(result.outputDir, "skills/code-review-antipatterns/SKILL.md"), "utf8"), "skills/code-review-antipatterns/SKILL.md\n")
  for (const tool of ["pipeline_commit.ts", "pipeline_serve.ts", "pipeline_smoke.ts", "pipeline_state.ts", "pipeline_verify.ts"]) {
    assert.equal(fs.readFileSync(path.join(result.outputDir, "tools", tool), "utf8"), `tools/${tool}\n`)
  }
})

test("sync to base category applies in place without creating backups", () => {
  const root = workspace()
  const filePath = agent(root, "pipeline", "orchestrator")
  agent(root, "pipeline", "executor")
  const result = syncPipelineProfile(root, "hybrid", "pipeline")
  assert.deepEqual(result.synced.sort(), [filePath, path.join(root, "src", "agents", "pipeline-executor.md")].sort())
  assert.equal(result.backupsPath, null)
  assert.equal(parseAgentFile(filePath, root)!.model, "mistral/zai-glm-5-3")
})
