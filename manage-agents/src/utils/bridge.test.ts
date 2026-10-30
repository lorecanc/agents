import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { bridgeToClaudeCode, buildClaudeCodePlugin, normalizeClaudeAgentName, writeClaudeCodePlugin } from "./bridge.js"
import { DEFAULT_TRANSLATION_CONFIG, resolveMarketplaceName, resolveRole, type TranslationConfig } from "./translationConfig.js"
import { claudeNextSteps } from "./claudeNextSteps.js"
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
  // The icon copy must stay inside the gated .claude-plugin directory.
  fs.mkdirSync(path.join(workspace, "manage-agents", "assets"), { recursive: true })
  fs.writeFileSync(path.join(workspace, "manage-agents", "assets", "plugin-icon.png"), "icon")
  const plugin = buildClaudeCodePlugin([fixture("copilot-pipeline-orchestrator.md")], "decent-pipeline", "copilot-pipeline-")
  assert.throws(
    () => writeClaudeCodePlugin(plugin, path.join(workspace, "out"), workspace),
    /outside workspace/i
  )
  assert.equal(fs.readdirSync(outside).length, 0)
})

test("writeClaudeCodePlugin refuses a symlinked skills directory pointing outside the workspace", { skip: process.platform === "win32" }, () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "claude-skills-parent-ws-"))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "claude-skills-parent-out-"))
  const output = path.join(workspace, "claude")
  fs.mkdirSync(output, { recursive: true })
  fs.symlinkSync(outside, path.join(output, "skills"), "dir")
  fs.mkdirSync(path.join(workspace, "src", "commands"), { recursive: true })
  fs.writeFileSync(path.join(workspace, "src", "commands", "pipeline-bug.md"), "---\ndescription: Bug triage\n---\nFix the bug.\n")
  const plugin = buildClaudeCodePlugin([fixture("copilot-pipeline-orchestrator.md")], "decent-pipeline", "copilot-pipeline-")

  assert.throws(
    () => writeClaudeCodePlugin(plugin, output, workspace, "general", {
      companions: { plugins: [], tools: [], commands: ["commands/pipeline-bug.md"], skills: [] }
    }),
    /outside workspace/i
  )
  assert.deepEqual(fs.readdirSync(outside), [])
})

test("writeClaudeCodePlugin refuses a symlinked command skill leaf pointing outside the workspace", { skip: process.platform === "win32" }, () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "claude-skills-leaf-ws-"))
  const outsideFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "claude-skills-leaf-out-")), "keep.md")
  fs.writeFileSync(outsideFile, "outside\n")
  const output = path.join(workspace, "claude")
  fs.mkdirSync(path.join(output, "skills"), { recursive: true })
  fs.symlinkSync(outsideFile, path.join(output, "skills", "pipeline-bug"), "file")
  fs.mkdirSync(path.join(workspace, "src", "commands"), { recursive: true })
  fs.writeFileSync(path.join(workspace, "src", "commands", "pipeline-bug.md"), "---\ndescription: Bug triage\n---\nFix the bug.\n")
  const plugin = buildClaudeCodePlugin([fixture("copilot-pipeline-orchestrator.md")], "decent-pipeline", "copilot-pipeline-")

  assert.throws(
    () => writeClaudeCodePlugin(plugin, output, workspace, "general", {
      companions: { plugins: [], tools: [], commands: ["commands/pipeline-bug.md"], skills: [] }
    }),
    /outside workspace/i
  )
  assert.equal(fs.readFileSync(outsideFile, "utf8"), "outside\n")
})

