/**
 * Data-driven adaptation of OpenCode tool references in bridged prompt bodies.
 *
 * Source prompts are written for OpenCode: they name OpenCode tools
 * (`todowrite`, `question`, the Task tool) and repository custom tools
 * (`pipeline_state`, `pipeline_commit`, ...). Bridges rewrite names that have a
 * target equivalent and insert one runtime note, near the top of the body, that
 * lists the tools the target does not provide. Prompts already document the
 * fallback for those tools, so no prompt text is deleted.
 */

import { translatePermissionsV2ToV1 } from "./v2Compat.js"

export type BridgeTarget = "claude" | "codex"

/** V1 permission map of an agent frontmatter (V2 `permissions` are translated). */
function permissionOf(frontmatter: Record<string, any> | undefined): Record<string, any> | null {
  const permission = frontmatter?.permissions ? translatePermissionsV2ToV1(frontmatter.permissions) : frontmatter?.permission
  return permission && typeof permission === "object" && !Array.isArray(permission) ? permission : null
}

/** A textual replacement applied to the prompt body. */
interface ToolRename {
  /** OpenCode name shown in the runtime note. */
  source: string
  /** Target name shown in the runtime note. */
  target: string
  /** Matches the OpenCode spelling in prose. */
  pattern: RegExp
  /** Replacement text (may use `$1`...). */
  replacement: string
}

/** An OpenCode tool with no rename, explained in the runtime note only. */
interface ToolGuidance {
  source: string
  /** Detects a mention of the tool in the body. */
  pattern: RegExp
  guidance: string
}

interface TargetToolTable {
  label: string
  renames: ToolRename[]
  guidance: ToolGuidance[]
}

/** Only backticked spellings are rewritten for names that are also English words. */
const backticked = (name: string) => new RegExp(`\`${name}\``, "g")
const taskTool = /\bTask (tool|calls?\b|call\(s\))/g

const CLAUDE_TABLE: TargetToolTable = {
  label: "Claude Code",
  renames: [
    { source: "todowrite", target: "TodoWrite", pattern: /\btodowrite\b/g, replacement: "TodoWrite" },
    { source: "question", target: "AskUserQuestion", pattern: backticked("question"), replacement: "`AskUserQuestion`" },
    { source: "task", target: "Agent", pattern: backticked("task"), replacement: "`Agent`" },
    { source: "Task tool", target: "Agent tool", pattern: taskTool, replacement: "Agent $1" },
    { source: "read", target: "Read", pattern: backticked("read"), replacement: "`Read`" },
    { source: "grep", target: "Grep", pattern: backticked("grep"), replacement: "`Grep`" },
    { source: "glob", target: "Glob", pattern: backticked("glob"), replacement: "`Glob`" },
    { source: "lsp", target: "LSP", pattern: backticked("lsp"), replacement: "`LSP`" },
    { source: "skill", target: "Skill", pattern: backticked("skill"), replacement: "`Skill`" },
    { source: "webfetch", target: "WebFetch", pattern: backticked("webfetch"), replacement: "`WebFetch`" },
    { source: "websearch", target: "WebSearch", pattern: backticked("websearch"), replacement: "`WebSearch`" },
    { source: "bash", target: "Bash", pattern: backticked("bash"), replacement: "`Bash`" },
    { source: "edit", target: "Edit", pattern: backticked("edit"), replacement: "`Edit`" },
    { source: "write", target: "Write", pattern: backticked("write"), replacement: "`Write`" }
  ],
  guidance: []
}

const CODEX_TABLE: TargetToolTable = {
  label: "Codex",
  renames: [
    { source: "todowrite", target: "update_plan", pattern: /\btodowrite\b/g, replacement: "update_plan" }
  ],
  guidance: [
    { source: "question", pattern: backticked("question"), guidance: "ask the user directly in your reply and wait for the answer" },
    { source: "task", pattern: /`task`|\bTask (?:tool|calls?\b|call\(s\))/, guidance: "delegate to the Codex subagents listed under Delegation targets" },
    { source: "read / grep / glob / lsp", pattern: /`(?:read|grep|glob|lsp)`/, guidance: "read and search files with shell commands (for example `rg`, `sed -n`)" },
    { source: "edit / write", pattern: /`(?:edit|write)`/, guidance: "change files with `apply_patch`" }
  ]
}

