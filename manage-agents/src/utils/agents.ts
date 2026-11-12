import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { randomBytes } from "node:crypto"
import YAML from "yaml"
import { isPathInsideWorkspace, isWorkspaceRelativePath } from "./pathValidation.js"
import { packDir, readManifest, resolvePackClosure } from "./catalog.js"
import { MANIFEST_FILE } from "./packs.js"
import { detectFrontmatterVersion, translateFrontmatterV1ToV2, translateFrontmatterV2ToV1 } from "./v2Compat.js"
import { isServerDisabled, readMcpServers } from "./opencodeMcp.js"

function isValidFrontmatter(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length > 0
}

const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/

/**
 * Extract YAML frontmatter from agent file content, tolerating CRLF line endings.
 * Returns yamlText=null (and body=content) when no frontmatter block is present.
 */
export function extractFrontmatter(content: string): { yamlText: string | null; body: string } {
  const match = content.match(FRONTMATTER_RE)
  if (!match) return { yamlText: null, body: content }
  return { yamlText: match[1], body: content.substring(match[0].length) }
}

export interface AgentInfo {
  filename: string
  currentPath: string
  targetPath: string
  category: string
  description: string
  model: string
  rawContent: string
  frontmatter: Record<string, any>
  body: string
  allowedSubagents: string[]
  /** Original frontmatter format detected when parsing the file */
  frontmatterVersion?: "v1" | "v2" | "unknown"
}

export type TuningField = "steps" | "temp" | "variant" | "mode" | "hidden"

export interface TuningInitialState {
  steps: { value: string; mixed: boolean; distinctValues: number[]; displayMixed: string }
  temp: { value: string; mixed: boolean; distinctValues: number[]; displayMixed: string }
  variant: { value: string; mixed: boolean; distinctValues: string[]; displayMixed: string }
  mode: { value: "subagent" | "primary"; mixed: boolean; distinctValues: string[]; displayMixed: string }
  hidden: { value: boolean; mixed: boolean; distinctValues: boolean[]; displayMixed: string }
}

export function inspectTuningTargets(agents: AgentInfo[]): TuningInitialState {
  const stepsDistinct = [...new Set(agents.map(agent => agent.frontmatter.steps ?? agent.frontmatter.max_steps ?? 50))].sort((a, b) => a - b)
  const stepsMixed = stepsDistinct.length > 1
  const stepsValue = stepsDistinct.length === 1 ? String(stepsDistinct[0]) : String(agents[0]?.frontmatter.steps ?? agents[0]?.frontmatter.max_steps ?? 50)
  const tempDistinct = [...new Set(agents.map(agent => agent.frontmatter.temperature ?? 0.2))].sort((a, b) => a - b)
  const tempMixed = tempDistinct.length > 1
  const tempValue = tempDistinct.length === 1 ? String(tempDistinct[0]) : String(agents[0]?.frontmatter.temperature ?? 0.2)
  const variantDistinct = [...new Set(agents.map(agent => typeof agent.frontmatter.variant === "string" ? agent.frontmatter.variant.trim() : ""))].sort()
  const variantMixed = variantDistinct.length > 1
  const variantValue = variantDistinct.length === 1 ? variantDistinct[0] : ""
  const modeDistinct = [...new Set(agents.map(agent => agent.frontmatter.mode === "primary" ? "primary" : "subagent"))].sort()
  const modeMixed = modeDistinct.length > 1
  const modeValue = modeDistinct.length === 1 ? modeDistinct[0] as "primary" | "subagent" : agents[0]?.frontmatter.mode === "primary" ? "primary" : "subagent"
  const hiddenDistinct = [...new Set(agents.map(agent => Boolean(agent.frontmatter.hidden)))].sort((a, b) => Number(a) - Number(b))
  const hiddenMixed = hiddenDistinct.length > 1
  const hiddenValue = hiddenDistinct.length === 1 ? hiddenDistinct[0] : Boolean(agents[0]?.frontmatter.hidden)

  return {
    steps: { value: stepsValue, mixed: stepsMixed, distinctValues: stepsDistinct, displayMixed: stepsMixed ? `(mixed: ${stepsDistinct.join(", ")} — unchanged)` : stepsValue },
    temp: { value: tempValue, mixed: tempMixed, distinctValues: tempDistinct, displayMixed: tempMixed ? `(mixed: ${tempDistinct.join(", ")} — unchanged)` : tempValue },
    variant: { value: variantValue, mixed: variantMixed, distinctValues: variantDistinct, displayMixed: variantMixed ? `(mixed: ${variantDistinct.map(value => value || "default").join(", ")} — unchanged)` : variantValue },
    mode: { value: modeValue, mixed: modeMixed, distinctValues: modeDistinct, displayMixed: modeMixed ? `(mixed: ${modeDistinct.map(mode => mode.toUpperCase()).join(", ")} — unchanged)` : modeValue.toUpperCase() },
    hidden: { value: hiddenValue, mixed: hiddenMixed, distinctValues: hiddenDistinct, displayMixed: hiddenMixed ? `(mixed: ${hiddenDistinct.map(value => value ? "TRUE" : "FALSE").join(", ")} — unchanged)` : hiddenValue ? "TRUE" : "FALSE" }
  }
}

export function buildTuningUpdateParams(
  draft: { steps: string; temp: string; variant: string; mode: "subagent" | "primary"; hidden: boolean },
  dirtyFields: ReadonlySet<TuningField>,
  allowedVariants?: readonly string[]
): { steps?: number; temperature?: number; mode?: "subagent" | "primary"; hidden?: boolean; variant?: string | null; allowedVariants?: readonly string[] } {
  const params: { steps?: number; temperature?: number; mode?: "subagent" | "primary"; hidden?: boolean; variant?: string | null; allowedVariants?: readonly string[] } = {}
  if (dirtyFields.has("steps")) {
    const stepsNum = parseInt(draft.steps, 10)
    if (isNaN(stepsNum) || stepsNum < 0) throw new Error("Steps must be a valid positive number.")
    params.steps = stepsNum
  }
  if (dirtyFields.has("temp")) {
    const tempNum = parseFloat(draft.temp)
    if (isNaN(tempNum) || tempNum < 0 || tempNum > 1) throw new Error("Temperature must be a valid number between 0.0 and 1.0.")
    params.temperature = tempNum
  }
  if (dirtyFields.has("variant")) {
    params.variant = draft.variant.trim() === "" ? null : draft.variant.trim()
    if (allowedVariants && allowedVariants.length > 0) params.allowedVariants = allowedVariants
  }
  if (dirtyFields.has("mode")) params.mode = draft.mode
  if (dirtyFields.has("hidden")) params.hidden = draft.hidden
  return params
}

/** Where agents are discovered: the workspace itself when it is a single pack, else a catalog's packs/. */
export function resolveSourceSubdir(workspaceRoot: string): string {
  if (fs.existsSync(path.join(workspaceRoot, MANIFEST_FILE))) return "."
  return fs.existsSync(path.join(workspaceRoot, "packs")) ? "packs" : "."
}

/**
 * Pack holding a file: the nearest opencode-pack.json between the file and the workspace root. In a catalog the pack
 * is its directory under packs/ (what packDir resolves); a single pack is named by its manifest.
 */
function packNameOf(filePath: string, workspaceRoot: string): string | null {
  const root = path.resolve(workspaceRoot)
  for (let dir = path.dirname(path.resolve(filePath)); dir.startsWith(root); dir = path.dirname(dir)) {
    const manifest = path.join(dir, MANIFEST_FILE)
    if (fs.existsSync(manifest)) {
      if (path.dirname(dir) === path.join(root, "packs")) return path.basename(dir)
      try {
        const name = readManifest(dir).name
        return typeof name === "string" && name ? name : path.basename(dir)
      } catch {
        return path.basename(dir)
      }
    }
    if (dir === root) break
  }
  return null
}