test("refuses a symlinked companion command source that escapes the workspace", { skip: process.platform === "win32" }, () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "claude-companion-link-ws-"))
  const outsideFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "claude-companion-link-out-")), "passwd")
  fs.writeFileSync(outsideFile, "outside\n")
  fs.mkdirSync(path.join(workspace, ".agent-manager"), { recursive: true })
  fs.writeFileSync(path.join(workspace, ".agent-manager", "companion-links.json"), JSON.stringify({
    version: 1,
    categories: {
      pipeline: { plugins: [], commands: ["commands/pipeline-bug.md"], skills: [], tools: [] }
    }
  }))
  fs.mkdirSync(path.join(workspace, "src", "commands"), { recursive: true })
  fs.symlinkSync(outsideFile, path.join(workspace, "src", "commands", "pipeline-bug.md"), "file")
  const output = path.join(workspace, "claude")

  assert.throws(
    () => bridgeToClaudeCode(
      [fixture("copilot-pipeline-orchestrator.md")],
      "decent-pipeline",
      "copilot-pipeline-",
      output,
      workspace,
      undefined,
      { category: "pipeline" }
    ),
    /must not be a symlink/i
  )
  assert.equal(fs.existsSync(path.join(output, "skills", "pipeline-bug", "SKILL.md")), false, "no skill may be emitted from a symlinked source")
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
  assert.ok(
    result.warnings.some(warning => /disabled.*cupertino/i.test(warning)),
    `expected a disabled-server warning for 'cupertino', got ${JSON.stringify(result.warnings)}`
  )
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
    apply_patch: "allow",
    patch: "allow",
    multiedit: "allow",
    list: "allow",
    pipeline_env: "allow",
    pipeline_state: "allow",
    external_directory: { "*": "deny", "~/.local/*": "allow" },
    read_mcp_resource: "allow",
    doom_loop: "allow",
    read: "allow"
  }
  const output = path.join(workspace, "claude")

  const result = bridgeToClaudeCode([agent], "pipeline", "copilot-pipeline-", output, workspace)

  const generated = fs.readFileSync(path.join(output, "agents", "executor.md"), "utf8")
  const tools = generated.match(/^tools: (.*)$/m)?.[1] || ""
  for (const forbidden of [
    "mcp__apply__*", "mcp__plugin_pipeline_apply__*",
    "mcp__patch__*", "mcp__plugin_pipeline_patch__*",
    "mcp__multiedit__*", "mcp__plugin_pipeline_multiedit__*",
    "mcp__list__*", "mcp__plugin_pipeline_list__*",
    "mcp__pipeline__*", "mcp__plugin_pipeline_pipeline__*",
    "mcp__external__*", "mcp__plugin_pipeline_external__*",
    "mcp__read__*", "mcp__plugin_pipeline_read__*",
    "mcp__doom__*", "mcp__plugin_pipeline_doom__*"
  ]) {
    assert.equal(tools.includes(forbidden), false, `${forbidden} must not be emitted; got ${tools}`)
  }
  assert.ok(tools.split(", ").includes("Write"), `file-manipulation permissions should enable Write; got ${tools}`)
  assert.ok(tools.split(", ").includes("Edit"), `file-manipulation permissions should enable Edit; got ${tools}`)
  for (const key of ["pipeline_env", "pipeline_state", "external_directory", "doom_loop"]) {
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

test("writeClaudeCodePlugin prunes stale generated agents and skills with warnings", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "claude-stale-artifacts-"))
  const output = path.join(workspace, "claude")
  const staleAgent = path.join(output, "agents", "stale-agent.md")
  const staleSkill = path.join(output, "skills", "stale-skill", "SKILL.md")
  fs.mkdirSync(path.dirname(staleAgent), { recursive: true })
  fs.mkdirSync(path.dirname(staleSkill), { recursive: true })
  fs.writeFileSync(staleAgent, "stale agent\n")
  fs.writeFileSync(staleSkill, "stale skill\n")

  const result = bridgeToClaudeCode(
    [fixture("copilot-pipeline-orchestrator.md")],
    "decent-pipeline",
    "copilot-pipeline-",
    output,
    workspace
  )

  assert.equal(fs.existsSync(staleAgent), false, "stale generated agent must be pruned")
  assert.equal(fs.existsSync(staleSkill), false, "stale generated skill must be pruned")
  assert.ok(fs.existsSync(path.join(output, "agents", "orchestrator.md")), "fresh agent should still be written")
  assert.ok(
    result.warnings.includes("Pruned stale generated artifact 'agents/stale-agent.md'"),
    `missing stale agent warning, got ${JSON.stringify(result.warnings)}`
  )
  assert.ok(
    result.warnings.some(warning =>
      warning === "Pruned stale generated artifact 'skills/stale-skill/SKILL.md'"
      || warning === "Pruned stale generated artifact 'skills/stale-skill'"
    ),
    `missing stale skill warning, got ${JSON.stringify(result.warnings)}`
  )
})

