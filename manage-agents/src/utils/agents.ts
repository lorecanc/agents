import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { randomBytes } from "node:crypto"
import YAML from "yaml"
import { isPathInsideWorkspace, isWorkspaceRelativePath } from "./pathValidation.js"
import { detectFrontmatterVersion, translateFrontmatterV1ToV2, translateFrontmatterV2ToV1 } from "./v2Compat.js"
import { discoverAvailableCategoryCompanionItems, getCategoryCompanionLinks, type SelectableCompanionItem } from "./companionLinks.js"

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

export function resolveSourceSubdir(workspaceRoot: string): string {
  return fs.existsSync(path.join(workspaceRoot, "src")) ? "src" : "general"
}

export function resolveCategoriesSubdir(workspaceRoot: string): string {
  return fs.existsSync(path.join(workspaceRoot, "export")) || fs.existsSync(path.join(workspaceRoot, "src"))
    ? path.join("export", "categories")
    : "categories"
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
  companionFiles: string[]
  categoryCompanionItems?: SelectableCompanionItem[]
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
  mcpEnabled?: Record<string, boolean>
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

function resolveWorkspaceRootFromSourceRoot(sourceRoot: string): string {
  const resolved = path.resolve(sourceRoot)
  const parentName = path.basename(path.dirname(resolved))
  if (parentName === "categories") {
    const categoriesParent = path.dirname(path.dirname(resolved))
    return path.basename(categoriesParent) === "export" ? path.dirname(categoriesParent) : categoriesParent
  }
  return path.dirname(resolved)
}

function inferAgentResourceRoot(agent: AgentInfo, resourceSourceRoot: string): string {
  const agentPath = path.resolve(agent.currentPath)
  const parts = agentPath.split(path.sep)
  const agentsIndex = parts.lastIndexOf("agents")
  if (agentsIndex < 2 || agentsIndex !== parts.length - 2) return path.resolve(resourceSourceRoot)
  const bundleRoot = path.dirname(path.dirname(agentPath))
  if (path.basename(path.dirname(bundleRoot)) !== "categories") return path.resolve(resourceSourceRoot)
  return bundleRoot
}

export function discoverAgentResources(
  workspaceRoot: string,
  agent: AgentInfo,
  allAgents?: AgentInfo[],
  env: NodeJS.ProcessEnv = process.env
): AgentResourceCatalog {
  const generalDir = path.join(workspaceRoot, resolveSourceSubdir(workspaceRoot))
  const resourceRoot = inferAgentResourceRoot(agent, generalDir)
  const generalStat = resourcePathStat(resourceRoot)
  if (generalStat && !generalStat.isDirectory()) throw new Error(`Resource root is not a directory: ${resourceRoot}`)
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

  const skillRoot = path.join(resourceRoot, "skills")
  const skillRootStat = resourcePathStat(skillRoot)
  if (skillRootStat && !skillRootStat.isDirectory()) throw new Error(`Skills resource root is not a directory: ${skillRoot}`)
  const diskSkillNames = new Set<string>()
  if (skillRootStat) {
    for (const entry of fs.readdirSync(skillRoot)) {
      const entryPath = path.join(skillRoot, entry)
      const entryStat = resourcePathStat(entryPath)
      if (!entryStat?.isDirectory()) continue
      const skillFile = path.join(entryPath, "SKILL.md")
      const skillFileStat = resourcePathStat(skillFile)
      if (skillFileStat?.isFile()) {
        diskSkillNames.add(entry)
        skillNames.add(entry)
      }
    }
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
  const toolRoot = path.join(resourceRoot, "tools")
  const toolRootStat = resourcePathStat(toolRoot)
  if (toolRootStat && !toolRootStat.isDirectory()) throw new Error(`Tools resource root is not a directory: ${toolRoot}`)
  const toolNames = new Set<string>()
  if (toolRootStat) {
    for (const entry of fs.readdirSync(toolRoot)) {
      if (!entry.endsWith(".ts") || entry.endsWith(".d.ts") || entry.endsWith(".test.ts")) continue
      const entryPath = path.join(toolRoot, entry)
      if (resourcePathStat(entryPath)?.isFile()) toolNames.add(entry.slice(0, -3))
    }
  }
  const families = new Map<string, string[]>()
  const standalone: string[] = []
  for (const name of toolNames) {
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
      tools.push({
        id: `tool:${name}`, kind: "tool", name, permissionKey: name, allowed, exists: true,
        relativePath: path.join("tools", `${name}.ts`), familyKey
      })
    }
  }
  for (const name of standalone.sort((a, b) => a.localeCompare(b))) {
    tools.push({
      id: `tool:${name}`, kind: "tool", name, permissionKey: name, allowed: allowedValue(perm[name]), exists: true,
      relativePath: path.join("tools", `${name}.ts`)
    })
  }

  const opencodePath = getGlobalOpenCodeConfigPath(env)
  const opencodeStat = resourcePathStat(opencodePath)
  let opencodeRawContent: string | null = null
  let globalOpencode: Record<string, any> = {}
  if (opencodeStat) {
    if (!opencodeStat.isFile()) throw new Error(`OpenCode config is not a regular file: ${opencodePath}`)
    opencodeRawContent = fs.readFileSync(opencodePath, "utf8")
    globalOpencode = parseOpenCodeJson(opencodeRawContent, opencodePath)
  }
  const globalMcpObj = isPlainObject(globalOpencode.mcp) ? globalOpencode.mcp : {}
  const repoOpencodePath = path.join(resourceRoot, "opencode.json")
  const repoOpencodeStat = resourcePathStat(repoOpencodePath)
  let repoOpencode: Record<string, any> = {}
  if (repoOpencodeStat) {
    if (!repoOpencodeStat.isFile()) throw new Error(`OpenCode config is not a regular file: ${repoOpencodePath}`)
    repoOpencode = parseOpenCodeJson(fs.readFileSync(repoOpencodePath, "utf8"), repoOpencodePath)
  }
  const repoMcpObj = isPlainObject(repoOpencode.mcp) ? repoOpencode.mcp : {}
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
      serverEnabled: configuredInOpencode ? globalMcpObj[serverKey]?.enabled !== false : false,
      configuredInOpencode, recommendedInRepo,
      serverType: typeof rawEntry?.type === "string" ? rawEntry.type : undefined,
      serverTarget: typeof rawEntry?.url === "string" ? rawEntry.url : Array.isArray(rawEntry?.command) ? rawEntry.command.join(" ") : undefined
    }
  })

  return {
    skills, tools, mcpServers,
    companionFiles: discoverCompanionResourcePaths(resourceRoot, [agentDomain(agent.filename), agent.category], undefined, [agent]),
    categoryCompanionItems: discoverAvailableCategoryCompanionItems(workspaceRoot, agent.category),
    opencodeRawContent, opencodeConfigPath: opencodePath, recommendedMcpServers
  }
}

