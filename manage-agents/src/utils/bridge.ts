import fs from "node:fs"
import path from "node:path"
import YAML from "yaml"
import { escapeRegExp, extractFrontmatter, normalizeAgentBody } from "./agents.js"
import type { AgentInfo } from "./agents.js"
import { buildInferenceIndex, DEFAULT_TRANSLATION_CONFIG, resolveMarketplaceName, resolveModelTarget, authorName, unusedModelMapKeys, validateMarketplaceName } from "./translationConfig.js"
import type { TranslationConfig } from "./translationConfig.js"
import { getCategoryCompanionLinks } from "./companionLinks.js"
import { assertInsideRealWorkspace, realpathThroughExistingAncestor } from "./pathValidation.js"
import { isKnownPermissionKey, translatePermissionsV2ToV1 } from "./v2Compat.js"
import { adaptToolReferences, collectBashAllowlist, isOpenCodeCustomToolKey, renderBashAllowlistSection, type BashAllowlist } from "./bridgeToolReferences.js"

type ResolvedModelTarget = ReturnType<typeof resolveModelTarget>
type ResolvedTargets = Map<string, ResolvedModelTarget>

/** OpenCode permission keys with no Claude Code tool equivalent; dropped with a warning. */
const DROPPED_PERMISSION_KEYS = [
  "doom_loop", "external_directory",
  "artifact", "file-diff", "mcp-resource",
  "opencode_session_rename", "opencode_session_move",
  "opencode_worktree_create", "opencode_worktree_list", "opencode_worktree_remove"
]

/** Tools whose `ask` state is promoted to allow when the tool is emitted. */
const PROMOTED_ASK_KEYS = ["websearch", "skill", "lsp", "question", "todowrite", "edit", "bash", "shell", "webfetch"]

/** Scalar `ask`, or a catch-all `*: ask` rule, promotes tool presence. */
function promotesAsk(value: unknown): boolean {
  if (value === "ask") return true
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  return (value as Record<string, unknown>)["*"] === "ask"
}

/**
 * A key containing an underscore that is not a built-in tool permission names
 * an MCP server (`<server>_<tool>`), so it cannot fabricate a server for a
 * built-in key.
 */
function isMcpPermissionKey(key: string): boolean {
  return key.includes("_") && !isKnownPermissionKey(key) && !isOpenCodeCustomToolKey(key)
}

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
  /** Effective plugin name written to plugin.json, normalized for Claude Code. */
  pluginName: string
  /** Effective marketplace name written to marketplace.json, null when no marketplace is emitted. */
  marketplaceName: string | null
  /** Generated plugin orchestrator name (`mode: primary`), null when the bridge has none. */
  orchestratorName: string | null
  preview?: AgentTranslationPreview[]
}

