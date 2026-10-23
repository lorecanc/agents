import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {
  bridgeToCodex,
  resolveCodexModel,
  writeCodexPlugin,
} from "./codexBridge.js"
import { DEFAULT_TRANSLATION_CONFIG, type TranslationConfig } from "./translationConfig.js"
import type { AgentInfo } from "./agents.js"

function agent(
  filename: string,
  model: string,
  frontmatter: Record<string, any>,
  body: string,
  allowedSubagents: string[] = []
): AgentInfo {
  return {
    filename,
    currentPath: filename,
    targetPath: filename,
    category: "test",
    description: `${filename} description`,
    model,
    rawContent: body,
    frontmatter,
    body,
    allowedSubagents
  }
}

test("Codex roles map planning to Sol/high and execution to Luna/max", () => {
  const primary = agent("copilot-pipeline-orchestrator.md", "github-copilot/claude-opus-5", { mode: "primary" }, "")
  const opus = agent("copilot-pipeline-reviewer.md", "github-copilot/claude-opus-5", {}, "")
  const luna = agent("copilot-pipeline-explorer.md", "github-copilot/gpt-5.6-luna", {}, "")

  assert.deepEqual(resolveCodexModel(primary), { model: "gpt-5.6-sol", reasoningEffort: "high" })
  assert.deepEqual(resolveCodexModel(opus), { model: "gpt-5.6-luna", reasoningEffort: "max" })
  assert.deepEqual(resolveCodexModel(luna), { model: "gpt-5.6-luna", reasoningEffort: "max" })
})

test("bridge emits manifest, Codex agents, skills and translated links", () => {
  const agents = [
    agent(
      "copilot-pipeline-orchestrator.md",
      "github-copilot/claude-opus-5",
      { mode: "primary", permission: { task: { "copilot-pipeline-fast_lane": "allow" } } },
      "Delegate to @copilot-pipeline-fast_lane; do not call @copilot-pipeline-missing.",
      ["copilot-pipeline-fast_lane"]
    ),
    agent("copilot-pipeline-fast_lane.md", "github-copilot/gpt-5.6-luna", {}, "Fast lane")
  ]
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-"))
  const output = path.join(workspace, "bridges", "codex")
  const result = bridgeToCodex(agents, "Decent Pipeline", "copilot-pipeline-", output, workspace)

  assert.equal(result.plugin.pluginName, "decent-pipeline")
  assert.equal(result.plugin.orchestratorName, "orchestrator")
  assert.equal(result.plugin.agents[0].model, "gpt-5.6-sol")
  assert.equal(result.plugin.agents[0].modelReasoningEffort, "high")
  assert.equal(result.plugin.agents[0].sandboxMode, "read-only")
  assert.equal(result.plugin.agents[1].model, "gpt-5.6-luna")
  assert.equal(result.plugin.agents[1].modelReasoningEffort, "max")
  assert.ok(result.warnings.some(warning => warning.includes("unresolved agent reference @copilot-pipeline-missing")))

  const manifestPath = path.join(output, ".codex-plugin", "plugin.json")
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
  assert.equal(manifest.name, "decent-pipeline")
  assert.equal(manifest.author.name, "Lorenzo Cancellara")
  assert.equal(manifest.skills, "./skills/")

  const orchestratorToml = fs.readFileSync(path.join(output, ".codex", "agents", "orchestrator.toml"), "utf8")
  assert.match(orchestratorToml, /model = "gpt-5\.6-sol"/)
  assert.match(orchestratorToml, /model_reasoning_effort = "high"/)
  assert.match(orchestratorToml, /@fast-lane/)
  assert.ok(fs.existsSync(path.join(output, "skills", "orchestrator", "SKILL.md")))
  assert.match(fs.readFileSync(path.join(output, "README.md"), "utf8"), /Source and configuration/)
  assert.match(fs.readFileSync(path.join(output, "README.md"), "utf8"), /`general\/`/)
  assert.match(fs.readFileSync(path.join(output, "README.md"), "utf8"), /`src\/opencode\.json`/)
  assert.match(fs.readFileSync(path.join(output, "README.md"), "utf8"), /Do not edit this directory directly/)
})

