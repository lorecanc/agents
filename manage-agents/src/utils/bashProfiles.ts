import fs from "node:fs"
import path from "node:path"
import YAML from "yaml"
import { extractFrontmatter, findAgentFiles, resolveSourceSubdir, type AgentInfo } from "./agents.js"
import { translateFrontmatterV1ToV2, translateFrontmatterV2ToV1, type V2PermissionRule } from "./v2Compat.js"

/**
 * Bash allowlists of pipeline agents are generated from named, ordered rule
 * blocks in `.agent-manager/bash-profiles.json`. A role expands to the
 * concatenation of its profiles; OpenCode evaluates bash rules with
 * last-match-wins, so order is semantic and preserved exactly.
 */

export type BashAction = "allow" | "ask" | "deny"
export type BashRule = [pattern: string, action: BashAction]

export interface BashProfile {
  description?: string
  rules: BashRule[]
}

export interface BashProfilesConfig {
  version: 1
  description?: string
  profiles: Record<string, BashProfile>
  roles: Record<string, string[]>
}

export const BASH_PROFILES_FILE = path.join(".agent-manager", "bash-profiles.json")
const ACTIONS = new Set(["allow", "ask", "deny"])

export function bashProfilesPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, BASH_PROFILES_FILE)
}

/** Validate structure, references, and that no role expansion repeats a pattern. */
export function validateBashProfiles(value: unknown): asserts value is BashProfilesConfig {
  const fail = (message: string): never => { throw new Error(`Invalid bash profiles: ${message}`) }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("root must be an object")
  const config = value as Record<string, any>
  if (config.version !== 1) fail("version must be 1")
  if (!config.profiles || typeof config.profiles !== "object" || Array.isArray(config.profiles)) fail("profiles must be an object")
  if (!config.roles || typeof config.roles !== "object" || Array.isArray(config.roles)) fail("roles must be an object")
  for (const [name, profile] of Object.entries(config.profiles as Record<string, any>)) {
    if (!profile || !Array.isArray(profile.rules) || profile.rules.length === 0) fail(`profile '${name}' needs a non-empty rules array`)
    for (const rule of profile.rules) {
      if (!Array.isArray(rule) || rule.length !== 2 || typeof rule[0] !== "string" || !rule[0] || !ACTIONS.has(rule[1])) {
        fail(`profile '${name}' has an invalid rule ${JSON.stringify(rule)}`)
      }
    }
  }
  for (const [role, names] of Object.entries(config.roles as Record<string, any>)) {
    if (!Array.isArray(names) || names.length === 0) fail(`role '${role}' needs a non-empty profile list`)
    const seen = new Set<string>()
    for (const name of names) {
      if (typeof name !== "string" || !config.profiles[name]) fail(`role '${role}' references unknown profile '${name}'`)
      for (const [pattern] of config.profiles[name].rules as BashRule[]) {
        if (seen.has(pattern)) fail(`role '${role}' expands pattern ${JSON.stringify(pattern)} twice`)
        seen.add(pattern)
      }
    }
  }
}

