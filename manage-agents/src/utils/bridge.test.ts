import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { bridgeToClaudeCode, buildClaudeCodePlugin, normalizeClaudeAgentName } from "./bridge.js"
import { DEFAULT_TRANSLATION_CONFIG, resolveRole, type TranslationConfig } from "./translationConfig.js"
import { bridgeToCodex } from "./codexBridge.js"
import type { AgentInfo } from "./agents.js"

function fixture(filename: string, body = ""): AgentInfo {
  const primary = filename.includes("orchestrator")
  return {
    filename,
    currentPath: `/tmp/${filename}`,
    targetPath: `/tmp/${filename}`,
    category: "copilot-pipeline",
    description: filename,
    model: primary ? "github-copilot/claude-opus-5" : "github-copilot/gpt-5.6-luna-max",
    rawContent: body,
    frontmatter: {
      mode: primary ? "primary" : "subagent",
      model: primary ? "github-copilot/claude-opus-5" : "github-copilot/gpt-5.6-luna-max",
      permission: {
        read: "allow",
        task: primary ? { "*": "deny", "copilot-pipeline-code_reviewer": "allow" } : { "*": "deny" }
      }
    },
    body,
    allowedSubagents: primary ? ["copilot-pipeline-code_reviewer"] : []
  }
}

function config(overrides: Partial<TranslationConfig> = {}): TranslationConfig {
  return { ...DEFAULT_TRANSLATION_CONFIG, ...overrides,
    claude: { ...DEFAULT_TRANSLATION_CONFIG.claude, ...overrides.claude } }
}

test("resolves Claude models from roles and per-agent overrides", () => {
  const planning = fixture("copilot-pipeline-planner.md")
  const execution = fixture("copilot-pipeline-worker.md")
  const custom = config({ claude: { overrides: { "worker": { model: "haiku" } } } })
  assert.equal(buildClaudeCodePlugin([planning, execution], "pipeline", "copilot-pipeline-", custom).agents[0].frontmatter.model, "opus")
  assert.equal(buildClaudeCodePlugin([planning, execution], "pipeline", "copilot-pipeline-", custom).agents[1].frontmatter.model, "haiku")
  assert.equal(resolveRole(fixture("copilot-pipeline-unknown.md"), custom), "unknown")
})

test("Claude and Codex previews agree on role, tier, and source", () => {
  const agents = [fixture("copilot-pipeline-planner.md"), fixture("copilot-pipeline-worker.md")]
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-parity-"))
  const claude = bridgeToClaudeCode(agents, "pipeline", "copilot-pipeline-", path.join(workspace, "claude"), workspace)
  const codex = bridgeToCodex(agents, "pipeline", "copilot-pipeline-", path.join(workspace, "codex"))
  assert.deepEqual(claude.preview?.map(({ agent, role, tier, source }) => ({ agent, role, tier, source })), codex.preview.map(({ agent, role, tier, source }) => ({ agent, role, tier, source })))
})

test("normalizes names to Claude's lower-hyphen form", () => {
  assert.equal(normalizeClaudeAgentName("copilot-pipeline-code_reviewer.md"), "copilot-pipeline-code-reviewer")
  assert.equal(normalizeClaudeAgentName("123_worker"), "agent-123-worker")
  const normalized = normalizeClaudeAgentName("Decent Pipeline")
  assert.equal(normalizeClaudeAgentName(normalized), normalized)
})

test("normalizes a dirty plugin name when building directly", () => {
  const plugin = buildClaudeCodePlugin(
    [
      fixture("copilot-pipeline-orchestrator.md", "Delegate to @copilot-pipeline-explorer."),
      fixture("copilot-pipeline-explorer.md")
    ],
    "Decent Pipeline",
    "copilot-pipeline-"
  )

  assert.equal(plugin.pluginName, "decent-pipeline")
  const orchestrator = plugin.agents.find(agent => agent.name === "orchestrator")
  assert.ok(orchestrator)
  assert.match(orchestrator.body, /@decent-pipeline:explorer/)
})