export type AgentResourceKind = "skill-wildcard" | "skill" | "tool-family" | "tool" | "mcp"

export interface AgentResourceItem {
  id: string
  kind: AgentResourceKind
  name: string
  permissionKey: string
  allowed: boolean
  exists: boolean
  relativePath?: string
  familyKey?: string
}

export interface AgentMcpResourceItem extends AgentResourceItem {
  kind: "mcp"
  serverKey: string
  serverEnabled: boolean
  configuredInOpencode: boolean
  recommendedInRepo?: boolean
  serverType?: string
  serverTarget?: string
}

export interface AgentResourceCatalog {
  skills: AgentResourceItem[]
  tools: AgentResourceItem[]
  mcpServers: AgentMcpResourceItem[]
  opencodeRawContent: string | null
  opencodeConfigPath?: string
  recommendedMcpServers?: Record<string, Record<string, any>>
}

export interface AgentResourceChanges {
  skills?: {
    all: boolean
    allowedNames: string[]
  }
  permissions?: Record<string, boolean>
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseOpenCodeJson(raw: string, filePath: string): Record<string, any> {
  let withoutComments = ""
  let inString = false
  let escaped = false
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index]
    const next = raw[index + 1]
    if (inString) {
      withoutComments += char
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') inString = false
    } else if (char === '"') {
      inString = true
      withoutComments += char
    } else if (char === "/" && next === "/") {
      while (index < raw.length && raw[index] !== "\n" && raw[index] !== "\r") {
        withoutComments += " "
        index++
      }
      if (index < raw.length) withoutComments += raw[index]
    } else if (char === "/" && next === "*") {
      withoutComments += "  "
      index += 2
      while (index < raw.length && !(raw[index] === "*" && raw[index + 1] === "/")) {
        withoutComments += raw[index] === "\n" || raw[index] === "\r" ? raw[index] : " "
        index++
      }
      if (index < raw.length) {
        withoutComments += "  "
        index++
      }
    } else withoutComments += char
  }

  let json = ""
  inString = false
  escaped = false
  for (let index = 0; index < withoutComments.length; index++) {
    const char = withoutComments[index]
    if (inString) {
      json += char
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') inString = false
    } else if (char === '"') {
      inString = true
      json += char
    } else if (char === ",") {
      let nextIndex = index + 1
      while (/\s/.test(withoutComments[nextIndex] ?? "")) nextIndex++
      if (withoutComments[nextIndex] !== "}" && withoutComments[nextIndex] !== "]") json += char
    } else json += char
  }

  const parsed: unknown = JSON.parse(json)
  if (!isPlainObject(parsed)) throw new Error(`Invalid OpenCode config object: ${filePath}`)
  if (Object.prototype.hasOwnProperty.call(parsed, "mcp") && !isPlainObject(parsed.mcp)) {
    throw new Error(`Invalid mcp object in OpenCode config: ${filePath}`)
  }
  return parsed
}

function resourcePathStat(filePath: string): fs.Stats | undefined {
  const stat = fs.lstatSync(filePath, { throwIfNoEntry: false })
  if (stat?.isSymbolicLink()) throw new Error(`Refusing to use symlink resource path: ${filePath}`)
  return stat
}

/**
 * The agent's pack and the packs it requires: the skills, tools and MCP servers it can use once installed. A single
 * pack opened as the workspace cannot see the packs it requires, so only its own resources are listed.
 */
function agentResourceRoots(workspaceRoot: string, agent: AgentInfo): string[] {
  const dir = packDir(workspaceRoot, agent.category)
  if (!dir) return [path.dirname(path.dirname(agent.currentPath))]
  if (dir === path.resolve(workspaceRoot) || dir === workspaceRoot) return [dir]
  return resolvePackClosure(workspaceRoot, agent.category).map(name => packDir(workspaceRoot, name)!)
}

function readConfigFile(file: string): { raw: string | null; config: Record<string, any> } {
  const stat = resourcePathStat(file)
  if (!stat) return { raw: null, config: {} }
  if (!stat.isFile()) throw new Error(`OpenCode config is not a regular file: ${file}`)
  const raw = fs.readFileSync(file, "utf8")
  return { raw, config: parseOpenCodeJson(raw, file) }
}

export function discoverAgentResources(
  workspaceRoot: string,
  agent: AgentInfo,
  allAgents?: AgentInfo[],
  env: NodeJS.ProcessEnv = process.env
): AgentResourceCatalog {
  const resourceRoots = agentResourceRoots(workspaceRoot, agent)
  const permission = agent.frontmatter?.permission
  const perm = isPlainObject(permission) ? permission : {}
  const allowedValue = (value: unknown) => value === "allow" || value === true
  const skillPermission = perm.skill
  const skillPermissionObject = isPlainObject(skillPermission) ? skillPermission : undefined
  const wildcardAllowed = allowedValue(skillPermission) || !!(skillPermissionObject && allowedValue(skillPermissionObject["*"]))
  const skillNames = new Set<string>()
  if (skillPermissionObject) {
    for (const key of Object.keys(skillPermissionObject)) if (key !== "*") skillNames.add(key)
  }

  const diskSkillNames = new Set<string>()
  const toolPaths = new Map<string, string>()
  const repoMcpObj: Record<string, any> = {}
  for (const resourceRoot of resourceRoots) {
    const skillRoot = path.join(resourceRoot, "skills")
    if (resourcePathStat(skillRoot)?.isDirectory()) {
      for (const entry of fs.readdirSync(skillRoot)) {
        if (!resourcePathStat(path.join(skillRoot, entry))?.isDirectory()) continue
        if (!resourcePathStat(path.join(skillRoot, entry, "SKILL.md"))?.isFile()) continue
        diskSkillNames.add(entry)
        skillNames.add(entry)
      }
    }
    // Tool modules live in per-pack namespaces (tools/<pack>/<name>.ts); their plugins register them by file name.
    const toolRoot = path.join(resourceRoot, "tools")
    if (resourcePathStat(toolRoot)?.isDirectory()) {
      for (const namespace of fs.readdirSync(toolRoot)) {
        const namespaceDir = path.join(toolRoot, namespace)
        if (!resourcePathStat(namespaceDir)?.isDirectory()) continue
        for (const entry of fs.readdirSync(namespaceDir)) {
          if (!entry.endsWith(".ts") || entry.endsWith(".d.ts") || entry.includes(".test.") || entry.startsWith("_")) continue
          if (resourcePathStat(path.join(namespaceDir, entry))?.isFile()) toolPaths.set(entry.slice(0, -3), path.join("tools", namespace, entry))
        }
      }
    }
    Object.assign(repoMcpObj, readMcpServers(readConfigFile(path.join(resourceRoot, "opencode.json")).config))
  }

  const skills: AgentResourceItem[] = [{
    id: "skill:*", kind: "skill-wildcard", name: "* (All Skills)", permissionKey: "*", allowed: wildcardAllowed, exists: true
  }]
  for (const name of [...skillNames].sort((a, b) => a.localeCompare(b))) {
    const exists = diskSkillNames.has(name)
    const allowed = skillPermissionObject && Object.prototype.hasOwnProperty.call(skillPermissionObject, name)
      ? allowedValue(skillPermissionObject[name])
      : wildcardAllowed
    skills.push({
      id: `skill:${name}`, kind: "skill", name, permissionKey: name, allowed, exists,
      relativePath: exists ? path.join("skills", name, "SKILL.md") : undefined
    })
  }

  const tools: AgentResourceItem[] = []
  const families = new Map<string, string[]>()
  const standalone: string[] = []
  for (const name of toolPaths.keys()) {
    const match = name.match(/^([^_]+)_.+$/)
    if (!match) {
      standalone.push(name)
      continue
    }
    const members = families.get(match[1]) ?? []
    members.push(name)
    families.set(match[1], members)
  }
  const toolPrefixes = new Set(families.keys())
  for (const prefix of [...families.keys()].sort((a, b) => a.localeCompare(b))) {
    const familyKey = `${prefix}_*`
    const familyAllowed = allowedValue(perm[familyKey])
    tools.push({ id: `tool-family:${prefix}`, kind: "tool-family", name: familyKey, permissionKey: familyKey, allowed: familyAllowed, exists: true, familyKey })
    for (const name of families.get(prefix)!.sort((a, b) => a.localeCompare(b))) {
      const allowed = Object.prototype.hasOwnProperty.call(perm, name) ? allowedValue(perm[name]) : familyAllowed
      tools.push({ id: `tool:${name}`, kind: "tool", name, permissionKey: name, allowed, exists: true, relativePath: toolPaths.get(name), familyKey })
    }
  }
  for (const name of standalone.sort((a, b) => a.localeCompare(b))) {
    tools.push({ id: `tool:${name}`, kind: "tool", name, permissionKey: name, allowed: allowedValue(perm[name]), exists: true, relativePath: toolPaths.get(name) })
  }

  const opencodePath = path.join(path.dirname(getExportDestination(env)), "opencode.json")
  const { raw: opencodeRawContent, config: globalOpencode } = readConfigFile(opencodePath)
  const globalMcpObj = readMcpServers(globalOpencode)
  const recommendedMcpServers: Record<string, Record<string, any>> = {}
  for (const [serverKey, config] of Object.entries(repoMcpObj)) {
    if (isPlainObject(config)) recommendedMcpServers[serverKey] = config
  }
  const mcpNames = new Set([...Object.keys(globalMcpObj), ...Object.keys(repoMcpObj)])
  const collectMcpPermissionKeys = (source: unknown) => {
    if (!isPlainObject(source)) return
    for (const key of Object.keys(source)) {
      if (!key.endsWith("_*")) continue
      const prefix = key.slice(0, -2)
      if (prefix && !toolPrefixes.has(prefix)) mcpNames.add(prefix)
    }
  }
  collectMcpPermissionKeys(perm)
  for (const other of allAgents ?? []) collectMcpPermissionKeys(other.frontmatter?.permission)
  const mcpServers: AgentMcpResourceItem[] = [...mcpNames].sort((a, b) => a.localeCompare(b)).map(serverKey => {
    const configuredInOpencode = Object.prototype.hasOwnProperty.call(globalMcpObj, serverKey)
    const recommendedInRepo = Object.prototype.hasOwnProperty.call(repoMcpObj, serverKey)
    const rawEntry = configuredInOpencode ? globalMcpObj[serverKey] : repoMcpObj[serverKey]
    return {
      id: `mcp:${serverKey}`, kind: "mcp", name: serverKey, serverKey, permissionKey: `${serverKey}_*`,
      allowed: allowedValue(perm[`${serverKey}_*`]), exists: configuredInOpencode || recommendedInRepo,
      relativePath: configuredInOpencode ? opencodePath : recommendedInRepo ? "opencode.json" : undefined,
      serverEnabled: configuredInOpencode ? !isServerDisabled(globalMcpObj[serverKey]) : false,
      configuredInOpencode, recommendedInRepo,
      serverType: typeof rawEntry?.type === "string" ? rawEntry.type : undefined,
      serverTarget: typeof rawEntry?.url === "string" ? rawEntry.url : Array.isArray(rawEntry?.command) ? rawEntry.command.join(" ") : undefined
    }
  })

  return { skills, tools, mcpServers, opencodeRawContent, opencodeConfigPath: opencodePath, recommendedMcpServers }
}