export function loadBashProfiles(workspaceRoot: string): BashProfilesConfig | null {
  const file = bashProfilesPath(workspaceRoot)
  const stat = fs.lstatSync(file, { throwIfNoEntry: false })
  if (!stat) return null
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Refusing to read bash profiles through a non-regular file: ${file}`)
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"))
  validateBashProfiles(parsed)
  return parsed
}

/** Ordered rules for a role, or null when the role has no profile (e.g. `bash: deny` agents). */
export function expandBashRole(config: BashProfilesConfig, role: string): BashRule[] | null {
  const names = config.roles[role]
  if (!names) return null
  return names.flatMap(name => config.profiles[name].rules.map(([pattern, action]) => [pattern, action] as BashRule))
}

/** The agent's current `permission.bash` / V2 `shell` rules: ordered rules, a scalar action, or undefined. */
export function bashRulesOf(frontmatter: Record<string, any> | undefined): BashRule[] | string | undefined {
  if (Array.isArray(frontmatter?.permissions)) {
    const rules = frontmatter.permissions
      .filter((rule: any) => rule && typeof rule === "object" && !Array.isArray(rule) && rule.action === "shell" && typeof rule.resource === "string")
      .map((rule: any) => [rule.resource, String(rule.effect) as BashAction] as BashRule)
    // A lone "*" shell rule is the V2 form of `bash: <action>`.
    if (rules.length === 1 && rules[0][0] === "*") return rules[0][1]
    return rules.length > 0 ? rules : undefined
  }
  const bash = frontmatter?.permission?.bash
  if (bash === undefined || bash === null) return undefined
  if (typeof bash !== "object" || Array.isArray(bash)) return String(bash)
  return Object.entries(bash).map(([pattern, action]) => [pattern, String(action) as BashAction])
}

const renderRule = ([pattern, action]: BashRule) => `${JSON.stringify(pattern)}: ${action}`

/** Small unified-style diff (LCS) between current and expected rules; context lines are omitted. */
export function diffBashRules(actual: BashRule[], expected: BashRule[], limit = 12): string[] {
  const a = actual.map(renderRule), b = expected.map(renderRule)
  const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
  }
  const lines: string[] = []
  let i = 0, j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { i++; j++ }
    else if (j < b.length && (i === a.length || table[i][j + 1] >= table[i + 1][j])) lines.push(`+ ${b[j++]}`)
    else lines.push(`- ${a[i++]}`)
  }
  return lines.length > limit ? [...lines.slice(0, limit), `… ${lines.length - limit} more`] : lines
}

export interface BashDrift {
  file: string
  role: string
  /** Why the agent does not match: different rules, or a scalar/missing block for a profiled role. */
  problem: "rules-differ" | "not-a-rule-block" | "unprofiled-rule-block"
  diff: string[]
}

const PIPELINE_ROLE = /^pipeline-([a-z0-9_]+)\.md$/i

function roleOf(agent: AgentInfo): string | null {
  return path.basename(agent.filename).match(PIPELINE_ROLE)?.[1]?.toLowerCase() ?? null
}

/** Compare a set of pipeline agents with the profile expansion of their role. */
export function checkAgentsAgainstBashProfiles(config: BashProfilesConfig, agents: AgentInfo[], workspaceRoot: string): BashDrift[] {
  const drifts: BashDrift[] = []
  for (const agent of agents) {
    const role = roleOf(agent)
    if (!role) continue
    const file = path.relative(workspaceRoot, agent.currentPath).split(path.sep).join("/")
    const expected = expandBashRole(config, role)
    const actual = bashRulesOf(agent.frontmatter)
    if (!expected) {
      if (Array.isArray(actual)) drifts.push({ file, role, problem: "unprofiled-rule-block", diff: [`role '${role}' has a bash rule block but no entry in ${BASH_PROFILES_FILE}`] })
      continue
    }
    if (!Array.isArray(actual)) {
      drifts.push({ file, role, problem: "not-a-rule-block", diff: [`- bash: ${actual ?? "(missing)"}`, `+ ${expected.length} rules from ${config.roles[role].join(", ")}`] })
      continue
    }
    if (JSON.stringify(actual) !== JSON.stringify(expected)) drifts.push({ file, role, problem: "rules-differ", diff: diffBashRules(actual, expected) })
  }
  return drifts
}

/**
 * Check the canonical pipeline agents.
 * Returns an empty list when no profile file exists.
 */
export function checkBashProfiles(workspaceRoot: string): BashDrift[] {
  const config = loadBashProfiles(workspaceRoot)
  if (!config) return []
  const agents = findAgentFiles(workspaceRoot, resolveSourceSubdir(workspaceRoot)).filter(agent => roleOf(agent) !== null && /^pipeline-/.test(agent.filename))
  return checkAgentsAgainstBashProfiles(config, agents, workspaceRoot)
}

function shellRules(rules: BashRule[]): V2PermissionRule[] {
  return rules.map(([resource, effect]) => ({ action: "shell", resource, effect }))
}

/**
 * Replace the ordered bash/shell expansion while leaving every other
 * frontmatter field and the body bytes untouched. Returns null when the file
 * has no frontmatter.
 */
export function rewriteBashRules(content: string, rules: BashRule[]): string | null {
  const { yamlText, body } = extractFrontmatter(content)
  if (yamlText === null) return null
  let parsed: unknown
  try { parsed = YAML.parse(yamlText) } catch { return null }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const frontmatter = parsed as Record<string, any>

  let next: Record<string, any>
  if (Array.isArray(frontmatter.permissions)) {
    const permissions: any[] = []
    let inserted = false
    for (const rule of frontmatter.permissions) {
      if (rule && typeof rule === "object" && !Array.isArray(rule) && rule.action === "shell") {
        if (!inserted) { permissions.push(...shellRules(rules)); inserted = true }
        continue
      }
      permissions.push(rule)
    }
    if (!inserted) permissions.push(...shellRules(rules))
    next = { ...frontmatter, permissions }
  } else {
    const permission = frontmatter.permission && typeof frontmatter.permission === "object" && !Array.isArray(frontmatter.permission)
      ? frontmatter.permission as Record<string, any>
      : {}
    next = translateFrontmatterV1ToV2({ ...frontmatter, permission: { ...permission, bash: Object.fromEntries(rules) } })
  }

  return `---\n${YAML.stringify(next).trim()}\n---\n${body}`
}

export interface SyncBashResult {
  changed: string[]
  unchanged: string[]
  skipped: string[]
}

function canonicalJson(value: any): any {
  if (Array.isArray(value)) return value.map(canonicalJson)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalJson(value[key])]))
}

/** Rewrite canonical pipeline agents' bash blocks from the profiles. */
export function syncBashProfiles(workspaceRoot: string, options: { dryRun?: boolean } = {}): SyncBashResult {
  const config = loadBashProfiles(workspaceRoot)
  if (!config) throw new Error(`No ${BASH_PROFILES_FILE} found`)
  const result: SyncBashResult = { changed: [], unchanged: [], skipped: [] }
  const agents = findAgentFiles(workspaceRoot, resolveSourceSubdir(workspaceRoot)).filter(agent => /^pipeline-/.test(agent.filename))
  const plans: Array<{ file: string; next: string }> = []
  for (const agent of agents) {
    const role = roleOf(agent)
    const expected = role ? expandBashRole(config, role) : null
    const relative = path.relative(workspaceRoot, agent.currentPath).split(path.sep).join("/")
    if (!expected) { result.skipped.push(relative); continue }
    const stat = fs.lstatSync(agent.currentPath)
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Refusing to rewrite non-regular agent file: ${agent.currentPath}`)
    const content = fs.readFileSync(agent.currentPath, "utf8")
    const before = extractFrontmatter(content)
    const parsedBefore = YAML.parse(before.yamlText ?? "")
    if (JSON.stringify(bashRulesOf(parsedBefore)) === JSON.stringify(expected)) { result.unchanged.push(relative); continue }
    const next = rewriteBashRules(content, expected)
    if (next === null) throw new Error(`${relative}: role '${role}' is profiled but the file has no frontmatter`)
    // Round-trip guard: only permission.bash may change, and the body must keep
    // its bytes. Compare parsed YAML, not the rendered lines.
    const after = extractFrontmatter(next)
    const parsedAfter = YAML.parse(after.yamlText ?? "")
    if (JSON.stringify(bashRulesOf(parsedAfter)) !== JSON.stringify(expected)) throw new Error(`${relative}: rewritten bash block does not parse back to the profile expansion`)
    const normalizedBefore = Array.isArray(parsedBefore.permissions) ? translateFrontmatterV2ToV1(parsedBefore) : parsedBefore
    const normalizedAfter = Array.isArray(parsedAfter.permissions) ? translateFrontmatterV2ToV1(parsedAfter) : parsedAfter
    delete normalizedBefore.permission?.["*"]
    delete normalizedAfter.permission?.["*"]
    normalizedBefore.permission = { ...(normalizedBefore.permission ?? {}), bash: normalizedAfter.permission?.bash }
    if (JSON.stringify(canonicalJson(normalizedBefore)) !== JSON.stringify(canonicalJson(normalizedAfter)) || before.body !== after.body) {
      throw new Error(`${relative}: sync would change more than permission.bash`)
    }
    if (next === content) result.unchanged.push(relative)
    else { result.changed.push(relative); plans.push({ file: agent.currentPath, next }) }
  }
  if (!options.dryRun) for (const plan of plans) {
    const temporary = `${plan.file}.tmp-${process.pid}`
    fs.writeFileSync(temporary, plan.next, { mode: fs.statSync(plan.file).mode & 0o7777 })
    fs.renameSync(temporary, plan.file)
  }
  return result
}