test("Codex README stays generic for non-Copilot categories", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-category-"))
  const output = path.join(workspace, "bridges", "codex")
  bridgeToCodex([agent("docs-orchestrator.md", "any", { mode: "primary" }, "")], "docs", "docs-", output, workspace)
  const readme = fs.readFileSync(path.join(output, "README.md"), "utf8")
  assert.match(readme, /canonical source agents/)
  assert.doesNotMatch(readme, /Copilot pipeline/)
})

test("Codex README uses the configured source directory", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-source-"))
  const output = path.join(workspace, "bridges", "codex")
  bridgeToCodex([agent("docs-orchestrator.md", "any", { mode: "primary" }, "")], "docs", "docs-", output, workspace, { ...DEFAULT_TRANSLATION_CONFIG, sourceDir: "custom-agents" })
  const readme = fs.readFileSync(path.join(output, "README.md"), "utf8")
  assert.match(readme, /`custom-agents\/`/)
  assert.doesNotMatch(readme, /agents\/general\/agents\//)
})

test("role targets can be overridden without changing source agents", () => {
  const config: TranslationConfig = {
    ...DEFAULT_TRANSLATION_CONFIG,
    tiers: { ...DEFAULT_TRANSLATION_CONFIG.tiers,
      planning: { ...DEFAULT_TRANSLATION_CONFIG.tiers.planning, codex: { model: "custom-primary", reasoningEffort: "xhigh" } },
      execution: { ...DEFAULT_TRANSLATION_CONFIG.tiers.execution, codex: { model: "custom-default", reasoningEffort: "low" } } },
    codex: { ...DEFAULT_TRANSLATION_CONFIG.codex, emitSkills: false, emitReadme: false }
  }
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-config-"))
  const output = path.join(workspace, "bridges", "codex")
  const result = bridgeToCodex([
    agent("orchestrator.md", "any", { mode: "primary" }, ""),
    agent("worker.md", "different", {}, "")
  ], "configured", "", output, workspace, config)

  assert.equal(result.plugin.agents[0].model, "custom-primary")
  assert.equal(result.plugin.agents[1].model, "custom-default")
  assert.equal(result.plugin.skills.length, 0)
  assert.ok(!fs.existsSync(path.join(output, "README.md")))
})

test("codex.modelMap maps the source model into the emitted TOML without a reasoning effort", () => {
  const config: TranslationConfig = {
    ...DEFAULT_TRANSLATION_CONFIG,
    codex: {
      ...DEFAULT_TRANSLATION_CONFIG.codex,
      modelMap: { "deepseek-v4.1-flash": "gpt-5.6-luna" },
      emitSkills: false,
      emitReadme: false
    }
  }
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-model-map-"))
  const output = path.join(workspace, "bridges", "codex")
  const result = bridgeToCodex(
    [agent("executor.md", "deepseek/deepseek-v4.1-flash", {}, "")],
    "mapped", "", output, workspace, config
  )

  assert.equal(result.preview[0].source, "model-map")
  assert.equal(result.plugin.agents[0].model, "gpt-5.6-luna")
  assert.equal(result.plugin.agents[0].modelReasoningEffort, undefined)
  const toml = fs.readFileSync(path.join(output, ".codex", "agents", "executor.toml"), "utf8")
  assert.match(toml, /model = "gpt-5\.6-luna"/)
  assert.doesNotMatch(toml, /model_reasoning_effort/)
  assert.ok(!result.warnings.some(warning => warning.startsWith("[model-map]")))
})

test("codex.modelMap catch-all applies to unmapped models and specific keys win", () => {
  const config: TranslationConfig = {
    ...DEFAULT_TRANSLATION_CONFIG,
    codex: {
      ...DEFAULT_TRANSLATION_CONFIG.codex,
      modelMap: { "*": "gpt-5.6-sol", "deepseek-v4.1-flash": "gpt-5.6-luna" },
      emitSkills: false,
      emitReadme: false
    }
  }
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-model-map-catch-all-"))
  const output = path.join(workspace, "bridges", "codex")
  const result = bridgeToCodex([
    agent("planner.md", "unknown/model-x", {}, ""),
    agent("executor.md", "deepseek-v4.1-flash", {}, "")
  ], "mapped", "", output, workspace, config)

  assert.equal(result.plugin.agents[0].model, "gpt-5.6-sol")
  assert.equal(result.plugin.agents[1].model, "gpt-5.6-luna")
  assert.deepEqual(result.preview.map(entry => entry.source), ["model-map", "model-map"])
})