test("rejects a degenerate plugin name when building directly", () => {
  assert.throws(
    () => buildClaudeCodePlugin([fixture("copilot-pipeline-explorer.md")], "---", "copilot-pipeline-"),
    new Error("Invalid Claude plugin name '---': it must contain at least one letter or number.")
  )
})

test("rewrites cross-agent references and reports unresolved source refs", () => {
  const plugin = buildClaudeCodePlugin(
    [
      fixture(
        "copilot-pipeline-orchestrator.md",
        "Delegate to @copilot-pipeline-code_reviewer and @copilot-pipeline-docs-orchestrator_grounding. Broken: @copilot-pipeline-missing."
      ),
      fixture("copilot-pipeline-code_reviewer.md", "Review the change."),
      fixture("copilot-pipeline-docs_grounding.md", "Ground the docs.")
    ],
    "decent-pipeline",
    "copilot-pipeline-"
  )

  const orchestrator = plugin.agents.find(agent => agent.name === "orchestrator")
  assert.ok(orchestrator)
  assert.match(orchestrator.body, /@decent-pipeline:code-reviewer/)
  assert.match(orchestrator.body, /@decent-pipeline:docs-grounding/)
  assert.doesNotMatch(orchestrator.body, /@copilot-pipeline-code_reviewer/)
  assert.equal(orchestrator.frontmatter.tools, "Agent(decent-pipeline:code-reviewer), Read, Grep, Glob")
  assert.equal(orchestrator.frontmatter.name, "orchestrator")
  assert.equal(orchestrator.frontmatter.permissionMode, undefined)
  assert.equal(orchestrator.frontmatter.temperature, undefined)
  assert.ok(plugin.warnings?.some(warning => warning.includes("copilot-pipeline-missing")))
  assert.equal(plugin.orchestratorName, "orchestrator")
})

test("repairs the legacy docs-orchestrator grounding alias", () => {
  const plugin = buildClaudeCodePlugin(
    [
      fixture(
        "copilot-pipeline-orchestrator.md",
        "Use @copilot-pipeline-docs-orchestrator_grounding for documentation checks."
      ),
      fixture("copilot-pipeline-docs_grounding.md", "Ground the answer in the repository docs.")
    ],
    "pipeline",
    "copilot-pipeline-"
  )
  const orchestrator = plugin.agents.find(agent => agent.name === "orchestrator")
  assert.ok(orchestrator)
  assert.match(orchestrator.body, /@pipeline:docs-grounding/)
  assert.equal(plugin.warnings?.some(warning => warning.includes("docs-orchestrator_grounding")), false)
})

test("keeps unresolved and already-scoped references unchanged", () => {
  const plugin = buildClaudeCodePlugin(
    [
      fixture("copilot-pipeline-orchestrator.md", "Use @copilot-pipeline-code_reviewer, @decent-pipeline:code-reviewer, and @copilot-pipeline-missing."),
      fixture("copilot-pipeline-code_reviewer.md")
    ],
    "decent-pipeline",
    "copilot-pipeline-"
  )
  const orchestrator = plugin.agents.find(agent => agent.name === "orchestrator")
  assert.ok(orchestrator)
  assert.equal(
    orchestrator.body,
    "Use @decent-pipeline:code-reviewer, @decent-pipeline:code-reviewer, and @copilot-pipeline-missing."
  )
})

test("writes Claude MCP and LSP layers from OpenCode config", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bridge-workspace-"))
  fs.mkdirSync(path.join(workspace, "general"), { recursive: true })
  fs.writeFileSync(path.join(workspace, "general", "opencode.json"), JSON.stringify({
    mcp: { docs: { command: ["docs-mcp", "--stdio"], enabled: true } },
    lsp: { markdown: { command: ["marksman", "server"], extensions: [".md"] } }
  }))
  const output = path.join(workspace, "bridges", "claude")
  const result = bridgeToClaudeCode(
    [fixture("copilot-pipeline-orchestrator.md", "")],
    "pipeline",
    "copilot-pipeline-",
    output,
    workspace,
    DEFAULT_TRANSLATION_CONFIG
  )
  assert.ok(result.files.includes(".mcp.json"))
  assert.ok(result.files.includes(".lsp.json"))
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(output, ".claude-plugin", "plugin.json"), "utf8")).author.name,
    "Lorenzo Cancellara"
  )
  const readme = fs.readFileSync(path.join(output, "README.md"), "utf8")
  assert.match(readme, /--agent pipeline:orchestrator/)
  assert.equal(JSON.parse(fs.readFileSync(path.join(output, ".lsp.json"), "utf8")).markdown.extensionToLanguage[".md"], "markdown")
  assert.equal(result.preview?.[0].role, "orchestrator")
})

