import fs from "node:fs"
import path from "node:path"
import YAML from "yaml"
import { escapeRegExp, normalizeAgentBody } from "./agents.js"
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

function resolveTargets(agents: AgentInfo[], config: TranslationConfig, target: "claude" | "codex"): ResolvedTargets {
  const inferenceIndex = buildInferenceIndex(agents, config)
  return new Map(agents.map(agent => [agent.filename, resolveModelTarget(agent, inferenceIndex, config, target)]))
}

// --- Types ---

export interface ClaudeCodeAgent {
  name: string
  filename: string
  frontmatter: Record<string, any>
  body: string
  /** Translation diagnostics associated with this generated agent. */
  warnings?: string[]
}

export interface ClaudeCodePlugin {
  pluginName: string
  agents: ClaudeCodeAgent[]
  orchestratorName: string | null
  /** MCP servers required by each generated agent. */
  mcpRequirements: Record<string, string[]>
  /** Warnings found while resolving the generated agent graph. */
  warnings?: string[]
}

export interface BridgeResult {
  pluginDir: string
  files: string[]
  warnings: string[]
  preview?: AgentTranslationPreview[]
}

export interface AgentTranslationPreview {
  agent: string
  role: string
  tier: string
  model: string
  source: "override" | "role" | "inferred" | "default"
  inferredFrom?: string
}

/**
 * Claude Code agent names are lowercase, hyphen-delimited identifiers. Keep
 * the name deterministic so source references can be translated without
 * touching the source agent files.
 */
