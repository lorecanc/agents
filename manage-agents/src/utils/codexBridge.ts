import fs from "node:fs"
import path from "node:path"
import type { AgentInfo } from "./agents.js"
import { buildInferenceIndex, DEFAULT_TRANSLATION_CONFIG, resolveModelTarget, authorName } from "./translationConfig.js"
import type { TranslationConfig } from "./translationConfig.js"
import { assertInsideRealWorkspace, realpathThroughExistingAncestor } from "./pathValidation.js"

type ResolvedModelTarget = ReturnType<typeof resolveModelTarget>
type ResolvedTargets = Map<string, ResolvedModelTarget>

const markdownCode = (value: string) => {
  const normalized = value.replace(/\r\n?|\n/g, " ")
  const runs = [...normalized.matchAll(/`+/g)].map(match => match[0].length)
  const fence = "`".repeat(Math.max(1, ...(runs.length ? runs : [0]).map(length => length + 1)))
  return `${fence}${normalized}${fence}`
}

function resolveTargets(agents: AgentInfo[], config: TranslationConfig): ResolvedTargets {
  const inferenceIndex = buildInferenceIndex(agents, config)
  return new Map(agents.map(agent => [agent.filename, resolveModelTarget(agent, inferenceIndex, config, "codex")]))
}

/** A Codex model and its reasoning budget. */
export interface CodexModelTarget {
  model: string
  reasoningEffort?: string
}

export interface CodexBridgeConfig {
  /** Also emit skills that carry each translated developer prompt. */
  emitSkills?: boolean
  /** Translate enabled OpenCode MCP servers into the plugin's `.mcp.json`. */
  emitMcp?: boolean
  /** Emit a README describing the generated layer and unresolved links. */
  emitReadme?: boolean
}

export interface CodexAgent {
  name: string
  filename: string
  description: string
  model: string
  modelReasoningEffort?: string
  developerInstructions: string
  allowedSubagents: string[]
  sandboxMode: "read-only" | "workspace-write"
}

export interface CodexPlugin {
  pluginName: string
  agents: CodexAgent[]
  skills: string[]
  orchestratorName: string | null
}

export interface CodexBridgeResult {
  pluginDir: string
  files: string[]
  warnings: string[]
  plugin: CodexPlugin
  preview: Array<{ agent: string; role: string; tier: string; model: string; source: "override" | "role" | "inferred" | "default"; inferredFrom?: string }>
}

function normalizeName(value: string): string {
  const withoutExtension = value.replace(/\.md$/i, "")
  const normalized = withoutExtension
    .replace(/[_\s.]+/g, "-")
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()
  return normalized || "agent"
}

export function normalizeCodexAgentName(filename: string, prefix = ""): string {
  const stem = filename.replace(/\.md$/i, "")
  const stripped = prefix && stem.startsWith(prefix) ? stem.slice(prefix.length) : stem
  return normalizeName(stripped)
}

function pluginName(value: string): string {
  const normalized = normalizeName(value).slice(0, 64).replace(/-+$/g, "")
  return normalized || "translated-agents"
}

export function resolveCodexModel(agent: AgentInfo, agents: AgentInfo[] = [agent], config: TranslationConfig = DEFAULT_TRANSLATION_CONFIG): CodexModelTarget {
  return resolveModelTarget(agent, buildInferenceIndex(agents, config), config, "codex").model
}

function permissionAllows(value: unknown): boolean {
  if (value === true || value === "allow") return true
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  return Object.values(value as Record<string, unknown>).some(entry => entry === true || entry === "allow")
}

function resolveSandboxMode(agent: AgentInfo): "read-only" | "workspace-write" {
  const permissions = agent.frontmatter.permission || {}
  return permissionAllows(permissions.write) || permissionAllows(permissions.edit) ||
    permissionAllows(permissions.bash) || permissionAllows(permissions.execute)
    ? "workspace-write"
    : "read-only"
}

function stripPrefix(value: string, prefix: string): string {
  const stem = value.replace(/\.md$/i, "")
  return prefix && stem.startsWith(prefix) ? stem.slice(prefix.length) : stem
}

function sourceAliases(agent: AgentInfo, prefix: string): string[] {
  const filename = agent.filename.replace(/\.md$/i, "")
  const stripped = stripPrefix(filename, prefix)
  const aliases = [filename, stripped, normalizeName(filename), normalizeName(stripped)]
  return [...new Set(aliases.filter(Boolean))]
}

function buildAgentAliasMap(agents: AgentInfo[], prefix: string): Map<string, string> {
  const aliases = new Map<string, string>()
  for (const agent of agents) {
    const name = normalizeCodexAgentName(agent.filename, prefix)
    for (const alias of sourceAliases(agent, prefix)) {
      aliases.set(alias, name)
      aliases.set(alias.toLowerCase(), name)
    }
  }
  // Preserve the legacy spelling used by the Copilot orchestrator while
  // resolving it to the canonical docs-grounding agent in the generated layer.
  const docsGrounding = aliases.get(`${prefix}docs_grounding`) || aliases.get("docs_grounding")
  if (docsGrounding) {
    aliases.set(`${prefix}docs-orchestrator_grounding`, docsGrounding)
    aliases.set(`${prefix}docs-orchestrator_grounding`.toLowerCase(), docsGrounding)
  }
  return aliases
}

function rewriteReferences(
  body: string,
  aliases: Map<string, string>,
  sourceName: string,
  warnings: string[]
): string {
  return body.replace(/@([a-zA-Z0-9][a-zA-Z0-9_-]*)/g, (match, reference: string) => {
    const target = aliases.get(reference) || aliases.get(reference.toLowerCase())
    if (target) return `@${target}`
    // Ignore email addresses and ordinary handles that are not agent-like.
    if (reference.includes("-pipeline") || reference.includes("_")) {
      warnings.push(`${sourceName}: unresolved agent reference @${reference}`)
    }
    return match
  })
}

function translateAllowedSubagents(
  agent: AgentInfo,
  aliases: Map<string, string>,
  warnings: string[]
): string[] {
  const targets: string[] = []
  for (const source of agent.allowedSubagents || []) {
    const stripped = source.replace(/\.md$/i, "")
    const target = aliases.get(source) || aliases.get(stripped) || aliases.get(source.toLowerCase()) ||
      aliases.get(stripped.toLowerCase())
    if (!target) {
      warnings.push(`${agent.filename}: unresolved delegated agent '${source}'`)
      continue
    }
    if (!targets.includes(target)) targets.push(target)
  }
  return targets
}

function appendDelegationTargets(instructions: string, targets: string[]): string {
  if (targets.length === 0) return instructions
  const note = [
    "",
    "## Delegation targets",
    "",
    "Translated from the source pipeline. Use these Codex subagents when delegation is appropriate:",
    ...targets.map(target => `- @${target}`),
    ""
  ].join("\n")
  return `${instructions.trimEnd()}\n${note}`
}

export function convertCodexAgent(
  agent: AgentInfo,
  prefix: string,
  aliases: Map<string, string>,
  config: TranslationConfig,
  warnings: string[],
  agents: AgentInfo[] = [agent],
  resolvedTargets: ReadonlyMap<string, ResolvedModelTarget> = new Map()
): CodexAgent {
  const name = normalizeCodexAgentName(agent.filename, prefix)
  const target = (resolvedTargets.get(agent.filename) || resolveTargets([agent], config).get(agent.filename)!).model
  const delegated = translateAllowedSubagents(agent, aliases, warnings)
  const rewritten = rewriteReferences(agent.body.trim(), aliases, agent.filename, warnings)
  return {
    name,
    filename: `${name}.toml`,
    description: agent.description || `Translated agent ${name}`,
    model: target.model,
    modelReasoningEffort: target.reasoningEffort,
    developerInstructions: appendDelegationTargets(rewritten, delegated),
    allowedSubagents: delegated,
    sandboxMode: resolveSandboxMode(agent)
  }
}

/** Escape a value as a TOML basic string. JSON strings are valid TOML strings. */
function tomlString(value: string): string {
  return JSON.stringify(value)
}

export function renderCodexAgentToml(agent: CodexAgent): string {
  return [
    `name = ${tomlString(agent.name)}`,
    `description = ${tomlString(agent.description)}`,
    `developer_instructions = ${tomlString(agent.developerInstructions)}`,
    `model = ${tomlString(agent.model)}`,
    ...(agent.modelReasoningEffort ? [`model_reasoning_effort = ${tomlString(agent.modelReasoningEffort)}`] : []),
    `sandbox_mode = ${tomlString(agent.sandboxMode)}`,
    ""
  ].join("\n")
}

export function renderCodexSkill(agent: CodexAgent): string {
  return [
    "---",
    `name: ${agent.name}`,
    `description: ${JSON.stringify(agent.description)}`,
    "---",
    "",
    agent.developerInstructions.trim(),
    ""
  ].join("\n")
}

function buildPlugin(agents: CodexAgent[], name: string, emitSkills: boolean): CodexPlugin {
  const orchestrator = agents.find(agent => agent.name === "orchestrator") ||
    agents.find(agent => agent.name.includes("orchestrator"))
  return {
    pluginName: name,
    agents,
    skills: emitSkills ? agents.map(agent => agent.name) : [],
    orchestratorName: orchestrator?.name || null
  }
}

function renderManifest(plugin: CodexPlugin, emitSkills: boolean, emitMcp: boolean): string {
  const manifest: Record<string, unknown> = {
    name: plugin.pluginName,
    version: "1.0.0",
    description: "Translated Codex agents and skills generated from the source pipeline.",
    author: { name: authorName() },
    interface: {
      displayName: plugin.pluginName,
      shortDescription: "Translated pipeline skills and Codex agent configuration.",
      longDescription: "A generated translation layer that preserves the Copilot pipeline routing while applying the configured Sol/Luna model policy.",
      developerName: authorName(),
      category: "Developer Tools",
      capabilities: emitSkills ? ["Skills", "Subagents"] : ["Subagents"],
      defaultPrompt: ["Use the translated pipeline agents and skills for this task."]
    }
  }
  if (emitSkills) manifest.skills = "./skills/"
  if (emitMcp) manifest.mcpServers = "./.mcp.json"
  return `${JSON.stringify(manifest, null, 2)}\n`
}

function requiredMcpServers(agents: AgentInfo[]): Set<string> {
  const servers = new Set<string>()
  for (const agent of agents) {
    const permissions = agent.frontmatter.permission || {}
    for (const [key, value] of Object.entries(permissions)) {
      if (!key.includes("_") || [
        "read", "write", "edit", "execute", "bash",
        "question", "task", "grep", "glob", "lsp", "webfetch"
      ].includes(key)) continue
      if (value === true || value === "allow" || (typeof value === "object" && value !== null)) {
        servers.add(key.replace(/_.*$/, ""))
      }
    }
  }
  return servers
}

function buildCodexMcpConfig(workspaceRoot: string, requiredServers: Set<string> = new Set()): {
  config: Record<string, any> | null
  warnings: string[]
} {
  const sourcePath = path.join(workspaceRoot, "general", "opencode.json")
  if (!fs.existsSync(sourcePath)) return { config: null, warnings: [] }
  try {
    const source = JSON.parse(fs.readFileSync(sourcePath, "utf-8")) as Record<string, any>
    const servers: Record<string, any> = {}
    for (const [name, value] of Object.entries(source.mcp || {})) {
      if (!value || typeof value !== "object") continue
      const server = value as Record<string, any>
      if (server.enabled === false && !requiredServers.has(name)) continue
      const commandParts = Array.isArray(server.command)
        ? server.command.map(String)
        : typeof server.command === "string" ? server.command.trim().split(/\s+/) : []
      if (typeof server.url === "string") {
        servers[name] = { url: server.url }
        continue
      }
      if (commandParts.length === 0) continue
      const translated: Record<string, any> = {
        command: commandParts[0],
        ...(commandParts.length > 1 ? { args: commandParts.slice(1) } : {})
      }
      if (server.environment && typeof server.environment === "object") {
        translated.env = Object.fromEntries(Object.entries(server.environment).map(([key, envValue]) => {
          const text = String(envValue)
          const match = text.match(/^\{env:([^}]+)\}$/)
          return [key, match ? `\${${match[1]}}` : text]
        }))
      }
      servers[name] = translated
    }
    return Object.keys(servers).length > 0
      ? { config: { mcpServers: servers }, warnings: [] }
      : { config: null, warnings: [] }
  } catch (error: any) {
    return {
      config: null,
      warnings: [`Unable to translate MCP config '${sourcePath}': ${error?.message || String(error)}`]
    }
  }
}

function renderCodexMcpSetup(config: Record<string, any> | null): string[] {
  const servers = config?.mcpServers
  if (!servers || typeof servers !== "object") return []
  const lines = [
    "## MCP setup",
    "",
    "`npx` servers are fetched on first use. Binary servers must already be available on `PATH`.",
    ""
  ]
  for (const [name, value] of Object.entries(servers) as Array<[string, Record<string, any>]>) {
    const command = String(value.command || "")
    const args = Array.isArray(value.args) ? value.args.map(String) : []
    let setup = command === "npx"
      ? `runs as \`${[command, ...args].join(" ")}\` (Node.js, npm, and network required)`
      : `install \`${command}\` and verify with \`command -v ${command}\``
    if (name === "codebase-memory-mcp") {
      setup += "; see https://github.com/DeusData/codebase-memory-mcp#quick-start"
    } else if (name === "cupertino") {
      setup += "; see https://aleahim.com/blog/cupertino-09-release/"
    }
    const envKeys = value.env && typeof value.env === "object"
      ? Object.entries(value.env).map(([key, envValue]) => String(envValue).match(/^\$\{([^}]+)\}$/)?.[1] || key)
      : []
    if (envKeys.length > 0) setup += `; set ${envKeys.map(key => `\`${key}\``).join(", ")}`
    lines.push(`- \`${name}\`: ${setup}.`)
  }
  lines.push("", "Verify the resulting connections from Codex before invoking MCP-dependent agents.", "")
  return lines
}