export interface AgentTranslationPreview {
  agent: string
  role: string
  tier: string
  model: string
  source: "override" | "model-map" | "role" | "inferred" | "default"
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
 * OpenCode evaluates permission patterns in insertion order with last match
 * winning. Without a concrete path we cannot match globs, so a later catch-all
 * deny overrides earlier rules; any surviving allow/ask means the tool is
 * usable.
 */
function objectAllowsAny(value: unknown): boolean {
  if (value === "allow" || value === true || value === "ask") return true
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  let allowed = false
  for (const [pattern, action] of Object.entries(value as Record<string, unknown>)) {
    if (action === "allow" || action === true || action === "ask") allowed = true
    else if (pattern === "*" && (action === "deny" || action === false)) allowed = false
  }
  return allowed
}

/**
 * Normalize frontmatter permissions to the V1 object the bridge reads
 * internally. V2 carries delegation as `subagent`; the bridge reads one key.
 */
function normalizedPermissions(frontmatter: Record<string, any>): Record<string, any> {
  const permission = frontmatter.permission
  const perms: Record<string, any> = frontmatter.permissions
    ? translatePermissionsV2ToV1(frontmatter.permissions)
    : permission && typeof permission === "object" && !Array.isArray(permission) ? { ...permission } : {}
  if (perms.task === undefined && perms.subagent !== undefined) {
    perms.task = perms.subagent
    delete perms.subagent
  }
  return perms
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
  const perms = normalizedPermissions(frontmatter)

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
  if (objectAllowsAny(perms.edit) || objectAllowsAny(perms.write) || objectAllowsAny(perms.apply_patch) ||
      objectAllowsAny(perms.patch) || objectAllowsAny(perms.multiedit)) {
    tools.push("Write", "Edit")
  }

  // Bash tool (OpenCode exposes both `bash` and `shell`)
  if (objectAllowsAny(perms.bash) || objectAllowsAny(perms.shell)) {
    tools.push("Bash")
  }

  // WebFetch tool
  if (objectAllowsAny(perms.webfetch)) {
    tools.push("WebFetch")
  }
  if (objectAllowsAny(perms.websearch)) {
    tools.push("WebSearch")
  }
  if (objectAllowsAny(perms.skill)) {
    tools.push("Skill")
  }
  if (objectAllowsAny(perms.lsp)) {
    tools.push("LSP")
  }
  if (objectAllowsAny(perms.question)) {
    tools.push("AskUserQuestion")
  }
  if (objectAllowsAny(perms.todowrite)) {
    tools.push("TodoWrite")
  }

  // OpenCode names MCP permissions as `<server>_*`. Claude exposes bundled
  // plugin servers through scoped `mcp__plugin_<plugin>_<server>__*` names;
  // keep the bare form as a compatibility fallback for user-scoped servers.
  const permissionServers = Object.keys(perms)
    .filter(key => isMcpPermissionKey(key) && (perms[key] === "allow" || perms[key] === true ||
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
  const perms = normalizedPermissions(frontmatter)

  if (enabledMcpServers) {
    for (const key of Object.keys(perms)) {
      if (!isMcpPermissionKey(key)) continue
      const server = key.replace(/_.*$/, "")
      if (!enabledMcpServers.has(server)) {
        warnings.push(`MCP server '${server}' is not enabled in the generated Claude .mcp.json`)
      }
    }
  }

  // Claude Code has no per-tool deny syntax for MCP servers: only the whole
  // server can be allowed or removed, so individual denials must be disclosed.
  const allowedMcpServers = new Set<string>()
  const deniedMcpTools = new Map<string, string[]>()
  for (const key of Object.keys(perms)) {
    if (!isMcpPermissionKey(key)) continue
    const value = perms[key]
    const server = key.replace(/_.*$/, "")
    if (value === "allow" || value === true || (typeof value === "object" && value !== null)) {
      allowedMcpServers.add(server)
    } else if ((value === "deny" || value === false) && key !== `${server}_*`) {
      const denied = deniedMcpTools.get(server)
      if (denied) denied.push(key)
      else deniedMcpTools.set(server, [key])
    }
  }
  for (const [server, tools] of deniedMcpTools) {
    if (!allowedMcpServers.has(server)) continue
    warnings.push(`MCP per-tool deny rules for server '${server}' cannot be enforced in Claude Code plugin agents (denied tools: ${tools.join(", ")}); the whole server is allowed`)
  }

  // Granular pattern permissions are collapsed to the whole tool.
  for (const key of ["bash", "shell", "edit"]) {
    const value = perms[key]
    if (!value || typeof value !== "object" || Array.isArray(value)) continue
    const patterns = Object.keys(value).filter(pattern => pattern !== "*")
    if (patterns.length === 0) continue
    warnings.push(`${key} patterns not representable in Claude Code plugin agents; ${patterns.length} rule${patterns.length === 1 ? "" : "s"} dropped: ${patterns.map(pattern => `"${pattern}"`).join(", ")}`)
  }

  const webfetch = perms.webfetch
  if (webfetch && typeof webfetch === "object" && !Array.isArray(webfetch)) {
    const patterns = Object.keys(webfetch).filter(pattern => pattern !== "*")
    if (patterns.length > 0) {
      warnings.push(`webfetch URL patterns match by domain only in Claude Code; ${patterns.length} rule${patterns.length === 1 ? "" : "s"} dropped: ${patterns.map(pattern => `"${pattern}"`).join(", ")}`)
    }
  }

  // Custom tools and built-in permissions have no plugin-agent equivalent.
  for (const key of Object.keys(perms)) {
    const value = perms[key]
    // A deny loses nothing, so only rules that grant something are reported.
    const grantsSomething = value === "allow" || value === true ||
      (typeof value === "object" && value !== null && !Array.isArray(value))
    const droppedBuiltin = grantsSomething &&
      (DROPPED_PERMISSION_KEYS.includes(key) || isOpenCodeCustomToolKey(key))
    const droppedCustomTool = grantsSomething && !isKnownPermissionKey(key) && !key.includes("_")
    if (droppedBuiltin || droppedCustomTool) {
      warnings.push(`permission '${key}' is not representable in Claude Code plugin agents; dropped`)
    }
  }

  const promoted = PROMOTED_ASK_KEYS.filter(key => promotesAsk(perms[key]))
  if (promoted.length > 0) {
    warnings.push(`ask states promoted to allow for ${promoted.join(", ")} (not enforceable per-agent in Claude Code plugin agents)`)
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
    if (isMcpPermissionKey(key) && (value === "allow" || value === true)) {
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
  const sourcePath = [path.join(workspaceRoot, "src", "opencode.json"), path.join(workspaceRoot, "general", "opencode.json")].find(file => fs.existsSync(file)) || path.join(workspaceRoot, "src", "opencode.json")
  if (!fs.existsSync(sourcePath)) return { config: null, warnings: [] }

  try {
    const source = JSON.parse(fs.readFileSync(sourcePath, "utf-8")) as Record<string, any>
    const servers: Record<string, any> = {}
    const warnings: string[] = []
    for (const [name, value] of Object.entries(source.mcp || {})) {
      if (!value || typeof value !== "object") continue
      const server = value as Record<string, any>
      if (server.enabled === false) {
        if (!requiredServers.has(name)) continue
        warnings.push(`[mcp] disabled server '${name}' in ${sourcePath} is required by translated agents; emitted so its tools resolve`)
      }
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
      ? { config: { mcpServers: servers }, warnings }
      : { config: null, warnings }
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
  const sourcePath = [path.join(workspaceRoot, "src", "opencode.json"), path.join(workspaceRoot, "general", "opencode.json")].find(file => fs.existsSync(file)) || path.join(workspaceRoot, "src", "opencode.json")
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

interface OpenCodeCompanions {
  plugins: string[]
  tools: string[]
  commands: string[]
  skills: string[]
}

/** Companion roots, in resolution order: `src/` wins over the legacy `general/`. */
function companionRoots(workspaceRoot: string): string[] {
  return [path.join(workspaceRoot, "src"), path.join(workspaceRoot, "general"), workspaceRoot]
}

function resolveCompanionSourcePath(workspaceRoot: string, relative: string): string | null {
  for (const root of companionRoots(workspaceRoot)) {
    const candidate = path.join(root, relative)
    if (!fs.existsSync(candidate)) continue
    if (fs.lstatSync(candidate).isSymbolicLink()) {
      throw new Error(`Companion source must not be a symlink: ${candidate}`)
    }
    assertInsideRealWorkspace(workspaceRoot, fs.realpathSync(candidate), candidate)
    return candidate
  }
  return null
}

/** Linked companion paths are workspace-relative but live under the source root. */
function resolveOpenCodeCompanions(workspaceRoot: string, category: string): OpenCodeCompanions {
  const links = getCategoryCompanionLinks(workspaceRoot, category)
  const exists = (relative: string) => companionRoots(workspaceRoot).some(root => fs.existsSync(path.join(root, relative)))
  return {
    plugins: links.plugins.filter(exists),
    tools: links.tools.filter(exists),
    commands: links.commands.filter(exists),
    skills: links.skills.filter(exists)
  }
}

function renderCompanionSection(companions: OpenCodeCompanions | undefined): string[] {
  if (!companions || (companions.plugins.length === 0 && companions.tools.length === 0)) return []
  return [
    "## OpenCode plugins and tools",
    "",
    "These OpenCode companions are linked by the category but are not transpiled by the bridge:",
    "",
    ...companions.plugins.map(plugin => `- Plugin: ${markdownCode(plugin)}`),
    ...companions.tools.map(tool => `- Tool: ${markdownCode(tool)}`),
    "",
    "| OpenCode plugin hook | Claude Code equivalent |",
    "|---|---|",
    "| `tool.execute.before` | `PreToolUse` |",
    "| `tool.execute.after` | `PostToolUse` |",
    "| `session.idle` | `Stop` |",
    "| `permission.asked` | `PermissionRequest` |",
    "",
    "Custom OpenCode tools have no per-agent Claude Code equivalent; expose their behavior through a Claude Code MCP server if agents need it.",
    ""
  ]
}

/** Read a command's `description` line directly: command frontmatter values may contain `: `. */
function commandDescription(yamlText: string | null): string {
  if (!yamlText) return ""
  for (const line of yamlText.split(/\r?\n/)) {
    const match = line.match(/^description:\s*(.*)$/)
    if (!match) continue
    const value = match[1].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      return value.slice(1, -1)
    }
    return value
  }
  return ""
}

/** Rewrite OpenCode command placeholders and `!` substitutions into skill instructions. */
function rewriteCommandBody(
  body: string,
  pluginName: string,
  orchestratorName: string | null,
  commandNames: ReadonlySet<string> = new Set()
): { body: string; substitutions: number } {
  const delegation = orchestratorName
    ? `Delegate this task to the ${pluginName}:${orchestratorName} subagent (the plugin orchestrator), passing the brief below unchanged.`
    : `Complete this task with the ${pluginName} plugin agents, passing the brief below unchanged.`
  let substitutions = 0
  const rewritten = body
    .replace(/!`([^`\n]+)`/g, (_match, command: string) => {
      substitutions += 1
      return `\n\n\`\`\`bash\n${command.trim()}\n\`\`\`\n\n`
    })
    .replace(/\$ARGUMENTS/g, () => "$request")
  // Sibling command names are only resolvable in Claude Code with the plugin scope.
  const scopedNames = [...commandNames].filter(name => name.startsWith("pipeline-")).sort((a, b) => b.length - a.length)
  const scoped = scopedNames.length === 0
    ? rewritten
    : rewritten.replace(
      new RegExp(`(^|[^\\w/-])/(${scopedNames.map(escapeRegExp).join("|")})(?![\\w-])`, "g"),
      (_match, prefix: string, command: string) => `${prefix}/${pluginName}:${command}`
    )
  return { body: `${delegation}\n\n${normalizeAgentBody(scoped).trimEnd()}\n`, substitutions }
}

/** Translate one OpenCode command file into `skills/<command>/SKILL.md`. */
function writeCommandSkill(
  sourcePath: string,
  skillsDir: string,
  pluginName: string,
  orchestratorName: string | null,
  commandNames: ReadonlySet<string>
): { name: string; file: string; warning: string } {
  const name = path.basename(sourcePath).replace(/\.md$/i, "")
  const raw = fs.readFileSync(sourcePath, "utf-8")
  const { yamlText, body } = extractFrontmatter(raw)
  const description = commandDescription(yamlText)
  const rewritten = rewriteCommandBody(body, pluginName, orchestratorName, commandNames)
  const frontmatter = YAML.stringify({
    description: description || `Run the ${name} pipeline command.`,
    "disable-model-invocation": true,
    arguments: "request"
  }).trim()
  const skillDir = path.join(skillsDir, name)
  // A planted `skills/<name>` link must be unlinked, never written through.
  if (fs.existsSync(skillDir) && fs.lstatSync(skillDir).isSymbolicLink()) {
    throw new Error(`Invalid plugin output path outside workspace: ${skillDir}`)
  }
  fs.rmSync(skillDir, { recursive: true, force: true })
  fs.mkdirSync(skillDir, { recursive: true })
  const file = `skills/${name}/SKILL.md`
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), `---\n${frontmatter}\n---\n\n${rewritten.body}`, "utf-8")
  return { name, file, warning: `converted ${rewritten.substitutions} !-substitution(s) to inline instructions` }
}

/** Fail closed on any link in a source tree: cpSync preserves links and rewrites would follow them. */
function assertNoSymlinksInTree(dir: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`Companion source must not be a symlink: ${entryPath}`)
    if (entry.isDirectory()) assertNoSymlinksInTree(entryPath)
  }
}