export function normalizeClaudeAgentName(rawName: string): string {
  let name = rawName
    .replace(/\.md$/i, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[_\s]+/g, "-")
    .replace(/[^a-zA-Z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()

  if (!name) name = "agent"
  // Avoid a leading digit: this keeps the identifier valid for the strict
  // Claude plugin validator across CLI versions.
  if (/^[0-9]/.test(name)) name = `agent-${name}`
  return name.slice(0, 64).replace(/-+$/, "") || "agent"
}

function normalizeAndValidateClaudePluginName(pluginName: string): string {
  if (!pluginName.trim() || !/[a-z0-9]/i.test(pluginName)) {
    throw new Error(`Invalid Claude plugin name '${pluginName}': it must contain at least one letter or number.`)
  }
  return normalizeClaudeAgentName(pluginName)
}

/**
 * Strip the pipeline prefix from an agent filename.
 * e.g. "copilot-pipeline-explorer.md" with prefix "copilot-pipeline-" → "explorer.md"
 */
function stripPrefix(filename: string, prefix: string): string {
  if (prefix && filename.startsWith(prefix)) {
    return filename.slice(prefix.length)
  }
  return filename
}

type AgentNameMap = Map<string, string>

function baseAgentName(filename: string, prefix: string): string {
  return stripPrefix(path.basename(filename), prefix).replace(/\.md$/i, "")
}

function addNameAlias(nameMap: AgentNameMap, alias: string, canonical: string) {
  const key = alias.trim().toLowerCase()
  if (key) nameMap.set(key, canonical)
}

/** Build aliases for both source names and the names Claude will expose. */
function buildAgentNameMap(agents: AgentInfo[], prefix: string): {
  names: AgentNameMap
  canonicalNames: Set<string>
  warnings: string[]
} {
  const names: AgentNameMap = new Map()
  const canonicalNames = new Set<string>()
  const warnings: string[] = []

  for (const agent of agents) {
    const full = path.basename(agent.filename).replace(/\.md$/i, "")
    const stripped = baseAgentName(agent.filename, prefix)
    const baseCanonical = normalizeClaudeAgentName(stripped)
    let canonical = baseCanonical
    let collisionIndex = 2
    while (canonicalNames.has(canonical)) {
      const suffix = `-${collisionIndex++}`
      canonical = `${baseCanonical.slice(0, 64 - suffix.length)}${suffix}`
    }
    if (canonical !== baseCanonical) {
      warnings.push(`Agent name collision after Claude normalization: '${stripped}' -> '${baseCanonical}'; assigned '${canonical}'`)
    }
    canonicalNames.add(canonical)

    // Preserve all practical spellings used in permission.task and bodies.
    for (const alias of [full, stripped, full.replace(/_/g, "-"), stripped.replace(/_/g, "-"), canonical]) {
      addNameAlias(names, alias, canonical)
    }
    if (prefix && full.startsWith(prefix)) {
      addNameAlias(names, `${prefix}${stripped}`, canonical)
    }
  }

  return { names, canonicalNames, warnings }
}

function resolveAgentAlias(rawName: string, prefix: string, names: AgentNameMap): string | null {
  const value = rawName.replace(/^@/, "").replace(/\.md$/i, "")
  const candidates = [
    value,
    value.replace(/_/g, "-"),
    stripPrefix(value, prefix),
    stripPrefix(value, prefix).replace(/_/g, "-")
  ]
  for (const candidate of candidates) {
    const resolved = names.get(candidate.toLowerCase())
    if (resolved) return resolved
  }

  // A few legacy pipeline prompts used role words in the middle of an agent
  // name (for example `docs-orchestrator_grounding` while the file is
  // `docs_grounding`). Treat those as compatibility aliases, but only when
  // the resulting name maps to exactly one generated agent.
  const compatibility = normalizeClaudeAgentName(stripPrefix(value, prefix))
    .replace(/(^|-)orchestrator(?=-|$)/g, "$1")
    .replace(/(^|-)agent(?=-|$)/g, "$1")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
  const compatibilityResolved = names.get(compatibility)
  if (compatibilityResolved) return compatibilityResolved
  return null
}

/**
 * Build the `tools:` string for a Claude Code agent from OpenCode permissions.
 */
function buildToolsString(
  frontmatter: Record<string, any>,
  allowedSubagents: string[],
  prefix: string,
  names?: AgentNameMap,
  warnings?: string[],
  pluginName?: string,
  requiredMcpServers: string[] = []
): string {
  const tools: string[] = []
  const perms = frontmatter.permission || {}

  // Agent tool (subagent delegation)
  const taskPerm = perms.task
  if (taskPerm === "allow" || taskPerm === true) {
    // Open delegation — no whitelist
    tools.push("Agent")
  } else if (taskPerm && typeof taskPerm === "object" && !Array.isArray(taskPerm)) {
    // Structured dict — build whitelist from allowed subagents
    const allowed = allowedSubagents
      .map(name => {
        const resolved = names && resolveAgentAlias(name, prefix, names)
        if (!resolved && warnings) {
          warnings.push(`Unresolved delegated subagent '${name}'`)
        }
        return resolved || normalizeClaudeAgentName(stripPrefix(name, prefix))
      })
      .filter((name, index, all) => name && all.indexOf(name) === index)
    if (allowed.length > 0) {
      const scopedAllowed = pluginName
        ? allowed.map(name => `${pluginName}:${name}`)
        : allowed
      tools.push(`Agent(${scopedAllowed.join(", ")})`)
    }
  }

  // Read tools
  if (perms.read !== "deny" && perms.read !== false) {
    tools.push("Read")
  }
  if (perms.grep !== "deny" && perms.grep !== false) {
    tools.push("Grep")
  }
  if (perms.glob !== "deny" && perms.glob !== false) {
    tools.push("Glob")
  }

  // Write/Edit tools
  if (perms.edit === "allow" || perms.edit === true ||
      (typeof perms.edit === "object" && perms.edit["*"] === "allow")) {
    tools.push("Write", "Edit")
  }

  // Bash tool
  const bashPerm = perms.bash
  if (bashPerm === "allow" || bashPerm === true) {
    tools.push("Bash")
  } else if (typeof bashPerm === "object" && bashPerm["*"] !== "deny") {
    // Has some bash allowed
    tools.push("Bash")
  } else if (typeof bashPerm === "object") {
    // Has granular patterns — some commands are allowed even if * is deny
    const hasAllowed = Object.entries(bashPerm).some(([k, v]) => k !== "*" && (v === "allow" || v === true))
    if (hasAllowed) {
      tools.push("Bash")
    }
  }

  // WebFetch tool
  if (perms.webfetch === "allow" || perms.webfetch === true) {
    tools.push("WebFetch")
  }

  // OpenCode names MCP permissions as `<server>_*`. Claude exposes bundled
  // plugin servers through scoped `mcp__plugin_<plugin>_<server>__*` names;
  // keep the bare form as a compatibility fallback for user-scoped servers.
  const permissionServers = Object.keys(perms)
    .filter(key => key.includes("_") && ![
      "read", "write", "edit", "execute", "bash",
      "question", "task", "grep", "glob", "lsp", "webfetch"
    ].includes(key) && (perms[key] === "allow" || perms[key] === true ||
      (typeof perms[key] === "object" && perms[key] !== null)))
    .map(key => key.replace(/_.*$/, ""))
    .filter((server, index, all) => server && all.indexOf(server) === index)
  const mcpServers = [...new Set([...permissionServers, ...requiredMcpServers])]
  for (const server of mcpServers) {
    tools.push(`mcp__${server}__*`)
    if (pluginName) tools.push(`mcp__plugin_${pluginName}_${server}__*`)
  }

  return tools.join(", ")
}

/**
 * Collect warnings about features that don't map cleanly to Claude Code.
 */
function collectWarnings(frontmatter: Record<string, any>, enabledMcpServers?: Set<string>): string[] {
  const warnings: string[] = []
  const perms = frontmatter.permission || {}

  if (enabledMcpServers) {
    for (const key of Object.keys(perms)) {
      if (!key.includes("_") || [
        "read", "write", "edit", "execute", "bash",
        "question", "task", "grep", "glob", "lsp", "webfetch"
      ].includes(key)) continue
      const server = key.replace(/_.*$/, "")
      if (!enabledMcpServers.has(server)) {
        warnings.push(`MCP server '${server}' is not enabled in the generated Claude .mcp.json`)
      }
    }
  }

  // Hidden flag
  if (frontmatter.hidden === true) {
    warnings.push(`'hidden: true' has no Claude Code equivalent — ignored`)
  }

  if (frontmatter.temperature !== undefined) {
    warnings.push(`'temperature' has no Claude Code plugin-agent equivalent — ignored`)
  }

  // Ask-state task permissions
  if (typeof perms.task === "object") {
    for (const [name, value] of Object.entries(perms.task)) {
      if (value === "ask") {
        warnings.push(`permission.task '${name}: ask' converted to 'allow' (no Claude Code equivalent)`)
      }
    }
  }

  return warnings
}

/**
 * Replace source agent references with Claude's plugin-scoped agent names.
 */
function rewriteBodyReferences(
  body: string,
  prefix: string,
  names?: AgentNameMap,
  warnings?: string[],
  pluginName?: string
): string {
  if (!names) {
    if (!prefix) return body
    const regex = new RegExp(`@${escapeRegExp(prefix)}([a-z0-9_-]+)`, "gi")
    return body.replace(regex, (_, name) => `@${normalizeClaudeAgentName(name)}`)
  }

  const unresolved = new Set<string>()
  const regex = /@([A-Za-z0-9][A-Za-z0-9_-]*)(?::[A-Za-z0-9][A-Za-z0-9_-]*)?/g
  const rewritten = body.replace(regex, (whole, token: string) => {
    // Scoped references are already canonical and must remain idempotent.
    if (whole.includes(":")) return whole
    const resolved = resolveAgentAlias(token, prefix, names)
    if (resolved) return `@${pluginName ? `${pluginName}:` : ""}${resolved}`

    // Only report references that look like source agent identifiers. This
    // avoids treating ordinary @mentions/email addresses as broken wiring.
    const looksLikeAgentReference = Boolean(prefix && token.toLowerCase().startsWith(prefix.toLowerCase()))
    if (looksLikeAgentReference) unresolved.add(token)
    return whole
  })
  if (warnings) {
    for (const token of unresolved) warnings.push(`Unresolved agent reference '@${token}'`)
  }
  return rewritten
}

/**
 * Append MCP notes to the body if there are MCP tool permissions.
 */
function permissionMcpServers(frontmatter: Record<string, any>): string[] {
  const perms = frontmatter.permission || {}
  const servers: string[] = []

  for (const [key, value] of Object.entries(perms)) {
    if (key.includes("_") && ![
      "read", "write", "edit", "execute", "bash",
      "question", "task", "grep", "glob", "lsp", "webfetch"
    ].includes(key) && (value === "allow" || value === true)) {
      servers.push(key.replace(/_.*$/, ""))
    }
  }

  return [...new Set(servers)]
}

function requiredMcpServersForAgent(agent: AgentInfo, knownMcpServers: Set<string>): string[] {
  const required = new Set(permissionMcpServers(agent.frontmatter))
  const searchable = `${agent.description}\n${agent.body}`.toLowerCase()
  for (const server of knownMcpServers) {
    // Only infer dependencies whose canonical name explicitly identifies an
    // MCP server. Other names such as "magic" or "cupertino" commonly occur
    // in prose or delegated-agent descriptions and must be permission-driven.
    const normalizedServer = server.toLowerCase()
    const aliases = [
      normalizedServer,
      normalizedServer.replace(/-?mcp$/, ""),
      normalizedServer.replace(/^mcp-?/, "")
    ].filter(alias => alias.length >= 4)
    if (normalizedServer.includes("mcp") && aliases.some(alias => searchable.includes(alias))) {
      required.add(server)
    }
  }
  return [...required]
}

function appendMcpNotes(body: string, mcpServers: string[]): string {
  const mcpTools = mcpServers.map(server => `${server}/*`)

  if (mcpTools.length === 0) return body

  const note = `\n\n## MCP Tools (from OpenCode bridge)\n\nThis agent requires the following MCP servers:\n${mcpTools.map(t => `- \`${t}\``).join("\n")}\n`
  return body + note
}

/**
 * Translate the repository's OpenCode MCP declaration into Claude's plugin
 * `.mcp.json` shape. This is deliberately a generated artifact: the source
 * `general/opencode.json` remains untouched.
 */
function buildClaudeMcpConfig(workspaceRoot: string, requiredServers: Set<string> = new Set()): {
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
      if (commandParts.length === 0 && typeof server.url !== "string") continue

      if (typeof server.url === "string") {
        servers[name] = { url: server.url }
        continue
      }

      const translated: Record<string, any> = {
        command: commandParts[0],
        ...(commandParts.length > 1 ? { args: commandParts.slice(1) } : {})
      }
      if (server.environment && typeof server.environment === "object") {
        translated.env = Object.fromEntries(
          Object.entries(server.environment).map(([key, envValue]) => {
            const text = String(envValue)
            const match = text.match(/^\{env:([^}]+)\}$/)
            return [key, match ? `\${${match[1]}}` : text]
          })
        )
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

/** Translate OpenCode LSP declarations to Claude's `.lsp.json` schema. */
function buildClaudeLspConfig(workspaceRoot: string): {
  config: Record<string, any> | null
  warnings: string[]
} {
  const sourcePath = path.join(workspaceRoot, "general", "opencode.json")
  if (!fs.existsSync(sourcePath)) return { config: null, warnings: [] }

  try {
    const source = JSON.parse(fs.readFileSync(sourcePath, "utf-8")) as Record<string, any>
    const servers: Record<string, any> = {}
    for (const [name, value] of Object.entries(source.lsp || {})) {
      if (!value || typeof value !== "object") continue
      const server = value as Record<string, any>
      const commandParts = Array.isArray(server.command)
        ? server.command.map(String)
        : typeof server.command === "string" ? server.command.trim().split(/\s+/) : []
      if (commandParts.length === 0) continue
      const extensions = Array.isArray(server.extensions) ? server.extensions.map(String) : []
      if (extensions.length === 0) continue
      servers[name] = {
        command: commandParts[0],
        ...(commandParts.length > 1 ? { args: commandParts.slice(1) } : {}),
        extensionToLanguage: Object.fromEntries(extensions.map(extension => [extension, name]))
      }
    }
    return Object.keys(servers).length > 0
      ? { config: servers, warnings: [] }
      : { config: null, warnings: [] }
  } catch (error: any) {
    return {
      config: null,
      warnings: [`Unable to translate LSP config '${sourcePath}': ${error?.message || String(error)}`]
    }
  }
}

const MCP_INSTALL_GUIDES: Record<string, string> = {
  "codebase-memory-mcp": "https://github.com/DeusData/codebase-memory-mcp#quick-start",
  cupertino: "https://aleahim.com/blog/cupertino-09-release/"
}

function renderMcpSetup(
  config: Record<string, any> | null,
  requirements: Record<string, string[]>
): string[] {
  const servers = config?.mcpServers
  if (!servers || typeof servers !== "object") return []

  const lines = [
    "## MCP setup",
    "",
    "These servers are declared by the generated plugin. `npx` entries are fetched on first use; binary entries must already be available on `PATH`.",
    "",
    "| Server | Required by | Setup |",
    "|---|---|---|"
  ]

  for (const [name, value] of Object.entries(servers) as Array<[string, Record<string, any>]>) {
    const requiredBy = requirements[name]?.map(agent => `\`${agent}\``).join(", ") || "plugin runtime"
    const command = String(value.command || "")
    const args = Array.isArray(value.args) ? value.args.map(String) : []
    let setup = command === "npx"
      ? `Automatic via \`${[command, ...args].join(" ")}\`; requires Node.js, npm, and network access.`
      : `Install \`${command}\` and verify it with \`command -v ${command}\`.`
    if (MCP_INSTALL_GUIDES[name]) setup += ` [Installation guide](${MCP_INSTALL_GUIDES[name]}).`
    const envKeys = value.env && typeof value.env === "object"
      ? Object.entries(value.env).map(([key, envValue]) => {
          const match = String(envValue).match(/^\$\{([^}]+)\}$/)
          return match ? match[1] : key
        })
      : []
    if (envKeys.length > 0) setup += ` Required environment: ${envKeys.map(key => `\`${key}\``).join(", ")}.`
    lines.push(`| \`${name}\` | ${requiredBy} | ${setup} |`)
  }

  lines.push("", "After setup, launch Claude Code and use `/mcp` to verify that every required server is connected.", "")
  return lines
}

