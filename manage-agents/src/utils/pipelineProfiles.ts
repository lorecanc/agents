import fs from "node:fs"
import path from "node:path"
import { discoverCompanionResourcePaths, findAgentFiles, getExportDestination, resolveCategoriesSubdir, resolveSourceSubdir, saveAgentFile, type AgentInfo } from "./agents.js"
import { copyCategoryCompanionLinks, getCompanionLinksConfigPath, loadCompanionLinks, saveCompanionLinks } from "./companionLinks.js"

export const PIPELINE_ROLES = [
  "orchestrator", "planner", "reasoner", "executor", "tester", "refactorer", "code_reviewer", "critic", "ops",
  "explorer", "researcher", "docs_grounding", "fast_lane", "hitl", "post_session", "chrome_devtools",
  "frontend_specialist", "swift_specialist", "kotlin_specialist", "security_auditor", "multimodal"
] as const

export const PIPELINE_ROLE_GROUPS = {
  orchestration: ["orchestrator"],
  planning: ["planner", "reasoner"],
  execution: ["executor", "tester", "refactorer", "code_reviewer", "critic", "ops"],
  fast: ["explorer", "researcher", "docs_grounding", "fast_lane", "hitl", "post_session"],
  specialist: ["chrome_devtools", "frontend_specialist", "swift_specialist", "kotlin_specialist", "security_auditor", "multimodal"]
} as const

export interface PipelineRoleModelSpec {
  model: string
  variant?: string
}

export interface PipelineProfile {
  description: string
  defaults?: Record<string, PipelineRoleModelSpec>
  roles?: Record<string, PipelineRoleModelSpec>
}

export interface PipelineProfilesConfig {
  version: 1
  baseCategory: string
  profiles: Record<string, PipelineProfile>
}

export interface DeleteStampedPipelineOptions {
  alsoInstalled?: boolean
  env?: NodeJS.ProcessEnv
}

export interface DeleteStampedPipelineResult {
  deletedCategory: string
  outputDir: string
  removedAgentsCount: number
  removedInstalledAgents: string[]
  removedInstalledCommands: string[]
}

export const DEFAULT_PIPELINE_PROFILES: PipelineProfilesConfig = {
  version: 1,
  baseCategory: "pipeline",
  profiles: {
    hybrid: {
      description: "Mistral GLM-5.3 for orchestration/planning/reasoning + DeepSeek V4.1 Flash for execution and specialists.",
      defaults: {
        orchestration: { model: "mistral/zai-glm-5-3" },
        planning: { model: "mistral/zai-glm-5-3" },
        execution: { model: "opencode-go/deepseek-v4.1-flash" },
        fast: { model: "opencode-go/deepseek-v4.1-flash" },
        specialist: { model: "opencode-go/deepseek-v4.1-flash" }
      }
    },
    go: { description: "OpenCode Go DeepSeek V4.1 Flash across all pipeline roles.", defaults: { all: { model: "opencode-go/deepseek-v4.1-flash" } } },
    mistral: { description: "Mistral ZAI GLM-5.3 across all pipeline roles.", defaults: { all: { model: "mistral/zai-glm-5-3" } } },
    collector: { description: "OpenCode Go Muse Spark 1.3 Contributor across all pipeline roles.", defaults: { all: { model: "opencode-go/muse-spark-1.3-contributor" } } },
    free: { description: "OpenCode Free Muse Spark 1.3 Contributor across all pipeline roles.", defaults: { all: { model: "opencode/muse-spark-1.3-contributor-free" } } },
    copilot: {
      description: "GitHub Copilot Claude Opus 4.6 (high) for planning/reasoning, Sonnet 4.6 (medium) for execution, Haiku 4.5 (low) for fast/discovery.",
      defaults: {
        orchestration: { model: "github-copilot/claude-opus-4.6", variant: "high" },
        planning: { model: "github-copilot/claude-opus-4.6", variant: "high" },
        execution: { model: "github-copilot/claude-sonnet-4.6", variant: "medium" },
        specialist: { model: "github-copilot/claude-sonnet-4.6", variant: "medium" },
        fast: { model: "github-copilot/claude-haiku-4.5", variant: "low" }
      }
    },
    cp_nightly: {
      description: "GitHub Copilot Gemini 4 Argon with tiered thinking effort (high/medium/low).",
      defaults: {
        orchestration: { model: "github-copilot/gemini-4-argon", variant: "high" },
        planning: { model: "github-copilot/gemini-4-argon", variant: "high" },
        execution: { model: "github-copilot/gemini-4-argon", variant: "medium" },
        specialist: { model: "github-copilot/gemini-4-argon", variant: "medium" },
        fast: { model: "github-copilot/gemini-4-argon", variant: "low" }
      }
    }
  }
}

export function pipelineProfilesPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".agent-manager", "pipeline-profiles.json")
}