/** Copy a companion skill directory, dropping the source `name` frontmatter key. */
function copyCompanionSkill(sourceDir: string, skillsDir: string, warnings: string[]): string[] {
  if (!fs.statSync(sourceDir).isDirectory()) return []
  const name = path.basename(sourceDir)
  const targetDir = path.join(skillsDir, name)
  // Validate the whole tree before copying so no partial copy escapes.
  assertNoSymlinksInTree(sourceDir)
  fs.rmSync(targetDir, { recursive: true, force: true })
  fs.cpSync(sourceDir, targetDir, { recursive: true })
  const skillPath = path.join(targetDir, "SKILL.md")
  if (fs.existsSync(skillPath)) {
    // Guards the rewrite below directly, even though the source tree is link-free.
    if (fs.lstatSync(skillPath).isSymbolicLink()) throw new Error(`Companion source must not be a symlink: ${skillPath}`)
    const { yamlText, body } = extractFrontmatter(fs.readFileSync(skillPath, "utf-8"))
    if (yamlText) {
      try {
        const parsed = YAML.parse(yamlText) as Record<string, any> | null
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          // The directory name is the plugin skill name; the source key is redundant.
          delete parsed.name
          const yamlStr = YAML.stringify(parsed).trim()
          fs.writeFileSync(skillPath, `---\n${yamlStr}\n---\n\n${normalizeAgentBody(body)}`, "utf-8")
        }
      } catch {
        // Malformed source frontmatter must not block the rest of the bridge.
        warnings.push(`Malformed frontmatter in copied companion skill 'skills/${name}/SKILL.md'; left unchanged`)
      }
    }
  }
  return [`skills/${name}/SKILL.md`]
}

