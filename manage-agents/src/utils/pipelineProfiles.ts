import fs from "node:fs"
import path from "node:path"
import YAML from "yaml"
import { discoverCompanionResourcePaths, findAgentFiles, getExportDestination, resolveCategoriesSubdir, resolveSourceSubdir, saveAgentFile, type AgentInfo } from "./agents.js"
import { copyCategoryCompanionLinks, getCompanionLinksConfigPath, loadCompanionLinks, saveCompanionLinks } from "./companionLinks.js"
import { translateFrontmatterV1ToV2 } from "./v2Compat.js"

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

export function normalizePipelineCategoryName(target: string): string {
  const trimmed = target.trim().replace(/-+$/, "")
  const normalized = trimmed === "pipeline" || trimmed.endsWith("-pipeline") ? trimmed : `${trimmed}-pipeline`
  if (!/^[a-z0-9_-]+$/i.test(normalized)) throw new Error(`Invalid stamped pipeline name '${target}'.`)
  return normalized
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function replacePipelinePathReferences(body: string, sourceCategory: string, targetPrefix: string): string {
  const sourcePrefix = sourceCategory.replace(/-pipeline$/, "")
  const prefixes = sourceCategory === "pipeline" ? ["pipeline"] : [sourcePrefix, "pipeline"]
  for (const prefix of [...new Set(prefixes)]) {
    const escaped = escapeRegExp(prefix)
    body = body.replace(new RegExp(`/${escaped}-`, "g"), (match, offset, whole) =>
      whole.slice(offset + match.length).startsWith("guard.js") ? match : `/${targetPrefix}-`)
  }
  return body
}

export function rewritePipelineBody(body: string, resolvedTarget: string, sourceCategory = "pipeline"): string {
  const targetPrefix = resolvedTarget.replace(/-pipeline$/, "")
  let rewritten = body
    .replaceAll(`@${sourceCategory}-`, `@${resolvedTarget}-`)
    .replaceAll("@pipeline-", `@${resolvedTarget}-`)
    .replaceAll(`# ${sourceCategory}-`, `# ${resolvedTarget}-`)
    .replaceAll("# pipeline-", `# ${resolvedTarget}-`)
  const categoryPattern = sourceCategory === "pipeline" ? "pipeline" : `${escapeRegExp(sourceCategory)}|pipeline`
  rewritten = rewritten.replace(new RegExp(`(?:${categoryPattern})-([a-z0-9_]+)(?=[\"']?\\s*:)`, "gi"), (match, role: string) =>
    /^Pipeline-Checkpoint$/i.test(match) ? match : `${resolvedTarget}-${role}`)
  return replacePipelinePathReferences(rewritten, sourceCategory, targetPrefix)
}

export function rewritePipelineTaskPermissions(taskPerm: Record<string, any>, resolvedTarget: string, sourceCategory = "pipeline"): Record<string, any> {
  const rewritten: Record<string, any> = {}
  const prefixes = [...new Set([`${sourceCategory}-`, "pipeline-"])]
  for (const [key, value] of Object.entries(taskPerm)) {
    const prefix = prefixes.find(candidate => key.startsWith(candidate))
    const nextKey = prefix ? `${resolvedTarget}-${key.slice(prefix.length)}` : key
    if (nextKey === "*") continue
    rewritten[nextKey] = value
  }
  if (Object.prototype.hasOwnProperty.call(taskPerm, "*")) return { "*": taskPerm["*"], ...rewritten }
  return rewritten
}

export function rewritePipelineCommandContent(content: string, resolvedTarget: string, sourceCategory = "pipeline"): string {
  const targetPrefix = resolvedTarget.replace(/-pipeline$/, "")
  let rewritten = content
    .replaceAll(`${sourceCategory}-orchestrator`, `${resolvedTarget}-orchestrator`)
    .replaceAll("pipeline-orchestrator", `${resolvedTarget}-orchestrator`)
    .replaceAll(`@${sourceCategory}-`, `@${resolvedTarget}-`)
    .replaceAll("@pipeline-", `@${resolvedTarget}-`)
  rewritten = replacePipelinePathReferences(rewritten, sourceCategory, targetPrefix)
  return rewritten.replaceAll("Pipeline:", `${targetPrefix} pipeline:`)
}

export interface RefreshStampedPipelinesResult {
  refreshedCategories: string[]
  updatedAgents: string[]
  updatedCompanions: string[]
}

function renderPipelineAgent(frontmatter: Record<string, any>, body: string, version?: AgentInfo["frontmatterVersion"]): string {
  const frontmatterToWrite = version === "v2" ? translateFrontmatterV1ToV2(frontmatter) : frontmatter
  const yamlText = YAML.stringify(frontmatterToWrite).trim()
  const normalizedBody = body.replace(/^(?:[ \t]*\r?\n)+/, "")
  return normalizedBody ? `---\n${yamlText}\n---\n\n${normalizedBody}` : `---\n${yamlText}\n---\n`
}

function keepWildcardFirst(value: Record<string, any>): Record<string, any> {
  const normalized = Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    Array.isArray(child)
      ? child.map(item => item && typeof item === "object" && !Array.isArray(item) ? keepWildcardFirst(item) : item)
      : child && typeof child === "object" ? keepWildcardFirst(child) : child
  ]))
  if (!Object.prototype.hasOwnProperty.call(normalized, "*")) return normalized
  const { "*": wildcard, ...rest } = normalized
  return { "*": wildcard, ...rest }
}