export function loadPipelineProfiles(workspaceRoot: string): PipelineProfilesConfig {
  const configPath = pipelineProfilesPath(workspaceRoot)
  if (!fs.existsSync(configPath)) return structuredClone(DEFAULT_PIPELINE_PROFILES)
  return JSON.parse(fs.readFileSync(configPath, "utf8")) as PipelineProfilesConfig
}

export function savePipelineProfiles(workspaceRoot: string, config: PipelineProfilesConfig): string {
  const configPath = pipelineProfilesPath(workspaceRoot)
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8")
  return configPath
}

export function extractPipelineRole(filenameOrName: string, categoryPrefix = "pipeline"): string | null {
  const filename = path.basename(filenameOrName).replace(/\.md$/i, "")
  const match = filename.match(/^(?:[a-z0-9_-]+-)?pipeline-([a-z0-9_]+)$/i)
  const role = match?.[1]?.toLocaleLowerCase("und")
  return role && (categoryPrefix === "pipeline" || filename.startsWith(`${categoryPrefix}-`)) ? role : null
}

export function resolveProfileRoleSpec(profile: PipelineProfile, role: string): PipelineRoleModelSpec | null {
  if (profile.roles?.[role]) return profile.roles[role]
  for (const [group, roles] of Object.entries(PIPELINE_ROLE_GROUPS)) {
    if (roles.includes(role as never) && profile.defaults?.[group]) return profile.defaults[group]
  }
  return profile.defaults?.all ?? null
}

function getProfile(workspaceRoot: string, profileName: string): { config: PipelineProfilesConfig; profile: PipelineProfile } {
  const config = loadPipelineProfiles(workspaceRoot)
  const profile = config.profiles[profileName]
  if (!profile) throw new Error(`Unknown pipeline profile '${profileName}'`)
  return { config, profile }
}

export function applyPipelineProfile(
  workspaceRoot: string,
  profileName: string,
  targetCategory?: string
): { updated: string[]; profileName: string; targetCategory: string } {
  const { config, profile } = getProfile(workspaceRoot, profileName)
  const category = (targetCategory || config.baseCategory).trim()
  const updated: string[] = []
  let matchingAgents = findAgentFiles(workspaceRoot).filter(agent => agent.category === category)
  const stampedRoot = path.join(workspaceRoot, resolveCategoriesSubdir(workspaceRoot), category)
  if (!matchingAgents.length && fs.existsSync(path.join(stampedRoot, "agents"))) {
    matchingAgents = findAgentFiles(workspaceRoot, path.join(resolveCategoriesSubdir(workspaceRoot), category))
  }
  for (const agent of matchingAgents) {
    const role = extractPipelineRole(agent.filename, category)
    if (!role) continue
    const spec = resolveProfileRoleSpec(profile, role)
    if (!spec) continue
    const frontmatter: Record<string, any> = { ...agent.frontmatter, model: spec.model }
    if (typeof spec.variant === "string" && spec.variant.length > 0) frontmatter.variant = spec.variant
    else delete frontmatter.variant
    saveAgentFile(agent.currentPath, frontmatter, agent.body, agent.frontmatterVersion)
    updated.push(agent.currentPath)
  }
  return { updated, profileName, targetCategory: category }
}