test("warns when a disabled MCP server is emitted because agents require it", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "claude-disabled-mcp-required-"))
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true })
  fs.writeFileSync(path.join(workspace, "src", "opencode.json"), JSON.stringify({
    mcp: { XcodeBuildMCP: { command: ["xcodebuild-mcp", "serve"], enabled: false } }
  }))
  const agent = fixture("copilot-pipeline-swift_specialist.md")
  agent.frontmatter.permission["XcodeBuildMCP_*"] = "allow"
  const output = path.join(workspace, "claude")

  const result = bridgeToClaudeCode([agent], "decent-pipeline", "copilot-pipeline-", output, workspace)

  const mcp = JSON.parse(fs.readFileSync(path.join(output, ".mcp.json"), "utf8")).mcpServers
  assert.ok(mcp.XcodeBuildMCP, `disabled but required server must still be emitted, got ${JSON.stringify(mcp)}`)
  assert.ok(
    result.warnings.some(warning => /disabled.*XcodeBuildMCP/i.test(warning)),
    `expected a disabled-server warning, got ${JSON.stringify(result.warnings)}`
  )
})

test("emits a self-hosted marketplace.json", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "claude-marketplace-"))
  const output = path.join(workspace, "claude")
  bridgeToClaudeCode([fixture("copilot-pipeline-orchestrator.md")], "decent-pipeline", "copilot-pipeline-", output, workspace)

  const marketplacePath = path.join(output, ".claude-plugin", "marketplace.json")
  assert.ok(fs.existsSync(marketplacePath), "marketplace.json must be emitted")
  const marketplace = JSON.parse(fs.readFileSync(marketplacePath, "utf8"))
  assert.equal(marketplace.name, resolveMarketplaceName("decent-pipeline"))
  assert.equal(marketplace.name, "decent-pipeline-local")
  assert.equal(typeof marketplace.owner?.name, "string", "marketplace owner.name must be present")
  assert.ok(marketplace.owner.name.length > 0)
  assert.equal(marketplace.plugins.length, 1)
  assert.equal(marketplace.plugins[0].name, "decent-pipeline")
  assert.equal(marketplace.plugins[0].source, ".")

  const disabledOutput = path.join(workspace, "claude-no-marketplace")
  bridgeToClaudeCode(
    [fixture("copilot-pipeline-orchestrator.md")],
    "decent-pipeline",
    "copilot-pipeline-",
    disabledOutput,
    workspace,
    config({ claude: { overrides: {}, emitMarketplace: false } })
  )
  assert.equal(fs.existsSync(path.join(disabledOutput, ".claude-plugin", "marketplace.json")), false)
})

test("emits a non-empty marketplace description", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "claude-marketplace-description-"))
  const result = bridgeToClaudeCode([fixture("copilot-pipeline-orchestrator.md")], "decent-pipeline", "copilot-pipeline-", path.join(workspace, "claude"), workspace)

  const marketplace = JSON.parse(fs.readFileSync(path.join(result.pluginDir, ".claude-plugin", "marketplace.json"), "utf8"))
  assert.equal(typeof marketplace.description, "string")
  assert.ok(marketplace.description.trim().length > 0, "the marketplace description must not be empty")
})

test("copies the shared plugin icon into .claude-plugin when the workspace provides it", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "claude-plugin-icon-"))
  const plugin = buildClaudeCodePlugin([fixture("copilot-pipeline-orchestrator.md")], "decent-pipeline", "copilot-pipeline-")

  const withoutIcon = writeClaudeCodePlugin(plugin, path.join(workspace, "no-icon"), workspace)
  assert.equal(fs.existsSync(path.join(withoutIcon.pluginDir, ".claude-plugin", "icon.png")), false, "no icon is emitted without the source asset")

  const source = path.join(workspace, "manage-agents", "assets", "plugin-icon.png")
  fs.mkdirSync(path.dirname(source), { recursive: true })
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])
  fs.writeFileSync(source, bytes)
  const withIcon = writeClaudeCodePlugin(plugin, path.join(workspace, "with-icon"), workspace)
  assert.deepEqual(fs.readFileSync(path.join(withIcon.pluginDir, ".claude-plugin", "icon.png")), bytes)
})