// --- Matcher (OpenCode-like; used by tests and diagnostics) ---

function globToRegExp(pattern: string): RegExp {
  let source = ""
  for (const character of pattern) {
    if (character === "*") source += "[\\s\\S]*"
    else if (character === "?") source += "[\\s\\S]"
    else source += character.replace(/[\\^$.+()|[\]{}]/g, "\\$&")
  }
  return new RegExp(`^${source}$`)
}

/** Split a shell line on `&&`, `||`, `;`, and `|` outside quotes. Leading `VAR=x` stays in the part. */
export function splitCompoundCommand(command: string): string[] {
  const parts: string[] = []
  let current = "", quote: string | null = null
  for (let index = 0; index < command.length; index++) {
    const character = command[index]
    if (quote) {
      current += character
      if (character === "\\" && quote === "\"" && index + 1 < command.length) current += command[++index]
      else if (character === quote) quote = null
      continue
    }
    if (character === "'" || character === "\"") { quote = character; current += character; continue }
    const two = command.slice(index, index + 2)
    if (two === "&&" || two === "||") { parts.push(current); current = ""; index++; continue }
    if (character === ";" || character === "|") { parts.push(current); current = ""; continue }
    current += character
  }
  parts.push(current)
  return parts.map(part => part.trim()).filter(Boolean)
}

/** Action for a single command: last matching rule wins, deny when nothing matches. */
export function matchBashRule(rules: BashRule[], command: string): BashAction {
  let action: BashAction = "deny"
  for (const [pattern, ruleAction] of rules) if (globToRegExp(pattern).test(command)) action = ruleAction
  return action
}

/** Action for a possibly compound command: every part must be allowed; any deny wins, then ask. */
export function evaluateBashCommand(rules: BashRule[], command: string): BashAction {
  const actions = splitCompoundCommand(command).map(part => matchBashRule(rules, part))
  if (actions.length === 0) return "deny"
  if (actions.includes("deny")) return "deny"
  if (actions.includes("ask")) return "ask"
  return "allow"
}

/** Evaluate against an agent's bash permission (`bash: deny` scalars apply to every command). */
export function evaluateAgentBash(frontmatter: Record<string, any> | undefined, command: string): BashAction {
  const rules = bashRulesOf(frontmatter)
  if (Array.isArray(rules)) return evaluateBashCommand(rules, command)
  if (rules === "allow" || rules === "ask") return rules
  return "deny"
}
