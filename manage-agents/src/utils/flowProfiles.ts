import fs from "node:fs"
import path from "node:path"
import { composeModelVariant, discoverCompanionResourcePaths, findAgentFiles, getExportDestination, renderAgentFile, resolveCategoriesSubdir, resolveSourceSubdir, saveAgentFile, type AgentInfo } from "./agents.js"
import { copyCategoryCompanionLinks, getCompanionLinksConfigPath, loadCompanionLinks, saveCompanionLinks } from "./companionLinks.js"
import { loadStampedPipelineAgents, mergePermission, type PipelineRoleModelSpec } from "./pipelineProfiles.js"

// Multi-provider profiles for the `flow` agent family. Flow and the pipeline are separate families:
// flow has its own config (.agent-manager/flow-profiles.json), its own stamped bundles
// (export/categories/<profile>-flow) and its own naming rules. Only family-neutral helpers are shared
// (permission merge, model/variant composition, stamped-agent loading, companion discovery).

export const FLOW_BASE_CATEGORY = "flow"
export const FLOW_ROLES = ["build", "plan", "explore", "review", "research", "eye", "ops"] as const
export type FlowRole = typeof FLOW_ROLES[number]

/** Role groups a profile can assign a model to with `defaults.<group>`; `defaults.all` covers the rest. */
export const FLOW_ROLE_GROUPS: Record<string, readonly FlowRole[]> = {
  main: ["build", "plan"],
  review: ["review"],
  fast: ["explore", "research", "ops"],
  vision: ["eye"],
}

export interface FlowProfile {
  description: string
  defaults?: Record<string, PipelineRoleModelSpec>
  roles?: Partial<Record<FlowRole, PipelineRoleModelSpec>>
}

export interface FlowProfilesConfig {
  version: 1
  profiles: Record<string, FlowProfile>
}

export const DEFAULT_FLOW_PROFILES: FlowProfilesConfig = { version: 1, profiles: {} }

export function flowProfilesPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".agent-manager", "flow-profiles.json")
}

export function loadFlowProfiles(workspaceRoot: string): FlowProfilesConfig {
  const configPath = flowProfilesPath(workspaceRoot)
  if (!fs.existsSync(configPath)) return structuredClone(DEFAULT_FLOW_PROFILES)
  const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as FlowProfilesConfig
  if (!config || typeof config.profiles !== "object" || config.profiles === null) throw new Error(`${configPath}: missing "profiles" object`)
  return config
}

export function saveFlowProfiles(workspaceRoot: string, config: FlowProfilesConfig): string {
  const configPath = flowProfilesPath(workspaceRoot)
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8")
  return configPath
}

export function resolveFlowRoleSpec(profile: FlowProfile, role: string): PipelineRoleModelSpec | null {
  const explicit = profile.roles?.[role as FlowRole]
  if (explicit) return explicit
  for (const [group, roles] of Object.entries(FLOW_ROLE_GROUPS)) {
    if (roles.includes(role as FlowRole) && profile.defaults?.[group]) return profile.defaults[group]
  }
  return profile.defaults?.all ?? null
}

/** A stamped flow bundle: `<profile>-flow`, never the canonical `flow`. */
export function isStampedFlowCategory(name: string): boolean {
  return /^[a-z0-9_-]+-flow$/i.test(name) && name !== FLOW_BASE_CATEGORY
}

export function normalizeFlowCategoryName(target: string): string {
  const trimmed = target.trim().replace(/-+$/, "")
  const normalized = trimmed === FLOW_BASE_CATEGORY || trimmed.endsWith("-flow") ? trimmed : `${trimmed}-flow`
  if (!/^[a-z0-9_-]+$/i.test(normalized)) throw new Error(`Invalid flow category name '${target}'.`)
  return normalized
}