test("codex.modelMap dead keys are reported as translation warnings", () => {
  const config: TranslationConfig = {
    ...DEFAULT_TRANSLATION_CONFIG,
    codex: {
      ...DEFAULT_TRANSLATION_CONFIG.codex,
      modelMap: { "missing-model": "gpt-5.6-luna" },
      emitSkills: false
    }
  }
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-model-map-dead-"))
  const output = path.join(workspace, "bridges", "codex")
  const result = bridgeToCodex(
    [agent("orchestrator.md", "deepseek-v4.1-flash", { mode: "primary" }, "")],
    "mapped", "", output, workspace, config
  )

  const expected = '[model-map] entry "missing-model" matches no source agent model'
  assert.ok(result.warnings.includes(expected))
  assert.match(fs.readFileSync(path.join(output, "README.md"), "utf8"), /\[model-map\] entry "missing-model" matches no source agent model/)
})

test("permissions.shell and permissions.bash produce the same sandbox decision", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-shell-"))
  const output = path.join(workspace, "bridges", "codex")
  const result = bridgeToCodex([
    agent("bash-agent.md", "any", { permission: { bash: "allow" } }, ""),
    agent("shell-agent.md", "any", { permission: { shell: "allow" } }, ""),
    agent("denied-shell-agent.md", "any", { permission: { shell: "deny" } }, "")
  ], "sandbox", "", output, workspace, {
    ...DEFAULT_TRANSLATION_CONFIG,
    codex: { ...DEFAULT_TRANSLATION_CONFIG.codex, emitSkills: false, emitReadme: false }
  })

  assert.equal(result.plugin.agents[0].sandboxMode, "workspace-write")
  assert.equal(result.plugin.agents[1].sandboxMode, result.plugin.agents[0].sandboxMode)
  assert.equal(result.plugin.agents[2].sandboxMode, "read-only")
})

test("Codex plugin mirrors enabled MCP servers in a valid companion layer", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-mcp-"))
  fs.mkdirSync(path.join(workspace, "general"), { recursive: true })
  fs.writeFileSync(path.join(workspace, "general", "opencode.json"), JSON.stringify({
    mcp: {
      docs: { command: ["docs-mcp", "--stdio"], enabled: true },
      cupertino: { command: ["cupertino", "serve"], enabled: false }
    }
  }))
  const output = path.join(workspace, "bridges", "codex")
  const result = bridgeToCodex([
    agent("orchestrator.md", "any", {
      mode: "primary",
      permission: { "cupertino_*": "allow" }
    }, "")
  ], "configured", "", output, workspace)
  const manifest = JSON.parse(fs.readFileSync(path.join(output, ".codex-plugin", "plugin.json"), "utf8"))
  assert.equal(manifest.mcpServers, "./.mcp.json")
  const mcp = JSON.parse(fs.readFileSync(path.join(output, ".mcp.json"), "utf8"))
  assert.deepEqual(Object.keys(mcp.mcpServers), ["docs", "cupertino"])
  assert.match(fs.readFileSync(path.join(output, "README.md"), "utf8"), /## MCP setup/)
  assert.ok(result.files.some(file => file.split(path.sep).join("/").endsWith("/.mcp.json")))
})

test("writeCodexPlugin rejects output directories escaping the workspace root", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-ws-"))
  const tmpParent = path.dirname(workspace)
  const escapeTarget = path.join(tmpParent, "codex-bridge-escape-target")
  const escapingOutput = path.join(workspace, "bridges", "..", "..", "codex-bridge-escape-target")
  const agents = [agent("orchestrator.md", "any", { mode: "primary" }, "")]

  assert.throws(
    () => writeCodexPlugin(agents, "decent-pipeline", "", escapingOutput, workspace, DEFAULT_TRANSLATION_CONFIG),
    /outside workspace/i
  )
  // The caller wiring (index.tsx) forwards workspaceRoot through bridgeToCodex.
  assert.throws(
    () => bridgeToCodex(agents, "decent-pipeline", "", escapingOutput, workspace),
    /outside workspace/i
  )
  assert.ok(!fs.existsSync(escapeTarget), "no plugin files may be written outside the workspace")
})

