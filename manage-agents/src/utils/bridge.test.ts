import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { bridgeToClaudeCode, buildClaudeCodePlugin, normalizeClaudeAgentName, writeClaudeCodePlugin } from "./bridge.js"
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
  const codex = bridgeToCodex(agents, "pipeline", "copilot-pipeline-", path.join(workspace, "codex"), workspace)
  assert.deepEqual(claude.preview?.map(({ agent, role, tier, source }) => ({ agent, role, tier, source })), codex.preview.map(({ agent, role, tier, source }) => ({ agent, role, tier, source })))
})

test("writeClaudeCodePlugin refuses a symlinked output pointing outside the workspace", { skip: process.platform === "win32" }, () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bridge-symlink-ws-"))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bridge-symlink-out-"))
  fs.symlinkSync(outside, path.join(workspace, "out"), "dir")
  const plugin = buildClaudeCodePlugin([fixture("copilot-pipeline-orchestrator.md")], "decent-pipeline", "copilot-pipeline-")
  assert.throws(
    () => writeClaudeCodePlugin(plugin, path.join(workspace, "out"), workspace),
    /outside workspace/i
  )
  assert.equal(fs.readdirSync(outside).length, 0)
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
  assert.match(readme, /Source and configuration/)
  assert.match(readme, /discovered under `general\/`/)
  assert.match(readme, /`src\/opencode\.json`/)
  assert.match(readme, /legacy `general\/opencode\.json`/)
  assert.match(readme, /Do not edit this directory directly/)
  assert.equal(JSON.parse(fs.readFileSync(path.join(output, ".lsp.json"), "utf8")).markdown.extensionToLanguage[".md"], "markdown")
  assert.equal(result.preview?.[0].role, "orchestrator")
})

test("Claude README stays generic for non-Copilot categories", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bridge-category-"))
  const output = path.join(workspace, "bridges", "claude")
  bridgeToClaudeCode([fixture("docs-orchestrator.md")], "docs", "docs-", output, workspace)
  const readme = fs.readFileSync(path.join(output, "README.md"), "utf8")
  assert.match(readme, /canonical source agents/)
  assert.doesNotMatch(readme, /Copilot pipeline/)
})

test("Claude README uses the configured source directory", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bridge-source-"))
  const output = path.join(workspace, "bridges", "claude")
  bridgeToClaudeCode([fixture("docs-orchestrator.md")], "docs", "docs-", output, workspace, config({ sourceDir: "custom-agents" }))
  const readme = fs.readFileSync(path.join(output, "README.md"), "utf8")
  assert.match(readme, /`custom-agents\/`/)
  assert.doesNotMatch(readme, /agents\/general\/agents\//)
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

test("resolves Claude models from claude.modelMap", () => {
  const planning = fixture("copilot-pipeline-planner.md")
  planning.model = "github-copilot/claude-opus-5"
  planning.frontmatter.model = "github-copilot/claude-opus-5"
  const execution = fixture("copilot-pipeline-worker.md")

  const fullId = config({ claude: { overrides: {}, modelMap: { "github-copilot/claude-opus-5": "claude-opus-4-1-20250805" } } })
  assert.equal(
    buildClaudeCodePlugin([planning, execution], "pipeline", "copilot-pipeline-", fullId).agents[0].frontmatter.model,
    "claude-opus-4-1-20250805"
  )

  const bareId = config({ claude: { overrides: {}, modelMap: { "gpt-5.6-luna-max": "haiku" } } })
  assert.equal(
    buildClaudeCodePlugin([planning, execution], "pipeline", "copilot-pipeline-", bareId).agents[1].frontmatter.model,
    "haiku"
  )

  const catchAll = config({ claude: { overrides: {}, modelMap: { "*": "sonnet" } } })
  assert.deepEqual(
    buildClaudeCodePlugin([planning, execution], "pipeline", "copilot-pipeline-", catchAll).agents.map(agent => agent.frontmatter.model),
    ["sonnet", "sonnet"]
  )
})

test("previews model-map sources and warns on dead model-map keys", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "claude-model-map-"))
  const agents = [fixture("copilot-pipeline-planner.md"), fixture("copilot-pipeline-worker.md")]
  agents[0].model = "github-copilot/claude-opus-5"
  agents[0].frontmatter.model = "github-copilot/claude-opus-5"
  const mapped = config({ claude: { overrides: {}, modelMap: { "github-copilot/gpt-5.6-luna-max": "sonnet", "missing-model": "opus" } } })

  const result = bridgeToClaudeCode(agents, "pipeline", "copilot-pipeline-", path.join(workspace, "claude"), workspace, mapped)

  assert.deepEqual(result.preview?.map(preview => preview.source), ["role", "model-map"])
  assert.ok(result.warnings.includes('[model-map] entry "missing-model" matches no source agent model in this bridge'))
})