test("normalizes a dirty plugin name for scoped references", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bridge-name-workspace-"))
  fs.mkdirSync(path.join(workspace, "general"), { recursive: true })
  fs.writeFileSync(path.join(workspace, "general", "opencode.json"), "{}\n")
  const output = path.join(workspace, "bridges", "claude")
  bridgeToClaudeCode(
    [fixture("copilot-pipeline-orchestrator.md", "Delegate to @copilot-pipeline-code_reviewer."), fixture("copilot-pipeline-code_reviewer.md")],
    "Decent Pipeline",
    "copilot-pipeline-",
    output,
    workspace,
    DEFAULT_TRANSLATION_CONFIG
  )
  const generated = fs.readFileSync(path.join(output, "agents", "orchestrator.md"), "utf8")
  assert.match(generated, /@decent-pipeline:code-reviewer/)
})

test("writes exactly one blank line between Claude frontmatter and body", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bridge-spacing-workspace-"))
  fs.mkdirSync(path.join(workspace, "general"), { recursive: true })
  fs.writeFileSync(path.join(workspace, "general", "opencode.json"), "{}\n")
  const output = path.join(workspace, "bridges", "claude")

  bridgeToClaudeCode(
    [fixture("copilot-pipeline-executor.md", "\n\n\n# Executor\n\nExecute the plan.\n")],
    "pipeline",
    "copilot-pipeline-",
    output,
    workspace,
    DEFAULT_TRANSLATION_CONFIG
  )

  const generated = fs.readFileSync(path.join(output, "agents", "executor.md"), "utf8")
  assert.match(generated, /\n---\n\n# Executor\n/)
  assert.doesNotMatch(generated, /\n---\n\n\n# Executor\n/)
})

test("includes disabled MCP servers required by agents and emits setup guidance", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "claude-required-mcp-workspace-"))
  fs.mkdirSync(path.join(workspace, "general"), { recursive: true })
  fs.writeFileSync(path.join(workspace, "general", "opencode.json"), JSON.stringify({
    mcp: {
      cupertino: { command: ["cupertino", "serve"], enabled: false },
      "codebase-memory-mcp": { command: ["codebase-memory-mcp"], enabled: true }
    }
  }))
  const swiftAgent = fixture(
    "copilot-pipeline-swift_specialist.md",
    "Use Cupertino and the codebase-memory graph to ground the review."
  )
  swiftAgent.frontmatter.permission["cupertino_*"] = "allow"
  const output = path.join(workspace, "bridges", "claude")

  const result = bridgeToClaudeCode(
    [swiftAgent],
    "pipeline",
    "copilot-pipeline-",
    output,
    workspace,
    DEFAULT_TRANSLATION_CONFIG
  )

  const mcp = JSON.parse(fs.readFileSync(path.join(output, ".mcp.json"), "utf8")).mcpServers
  assert.equal(mcp.cupertino.command, "cupertino")
  assert.equal(mcp["codebase-memory-mcp"].command, "codebase-memory-mcp")
  const generated = fs.readFileSync(path.join(output, "agents", "swift-specialist.md"), "utf8")
  assert.match(generated, /mcp__plugin_pipeline_cupertino__\*/)
  assert.match(generated, /mcp__plugin_pipeline_codebase-memory-mcp__\*/)
  const readme = fs.readFileSync(path.join(output, "README.md"), "utf8")
  assert.match(readme, /## MCP setup/)
  assert.match(readme, /Lorenzo Cancellara/)
  assert.equal(result.warnings.some(warning => warning.includes("cupertino")), false)
})