function renderReadme(plugin: CodexPlugin, warnings: string[], mcpConfig: Record<string, any> | null, sourceDir: string): string {
  const lines = [
    `# ${plugin.pluginName}`,
    "",
    "This directory is a generated translation layer from the canonical source agents. Source agents are unchanged.",
    "",
    "> **Generated output.** Do not edit this directory directly. Change canonical agents or `agents/.agent-manager/translation-config.json`, then regenerate with the manager.",
    "",
    "## Source and configuration",
    "",
    `Agent prompts are discovered under ${markdownCode(`agents/${sourceDir}/`)}. Translation roles, tiers, model overrides, prefix, and output options come from ${markdownCode("agents/.agent-manager/translation-config.json")}; MCP declarations come from ${markdownCode("agents/general/opencode.json")}.`,
    "",
    "## Contents",
    "",
    "- `.codex-plugin/plugin.json` — Codex plugin manifest.",
    "- `.mcp.json` — enabled MCP servers plus servers explicitly required by translated agents.",
    "- `.codex/agents/` — project-scoped Codex subagent definitions.",
    plugin.skills.length > 0 ? "- `skills/` — plugin skills containing translated instructions." : "",
    "- `README.md` — this generated inventory and setup guide.",
    "",
    "Note: custom prompts in `~/.codex/prompts` are deprecated; prefer skills such as the ones generated here.",
    "",
    ...renderCodexMcpSetup(mcpConfig),
    `Primary agent: ${plugin.orchestratorName ? `@${plugin.orchestratorName}` : "(none detected)"}`,
    ""
  ]
  if (warnings.length > 0) {
    lines.push("## Translation warnings", "", ...warnings.map(warning => `- ${warning}`), "")
  }
  return lines.filter((line, index) => !(line === "" && lines[index - 1] === "")).join("\n")
}