test("emits Claude tool names for the expanded OpenCode vocabulary", () => {
  const agent = fixture("copilot-pipeline-executor.md")
  agent.frontmatter.permission = {
    shell: "allow",
    websearch: "allow",
    skill: "allow",
    lsp: "allow",
    question: "allow",
    todowrite: "allow"
  }

  const tools = String(buildClaudeCodePlugin([agent], "pipeline", "copilot-pipeline-").agents[0].frontmatter.tools).split(", ")

  for (const name of ["Bash", "WebSearch", "Skill", "LSP", "AskUserQuestion", "TodoWrite"]) {
    assert.ok(tools.includes(name), `${name} should be emitted, got ${tools.join(", ")}`)
  }
})

test("honors last-match-wins for bash and edit permission objects", () => {
  const bashAgent = fixture("copilot-pipeline-executor.md")
  bashAgent.frontmatter.permission = { bash: { "*": "deny", "node *": "allow" } }
  const bashTools = String(buildClaudeCodePlugin([bashAgent], "pipeline", "copilot-pipeline-").agents[0].frontmatter.tools)
  assert.ok(bashTools.split(", ").includes("Bash"))

  const editAgent = fixture("copilot-pipeline-executor.md")
  editAgent.frontmatter.permission = { edit: { "*": "deny", "docs/*.md": "allow" } }
  const editTools = String(buildClaudeCodePlugin([editAgent], "pipeline", "copilot-pipeline-").agents[0].frontmatter.tools)
  assert.ok(editTools.includes("Write, Edit"))
})

test("honors last-match-wins for webfetch permission objects", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "claude-webfetch-perms-"))

  const denied = fixture("copilot-pipeline-executor.md")
  denied.frontmatter.permission = { webfetch: { "https://trusted/*": "allow", "*": "deny" } }
  const deniedOutput = path.join(workspace, "denied")
  const deniedResult = bridgeToClaudeCode([denied], "pipeline", "copilot-pipeline-", deniedOutput, workspace)
  const deniedTools = fs.readFileSync(path.join(deniedOutput, "agents", "executor.md"), "utf8").match(/^tools: (.*)$/m)?.[1] || ""
  assert.equal(deniedTools.includes("WebFetch"), false, `WebFetch must not be emitted after a catch-all deny; got ${deniedTools}`)
  assert.ok(
    deniedResult.warnings.some(warning => warning.includes("webfetch") && warning.includes("domain")),
    "missing webfetch granularity warning"
  )

  const allowed = fixture("copilot-pipeline-executor.md")
  allowed.frontmatter.permission = { webfetch: { "https://trusted/*": "allow" } }
  const allowedOutput = path.join(workspace, "allowed")
  bridgeToClaudeCode([allowed], "pipeline", "copilot-pipeline-", allowedOutput, workspace)
  const allowedTools = fs.readFileSync(path.join(allowedOutput, "agents", "executor.md"), "utf8").match(/^tools: (.*)$/m)?.[1] || ""
  assert.ok(allowedTools.split(", ").includes("WebFetch"), `WebFetch should be emitted; got ${allowedTools}`)
})