export function updateAgentResourcesAndMcp(
  workspaceRoot: string,
  agent: AgentInfo,
  catalog: AgentResourceCatalog,
  changes: AgentResourceChanges,
  env: NodeJS.ProcessEnv = process.env
): { changedPaths: string[] } {
  const hasPermissions = Object.keys(changes.permissions ?? {}).length > 0
  const hasMcpChanges = Object.keys(changes.mcpEnabled ?? {}).length > 0
  if (!changes.skills && !hasPermissions && !hasMcpChanges) return { changedPaths: [] }

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
  for (const key of Object.keys(changes.mcpEnabled ?? {})) {
    if (!catalog.mcpServers.some(item => item.serverKey === key && (item.configuredInOpencode || item.recommendedInRepo))) {
      throw new Error(`Unknown configured MCP server: ${key}`)
    }
  }

  const agentPath = agent.currentPath
  const opencodePath = catalog.opencodeConfigPath ?? getGlobalOpenCodeConfigPath(env)
  const changesAgent = !!changes.skills || hasPermissions
  let originalAgent: Buffer | undefined
  let agentMode: number | undefined
  let originalOpencode: Buffer | undefined
  if (changesAgent) {
    const stat = fs.lstatSync(agentPath)
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Refusing to update non-regular agent file: ${agentPath}`)
    originalAgent = fs.readFileSync(agentPath)
    if (originalAgent.toString("utf8") !== agent.rawContent) throw new Error(`Agent changed on disk before resource update: ${agent.filename}`)
    agentMode = stat.mode & 0o7777
  }
  if (hasMcpChanges) {
    const stat = resourcePathStat(opencodePath)
    if (catalog.opencodeRawContent !== null) {
      if (!stat?.isFile() || fs.readFileSync(opencodePath, "utf8") !== catalog.opencodeRawContent) {
        throw new Error("OpenCode config changed on disk before MCP update")
      }
      originalOpencode = Buffer.from(catalog.opencodeRawContent, "utf8")
    } else if (stat) {
      throw new Error("OpenCode config changed on disk before MCP update")
    } else if (Object.keys(changes.mcpEnabled ?? {}).some(key => !isPlainObject(catalog.recommendedMcpServers?.[key]))) {
      throw new Error(`OpenCode config does not exist: ${opencodePath}`)
    }
  }

  let updatedFrontmatter: Record<string, any> | undefined
  let renderedAgent: string | undefined
  if (changesAgent) {
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
    updatedFrontmatter = { ...agent.frontmatter, permission: existingPerm }
    renderedAgent = renderAgentFile(updatedFrontmatter, agent.body, agent.frontmatterVersion)
  }

  let renderedOpencode: string | undefined
  if (hasMcpChanges) {
    const parsed = catalog.opencodeRawContent !== null
      ? parseOpenCodeJson(catalog.opencodeRawContent, opencodePath)
      : { $schema: "https://opencode.ai/config.json", mcp: {} }
    if (!isPlainObject(parsed.mcp)) parsed.mcp = {}
    for (const [serverKey, enabled] of Object.entries(changes.mcpEnabled ?? {})) {
      if (!isPlainObject(parsed.mcp[serverKey])) {
        const seed = catalog.recommendedMcpServers?.[serverKey]
        if (isPlainObject(seed)) parsed.mcp[serverKey] = JSON.parse(JSON.stringify(seed))
      }
      if (!isPlainObject(parsed.mcp[serverKey])) throw new Error(`Invalid MCP server configuration: ${serverKey}`)
      parsed.mcp[serverKey].enabled = Boolean(enabled)
    }
    renderedOpencode = `${JSON.stringify(parsed, null, 2)}\n`
  }

  const changedPaths: string[] = []
  const agentBytes = renderedAgent === undefined ? undefined : Buffer.from(renderedAgent, "utf8")
  const opencodeBytes = renderedOpencode === undefined ? undefined : Buffer.from(renderedOpencode, "utf8")
  const agentChanged = !!(agentBytes && originalAgent && !agentBytes.equals(originalAgent))
  const opencodeChanged = !!(opencodeBytes && (!originalOpencode || !opencodeBytes.equals(originalOpencode)))
  let agentWritten = false
  let opencodeWritten = false
  try {
    if (agentChanged) {
      atomicWriteAgentFile(agentPath, agentBytes!)
      agentWritten = true
      changedPaths.push(agentPath)
    }
    if (opencodeChanged) {
      fs.mkdirSync(path.dirname(opencodePath), { recursive: true })
      atomicWriteAgentFile(opencodePath, opencodeBytes!)
      opencodeWritten = true
      changedPaths.push(opencodePath)
    }
  } catch (error: any) {
    if (opencodeWritten) {
      try {
        if (catalog.opencodeRawContent === null) fs.unlinkSync(opencodePath)
        else atomicWriteAgentFile(opencodePath, Buffer.from(catalog.opencodeRawContent, "utf8"))
      } catch (rollbackError: any) {
        throw new Error(`${error?.message || error}; rollback incomplete: ${rollbackError?.message || rollbackError}`)
      }
    }
    if (agentWritten) {
      try {
        atomicWriteAgentFile(agentPath, originalAgent!)
        fs.chmodSync(agentPath, agentMode!)
      } catch (rollbackError: any) {
        throw new Error(`${error?.message || error}; rollback incomplete: ${rollbackError?.message || rollbackError}`)
      }
      throw new Error(`${error?.message || error}; rollback completed`)
    }
    throw error
  }
  if (updatedFrontmatter && renderedAgent !== undefined) {
    agent.frontmatter = updatedFrontmatter
    agent.rawContent = renderedAgent
  }
  return { changedPaths }
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

    saveAgentFile(agent.currentPath, updatedFrontmatter, agent.body, agent.frontmatterVersion)
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

export interface AgentDiffResult {
  filename: string
  localPath: string
  exportPath: string
  existsLocally: boolean
  existsInExport: boolean
  hasDifferences: boolean
  localContent: string
  exportContent: string
}

export interface CompanionResourceDiff {
  relativePath: string
  localPath: string
  exportPath: string
  existsLocally: boolean
  existsInExport: boolean
  hasDifferences: boolean
}

export interface ImportPreview {
  agents: AgentDiffResult[]
  companionResources: CompanionResourceDiff[]
}

export interface ImportResult {
  imported: string[]
  importedResources: string[]
  backupPath: string | null
}

export function compareAgentWithExport(agent: AgentInfo): AgentDiffResult {
  const exportDir = getExportDestination()
  const exportPath = path.join(exportDir, agent.filename)

  if (!fs.existsSync(exportPath)) {
    return {
      filename: agent.filename,
      localPath: agent.currentPath,
      exportPath,
      existsLocally: true,
      existsInExport: false,
      hasDifferences: true,
      localContent: agent.rawContent,
      exportContent: ""
    }
  }

  const exportContent = fs.readFileSync(exportPath, "utf-8")
  const hasDifferences = agent.rawContent !== exportContent

  return {
    filename: agent.filename,
    localPath: agent.currentPath,
    exportPath,
    existsLocally: true,
    existsInExport: true,
    hasDifferences,
    localContent: agent.rawContent,
    exportContent
  }
}

function validateImportFile(filePath: string): fs.Stats | undefined {
  const stat = fs.lstatSync(filePath, { throwIfNoEntry: false })
  if (stat && (stat.isSymbolicLink() || !stat.isFile())) throw new Error(`Refusing to import symlink or non-regular file: ${filePath}`)
  return stat
}

function validateImportDestination(workspaceRoot: string, filePath: string): void {
  const generalRoot = path.resolve(workspaceRoot, resolveSourceSubdir(workspaceRoot))
  const resolvedPath = path.resolve(filePath)
  const relative = path.relative(generalRoot, resolvedPath)
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error(`Refusing import destination outside ${path.basename(generalRoot)}/: ${filePath}`)
  }

  let current = generalRoot
  const components = relative.split(path.sep).filter(Boolean)
  for (const component of components.slice(0, -1)) {
    current = path.join(current, component)
    const stat = fs.lstatSync(current, { throwIfNoEntry: false })
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) throw new Error(`Refusing import through symlink or non-directory path: ${current}`)
  }
  validateImportFile(resolvedPath)
}

function validateImportDirectory(directoryPath: string): void {
  const stat = fs.lstatSync(directoryPath, { throwIfNoEntry: false })
  if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) throw new Error(`Refusing import through symlink or non-directory path: ${directoryPath}`)
}

export function previewImport(workspaceRoot: string): ImportPreview {
  const sourceDir = path.join(workspaceRoot, resolveSourceSubdir(workspaceRoot))
  const agentsDir = path.join(sourceDir, "agents")
  const exportDir = getExportDestination()
  validateImportDirectory(sourceDir)
  validateImportDestination(workspaceRoot, path.join(agentsDir, ".validation"))
  validateImportDirectory(agentsDir)
  validateImportDirectory(path.dirname(exportDir))
  validateImportDirectory(exportDir)
  const localAgents = fs.existsSync(agentsDir)
    ? fs.readdirSync(agentsDir).filter(filename => filename.endsWith(".md")).map(filename => {
      const filePath = path.join(agentsDir, filename)
      validateImportDestination(workspaceRoot, filePath)
      return parseAgentFile(filePath, workspaceRoot)
    }).filter((agent): agent is AgentInfo => !!agent)
    : []
  const byFilename = new Map<string, AgentInfo>(localAgents.map(agent => [agent.filename, agent]))
  if (fs.existsSync(exportDir)) {
    for (const filename of fs.readdirSync(exportDir).filter(name => name.endsWith(".md"))) {
      validateImportFile(path.join(exportDir, filename))
      if (!byFilename.has(filename)) {
        byFilename.set(filename, {
          filename, currentPath: "", targetPath: "", category: "", description: "", model: "", rawContent: "",
          frontmatter: {}, body: "", allowedSubagents: []
        })
      }
    }
  }
  const agents = [...byFilename.keys()].sort().map(filename => {
    const agent = byFilename.get(filename)!
    if (agent.currentPath) {
      validateImportDestination(workspaceRoot, agent.currentPath)
      const exportPath = path.join(exportDir, filename)
      validateImportFile(exportPath)
      return compareAgentWithExport(agent)
    }
    const exportPath = path.join(exportDir, filename)
    validateImportFile(exportPath)
    return { filename, localPath: path.join(agentsDir, filename), exportPath, existsLocally: false, existsInExport: true,
      hasDifferences: true, localContent: "", exportContent: fs.readFileSync(exportPath, "utf8") }
  })
  return { agents, companionResources: compareCompanionResources(workspaceRoot) }
}

export function importAgents(
  workspaceRoot: string,
  selectedFilenames?: string[],
  options?: { includeResources?: boolean; selectedResources?: string[] }
): ImportResult {
  const preview = previewImport(workspaceRoot)
  const selected = selectedFilenames && selectedFilenames.length > 0 ? new Set(selectedFilenames) : null
  const agents = preview.agents.filter(diff => diff.existsInExport && diff.hasDifferences && (!selected || selected.has(diff.filename)))
  const resources = options?.includeResources === false ? [] : preview.companionResources.filter(diff => diff.existsInExport && diff.hasDifferences &&
    (!options?.selectedResources || options.selectedResources.length === 0 || options.selectedResources.includes(diff.relativePath)))
  if (!agents.length && !resources.length) return { imported: [], importedResources: [], backupPath: null }

  const backupPath = createBackup(workspaceRoot)
  const imported: string[] = []
  const importedResources: string[] = []
  const generalDir = path.join(workspaceRoot, resolveSourceSubdir(workspaceRoot))
  fs.mkdirSync(generalDir, { recursive: true })
  const staging = fs.mkdtempSync(path.join(generalDir, ".import-stage-"))
  const appliedImports: Array<{ localPath: string; relativeToGeneral: string; existed: boolean; mode?: number }> = []
  try {
    const stagedImports = [
      ...agents.map(diff => ({ diff, relativeToGeneral: path.relative(generalDir, diff.localPath), name: diff.filename, resource: false })),
      ...resources.map(diff => ({ diff, relativeToGeneral: path.relative(generalDir, diff.localPath), name: diff.relativePath, resource: true }))
    ]

    for (const item of stagedImports) {
      validateImportFile(item.diff.exportPath)
      validateImportDestination(workspaceRoot, item.diff.localPath)
      const stagedPath = path.join(staging, item.relativeToGeneral)
      fs.mkdirSync(path.dirname(stagedPath), { recursive: true })
      fs.copyFileSync(item.diff.exportPath, stagedPath)
      fs.chmodSync(stagedPath, fs.statSync(item.diff.exportPath).mode & 0o7777)
    }

    for (const item of stagedImports) {
      fs.mkdirSync(path.dirname(item.diff.localPath), { recursive: true })
      const targetStat = fs.lstatSync(item.diff.localPath, { throwIfNoEntry: false })
      appliedImports.push({
        localPath: item.diff.localPath,
        relativeToGeneral: item.relativeToGeneral,
        existed: !!targetStat,
        mode: targetStat?.mode & 0o7777
      })
      fs.renameSync(path.join(staging, item.relativeToGeneral), item.diff.localPath)
      if (item.resource) importedResources.push(item.name)
      else imported.push(item.name)
    }
  } catch (error: any) {
    const rollbackErrors: string[] = []
    for (const applied of appliedImports.reverse()) {
      try {
        if (applied.existed) {
          const saved = path.join(backupPath!, applied.relativeToGeneral)
          fs.copyFileSync(saved, applied.localPath)
          fs.chmodSync(applied.localPath, applied.mode ?? (fs.statSync(saved).mode & 0o7777))
        } else {
          fs.rmSync(applied.localPath, { force: true })
        }
      } catch (rollbackError: any) {
        rollbackErrors.push(`${applied.localPath}: ${rollbackError?.message || rollbackError}`)
      }
    }
    const detail = rollbackErrors.length ? `; rollback incomplete: ${rollbackErrors.join("; ")}` : "; rollback completed"
    throw new Error(`${error?.message || error}${detail}`)
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
  return { imported, importedResources, backupPath }
}

/**
 * Get all V2-compatible agent source directories.
 * V2 discovers agents from: agents/, agent/, mode/, modes/
 */
export function getAgentSourceDirectories(workspaceRoot: string): string[] {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  const opencodeDir = path.join(configHome, "opencode")
  const dirs = ["agents", "agent", "mode", "modes"]
  return dirs.filter(d => {
    const fullPath = path.join(opencodeDir, d)
    return fs.existsSync(fullPath) && fs.lstatSync(fullPath).isDirectory()
  })
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
 * E.g., 'copilot-pipeline', 'go-pipeline', 'slides', 'docs', 'wiki'.
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
): { success: boolean; updatedReferences: string[]; skipped: string[]; newPath: string; error?: string; backupPath?: string | null } {
  if (!newFilename.endsWith(".md")) {
    newFilename += ".md"
  }
  newFilename = sanitizeFilename(newFilename)
  const backupPath = createBackup(workspaceRoot)

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
      backupPath,
      error: `Agent renamed, but reference updates were only partially flushed. Backup: ${backupPath || "none"}. ${e?.message || e}`
    }
  }

  return { success: true, updatedReferences, skipped, newPath, backupPath }
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
  const resolvedSourceDir = !sourceDir || (sourceDir === "general" && !fs.existsSync(path.join(workspaceRoot, "general")) && fs.existsSync(path.join(workspaceRoot, "src")))
    ? resolveSourceSubdir(workspaceRoot)
    : sourceDir
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

  function walk(dir: string) {
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
    // make export/organize operate on an unexpected target.
    if (stats.isSymbolicLink()) {
      throw new Error(`Refusing to discover agents through symlink: ${dir}`)
    }

    if (stats.isDirectory()) {
      const files = fs.readdirSync(dir)
      // V2 compatibility: 'agents', 'agent', 'mode', 'modes' are all valid agent directories
      const isAgentsDir = basename === "agents" || basename === "agent" || basename === "mode" || basename === "modes"

      for (const file of files) {
        const fullPath = path.join(dir, file)
        const childStat = fs.lstatSync(fullPath)
        if (childStat.isSymbolicLink()) {
          throw new Error(`Refusing to discover agents through symlink: ${fullPath}`)
        }
        if (isAgentsDir && file.endsWith(".md")) {
          try {
            const agent = parseAgentFile(fullPath, workspaceRoot)
            if (agent) {
              // V2: agents in 'mode' or 'modes' directories are primary agents
              if ((basename === "mode" || basename === "modes") && !agent.frontmatter.mode) {
                agent.frontmatter.mode = "primary"
              }
              agents.push(agent)
            }
          } catch (e) {
            console.error(`Error parsing agent file ${file}:`, e)
          }
        } else {
          walk(fullPath)
        }
      }
    }
  }

  walk(sourceRoot)
  if (agents.length === 0) (agents as AgentList).warnings = [`No agents found under sourceDir '${resolvedSourceDir}' (${sourceRoot})`]

  // Compute categories dynamically based on filename prefix frequency analysis
  const filenames = agents.map(a => a.filename)
  const categoryMap = computeCategories(filenames)

  agents.forEach(agent => {
    agent.category = categoryMap[agent.filename]
    agent.targetPath = path.join(workspaceRoot, resolveCategoriesSubdir(workspaceRoot), agent.category, "agents", agent.filename)
  })

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
  let rawFrontmatter: Record<string, any> = {}

  const { yamlText, body: contentBody } = extractFrontmatter(content)
  if (yamlText !== null) {
    body = contentBody
    try {
      const parsed = YAML.parse(yamlText)
      if (isValidFrontmatter(parsed)) {
        rawFrontmatter = parsed
        // Normalize V2 frontmatter to V1 for internal use
        const version = detectFrontmatterVersion(parsed)
        if (version === "v2") {
          frontmatter = translateFrontmatterV2ToV1(parsed)
        } else {
          frontmatter = parsed
        }
      }
    } catch (e) {
      console.error(`YAML parsing error in ${filePath}:`, e)
    }
  }

  // Temporary category assignment; updated dynamically in findAgentFiles
  const category = detectCategory(filename)
  const targetPath = path.join(workspaceRoot, "categories", category, "agents", filename)

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
    frontmatterVersion: detectFrontmatterVersion(rawFrontmatter)
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

export function renderAgentFile(frontmatter: Record<string, any>, body: string, originalVersion?: "v1" | "v2" | "unknown"): string {
  const frontmatterToWrite = originalVersion === "v2"
    ? translateFrontmatterV1ToV2(frontmatter)
    : frontmatter
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
 * Create a timestamped backup of the general/ directory under backups/.
 */
export function createBackup(workspaceRoot: string): string | null {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  const sourceDir = resolveSourceSubdir(workspaceRoot)
  const backupDir = path.join(workspaceRoot, "backups", `backup_${timestamp}`, sourceDir)
  const generalDir = path.join(workspaceRoot, sourceDir)

  if (fs.existsSync(generalDir)) {
    fs.mkdirSync(backupDir, { recursive: true })
    fs.cpSync(generalDir, backupDir, { recursive: true })
    return backupDir
  }
  return null
}

/**
 * True when the path points inside a `general/agents` directory
 * (separator-agnostic, so it works with POSIX and Windows paths).
 */
export function isInGeneralAgents(p: string): boolean {
  return /(^|[/\\])(src|general)[/\\]agents([/\\]|$)/.test(p)
}

/**
 * Reorganize agents by copying them to their corresponding category directory
 * and adding/updating the "category" key in the copy's frontmatter.
 */
export function organizeAgents(workspaceRoot: string, agents: AgentInfo[]): { copied: string[]; skipped: string[]; backupsPath: string | null } {
  const copied: string[] = []
  const skipped: string[] = []
  const protectedCategories = discoverManifestCategories(workspaceRoot)
  const eligible = agents.filter(agent => isInGeneralAgents(agent.currentPath) && agent.currentPath !== agent.targetPath && !protectedCategories.has(agent.category))
  for (const agent of agents) {
    if (isInGeneralAgents(agent.currentPath) && agent.currentPath !== agent.targetPath && protectedCategories.has(agent.category)) skipped.push(`${agent.filename} (category '${agent.category}' is manifest-backed; run category build ${agent.category})`)
  }
  // Do not create a backup when every requested destination is protected.
  const backupsPath = eligible.length > 0 ? createBackup(workspaceRoot) : null
  for (const agent of agents) {
    const isOriginal = isInGeneralAgents(agent.currentPath)
    const isAtTarget = agent.currentPath === agent.targetPath

    if (isOriginal && !isAtTarget && !protectedCategories.has(agent.category)) {
      const sourceContent = fs.readFileSync(agent.currentPath, "utf-8")
      const { yamlText } = extractFrontmatter(sourceContent)
      if (yamlText === null) {
        skipped.push(agent.filename)
        continue
      }
      try {
        if (!isValidFrontmatter(YAML.parse(yamlText))) {
          skipped.push(agent.filename)
          continue
        }
      } catch {
        skipped.push(agent.filename)
        continue
      }
      const targetDir = path.dirname(agent.targetPath)
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true })
      }

      fs.copyFileSync(agent.currentPath, agent.targetPath)

      const copyInfo = parseAgentFile(agent.targetPath, workspaceRoot)
      if (copyInfo && isValidFrontmatter(copyInfo.frontmatter)) {
        copyInfo.frontmatter.category = agent.category
      saveAgentFile(agent.targetPath, copyInfo.frontmatter, copyInfo.body, copyInfo.frontmatterVersion)
      } else {
        skipped.push(agent.filename)
        continue
      }

      copied.push(`${agent.filename} -> categories/${agent.category}/agents/`)
    }
  }

  return { copied, skipped, backupsPath }
}

/** Return manifest-backed category IDs without following symlinks. */
export function discoverManifestCategories(workspaceRoot: string): Set<string> {
  const result = new Set<string>()
  const dir = path.join(workspaceRoot, ".agent-manager", "categories")
  try {
    const managerDir = path.join(workspaceRoot, ".agent-manager")
    let current = path.resolve(workspaceRoot)
    for (const part of path.relative(current, dir).split(path.sep).filter(Boolean)) {
      current = path.join(current, part)
      if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error(`Refusing organize: path component is a symlink: ${current}`)
    }
    if (fs.existsSync(managerDir) && fs.lstatSync(managerDir).isSymbolicLink()) throw new Error("Refusing organize: .agent-manager is a symlink")
    if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) throw new Error("Refusing organize: .agent-manager/categories is a symlink")
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".json")) continue
      const file = path.join(dir, name)
      const stat = fs.lstatSync(file)
      if (stat.isSymbolicLink()) throw new Error(`Refusing organize: category manifest is a symlink: ${name}`)
      if (!stat.isFile()) continue
      const id = name.slice(0, -5)
      if (/^[a-z0-9][a-z0-9-]*$/.test(id)) result.add(id)
    }
  } catch (error: any) { if (error.code !== "ENOENT") throw error }
  return result
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
      expected.set(agent.currentPath, { bytes: Buffer.from(renderAgentFile(updatedFrontmatter, agent.body, agent.frontmatterVersion)), mode: originals.get(agent.currentPath)!.stat.mode & 0o7777 })
      writer(agent.currentPath, updatedFrontmatter, agent.body, agent.frontmatterVersion)
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

export interface ForkResult {
  copied: string[]
  skipped: string[]
  backupsPath: string | null
}

/**
 * Parse the replacement syntax used by the fork TUI. Plain input is kept as
 * one literal, while comma-separated input is treated as a list. Brackets
 * remain accepted for backwards compatibility.
 */
export function parseForkReplacements(input: string): string | readonly string[] {
  const trimmedInput = input.trim()
  if (trimmedInput === "") return ""

  const startsWithBracket = trimmedInput.startsWith("[")
  const endsWithBracket = trimmedInput.endsWith("]")
  const hasOpeningBracket = trimmedInput.includes("[")
  const hasClosingBracket = trimmedInput.includes("]")
  if (hasOpeningBracket !== hasClosingBracket ||
      (hasOpeningBracket && (!startsWithBracket || !endsWithBracket))) {
    throw new Error("Fork replacement list must have matching outer brackets")
  }

  const isBracketed = startsWithBracket && endsWithBracket
  const value = isBracketed ? trimmedInput.slice(1, -1) : trimmedInput
  if (!isBracketed && !value.includes(",")) return value
  if (isBracketed && /[\[\]]/.test(value)) {
    throw new Error("Fork replacement list contains malformed brackets")
  }

  const items = value.split(",").map(item => item.trim())
  if (items.length === 1 && items[0] === "") throw new Error("Fork replacement list cannot be empty")
  if (items.some(item => item === "")) throw new Error("Fork replacement list cannot contain empty items")
  if (new Set(items).size !== items.length) throw new Error("Fork replacement list cannot contain duplicates")
  return items
}

function validateForkTargetFilesystem(targetPath: string, workspaceRoot: string): void {
  const resolvedRoot = path.resolve(workspaceRoot)
  const resolvedTarget = path.resolve(targetPath)
  const relativeTarget = path.relative(resolvedRoot, resolvedTarget)
  let current = resolvedRoot

  for (const component of relativeTarget.split(path.sep).slice(0, -1).filter(Boolean)) {
    current = path.join(current, component)
    const stat = fs.lstatSync(current, { throwIfNoEntry: false })
    if (!stat) break
    if (stat.isSymbolicLink()) throw new Error(`Refusing fork target path component that is a symlink: ${current}`)
    if (!stat.isDirectory()) throw new Error(`Refusing fork target path component that is not a directory: ${current}`)
  }

  const target = fs.lstatSync(resolvedTarget, { throwIfNoEntry: false })
  if (!target) return
  if (target.isSymbolicLink()) throw new Error(`Refusing to replace symlink fork target: ${resolvedTarget}`)
  if (!target.isFile()) throw new Error(`Refusing to replace non-regular fork target: ${resolvedTarget}`)
}

function forkPathIdentity(candidate: string): string {
  return path.resolve(candidate).normalize("NFC").toLowerCase().normalize("NFC")
}

/**
 * Fork a category by copying all its agents inside general/agents/,
 * substituting patterns in filename and file contents, and preserving target LLM models on overwrite.
 */
export function forkCategory(
  workspaceRoot: string,
  sourceCategory: string,
  findStr: string,
  replaceStr: string | readonly string[],
  selectedPaths?: string[]
): ForkResult {
  const isPipelineCategory = sourceCategory === "pipeline" || sourceCategory.endsWith("-pipeline")
  // Find all agents under general/agents/ belonging to sourceCategory
  const sourceDir = resolveSourceSubdir(workspaceRoot)
  const allAgents = findAgentFiles(workspaceRoot, sourceDir)
  let sourceAgents = allAgents.filter(
    (agent) => agent.category === sourceCategory && isInGeneralAgents(agent.currentPath)
  )
  if (isPipelineCategory && sourceAgents.length === 0) {
    sourceAgents = allAgents.filter(agent =>
      isInGeneralAgents(agent.currentPath) && agent.filename.startsWith(`${sourceCategory}-`)
    )
  }
  if (isPipelineCategory && sourceAgents.length === 0) {
    const stampedSourceDir = path.join(resolveCategoriesSubdir(workspaceRoot), sourceCategory)
    const stampedSourcePath = path.join(workspaceRoot, stampedSourceDir)
    if (fs.existsSync(stampedSourcePath)) {
      sourceAgents = findAgentFiles(workspaceRoot, stampedSourceDir)
        .filter(agent => agent.category === sourceCategory || agent.filename.startsWith(`${sourceCategory}-`))
    }
  }

  // If specific files are selected, only fork those selected files
  if (selectedPaths && selectedPaths.length > 0) {
    const selectedSet = new Set(selectedPaths)
    sourceAgents = sourceAgents.filter((agent) => selectedSet.has(agent.currentPath))
  }

  const replacements = typeof replaceStr === "string" ? [replaceStr] : [...replaceStr]
  if (replacements.length === 0) throw new Error("Fork replacement list cannot be empty")
  if (replacements.some(item => typeof item !== "string")) throw new Error("Fork replacements must be strings")
  if (new Set(replacements).size !== replacements.length) throw new Error("Fork replacement list cannot contain duplicates")

  const copied: string[] = []
  const skipped: string[] = []
  const plans: Array<{ agent: AgentInfo; targetPath: string; frontmatter: Record<string, any>; body: string; frontmatterVersion: "v1" | "v2" | "unknown" }> = []
  const targetPaths = new Set<string>()
  const agentsByPath = new Map<string, AgentInfo[]>()
  for (const existingAgent of allAgents) {
    if (!isInGeneralAgents(existingAgent.currentPath)) continue
    const identity = forkPathIdentity(existingAgent.currentPath)
    const entries = agentsByPath.get(identity) || []
    entries.push(existingAgent)
    agentsByPath.set(identity, entries)
  }
  const existingTargetEntries = new Map<string, string[]>()
  const loadedTargetDirs = new Set<string>()

  for (const agent of sourceAgents) {
    const filename = agent.filename
    for (const replacement of replacements) {
      const replacementLabel = JSON.stringify(replacement)
      let targetCategory: string | undefined
      let newFilename: string
      if (isPipelineCategory) {
        const trimmedRep = replacement.trim().replace(/-+$/, "")
        targetCategory = trimmedRep === "pipeline" || trimmedRep.endsWith("-pipeline") ? trimmedRep : `${trimmedRep}-pipeline`
        sanitizeFilename(targetCategory)
        newFilename = sanitizeFilename(filename.replace(new RegExp(`^${escapeRegExp(sourceCategory)}-`), `${targetCategory}-`))
      } else {
        // Compute target filename by replacing findStr with this replacement.
        newFilename = sanitizeFilename(filename.split(findStr).join(replacement))
      }
      const useStampedPipelineLayout = isPipelineCategory && (
        fs.existsSync(path.join(workspaceRoot, "export", "categories")) ||
        fs.existsSync(path.join(workspaceRoot, "src", "agents"))
      )
      const targetDir = useStampedPipelineLayout
        ? path.join(workspaceRoot, resolveCategoriesSubdir(workspaceRoot), targetCategory!, "agents")
        : path.join(workspaceRoot, sourceDir, "agents")
      const targetPath = path.join(targetDir, newFilename)
      const resolvedTargetPath = path.resolve(targetPath)
      if (!resolvedTargetPath.startsWith(path.resolve(targetDir) + path.sep)) {
        throw new Error(`Invalid fork target path: ${newFilename}`)
      }
      validateForkTargetFilesystem(targetPath, workspaceRoot)
      if (resolvedTargetPath === path.resolve(agent.currentPath)) {
        skipped.push(`${filename} [${replacementLabel}] (source)`)
        continue
      }

      const targetIdentity = forkPathIdentity(targetPath)
      if (targetPaths.has(targetIdentity)) throw new Error(`Duplicate fork target (case/NFC-equivalent): ${targetPath}`)
      targetPaths.add(targetIdentity)
      if (!loadedTargetDirs.has(targetDir)) {
        if (fs.existsSync(targetDir)) {
          for (const entry of fs.readdirSync(targetDir)) {
            const entryPath = path.join(targetDir, entry)
            const identity = forkPathIdentity(entryPath)
            const entries = existingTargetEntries.get(identity) || []
            entries.push(entryPath)
            existingTargetEntries.set(identity, entries)
          }
        }
        loadedTargetDirs.add(targetDir)
      }
      const filesystemEntries = existingTargetEntries.get(targetIdentity) || []
      if (filesystemEntries.length > 1) {
        throw new Error(`Ambiguous case/NFC-equivalent existing fork targets: ${targetPath}`)
      }
      if (filesystemEntries.length === 1 && path.resolve(filesystemEntries[0]) !== resolvedTargetPath) {
        throw new Error(`Fork target collides with differently spelled existing path: ${targetPath}`)
      }
      const existingAgents = agentsByPath.get(targetIdentity) || []
      if (existingAgents.length > 1) {
        throw new Error(`Ambiguous case/NFC-equivalent fork target: ${targetPath}`)
      }
      const existingSourceAgent = existingAgents[0]
      if (existingSourceAgent && path.resolve(existingSourceAgent.currentPath) !== resolvedTargetPath) {
        throw new Error(`Fork target collides with differently spelled existing agent: ${targetPath}`)
      }
      if (existingSourceAgent && existingSourceAgent.category === sourceCategory) {
        throw new Error(`Fork target resolves to another source-category agent: ${targetPath}`)
      }

      let existingModel: unknown
      let hasExistingModel = false
      if (fs.existsSync(targetPath)) {
        // If target file already exists, read its frontmatter to preserve its model.
        const existingInfo = parseAgentFile(targetPath, workspaceRoot)
        if (existingInfo && Object.prototype.hasOwnProperty.call(existingInfo.frontmatter, "model")) {
          existingModel = existingInfo.frontmatter.model
          hasExistingModel = true
        }
      }

      const sourceContent = fs.readFileSync(agent.currentPath, "utf-8")
      const sourceModel = Object.prototype.hasOwnProperty.call(agent.frontmatter, "model") ? agent.frontmatter.model : undefined
      const sourceHasModel = Object.prototype.hasOwnProperty.call(agent.frontmatter, "model")
      let frontmatter: Record<string, any>
      let body: string
      let frontmatterVersion: "v1" | "v2" | "unknown"
      if (isPipelineCategory) {
        frontmatter = { ...agent.frontmatter }
        body = agent.body
        frontmatterVersion = agent.frontmatterVersion ?? "unknown"
        if (frontmatter.category !== undefined) frontmatter.category = targetCategory
        const permission = frontmatter.permission
        if (permission && typeof permission === "object" && !Array.isArray(permission)) {
          frontmatter.permission = { ...permission }
          const task = permission.task
          if (task && typeof task === "object" && !Array.isArray(task)) {
            const rewrittenTask = Object.fromEntries(Object.entries(task).map(([key, value]) => {
              if (key.startsWith(`${sourceCategory}-`)) return [`${targetCategory}${key.slice(sourceCategory.length)}`, value]
              if (key.startsWith("pipeline-")) return [`${targetCategory}${key.slice("pipeline".length)}`, value]
              return [key, value]
            }))
            frontmatter.permission.task = Object.prototype.hasOwnProperty.call(rewrittenTask, "*")
              ? { "*": rewrittenTask["*"], ...Object.fromEntries(Object.entries(rewrittenTask).filter(([key]) => key !== "*")) }
              : rewrittenTask
          }
        }
        const sourcePrefix = sourceCategory.replace(/-pipeline$/, "")
        const targetPrefix = targetCategory!.replace(/-pipeline$/, "")
        const pipelineGuardPath = "plugins/pipeline-guard.js"
        const pipelineGuardPlaceholder = "\0PIPELINE_GUARD_PATH\0"
        body = body
          .replaceAll(pipelineGuardPath, pipelineGuardPlaceholder)
          .replace(new RegExp(`@${escapeRegExp(sourceCategory)}-`, "g"), `@${targetCategory}-`)
          .replace(/@pipeline-/g, `@${targetCategory}-`)
          .replace(new RegExp(`# ${escapeRegExp(sourceCategory)}-`, "g"), `# ${targetCategory}-`)
          .replace(/# pipeline-/g, `# ${targetCategory}-`)
        if (sourceCategory !== "pipeline") {
          body = body.replace(new RegExp(`/${escapeRegExp(sourcePrefix)}-`, "g"), `/${targetPrefix}-`)
        }
        body = body.replace(/\/pipeline-/g, `/${targetPrefix}-`).replaceAll(pipelineGuardPlaceholder, pipelineGuardPath)
      } else {
        const updatedContent = sourceContent.split(findStr).join(replacement)
        const { yamlText, body: updatedBody } = extractFrontmatter(updatedContent)
        body = updatedBody
        if (yamlText === null) {
          skipped.push(`${filename} [${replacementLabel}]`)
          continue
        }
        try {
          frontmatter = YAML.parse(yamlText)
          if (!isValidFrontmatter(frontmatter)) {
            skipped.push(`${filename} [${replacementLabel}]`)
            continue
          }
        } catch (e) {
          skipped.push(`${filename} [${replacementLabel}]`)
          continue
        }
        frontmatterVersion = detectFrontmatterVersion(frontmatter)
        if (frontmatterVersion === "v2") frontmatter = translateFrontmatterV2ToV1(frontmatter)
      }

      // Never replace a model as part of the global content substitution.
      if (!hasExistingModel && sourceHasModel) frontmatter.model = sourceModel
      if (hasExistingModel) frontmatter.model = existingModel
      plans.push({ agent, targetPath, frontmatter, body, frontmatterVersion })
    }
  }

  // All parseability and targets are checked before the first write.
  const backupsPath = plans.length > 0 ? createBackup(workspaceRoot) : null
  for (const plan of plans) {
    saveAgentFile(plan.targetPath, plan.frontmatter, plan.body, plan.frontmatterVersion)
    copied.push(`${plan.agent.filename} -> ${path.basename(plan.targetPath)}`)
  }

  return { copied, skipped, backupsPath }
}