/** Role of `flow-build.md` in category `flow`, or of `hybrid-flow-build.md` in `hybrid-flow`. */
export function extractFlowRole(filenameOrName: string, category = FLOW_BASE_CATEGORY): FlowRole | null {
  const stem = path.basename(filenameOrName).replace(/\.md$/i, "")
  if (!stem.startsWith(`${category}-`)) return null
  const role = stem.slice(category.length + 1).toLocaleLowerCase("und")
  return (FLOW_ROLES as readonly string[]).includes(role) ? role as FlowRole : null
}

const AGENT_REFERENCE = new RegExp(`(?<![A-Za-z0-9_/-])${FLOW_BASE_CATEGORY}-(${FLOW_ROLES.join("|")})(?![A-Za-z0-9_-])`, "g")

/**
 * Point references to flow agents and slash commands at the stamped family.
 * `flow-explore` -> `hybrid-flow-explore`, `/flow-explain` -> `/hybrid-flow-explain`. Skill names
 * (`flow-frontend-design`, `flow-commit`, ...) and plugin names are shared and stay as they are.
 */
export function rewriteFlowText(text: string, target: string, commandStems: readonly string[] = []): string {
  let rewritten = text
  if (commandStems.length > 0) {
    const escaped = commandStems.map(stem => stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    const commandReference = new RegExp(`(?<![A-Za-z0-9_-])/${FLOW_BASE_CATEGORY}-(${escaped.join("|")})(?![A-Za-z0-9_-])`, "g")
    rewritten = rewritten.replace(commandReference, `/${target}-$1`)
  }
  return rewritten.replace(AGENT_REFERENCE, `${target}-$1`)
}

function rewriteTaskPermissions(task: Record<string, any>, target: string): Record<string, any> {
  return Object.fromEntries(Object.entries(task).map(([key, value]) => {
    const role = extractFlowRole(key)
    return [role ? `${target}-${role}` : key, value]
  }))
}

const isPermissionMap = (value: unknown): value is Record<string, any> => typeof value === "object" && value !== null && !Array.isArray(value)

function applySpec(frontmatter: Record<string, any>, spec: PipelineRoleModelSpec | null): void {
  if (!spec) return
  frontmatter.model = spec.model
  if (typeof spec.variant === "string" && spec.variant.length > 0) frontmatter.variant = spec.variant
  else delete frontmatter.variant
}

function baseFlowAgents(workspaceRoot: string): AgentInfo[] {
  return findAgentFiles(workspaceRoot, resolveSourceSubdir(workspaceRoot))
    .filter(agent => agent.category === FLOW_BASE_CATEGORY && extractFlowRole(agent.filename) !== null)
}

function commandStemOf(relative: string): string | null {
  const match = /^commands\/flow-([a-z0-9_-]+)\.md$/i.exec(relative)
  return match ? match[1] : null
}

function categoriesRootOf(workspaceRoot: string): string {
  return path.join(workspaceRoot, resolveCategoriesSubdir(workspaceRoot))
}

function assertSafeDirectory(workspaceRoot: string, directory: string): void {
  const root = path.resolve(workspaceRoot)
  const relative = path.relative(root, path.resolve(directory))
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Refusing path outside the workspace: ${directory}`)
  let current = root
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component)
    const stat = fs.lstatSync(current, { throwIfNoEntry: false })
    if (!stat) return
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Refusing unsafe path component: ${current}`)
  }
}

export function listStampedFlowCategories(workspaceRoot: string): string[] {
  const root = categoriesRootOf(workspaceRoot)
  if (!fs.existsSync(root)) return []
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && isStampedFlowCategory(entry.name) && fs.existsSync(path.join(root, entry.name, "agents")))
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b))
}

export interface RefreshStampedFlowsResult {
  refreshedCategories: string[]
  updatedAgents: string[]
  updatedCompanions: string[]
  /** Bundle-relative files each refreshed category must contain (for pruning and extra-file checks). */
  expected: Record<string, string[]>
}

/**
 * Re-render every stamped `<profile>-flow` bundle (or only `targetCategory`) from the canonical
 * `src/agents/flow-*.md` and its companions. Per-bundle choices survive: model, variant, steps, mode,
 * hidden and color of agents that already exist, and permission rules the bundle added. New agents
 * take their model from the profile whose name matches the bundle prefix. `dryRun` reports without writing.
 */