const TABLES: Record<BridgeTarget, TargetToolTable> = { claude: CLAUDE_TABLE, codex: CODEX_TABLE }

/**
 * OpenCode custom tools shipped by this repository (`src/tools/pipeline_*.ts`).
 * Any `pipeline_<name>` identifier is treated as one, so new tools are covered
 * without editing this list; the named ones are always recognized.
 */
export const OPENCODE_ONLY_TOOLS = ["pipeline_state", "pipeline_commit", "pipeline_verify", "pipeline_smoke", "pipeline_serve", "pipeline_env"] as const
const OPENCODE_CUSTOM_TOOL = /\bpipeline_[a-z][a-z0-9_]*\b/g

/** True for permission keys that name an OpenCode custom tool rather than an MCP server. */
export function isOpenCodeCustomToolKey(key: string): boolean {
  return (OPENCODE_ONLY_TOOLS as readonly string[]).includes(key) || /^pipeline_[a-z][a-z0-9_]*$/.test(key)
}

/** Marker that makes the note idempotent across repeated rewrites. */
export const RUNTIME_NOTE_MARKER = "Runtime note (OpenCode bridge)"

export interface ToolReferenceResult {
  body: string
  /** OpenCode custom tools referenced by the agent and unavailable in the target. */
  unavailable: string[]
  /** Renames that actually changed the body, as `source → target`. */
  renamed: string[]
}

function permissionKeys(frontmatter: Record<string, any> | undefined): string[] {
  const permission = permissionOf(frontmatter)
  if (!permission) return []
  return Object.entries(permission)
    .filter(([, value]) => value !== "deny" && value !== false)
    .map(([key]) => key)
}