export function syncPipelineProfile(
  workspaceRoot: string,
  profileName: string,
  targetCategory?: string
): { synced: string[]; targetCategory: string; outputDir: string; baseCategory: string; profileName: string; backupsPath: string | null } {
  const { config, profile } = getProfile(workspaceRoot, profileName)
  const baseCategory = config.baseCategory
  const resolvedTarget = targetCategory
    ? (targetCategory === "pipeline" || targetCategory.endsWith("-pipeline") ? targetCategory : `${targetCategory}-pipeline`)
    : `${profileName}-pipeline`

  if (resolvedTarget === baseCategory) {
    const applied = applyPipelineProfile(workspaceRoot, profileName, baseCategory)
    return { synced: applied.updated, targetCategory: baseCategory, outputDir: path.join(workspaceRoot, resolveSourceSubdir(workspaceRoot)), baseCategory, profileName, backupsPath: null }
  }

  const baseAgents = findAgentFiles(workspaceRoot).filter(agent => agent.category === baseCategory)
  const outputDir = path.join(workspaceRoot, resolveCategoriesSubdir(workspaceRoot), resolvedTarget)
  const agentsDir = path.join(outputDir, "agents")
  fs.mkdirSync(agentsDir, { recursive: true })
  for (const name of fs.readdirSync(agentsDir)) {
    if (name.endsWith(".md")) fs.rmSync(path.join(agentsDir, name), { force: true })
  }
  const profilePrefix = resolvedTarget.replace(/-pipeline$/, "")
  const synced: string[] = []
  for (const agent of baseAgents) {
    const role = extractPipelineRole(agent.filename, baseCategory)
    if (!role) continue
    const spec = resolveProfileRoleSpec(profile, role)
    if (!spec) continue
    const targetFilename = `${resolvedTarget}-${role}.md`
    const targetPath = path.join(agentsDir, targetFilename)
    const frontmatter: Record<string, any> = { ...agent.frontmatter, model: spec.model }
    if (typeof spec.variant === "string" && spec.variant.length > 0) frontmatter.variant = spec.variant
    else delete frontmatter.variant
    if (frontmatter.permission?.task && typeof frontmatter.permission.task === "object" && !Array.isArray(frontmatter.permission.task)) {
      frontmatter.permission = { ...frontmatter.permission, task: Object.fromEntries(Object.entries(frontmatter.permission.task).map(([key, value]) => [
        key.startsWith("pipeline-") ? `${resolvedTarget}-${key.slice("pipeline-".length)}` : key, value
      ])) }
    }
    const updatedBody = agent.body
      .replace(/@pipeline-/g, `@${resolvedTarget}-`)
      .replace(/# pipeline-/g, `# ${resolvedTarget}-`)
      .replace(/pipeline-([a-z0-9_-]+)(?=["']?\s*:)/gi, `${resolvedTarget}-$1`)
      .replace(/\/pipeline-/g, `/${profilePrefix}-`)
    saveAgentFile(targetPath, frontmatter, updatedBody, agent.frontmatterVersion)
    synced.push(targetPath)
  }

  const sourceRoot = path.join(workspaceRoot, resolveSourceSubdir(workspaceRoot))
  for (const rel of discoverCompanionResourcePaths(sourceRoot, [baseCategory], undefined, baseAgents)) {
    let destinationRelative = rel
    let content: string | undefined
    if (rel.startsWith("commands/pipeline-")) {
      destinationRelative = `commands/${profilePrefix}-${rel.slice("commands/pipeline-".length)}`
      content = fs.readFileSync(path.join(sourceRoot, rel), "utf8")
        .replace(/pipeline-orchestrator/g, `${resolvedTarget}-orchestrator`)
        .replace(/@pipeline-/g, `@${resolvedTarget}-`)
        .replace(/\/pipeline-/g, `/${profilePrefix}-`)
        .replace(/Pipeline:/g, `${profilePrefix} pipeline:`)
    }
    const destination = path.join(outputDir, destinationRelative)
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    if (content === undefined) fs.copyFileSync(path.join(sourceRoot, rel), destination)
    else fs.writeFileSync(destination, content, "utf8")
  }
  copyCategoryCompanionLinks(workspaceRoot, baseCategory, resolvedTarget)
  return { synced, targetCategory: resolvedTarget, outputDir, baseCategory, profileName, backupsPath: null }
}

export function loadStampedPipelineAgents(workspaceRoot: string, category: string): { agents: AgentInfo[]; resourceRoot: string } | null {
  const resourceRoot = path.join(workspaceRoot, resolveCategoriesSubdir(workspaceRoot), category)
  if (!fs.existsSync(path.join(resourceRoot, "agents"))) return null
  const agents = findAgentFiles(workspaceRoot, path.join(resolveCategoriesSubdir(workspaceRoot), category))
  return agents.length ? { agents, resourceRoot } : null
}

export function deleteStampedPipeline(
  workspaceRoot: string,
  targetName: string,
  options: DeleteStampedPipelineOptions = {}
): DeleteStampedPipelineResult {
  const trimmed = targetName.trim()
  if (!trimmed || trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..") || !/^[a-z0-9_-]+$/i.test(trimmed)) {
    throw new Error(`Invalid stamped pipeline name '${targetName}'.`)
  }

  const deletedCategory = trimmed === "pipeline" || trimmed.endsWith("-pipeline") ? trimmed : `${trimmed}-pipeline`
  const config = loadPipelineProfiles(workspaceRoot)
  if (deletedCategory === "pipeline" || deletedCategory === config.baseCategory) {
    throw new Error(`Refusing to delete canonical base pipeline '${deletedCategory}'.`)
  }

  const sourceSubdir = resolveSourceSubdir(workspaceRoot)
  if (findAgentFiles(workspaceRoot, sourceSubdir).some(agent => agent.category === deletedCategory)) {
    throw new Error(`Refusing to delete source category '${deletedCategory}' in ${sourceSubdir}/agents/.`)
  }

  const categoriesRoot = path.join(workspaceRoot, resolveCategoriesSubdir(workspaceRoot))
  const outputDir = path.join(categoriesRoot, deletedCategory)
  const validateDirectoryPath = (trustedRoot: string, directory: string): boolean => {
    const root = path.resolve(trustedRoot)
    const target = path.resolve(directory)
    const relative = path.relative(root, target)
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Invalid directory path outside trusted root: ${directory}.`)
    }
    let current = root
    for (const component of ["", ...relative.split(path.sep).filter(Boolean)]) {
      if (component) current = path.join(current, component)
      const stat = fs.lstatSync(current, { throwIfNoEntry: false })
      if (!stat) return false
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Invalid directory path at ${current}.`)
    }
    return true
  }
  if (!validateDirectoryPath(workspaceRoot, categoriesRoot)) {
    throw new Error(`Invalid stamped pipeline categories directory at ${categoriesRoot}.`)
  }
  if (!validateDirectoryPath(workspaceRoot, outputDir)) {
    throw new Error(`Stamped pipeline '${deletedCategory}' does not exist at ${outputDir}.`)
  }

  const rejectSymlinks = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name)
      const entryStat = fs.lstatSync(entryPath)
      if (entryStat.isSymbolicLink()) throw new Error(`Stamped pipeline must not contain symlinks: ${entryPath}`)
      if (entryStat.isDirectory()) rejectSymlinks(entryPath)
    }
  }
  rejectSymlinks(outputDir)

  const agentsDir = path.join(outputDir, "agents")
  const removedAgentsCount = fs.existsSync(agentsDir)
    ? fs.readdirSync(agentsDir, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith(".md")).length
    : 0

  const companionLinksPath = getCompanionLinksConfigPath(workspaceRoot)
  const links = fs.existsSync(companionLinksPath) ? loadCompanionLinks(workspaceRoot) : null

  const installedPaths = options.alsoInstalled
    ? (() => {
      const exportAgentsDir = getExportDestination(options.env)
      const opencodeRoot = path.dirname(exportAgentsDir)
      const exportCommandsDir = path.join(opencodeRoot, "commands")
      const configHome = path.dirname(opencodeRoot)
      const agentsAvailable = validateDirectoryPath(configHome, exportAgentsDir)
      const commandsAvailable = validateDirectoryPath(configHome, exportCommandsDir)
      return { exportAgentsDir, exportCommandsDir, agentsAvailable, commandsAvailable }
    })()
    : null

  const installedCommandNames = new Set<string>()
  const prefix = deletedCategory.replace(/-pipeline$/, "")
  const addLinkedCommand = (relative: string): void => {
    if (!relative.startsWith("commands/")) return
    const filename = path.posix.basename(relative)
    if (!filename.endsWith(".md")) return
    if (filename.startsWith("pipeline-") && prefix && prefix !== "pipeline") {
      installedCommandNames.add(`${prefix}-${filename.slice("pipeline-".length)}`)
    } else if (!filename.startsWith("pipeline-")) {
      installedCommandNames.add(filename)
    }
  }
  const stampedCommandsDir = path.join(outputDir, "commands")
  if (fs.existsSync(stampedCommandsDir)) {
    for (const entry of fs.readdirSync(stampedCommandsDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md")) installedCommandNames.add(entry.name)
    }
  }
  for (const command of links?.categories[deletedCategory]?.commands ?? []) addLinkedCommand(command)

  fs.rmSync(outputDir, { recursive: true, force: false })

  if (links && Object.prototype.hasOwnProperty.call(links.categories, deletedCategory)) {
    delete links.categories[deletedCategory]
    saveCompanionLinks(workspaceRoot, links)
  }

  const removedInstalledAgents: string[] = []
  const removedInstalledCommands: string[] = []
  if (installedPaths) {
    const removeMatchingFiles = (directory: string, prefix: string, removed: string[]): void => {
      if (!validateDirectoryPath(path.dirname(path.dirname(directory)), directory)) return
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!entry.name.startsWith(`${prefix}-`) || !entry.name.endsWith(".md")) continue
        const entryPath = path.join(directory, entry.name)
        const entryStat = fs.lstatSync(entryPath)
        if (!entryStat.isSymbolicLink() && entryStat.isFile()) {
          fs.rmSync(entryPath, { force: false })
          removed.push(entryPath)
        }
      }
    }
    if (installedPaths.agentsAvailable) removeMatchingFiles(installedPaths.exportAgentsDir, deletedCategory, removedInstalledAgents)
    if (installedPaths.commandsAvailable) {
      for (const commandName of installedCommandNames) {
        const commandPath = path.join(installedPaths.exportCommandsDir, commandName)
        const stat = fs.lstatSync(commandPath, { throwIfNoEntry: false })
        if (stat && !stat.isSymbolicLink() && stat.isFile()) {
          fs.rmSync(commandPath, { force: false })
          removedInstalledCommands.push(commandPath)
        }
      }
    }
  }

  return {
    deletedCategory,
    outputDir,
    removedAgentsCount,
    removedInstalledAgents: removedInstalledAgents.sort(),
    removedInstalledCommands: removedInstalledCommands.sort()
  }
}