/**
 * Write a Codex translation layer without modifying source agents.
 *
 * Output layout:
 *   <output>/.codex-plugin/plugin.json
 *   <output>/.codex/agents/*.toml
 *   <output>/skills/<agent>/SKILL.md (optional)
 */
export function writeCodexPlugin(
  agents: AgentInfo[],
  pluginName: string,
  prefix: string,
  outputDir: string,
  workspaceRoot: string,
  config: TranslationConfig = DEFAULT_TRANSLATION_CONFIG,
  resolvedTargets: ReadonlyMap<string, ResolvedModelTarget> = resolveTargets(agents, config)
): CodexBridgeResult {
  if (typeof workspaceRoot !== "string" || !workspaceRoot) {
    throw new Error("writeCodexPlugin requires a workspaceRoot")
  }
  const warnings: string[] = []
  const normalizedPluginName = pluginNameValue(pluginName)
  const aliases = buildAgentAliasMap(agents, prefix)
  const translatedAgents = agents.map(agent => convertCodexAgent(agent, prefix, aliases, config, warnings, agents, resolvedTargets))
  const emitSkills = config.codex.emitSkills !== false
  const mcpResult = buildCodexMcpConfig(workspaceRoot, requiredMcpServers(agents))
  const emitMcp = config.codex.emitMcp !== false && Boolean(mcpResult.config)
  warnings.push(...mcpResult.warnings)
  const plugin = buildPlugin(translatedAgents, normalizedPluginName, emitSkills)

  // Mirror writeClaudeCodePlugin: resolve symlinks through the nearest
  // existing ancestor so the containment check cannot be fooled by links.
  const pluginDir = realpathThroughExistingAncestor(path.resolve(outputDir))
  assertInsideRealWorkspace(workspaceRoot, pluginDir, outputDir)
  const codexAgentsDir = path.join(pluginDir, ".codex", "agents")
  const manifestDir = path.join(pluginDir, ".codex-plugin")
  fs.mkdirSync(pluginDir, { recursive: true })
  // Post-creation gate before creating .codex/agents, .codex-plugin, skills/*
  // or writing any files. Residual race: if a symlink target did not
  // pre-exist, empty dirs may be created there before this gate throws.
  assertInsideRealWorkspace(workspaceRoot, fs.realpathSync(pluginDir), outputDir)
  fs.mkdirSync(codexAgentsDir, { recursive: true })
  fs.mkdirSync(manifestDir, { recursive: true })
  assertInsideRealWorkspace(workspaceRoot, fs.realpathSync(codexAgentsDir), outputDir)
  assertInsideRealWorkspace(workspaceRoot, fs.realpathSync(manifestDir), outputDir)

  const files: string[] = []
  const manifestPath = path.join(manifestDir, "plugin.json")
  fs.writeFileSync(manifestPath, renderManifest(plugin, emitSkills, emitMcp))
  files.push(manifestPath)

  if (emitMcp && mcpResult.config) {
    const mcpPath = path.join(pluginDir, ".mcp.json")
    fs.writeFileSync(mcpPath, `${JSON.stringify(mcpResult.config, null, 2)}\n`)
    files.push(mcpPath)
  }

  for (const agent of translatedAgents) {
    const agentPath = path.join(codexAgentsDir, agent.filename)
    fs.writeFileSync(agentPath, renderCodexAgentToml(agent))
    files.push(agentPath)
  }

  if (emitSkills) {
    const skillsDir = path.join(pluginDir, "skills")
    for (const agent of translatedAgents) {
      const skillDir = path.join(skillsDir, agent.name)
      fs.mkdirSync(skillDir, { recursive: true })
      assertInsideRealWorkspace(workspaceRoot, fs.realpathSync(skillDir), outputDir)
      const skillPath = path.join(skillDir, "SKILL.md")
      fs.writeFileSync(skillPath, renderCodexSkill(agent))
      files.push(skillPath)
    }
  }

  if (config.codex.emitReadme !== false) {
    const readmePath = path.join(pluginDir, "README.md")
    fs.writeFileSync(readmePath, renderReadme(plugin, warnings, mcpResult.config, config.sourceDir))
    files.push(readmePath)
  }

  return {
    pluginDir, files, warnings, plugin,
    preview: agents.map(agent => {
      const resolved = resolvedTargets.get(agent.filename)!
      if (resolved.source === "inferred" || resolved.source === "default") warnings.push(`[${agent.filename}] model assignment source: ${resolved.source}`)
      return { agent: agent.filename, role: resolved.role, tier: resolved.tier, model: resolved.model.model, source: resolved.source, ...(resolved.inferredFrom ? { inferredFrom: resolved.inferredFrom } : {}) }
    })
  }
}

// Kept separate to make it easy for the configuration wizard to validate a
// name before any filesystem operation occurs.
export function pluginNameValue(value: string): string {
  return pluginName(value)
}

export function bridgeToCodex(
  agents: AgentInfo[],
  pluginNameInput: string,
  prefix: string,
  outputDir: string,
  workspaceRoot: string,
  config: TranslationConfig = DEFAULT_TRANSLATION_CONFIG
): CodexBridgeResult {
  return writeCodexPlugin(agents, pluginNameInput, prefix, outputDir, workspaceRoot, config)
}