/** Resource roots under agents/general/ whose per-domain subdirectories travel with their agents on export. */
const DOMAIN_RESOURCE_ROOTS = ["tools", "commands", "skills", "plugins"] as const

/** Domain key of an agent filename: the first hyphen-delimited segment (family when present, else category). */
export function agentDomain(filename: string): string {
  return filename.replace(/\.md$/i, "").split("-")[0].toLocaleLowerCase("und")
}

const MAX_RESOURCE_BACKUPS = 5

function validateResourceRoot(sourceRoot: string): void {
  const stat = fs.lstatSync(sourceRoot, { throwIfNoEntry: false })
  if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) throw new Error(`Refusing to use symlink or non-directory resource source root: ${sourceRoot}`)
}

function isExcludedCompanionFile(relPath: string): boolean {
  const basename = path.posix.basename(relPath.replace(/\\/g, "/"))
  if (basename === ".DS_Store" || /(\.test\.|_testutil\.|\.d\.ts$)/i.test(basename)) return true
  return /^README\.md$/i.test(basename) && /^(?:plugins|tools)\//i.test(relPath.replace(/\\/g, "/"))
}

function safeRelativeStat(sourceRoot: string, relative: string): fs.Stats | undefined {
  const normalized = relative.replace(/\\/g, "/")
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) return undefined
  let current = sourceRoot
  for (const component of normalized.split("/")) {
    current = path.join(current, component)
    const stat = fs.lstatSync(current, { throwIfNoEntry: false })
    if (!stat) return undefined
    if (stat.isSymbolicLink()) throw new Error(`Refusing to export resource symlink: ${current}`)
  }
  const resolved = path.resolve(sourceRoot, normalized)
  if (!resolved.startsWith(`${path.resolve(sourceRoot)}${path.sep}`)) return undefined
  return fs.lstatSync(resolved, { throwIfNoEntry: false })
}