test("never fabricates MCP servers from built-in permission keys", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "claude-builtin-perms-"))
  const agent = fixture("copilot-pipeline-executor.md")
  agent.frontmatter.permission = {
    pipeline_state: "allow",
    external_directory: { "*": "deny", "~/.local/*": "allow" },
    read_mcp_resource: "allow",
    doom_loop: "deny",
    read: "allow"
  }
  const output = path.join(workspace, "claude")

  const result = bridgeToClaudeCode([agent], "pipeline", "copilot-pipeline-", output, workspace)

  const generated = fs.readFileSync(path.join(output, "agents", "executor.md"), "utf8")
  const tools = generated.match(/^tools: (.*)$/m)?.[1] || ""
  for (const forbidden of [
    "mcp__pipeline__*", "mcp__plugin_pipeline_pipeline__*",
    "mcp__external__*", "mcp__plugin_pipeline_external__*",
    "mcp__read__*", "mcp__plugin_pipeline_read__*",
    "mcp__doom__*", "mcp__plugin_pipeline_doom__*"
  ]) {
    assert.equal(tools.includes(forbidden), false, `${forbidden} must not be emitted; got ${tools}`)
  }
  for (const key of ["pipeline_state", "external_directory", "doom_loop"]) {
    assert.ok(result.warnings.some(warning => warning.includes(`'${key}'`)), `missing dropped-key warning for ${key}`)
  }
})

test("warns about granular permission rules lost in translation", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "claude-permission-losses-"))
  const agent = fixture("copilot-pipeline-executor.md")
  agent.frontmatter.permission = {
    bash: { "*": "deny", "node *": "allow", "rm *": "deny" },
    edit: { "*": "deny", "docs/*.md": "allow" },
    webfetch: { "*": "deny", "https://example.com/*": "allow" },
    websearch: "ask",
    skill: "ask",
    imagegen: "allow"
  }

  const result = bridgeToClaudeCode([agent], "pipeline", "copilot-pipeline-", path.join(workspace, "claude"), workspace)

  const bashWarning = result.warnings.find(warning => warning.includes("bash patterns not representable"))
  assert.ok(bashWarning, "missing bash pattern warning")
  assert.match(bashWarning!, /"node \*"/)
  assert.match(bashWarning!, /"rm \*"/)

  const editWarning = result.warnings.find(warning => warning.includes("edit patterns not representable"))
  assert.ok(editWarning, "missing edit pattern warning")
  assert.match(editWarning!, /"docs\/\*\.md"/)

  const webfetchWarning = result.warnings.find(warning => warning.includes("webfetch") && warning.includes("domain"))
  assert.ok(webfetchWarning, "missing webfetch granularity warning")

  const promoted = result.warnings.find(warning => warning.includes("promoted to allow"))
  assert.ok(promoted, "missing ask-promotion note")
  assert.match(promoted!, /websearch/)
  assert.match(promoted!, /skill/)

  assert.ok(result.warnings.some(warning => warning.includes("'imagegen'")))
})

test("README documents model aliases and connection modes", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "claude-readme-model-"))
  const output = path.join(workspace, "claude")
  bridgeToClaudeCode([fixture("copilot-pipeline-orchestrator.md")], "pipeline", "copilot-pipeline-", output, workspace)

  const readme = fs.readFileSync(path.join(output, "README.md"), "utf8")
  assert.match(readme, /## Model connection/)
  assert.match(readme, /subscription OAuth via `\/login`/)
  assert.match(readme, /v2\.1\.257/)
})

test("lists untranspiled OpenCode plugins and tools only when they exist", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "claude-readme-companions-"))
  const agents = [fixture("copilot-pipeline-orchestrator.md")]

  const emptyOutput = path.join(workspace, "empty")
  const empty = bridgeToClaudeCode(agents, "pipeline", "copilot-pipeline-", emptyOutput, workspace)
  assert.doesNotMatch(fs.readFileSync(path.join(emptyOutput, "README.md"), "utf8"), /## OpenCode plugins and tools/)
  assert.equal(empty.warnings.some(warning => warning.includes("not transpiled")), false)

  fs.mkdirSync(path.join(workspace, "src", "plugins"), { recursive: true })
  fs.writeFileSync(path.join(workspace, "src", "plugins", "pipeline-guard.js"), "")
  fs.mkdirSync(path.join(workspace, "src", "tools"), { recursive: true })
  fs.writeFileSync(path.join(workspace, "src", "tools", "pipeline_commit.ts"), "")

  const output = path.join(workspace, "claude")
  const result = bridgeToClaudeCode(agents, "pipeline", "copilot-pipeline-", output, workspace)
  const readme = fs.readFileSync(path.join(output, "README.md"), "utf8")
  assert.match(readme, /## OpenCode plugins and tools/)
  assert.match(readme, /plugins\/pipeline-guard\.js/)
  assert.match(readme, /tools\/pipeline_commit\.ts/)
  assert.match(readme, /`tool\.execute\.before` \| `PreToolUse`/)
  assert.match(readme, /`session\.idle` \| `Stop`/)
  assert.ok(result.warnings.some(warning => warning.includes("OpenCode plugin 'plugins/pipeline-guard.js' is not transpiled")))
  assert.ok(result.warnings.some(warning => warning.includes("OpenCode tool 'tools/pipeline_commit.ts' is not transpiled")))

  const secondOutput = path.join(workspace, "claude")
  bridgeToClaudeCode(agents, "pipeline", "copilot-pipeline-", secondOutput, workspace)
  assert.equal(fs.readFileSync(path.join(secondOutput, "README.md"), "utf8"), readme)
})