export function refreshStampedFlowsFromSource(workspaceRoot: string, targetCategory?: string, options: { dryRun?: boolean } = {}): RefreshStampedFlowsResult {
  const result: RefreshStampedFlowsResult = { refreshedCategories: [], updatedAgents: [], updatedCompanions: [], expected: {} }
  const categoriesRoot = categoriesRootOf(workspaceRoot)
  if (!fs.existsSync(categoriesRoot)) return result
  let targets: string[]
  if (targetCategory !== undefined) {
    const normalized = normalizeFlowCategoryName(targetCategory)
    if (!isStampedFlowCategory(normalized) || !fs.existsSync(path.join(categoriesRoot, normalized, "agents"))) return result
    targets = [normalized]
  } else targets = listStampedFlowCategories(workspaceRoot)
  if (targets.length === 0) return result

  const baseAgents = baseFlowAgents(workspaceRoot)
  if (baseAgents.length === 0) return result
  const config = loadFlowProfiles(workspaceRoot)
  const sourceRoot = path.join(workspaceRoot, resolveSourceSubdir(workspaceRoot))
  const companions = discoverCompanionResourcePaths(sourceRoot, [FLOW_BASE_CATEGORY], undefined, baseAgents)
  const commandStems = companions.map(commandStemOf).filter((stem): stem is string => stem !== null)

  for (const target of targets) {
    const outputDir = path.join(categoriesRoot, target)
    assertSafeDirectory(workspaceRoot, outputDir)
    const profile = config.profiles[target.replace(/-flow$/, "")]
    const existingByRole = new Map<string, AgentInfo>()
    for (const existing of loadStampedPipelineAgents(workspaceRoot, target)?.agents ?? []) {
      const role = extractFlowRole(existing.filename, target)
      if (role) existingByRole.set(role, existing)
    }
    const expected: string[] = []

    for (const baseAgent of baseAgents) {
      const role = extractFlowRole(baseAgent.filename)!
      const existing = existingByRole.get(role)
      const frontmatter: Record<string, any> = { ...structuredClone(existing?.frontmatter ?? {}), ...structuredClone(baseAgent.frontmatter) }
      const basePermission: Record<string, any> = isPermissionMap(frontmatter.permission) ? { ...frontmatter.permission } : {}
      if (isPermissionMap(basePermission.task)) basePermission.task = rewriteTaskPermissions(basePermission.task, target)
      if (existing) {
        for (const key of ["model", "variant", "mode", "hidden", "color"]) {
          if (Object.prototype.hasOwnProperty.call(existing.frontmatter, key)) frontmatter[key] = existing.frontmatter[key]
          else if (key === "model" || key === "variant") delete frontmatter[key]
        }
        const stepKey = ["steps", "max_steps"].find(key => Object.prototype.hasOwnProperty.call(existing.frontmatter, key))
        if (stepKey) {
          delete frontmatter.steps
          delete frontmatter.max_steps
          frontmatter[stepKey] = existing.frontmatter[stepKey]
        }
        const existingPermission: Record<string, any> = isPermissionMap(existing.frontmatter.permission) ? { ...existing.frontmatter.permission } : {}
        const baseMap = { ...basePermission }
        const targetMap = { ...existingPermission }
        if (isPermissionMap(basePermission.task) || isPermissionMap(existingPermission.task)) {
          const mergedTask = mergePermission(
            { task: isPermissionMap(basePermission.task) ? basePermission.task : {} },
            { task: isPermissionMap(existingPermission.task) ? existingPermission.task : {} },
          ).task
          if (isPermissionMap(mergedTask) && Object.keys(mergedTask).length > 0) baseMap.task = mergedTask
          else delete baseMap.task
          delete targetMap.task
        }
        frontmatter.permission = mergePermission(baseMap, targetMap)
      } else {
        if (isPermissionMap(frontmatter.permission)) frontmatter.permission = basePermission
        applySpec(frontmatter, profile ? resolveFlowRoleSpec(profile, role) : null)
      }
      composeModelVariant(frontmatter)
      const body = rewriteFlowText(baseAgent.body, target, commandStems)
      const relative = `agents/${target}-${role}.md`
      const targetPath = path.join(outputDir, ...relative.split("/"))
      const version = existing?.frontmatterVersion ?? baseAgent.frontmatterVersion
      expected.push(relative)
      const rendered = renderAgentFile(frontmatter, body, version)
      if (!fs.existsSync(targetPath) || fs.readFileSync(targetPath, "utf8") !== rendered) {
        result.updatedAgents.push(targetPath)
        if (!options.dryRun) {
          fs.mkdirSync(path.dirname(targetPath), { recursive: true })
          saveAgentFile(targetPath, frontmatter, body, version)
        }
      }
    }

    for (const relative of companions) {
      const stem = commandStemOf(relative)
      const destinationRelative = stem ? `commands/${target}-${stem}.md` : relative
      const sourcePath = path.join(sourceRoot, ...relative.split("/"))
      const destinationPath = path.join(outputDir, ...destinationRelative.split("/"))
      const next = stem ? Buffer.from(rewriteFlowText(fs.readFileSync(sourcePath, "utf8"), target, commandStems), "utf8") : fs.readFileSync(sourcePath)
      expected.push(destinationRelative)
      if (fs.existsSync(destinationPath) && fs.readFileSync(destinationPath).equals(next)) continue
      result.updatedCompanions.push(destinationPath)
      if (!options.dryRun) {
        fs.mkdirSync(path.dirname(destinationPath), { recursive: true })
        fs.writeFileSync(destinationPath, next)
      }
    }
    result.expected[target] = expected.sort((a, b) => a.localeCompare(b))
    result.refreshedCategories.push(target)
  }
  return result
}