function walkFiles(sourceRoot: string, relative: string): string[] {
  const stat = safeRelativeStat(sourceRoot, relative)
  if (!stat) return []
  if (stat.isFile()) return isExcludedCompanionFile(relative) ? [] : [relative]
  if (!stat.isDirectory()) return []
  const files: string[] = []
  const directory = path.join(sourceRoot, relative)
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const child = path.posix.join(relative.replace(/\\/g, "/"), entry.name)
    if (isExcludedCompanionFile(child)) continue
    const childStat = safeRelativeStat(sourceRoot, child)
    if (childStat?.isDirectory()) files.push(...walkFiles(sourceRoot, child))
    else if (childStat?.isFile()) files.push(child)
  }
  return files
}

function traceRelativeToolDependencies(sourceRoot: string, initialRelPaths: Iterable<string>): Set<string> {
  const traced = new Set<string>()
  const queue = [...initialRelPaths].map(relative => relative.replace(/\\/g, "/"))
  const parsed = new Set<string>()
  const resolveReference = (current: string, reference: string): string | undefined => {
    const candidates = [path.posix.normalize(path.posix.join(path.posix.dirname(current), reference))]
    if (reference.endsWith(".js")) candidates.push(`${candidates[0].slice(0, -3)}.ts`)
    for (const candidate of candidates) {
      if (!/^(?:tools|plugins)\//.test(candidate) || isExcludedCompanionFile(candidate)) continue
      const stat = safeRelativeStat(sourceRoot, candidate)
      if (stat?.isFile()) return candidate
    }
    return undefined
  }
  while (queue.length) {
    const relative = queue.shift()!
    if (parsed.has(relative) || !/^(?:tools|plugins)\/.+\.(?:ts|js|mjs)$/i.test(relative) || isExcludedCompanionFile(relative)) continue
    const stat = safeRelativeStat(sourceRoot, relative)
    if (!stat?.isFile()) continue
    parsed.add(relative)
    traced.add(relative)
    const source = fs.readFileSync(path.join(sourceRoot, relative), "utf8")
    const references = new Set<string>()
    const imports = /(?:from|import)\s*\(\s*["'](\.[^"']+)["']\s*\)|(?:from|import)\s+["'](\.[^"']+)["']/g
    for (const match of source.matchAll(imports)) references.add(match[1] || match[2])
    const assets = /opencodePath\(\s*["']([^"']+)["']\s*\)/g
    for (const match of source.matchAll(assets)) {
      const assetPath = path.posix.join("tools", match[1])
      const stat = safeRelativeStat(sourceRoot, assetPath)
      if (stat?.isFile() && !isExcludedCompanionFile(assetPath)) {
        traced.add(assetPath)
        if (/\.(?:ts|js|mjs)$/i.test(assetPath) && !parsed.has(assetPath)) queue.push(assetPath)
      }
    }
    for (const reference of references) {
      const resolved = resolveReference(relative, reference)
      if (resolved && !parsed.has(resolved)) queue.push(resolved)
    }
  }
  return traced
}

function deriveCompanionResourcesFromAgents(sourceRoot: string, agentsList: AgentInfo[]): Set<string> {
  const discovered = new Set<string>()
  const collectTree = (relative: string) => {
    for (const file of walkFiles(sourceRoot, relative)) discovered.add(file)
  }
  for (const agent of agentsList) {
    const permission = agent.frontmatter?.permission
    if (!permission || typeof permission !== "object" || Array.isArray(permission)) continue
    for (const [key, value] of Object.entries(permission)) {
      if (value !== "allow" && value !== true) continue
      if (key === "skill" && typeof value === "object") continue
      if (key === "skill" || key.endsWith("_*")) {
        if (key.endsWith("_*")) {
          const prefix = key.slice(0, -2)
          const toolsStat = safeRelativeStat(sourceRoot, "tools")
          const toolsDir = path.join(sourceRoot, "tools")
          if (toolsStat?.isDirectory()) for (const entry of fs.readdirSync(toolsDir, { withFileTypes: true })) {
            if (entry.isFile() && entry.name.startsWith(`${prefix}_`) && entry.name.endsWith(".ts")) {
              const relative = `tools/${entry.name}`
              if (!isExcludedCompanionFile(relative) && safeRelativeStat(sourceRoot, relative)?.isFile()) discovered.add(relative)
            }
          }
          collectTree(`tools/${prefix}`)
        }
        continue
      }
      const relative = `tools/${key}.ts`
      if (!isExcludedCompanionFile(relative) && safeRelativeStat(sourceRoot, relative)?.isFile()) discovered.add(relative)
    }
    const skills = permission.skill
    if (skills && typeof skills === "object" && !Array.isArray(skills)) {
      for (const [name, value] of Object.entries(skills)) {
        if (name === "*" || (value !== "allow" && value !== true)) continue
        collectTree(`skills/${name}`)
        collectTree(`tools/${name}`)
      }
    }
  }
  for (const dependency of traceRelativeToolDependencies(sourceRoot, discovered)) discovered.add(dependency)
  return discovered
}

export function discoverCompanionResourcePaths(sourceRoot: string, domains: string[], manifestDirectory?: string, agentsForDerivation?: AgentInfo[]): string[] {
  validateResourceRoot(sourceRoot)
  if (!fs.existsSync(sourceRoot)) return []
  const found = new Set<string>()
  const names = [...new Set(domains.filter(Boolean))]
  const matches = (name: string): boolean => names.some(domain => name === domain || name.startsWith(`${domain}-`))

  const categoriesDirectory = manifestDirectory ?? (["general", "src"].includes(path.basename(sourceRoot))
    ? path.join(path.dirname(sourceRoot), ".agent-manager", "categories")
    : undefined)
  if (categoriesDirectory) {
    for (const domain of names) {
      const manifestPath = path.join(categoriesDirectory, `${domain}.json`)
      const manifestStat = fs.lstatSync(manifestPath, { throwIfNoEntry: false })
      if (!manifestStat) continue
      if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) throw new Error(`Invalid category manifest: ${manifestPath}`)
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
      if (!Array.isArray(manifest.resources)) continue
      for (const resource of manifest.resources) {
        if (typeof resource?.source !== "string" || !["file", "directory"].includes(resource.kind)) continue
        const sourcePrefix = ["src/tools/", "src/commands/", "src/skills/", "src/plugins/", "general/tools/", "general/commands/", "general/skills/", "general/plugins/"]
          .find(prefix => resource.source.startsWith(prefix))
        if (!sourcePrefix) continue
        const relative = resource.source.slice(sourcePrefix.slice(0, sourcePrefix.indexOf("/") + 1).length)
        if (relative.split(/[\\/]/).includes("..") || path.isAbsolute(relative)) throw new Error(`Invalid resource path in category manifest: ${resource.source}`)
        const source = path.resolve(sourceRoot, relative)
        if (!source.startsWith(`${path.resolve(sourceRoot)}${path.sep}`)) throw new Error(`Invalid resource path in category manifest: ${resource.source}`)
        let current = sourceRoot
        for (const component of relative.split(/[\\/]/)) {
          current = path.join(current, component)
          const stat = fs.lstatSync(current, { throwIfNoEntry: false })
          if (stat?.isSymbolicLink()) throw new Error(`Refusing to export resource through source symlink: ${current}`)
        }
        if (resource.kind === "file" && !isExcludedCompanionFile(relative)) found.add(relative)
        const stat = fs.lstatSync(source, { throwIfNoEntry: false })
        if (!stat) continue
        if (resource.kind === "file") {
          if (stat.isFile() && !isExcludedCompanionFile(relative)) found.add(relative)
        } else if (stat.isDirectory()) for (const file of walkFiles(sourceRoot, relative)) found.add(file)
      }
    }
  }

  for (const root of DOMAIN_RESOURCE_ROOTS) {
    const rootDir = path.join(sourceRoot, root)
    const stat = fs.lstatSync(rootDir, { throwIfNoEntry: false })
    if (!stat) continue
    if (stat.isSymbolicLink()) throw new Error(`Refusing to export through source symlink: ${rootDir}`)
    if (!stat.isDirectory()) continue
    for (const entry of fs.readdirSync(rootDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const entryPath = path.join(rootDir, entry.name)
      const entryStat = fs.lstatSync(entryPath)
      if (entryStat.isSymbolicLink()) {
        if (matches(entry.name) || matches(path.parse(entry.name).name)) throw new Error(`Refusing to export resource symlink: ${entryPath}`)
        continue
      }
      if (entryStat.isDirectory() && matches(entry.name)) for (const file of walkFiles(sourceRoot, path.join(root, entry.name))) found.add(file)
      else if (entryStat.isFile() && matches(path.parse(entry.name).name) && !isExcludedCompanionFile(path.join(root, entry.name))) found.add(path.join(root, entry.name))
    }
  }

  const workspaceRoot = resolveWorkspaceRootFromSourceRoot(sourceRoot)
  for (const domain of names) {
    const links = getCategoryCompanionLinks(workspaceRoot, domain)
    for (const relative of [...links.plugins, ...links.commands, ...links.skills, ...links.tools]) {
      const normalized = relative.replace(/\\/g, "/")
      const stat = safeRelativeStat(sourceRoot, normalized)
      if (stat?.isDirectory()) for (const file of walkFiles(sourceRoot, normalized)) found.add(file)
      else if (stat?.isFile() && !isExcludedCompanionFile(normalized)) found.add(normalized)
    }
  }
  for (const dependency of traceRelativeToolDependencies(sourceRoot, found)) found.add(dependency)
  if (agentsForDerivation) for (const resource of deriveCompanionResourcesFromAgents(sourceRoot, agentsForDerivation)) found.add(resource)
  for (const dependency of traceRelativeToolDependencies(sourceRoot, found)) found.add(dependency)
  return [...found].sort((a, b) => a.localeCompare(b))
}

export function compareCompanionResources(workspaceRoot: string, agents?: AgentInfo[]): CompanionResourceDiff[] {
  const generalRoot = path.join(workspaceRoot, resolveSourceSubdir(workspaceRoot))
  const localAgentsDir = path.join(generalRoot, "agents")
  const localAgents = agents ?? (fs.existsSync(localAgentsDir)
    ? fs.readdirSync(localAgentsDir).filter(name => name.endsWith(".md")).map(name => parseAgentFile(path.join(localAgentsDir, name), workspaceRoot)).filter((agent): agent is AgentInfo => !!agent)
    : [])
  const exportDir = getExportDestination()
  const exportAgents = fs.existsSync(exportDir) ? fs.readdirSync(exportDir).filter(name => name.endsWith(".md")) : []
  const domains = [...new Set([...localAgents.flatMap(agent => [agentDomain(agent.filename), agent.category]), ...exportAgents.map(agentDomain)])]
  const localPaths = discoverCompanionResourcePaths(generalRoot, domains, undefined, localAgents)
  const exportRoot = path.dirname(exportDir)
  const manifestDirectory = path.join(workspaceRoot, ".agent-manager", "categories")
  const exportPaths = discoverCompanionResourcePaths(exportRoot, domains, manifestDirectory, localAgents)
  const relatives = [...new Set([...localPaths, ...exportPaths])].sort((a, b) => a.localeCompare(b))
  return relatives.map(relativePath => {
    const localPath = path.join(generalRoot, relativePath)
    const exportPath = path.join(exportRoot, relativePath)
    let current = generalRoot
    for (const component of relativePath.split(path.sep).slice(0, -1)) {
      current = path.join(current, component)
      const stat = fs.lstatSync(current, { throwIfNoEntry: false })
      if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) throw new Error(`Refusing to compare through symlink or non-directory companion path: ${current}`)
    }
    let exportCurrent = exportRoot
    for (const component of relativePath.split(path.sep).slice(0, -1)) {
      exportCurrent = path.join(exportCurrent, component)
      const stat = fs.lstatSync(exportCurrent, { throwIfNoEntry: false })
      if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) throw new Error(`Refusing to compare through symlink or non-directory companion path: ${exportCurrent}`)
    }
    const localStat = fs.lstatSync(localPath, { throwIfNoEntry: false })
    const exportStat = fs.lstatSync(exportPath, { throwIfNoEntry: false })
    if (localStat?.isSymbolicLink() || exportStat?.isSymbolicLink()) throw new Error(`Refusing to compare symlinked companion resource: ${localStat?.isSymbolicLink() ? localPath : exportPath}`)
    if ((localStat && !localStat.isFile()) || (exportStat && !exportStat.isFile())) throw new Error(`Refusing to compare non-regular companion resource: ${localStat && !localStat.isFile() ? localPath : exportPath}`)
    const existsLocally = !!localStat?.isFile()
    const existsInExport = !!exportStat?.isFile()
    const hasDifferences = existsLocally !== existsInExport || (existsLocally && existsInExport &&
      (!fs.readFileSync(localPath).equals(fs.readFileSync(exportPath)) || (localStat!.mode & 0o7777) !== (exportStat!.mode & 0o7777)))
    return { relativePath, localPath, exportPath, existsLocally, existsInExport, hasDifferences }
  })
}