test("never fabricates MCP tools from custom pipeline tool permissions", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pipeline-tools-"))
  const agent = fixture("copilot-pipeline-executor.md")
  agent.frontmatter.permission = {
    pipeline_commit: "allow",
    pipeline_serve: "allow",
    pipeline_smoke: "allow",
    pipeline_state: "allow",
    bash: { "*": "deny", "git status*": "allow" },
    read: "allow"
  }
  const output = path.join(workspace, "claude")

  const result = bridgeToClaudeCode([agent], "pipeline", "copilot-pipeline-", output, workspace)

  const generated = fs.readFileSync(path.join(output, "agents", "executor.md"), "utf8")
  const tools = generated.match(/^tools: (.*)$/m)?.[1] || ""
  assert.equal(tools.includes("mcp__pipeline"), false, `mcp__pipeline tools must not be emitted; got ${tools}`)
  assert.doesNotMatch(generated, /## MCP Tools/)
  for (const key of ["pipeline_commit", "pipeline_serve", "pipeline_smoke", "pipeline_state"]) {
    assert.ok(
      result.warnings.some(warning => warning.includes(`permission '${key}' is not representable`)),
      `missing dropped-key warning for ${key}`
    )
  }

  const mcpAgent = fixture("copilot-pipeline-executor.md")
  mcpAgent.frontmatter.permission = { "codebase-memory-mcp_*": "allow" }
  const mcpTools = String(buildClaudeCodePlugin([mcpAgent], "pipeline", "copilot-pipeline-").agents[0].frontmatter.tools)
  assert.ok(mcpTools.split(", ").includes("mcp__codebase-memory-mcp__*"), `expected real MCP tool, got ${mcpTools}`)
})

test("warns when per-tool MCP denies are lost behind a server-wide allow", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "claude-mcp-per-tool-deny-"))
  const agent = fixture("copilot-pipeline-security_auditor.md")
  agent.frontmatter.permission = {
    "codebase-memory-mcp_*": "allow",
    "codebase-memory-mcp_delete_project": "deny",
    "codebase-memory-mcp_ingest_traces": "deny"
  }
  const output = path.join(workspace, "claude")

  const result = bridgeToClaudeCode([agent], "pipeline", "copilot-pipeline-", output, workspace)

  const tools = String(buildClaudeCodePlugin([agent], "pipeline", "copilot-pipeline-").agents[0].frontmatter.tools).split(", ")
  assert.ok(tools.includes("mcp__codebase-memory-mcp__*"), `expected whole-server wildcard, got ${tools.join(", ")}`)

  const perToolWarnings = result.warnings.filter(warning => warning.includes("MCP per-tool deny rules"))
  assert.equal(perToolWarnings.length, 1, `expected one per-server warning, got ${perToolWarnings.join(" | ")}`)
  assert.match(perToolWarnings[0], /server 'codebase-memory-mcp'/)
  assert.match(perToolWarnings[0], /codebase-memory-mcp_delete_project/)
  assert.match(perToolWarnings[0], /codebase-memory-mcp_ingest_traces/)
})