test("reports the effective plugin and marketplace names written by the bridge", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "claude-effective-names-"))
  const output = path.join(workspace, "my_layer")
  const plugin = buildClaudeCodePlugin([fixture("copilot-pipeline-orchestrator.md")], "my_layer", "copilot-pipeline-")

  const result = writeClaudeCodePlugin(plugin, output, workspace)

  assert.equal(result.pluginName, "my-layer")
  assert.equal(result.marketplaceName, "my-layer-local")
  const pluginJson = JSON.parse(fs.readFileSync(path.join(result.pluginDir, ".claude-plugin", "plugin.json"), "utf8"))
  assert.equal(pluginJson.name, "my-layer")
  const marketplace = JSON.parse(fs.readFileSync(path.join(result.pluginDir, ".claude-plugin", "marketplace.json"), "utf8"))
  assert.equal(marketplace.name, "my-layer-local")
  assert.equal(marketplace.plugins[0].name, "my-layer")
  assert.ok(
    claudeNextSteps(result.pluginName, result.orchestratorName, result.pluginDir).some(line => line.includes("--agent my-layer:orchestrator")),
    "the next-steps hint must use the effective plugin name"
  )

  const noMarketplace = writeClaudeCodePlugin(plugin, path.join(workspace, "no-marketplace"), workspace, "general", { emitMarketplace: false })
  assert.equal(noMarketplace.marketplaceName, null)
})

test("refuses to emit a marketplace whose final name is reserved", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "claude-reserved-marketplace-"))
  const plugin = buildClaudeCodePlugin([fixture("copilot-pipeline-orchestrator.md")], "claude-layer", "copilot-pipeline-")

  assert.throws(
    () => writeClaudeCodePlugin(plugin, path.join(workspace, "claude"), workspace),
    /claude\.marketplaceName/
  )
  assert.equal(fs.existsSync(path.join(workspace, "claude", ".claude-plugin", "marketplace.json")), false)
})

test("prune refuses symlinked entries that escape the plugin directory", { skip: process.platform === "win32" }, () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "claude-prune-escape-ws-"))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "claude-prune-escape-out-"))
  fs.writeFileSync(path.join(outside, "keep.txt"), "outside\n")

  const output = path.join(workspace, "claude")
  fs.mkdirSync(path.join(output, "agents"), { recursive: true })
  fs.mkdirSync(path.join(output, "skills", "stale-skill"), { recursive: true })
  fs.writeFileSync(path.join(output, "agents", "notes.txt"), "not generated\n")
  fs.writeFileSync(path.join(output, "skills", "stale-skill", "SKILL.md"), "stale\n")
  fs.symlinkSync(outside, path.join(output, "agents", "escape.md"), "dir")

  const plugin = buildClaudeCodePlugin([fixture("copilot-pipeline-orchestrator.md")], "decent-pipeline", "copilot-pipeline-")

  assert.throws(
    () => writeClaudeCodePlugin(plugin, output, workspace),
    /outside workspace/i
  )
  assert.ok(fs.existsSync(path.join(outside, "keep.txt")), "the escaping target must not be deleted")
  assert.ok(fs.existsSync(path.join(output, "agents", "notes.txt")), "agents/ pruning must only touch .md entries")
})