function copyDomainResources(sourceRoot: string, opencodeRoot: string, agents: AgentInfo[]): { installed: string[]; backupPath: string | null } {
  const canonicalRoot = path.resolve(sourceRoot)
  const bundles = new Map<string, { domains: Set<string>; agents: AgentInfo[] }>()
  for (const agent of agents) {
    const root = inferAgentResourceRoot(agent, canonicalRoot)
    const bundle = bundles.get(root) ?? { domains: new Set<string>(), agents: [] }
    bundle.domains.add(agentDomain(agent.filename))
    bundle.domains.add(agent.category)
    if (path.basename(path.dirname(root)) === "categories" && path.basename(root).endsWith("-pipeline")) {
      bundle.domains.add("pipeline")
    }
    bundle.agents.push(agent)
    bundles.set(root, bundle)
  }
  if (["src", "general"].includes(path.basename(canonicalRoot))) {
    const canonicalBundle = bundles.get(canonicalRoot) ?? { domains: new Set<string>(), agents: [] }
    for (const agent of agents) {
      if (!canonicalBundle.agents.includes(agent)) canonicalBundle.agents.push(agent)
      canonicalBundle.domains.add(agentDomain(agent.filename))
      canonicalBundle.domains.add(agent.category)
    }
    bundles.set(canonicalRoot, canonicalBundle)
  }
  const roots = [...bundles.keys()].sort((a, b) => {
    if (a === canonicalRoot) return b === canonicalRoot ? 0 : -1
    if (b === canonicalRoot) return 1
    return a.localeCompare(b)
  })
  const allDomains = [...new Set([...bundles.values()].flatMap(bundle => [...bundle.domains]))]
  const sources = new Map<string, string>()
  for (const root of roots) {
    const bundle = bundles.get(root)!
    const domains = root === canonicalRoot && bundle.agents.length > 0 ? allDomains : [...bundle.domains]
    const agentsForDerivation = root === canonicalRoot && bundle.agents.length > 0 ? agents : bundle.agents
    const discovered = discoverCompanionResourcePaths(root, domains, undefined, agentsForDerivation)
    const canonicalPipelineAgent = bundle.agents.some(agent => agentDomain(agent.filename) === "pipeline")
    for (const relative of discovered) {
      if (root === canonicalRoot && !canonicalPipelineAgent && /^commands\/pipeline-/.test(relative)) continue
      const normalized = relative.replace(/\\/g, "/")
      if (!sources.has(normalized)) sources.set(normalized, path.join(root, ...normalized.split("/")))
    }
  }
  const resources = [...sources].map(([relative, source]) => ({ source, relative }))
  if (resources.length === 0) return { installed: [], backupPath: null }

  const pending: typeof resources = []
  for (const resource of resources) {
    const destination = path.join(opencodeRoot, resource.relative)
    const sourceStat = fs.lstatSync(resource.source)
    let current = opencodeRoot
    for (const component of resource.relative.split(path.sep).slice(0, -1)) {
      current = path.join(current, component)
      const stat = fs.lstatSync(current, { throwIfNoEntry: false })
      if (stat?.isSymbolicLink()) throw new Error(`Refusing to export through destination symlink: ${current}`)
      if (stat && !stat.isDirectory()) throw new Error(`Resource export destination is not a directory: ${current}`)
    }
    const target = fs.lstatSync(destination, { throwIfNoEntry: false })
    if (target && (target.isSymbolicLink() || !target.isFile())) throw new Error(`Refusing to replace non-regular resource: ${destination}`)
    if (target && sourceStat.isFile() && fs.readFileSync(resource.source).equals(fs.readFileSync(destination)) &&
      (sourceStat.mode & 0o7777) === (target.mode & 0o7777)) continue
    pending.push(resource)
  }
  if (pending.length === 0) return { installed: [], backupPath: null }

  const staging = fs.mkdtempSync(path.join(opencodeRoot, ".resource-export-stage-"))
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  const backupPath = path.join(opencodeRoot, `resource_export_backup_${timestamp}_${randomBytes(4).toString("hex")}`)
  const existing: string[] = []
  const installed: string[] = []
  let backupCreated = false

  try {
    for (const resource of pending) {
      const staged = path.join(staging, resource.relative)
      fs.mkdirSync(path.dirname(staged), { recursive: true })
      fs.copyFileSync(resource.source, staged)
      fs.chmodSync(staged, fs.statSync(resource.source).mode & 0o7777)
      const destination = path.join(opencodeRoot, resource.relative)
      const target = fs.lstatSync(destination, { throwIfNoEntry: false })
      if (target && (target.isSymbolicLink() || !target.isFile())) throw new Error(`Refusing to replace non-regular resource: ${destination}`)
      if (target) existing.push(resource.relative)
    }

    if (existing.length > 0) {
      for (const relative of existing) {
        const saved = path.join(backupPath, relative)
        fs.mkdirSync(path.dirname(saved), { recursive: true })
        fs.copyFileSync(path.join(opencodeRoot, relative), saved)
        fs.chmodSync(saved, fs.statSync(path.join(opencodeRoot, relative)).mode & 0o7777)
      }
      backupCreated = true
    }

    for (const resource of pending) {
      const destination = path.join(opencodeRoot, resource.relative)
      fs.mkdirSync(path.dirname(destination), { recursive: true })
      installed.push(resource.relative)
      fs.renameSync(path.join(staging, resource.relative), destination)
    }
    if (backupCreated) {
      const backups = fs.readdirSync(opencodeRoot, { withFileTypes: true })
        .filter(entry => /^resource_export_backup_/.test(entry.name) && entry.isDirectory())
        .map(entry => ({ name: entry.name, path: path.join(opencodeRoot, entry.name), mtime: fs.statSync(path.join(opencodeRoot, entry.name)).mtimeMs }))
        .sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name))
      for (const old of backups.slice(0, Math.max(0, backups.length - MAX_RESOURCE_BACKUPS))) fs.rmSync(old.path, { recursive: true, force: true })
    }
    return { installed: pending.map(resource => path.join(opencodeRoot, resource.relative)), backupPath: backupCreated ? backupPath : null }
  } catch (error: any) {
    const rollbackErrors: string[] = []
    for (const relative of installed.reverse()) {
      try {
        const destination = path.join(opencodeRoot, relative)
        if (existing.includes(relative)) {
          const saved = path.join(backupPath, relative)
          fs.copyFileSync(saved, destination)
          fs.chmodSync(destination, fs.statSync(saved).mode & 0o7777)
        }
        else fs.rmSync(destination, { force: true })
      } catch (rollbackError: any) {
        rollbackErrors.push(`${relative}: ${rollbackError?.message || rollbackError}`)
      }
    }
    if (!backupCreated && fs.existsSync(backupPath)) {
      try { fs.rmSync(backupPath, { recursive: true, force: true }) } catch {}
    }
    const detail = rollbackErrors.length ? `; rollback incomplete: ${rollbackErrors.join("; ")}` : "; rollback completed"
    throw new Error(`${error?.message || error}${detail}${backupCreated ? `; backup: ${backupPath}` : ""}`)
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
}