/** Delete generated artifacts that this run no longer emits. */
function pruneStaleArtifacts(
  pluginDir: string,
  directory: "agents" | "skills",
  expected: ReadonlySet<string>,
  warnings: string[]
): void {
  const dir = path.join(pluginDir, directory)
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (expected.has(entry.name)) continue
    if (directory === "agents" && !entry.name.endsWith(".md")) continue
    const target = path.join(dir, entry.name)
    // Fail closed if a planted link would make the deletion escape the plugin.
    assertInsideRealWorkspace(pluginDir, realpathThroughExistingAncestor(target), target)
    fs.rmSync(target, { recursive: true, force: true })
    warnings.push(`Pruned stale generated artifact '${directory}/${entry.name}'`)
  }
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

  // Translate OpenCode tool names and flag OpenCode-only tools near the top.
  body = adaptToolReferences(body, "claude", agent.frontmatter, {
    mcpServers: requiredMcpServers.filter(server => body.includes(`${server}_`))
  }).body

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
export interface ClaudeCodeWriteOptions {
  companions?: OpenCodeCompanions
  /** Per-agent OpenCode bash rules documented (not enforced) in the README. */
  bashAllowlists?: BashAllowlist[]
  emitMarketplace?: boolean
  emitCommands?: boolean
  emitSkills?: boolean
  autoValidate?: boolean
  autoRegister?: boolean
  marketplaceName?: string
}

