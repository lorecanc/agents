import fs from "node:fs"
import path from "node:path"
import YAML from "yaml"
import { extractFrontmatter, findAgentFiles, resolveCategoriesSubdir, resolveSourceSubdir, type AgentInfo } from "./agents.js"

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

/** The agent's current `permission.bash`: ordered rules, a scalar action, or undefined. */
export function bashRulesOf(frontmatter: Record<string, any> | undefined): BashRule[] | string | undefined {
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

const PIPELINE_ROLE = /^(?:[a-z0-9_-]+-)?pipeline-([a-z0-9_]+)\.md$/i

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
 * Check canonical pipeline agents and every stamped `*-pipeline` copy.
 * Returns an empty list when no profile file exists.
 */
export function checkBashProfiles(workspaceRoot: string): BashDrift[] {
  const config = loadBashProfiles(workspaceRoot)
  if (!config) return []
  const sourceSubdir = resolveSourceSubdir(workspaceRoot)
  const agents = findAgentFiles(workspaceRoot, sourceSubdir).filter(agent => roleOf(agent) !== null && /^pipeline-/.test(agent.filename))
  const categoriesSubdir = resolveCategoriesSubdir(workspaceRoot)
  const categoriesRoot = path.join(workspaceRoot, categoriesSubdir)
  if (fs.existsSync(categoriesRoot)) {
    for (const entry of fs.readdirSync(categoriesRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || !entry.name.endsWith("-pipeline") || !fs.existsSync(path.join(categoriesRoot, entry.name, "agents"))) continue
      agents.push(...findAgentFiles(workspaceRoot, path.join(categoriesSubdir, entry.name)).filter(agent => roleOf(agent) !== null))
    }
  }
  return checkAgentsAgainstBashProfiles(config, agents, workspaceRoot)
}

/** Render rules as the indented YAML lines used under `  bash:` in agent frontmatter. */
export function renderBashBlock(rules: BashRule[], indent = "    "): string[] {
  return rules.map(rule => `${indent}${renderRule(rule)}`)
}

/**
 * Replace only the lines of the frontmatter `permission.bash` mapping. Other
 * keys, comments, and the body are untouched. Returns null when the file has
 * no `bash:` rule block under `permission:` (scalar values are left alone).
 */
export function replaceBashBlock(content: string, rules: BashRule[]): string | null {
  const newline = content.includes("\r\n") ? "\r\n" : "\n"
  const lines = content.split(/\r?\n/)
  if (lines[0] !== "---") return null
  const end = lines.indexOf("---", 1)
  if (end < 0) return null
  let inPermission = false
  for (let index = 1; index < end; index++) {
    const line = lines[index]
    if (/^permission:\s*$/.test(line)) { inPermission = true; continue }
    if (inPermission && /^\S/.test(line)) inPermission = false
    if (!inPermission || !/^ {2}bash:\s*$/.test(line)) continue
    let stop = index + 1
    while (stop < end && (/^ {4,}\S/.test(lines[stop]) || lines[stop].trim() === "")) stop++
    while (stop > index + 1 && lines[stop - 1].trim() === "") stop--
    const indent = lines[index + 1]?.match(/^( {4,})\S/)?.[1] ?? "    "
    return [...lines.slice(0, index + 1), ...renderBashBlock(rules, indent), ...lines.slice(stop)].join(newline)
  }
  return null
}

export interface SyncBashResult {
  changed: string[]
  unchanged: string[]
  skipped: string[]
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
    const next = replaceBashBlock(content, expected)
    if (next === null) throw new Error(`${relative}: role '${role}' is profiled but the file has no permission.bash rule block`)
    // Round-trip guard: only the bash block may change.
    const before = extractFrontmatter(content), after = extractFrontmatter(next)
    const parsedBefore = YAML.parse(before.yamlText ?? ""), parsedAfter = YAML.parse(after.yamlText ?? "")
    if (JSON.stringify(bashRulesOf(parsedAfter)) !== JSON.stringify(expected)) throw new Error(`${relative}: rewritten bash block does not parse back to the profile expansion`)
    parsedBefore.permission.bash = parsedAfter.permission.bash
    if (JSON.stringify(parsedBefore) !== JSON.stringify(parsedAfter) || before.body !== after.body) throw new Error(`${relative}: sync would change more than permission.bash`)
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