/** Rewrites the agent's skill, tool and MCP permissions; the agent file is the only file written. */
export function updateAgentResources(agent: AgentInfo, catalog: AgentResourceCatalog, changes: AgentResourceChanges): { changedPaths: string[] } {
  const hasPermissions = Object.keys(changes.permissions ?? {}).length > 0
  if (!changes.skills && !hasPermissions) return { changedPaths: [] }

  const permission = agent.frontmatter.permission
  if (permission !== undefined && !isPlainObject(permission)) throw new Error("Agent permission must be an object")
  for (const key of Object.keys(changes.permissions ?? {})) {
    if (![...catalog.tools, ...catalog.mcpServers].some(item => item.permissionKey === key)) {
      throw new Error(`Unknown resource permission key: ${key}`)
    }
  }
  for (const name of changes.skills?.allowedNames ?? []) {
    if (!catalog.skills.some(item => item.kind === "skill" && item.name === name)) throw new Error(`Unknown skill: ${name}`)
  }

  const agentPath = agent.currentPath
  const stat = fs.lstatSync(agentPath)
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Refusing to update non-regular agent file: ${agentPath}`)
  const originalAgent = fs.readFileSync(agentPath)
  if (originalAgent.toString("utf8") !== agent.rawContent) throw new Error(`Agent changed on disk before resource update: ${agent.filename}`)

  const existingPerm: Record<string, any> = { ...(agent.frontmatter.permission || {}) }
  if (changes.skills) {
    const knownNames = catalog.skills.filter(item => item.kind === "skill").map(item => item.name)
    const allowedNames = new Set(changes.skills.allowedNames)
    if (changes.skills.all) {
      const unchecked = knownNames.filter(name => !allowedNames.has(name)).sort((a, b) => a.localeCompare(b))
      existingPerm.skill = unchecked.length
        ? { "*": "allow", ...Object.fromEntries(unchecked.map(name => [name, "deny"])) }
        : { "*": "allow" }
    } else {
      const checked = knownNames.filter(name => allowedNames.has(name)).sort((a, b) => a.localeCompare(b))
      existingPerm.skill = checked.length
        ? { "*": "deny", ...Object.fromEntries(checked.map(name => [name, "allow"])) }
        : "deny"
    }
  }
  for (const [key, allow] of Object.entries(changes.permissions ?? {})) existingPerm[key] = allow ? "allow" : "deny"
  if (hasPermissions) {
    const familyKeys = [...new Set(catalog.tools.filter(item => item.kind === "tool-family").map(item => item.permissionKey))]
      .filter(key => Object.prototype.hasOwnProperty.call(existingPerm, key))
    const reordered: Record<string, any> = {}
    const emittedFamilies = new Set<string>()
    for (const [key, value] of Object.entries(existingPerm)) {
      const memberFamily = familyKeys.find(family => key.startsWith(family.slice(0, -1)) && key !== family)
      if (memberFamily && !emittedFamilies.has(memberFamily)) {
        reordered[memberFamily] = existingPerm[memberFamily]
        emittedFamilies.add(memberFamily)
      }
      if (familyKeys.includes(key)) {
        if (!emittedFamilies.has(key)) reordered[key] = value
        emittedFamilies.add(key)
      } else reordered[key] = value
    }
    for (const key of Object.keys(existingPerm)) delete existingPerm[key]
    Object.assign(existingPerm, reordered)
  }
  const updatedFrontmatter = { ...agent.frontmatter, permission: existingPerm }
  const renderedAgent = renderAgentFile(updatedFrontmatter, agent.body, agent.frontmatterVersion)
  const agentBytes = Buffer.from(renderedAgent, "utf8")
  if (agentBytes.equals(originalAgent)) return { changedPaths: [] }
  atomicWriteAgentFile(agentPath, agentBytes)
  agent.frontmatter = updatedFrontmatter
  agent.rawContent = renderedAgent
  return { changedPaths: [agentPath] }
}

export type AgentList = AgentInfo[] & { warnings?: string[] }

export interface NamingAnalysis {
  isValid: boolean
  family?: string
  category?: string
  role?: string
  errors: string[]
  suggestedName?: string
}

export interface PermissionSummary {
  bash: "allow" | "deny" | "ask" | "custom"
  edit: "allow" | "deny" | "ask" | "custom"
  read: "allow" | "deny" | "ask"
  taskCount: number
  riskLevel: "HIGH" | "MEDIUM" | "LOW"
}

export interface SafetyPreset {
  key: "readonly_scout" | "safe_builder" | "unrestricted_dev"
  name: string
  description: string
  permissions: Record<string, any>
}

export const SAFETY_PRESETS: SafetyPreset[] = [
  {
    key: "readonly_scout",
    name: "Read-Only Scout 🛡️",
    description: "Read, grep, glob & LSP allowed. Edit, write & bash denied.",
    permissions: {
      read: "allow",
      grep: "allow",
      glob: "allow",
      lsp: "allow",
      edit: "deny",
      write: "deny",
      bash: "deny"
    }
  },
  {
    key: "safe_builder",
    name: "Safe Builder 🛠️",
    description: "File modifications allowed (edit/write). Bash denied for security.",
    permissions: {
      read: "allow",
      grep: "allow",
      glob: "allow",
      lsp: "allow",
      edit: { "*": "allow" },
      write: { "*": "allow" },
      bash: "deny"
    }
  },
  {
    key: "unrestricted_dev",
    name: "Unrestricted Dev ⚡",
    description: "Full access: edit, write & bash execution allowed.",
    permissions: {
      read: "allow",
      grep: "allow",
      glob: "allow",
      lsp: "allow",
      edit: { "*": "allow" },
      write: { "*": "allow" },
      bash: { "*": "allow" }
    }
  }
]

export function getAgentPermissionSummary(agent: AgentInfo): PermissionSummary {
  const perm = agent.frontmatter.permission || {}

  let bashState: "allow" | "deny" | "ask" | "custom" = "deny"
  if (perm.bash === "allow" || perm.bash === true) bashState = "allow"
  else if (perm.bash === "deny" || perm.bash === false) bashState = "deny"
  else if (perm.bash === "ask") bashState = "ask"
  else if (perm.bash && typeof perm.bash === "object") bashState = "allow"

  let editState: "allow" | "deny" | "ask" | "custom" = "deny"
  if (perm.edit === "allow" || perm.edit === true) editState = "allow"
  else if (perm.edit === "deny" || perm.edit === false) editState = "deny"
  else if (perm.edit === "ask") editState = "ask"
  else if (perm.edit && typeof perm.edit === "object") editState = "allow"

  let readState: "allow" | "deny" | "ask" = "allow"
  if (perm.read === "deny" || perm.read === false) readState = "deny"
  else if (perm.read === "ask") readState = "ask"

  const taskCount = agent.allowedSubagents ? agent.allowedSubagents.length : 0

  let riskLevel: "HIGH" | "MEDIUM" | "LOW" = "LOW"
  if (bashState === "allow") riskLevel = "HIGH"
  else if (editState === "allow") riskLevel = "MEDIUM"

  return { bash: bashState, edit: editState, read: readState, taskCount, riskLevel }
}

export function applySafetyPreset(agents: AgentInfo[], presetKey: "readonly_scout" | "safe_builder" | "unrestricted_dev") {
  const preset = SAFETY_PRESETS.find(p => p.key === presetKey)
  if (!preset) return

  for (const agent of agents) {
    const existingPerm = agent.frontmatter.permission || {}
    const updatedFrontmatter = {
      ...agent.frontmatter,
      permission: {
        ...existingPerm,
        ...preset.permissions
      }
    }
    saveAgentFile(agent.currentPath, updatedFrontmatter, agent.body, agent.frontmatterVersion)
    agent.frontmatter = updatedFrontmatter
  }
}

export function updateAgentParams(
  agents: AgentInfo[],
  params: { steps?: number; temperature?: number; mode?: string; hidden?: boolean; variant?: string | null; allowedVariants?: readonly string[] }
) {
  const variant = params.variant === undefined ? undefined : normalizeAgentVariant(params.variant, params.allowedVariants)

  for (const agent of agents) {
    const updatedFrontmatter = { ...agent.frontmatter }
    if (params.steps !== undefined) {
      if (updatedFrontmatter.steps !== undefined) updatedFrontmatter.steps = params.steps
      if (updatedFrontmatter.max_steps !== undefined) updatedFrontmatter.max_steps = params.steps
      if (updatedFrontmatter.steps === undefined && updatedFrontmatter.max_steps === undefined) updatedFrontmatter.steps = params.steps
    }
    if (params.temperature !== undefined) updatedFrontmatter.temperature = params.temperature
    if (params.mode !== undefined) updatedFrontmatter.mode = params.mode
    if (params.hidden !== undefined) updatedFrontmatter.hidden = params.hidden
    if (variant === null) delete updatedFrontmatter.variant
    else if (variant !== undefined) updatedFrontmatter.variant = variant

    saveAgentFile(agent.currentPath, composeModelVariant({ ...updatedFrontmatter }), agent.body, agent.frontmatterVersion)
    agent.frontmatter = updatedFrontmatter
  }
}

export const AGENT_EFFORT_VARIANTS = ["low", "medium", "high", "max"] as const
export const KNOWN_MODEL_VARIANTS = ["minimal", "low", "medium", "high", "xhigh", "max", "none", "thinking"] as const

function normalizeAgentVariant(value: unknown, allowedVariants?: readonly string[]): string | null {
  if (value === null) return null
  if (typeof value !== "string") throw new Error("Invalid agent variant. Expected string or null.")
  const normalized = value.trim().toLocaleLowerCase("und")
  if (!normalized) throw new Error("Agent variant cannot be empty. Pass null to clear variant.")
  if (!/^[a-z0-9._-]+$/.test(normalized)) throw new Error(`Invalid agent variant "${value}".`)
  const allowed = allowedVariants && allowedVariants.length > 0 ? allowedVariants : KNOWN_MODEL_VARIANTS
  if (!allowed.includes(normalized)) throw new Error(`Invalid agent variant "${value}". Expected one of: ${allowed.join(", ")}.`)
  return normalized
}

export interface PermissionOrderAnalysis {
  hasOrderError: boolean
  erroneousCategories: string[]
}

/**
 * Checks if wildcard '*' is placed FIRST in permission map objects.
 * OpenCode permission evaluation order: LAST matching rule wins.
 * Therefore, wildcard '*' MUST be the FIRST key in the object dictionary!
 */
export function analyzePermissionOrder(agent: AgentInfo): PermissionOrderAnalysis {
  const perm = agent.frontmatter.permission
  if (!perm || typeof perm !== "object") return { hasOrderError: false, erroneousCategories: [] }

  const erroneousCategories: string[] = []

  for (const [categoryKey, val] of Object.entries(perm)) {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const keys = Object.keys(val)
      if (keys.includes("*") && keys[0] !== "*") {
        erroneousCategories.push(categoryKey)
      }
    }
  }

  return {
    hasOrderError: erroneousCategories.length > 0,
    erroneousCategories
  }
}

/**
 * Reorders permission dictionaries so that wildcard '*' is placed FIRST.
 */
export function fixPermissionOrder(agent: AgentInfo): boolean {
  const perm = agent.frontmatter.permission
  if (!perm || typeof perm !== "object") return false

  let modified = false
  const updatedPerm: Record<string, any> = { ...perm }

  for (const [catKey, val] of Object.entries(perm)) {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const keys = Object.keys(val)
      if (keys.includes("*") && keys[0] !== "*") {
        // Reorder object so '*' comes first
        const reorderedObj: Record<string, any> = {}
        reorderedObj["*"] = val["*"]
        for (const k of keys) {
          if (k !== "*") {
            reorderedObj[k] = val[k]
          }
        }
        updatedPerm[catKey] = reorderedObj
        modified = true
      }
    }
  }

  if (modified) {
    const updatedFrontmatter = { ...agent.frontmatter, permission: updatedPerm }
    saveAgentFile(agent.currentPath, updatedFrontmatter, agent.body, agent.frontmatterVersion)
    agent.frontmatter = updatedFrontmatter
  }

  return modified
}

export function updateAgentDelegations(
  agent: AgentInfo,
  allowedSubagentNames: string[]
) {
  const existingPerm = agent.frontmatter.permission || {}
  
  // OpenCode rule: wildcard '*' MUST be first!
  const taskObj: Record<string, string> = { "*": "deny" }

  allowedSubagentNames.forEach(name => {
    taskObj[name] = "allow"
  })

  const updatedFrontmatter = {
    ...agent.frontmatter,
    permission: {
      ...existingPerm,
      task: taskObj
    }
  }

  saveAgentFile(agent.currentPath, updatedFrontmatter, agent.body, agent.frontmatterVersion)
  agent.frontmatter = updatedFrontmatter
  agent.allowedSubagents = allowedSubagentNames
}

export function auditSecurityPermissions(agents: AgentInfo[]) {
  const highRisk: { agent: AgentInfo; reason: string }[] = []
  const mediumRisk: { agent: AgentInfo; reason: string }[] = []
  const orderErrors: { agent: AgentInfo; categories: string[] }[] = []
  const lowRisk: AgentInfo[] = []

  for (const agent of agents) {
    const summary = getAgentPermissionSummary(agent)
    const orderAnalysis = analyzePermissionOrder(agent)

    if (orderAnalysis.hasOrderError) {
      orderErrors.push({ agent, categories: orderAnalysis.erroneousCategories })
    }

    if (summary.riskLevel === "HIGH") {
      highRisk.push({ agent, reason: "BASH execution allowed ('bash: allow')" })
    } else if (summary.riskLevel === "MEDIUM") {
      mediumRisk.push({ agent, reason: "File edit allowed ('edit: allow')" })
    } else {
      lowRisk.push(agent)
    }
  }

  return { highRisk, mediumRisk, orderErrors, lowRisk }
}

/**
 * Computes recurring prefixes across filenames to identify known categories or family-category pairs.
 * E.g., 'pipeline', 'flow', 'slides', 'docs', 'wiki'.
 */
export function getKnownPrefixes(filenames: string[]): string[] {
  const prefixCounts: Record<string, number> = {}
  const uniqueFilenames = Array.from(new Set(filenames.map(f => f.replace(/\.md$/, ""))))

  uniqueFilenames.forEach(name => {
    const parts = name.split("-")
    for (let i = 1; i < parts.length && i <= 2; i++) {
      const prefix = parts.slice(0, i).join("-")
      prefixCounts[prefix] = (prefixCounts[prefix] || 0) + 1
    }
  })

  // Prefixes appearing in >= 2 files are recurring categories/families
  return Object.keys(prefixCounts)
    .filter(prefix => prefixCounts[prefix] > 1)
    .sort((a, b) => b.length - a.length)
}

/**
 * Analyzes an agent filename against the naming convention:
 * [{family}-]{category}-{role_with_underscores}.md
 * 
 * Optionally accepts allFilenames to intelligently detect recurring category/family prefixes
 * (e.g. 'slides-html-writer' -> category='slides', role='html_writer').
 */
export function analyzeAgentName(filename: string, allFilenames?: string[]): NamingAnalysis {
  const cleanName = filename.replace(/\.md$/, "")
  const errors: string[] = []

  let family: string | undefined
  let category: string
  let rawRole: string

  // If allFilenames is supplied, find matching recurring prefix
  let matchedPrefix: string | undefined
  if (allFilenames && allFilenames.length > 0) {
    const knownPrefixes = getKnownPrefixes(allFilenames)
    matchedPrefix = knownPrefixes.find(p => cleanName === p || cleanName.startsWith(p + "-"))
  }

  if (matchedPrefix && cleanName !== matchedPrefix) {
    const prefixParts = matchedPrefix.split("-")
    if (prefixParts.length === 2) {
      family = prefixParts[0]
      category = prefixParts[1]
    } else {
      category = prefixParts[0]
    }
    rawRole = cleanName.substring(matchedPrefix.length + 1)
  } else {
    // Fallback: split by hyphens
    const parts = cleanName.split("-")
    if (parts.length < 2) {
      errors.push("Missing category separator (must be at least {category}-{role})")
      const rolePart = cleanName.replace(/[\s-]/g, "_")
      return {
        isValid: false,
        role: rolePart,
        errors,
        suggestedName: `general-${rolePart}.md`
      }
    }

    if (parts.length >= 3) {
      family = parts[0]
      category = parts[1]
      rawRole = parts.slice(2).join("-")
    } else {
      category = parts[0]
      rawRole = parts.slice(1).join("-")
    }
  }

  const suggestedRole = rawRole.replace(/[\s-]/g, "_")

  if (rawRole.includes("-") || rawRole.includes(" ")) {
    errors.push("Multi-word role uses hyphens/spaces instead of underscores ('_' required for role)")
  }

  const isValid = errors.length === 0
  const suggestedFilename = family
    ? `${family}-${category}-${suggestedRole}.md`
    : `${category}-${suggestedRole}.md`

  return {
    isValid,
    family,
    category,
    role: rawRole,
    errors,
    suggestedName: isValid ? filename : suggestedFilename
  }
}

/**
 * Renames an agent file and updates all cross-references in permission.task blocks across all agent files.
 */
export function renameAgent(
  workspaceRoot: string,
  oldPath: string,
  newFilename: string,
  agents: AgentInfo[]
): { success: boolean; updatedReferences: string[]; skipped: string[]; newPath: string; error?: string } {
  if (!newFilename.endsWith(".md")) {
    newFilename += ".md"
  }
  newFilename = sanitizeFilename(newFilename)

  const oldFilename = path.basename(oldPath)
  const oldNameNoExt = oldFilename.replace(/\.md$/, "")
  const newNameNoExt = newFilename.replace(/\.md$/, "")

  const dir = path.dirname(oldPath)
  const newPath = path.join(dir, newFilename)
  const resolvedDir = path.resolve(dir)
  if (!path.resolve(newPath).startsWith(resolvedDir + path.sep)) {
    throw new Error(`Invalid target path outside the agent directory: ${newFilename}`)
  }

  if (fs.existsSync(newPath) && oldPath !== newPath) {
    throw new Error(`Target file already exists: ${newPath}`)
  }

  // Prepare all reference updates before mutating the filesystem.
  const updatedReferences: string[] = []
  const skipped: string[] = []
  const pendingWrites: { filePath: string; frontmatter: Record<string, any>; body: string; frontmatterVersion: "v1" | "v2" | "unknown" }[] = []

  for (const agent of agents) {
    const filePath = agent.currentPath === oldPath ? newPath : agent.currentPath
    const readPath = agent.currentPath === oldPath ? oldPath : agent.currentPath
    if (!fs.existsSync(readPath)) continue

    const content = fs.readFileSync(readPath, "utf-8")
    if (!content.includes(oldNameNoExt)) continue

    const { yamlText, body } = extractFrontmatter(content)
    if (yamlText === null) {
      skipped.push(path.basename(filePath))
      continue
    }

    let frontmatter: Record<string, any>
    let frontmatterVersion: "v1" | "v2" | "unknown"
    try {
      const parsed = YAML.parse(yamlText)
      if (!isValidFrontmatter(parsed)) {
        skipped.push(path.basename(filePath))
        continue
      }
      frontmatterVersion = detectFrontmatterVersion(parsed)
      frontmatter = frontmatterVersion === "v2" ? translateFrontmatterV2ToV1(parsed) : parsed
    } catch (e) {
      skipped.push(path.basename(filePath))
      continue
    }

    let modified = false
    const taskPerm = frontmatter.permission?.task
    if (taskPerm && typeof taskPerm === "object" && !Array.isArray(taskPerm)) {
      if (oldNameNoExt in taskPerm) {
        const value = taskPerm[oldNameNoExt]
        delete taskPerm[oldNameNoExt]
        taskPerm[newNameNoExt] = value
        modified = true
      }
    }

    // Also check raw body references if old name appears as subagent call
    let newBody = body
    const referenceRegex = new RegExp("@" + escapeRegExp(oldNameNoExt) + "(?![A-Za-z0-9_-])", "g")
    if (referenceRegex.test(body)) {
      referenceRegex.lastIndex = 0
      newBody = body.replace(referenceRegex, `@${newNameNoExt}`)
      if (newBody !== body) {
        modified = true
      }
    }

    if (modified) {
      pendingWrites.push({ filePath, frontmatter, body: newBody, frontmatterVersion })
      updatedReferences.push(path.basename(filePath))
    }
  }

  // Rename is the last structural mutation; reference writes follow it.
  fs.renameSync(oldPath, newPath)
  try {
    for (const write of pendingWrites) {
      saveAgentFile(write.filePath, write.frontmatter, write.body, write.frontmatterVersion)
    }
  } catch (e: any) {
    return {
      success: false,
      updatedReferences: [],
      skipped,
      newPath,
      error: `Agent renamed, but reference updates were only partially flushed; restore the referencing agents from version control. ${e?.message || e}`
    }
  }

  return { success: true, updatedReferences, skipped, newPath }
}

export function sanitizeFilename(name: string): string {
  if (!name || name.startsWith(".") || name.includes("..") || name.includes("\0") || /[\\/]/.test(name) || !/^[a-zA-Z0-9._-]+$/.test(name)) {
    throw new Error(`Invalid filename '${name}'. Use only letters, numbers, '.', '_' and '-'.`)
  }
  return name
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// Ignore directories that are not related to agents
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".opencode",
  "agent-manager",
  "backups",
  "dist",
  "build"
])

/**
 * Dynamically desumes categories from a list of agent filenames.
 * If a prefix (split by '-') appears in more than 1 file, it is considered a category.
 * Longest prefix matches are preferred. Fallback is "general".
 */
export function computeCategories(filenames: string[]): Record<string, string> {
  const prefixCounts = countCategoryPrefixes(filenames)

  // Filter prefixes that appear in > 1 file
  const validPrefixes = Object.keys(prefixCounts)
    .filter(prefix => prefixCounts[prefix] > 1)
    .sort((a, b) => b.length - a.length) // longest first

  const mapping: Record<string, string> = {}
  filenames.forEach(filename => {
    const nameWithoutExt = filename.replace(/\.md$/, "")
    const match = validPrefixes.find(prefix =>
      nameWithoutExt === prefix || nameWithoutExt.startsWith(prefix + "-")
    )
    mapping[filename] = match || "general"
  })

  return mapping
}

/** Return the category prefixes recognised by computeCategories and their counts. */
export function getCategoryPrefixes(filenames: string[]): Array<{ prefix: string; count: number }> {
  return Object.entries(countCategoryPrefixes(filenames))
    .filter(([, count]) => count > 1)
    .sort(([a], [b]) => b.length - a.length)
    .map(([prefix, count]) => ({ prefix: `${prefix}-`, count }))
}

function countCategoryPrefixes(filenames: string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  Array.from(new Set(filenames)).forEach(filename => {
    const parts = filename.replace(/\.md$/, "").split("-")
    for (let i = 1; i < parts.length; i++) {
      const prefix = parts.slice(0, i).join("-")
      counts[prefix] = (counts[prefix] || 0) + 1
    }
  })
  return counts
}

/**
 * Recursively find all agent markdown files in the workspace (under any folder named 'agents').
 * Also discovers agents in V2 'mode' and 'modes' directories (which represent primary agents).
 */
export function findAgentFiles(workspaceRoot: string, sourceDir?: string): AgentList {
  const resolvedSourceDir = sourceDir || resolveSourceSubdir(workspaceRoot)
  if (!isWorkspaceRelativePath(resolvedSourceDir)) {
    throw new Error(`sourceDir must stay inside workspace; received '${resolvedSourceDir}'`)
  }
  const resolvedRoot = path.resolve(workspaceRoot)
  const sourceRoot = path.resolve(resolvedRoot, resolvedSourceDir)
  if (!isPathInsideWorkspace(workspaceRoot, resolvedSourceDir)) {
    throw new Error(`sourceDir must stay inside workspace; received '${resolvedSourceDir}'`)
  }
  if (!fs.existsSync(sourceRoot) || !fs.lstatSync(sourceRoot).isDirectory() || fs.lstatSync(sourceRoot).isSymbolicLink()) {
    throw new Error(`Agent source directory does not exist: ${sourceRoot} (sourceDir='${resolvedSourceDir}')`)
  }
  const agents: AgentInfo[] = []
  const skippedLinks: string[] = []

  /** agentDir: the agents/, agent/, mode/ or modes/ directory the walk is inside, if any (agents may be nested). */
  function walk(dir: string, agentDir: string | null = null) {
    const basename = path.basename(dir)
    if (IGNORED_DIRS.has(basename)) {
      return
    }

    let stats: fs.Stats
    try {
      stats = fs.lstatSync(dir)
    } catch {
      return
    }

    // Discovery must never follow links: a linked directory could expose
    // files outside the selected workspace and a linked markdown file could
    // make an edit land on an unexpected target. Links are skipped and reported.
    if (stats.isSymbolicLink()) {
      skippedLinks.push(dir)
      return
    }

    if (stats.isDirectory()) {
      const files = fs.readdirSync(dir)
      // V2 compatibility: 'agents', 'agent', 'mode', 'modes' are all valid agent directories
      const agentKind = agentDir ?? (basename === "agents" || basename === "agent" || basename === "mode" || basename === "modes" ? basename : null)
      const isAgentsDir = agentKind !== null

      for (const file of files) {
        const fullPath = path.join(dir, file)
        const childStat = fs.lstatSync(fullPath)
        if (childStat.isSymbolicLink()) {
          if (isAgentsDir || childStat.isDirectory()) skippedLinks.push(fullPath)
          continue
        }
        if (isAgentsDir && file.endsWith(".md")) {
          try {
            const agent = parseAgentFile(fullPath, workspaceRoot)
            if (agent) {
              // V2: agents in 'mode' or 'modes' directories are primary agents
              if ((agentKind === "mode" || agentKind === "modes") && !agent.frontmatter.mode) {
                agent.frontmatter.mode = "primary"
              }
              agents.push(agent)
            }
          } catch (e) {
            console.error(`Error parsing agent file ${file}:`, e)
          }
        } else {
          walk(fullPath, agentKind)
        }
      }
    }
  }

  walk(sourceRoot)
  const warnings = [
    ...(agents.length === 0 ? [`No agents found under sourceDir '${resolvedSourceDir}' (${sourceRoot})`] : []),
    ...skippedLinks.map(link => `Skipped symlink ${path.relative(workspaceRoot, link)}: agents are never read or edited through links`),
  ]
  if (warnings.length) (agents as AgentList).warnings = warnings

  // The category is the pack holding the agent; outside any pack it comes from the filename prefixes.
  const categoryMap = computeCategories(agents.map(a => a.filename))
  for (const agent of agents) agent.category = packNameOf(agent.currentPath, workspaceRoot) ?? categoryMap[agent.filename]

  return agents
}

/**
 * Parse an agent markdown file to extract frontmatter and content.
 */
export function parseAgentFile(filePath: string, workspaceRoot: string): AgentInfo | null {
  if (!fs.existsSync(filePath)) return null

  const content = fs.readFileSync(filePath, "utf-8")
  const filename = path.basename(filePath)

  let frontmatter: Record<string, any> = {}
  let body = content
  let frontmatterVersion: "v1" | "v2" | "unknown" = "unknown"

  const { yamlText, body: contentBody } = extractFrontmatter(content)
  if (yamlText !== null) {
    body = contentBody
    try {
      const parsed = YAML.parse(yamlText)
      if (isValidFrontmatter(parsed)) {
        // Normalize V2 frontmatter to V1 for internal use. A bare `model#variant`
        // is V2 syntax even when no other V2-only field is present.
        const detected = detectFrontmatterVersion(parsed)
        frontmatterVersion = detected === "unknown" && typeof parsed.model === "string" && parsed.model.includes("#")
          ? "v2"
          : detected
        frontmatter = frontmatterVersion === "v2" ? translateFrontmatterV2ToV1(parsed) : parsed
      }
    } catch (e) {
      console.error(`YAML parsing error in ${filePath}:`, e)
    }
  }

  const category = packNameOf(filePath, workspaceRoot) ?? detectCategory(filename)
  const targetPath = filePath

  // Parse permission.task to extract allowed subagents list
  const allowedSubagents: string[] = []
  const taskPerm = frontmatter.permission?.task
  if (taskPerm && typeof taskPerm === "object" && !Array.isArray(taskPerm)) {
    for (const [name, value] of Object.entries(taskPerm)) {
      if (name !== "*" && (value === "allow" || value === true)) {
        allowedSubagents.push(name)
      }
    }
  }

  return {
    filename,
    currentPath: filePath,
    targetPath,
    category,
    description: frontmatter.description || "",
    model: frontmatter.model || "",
    rawContent: content,
    frontmatter,
    body,
    allowedSubagents,
    frontmatterVersion
  }
}