export function writeClaudeCodePlugin(
  plugin: ClaudeCodePlugin,
  outputDir: string,
  workspaceRoot: string,
  sourceDir = "general",
  options: ClaudeCodeWriteOptions = {}
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
  const emitMarketplace = options.emitMarketplace !== false
  const emitCommands = options.emitCommands !== false
  const emitSkills = options.emitSkills !== false
  const marketplaceName = resolveMarketplaceName(plugin.pluginName, options.marketplaceName)
  if (emitMarketplace) {
    // The manifest must be acceptable to Claude Code; fail before writing anything.
    try {
      validateMarketplaceName(marketplaceName)
    } catch (error) {
      throw new Error(
        `Cannot emit Claude marketplace '${marketplaceName}': ${(error as Error).message} Set claude.marketplaceName in the translation config to a non-reserved name.`
      )
    }
  }

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
  const pluginDescription = `Pipeline agents bridged from OpenCode (${plugin.pluginName})`
  const pluginJson = {
    name: plugin.pluginName,
    version: "1.0.0",
    description: pluginDescription,
    author: {
      name: authorName()
    }
  }
  const pluginJsonPath = path.join(pluginMetaDir, "plugin.json")
  fs.writeFileSync(pluginJsonPath, JSON.stringify(pluginJson, null, 2), "utf-8")
  files.push(".claude-plugin/plugin.json")

  // The validator probes the default icon path; copy the shared asset when present.
  const iconSource = path.join(workspaceRoot, "manage-agents", "assets", "plugin-icon.png")
  if (fs.existsSync(iconSource)) {
    fs.copyFileSync(iconSource, path.join(pluginMetaDir, "icon.png"))
    files.push(".claude-plugin/icon.png")
  }

  // A local marketplace lets `claude plugin install` resolve this plugin in place.
  const marketplacePath = path.join(pluginMetaDir, "marketplace.json")
  if (emitMarketplace) {
    const marketplace = {
      name: marketplaceName,
      description: `Local marketplace: ${pluginDescription}`,
      owner: { name: pluginJson.author.name },
      plugins: [{ name: plugin.pluginName, source: "." }]
    }
    fs.writeFileSync(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`, "utf-8")
    files.push(".claude-plugin/marketplace.json")
  } else if (fs.existsSync(marketplacePath)) {
    assertInsideRealWorkspace(resolvedOutputDir, realpathThroughExistingAncestor(marketplacePath), marketplacePath)
    fs.rmSync(marketplacePath, { force: true })
    allWarnings.push("Pruned stale generated artifact '.claude-plugin/marketplace.json'")
  }

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

  const skillsDir = path.join(resolvedOutputDir, "skills")
  const hasSkillSources = (emitCommands && (options.companions?.commands.length || 0) > 0) ||
    (emitSkills && (options.companions?.skills.length || 0) > 0)
  if (hasSkillSources) {
    // Post-creation gate, like the output/agents/.claude-plugin dirs above.
    fs.mkdirSync(skillsDir, { recursive: true })
    assertInsideRealWorkspace(workspaceRoot, fs.realpathSync(skillsDir), skillsDir)
  }
  const expectedSkills = new Set<string>()
  const commandNames = new Set((options.companions?.commands || []).map(command => path.basename(command).replace(/\.md$/i, "")))
  if (emitCommands) {
    for (const command of options.companions?.commands || []) {
      const sourcePath = resolveCompanionSourcePath(workspaceRoot, command)
      if (!sourcePath) continue
      const skill = writeCommandSkill(sourcePath, skillsDir, plugin.pluginName, plugin.orchestratorName, commandNames)
      expectedSkills.add(skill.name)
      files.push(skill.file)
      allWarnings.push(skill.warning)
    }
  }
  if (emitSkills) {
    for (const skill of options.companions?.skills || []) {
      const sourceDir = resolveCompanionSourcePath(workspaceRoot, skill)
      if (!sourceDir) continue
      files.push(...copyCompanionSkill(sourceDir, skillsDir, allWarnings))
      expectedSkills.add(path.basename(sourceDir))
    }
  }

  // Mirror pruning: anything the current config no longer emits is stale.
  pruneStaleArtifacts(resolvedOutputDir, "agents", new Set(plugin.agents.map(agent => agent.filename)), allWarnings)
  pruneStaleArtifacts(resolvedOutputDir, "skills", expectedSkills, allWarnings)

  const marketplaceReadmeLines: string[] = []
  if (emitMarketplace) {
    marketplaceReadmeLines.push(
      "## Marketplace and registration",
      "",
      `This directory is a local marketplace named \`${marketplaceName}\` that publishes the \`${plugin.pluginName}\` plugin from \`.\`.`,
      ""
    )
    if (options.autoValidate !== false) {
      marketplaceReadmeLines.push("The manager runs `claude plugin validate --strict` after each regeneration.", "")
    }
    if (options.autoRegister !== false) {
      marketplaceReadmeLines.push("The manager adds the marketplace and installs the plugin automatically.", "")
    }
    marketplaceReadmeLines.push(
      "Manual fallback:",
      "",
      "```bash",
      `claude plugin marketplace add '${relativePluginPath}'`,
      `claude plugin install ${plugin.pluginName}@${marketplaceName}`,
      "```",
      "",
      "After regeneration no update command is needed: local marketplaces load in place, and the refreshed plugin is available in the next session or after `/reload-plugins`.",
      ""
    )
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
    `Agent definitions are discovered under ${markdownCode(`${sourceDir}/`)}; model tiers, roles, overrides, and bridge options come from ${markdownCode(".agent-manager/translation-config.json")}. MCP and LSP declarations are read from ${markdownCode("src/opencode.json")}, falling back to the legacy ${markdownCode("general/opencode.json")} when it is absent.`,
    "",
    "## Generated contents",
    "",
    "- `.claude-plugin/plugin.json` — plugin metadata.",
    ...(emitMarketplace ? ["- `.claude-plugin/marketplace.json` — local marketplace manifest used by `claude plugin install`."] : []),
    "- `agents/` — translated prompts with normalized names and rewritten delegation references.",
    ...(expectedSkills.size > 0 ? ["- `skills/` — plugin skills translated from linked OpenCode commands and copied companion skills."] : []),
    "- `.mcp.json` and `.lsp.json` — translated runtime configurations, when present.",
    "- `README.md` — this generated inventory and setup guide.",
    "",
    "The agent list below is derived from the input passed to the bridge, not maintained separately.",
    "",
    "## Local validation and testing",
    "",
    "```bash",
    `claude plugin validate '${relativePluginPath}' --strict`,
    `claude --plugin-dir '${relativePluginPath}'`,
    "```",
    "",
    "Generated runtime layers:",
    "",
    "- `.mcp.json` mirrors enabled OpenCode MCP declarations plus servers explicitly required by translated agents.",
    "- `.lsp.json` mirrors enabled OpenCode LSP declarations.",
    "- `.lsp.json` documents the project LSP setup and is not read by `claude plugin validate`.",
    "- Agent-to-agent references are rewritten to Claude's canonical lowercase-hyphen names.",
    "- OpenCode tool names in prompts are translated (`todowrite` → `TodoWrite`, `question` → `AskUserQuestion`, Task tool → `Agent`, ...). Prompts that rely on OpenCode-only tools (`pipeline_*`) start with a runtime note saying they are unavailable here and that the documented fallbacks apply.",
    "",
    "## Model connection",
    "",
    "The bridge emits Claude family aliases (`sonnet`, `opus`, `haiku`, `fable`, `inherit`) unless a full `claude-*` model ID was pinned in `claude.modelMap`, a tier's `claude.model`, or a per-agent `claude.overrides` entry. Aliases resolve per connection mode: subscription OAuth via `/login` needs no extra configuration, while API key, Bedrock, and Vertex connections resolve aliases according to the provider configuration. `fable` requires Claude Code CLI v2.1.257 or newer.",
    "",
    ...renderMcpSetup(mcpResult.config, plugin.mcpRequirements),
    ...renderCompanionSection(options.companions),
    ...renderBashAllowlistSection("claude", options.bashAllowlists ?? []),
    ...(expectedSkills.size > 0 ? [
      "## Pipeline skills",
      "",
      "Invoke a generated skill with its plugin-scoped name:",
      "",
      ...[...expectedSkills].map(name => `- \`/${plugin.pluginName}:${name}\``),
      ""
    ] : []),
    ...marketplaceReadmeLines,
    "## Usage",
    "",
  ]
  if (plugin.orchestratorName) {
    readmeLines.push(
      "Launch the orchestrator:",
      "",
      "```bash",
      `claude --plugin-dir '${relativePluginPath}' --agent ${plugin.pluginName}:${plugin.orchestratorName}`,
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
    warnings: allWarnings,
    pluginName: plugin.pluginName,
    marketplaceName: emitMarketplace ? marketplaceName : null,
    orchestratorName: plugin.orchestratorName
  }
}

export interface ClaudeBridgeOptions {
  /** Category used to resolve OpenCode companion links; defaults to the first agent's category. */
  category?: string
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
  config: TranslationConfig = DEFAULT_TRANSLATION_CONFIG,
  options: ClaudeBridgeOptions = {}
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
  const companionCategory = options.category || agents[0]?.category || ""
  const companions = companionCategory
    ? resolveOpenCodeCompanions(workspaceRoot, companionCategory)
    : undefined
  for (const file of companions?.plugins || []) {
    allWarnings.push(`OpenCode plugin '${file}' is not transpiled; see the README section 'OpenCode plugins and tools'`)
  }
  for (const file of companions?.tools || []) {
    allWarnings.push(`OpenCode tool '${file}' is not transpiled; see the README section 'OpenCode plugins and tools'`)
  }
  for (const key of unusedModelMapKeys(agents, config, "claude")) {
    allWarnings.push(`[model-map] entry "${key}" matches no source agent model in this bridge`)
  }
  const bashAllowlists = agents
    .map((agent, index) => collectBashAllowlist(plugin.agents[index]?.name ?? agent.filename, agent.frontmatter))
    .filter((allowlist): allowlist is BashAllowlist => allowlist !== null)
  const result = writeClaudeCodePlugin(plugin, outputDir, workspaceRoot, config.sourceDir, {
    companions,
    bashAllowlists,
    emitMarketplace: config.claude.emitMarketplace,
    emitCommands: config.claude.emitCommands,
    emitSkills: config.claude.emitSkills,
    autoValidate: config.claude.autoValidate,
    autoRegister: config.claude.autoRegister,
    marketplaceName: config.claude.marketplaceName
  })
  result.warnings.push(...allWarnings)
  result.preview = agents.map(agent => {
    const resolved = resolvedTargets.get(agent.filename)!
    if (resolved.source === "inferred" || resolved.source === "default") result.warnings.push(`[${agent.filename}] model assignment source: ${resolved.source}`)
    return { agent: agent.filename, role: resolved.role, tier: resolved.tier, model: resolved.model.model, source: resolved.source, ...(resolved.inferredFrom ? { inferredFrom: resolved.inferredFrom } : {}) }
  })

  return result
}