function getFlowProfile(workspaceRoot: string, profileName: string): FlowProfile {
  const profile = loadFlowProfiles(workspaceRoot).profiles[profileName]
  if (!profile) throw new Error(`Unknown flow profile '${profileName}' (see ${path.relative(workspaceRoot, flowProfilesPath(workspaceRoot))}).`)
  return profile
}

/** Set model/variant from a profile on the agents of `flow` (src) or a stamped `*-flow` bundle. */
export function applyFlowProfile(workspaceRoot: string, profileName: string, targetCategory = FLOW_BASE_CATEGORY): { updated: string[]; profileName: string; targetCategory: string } {
  const profile = getFlowProfile(workspaceRoot, profileName)
  const category = normalizeFlowCategoryName(targetCategory)
  const agents = category === FLOW_BASE_CATEGORY ? baseFlowAgents(workspaceRoot) : loadStampedPipelineAgents(workspaceRoot, category)?.agents ?? []
  const updated: string[] = []
  for (const agent of agents) {
    const role = extractFlowRole(agent.filename, category)
    const spec = role ? resolveFlowRoleSpec(profile, role) : null
    if (!spec) continue
    const frontmatter: Record<string, any> = { ...agent.frontmatter }
    applySpec(frontmatter, spec)
    composeModelVariant(frontmatter)
    if (renderAgentFile(frontmatter, agent.body, agent.frontmatterVersion) === agent.rawContent) continue
    saveAgentFile(agent.currentPath, frontmatter, agent.body, agent.frontmatterVersion)
    updated.push(agent.currentPath)
  }
  return { updated, profileName, targetCategory: category }
}

/**
 * Create or update the stamped bundle `<target>-flow` (default `<profile>-flow`) from the canonical flow
 * agents, then apply the profile's models. Targeting `flow` applies the profile to the canonical agents.
 */