test("warns when scalar ask values promote edit, bash, and webfetch", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "claude-ask-promotion-"))
  const cases = [
    { key: "edit", tools: ["Write", "Edit"] },
    { key: "bash", tools: ["Bash"] },
    { key: "webfetch", tools: ["WebFetch"] }
  ]

  for (const { key, tools } of cases) {
    const agent = fixture("copilot-pipeline-executor.md")
    agent.frontmatter.permission = { [key]: "ask" }
    const output = path.join(workspace, key)
    const result = bridgeToClaudeCode([agent], "pipeline", "copilot-pipeline-", output, workspace)

    const emitted = fs.readFileSync(path.join(output, "agents", "executor.md"), "utf8").match(/^tools: (.*)$/m)?.[1] || ""
    for (const tool of tools) {
      assert.ok(emitted.split(", ").includes(tool), `${tool} should be emitted for ${key}: ask; got ${emitted}`)
    }

    const promoted = result.warnings.find(warning => warning.includes("promoted to allow"))
    assert.ok(promoted, `missing ask-promotion warning for ${key}`)
    const promotedKeys = promoted!.split(" for ")[1].split(" (")[0].split(", ")
    assert.ok(promotedKeys.includes(key), `${key} should be listed as promoted; got ${promoted}`)
  }
})

test("emits no promotion or per-tool MCP deny warnings when not needed", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "claude-warning-noise-"))
  const agent = fixture("copilot-pipeline-executor.md")
  agent.frontmatter.permission = {
    read: "allow",
    "codebase-memory-mcp_*": "allow"
  }
  const output = path.join(workspace, "claude")

  const result = bridgeToClaudeCode([agent], "pipeline", "copilot-pipeline-", output, workspace)

  assert.equal(result.warnings.some(warning => warning.includes("promoted to allow")), false)
  assert.equal(result.warnings.some(warning => warning.includes("MCP per-tool deny rules")), false)
})

test("resolves companion links from the bridged category, not the global prefix", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "claude-companion-category-"))
  fs.mkdirSync(path.join(workspace, ".agent-manager"), { recursive: true })
  fs.writeFileSync(
    path.join(workspace, ".agent-manager", "companion-links.json"),
    JSON.stringify({
      version: 1,
      categories: {
        pipeline: {
          plugins: ["plugins/pipeline-guard.js"],
          commands: [],
          skills: [],
          tools: ["tools/pipeline_commit.ts"]
        },
        docs: {
          plugins: [],
          commands: [],
          skills: [],
          tools: ["tools/doc_convert.ts"]
        }
      }
    })
  )
  for (const relative of ["plugins/pipeline-guard.js", "tools/pipeline_commit.ts", "tools/doc_convert.ts"]) {
    const fullPath = path.join(workspace, "src", relative)
    fs.mkdirSync(path.dirname(fullPath), { recursive: true })
    fs.writeFileSync(fullPath, "")
  }
  const agents = [fixture("copilot-pipeline-orchestrator.md")]

  const docsOutput = path.join(workspace, "docs-claude")
  const docs = bridgeToClaudeCode(agents, "pipeline", "copilot-pipeline-", docsOutput, workspace, undefined, { category: "docs" })
  const docsReadme = fs.readFileSync(path.join(docsOutput, "README.md"), "utf8")
  assert.match(docsReadme, /## OpenCode plugins and tools/)
  assert.match(docsReadme, /tools\/doc_convert\.ts/)
  assert.doesNotMatch(docsReadme, /pipeline-guard\.js/)
  assert.doesNotMatch(docsReadme, /pipeline_commit\.ts/)
  assert.ok(docs.warnings.some(warning => warning.includes("OpenCode tool 'tools/doc_convert.ts' is not transpiled")))
  assert.equal(docs.warnings.some(warning => warning.includes("pipeline-guard.js") || warning.includes("pipeline_commit.ts")), false)

  const pipelineOutput = path.join(workspace, "pipeline-claude")
  bridgeToClaudeCode(agents, "pipeline", "copilot-pipeline-", pipelineOutput, workspace, undefined, { category: "pipeline" })
  const pipelineReadme = fs.readFileSync(path.join(pipelineOutput, "README.md"), "utf8")
  assert.match(pipelineReadme, /plugins\/pipeline-guard\.js/)
})