/**
 * Convert a single OpenCode AgentInfo to a Claude Code agent.
 */
export function convertAgent(
  agent: AgentInfo,
  prefix: string,
  config: TranslationConfig = DEFAULT_TRANSLATION_CONFIG,
  names?: AgentNameMap,
  pluginName?: string,
  knownMcpServers: Set<string> = new Set(),
  agents: AgentInfo[] = [agent],
  resolvedTargets: ReadonlyMap<string, ResolvedModelTarget> = new Map()
): ClaudeCodeAgent {
  const strippedFilename = stripPrefix(agent.filename, prefix)
  const name = names?.get(strippedFilename.replace(/\.md$/i, "").toLowerCase())
    || normalizeClaudeAgentName(strippedFilename)
  const warnings: string[] = []

  const newFm: Record<string, any> = {}

  // name
  newFm.name = name

  // description
  if (agent.description) {
    newFm.description = agent.description
  }

  // model
  const resolved = resolvedTargets.get(agent.filename) || resolveTargets([agent], config, "claude").get(agent.filename)!
  newFm.model = resolved.model.model

  // maxTurns (from max_steps)
  if (agent.frontmatter.max_steps !== undefined) {
    newFm.maxTurns = agent.frontmatter.max_steps
  } else if (agent.frontmatter.maxTurns !== undefined) {
    newFm.maxTurns = agent.frontmatter.maxTurns
  }

  // tools
  const requiredMcpServers = requiredMcpServersForAgent(agent, knownMcpServers)
  const toolsStr = buildToolsString(
    agent.frontmatter,
    agent.allowedSubagents,
    prefix,
    names,
    warnings,
    pluginName,
    requiredMcpServers
  )
  if (toolsStr) {
    newFm.tools = toolsStr
  }

  // Claude Code plugin-shipped agents do not support OpenCode's
  // `permissionMode` frontmatter field. Permission differences are
  // represented by the generated `tools` allowlist instead of emitting an
  // invalid plugin field.

  // Rewrite body references
  let body = rewriteBodyReferences(agent.body, prefix, names, warnings, pluginName)

  // Append MCP notes if needed
  body = appendMcpNotes(body, requiredMcpServers)

  return {
    name,
    filename: `${name}.md`,
    frontmatter: newFm,
    body,
    warnings: warnings.length > 0 ? warnings : undefined
  }
}