/**
 * Detect category from agent filename prefix (fallback/backwards compatibility).
 */
export function detectCategory(filename: string, allFilenames?: string[]): string {
  if (allFilenames) {
    const map = computeCategories(allFilenames)
    return map[filename] || "general"
  }
  const parts = filename.replace(/\.md$/, "").split("-")
  if (parts.length > 1) {
    return parts[0]
  }
  return "general"
}

/**
 * Write updated frontmatter and body back to an agent file.
 */
export function normalizeAgentBody(body: string): string {
  return body.replace(/^(?:[ \t]*\r?\n)+/, "")
}

export function saveAgentFile(filePath: string, frontmatter: Record<string, any>, body: string, originalVersion?: "v1" | "v2" | "unknown") {
  if (!isValidFrontmatter(frontmatter)) {
    throw new Error(`Invalid frontmatter for agent file: ${filePath}`)
  }
  const content = renderAgentFile(frontmatter, body, originalVersion)
  atomicWriteAgentFile(filePath, Buffer.from(content, "utf8"))
}

/** Fold a V1 `variant` into `model#variant`, never appending `#` twice. */
export function composeModelVariant(frontmatter: Record<string, any>): Record<string, any> {
  if (!Object.prototype.hasOwnProperty.call(frontmatter, "variant")) return frontmatter
  const variant = frontmatter.variant
  const baseModel = typeof frontmatter.model === "string" ? frontmatter.model.split("#")[0] : ""
  delete frontmatter.variant
  frontmatter.model = variant === undefined || variant === null || variant === "" ? baseModel : `${baseModel}#${variant}`
  return frontmatter
}