export function refreshStampedPipelinesFromSource(workspaceRoot: string, targetCategory?: string): RefreshStampedPipelinesResult {
  const emptyResult = (): RefreshStampedPipelinesResult => ({ refreshedCategories: [], updatedAgents: [], updatedCompanions: [] })
  const config = loadPipelineProfiles(workspaceRoot)
  const baseCategory = config.baseCategory || "pipeline"
  const categoriesRoot = path.join(workspaceRoot, resolveCategoriesSubdir(workspaceRoot))
  if (!fs.existsSync(categoriesRoot)) return emptyResult()

  let targets: string[]
  if (targetCategory !== undefined) {
    const normalized = normalizePipelineCategoryName(targetCategory)
    if (normalized === baseCategory || !fs.existsSync(path.join(categoriesRoot, normalized, "agents"))) return emptyResult()
    targets = [normalized]
  } else {
    targets = fs.readdirSync(categoriesRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name.endsWith("-pipeline") && entry.name !== baseCategory && fs.existsSync(path.join(categoriesRoot, entry.name, "agents")))
      .map(entry => entry.name)
  }

  const baseAgents = findAgentFiles(workspaceRoot, resolveSourceSubdir(workspaceRoot)).filter(agent => agent.category === baseCategory)
  if (baseAgents.length === 0) return emptyResult()
  const baseAgentsByRole = new Map<string, AgentInfo>()
  for (const agent of baseAgents) {
    const role = extractPipelineRole(agent.filename, baseCategory)
    if (role) baseAgentsByRole.set(role, agent)
  }

  const result: RefreshStampedPipelinesResult = { refreshedCategories: [], updatedAgents: [], updatedCompanions: [] }
  const sourceRoot = path.join(workspaceRoot, resolveSourceSubdir(workspaceRoot))
  for (const resolvedTarget of targets) {
    const outputDir = path.join(categoriesRoot, resolvedTarget)
    const profilePrefix = resolvedTarget.replace(/-pipeline$/, "")
    const existingAgents = loadStampedPipelineAgents(workspaceRoot, resolvedTarget)?.agents ?? []
    const existingByRole = new Map<string, AgentInfo>()
    for (const existing of existingAgents) {
      const role = extractPipelineRole(existing.filename, resolvedTarget)
      if (role) existingByRole.set(role, existing)
    }

    for (const [role, baseAgent] of baseAgentsByRole) {
      const existing = existingByRole.get(role)
      const body = rewritePipelineBody(baseAgent.body, resolvedTarget, baseCategory)
      const frontmatter: Record<string, any> = {
        ...structuredClone(existing?.frontmatter ?? {}),
        ...structuredClone(baseAgent.frontmatter)
      }
      const basePermission = frontmatter.permission && typeof frontmatter.permission === "object" && !Array.isArray(frontmatter.permission)
        ? frontmatter.permission as Record<string, any>
        : {}
      if (basePermission.task && typeof basePermission.task === "object" && !Array.isArray(basePermission.task)) {
        basePermission.task = rewritePipelineTaskPermissions(basePermission.task, resolvedTarget, baseCategory)
      }
      if (existing) {
        for (const key of ["model", "temperature", "mode", "hidden", "color"]) {
          if (Object.prototype.hasOwnProperty.call(existing.frontmatter, key)) frontmatter[key] = existing.frontmatter[key]
        }
        if (Object.prototype.hasOwnProperty.call(existing.frontmatter, "variant")) frontmatter.variant = existing.frontmatter.variant
        else delete frontmatter.variant
        const existingStepKey = Object.prototype.hasOwnProperty.call(existing.frontmatter, "steps") ? "steps"
          : Object.prototype.hasOwnProperty.call(existing.frontmatter, "max_steps") ? "max_steps" : null
        if (existingStepKey) {
          delete frontmatter.steps
          delete frontmatter.max_steps
          frontmatter[existingStepKey] = existing.frontmatter[existingStepKey]
        }
        const existingPermission = existing.frontmatter.permission && typeof existing.frontmatter.permission === "object" && !Array.isArray(existing.frontmatter.permission)
          ? existing.frontmatter.permission as Record<string, any>
          : {}
        const mergedPermission: Record<string, any> = { ...basePermission }
        for (const [key, value] of Object.entries(existingPermission)) {
          if (!Object.prototype.hasOwnProperty.call(basePermission, key)) mergedPermission[key] = value
          else if (value && typeof value === "object" && !Array.isArray(value) && basePermission[key] && typeof basePermission[key] === "object" && !Array.isArray(basePermission[key])) {
            mergedPermission[key] = keepWildcardFirst({ ...value, ...basePermission[key] })
          }
        }
        if (basePermission.task && existingPermission.task && typeof existingPermission.task === "object" && !Array.isArray(existingPermission.task)) {
          mergedPermission.task = rewritePipelineTaskPermissions({ ...existingPermission.task, ...basePermission.task }, resolvedTarget, baseCategory)
        }
        frontmatter.permission = keepWildcardFirst(mergedPermission)
      } else {
        const profile = config.profiles[profilePrefix]
        const spec = profile && resolveProfileRoleSpec(profile, role)
        if (spec) {
          frontmatter.model = spec.model
          if (typeof spec.variant === "string" && spec.variant.length > 0) frontmatter.variant = spec.variant
          else delete frontmatter.variant
        }
      }

      const targetPath = path.join(outputDir, "agents", `${resolvedTarget}-${role}.md`)
      const rendered = renderPipelineAgent(frontmatter, body, existing?.frontmatterVersion ?? baseAgent.frontmatterVersion)
      if (!fs.existsSync(targetPath) || fs.readFileSync(targetPath, "utf8") !== rendered) {
        saveAgentFile(targetPath, frontmatter, body, existing?.frontmatterVersion ?? baseAgent.frontmatterVersion)
        result.updatedAgents.push(targetPath)
      }
    }

    const companionPaths = discoverCompanionResourcePaths(sourceRoot, [baseCategory], undefined, baseAgents)
    if (fs.existsSync(path.join(sourceRoot, ".opencode", "pipeline.json"))) companionPaths.push(".opencode/pipeline.json")
    for (const rel of companionPaths) {
      const sourcePath = path.join(sourceRoot, ...rel.split("/"))
      if (rel.startsWith("commands/pipeline-")) {
        const destRel = `commands/${profilePrefix}-${rel.slice("commands/pipeline-".length)}`
        const destPath = path.join(outputDir, ...destRel.split("/"))
        const nextContent = rewritePipelineCommandContent(fs.readFileSync(sourcePath, "utf8"), resolvedTarget, baseCategory)
        if (!fs.existsSync(destPath) || fs.readFileSync(destPath, "utf8") !== nextContent) {
          fs.mkdirSync(path.dirname(destPath), { recursive: true })
          fs.writeFileSync(destPath, nextContent, "utf8")
          result.updatedCompanions.push(destPath)
        }
      } else {
        const destPath = path.join(outputDir, ...rel.split("/"))
        const srcBytes = fs.readFileSync(sourcePath)
        if (!fs.existsSync(destPath) || !fs.readFileSync(destPath).equals(srcBytes)) {
          fs.mkdirSync(path.dirname(destPath), { recursive: true })
          fs.copyFileSync(sourcePath, destPath)
          result.updatedCompanions.push(destPath)
        }
      }
    }
    result.refreshedCategories.push(resolvedTarget)
  }
  return result
}