export interface ExportResult {
  exported: string[]
  backupPath: string
  destinationPath: string
  skipped: string[]
  domainResources: string[]
  domainBackupPath: string | null
}

/**
 * Get the opencode agents destination path (portable: uses os.homedir()).
 */
export function getExportDestination(env: NodeJS.ProcessEnv = process.env): string {
  const configHome = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  return path.join(configHome, "opencode", "agents")
}

export function getGlobalOpenCodeConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(path.dirname(getExportDestination(env)), "opencode.json")
}

/**
 * Export agents to ~/.config/opencode/agents/ with full overwrite.
 * Creates a single disaster-recovery backup of the destination folder
 * at ~/.config/opencode/agents_backup/ (overwritten each time).
 */
export function exportAgents(
  agents: AgentInfo[],
  selectedPaths?: Set<string>,
  resourceSourceRoot?: string
): ExportResult {
  const destinationPath = getExportDestination()
  const opencodeRoot = path.dirname(destinationPath)
  const backupPath = path.join(opencodeRoot, "agents_backup")
  const rootStat = fs.lstatSync(opencodeRoot, { throwIfNoEntry: false })
  if (rootStat && (rootStat.isSymbolicLink() || !rootStat.isDirectory())) throw new Error(`Invalid OpenCode destination directory: ${opencodeRoot}`)
  const destinationStat = fs.lstatSync(destinationPath, { throwIfNoEntry: false })
  if (destinationStat && (destinationStat.isSymbolicLink() || !destinationStat.isDirectory())) throw new Error(`Invalid agent destination directory: ${destinationPath}`)
  if (resourceSourceRoot) validateResourceRoot(resourceSourceRoot)

  // Determine which agents to export
  const toExport = selectedPaths && selectedPaths.size > 0
    ? agents.filter((a) => selectedPaths.has(a.currentPath))
    : agents

  // Create disaster-recovery backup of current destination (if it exists)
  if (destinationStat) {
    const tempBackupPath = `${backupPath}.tmp-${Date.now()}`
    try {
      fs.cpSync(destinationPath, tempBackupPath, { recursive: true })
      if (fs.existsSync(backupPath)) {
        fs.rmSync(backupPath, { recursive: true, force: true })
      }
      fs.renameSync(tempBackupPath, backupPath)
    } catch (error) {
      if (fs.existsSync(tempBackupPath)) fs.rmSync(tempBackupPath, { recursive: true, force: true })
      throw error
    }
  }

  // Ensure destination directory exists
  if (!fs.existsSync(destinationPath)) {
    fs.mkdirSync(destinationPath, { recursive: true })
  }

  const exported: string[] = []
  const skipped: string[] = []
  const successfulAgents: AgentInfo[] = []
  const writtenAgents: Array<{ filename: string; targetFile: string; existed: boolean }> = []

  try {
    for (const agent of toExport) {
      const sourceStat = fs.lstatSync(agent.currentPath, { throwIfNoEntry: false })
      if (!sourceStat || sourceStat.isSymbolicLink() || !sourceStat.isFile()) throw new Error(`Refusing to export symlink or non-regular agent file: ${agent.currentPath}`)
      const targetFile = path.join(destinationPath, sanitizeFilename(agent.filename))
      const targetStat = fs.lstatSync(targetFile, { throwIfNoEntry: false })
      if (targetStat && (targetStat.isSymbolicLink() || !targetStat.isFile())) throw new Error(`Refusing to replace symlink or non-regular agent file: ${targetFile}`)
      const sourceBytes = fs.readFileSync(agent.currentPath)
      if (!targetStat || !sourceBytes.equals(fs.readFileSync(targetFile)) ||
          (sourceStat.mode & 0o7777) !== (targetStat.mode & 0o7777)) {
        const stagedTarget = path.join(destinationPath, `.agent-stage-${process.pid}-${randomBytes(8).toString("hex")}`)
        try {
          try {
            fs.copyFileSync(agent.currentPath, stagedTarget)
          } catch (error: any) {
            skipped.push(`${agent.filename}: ${error.message || error}`)
            continue
          }
          fs.chmodSync(stagedTarget, sourceStat.mode & 0o7777)
          writtenAgents.push({ filename: sanitizeFilename(agent.filename), targetFile, existed: !!targetStat })
          fs.renameSync(stagedTarget, targetFile)
        } finally {
          fs.rmSync(stagedTarget, { force: true })
        }
      }
      exported.push(agent.filename)
      successfulAgents.push(agent)
    }
  } catch (error: any) {
    const rollbackErrors: string[] = []
    for (const written of writtenAgents.reverse()) {
      try {
        if (written.existed) {
          const saved = path.join(backupPath, written.filename)
          fs.copyFileSync(saved, written.targetFile)
          fs.chmodSync(written.targetFile, fs.statSync(saved).mode & 0o7777)
        } else fs.rmSync(written.targetFile, { force: true })
      } catch (rollbackError: any) { rollbackErrors.push(`${written.filename}: ${rollbackError?.message || rollbackError}`) }
    }
    if (rollbackErrors.length) throw new Error(`${error?.message || error}; agent rollback incomplete: ${rollbackErrors.join("; ")}`)
    throw error
  }

  let resourceResult: { installed: string[]; backupPath: string | null }
  try {
      resourceResult = resourceSourceRoot
      ? copyDomainResources(resourceSourceRoot, opencodeRoot, successfulAgents)
      : { installed: [], backupPath: null }
  } catch (error: any) {
    const rollbackErrors: string[] = []
    for (const written of writtenAgents.reverse()) {
      try {
        if (written.existed) {
          const saved = path.join(backupPath, written.filename)
          fs.copyFileSync(saved, written.targetFile)
          fs.chmodSync(written.targetFile, fs.statSync(saved).mode & 0o7777)
        } else fs.rmSync(written.targetFile, { force: true })
      } catch (rollbackError: any) { rollbackErrors.push(`${written.filename}: ${rollbackError?.message || rollbackError}`) }
    }
    const message = error?.message || String(error)
    if (rollbackErrors.length) throw new Error(`${message}; agent rollback incomplete: ${rollbackErrors.join("; ")}`)
    throw new Error(message)
  }

  return { exported, backupPath, destinationPath, skipped, domainResources: resourceResult.installed, domainBackupPath: resourceResult.backupPath }
}
