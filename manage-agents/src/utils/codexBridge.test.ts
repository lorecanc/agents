import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {
  bridgeToCodex,
  resolveCodexModel,
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
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-"))
  const result = bridgeToCodex(agents, "Decent Pipeline", "copilot-pipeline-", output)

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
})

test("role targets can be overridden without changing source agents", () => {
  const config: TranslationConfig = {
    ...DEFAULT_TRANSLATION_CONFIG,
    tiers: { ...DEFAULT_TRANSLATION_CONFIG.tiers,
      planning: { ...DEFAULT_TRANSLATION_CONFIG.tiers.planning, codex: { model: "custom-primary", reasoningEffort: "xhigh" } },
      execution: { ...DEFAULT_TRANSLATION_CONFIG.tiers.execution, codex: { model: "custom-default", reasoningEffort: "low" } } },
    codex: { ...DEFAULT_TRANSLATION_CONFIG.codex, emitSkills: false, emitReadme: false }
  }
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-config-"))
  const result = bridgeToCodex([
    agent("orchestrator.md", "any", { mode: "primary" }, ""),
    agent("worker.md", "different", {}, "")
  ], "configured", "", output, undefined, config)

  assert.equal(result.plugin.agents[0].model, "custom-primary")
  assert.equal(result.plugin.agents[1].model, "custom-default")
  assert.equal(result.plugin.skills.length, 0)
  assert.ok(!fs.existsSync(path.join(output, "README.md")))
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
  assert.ok(result.files.some(file => file.endsWith("/.mcp.json")))
})