test("writeCodexPlugin still writes the manifest for output inside the workspace", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-ws-"))
  const output = path.join(workspace, "bridges", "codex", "decent-pipeline")
  const result = writeCodexPlugin(
    [agent("orchestrator.md", "any", { mode: "primary" }, "")],
    "decent-pipeline",
    "",
    output,
    workspace,
    DEFAULT_TRANSLATION_CONFIG
  )

  const manifestPath = path.join(output, ".codex-plugin", "plugin.json")
  assert.ok(fs.existsSync(manifestPath))
  // pluginDir is resolved through fs.realpathSync, so compare real paths
  // (os.tmpdir() is a symlink on macOS).
  assert.ok(result.files.includes(fs.realpathSync(manifestPath)))
  assert.equal(JSON.parse(fs.readFileSync(manifestPath, "utf8")).name, "decent-pipeline")
})

test("writeCodexPlugin requires a workspaceRoot", () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-legacy-"))
  assert.throws(
    () => (writeCodexPlugin as any)([agent("orchestrator.md", "any", { mode: "primary" }, "")], "legacy-plugin", "", output),
    /workspaceRoot/i
  )
})

test("writeCodexPlugin refuses a symlinked output pointing outside the workspace", { skip: process.platform === "win32" }, () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-symlink-ws-"))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-symlink-out-"))
  fs.symlinkSync(outside, path.join(workspace, "out"), "dir")
  assert.throws(
    () => writeCodexPlugin([agent("orchestrator.md", "any", { mode: "primary" }, "")], "decent-pipeline", "", path.join(workspace, "out"), workspace),
    /outside workspace/i
  )
  assert.equal(fs.readdirSync(outside).length, 0)
})

test("Codex bridge translates OpenCode tool names and flags OpenCode-only tools once", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-tools-"))
  const output = path.join(workspace, "bridges", "codex")
  const body = "# Orchestrator\n\nUse `todowrite` to track work. Call `pipeline_state` if it is available; otherwise use the fallback.\nAsk the user (use `question`) and launch two Task calls in one turn.\nRun pipeline_env before smoke tests."
  const orchestrator = agent("pipeline-orchestrator.md", "any", { mode: "primary", permission: { pipeline_state: "allow", pipeline_commit: "deny", todowrite: "allow", bash: { "*": "deny", "git status*": "allow", "rm *": "ask" } } }, body)
  const result = bridgeToCodex([orchestrator], "decent-pipeline", "pipeline-", output, workspace)
  const instructions = result.plugin.agents[0].developerInstructions
  assert.match(instructions, /^# Orchestrator\n\n> \*\*Runtime note \(OpenCode bridge\)\.\*\*/)
  assert.match(instructions, /not available\*\* in this environment: `pipeline_env`, `pipeline_state`\./)
  assert.doesNotMatch(instructions, /pipeline_commit/)
  assert.match(instructions, /Use `update_plan` to track work/)
  assert.match(instructions, /`question`: ask the user directly/)
  assert.match(instructions, /`task`: delegate to the Codex subagents/)
  assert.equal(instructions.match(/Runtime note \(OpenCode bridge\)/g)?.length, 1)
  const readme = fs.readFileSync(path.join(output, "README.md"), "utf8")
  assert.match(readme, /## Per-agent bash allowlists \(not enforced\)/)
  assert.match(readme, /- allow: `git status\*`/)
  assert.match(readme, /- ask: `rm \*`/)
})

test("Codex bridge never treats pipeline tool or built-in permission keys as MCP servers", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-mcp-keys-"))
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true })
  fs.writeFileSync(path.join(workspace, "src", "opencode.json"), JSON.stringify({ mcp: {
    pipeline: { command: ["fake-pipeline"], enabled: false },
    external: { command: ["fake-external"], enabled: false },
    "cwe-search": { command: ["cwe"], enabled: false }
  } }))
  const output = path.join(workspace, "bridges", "codex")
  const auditor = agent("pipeline-security_auditor.md", "any", { permission: { pipeline_env: "allow", external_directory: { "*": "deny" }, "cwe-search_*": "allow" } }, "Tools are prefixed: `cwe-search_get_cwe_weakness`.")
  bridgeToCodex([auditor], "decent-pipeline", "pipeline-", output, workspace)
  const mcp = JSON.parse(fs.readFileSync(path.join(output, ".mcp.json"), "utf8")).mcpServers
  assert.deepEqual(Object.keys(mcp), ["cwe-search"])
})