/**
 * Build a complete Claude Code plugin from a list of OpenCode agents.
 */
export function buildClaudeCodePlugin(
  agents: AgentInfo[],
  pluginName: string,
  prefix: string,
  config: TranslationConfig = DEFAULT_TRANSLATION_CONFIG,
  knownMcpServers: Set<string> = new Set(),
  resolvedTargets: ReadonlyMap<string, ResolvedModelTarget> = resolveTargets(agents, config, "claude")
): ClaudeCodePlugin {
  const safePluginName = normalizeAndValidateClaudePluginName(pluginName)
  const { names, warnings } = buildAgentNameMap(agents, prefix)
  const converted = agents.map(a => convertAgent(a, prefix, config, names, safePluginName, knownMcpServers, agents, resolvedTargets))
  for (const agent of converted) {
    if (agent.warnings) {
      warnings.push(...agent.warnings.map(w => `[${agent.name}] ${w}`))
    }
  }
  const orchestrator = agents.find(a => a.frontmatter.mode === "primary")
  const mcpRequirements: Record<string, string[]> = {}
  for (const agent of agents) {
    const generatedName = names.get(baseAgentName(agent.filename, prefix).toLowerCase())
      || normalizeClaudeAgentName(baseAgentName(agent.filename, prefix))
    for (const server of requiredMcpServersForAgent(agent, knownMcpServers)) {
      if (!mcpRequirements[server]) mcpRequirements[server] = []
      mcpRequirements[server].push(generatedName)
    }
  }

  return {
    pluginName: safePluginName,
    agents: converted,
    orchestratorName: orchestrator
      ? names.get(baseAgentName(orchestrator.filename, prefix).toLowerCase())
        || normalizeClaudeAgentName(baseAgentName(orchestrator.filename, prefix))
      : null,
    mcpRequirements,
    warnings: warnings.length > 0 ? [...new Set(warnings)] : undefined
  }
}