export function syncFlowProfile(workspaceRoot: string, profileName: string, targetCategory?: string): { synced: string[]; targetCategory: string; outputDir: string; profileName: string } {
  getFlowProfile(workspaceRoot, profileName)
  const target = normalizeFlowCategoryName(targetCategory || profileName)
  if (target === FLOW_BASE_CATEGORY) {
    const applied = applyFlowProfile(workspaceRoot, profileName, FLOW_BASE_CATEGORY)
    return { synced: applied.updated, targetCategory: target, outputDir: path.join(workspaceRoot, resolveSourceSubdir(workspaceRoot)), profileName }
  }
  if (baseFlowAgents(workspaceRoot).length === 0) throw new Error(`No canonical flow agents in ${resolveSourceSubdir(workspaceRoot)}/agents/.`)
  const outputDir = path.join(categoriesRootOf(workspaceRoot), target)
  assertSafeDirectory(workspaceRoot, path.join(outputDir, "agents"))
  fs.mkdirSync(path.join(outputDir, "agents"), { recursive: true })
  refreshStampedFlowsFromSource(workspaceRoot, target)
  applyFlowProfile(workspaceRoot, profileName, target)
  copyCategoryCompanionLinks(workspaceRoot, FLOW_BASE_CATEGORY, target)
  const synced = (loadStampedPipelineAgents(workspaceRoot, target)?.agents ?? []).map(agent => agent.currentPath)
  return { synced, targetCategory: target, outputDir, profileName }
}

/**
 * Stamp one or more `<x>-flow` bundles (TUI fork). With a profile its models are applied; without one,
 * new bundles keep the canonical models and existing ones keep their own.
 */
export function forkStampedFlow(workspaceRoot: string, targets: string | readonly string[], options: { profileName?: string } = {}): { createdCategories: string[]; updatedCategories: string[]; outputDirs: string[]; agents: number } {
  const names = (typeof targets === "string" ? targets.split(",") : [...targets]).map(value => value.trim()).filter(Boolean).map(normalizeFlowCategoryName)
  if (names.length === 0) throw new Error("Enter one or more target flow names (e.g. go or hybrid, mistral).")
  for (const name of names) if (!isStampedFlowCategory(name)) throw new Error(`Refusing to stamp into the canonical '${FLOW_BASE_CATEGORY}' category; pick a name such as go-flow.`)
  if (options.profileName) getFlowProfile(workspaceRoot, options.profileName)
  if (baseFlowAgents(workspaceRoot).length === 0) throw new Error(`No canonical flow agents in ${resolveSourceSubdir(workspaceRoot)}/agents/.`)
  const result = { createdCategories: [] as string[], updatedCategories: [] as string[], outputDirs: [] as string[], agents: 0 }
  for (const name of [...new Set(names)]) {
    const outputDir = path.join(categoriesRootOf(workspaceRoot), name)
    const existed = fs.existsSync(path.join(outputDir, "agents"))
    if (options.profileName) syncFlowProfile(workspaceRoot, options.profileName, name)
    else {
      assertSafeDirectory(workspaceRoot, path.join(outputDir, "agents"))
      fs.mkdirSync(path.join(outputDir, "agents"), { recursive: true })
      refreshStampedFlowsFromSource(workspaceRoot, name)
      copyCategoryCompanionLinks(workspaceRoot, FLOW_BASE_CATEGORY, name)
    }
    ;(existed ? result.updatedCategories : result.createdCategories).push(name)
    result.outputDirs.push(outputDir)
    result.agents += loadStampedPipelineAgents(workspaceRoot, name)?.agents.length ?? 0
  }
  return result
}

export interface DeleteStampedFlowResult {
  deletedCategory: string
  outputDir: string
  removedAgentsCount: number
  removedInstalledAgents: string[]
  removedInstalledCommands: string[]
}