export function renderAgentFile(frontmatter: Record<string, any>, body: string, _originalVersion?: "v1" | "v2" | "unknown"): string {
  // The write boundary always emits V2; the original version is advisory only.
  const frontmatterToWrite = translateFrontmatterV1ToV2(frontmatter)
  const yamlText = YAML.stringify(frontmatterToWrite).trim()
  const normalizedBody = normalizeAgentBody(body)
  return normalizedBody ? `---\n${yamlText}\n---\n\n${normalizedBody}` : `---\n${yamlText}\n---\n`
}

function atomicWriteAgentFile(filePath: string, bytes: Buffer): void {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  let mode = 0o666
  const target = fs.lstatSync(filePath, { throwIfNoEntry: false })
  if (target) {
    if (target.isSymbolicLink() || !target.isFile()) throw new Error(`Refusing to replace non-regular agent file: ${filePath}`)
    mode = target.mode & 0o7777
  }

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`)
    let fd: number | undefined
    let owned = false
    try {
      fd = fs.openSync(tempPath, "wx", mode)
      owned = true
      let offset = 0
      while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset)
      fs.fchmodSync(fd, mode)
      fs.closeSync(fd)
      fd = undefined
      fs.renameSync(tempPath, filePath)
      return
    } catch (error: any) {
      if (fd !== undefined) fs.closeSync(fd)
      if (owned) { try { fs.unlinkSync(tempPath) } catch {} }
      if (error?.code === "EEXIST") continue
      throw error
    }
  }
  throw new Error(`Unable to allocate a temporary agent file for ${filePath}`)
}

/**
 * Batch update the model of multiple agents.
 */
export function updateAgentsModel(agents: AgentInfo[], model: string, verifiedModels: string[] = [], writer = saveAgentFile) {
  if (!verifiedModels.includes(model)) throw new Error(`Model is not present in refreshed catalog: ${model}`)
  const originals = new Map<string, { bytes: Buffer; stat: fs.Stats }>()
  const expected = new Map<string, { bytes: Buffer; mode: number }>()
  const snapshots = new Map<AgentInfo, { model: string; frontmatter: Record<string, any>; frontmatterContent: Record<string, any>; rawContent: string; frontmatterVersion?: "v1" | "v2" | "unknown" }>()
  for (const agent of agents) {
    const disk = parseAgentFile(agent.currentPath, path.dirname(path.dirname(path.dirname(agent.currentPath))))
    const bytes = fs.readFileSync(agent.currentPath)
    if (!disk || disk.frontmatter.model !== agent.frontmatter.model || !bytes.equals(Buffer.from(agent.rawContent, "utf8"))) {
      throw new Error(`Agent changed on disk before model update: ${agent.filename}`)
    }
    originals.set(agent.currentPath, { bytes, stat: fs.statSync(agent.currentPath) })
    snapshots.set(agent, { model: agent.model, frontmatter: agent.frontmatter, frontmatterContent: structuredClone(agent.frontmatter), rawContent: agent.rawContent })
  }
  const attempted: string[] = []
  try {
    for (const agent of agents) {
      attempted.push(agent.currentPath)
      const updatedFrontmatter = { ...agent.frontmatter, model }
      const writeFrontmatter = composeModelVariant({ ...updatedFrontmatter })
      expected.set(agent.currentPath, { bytes: Buffer.from(renderAgentFile(writeFrontmatter, agent.body, agent.frontmatterVersion)), mode: originals.get(agent.currentPath)!.stat.mode & 0o7777 })
      writer(agent.currentPath, writeFrontmatter, agent.body, agent.frontmatterVersion)
    }
    for (const agent of agents) {
      agent.model = model
      agent.frontmatter = { ...agent.frontmatter, model }
      agent.rawContent = fs.readFileSync(agent.currentPath, "utf8")
    }
  } catch (error: any) {
    const failures: string[] = []
    for (const filePath of [...attempted].reverse()) {
      try {
        const current = fs.lstatSync(filePath)
        const original = originals.get(filePath)!
        const manager = expected.get(filePath)
        if (current.isSymbolicLink() || !current.isFile()) throw new Error("path is no longer a regular file")
        if (!manager || !fs.readFileSync(filePath).equals(manager.bytes) || (current.mode & 0o7777) !== manager.mode) throw new Error("rollback conflict: file changed after manager write")
        atomicWriteAgentFile(filePath, original.bytes)
        fs.chmodSync(filePath, original.stat.mode & 0o7777)
      } catch (restoreError: any) { failures.push(`${filePath}: ${restoreError?.message || restoreError}`) }
    }
    for (const [agent, snapshot] of snapshots) {
      const restored = (() => { try { return fs.readFileSync(agent.currentPath).equals(snapshot.rawContent ? Buffer.from(snapshot.rawContent) : Buffer.alloc(0)) } catch { return false } })()
      if (!restored && !failures.some(failure => failure.startsWith(`${agent.currentPath}:`))) {
        try {
          const disk = parseAgentFile(agent.currentPath, path.dirname(path.dirname(path.dirname(agent.currentPath))))
          if (disk) { agent.model = disk.model; agent.frontmatter = disk.frontmatter; agent.rawContent = disk.rawContent }
        } catch {}
        continue
      }
      agent.model = snapshot.model
      agent.frontmatter = snapshot.frontmatter
      for (const key of Object.keys(agent.frontmatter)) delete agent.frontmatter[key]
      Object.assign(agent.frontmatter, structuredClone(snapshot.frontmatterContent))
      agent.rawContent = snapshot.rawContent
    }
    const suffix = failures.length ? `; rollback incomplete: ${failures.join("; ")}` : "; rollback completed"
    const rollbackError = new Error(`${error?.message || error}${suffix}`)
    ;(rollbackError as any).cause = error
    throw rollbackError
  }
}

export type ModelRepairMapping = { oldModel: unknown; newModel: string; agentPaths: string[] }

/** Validate all groups and on-disk sources before changing any model. */
export function repairAgentModels(agents: AgentInfo[], mappings: ModelRepairMapping[], verifiedModels: string[], writer = saveAgentFile) {
  const catalog = new Set(verifiedModels)
  const paths = new Set<string>()
  const originals = new Map<string, Buffer>()
  const expected = new Map<string, { bytes: Buffer; mode: number }>()
  const snapshots = new Map<AgentInfo, { model: string; frontmatter: Record<string, any>; frontmatterContent: Record<string, any>; rawContent: string; frontmatterVersion: "v1" | "v2" | "unknown" }>()
  for (const mapping of mappings) {
    if (!catalog.has(mapping.newModel)) throw new Error(`Replacement is not present in refreshed catalog: ${mapping.newModel}`)
    for (const agentPath of mapping.agentPaths) {
      if (paths.has(agentPath)) throw new Error(`Agent appears in more than one repair group: ${agentPath}`)
      paths.add(agentPath)
      const agent = agents.find(item => item.currentPath === agentPath)
      if (!agent) throw new Error(`Unknown agent path: ${agentPath}`)
      const current = agent.frontmatter.model
      if (current !== mapping.oldModel || (typeof current === "string" && current !== agent.model)) {
        throw new Error(`Agent changed on disk before repair: ${agent.filename}`)
      }
      const currentBytes = fs.readFileSync(agentPath)
      if (!currentBytes.equals(Buffer.from(agent.rawContent, "utf8"))) {
        throw new Error(`Agent changed on disk before repair: ${agent.filename}`)
      }
      const { yamlText } = extractFrontmatter(currentBytes.toString("utf8"))
      let diskFrontmatter: Record<string, any> = {}
      let diskFrontmatterVersion: "v1" | "v2" | "unknown" = "unknown"
      try {
        const parsed = yamlText === null ? null : YAML.parse(yamlText)
        if (isValidFrontmatter(parsed)) {
          diskFrontmatterVersion = detectFrontmatterVersion(parsed)
          diskFrontmatter = diskFrontmatterVersion === "v2" ? translateFrontmatterV2ToV1(parsed) : parsed
        }
      } catch {
        // Keep the empty frontmatter so the model validation below rejects it.
      }
      if (diskFrontmatter.model !== mapping.oldModel) throw new Error(`Agent changed on disk before repair: ${agent.filename}`)
      originals.set(agentPath, currentBytes)
      snapshots.set(agent, {
        model: agent.model,
        frontmatter: agent.frontmatter,
        frontmatterContent: structuredClone(agent.frontmatter),
        rawContent: agent.rawContent,
        frontmatterVersion: diskFrontmatterVersion
      })
    }
  }
  const attempted: string[] = []
  try {
    for (const mapping of mappings) {
      for (const agentPath of mapping.agentPaths) {
        const agent = agents.find(item => item.currentPath === agentPath)!
        attempted.push(agentPath)
        const updatedFrontmatter = { ...agent.frontmatter, model: mapping.newModel }
        const frontmatterVersion = snapshots.get(agent)!.frontmatterVersion
        expected.set(agentPath, { bytes: Buffer.from(renderAgentFile(updatedFrontmatter, agent.body, frontmatterVersion)), mode: fs.lstatSync(agentPath).mode & 0o7777 })
        writer(agent.currentPath, updatedFrontmatter, agent.body, frontmatterVersion)
      }
    }
    for (const mapping of mappings) {
      for (const agentPath of mapping.agentPaths) {
        const agent = agents.find(item => item.currentPath === agentPath)!
        agent.model = mapping.newModel
        agent.frontmatter = { ...agent.frontmatter, model: mapping.newModel }
        agent.rawContent = fs.readFileSync(agent.currentPath, "utf8")
      }
    }
  } catch (error: any) {
    const restorationFailures: string[] = []
    for (const agentPath of [...attempted].reverse()) {
      try {
        const current = fs.lstatSync(agentPath)
        const manager = expected.get(agentPath)
        if (current.isSymbolicLink() || !current.isFile() || !manager || !fs.readFileSync(agentPath).equals(manager.bytes) || (current.mode & 0o7777) !== manager.mode) throw new Error("rollback conflict: file changed after manager write")
        atomicWriteAgentFile(agentPath, originals.get(agentPath)!)
      } catch (restoreError: any) {
        restorationFailures.push(`${agentPath}: ${restoreError?.message || restoreError}`)
      }
    }
    for (const [agent, snapshot] of snapshots) {
      try {
        agent.model = snapshot.model
        agent.frontmatter = snapshot.frontmatter
        for (const key of Object.keys(agent.frontmatter)) delete agent.frontmatter[key]
        Object.assign(agent.frontmatter, structuredClone(snapshot.frontmatterContent))
        agent.rawContent = snapshot.rawContent
      } catch (restoreError: any) {
        restorationFailures.push(`${agent.filename} memory: ${restoreError?.message || restoreError}`)
      }
    }
    const status = restorationFailures.length === 0 ? "completed" : "incomplete"
    const details = restorationFailures.length > 0 ? `: ${restorationFailures.join("; ")}` : ""
    const rollbackError = new Error(`${error?.message || error}; rollback ${status}${details}`)
    ;(rollbackError as any).cause = error
    throw rollbackError
  }
  return { groups: mappings.length, agentsChanged: attempted.length }
}

/**
 * Batch update the color of multiple agents.
 */
export function updateAgentsColor(agents: AgentInfo[], color: string) {
  for (const agent of agents) {
    const updatedFrontmatter = { ...agent.frontmatter, color }
    saveAgentFile(agent.currentPath, updatedFrontmatter, agent.body, agent.frontmatterVersion)
    agent.frontmatter = updatedFrontmatter
  }
}

export function atomicWriteRestrictedFile(filePath: string, bytes: Buffer, mode = 0o600): void {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  const target = fs.lstatSync(filePath, { throwIfNoEntry: false })
  if (target && (target.isSymbolicLink() || !target.isFile())) {
    throw new Error(`Refusing to replace non-regular file: ${filePath}`)
  }

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`)
    let fd: number | undefined
    let owned = false
    try {
      fd = fs.openSync(tempPath, "wx", mode)
      owned = true
      let offset = 0
      while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset)
      fs.fchmodSync(fd, mode)
      fs.closeSync(fd)
      fd = undefined
      fs.renameSync(tempPath, filePath)
      fs.chmodSync(filePath, mode)
      return
    } catch (error: any) {
      if (fd !== undefined) fs.closeSync(fd)
      if (owned) { try { fs.unlinkSync(tempPath) } catch {} }
      if (error?.code === "EEXIST") continue
      throw error
    }
  }
  throw new Error(`Unable to allocate a temporary file for ${filePath}`)
}

/**
 * Get the opencode agents destination path (portable: uses os.homedir()).
 */
export function getExportDestination(env: NodeJS.ProcessEnv = process.env): string {
  const configHome = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  return path.join(configHome, "opencode", "agents")
}