/**
 * Write a Claude Code plugin to disk.
 */
export function writeClaudeCodePlugin(
  plugin: ClaudeCodePlugin,
  outputDir: string,
  workspaceRoot: string,
  sourceDir = "general"
): BridgeResult {
  // Resolve symlinks through the nearest existing ancestor so the containment
  // check cannot be fooled by links planted where the output dir will live.
  const resolvedOutputDir = realpathThroughExistingAncestor(path.resolve(outputDir))
  assertInsideRealWorkspace(workspaceRoot, resolvedOutputDir, outputDir)
  const relativeOutputDir = path.relative(fs.realpathSync(workspaceRoot), resolvedOutputDir)
  const relativePluginPath = relativeOutputDir
    ? `./${relativeOutputDir.split(path.sep).join("/")}`
    : "."

  const files: string[] = []
  const allWarnings: string[] = plugin.warnings ? [...plugin.warnings] : []

  // Create directory structure
  const agentsDir = path.join(resolvedOutputDir, "agents")
  const pluginMetaDir = path.join(resolvedOutputDir, ".claude-plugin")
  fs.mkdirSync(agentsDir, { recursive: true })
  fs.mkdirSync(pluginMetaDir, { recursive: true })
  // Post-creation gate: re-check real paths now that the directories exist.
  // Residual race: if a symlink target did not pre-exist, empty dirs may be
  // created there before this gate throws.
  assertInsideRealWorkspace(workspaceRoot, fs.realpathSync(resolvedOutputDir), outputDir)
  assertInsideRealWorkspace(workspaceRoot, fs.realpathSync(agentsDir), outputDir)
  assertInsideRealWorkspace(workspaceRoot, fs.realpathSync(pluginMetaDir), outputDir)

  // Write plugin.json
  const pluginJson = {
    name: plugin.pluginName,
    version: "1.0.0",
    description: `Pipeline agents bridged from OpenCode (${plugin.pluginName})`,
    author: {
      name: authorName()
    }
  }
  const pluginJsonPath = path.join(pluginMetaDir, "plugin.json")
  fs.writeFileSync(pluginJsonPath, JSON.stringify(pluginJson, null, 2), "utf-8")
  files.push(".claude-plugin/plugin.json")

  // MCP servers are plugin-root configuration in Claude Code. Keep this
  // alongside the generated agents so their MCP notes resolve at runtime.
  const mcpResult = buildClaudeMcpConfig(workspaceRoot, new Set(Object.keys(plugin.mcpRequirements)))
  allWarnings.push(...mcpResult.warnings)
  if (mcpResult.config) {
    const mcpPath = path.join(resolvedOutputDir, ".mcp.json")
    fs.writeFileSync(mcpPath, `${JSON.stringify(mcpResult.config, null, 2)}\n`, "utf-8")
    files.push(".mcp.json")
  }

  const lspResult = buildClaudeLspConfig(workspaceRoot)
  allWarnings.push(...lspResult.warnings)
  if (lspResult.config) {
    const lspPath = path.join(resolvedOutputDir, ".lsp.json")
    fs.writeFileSync(lspPath, `${JSON.stringify(lspResult.config, null, 2)}\n`, "utf-8")
    files.push(".lsp.json")
  }

  // Write each agent
  for (const agent of plugin.agents) {
    const yamlStr = YAML.stringify(agent.frontmatter).trim()
    const normalizedBody = normalizeAgentBody(agent.body)
    const bodyWithFinalNewline = normalizedBody && !normalizedBody.endsWith("\n")
      ? `${normalizedBody}\n`
      : normalizedBody
    const content = bodyWithFinalNewline
      ? `---\n${yamlStr}\n---\n\n${bodyWithFinalNewline}`
      : `---\n${yamlStr}\n---\n`
    const agentPath = path.join(agentsDir, agent.filename)
    fs.writeFileSync(agentPath, content, "utf-8")
    files.push(`agents/${agent.filename}`)
  }

  // Write README.md
  const readmeLines = [
    `# ${plugin.pluginName}`,
    "",
    `Claude Code plugin generated by OpenCode Bridge from the canonical source agents.`,
    "",
    `Author: ${authorName()}.`,
    "",
    "> **Generated output.** Do not edit this directory directly. Change canonical agents or bridge configuration, then regenerate it with the manager.",
    "",
    "## Source and configuration",
    "",
    `Agent definitions are discovered under ${markdownCode(`agents/${sourceDir}/`)}; model tiers, roles, overrides, and bridge options come from ${markdownCode("agents/.agent-manager/translation-config.json")}. MCP and LSP declarations are read from ${markdownCode("agents/general/opencode.json")}.`,
    "",
    "## Generated contents",
    "",
    "- `.claude-plugin/plugin.json` — plugin metadata.",
    "- `agents/` — translated prompts with normalized names and rewritten delegation references.",
    "- `.mcp.json` and `.lsp.json` — translated runtime configurations, when present.",
    "- `README.md` — this generated inventory and setup guide.",
    "",
    "The agent list below is derived from the input passed to the bridge, not maintained separately.",
    "",
    "## Local validation and testing",
    "",
    "```bash",
    `claude plugin validate ${relativePluginPath} --strict`,
    `claude --plugin-dir ${relativePluginPath}`,
    "```",
    "",
    "Generated runtime layers:",
    "",
    "- `.mcp.json` mirrors enabled OpenCode MCP declarations plus servers explicitly required by translated agents.",
    "- `.lsp.json` mirrors enabled OpenCode LSP declarations.",
    "- Agent-to-agent references are rewritten to Claude's canonical lowercase-hyphen names.",
    "",
    ...renderMcpSetup(mcpResult.config, plugin.mcpRequirements),
    "## Usage",
    "",
  ]
  if (plugin.orchestratorName) {
    readmeLines.push(
      "Launch the orchestrator:",
      "",
      "```bash",
      `claude --plugin-dir ${relativePluginPath} --agent ${plugin.pluginName}:${plugin.orchestratorName}`,
      "```",
      ""
    )
  }
  readmeLines.push(
    "## Agents",
    "",
    ...plugin.agents.map(a => `- **${a.name}**: ${a.frontmatter.description || "No description"}`),
    ""
  )
  const readmePath = path.join(resolvedOutputDir, "README.md")
  fs.writeFileSync(readmePath, readmeLines.join("\n"), "utf-8")
  files.push("README.md")

  return {
    pluginDir: resolvedOutputDir,
    files,
    warnings: allWarnings
  }
}