/** Insert the note after a leading H1 heading when present, otherwise at the top. */
function insertNearTop(body: string, note: string): string {
  const leading = body.match(/^\s*/)?.[0] ?? ""
  const rest = body.slice(leading.length)
  const heading = rest.match(/^# [^\n]*\n/)
  if (heading) return `${leading}${heading[0]}\n${note}\n\n${rest.slice(heading[0].length).replace(/^\n+/, "")}`
  return `${leading}${note}\n\n${rest}`
}

/**
 * Rewrite OpenCode tool names to their target equivalents and add a single
 * runtime note for tools that do not exist in the target environment.
 */
export function adaptToolReferences(
  body: string,
  target: BridgeTarget,
  frontmatter?: Record<string, any>,
  options: { mcpServers?: string[] } = {}
): ToolReferenceResult {
  if (body.includes(RUNTIME_NOTE_MARKER)) return { body, unavailable: [], renamed: [] }
  const table = TABLES[target]

  const unavailable = new Set<string>()
  for (const key of permissionKeys(frontmatter)) if (isOpenCodeCustomToolKey(key)) unavailable.add(key)
  for (const match of body.matchAll(OPENCODE_CUSTOM_TOOL)) unavailable.add(match[0])

  const guidance = table.guidance.filter(entry => body.search(entry.pattern) !== -1)
  let rewritten = body
  const renamed: string[] = []
  for (const rename of table.renames) {
    const next = rewritten.replace(rename.pattern, rename.replacement)
    if (next !== rewritten) {
      const label = `\`${rename.source}\` → \`${rename.target}\``
      if (!renamed.includes(label)) renamed.push(label)
      rewritten = next
    }
  }

  const sortedUnavailable = [...unavailable].sort()
  const mcpServers = options.mcpServers ?? []
  if (sortedUnavailable.length === 0 && renamed.length === 0 && guidance.length === 0 && mcpServers.length === 0) {
    return { body, unavailable: [], renamed: [] }
  }

  const lines = [`> **${RUNTIME_NOTE_MARKER}.** This prompt was written for OpenCode and runs here in ${table.label}.`]
  if (sortedUnavailable.length > 0) {
    lines.push(
      `> - These OpenCode tools are **not available** in this environment: ${sortedUnavailable.map(tool => `\`${tool}\``).join(", ")}.` +
      " Wherever this prompt says to call one of them (\"if available\"), take the fallback it documents (manual baseline, plain git, test, or build commands) and state in your report that the tool was unavailable. Never invent its output."
    )
  }
  if (renamed.length > 0) lines.push(`> - OpenCode tool names were translated: ${renamed.join(", ")}.`)
  for (const entry of guidance) lines.push(`> - \`${entry.source}\`: ${entry.guidance}.`)
  if (mcpServers.length > 0) {
    lines.push(target === "claude"
      ? `> - MCP tools named \`<server>_<tool>\` in this prompt are exposed as \`mcp__<server>__<tool>\` (plugin-scoped: \`mcp__plugin_<plugin>_<server>__<tool>\`); servers: ${mcpServers.map(server => `\`${server}\``).join(", ")}.`
      : `> - MCP tools named \`<server>_<tool>\` in this prompt come from the plugin's MCP servers: ${mcpServers.map(server => `\`${server}\``).join(", ")}.`)
  }
  return { body: insertNearTop(rewritten, lines.join("\n")), unavailable: sortedUnavailable, renamed }
}

/** Granular bash rules of an agent, grouped by decision. */
export interface BashAllowlist {
  agent: string
  rules: Record<string, string[]>
}

/** Collect per-agent OpenCode bash/shell pattern rules (catch-all `*` excluded). */
export function collectBashAllowlist(agent: string, frontmatter: Record<string, any> | undefined): BashAllowlist | null {
  const permission = permissionOf(frontmatter)
  if (!permission) return null
  const rules: Record<string, string[]> = {}
  for (const key of ["bash", "shell"]) {
    const value = permission[key]
    if (!value || typeof value !== "object" || Array.isArray(value)) continue
    for (const [pattern, decision] of Object.entries(value as Record<string, unknown>)) {
      if (pattern === "*") continue
      const label = decision === true ? "allow" : decision === false ? "deny" : String(decision)
      ;(rules[label] ??= []).push(pattern)
    }
  }
  return Object.keys(rules).length > 0 ? { agent, rules } : null
}

const code = (value: string) => {
  const runs = [...value.matchAll(/`+/g)].map(match => match[0].length)
  const fence = "`".repeat(Math.max(1, ...(runs.length ? runs : [0]).map(length => length + 1)))
  return fence.length > 1 ? `${fence} ${value} ${fence}` : `${fence}${value}${fence}`
}

/** README section documenting why per-agent bash allowlists are not carried over. */
export function renderBashAllowlistSection(target: BridgeTarget, allowlists: BashAllowlist[]): string[] {
  if (allowlists.length === 0) return []
  const limitation = target === "claude"
    ? "Claude Code plugin agents only accept a `tools:` list: the bridge emits `Bash` for every agent whose OpenCode `bash` permission allows anything. Per-command allow/ask/deny rules exist only in Claude Code settings (`permissions.allow` / `permissions.deny`, for example `Bash(git diff *)`), which apply to the whole session and cannot be shipped per agent by a plugin. The source rules are listed here so they can be reviewed or copied into project settings."
    : "Codex agent files set only `sandbox_mode`: agents whose OpenCode `bash` or `edit` permission allows anything get `workspace-write`, the others `read-only`. Codex has no per-agent command allowlist; command rules are global. The source rules are listed here for review."
  const lines = ["## Per-agent bash allowlists (not enforced)", "", limitation, ""]
  for (const allowlist of allowlists) {
    const total = Object.values(allowlist.rules).reduce((sum, rules) => sum + rules.length, 0)
    lines.push(`<details><summary>${allowlist.agent} (${total} rule${total === 1 ? "" : "s"})</summary>`, "")
    for (const decision of Object.keys(allowlist.rules).sort()) {
      lines.push(`- ${decision}: ${allowlist.rules[decision].map(code).join(", ")}`)
    }
    lines.push("", "</details>", "")
  }
  return lines
}