test("translates pipeline commands into plugin skills", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "claude-command-skills-"))
  fs.mkdirSync(path.join(workspace, ".agent-manager"), { recursive: true })
  fs.writeFileSync(path.join(workspace, ".agent-manager", "companion-links.json"), JSON.stringify({
    version: 1,
    categories: {
      pipeline: { plugins: [], commands: ["commands/pipeline-bug.md"], skills: [], tools: [] }
    }
  }))
  fs.mkdirSync(path.join(workspace, "src", "commands"), { recursive: true })
  fs.writeFileSync(path.join(workspace, "src", "commands", "pipeline-bug.md"), [
    "---",
    "description: Triage and fix a pipeline bug",
    "agent: pipeline-orchestrator",
    "---",
    "Investigate $ARGUMENTS and start from !`git branch --show-current`.",
    ""
  ].join("\n"))
  const output = path.join(workspace, "claude")

  bridgeToClaudeCode(
    [fixture("copilot-pipeline-orchestrator.md")],
    "decent-pipeline",
    "copilot-pipeline-",
    output,
    workspace,
    undefined,
    { category: "pipeline" }
  )

  const skillPath = path.join(output, "skills", "pipeline-bug", "SKILL.md")
  assert.ok(fs.existsSync(skillPath), "pipeline command skill must be emitted")
  const content = fs.readFileSync(skillPath, "utf8")
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n/)
  assert.ok(frontmatterMatch, `skill must start with frontmatter, got ${content.slice(0, 120)}`)
  const frontmatter = frontmatterMatch![1]
  assert.match(frontmatter, /description:[^\n]*Triage and fix a pipeline bug/)
  assert.match(frontmatter, /disable-model-invocation:\s*true/)
  assert.match(frontmatter, /arguments:\s*request/)
  const body = content.slice(frontmatterMatch![0].length)
  assert.match(body, /\$request/)
  assert.doesNotMatch(body, /\$ARGUMENTS/)
  assert.doesNotMatch(body, /!`/)
  assert.match(body, /```bash[\s\S]*git branch --show-current[\s\S]*```/)
  assert.match(body, /decent-pipeline:orchestrator/)

  const disabledOutput = path.join(workspace, "claude-no-commands")
  bridgeToClaudeCode(
    [fixture("copilot-pipeline-orchestrator.md")],
    "decent-pipeline",
    "copilot-pipeline-",
    disabledOutput,
    workspace,
    config({ claude: { overrides: {}, emitCommands: false } }),
    { category: "pipeline" }
  )
  const skillsDir = path.join(disabledOutput, "skills")
  const names = fs.existsSync(skillsDir) ? fs.readdirSync(skillsDir) : []
  assert.equal(
    names.some(name => name.startsWith("pipeline-")),
    false,
    `no pipeline command skills expected, got ${JSON.stringify(names)}`
  )
})

test("preserves command descriptions containing a colon", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "claude-command-description-"))
  fs.mkdirSync(path.join(workspace, ".agent-manager"), { recursive: true })
  fs.writeFileSync(path.join(workspace, ".agent-manager", "companion-links.json"), JSON.stringify({
    version: 1,
    categories: {
      pipeline: { plugins: [], commands: ["commands/pipeline-bug.md"], skills: [], tools: [] }
    }
  }))
  fs.mkdirSync(path.join(workspace, "src", "commands"), { recursive: true })
  fs.writeFileSync(path.join(workspace, "src", "commands", "pipeline-bug.md"), [
    "---",
    "description: Pipeline: fix a bug with mandatory test-first (Red then Green)",
    "agent: pipeline-orchestrator",
    "---",
    "Fix $ARGUMENTS.",
    ""
  ].join("\n"))
  const output = path.join(workspace, "claude")

  bridgeToClaudeCode(
    [fixture("copilot-pipeline-orchestrator.md")],
    "decent-pipeline",
    "copilot-pipeline-",
    output,
    workspace,
    undefined,
    { category: "pipeline" }
  )

  const content = fs.readFileSync(path.join(output, "skills", "pipeline-bug", "SKILL.md"), "utf8")
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---\n/)?.[1] || ""
  assert.match(frontmatter, /Pipeline: fix a bug with mandatory test-first \(Red then Green\)/)
  assert.doesNotMatch(frontmatter, /Run the pipeline-bug pipeline command/)
})

test("scopes sibling pipeline command references to the plugin", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "claude-command-scope-"))
  fs.mkdirSync(path.join(workspace, ".agent-manager"), { recursive: true })
  fs.writeFileSync(path.join(workspace, ".agent-manager", "companion-links.json"), JSON.stringify({
    version: 1,
    categories: {
      pipeline: { plugins: [], commands: ["commands/pipeline-bug.md", "commands/pipeline-ops.md"], skills: [], tools: [] }
    }
  }))
  fs.mkdirSync(path.join(workspace, "src", "commands"), { recursive: true })
  fs.writeFileSync(path.join(workspace, "src", "commands", "pipeline-bug.md"), "---\ndescription: Bug\n---\nFix it.\n")
  fs.writeFileSync(path.join(workspace, "src", "commands", "pipeline-ops.md"), [
    "---",
    "description: Ops",
    "---",
    "If ops finds a code defect, propose the fix lane (`/pipeline-bug`).",
    ""
  ].join("\n"))
  const output = path.join(workspace, "claude")

  bridgeToClaudeCode(
    [fixture("copilot-pipeline-orchestrator.md")],
    "decent-pipeline",
    "copilot-pipeline-",
    output,
    workspace,
    undefined,
    { category: "pipeline" }
  )

  const content = fs.readFileSync(path.join(output, "skills", "pipeline-ops", "SKILL.md"), "utf8")
  assert.match(content, /`\/decent-pipeline:pipeline-bug`/)
  assert.doesNotMatch(content, /`\/pipeline-bug`/)
})

test("copies companion skills into the plugin", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "claude-companion-skills-"))
  fs.mkdirSync(path.join(workspace, ".agent-manager"), { recursive: true })
  fs.writeFileSync(path.join(workspace, ".agent-manager", "companion-links.json"), JSON.stringify({
    version: 1,
    categories: {
      pipeline: { plugins: [], commands: [], skills: ["skills/code-review-antipatterns"], tools: [] }
    }
  }))
  const sourceSkillDir = path.join(workspace, "src", "skills", "code-review-antipatterns")
  fs.mkdirSync(path.join(sourceSkillDir, "references"), { recursive: true })
  fs.writeFileSync(path.join(sourceSkillDir, "SKILL.md"), [
    "---",
    "name: code-review-antipatterns",
    "description: Catalog of code review anti-patterns",
    "---",
    "Use this skill during review.",
    ""
  ].join("\n"))
  fs.writeFileSync(path.join(sourceSkillDir, "references", "x.md"), "reference content\n")
  const output = path.join(workspace, "claude")

  bridgeToClaudeCode(
    [fixture("copilot-pipeline-orchestrator.md")],
    "decent-pipeline",
    "copilot-pipeline-",
    output,
    workspace,
    undefined,
    { category: "pipeline" }
  )

  const copiedSkill = path.join(output, "skills", "code-review-antipatterns", "SKILL.md")
  assert.ok(fs.existsSync(copiedSkill), "companion skill must be copied")
  const content = fs.readFileSync(copiedSkill, "utf8")
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n/)
  assert.ok(frontmatterMatch, `copied skill must keep frontmatter, got ${content.slice(0, 120)}`)
  const frontmatter = frontmatterMatch![1]
  assert.match(frontmatter, /description:[^\n]*Catalog of code review anti-patterns/)
  assert.doesNotMatch(frontmatter, /^name:/m, "the source name field must be dropped")
  const copiedReference = path.join(output, "skills", "code-review-antipatterns", "references", "x.md")
  assert.ok(fs.existsSync(copiedReference), "references must be copied along")
  assert.equal(fs.readFileSync(copiedReference, "utf8"), "reference content\n")

  const disabledOutput = path.join(workspace, "claude-no-skills")
  bridgeToClaudeCode(
    [fixture("copilot-pipeline-orchestrator.md")],
    "decent-pipeline",
    "copilot-pipeline-",
    disabledOutput,
    workspace,
    config({ claude: { overrides: {}, emitSkills: false } }),
    { category: "pipeline" }
  )
  assert.equal(fs.existsSync(path.join(disabledOutput, "skills", "code-review-antipatterns")), false)
})

test("warns but continues when a copied companion skill has malformed frontmatter", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "claude-companion-bad-frontmatter-"))
  fs.mkdirSync(path.join(workspace, ".agent-manager"), { recursive: true })
  fs.writeFileSync(path.join(workspace, ".agent-manager", "companion-links.json"), JSON.stringify({
    version: 1,
    categories: {
      pipeline: { plugins: [], commands: [], skills: ["skills/broken"], tools: [] }
    }
  }))
  const sourceSkillDir = path.join(workspace, "src", "skills", "broken")
  fs.mkdirSync(sourceSkillDir, { recursive: true })
  const malformed = "---\ndescription: [unterminated\n---\n\nBroken body.\n"
  fs.writeFileSync(path.join(sourceSkillDir, "SKILL.md"), malformed)
  const output = path.join(workspace, "claude")

  const result = bridgeToClaudeCode(
    [fixture("copilot-pipeline-orchestrator.md")],
    "decent-pipeline",
    "copilot-pipeline-",
    output,
    workspace,
    undefined,
    { category: "pipeline" }
  )

  assert.ok(result.warnings.some(warning => warning.includes("Malformed frontmatter in copied companion skill 'skills/broken/SKILL.md'")), `expected a malformed-frontmatter warning, got ${JSON.stringify(result.warnings)}`)
  assert.equal(fs.readFileSync(path.join(output, "skills", "broken", "SKILL.md"), "utf8"), malformed)
})

test("refuses a companion skill tree containing symlinks", { skip: process.platform === "win32" }, () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "claude-companion-tree-ws-"))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "claude-companion-tree-out-"))
  const outsideSkill = path.join(outside, "SKILL.md")
  const outsideReference = path.join(outside, "target.md")
  fs.writeFileSync(outsideSkill, "outside skill\n")
  fs.writeFileSync(outsideReference, "outside reference\n")
  fs.mkdirSync(path.join(workspace, ".agent-manager"), { recursive: true })
  fs.writeFileSync(path.join(workspace, ".agent-manager", "companion-links.json"), JSON.stringify({
    version: 1,
    categories: {
      pipeline: { plugins: [], commands: [], skills: ["skills/leaky"], tools: [] }
    }
  }))
  const sourceSkillDir = path.join(workspace, "src", "skills", "leaky")
  fs.mkdirSync(path.join(sourceSkillDir, "references"), { recursive: true })
  fs.symlinkSync(outsideSkill, path.join(sourceSkillDir, "SKILL.md"), "file")
  fs.symlinkSync(outsideReference, path.join(sourceSkillDir, "references", "link.md"), "file")
  const output = path.join(workspace, "claude")

  assert.throws(
    () => bridgeToClaudeCode(
      [fixture("copilot-pipeline-orchestrator.md")],
      "decent-pipeline",
      "copilot-pipeline-",
      output,
      workspace,
      undefined,
      { category: "pipeline" }
    ),
    /must not be a symlink/i
  )
  assert.equal(fs.readFileSync(outsideSkill, "utf8"), "outside skill\n", "the outside SKILL.md must not be overwritten")
  assert.equal(fs.readFileSync(outsideReference, "utf8"), "outside reference\n", "the outside reference must not be copied or overwritten")
  assert.equal(fs.existsSync(path.join(output, "skills", "leaky")), false, "no partial skill copy may be written")
})

// `isMcpPermissionKey` is internal to bridge.ts, so its classification is
// asserted through the generated agent's parsed `tools` frontmatter field.
test("opencode_session_rename stays a built-in permission key, not an MCP server", () => {
  const agent = fixture("copilot-pipeline-executor.md")
  agent.frontmatter.permission = {
    opencode_session_rename: "allow",
    "codebase-memory-mcp_delete_project": "allow",
    "chrome-devtools_click": "allow",
  }

  const tools = String(buildClaudeCodePlugin([agent], "pipeline", "copilot-pipeline-").agents[0].frontmatter.tools || "")

  assert.equal(tools.includes("mcp__opencode__*"), false, `a named built-in opencode_* key must not fabricate an MCP server; got ${tools}`)
  assert.ok(tools.split(", ").includes("mcp__codebase-memory-mcp__*"), `a real MCP server must stay; got ${tools}`)
  assert.ok(tools.split(", ").includes("mcp__chrome-devtools__*"), `a real MCP server must stay; got ${tools}`)
})

test("an MCP server named opencode is not swallowed by the built-in opencode_* names", () => {
  // `opencode_search` is the tool `search` of a server named `opencode`: the
  // explicit built-in list must not classify it as a built-in and drop it.
  const agent = fixture("copilot-pipeline-executor.md")
  agent.frontmatter.permission = { opencode_search: "allow" }

  const tools = String(buildClaudeCodePlugin([agent], "pipeline", "copilot-pipeline-").agents[0].frontmatter.tools || "")

  assert.ok(tools.split(", ").includes("mcp__opencode__*"), `an MCP tool key opencode_<tool> must stay an MCP server; got ${tools}`)
})

test("a V2-authored todowrite permission still emits TodoWrite", () => {
  const agent = fixture("copilot-pipeline-executor.md")
  delete agent.frontmatter.permission
  agent.frontmatter.permissions = [{ action: "todowrite", resource: "*", effect: "allow" }]

  const tools = String(buildClaudeCodePlugin([agent], "pipeline", "copilot-pipeline-").agents[0].frontmatter.tools || "")
  assert.ok(tools.split(", ").includes("TodoWrite"), `V2 todowrite must emit TodoWrite; got ${tools}`)
})

test("the Agent tool is emitted for subagent permissions, both V2 actions and the legacy subagent key", () => {
  const v2Agent = fixture("copilot-pipeline-executor.md")
  delete v2Agent.frontmatter.permission
  v2Agent.frontmatter.permissions = [{ action: "subagent", resource: "*", effect: "allow" }]
  const v2Tools = String(buildClaudeCodePlugin([v2Agent], "pipeline", "copilot-pipeline-").agents[0].frontmatter.tools || "")
  assert.ok(v2Tools.split(", ").includes("Agent"), `V2 subagent must emit Agent; got ${v2Tools}`)

  // A partially migrated frontmatter can still carry the V2 action name as a
  // plain permission key; it must not be ignored while only `task` is read.
  const legacyKey = fixture("copilot-pipeline-executor.md")
  legacyKey.frontmatter.permission = { subagent: "allow" }
  const legacyTools = String(buildClaudeCodePlugin([legacyKey], "pipeline", "copilot-pipeline-").agents[0].frontmatter.tools || "")
  assert.ok(legacyTools.split(", ").includes("Agent"), `perms.subagent must emit Agent; got ${legacyTools}`)
})

test("the legacy subagent key also drives the ask-to-allow warning", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "claude-subagent-ask-"))
  const agent = fixture("copilot-pipeline-executor.md")
  agent.frontmatter.permission = { subagent: { reviewer: "ask" } }
  agent.allowedSubagents = ["reviewer"]

  const result = bridgeToClaudeCode([agent], "pipeline", "copilot-pipeline-", path.join(workspace, "claude"), workspace)

  const generated = fs.readFileSync(path.join(result.pluginDir, "agents", "executor.md"), "utf8")
  assert.match(generated, /^tools: Agent\([^)]*reviewer\)/m, `subagent permissions must emit Agent(reviewer); got ${generated}`)
  assert.ok(
    result.warnings.some(warning => warning.includes("permission.task 'reviewer: ask' converted to 'allow'")),
    `missing ask-to-allow warning for the subagent key; got ${JSON.stringify(result.warnings)}`
  )
})

test("V1 permission spellings inside a V2 permissions array grant nothing (fail closed)", () => {
  const agent = fixture("copilot-pipeline-executor.md")
  delete agent.frontmatter.permission
  agent.frontmatter.permissions = [
    { action: "bash", resource: "*", effect: "allow" },
    { action: "write", resource: "*", effect: "allow" },
    { action: "task", resource: "*", effect: "allow" },
    { action: "execute", resource: "*", effect: "allow" },
    { action: "list", resource: "*", effect: "allow" },
  ]

  const tools = String(buildClaudeCodePlugin([agent], "pipeline", "copilot-pipeline-").agents[0].frontmatter.tools || "").split(", ")

  for (const forbidden of ["Bash", "Write", "Edit", "Agent"]) {
    assert.equal(tools.includes(forbidden), false, `${forbidden} must not be granted by a V1 spelling used as a V2 action; got ${tools.join(", ")}`)
  }
})

test("V2-only permission keys Claude cannot express are reported as dropped", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "claude-v2-only-keys-"))
  const agent = fixture("copilot-pipeline-executor.md")
  delete agent.frontmatter.permission
  agent.frontmatter.permissions = [
    { action: "artifact", resource: "*", effect: "allow" },
    { action: "file-diff", resource: "*", effect: "allow" },
    { action: "opencode_session_rename", resource: "*", effect: "allow" },
  ]

  const result = bridgeToClaudeCode([agent], "pipeline", "copilot-pipeline-", path.join(workspace, "claude"), workspace)

  for (const key of ["artifact", "file-diff", "opencode_session_rename"]) {
    assert.ok(
      result.warnings.some(warning => warning.includes(key) && /not representable|dropped/.test(warning)),
      `missing dropped-key warning for ${key}; got ${JSON.stringify(result.warnings)}`
    )
  }
})

test("dropped-key warnings are skipped for denied permissions", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "claude-dropped-deny-"))
  const denied = fixture("copilot-pipeline-executor.md")
  denied.frontmatter.permission = { artifact: "deny" }
  const allowed = fixture("copilot-pipeline-executor.md")
  allowed.frontmatter.permission = { artifact: "allow" }

  const deniedResult = bridgeToClaudeCode([denied], "pipeline", "copilot-pipeline-", path.join(workspace, "denied"), workspace)
  const allowedResult = bridgeToClaudeCode([allowed], "pipeline", "copilot-pipeline-", path.join(workspace, "allowed"), workspace)

  assert.equal(
    deniedResult.warnings.some(warning => warning.includes("'artifact'")),
    false,
    `a deny loses nothing and must not be reported as dropped; got ${JSON.stringify(deniedResult.warnings)}`
  )
  assert.ok(
    allowedResult.warnings.some(warning => warning.includes("'artifact'") && warning.includes("not representable")),
    `an allow must still be reported as dropped; got ${JSON.stringify(allowedResult.warnings)}`
  )
})