/** Remove a stamped `*-flow` bundle (and optionally its installed agents and commands). Never the canonical flow. */
export function deleteStampedFlow(workspaceRoot: string, targetName: string, options: { alsoInstalled?: boolean; env?: NodeJS.ProcessEnv } = {}): DeleteStampedFlowResult {
  const deletedCategory = normalizeFlowCategoryName(targetName)
  if (!isStampedFlowCategory(deletedCategory)) throw new Error(`Refusing to delete the canonical '${FLOW_BASE_CATEGORY}' category; only stamped *-flow bundles can be deleted.`)
  const outputDir = path.join(categoriesRootOf(workspaceRoot), deletedCategory)
  assertSafeDirectory(workspaceRoot, outputDir)
  if (!fs.existsSync(outputDir)) throw new Error(`Stamped flow '${deletedCategory}' does not exist at ${outputDir}.`)
  const rejectSymlinks = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name)
      const stat = fs.lstatSync(entryPath)
      if (stat.isSymbolicLink()) throw new Error(`Stamped flow must not contain symlinks: ${entryPath}`)
      if (stat.isDirectory()) rejectSymlinks(entryPath)
    }
  }
  rejectSymlinks(outputDir)
  const agentsDir = path.join(outputDir, "agents")
  const removedAgentsCount = fs.existsSync(agentsDir) ? fs.readdirSync(agentsDir).filter(name => name.endsWith(".md")).length : 0
  fs.rmSync(outputDir, { recursive: true, force: false })

  if (fs.existsSync(getCompanionLinksConfigPath(workspaceRoot))) {
    const links = loadCompanionLinks(workspaceRoot)
    if (Object.prototype.hasOwnProperty.call(links.categories, deletedCategory)) {
      delete links.categories[deletedCategory]
      saveCompanionLinks(workspaceRoot, links)
    }
  }

  const removedInstalledAgents: string[] = []
  const removedInstalledCommands: string[] = []
  if (options.alsoInstalled) {
    const agentsDestination = getExportDestination(options.env)
    const commandsDestination = path.join(path.dirname(agentsDestination), "commands")
    for (const [directory, removed] of [[agentsDestination, removedInstalledAgents], [commandsDestination, removedInstalledCommands]] as const) {
      const stat = fs.lstatSync(directory, { throwIfNoEntry: false })
      if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) continue
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.startsWith(`${deletedCategory}-`) || !entry.name.endsWith(".md")) continue
        const entryPath = path.join(directory, entry.name)
        fs.rmSync(entryPath, { force: false })
        removed.push(entryPath)
      }
    }
  }
  return { deletedCategory, outputDir, removedAgentsCount, removedInstalledAgents: removedInstalledAgents.sort(), removedInstalledCommands: removedInstalledCommands.sort() }
}

export interface FlowBundleCheck {
  category: string
  resourceRoot: string
  problems: string[]
}

/**
 * Read-only check of the stamped flow bundles: every flow role has an agent, the guard and tool
 * plugins are shipped, and nothing is out of date with the canonical sources (reported as drift).
 */
export function checkFlowBundles(workspaceRoot: string, categories?: string[]): FlowBundleCheck[] {
  const wanted = categories?.map(normalizeFlowCategoryName)
  const results: FlowBundleCheck[] = []
  for (const category of listStampedFlowCategories(workspaceRoot)) {
    if (wanted && !wanted.includes(category)) continue
    const resourceRoot = path.join(categoriesRootOf(workspaceRoot), category)
    const problems: string[] = []
    const roles = new Set((loadStampedPipelineAgents(workspaceRoot, category)?.agents ?? []).map(agent => extractFlowRole(agent.filename, category)))
    const missingRoles = baseFlowAgents(workspaceRoot).map(agent => extractFlowRole(agent.filename)!).filter(role => !roles.has(role))
    if (missingRoles.length) problems.push(`missing agents for roles: ${missingRoles.join(", ")}`)
    for (const plugin of ["flow-guard", "pipeline-tools"]) {
      if (!["index.ts", "index.js"].some(entry => fs.existsSync(path.join(resourceRoot, "plugins", plugin, entry)))) problems.push(`plugin ${plugin} is not shipped`)
    }
    const drift = refreshStampedFlowsFromSource(workspaceRoot, category, { dryRun: true })
    const outOfDate = drift.updatedAgents.length + drift.updatedCompanions.length
    if (outOfDate > 0) problems.push(`${drift.updatedAgents.length} agent(s) and ${drift.updatedCompanions.length} companion(s) out of date; run \`category build --all\``)
    results.push({ category, resourceRoot, problems })
  }
  return results
}
