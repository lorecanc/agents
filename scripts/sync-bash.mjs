// Bash allowlists of the pipeline agents are generated from named, ordered rule blocks in scripts/bash-profiles.json.
// A role expands to the concatenation of its profiles; OpenCode evaluates shell rules with last-match-wins, so the
// order is semantic and preserved exactly.
//
//   node scripts/sync-bash.mjs           rewrite the shell rules of packs/pipeline/agents/pipeline-<role>.md
//   node scripts/sync-bash.mjs --check   report drift, exit 1 when an agent differs from its profiles

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import YAML from "yaml"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const ACTIONS = new Set(["allow", "ask", "deny"])
const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/
const ROLE_RE = /^pipeline-([a-z0-9_]+)\.md$/

export function validateProfiles(config) {
  const fail = (message) => { throw new Error(`bash-profiles.json: ${message}`) }
  if (config?.version !== 1 || typeof config.profiles !== "object" || typeof config.roles !== "object") fail("expected {version: 1, profiles, roles}")
  for (const [name, profile] of Object.entries(config.profiles)) {
    if (!Array.isArray(profile?.rules) || !profile.rules.length) fail(`profile '${name}' needs a non-empty rules array`)
    for (const rule of profile.rules) if (!Array.isArray(rule) || rule.length !== 2 || typeof rule[0] !== "string" || !rule[0] || !ACTIONS.has(rule[1])) fail(`profile '${name}' has an invalid rule ${JSON.stringify(rule)}`)
  }
  for (const [role, names] of Object.entries(config.roles)) {
    if (!Array.isArray(names) || !names.length) fail(`role '${role}' needs a non-empty profile list`)
    const seen = new Set()
    for (const name of names) {
      if (!config.profiles[name]) fail(`role '${role}' references unknown profile '${name}'`)
      for (const [pattern] of config.profiles[name].rules) {
        if (seen.has(pattern)) fail(`role '${role}' expands pattern ${JSON.stringify(pattern)} twice`)
        seen.add(pattern)
      }
    }
  }
  return config
}

export const expandRole = (config, role) => config.roles[role]?.flatMap(name => config.profiles[name].rules) ?? null

const shellRulesOf = (frontmatter) => (Array.isArray(frontmatter?.permissions) ? frontmatter.permissions : [])
  .filter(rule => rule && typeof rule === "object" && rule.action === "shell")
  .map(rule => [rule.resource, rule.effect])

/** The file with its shell rules replaced by `rules` (at the position of the first one); body bytes untouched. */
export function rewriteShellRules(content, rules) {
  const match = content.match(FRONTMATTER_RE)
  if (!match) throw new Error("no frontmatter")
  const frontmatter = YAML.parse(match[1])
  if (!Array.isArray(frontmatter?.permissions)) throw new Error("no V2 permissions list")
  const shell = rules.map(([resource, effect]) => ({ action: "shell", resource, effect }))
  const permissions = []
  let inserted = false
  for (const rule of frontmatter.permissions) {
    if (rule?.action !== "shell") { permissions.push(rule); continue }
    if (!inserted) { permissions.push(...shell); inserted = true }
  }
  if (!inserted) permissions.push(...shell)
  return `---\n${YAML.stringify({ ...frontmatter, permissions }).trim()}\n---\n${content.slice(match[0].length)}`
}

export function syncBash({ root = ROOT, check = false } = {}) {
  const config = validateProfiles(JSON.parse(fs.readFileSync(path.join(root, "scripts", "bash-profiles.json"), "utf8")))
  const dir = path.join(root, "packs", "pipeline", "agents")
  const result = { changed: [], unchanged: [], skipped: [] }
  for (const file of fs.readdirSync(dir).filter(name => ROLE_RE.test(name)).sort()) {
    const role = file.match(ROLE_RE)[1]
    const expected = expandRole(config, role)
    if (!expected) { result.skipped.push(file); continue }
    const full = path.join(dir, file)
    const content = fs.readFileSync(full, "utf8")
    const current = shellRulesOf(YAML.parse(content.match(FRONTMATTER_RE)?.[1] ?? ""))
    if (JSON.stringify(current) === JSON.stringify(expected)) { result.unchanged.push(file); continue }
    result.changed.push(file)
    if (check) continue
    const next = rewriteShellRules(content, expected)
    if (JSON.stringify(shellRulesOf(YAML.parse(next.match(FRONTMATTER_RE)[1]))) !== JSON.stringify(expected)) throw new Error(`${file}: rewritten rules do not parse back to the profile expansion`)
    fs.writeFileSync(`${full}.tmp-${process.pid}`, next)
    fs.renameSync(`${full}.tmp-${process.pid}`, full)
  }
  return result
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check")
  const result = syncBash({ check })
  for (const file of result.changed) console.log(`${check ? "drift" : "updated"}: packs/pipeline/agents/${file}`)
  console.log(`${result.changed.length} ${check ? "differ" : "updated"}, ${result.unchanged.length} in sync, ${result.skipped.length} without a profile`)
  if (check && result.changed.length) process.exitCode = 1
}