/**
 * One-shot: bridge a category of agents to Claude Code plugin.
 * Main entry point for both TUI and CLI.
 */
export function bridgeToClaudeCode(
  agents: AgentInfo[],
  pluginName: string,
  prefix: string,
  outputDir: string,
  workspaceRoot: string,
  config: TranslationConfig = DEFAULT_TRANSLATION_CONFIG
): BridgeResult {
  // Claude plugin manifests use the same lower-kebab naming convention as
  // agent identifiers. Validate the input first, then normalize harmless
  // underscores/dots instead of emitting a manifest the CLI will reject.
  const safePluginName = normalizeAndValidateClaudePluginName(pluginName)
  const resolvedTargets = resolveTargets(agents, config, "claude")
  const explicitlyRequiredMcpServers = new Set(agents.flatMap(agent => permissionMcpServers(agent.frontmatter)))
  const mcpConfig = buildClaudeMcpConfig(workspaceRoot, explicitlyRequiredMcpServers).config
  const availableMcpServers = mcpConfig && typeof mcpConfig.mcpServers === "object"
    ? new Set<string>(Object.keys(mcpConfig.mcpServers))
    : new Set<string>()
  // Collect per-agent warnings
  const allWarnings: string[] = []
  for (const agent of agents) {
    const w = collectWarnings(agent.frontmatter, availableMcpServers)
    allWarnings.push(...w.map(msg => `[${agent.filename}] ${msg}`))
  }

  const plugin = buildClaudeCodePlugin(agents, safePluginName, prefix, config, availableMcpServers, resolvedTargets)
  const result = writeClaudeCodePlugin(plugin, outputDir, workspaceRoot, config.sourceDir)
  result.warnings.push(...allWarnings)
  result.preview = agents.map(agent => {
    const resolved = resolvedTargets.get(agent.filename)!
    if (resolved.source === "inferred" || resolved.source === "default") result.warnings.push(`[${agent.filename}] model assignment source: ${resolved.source}`)
    return { agent: agent.filename, role: resolved.role, tier: resolved.tier, model: resolved.model.model, source: resolved.source, ...(resolved.inferredFrom ? { inferredFrom: resolved.inferredFrom } : {}) }
  })

  return result
}
