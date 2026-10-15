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
  fs.mkdirSync(path.join(root, "general", "agents"), { recursive: true })
  return root
}

function agent(root: string, category: string, role: string, frontmatter: Record<string, unknown> = {}): string {
  const filePath = path.join(root, "general", "agents", `${category}-${role}.md`)
  saveAgentFile(filePath, { description: role, model: "old/model", ...frontmatter }, `Body for ${role}`)
  return filePath
}

test("defaults, role list, and profile persistence are available in workspace", () => {
  const root = workspace()
  assert.equal(loadPipelineProfiles(root).baseCategory, "hybrid-pipeline")
  assert.equal(PIPELINE_ROLES.length, 21)
  const config = structuredClone(DEFAULT_PIPELINE_PROFILES)
  config.profiles.custom = { description: "Custom", roles: { executor: { model: "test/model" } } }
  assert.equal(savePipelineProfiles(root, config), path.join(root, ".agent-manager", "pipeline-profiles.json"))
  assert.deepEqual(loadPipelineProfiles(root), config)
})

test("role extraction and profile model resolution use role, group, then all defaults", () => {
  assert.equal(extractPipelineRole("hybrid-pipeline-orchestrator.md"), "orchestrator")
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
  const orchestrator = agent(root, "hybrid-pipeline", "orchestrator", { variant: "old" })
  const planner = agent(root, "hybrid-pipeline", "planner")
  const executor = agent(root, "hybrid-pipeline", "executor", { variant: "old" })
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
  agent(root, "hybrid-pipeline", "orchestrator")
  agent(root, "hybrid-pipeline", "executor")
  const manager = path.join(root, ".agent-manager")
  fs.mkdirSync(manager, { recursive: true })
  fs.writeFileSync(path.join(manager, "companion-links.json"), JSON.stringify({
    version: 1,
    categories: { "hybrid-pipeline": { plugins: ["plugins/base.js"], commands: ["commands/base.md"], skills: ["skills/base"], tools: ["tools/base.ts"] } }
  }))
  const result = syncPipelineProfile(root, "go", "go")
  assert.equal(result.targetCategory, "go-pipeline")
  assert.equal(result.baseCategory, "hybrid-pipeline")
  assert.equal(result.profileName, "go")
  assert.equal(result.synced.length, 2)
  assert.ok(result.backupsPath)
  const target = parseAgentFile(path.join(root, "general", "agents", "go-pipeline-executor.md"), root)!
  assert.equal(target.model, "opencode-go/deepseek-v4.1-flash")
  assert.equal(target.body.trim(), "Body for executor")
  const links = JSON.parse(fs.readFileSync(path.join(manager, "companion-links.json"), "utf8"))
  assert.deepEqual(links.categories["go-pipeline"].plugins, ["plugins/base.js"])
  assert.deepEqual(links.categories["go-pipeline"].commands, ["commands/base.md"])
  assert.deepEqual(links.categories["go-pipeline"].skills, ["skills/base"])
  assert.deepEqual(links.categories["go-pipeline"].tools, ["tools/base.ts"])
})

test("sync inherits default companion links and persists them when no config exists", () => {
  const root = workspace()
  agent(root, "hybrid-pipeline", "orchestrator")
  const manager = path.join(root, ".agent-manager")
  assert.equal(fs.existsSync(path.join(manager, "companion-links.json")), false)

  syncPipelineProfile(root, "go", "go")

  const links = JSON.parse(fs.readFileSync(path.join(manager, "companion-links.json"), "utf8"))
  assert.deepEqual(links.categories["go-pipeline"], links.categories["hybrid-pipeline"])
  for (const group of ["plugins", "commands", "skills", "tools"]) {
    assert.deepEqual(links.categories["go-pipeline"][group], links.categories["hybrid-pipeline"][group])
  }
})

test("sync to base category applies in place without creating backups", () => {
  const root = workspace()
  const filePath = agent(root, "hybrid-pipeline", "orchestrator")
  agent(root, "hybrid-pipeline", "executor")
  const result = syncPipelineProfile(root, "hybrid", "hybrid-pipeline")
  assert.deepEqual(result.synced.sort(), [filePath, path.join(root, "general", "agents", "hybrid-pipeline-executor.md")].sort())
  assert.equal(result.backupsPath, null)
  assert.equal(parseAgentFile(filePath, root)!.model, "mistral/zai-glm-5-3")
})
