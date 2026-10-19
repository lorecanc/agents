import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { parseAgentFile, saveAgentFile } from "./agents.js"
import * as profilesMod from "./pipelineProfiles.js"
import {
  applyPipelineProfile,
  deleteStampedPipeline,
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

test("sync stamps command orchestrator references with exactly one profile prefix", () => {
  for (const family of ["copilot", "cp_nightly"]) {
    const root = workspace()
    agent(root, "pipeline", "orchestrator")
    const commandPath = path.join(root, "src", "commands", "pipeline-bug.md")
    fs.mkdirSync(path.dirname(commandPath), { recursive: true })
    fs.writeFileSync(commandPath, "---\nagent: pipeline-orchestrator\n---\n\nUse @pipeline-orchestrator.\n")

    const result = syncPipelineProfile(root, family)
    const command = fs.readFileSync(path.join(result.outputDir, "commands", `${family}-bug.md`), "utf8")

    assert.match(command, new RegExp(`agent: ${family}-pipeline-orchestrator`))
    assert.match(command, new RegExp(`@${family}-pipeline-orchestrator`))
    assert.doesNotMatch(command, new RegExp(`${family}-${family}-pipeline-orchestrator`))
  }
})

test("sync rejects path-traversal pipeline categories before creating output", () => {
  const root = workspace()
  agent(root, "pipeline", "orchestrator")
  const outside = path.join(root, "outside-pipeline")

  assert.throws(() => syncPipelineProfile(root, "copilot", "../../outside"), /Invalid pipeline category/)
  assert.equal(fs.existsSync(outside), false)
  assert.equal(fs.existsSync(path.join(root, "export", "categories", "outside-pipeline")), false)
})

test("sync rejects a symlinked pipeline category target before writing", () => {
  const root = workspace()
  agent(root, "pipeline", "orchestrator")
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-sync-outside-"))
  fs.writeFileSync(path.join(outside, "keep.txt"), "keep\n")
  const target = path.join(root, "export", "categories", "linked-pipeline")
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.symlinkSync(outside, target)

  assert.throws(() => syncPipelineProfile(root, "copilot", "linked"), /Invalid fork destination/)
  assert.equal(fs.readFileSync(path.join(outside, "keep.txt"), "utf8"), "keep\n")
  assert.deepEqual(fs.readdirSync(outside), ["keep.txt"])
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

test("delete refuses canonical base pipelines and categories present in source agents", () => {
  const root = workspace()
  const customConfig = structuredClone(DEFAULT_PIPELINE_PROFILES)
  customConfig.baseCategory = "custom-pipeline"
  savePipelineProfiles(root, customConfig)
  agent(root, "source-pipeline", "executor")
  agent(root, "source-pipeline", "planner")
  fs.mkdirSync(path.join(root, "export", "categories"), { recursive: true })

  assert.throws(() => deleteStampedPipeline(root, "pipeline"), /Refusing to delete canonical base pipeline 'pipeline'/)
  assert.throws(() => deleteStampedPipeline(root, "custom"), /Refusing to delete canonical base pipeline 'custom-pipeline'/)
  assert.throws(() => deleteStampedPipeline(root, "source"), /Refusing to delete source category 'source-pipeline'/)
})

test("delete reports a missing stamped pipeline", () => {
  const root = workspace()
  fs.mkdirSync(path.join(root, "export", "categories"), { recursive: true })
  const outputDir = path.join(root, "export", "categories", "missing-pipeline")
  assert.throws(() => deleteStampedPipeline(root, "missing"), (error: unknown) => error instanceof Error && error.message === `Stamped pipeline 'missing-pipeline' does not exist at ${outputDir}.`)
})

test("delete removes stamped pipeline resources and its companion links", () => {
  const root = workspace()
  const outputDir = path.join(root, "export", "categories", "custom-pipeline")
  fs.mkdirSync(path.join(outputDir, "agents"), { recursive: true })
  fs.writeFileSync(path.join(outputDir, "agents", "custom-pipeline-executor.md"), "agent\n")
  fs.writeFileSync(path.join(outputDir, "agents", "notes.txt"), "note\n")
  fs.mkdirSync(path.join(outputDir, "skills", "skill"), { recursive: true })
  fs.writeFileSync(path.join(outputDir, "skills", "skill", "SKILL.md"), "skill\n")
  const manager = path.join(root, ".agent-manager")
  fs.mkdirSync(manager, { recursive: true })
  fs.writeFileSync(path.join(manager, "companion-links.json"), JSON.stringify({
    version: 1,
    categories: {
      "custom-pipeline": { plugins: [], commands: [], skills: [], tools: [] },
      other: { plugins: [], commands: [], skills: [], tools: [] }
    }
  }))

  const result = deleteStampedPipeline(root, "custom-pipeline")

  assert.deepEqual(result, {
    deletedCategory: "custom-pipeline",
    outputDir,
    removedAgentsCount: 1,
    removedInstalledAgents: [],
    removedInstalledCommands: []
  })
  assert.equal(fs.existsSync(outputDir), false)
  const links = JSON.parse(fs.readFileSync(path.join(manager, "companion-links.json"), "utf8"))
  assert.equal(Object.hasOwn(links.categories, "custom-pipeline"), false)
  assert.equal(Object.hasOwn(links.categories, "other"), true)
})

test("delete leaves the stamped pipeline intact when companion links are malformed", () => {
  const root = workspace()
  const outputDir = path.join(root, "export", "categories", "custom-pipeline")
  fs.mkdirSync(outputDir, { recursive: true })
  const manager = path.join(root, ".agent-manager")
  fs.mkdirSync(manager, { recursive: true })
  fs.writeFileSync(path.join(manager, "companion-links.json"), "{")

  assert.throws(() => deleteStampedPipeline(root, "custom"))
  assert.equal(fs.existsSync(outputDir), true)
})

test("delete rejects symlinked stamped pipeline ancestors without changing targets", () => {
  const root = workspace()
  const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-delete-target-"))
  const targetCategories = path.join(targetRoot, "categories")
  const outputDir = path.join(targetCategories, "custom-pipeline")
  fs.mkdirSync(outputDir, { recursive: true })
  fs.writeFileSync(path.join(outputDir, "keep.txt"), "keep\n")
  fs.rmSync(path.join(root, "export"), { recursive: true })
  fs.symlinkSync(targetRoot, path.join(root, "export"))

  assert.throws(() => deleteStampedPipeline(root, "custom"), /Invalid directory path/)
  assert.equal(fs.readFileSync(path.join(outputDir, "keep.txt"), "utf8"), "keep\n")
})

test("delete can also remove matching installed agents and commands", () => {
  const root = workspace()
  const outputDir = path.join(root, "export", "categories", "test-pipeline")
  fs.mkdirSync(path.join(outputDir, "commands"), { recursive: true })
  fs.writeFileSync(path.join(outputDir, "commands", "test-bug.md"), "command\n")
  const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-delete-config-"))
  const opencodeRoot = path.join(configHome, "opencode")
  const exportAgentsDir = path.join(opencodeRoot, "agents")
  const exportCommandsDir = path.join(opencodeRoot, "commands")
  fs.mkdirSync(exportAgentsDir, { recursive: true })
  fs.mkdirSync(exportCommandsDir, { recursive: true })
  for (const filename of ["test-pipeline-executor.md", "test-pipeline-planner.md", "other-agent.md"]) {
    fs.writeFileSync(path.join(exportAgentsDir, filename), "agent\n")
  }
  for (const filename of ["test-bug.md", "test-feature.md", "test-unrelated-custom.md", "pipeline-ops.md", "other-command.md"]) {
    fs.writeFileSync(path.join(exportCommandsDir, filename), "command\n")
  }
  const manager = path.join(root, ".agent-manager")
  fs.mkdirSync(manager, { recursive: true })
  fs.writeFileSync(path.join(manager, "companion-links.json"), JSON.stringify({
    version: 1,
    categories: { "test-pipeline": { plugins: [], commands: ["commands/pipeline-feature.md"], skills: [], tools: [] } }
  }))

  const result = deleteStampedPipeline(root, "test", { alsoInstalled: true, env: { XDG_CONFIG_HOME: configHome } })

  assert.deepEqual(result.removedInstalledAgents, [
    path.join(exportAgentsDir, "test-pipeline-executor.md"),
    path.join(exportAgentsDir, "test-pipeline-planner.md")
  ].sort())
  assert.deepEqual(result.removedInstalledCommands, [
    path.join(exportCommandsDir, "test-bug.md"),
    path.join(exportCommandsDir, "test-feature.md")
  ].sort())
  assert.equal(fs.existsSync(path.join(exportAgentsDir, "other-agent.md")), true)
  assert.equal(fs.existsSync(path.join(exportCommandsDir, "test-unrelated-custom.md")), true)
  assert.equal(fs.existsSync(path.join(exportCommandsDir, "pipeline-ops.md")), true)
  assert.equal(fs.existsSync(path.join(exportCommandsDir, "other-command.md")), true)
})

test("delete refuses installed destinations with symlinked ancestors before deleting the pipeline", () => {
  const root = workspace()
  const outputDir = path.join(root, "export", "categories", "test-pipeline")
  fs.mkdirSync(outputDir, { recursive: true })
  const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-delete-config-"))
  const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-delete-opencode-target-"))
  fs.mkdirSync(path.join(targetRoot, "agents"), { recursive: true })
  fs.mkdirSync(path.join(targetRoot, "commands"), { recursive: true })
  fs.writeFileSync(path.join(targetRoot, "agents", "test-pipeline-executor.md"), "keep\n")
  fs.symlinkSync(targetRoot, path.join(configHome, "opencode"))

  assert.throws(() => deleteStampedPipeline(root, "test", { alsoInstalled: true, env: { XDG_CONFIG_HOME: configHome } }), /Invalid directory path/)
  assert.equal(fs.existsSync(outputDir), true)
  assert.equal(fs.readFileSync(path.join(targetRoot, "agents", "test-pipeline-executor.md"), "utf8"), "keep\n")
})

test("refreshStampedPipelinesFromSource updates body, permissions, and companions idempotently while preserving custom frontmatter", () => {
  const root = workspace()
  const orchestratorPath = agent(root, "pipeline", "orchestrator", {
    permission: { task: { "pipeline-executor": "allow" } }
  })
  agent(root, "pipeline", "executor")

  for (const [relative, contents] of [
    ["commands/pipeline-bug.md", "Use @pipeline-orchestrator to fix bugs.\n"],
    ["plugins/pipeline-guard.js", "original pipeline guard\n"],
    ["tools/pipeline_state.ts", "export const state = 'original'\n"]
  ]) {
    const filePath = path.join(root, "src", relative)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, contents)
  }

  const stamped = syncPipelineProfile(root, "go", "go")
  const stampedOrchestratorPath = path.join(stamped.outputDir, "agents", "go-pipeline-orchestrator.md")
  const stampedOrchestrator = parseAgentFile(stampedOrchestratorPath, root)!
  stampedOrchestrator.frontmatter = {
    ...stampedOrchestrator.frontmatter,
    model: "custom/model-x",
    variant: "high",
    steps: 150,
    temperature: 0.7,
    custom_target_note: "keep this value",
    permission: {
      ...(stampedOrchestrator.frontmatter.permission as Record<string, unknown>),
      "custom_mcp_*": "allow"
    }
  }
  saveAgentFile(stampedOrchestratorPath, stampedOrchestrator.frontmatter, stampedOrchestrator.body)

  const sourceOrchestrator = parseAgentFile(orchestratorPath, root)!
  sourceOrchestrator.frontmatter = {
    ...sourceOrchestrator.frontmatter,
    permission: {
      ...(sourceOrchestrator.frontmatter.permission as Record<string, unknown>),
      pipeline_verify: "allow"
    }
  }
  saveAgentFile(orchestratorPath, sourceOrchestrator.frontmatter, `${sourceOrchestrator.body}\nNew verification prompt for @pipeline-executor.\n`)
  fs.writeFileSync(path.join(root, "src", "plugins", "pipeline-guard.js"), "updated pipeline guard\n")

  const res1 = (profilesMod as any).refreshStampedPipelinesFromSource(root)

  assert.ok(res1.refreshedCategories.includes("go-pipeline"))
  assert.ok(res1.updatedAgents.length >= 1)
  assert.ok(res1.updatedCompanions.length >= 1)
  const refreshed = parseAgentFile(stampedOrchestratorPath, root)!
  assert.match(refreshed.body, /New verification prompt for @go-pipeline-executor/)
  assert.equal((refreshed.frontmatter.permission as Record<string, unknown>).pipeline_verify, "allow")
  assert.equal(refreshed.frontmatter.model, "custom/model-x")
  assert.equal(refreshed.frontmatter.variant, "high")
  assert.equal(refreshed.frontmatter.steps, 150)
  assert.equal(refreshed.frontmatter.temperature, 0.7)
  assert.equal(refreshed.frontmatter.custom_target_note, "keep this value")
  assert.equal((refreshed.frontmatter.permission as Record<string, unknown>)["custom_mcp_*"], "allow")
  assert.equal(fs.readFileSync(path.join(stamped.outputDir, "plugins", "pipeline-guard.js"), "utf8"), "updated pipeline guard\n")

  const res2 = (profilesMod as any).refreshStampedPipelinesFromSource(root)
  assert.equal(res2.updatedAgents.length, 0)
  assert.equal(res2.updatedCompanions.length, 0)
  assert.equal(parseAgentFile(stampedOrchestratorPath, root)!.frontmatter.custom_target_note, "keep this value")
})

test("refreshStampedPipelinesFromSource places wildcard permission keys first recursively", () => {
  const root = workspace()
  const sourcePath = agent(root, "pipeline", "executor", {
    permission: {
      access: {
        nested: { "source-rule": "allow", "*": "ask" },
        "*": "allow"
      },
      sourceMap: { nested: { "source-only": "allow", "*": "ask" } },
      "*": "ask"
    }
  })
  agent(root, "pipeline", "orchestrator")
  syncPipelineProfile(root, "go", "go")
  const stampedPath = path.join(root, "export", "categories", "go-pipeline", "agents", "go-pipeline-executor.md")
  const target = parseAgentFile(stampedPath, root)!
  target.frontmatter.permission = {
    access: {
      nested: { "target-rule": "deny", "*": "deny" },
      "*": "deny"
    },
    customMap: { nested: { "custom-rule": "allow", "*": "ask" } },
    "*": "deny"
  }
  saveAgentFile(stampedPath, target.frontmatter, target.body)

  const source = parseAgentFile(sourcePath, root)!
  source.frontmatter.permission = {
    access: {
      nested: { "source-rule": "allow", "*": "ask" },
      "*": "allow"
    },
    sourceMap: { nested: { "source-only": "allow", "*": "ask" } },
    "*": "ask"
  }
  saveAgentFile(sourcePath, source.frontmatter, source.body)

  profilesMod.refreshStampedPipelinesFromSource(root, "go")

  const permission = parseAgentFile(stampedPath, root)!.frontmatter.permission
  assert.deepEqual(Object.keys(permission), ["*", "access", "sourceMap", "customMap"], JSON.stringify(permission))
  assert.deepEqual(Object.keys(permission.access), ["*", "nested"])
  assert.deepEqual(Object.keys(permission.access.nested), ["*", "source-rule"])
  assert.deepEqual(Object.keys(permission.sourceMap), ["nested"])
  assert.deepEqual(Object.keys(permission.sourceMap.nested), ["*", "source-only"])
  assert.deepEqual(Object.keys(permission.customMap.nested), ["*", "custom-rule"])
  assert.equal(permission.access.nested["source-rule"], "allow")
  assert.equal(permission.customMap.nested["custom-rule"], "allow")
})

test("forkStampedPipeline forks from base pipeline or stamped pipeline into export/categories without writing to src/agents", () => {
  const root = workspace()
  agent(root, "pipeline", "orchestrator", {
    temperature: 0.2,
    steps: 10,
    permission: { pipeline_state: "allow", task: { "pipeline-executor": "allow", "pipeline-planner": "allow" } }
  })
  agent(root, "pipeline", "executor")
  const pipelineConfig = path.join(root, "src", ".opencode", "pipeline.json")
  fs.mkdirSync(path.dirname(pipelineConfig), { recursive: true })
  fs.writeFileSync(pipelineConfig, '{"name":"pipeline"}\n')
  const pluginPath = path.join(root, "src", "plugins", "pipeline-guard.js")
  fs.mkdirSync(path.dirname(pluginPath), { recursive: true })
  fs.writeFileSync(pluginPath, "pipeline guard\n")
  const toolPath = path.join(root, "src", "tools", "pipeline_state.ts")
  fs.mkdirSync(path.dirname(toolPath), { recursive: true })
  fs.writeFileSync(toolPath, "pipeline state tool\n")
  const manager = path.join(root, ".agent-manager")
  fs.mkdirSync(manager, { recursive: true })
  fs.writeFileSync(path.join(manager, "companion-links.json"), JSON.stringify({
    version: 1,
    categories: { pipeline: { plugins: ["plugins/pipeline-guard.js"], commands: [], skills: [], tools: ["tools/pipeline_state.ts"] } }
  }))

  ;(profilesMod as any).forkStampedPipeline(root, "pipeline", ["deepseek", "qwen-pipeline"])

  for (const category of ["deepseek-pipeline", "qwen-pipeline"]) {
    const outputDir = path.join(root, "export", "categories", category)
    const forkedAgent = parseAgentFile(path.join(outputDir, "agents", `${category}-orchestrator.md`), root)!
    assert.match(forkedAgent.body, new RegExp(`@${category}-executor`))
    assert.equal((forkedAgent.frontmatter.permission as Record<string, unknown>).pipeline_state, "allow")
    assert.equal(fs.readFileSync(path.join(outputDir, ".opencode", "pipeline.json"), "utf8"), '{"name":"pipeline"}\n')
    assert.equal(fs.readFileSync(path.join(outputDir, "tools", "pipeline_state.ts"), "utf8"), "pipeline state tool\n")
  }
  assert.equal(fs.readdirSync(path.join(root, "src", "agents")).some(name => /^(deepseek|qwen-pipeline)-pipeline-/.test(name)), false)

  const deepseekPath = path.join(root, "export", "categories", "deepseek-pipeline", "agents", "deepseek-pipeline-orchestrator.md")
  const deepseekAgent = parseAgentFile(deepseekPath, root)!
  deepseekAgent.frontmatter = { ...deepseekAgent.frontmatter, model: "deepseek/r1", variant: "max" }
  saveAgentFile(deepseekPath, deepseekAgent.frontmatter, deepseekAgent.body)

  ;(profilesMod as any).forkStampedPipeline(root, "deepseek-pipeline", "deepseek2")

  const deepseek2 = parseAgentFile(path.join(root, "export", "categories", "deepseek2-pipeline", "agents", "deepseek2-pipeline-orchestrator.md"), root)!
  assert.equal(deepseek2.frontmatter.model, "deepseek/r1")
  assert.equal(deepseek2.frontmatter.variant, "max")
  assert.match(deepseek2.body, /@deepseek2-pipeline-executor/)

  const qwenPath = path.join(root, "export", "categories", "qwen-pipeline", "agents", "qwen-pipeline-orchestrator.md")
  const qwen = parseAgentFile(qwenPath, root)!
  qwen.frontmatter = {
    ...qwen.frontmatter,
    model: "custom/qwen",
    variant: "high",
      temperature: 0.9,
      steps: 42,
      custom_target_note: "keep qwen",
      permission: {
        ...(qwen.frontmatter.permission as Record<string, unknown>),
        task: { "qwen-pipeline-planner": "allow", "qwen-pipeline-executor": "deny", "*": "ask" }
      }
  }
  saveAgentFile(qwenPath, qwen.frontmatter, qwen.body)

  const sourceOrchestratorPath = path.join(root, "src", "agents", "pipeline-orchestrator.md")
  const sourceOrchestrator = parseAgentFile(sourceOrchestratorPath, root)!
  sourceOrchestrator.frontmatter = {
    ...sourceOrchestrator.frontmatter,
    description: "Refreshed orchestrator",
    permission: {
      ...(sourceOrchestrator.frontmatter.permission as Record<string, unknown>),
      pipeline_verify: "allow",
      task: { "pipeline-executor": "ask", "pipeline-planner": "deny" }
    }
  }
  saveAgentFile(sourceOrchestratorPath, sourceOrchestrator.frontmatter, "Refreshed body for @pipeline-executor")

  ;(profilesMod as any).forkStampedPipeline(root, "pipeline", "qwen")
  const reforkedQwen = parseAgentFile(qwenPath, root)!
  assert.equal(reforkedQwen.frontmatter.model, "custom/qwen")
  assert.equal(reforkedQwen.frontmatter.variant, "high")
  assert.equal(reforkedQwen.frontmatter.temperature, 0.9)
  assert.equal(reforkedQwen.frontmatter.steps, 42)
  assert.equal(reforkedQwen.frontmatter.custom_target_note, "keep qwen")
  assert.equal(reforkedQwen.frontmatter.description, "Refreshed orchestrator")
  assert.equal(reforkedQwen.frontmatter.permission.pipeline_verify, "allow")
  assert.deepEqual(reforkedQwen.frontmatter.permission.task, { "*": "ask", "qwen-pipeline-executor": "deny", "qwen-pipeline-planner": "allow" })
  assert.deepEqual(Object.keys(reforkedQwen.frontmatter.permission.task), ["*", "qwen-pipeline-executor", "qwen-pipeline-planner"])
  assert.match(reforkedQwen.body, /Refreshed body for @qwen-pipeline-executor/)
})

test("forkStampedPipeline rejects duplicate normalized targets before creating categories", () => {
  const root = workspace()
  agent(root, "pipeline", "executor")
  agent(root, "pipeline", "orchestrator")
  const categoriesRoot = path.join(root, "export", "categories")

  assert.throws(() => (profilesMod as any).forkStampedPipeline(root, "pipeline", "alpha, alpha-pipeline"), /Duplicate stamped pipeline target/)
  assert.throws(() => (profilesMod as any).forkStampedPipeline(root, "pipeline", ["Alpha", "alpha-pipeline"]), /Duplicate stamped pipeline target/)
  assert.equal(fs.existsSync(categoriesRoot), false)
})

test("forkStampedPipeline rejects symlinked target paths before writing outside the workspace", () => {
  const root = workspace()
  agent(root, "pipeline", "executor")
  agent(root, "pipeline", "orchestrator")
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-fork-outside-"))
  const outsideFile = path.join(outside, "keep.txt")
  fs.writeFileSync(outsideFile, "keep\n")

  fs.mkdirSync(path.join(root, "export", "categories"), { recursive: true })
  fs.symlinkSync(outside, path.join(root, "export", "categories", "linked-pipeline"))
  assert.throws(() => (profilesMod as any).forkStampedPipeline(root, "pipeline", "linked"), /Invalid fork destination/)
  assert.equal(fs.readFileSync(outsideFile, "utf8"), "keep\n")
  assert.deepEqual(fs.readdirSync(path.join(root, "export", "categories", "linked-pipeline")), ["keep.txt"])

  fs.rmSync(path.join(root, "export", "categories", "linked-pipeline"))
  fs.rmSync(path.join(root, "export"), { recursive: true })
  fs.symlinkSync(outside, path.join(root, "export"))
  assert.throws(() => (profilesMod as any).forkStampedPipeline(root, "pipeline", "ancestor"), /Invalid fork destination/)
  assert.equal(fs.readFileSync(outsideFile, "utf8"), "keep\n")
  assert.deepEqual(fs.readdirSync(outside), ["keep.txt"])
})

test("forkStampedPipeline rejects conflicting target files without modifying existing category data", () => {
  const root = workspace()
  agent(root, "pipeline", "executor")
  agent(root, "pipeline", "orchestrator")
  const targetDir = path.join(root, "export", "categories", "conflict-pipeline")
  fs.mkdirSync(path.dirname(targetDir), { recursive: true })
  fs.writeFileSync(targetDir, "keep existing bytes\n")

  assert.throws(() => (profilesMod as any).forkStampedPipeline(root, "pipeline", "conflict"), /Invalid fork destination/)
  assert.equal(fs.readFileSync(targetDir, "utf8"), "keep existing bytes\n")
  assert.deepEqual(fs.readdirSync(path.dirname(targetDir)), ["conflict-pipeline"])
})