export interface ForkStampedPipelineResult {
  createdCategories: string[]
  copied: string[]
  updated: string[]
  outputDirs: string[]
}

function validateForkPath(workspaceRoot: string, targetPath: string, expectDirectory: boolean): void {
  const root = path.resolve(workspaceRoot)
  const target = path.resolve(targetPath)
  const relative = path.relative(root, target)
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Invalid fork destination outside workspace: ${targetPath}.`)
  }

  let current = root
  const rootStat = fs.lstatSync(root, { throwIfNoEntry: false })
  if (rootStat && (rootStat.isSymbolicLink() || !rootStat.isDirectory())) throw new Error(`Invalid fork destination at ${current}.`)
  const components = relative.split(path.sep).filter(Boolean)
  for (let index = 0; index < components.length; index++) {
    current = path.join(current, components[index])
    const stat = fs.lstatSync(current, { throwIfNoEntry: false })
    if (!stat) return
    const isLeaf = index === components.length - 1
    if (stat.isSymbolicLink() || (isLeaf && expectDirectory ? !stat.isDirectory() : !isLeaf && !stat.isDirectory())) {
      throw new Error(`Invalid fork destination at ${current}.`)
    }
    if (isLeaf && !expectDirectory && !stat.isFile()) throw new Error(`Invalid fork destination at ${current}.`)
  }
}

export function forkStampedPipeline(
  workspaceRoot: string,
  sourceCategory: string,
  targets: string | readonly string[],
  options: { profileName?: string; selectedPaths?: string[] } = {}
): ForkStampedPipelineResult {
  const config = loadPipelineProfiles(workspaceRoot)
  const baseCategory = config.baseCategory || "pipeline"
  const rawTargets = typeof targets === "string" ? targets.split(",").map(value => value.trim()).filter(Boolean) : targets.map(value => value.trim()).filter(Boolean)
  const resolvedTargets = rawTargets.map(normalizePipelineCategoryName)
  const normalizedTargetKeys = new Set<string>()
  for (const target of resolvedTargets) {
    const key = target.toLocaleLowerCase("und")
    if (normalizedTargetKeys.has(key)) throw new Error(`Duplicate stamped pipeline target '${target}'.`)
    normalizedTargetKeys.add(key)
  }

  if (options.profileName && !config.profiles[options.profileName]) throw new Error(`Unknown pipeline profile '${options.profileName}'`)

  let sourceAgents = sourceCategory === baseCategory
    ? findAgentFiles(workspaceRoot, resolveSourceSubdir(workspaceRoot)).filter(agent => agent.category === baseCategory && extractPipelineRole(agent.filename, baseCategory) !== null)
    : loadStampedPipelineAgents(workspaceRoot, sourceCategory)?.agents ?? []
  if (options.selectedPaths && options.selectedPaths.length > 0) {
    const selected = new Set(options.selectedPaths)
    sourceAgents = sourceAgents.filter(agent => selected.has(agent.currentPath) || selected.has(agent.filename) || selected.has(agent.targetPath))
  }
  if (sourceAgents.length === 0) throw new Error(`No pipeline agents found in source category "${sourceCategory}".`)

  const sourceRoot = path.join(workspaceRoot, resolveSourceSubdir(workspaceRoot))
  const baseAgents = findAgentFiles(workspaceRoot, resolveSourceSubdir(workspaceRoot)).filter(agent => agent.category === baseCategory && extractPipelineRole(agent.filename, baseCategory) !== null)
  const companionPaths = discoverCompanionResourcePaths(sourceRoot, [baseCategory], undefined, baseAgents)
  if (fs.existsSync(path.join(sourceRoot, ".opencode", "pipeline.json"))) companionPaths.push(".opencode/pipeline.json")
  for (const resolvedTarget of resolvedTargets) {
    if (resolvedTarget === baseCategory) throw new Error(`Refusing to fork into canonical base pipeline "${baseCategory}".`)
    if (resolvedTarget === sourceCategory) continue

    const outputDir = path.join(workspaceRoot, resolveCategoriesSubdir(workspaceRoot), resolvedTarget)
    const agentsDir = path.join(outputDir, "agents")
    validateForkPath(workspaceRoot, outputDir, true)
    validateForkPath(workspaceRoot, agentsDir, true)
    for (const agent of sourceAgents) {
      const role = extractPipelineRole(agent.filename, sourceCategory)
      if (!role) continue
      validateForkPath(workspaceRoot, path.join(agentsDir, `${resolvedTarget}-${role}.md`), false)
    }
    const targetPrefix = resolvedTarget.replace(/-pipeline$/, "")
    for (const rel of companionPaths) {
      const destRel = rel.startsWith("commands/pipeline-")
        ? `commands/${targetPrefix}-${rel.slice("commands/pipeline-".length)}`
        : rel
      validateForkPath(workspaceRoot, path.join(outputDir, ...destRel.split("/")), false)
    }
  }

  if (sourceCategory !== baseCategory) {
    refreshStampedPipelinesFromSource(workspaceRoot, sourceCategory)
    sourceAgents = loadStampedPipelineAgents(workspaceRoot, sourceCategory)?.agents ?? []
  }

  const result: ForkStampedPipelineResult = { createdCategories: [], copied: [], updated: [], outputDirs: [] }
  for (const resolvedTarget of resolvedTargets) {
    if (resolvedTarget === sourceCategory) {
      if (options.profileName) result.updated.push(...applyPipelineProfile(workspaceRoot, options.profileName, sourceCategory).updated)
      continue
    }
    if (resolvedTarget === baseCategory) throw new Error(`Refusing to fork into canonical base pipeline "${baseCategory}".`)

    const outputDir = path.join(workspaceRoot, resolveCategoriesSubdir(workspaceRoot), resolvedTarget)
    const agentsDir = path.join(outputDir, "agents")
    fs.mkdirSync(agentsDir, { recursive: true })
    for (const agent of sourceAgents) {
      const role = extractPipelineRole(agent.filename, sourceCategory)
      if (!role) continue
      const frontmatter: Record<string, any> = structuredClone(agent.frontmatter)
      if (options.profileName) {
        const profile = loadPipelineProfiles(workspaceRoot).profiles[options.profileName]
        if (!profile) throw new Error(`Unknown pipeline profile '${options.profileName}'`)
        const spec = resolveProfileRoleSpec(profile, role)
        if (spec) {
          frontmatter.model = spec.model
          if (typeof spec.variant === "string" && spec.variant.length > 0) frontmatter.variant = spec.variant
          else delete frontmatter.variant
        }
      }
      if (frontmatter.permission?.task && typeof frontmatter.permission.task === "object" && !Array.isArray(frontmatter.permission.task)) {
        frontmatter.permission = { ...frontmatter.permission, task: rewritePipelineTaskPermissions(frontmatter.permission.task, resolvedTarget, sourceCategory) }
      }
      const targetFilename = `${resolvedTarget}-${role}.md`
      const targetPath = path.join(agentsDir, targetFilename)
      const existing = fs.existsSync(targetPath) ? findAgentFiles(workspaceRoot, path.join(resolveCategoriesSubdir(workspaceRoot), resolvedTarget)).find(candidate => candidate.currentPath === targetPath) : undefined
      if (existing && !options.profileName) {
        const sourcePermission = frontmatter.permission && typeof frontmatter.permission === "object" && !Array.isArray(frontmatter.permission)
          ? frontmatter.permission as Record<string, any>
          : {}
        const existingPermission = existing.frontmatter.permission && typeof existing.frontmatter.permission === "object" && !Array.isArray(existing.frontmatter.permission)
          ? existing.frontmatter.permission as Record<string, any>
          : {}
        const targetOwnedFields = new Set(["model", "variant", "temperature", "steps", "max_steps", "mode", "hidden", "color"])
        for (const [key, value] of Object.entries(existing.frontmatter)) {
          if (key !== "permission" && (!Object.prototype.hasOwnProperty.call(agent.frontmatter, key) || targetOwnedFields.has(key))) frontmatter[key] = value
        }
        const normalizePermissionMap = (value: any): any => {
          if (Array.isArray(value)) return value.map(normalizePermissionMap)
          if (!value || typeof value !== "object") return value
          const normalized = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalizePermissionMap(child)]))
          if (!Object.prototype.hasOwnProperty.call(normalized, "*")) return normalized
          const { "*": wildcard, ...rest } = normalized
          return { "*": wildcard, ...rest }
        }
        const mergePermission = (source: any, target: any): any => {
          if (!source || typeof source !== "object" || Array.isArray(source) || !target || typeof target !== "object" || Array.isArray(target)) return normalizePermissionMap(structuredClone(target))
          const merged = structuredClone(source)
          for (const [key, value] of Object.entries(target)) {
            merged[key] = Object.prototype.hasOwnProperty.call(source, key)
              ? mergePermission(source[key], value)
              : normalizePermissionMap(structuredClone(value))
          }
          return normalizePermissionMap(merged)
        }
        const mergedPermission = mergePermission(sourcePermission, existingPermission)
        if (Object.keys(mergedPermission).length > 0) frontmatter.permission = mergedPermission
      }
      let body = rewritePipelineBody(agent.body, resolvedTarget, sourceCategory)
      const taskPermissions = frontmatter.permission?.task
      if (taskPermissions && typeof taskPermissions === "object" && !Array.isArray(taskPermissions)) {
        const delegatedRoles = Object.entries(taskPermissions)
          .filter(([name, permission]) => permission === "allow" && name !== "*")
          .map(([name]) => name)
        const missingReferences = delegatedRoles
          .map(name => `@${name}`)
          .filter(reference => !body.includes(reference))
        if (missingReferences.length > 0) body = `${body.trimEnd()}\n\n${missingReferences.join("\n")}`
      }
      saveAgentFile(targetPath, frontmatter, body, agent.frontmatterVersion)
      result.copied.push(`${agent.filename} -> ${targetFilename}`)
    }

    const targetPrefix = resolvedTarget.replace(/-pipeline$/, "")
    const companionPaths = discoverCompanionResourcePaths(sourceRoot, [baseCategory], undefined, baseAgents)
    if (fs.existsSync(path.join(sourceRoot, ".opencode", "pipeline.json"))) companionPaths.push(".opencode/pipeline.json")
    for (const rel of companionPaths) {
      const sourcePath = path.join(sourceRoot, ...rel.split("/"))
      if (rel.startsWith("commands/pipeline-")) {
        const destRel = `commands/${targetPrefix}-${rel.slice("commands/pipeline-".length)}`
        const destPath = path.join(outputDir, ...destRel.split("/"))
        const content = rewritePipelineCommandContent(fs.readFileSync(sourcePath, "utf8"), resolvedTarget, sourceCategory)
        fs.mkdirSync(path.dirname(destPath), { recursive: true })
        fs.writeFileSync(destPath, content, "utf8")
      } else {
        const destPath = path.join(outputDir, ...rel.split("/"))
        fs.mkdirSync(path.dirname(destPath), { recursive: true })
        fs.copyFileSync(sourcePath, destPath)
      }
    }
    copyCategoryCompanionLinks(workspaceRoot, baseCategory, resolvedTarget)
    result.createdCategories.push(resolvedTarget)
    result.outputDirs.push(outputDir)
  }
  return result
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
