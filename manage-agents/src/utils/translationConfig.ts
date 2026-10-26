import fs from "node:fs"
import path from "node:path"
import type { AgentInfo } from "./agents.js"
import { isWorkspaceRelativePath, realpathThroughExistingAncestor } from "./pathValidation.js"

export type TranslationTarget = "claude" | "codex"

export interface ModelTarget {
  model: string
  reasoningEffort?: string
}

export interface TranslationTier {
  description?: string
  claude: ModelTarget
  codex: ModelTarget
}

export interface TranslationConfig {
  version: 2
  target: TranslationTarget
  pluginName: string
  prefix: string
  sourceDir: string
  inference?: boolean
  defaultTier: string
  tiers: Record<string, TranslationTier>
  roles: Record<string, string>
  claude: {
    overrides: Record<string, ModelTarget>
    modelMap?: Record<string, string>
    emitMarketplace?: boolean
    emitCommands?: boolean
    emitSkills?: boolean
    autoValidate?: boolean
    autoRegister?: boolean
    marketplaceName?: string
  }
  codex: {
    overrides: Record<string, ModelTarget>
    modelMap?: Record<string, string>
    emitSkills?: boolean
    emitReadme?: boolean
    emitMcp?: boolean
  }
}

const DEFAULT_TIERS: Record<string, TranslationTier> = {
  planning: {
    description: "Agents that reason, plan and review",
    claude: { model: "opus" },
    codex: { model: "gpt-5.6-sol", reasoningEffort: "high" },
  },
  execution: {
    description: "Agents that execute tasks, cheaper and faster",
    claude: { model: "sonnet" },
    codex: { model: "gpt-5.6-luna", reasoningEffort: "max" },
  },
  light: {
    description: "Agents that do lightweight work (claude haiku; codex parity with execution)",
    claude: { model: "haiku" },
    codex: { model: "gpt-5.6-luna", reasoningEffort: "max" },
  }
}
const DEFAULT_ROLES: Record<string, string> = {
  orchestrator: "planning", planner: "planning", reasoner: "planning", critic: "planning",
  code_reviewer: "planning", executor: "light", explorer: "light", refactorer: "execution",
  tester: "execution", fast_lane: "execution"
}

export const DEFAULT_TRANSLATION_CONFIG: TranslationConfig = {
  version: 2,
  target: "claude",
  pluginName: "decent-pipeline",
  prefix: "copilot-pipeline-",
  sourceDir: "general",
  inference: true,
  defaultTier: "execution",
  tiers: DEFAULT_TIERS,
  roles: DEFAULT_ROLES,
  claude: {
    overrides: {},
    modelMap: {},
    emitMarketplace: true,
    emitCommands: true,
    emitSkills: true,
    autoValidate: true,
    autoRegister: true
  },
  codex: { overrides: {}, modelMap: {}, emitSkills: true, emitReadme: true }
}

/** Default author name stamped into generated plugin manifests and READMEs. */
export const DEFAULT_AUTHOR_NAME = "Lorenzo Cancellara"

const AUTHOR_NAME_PATTERN = /^[\p{L}\p{N} '’.\-]{1,100}$/u

/** Resolve the author name for generated artifacts (AGENT_AUTHOR_NAME overrides the default). */
export function authorName(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.AGENT_AUTHOR_NAME?.trim()
  if (!override) return DEFAULT_AUTHOR_NAME
  if (!AUTHOR_NAME_PATTERN.test(override)) {
    console.error(`Ignoring invalid AGENT_AUTHOR_NAME override ${JSON.stringify(override.slice(0, 80))}; using default author name instead`)
    return DEFAULT_AUTHOR_NAME
  }
  return override
}

export function translationConfigPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".agent-manager", "translation-config.json")
}

function merge<T extends Record<string, any>>(base: T, override: Partial<T> | undefined): T {
  if (!override) return { ...base }
  const result: Record<string, any> = { ...base, ...override }
  for (const key of Object.keys(base)) {
    if (base[key] && typeof base[key] === "object" && !Array.isArray(base[key]) &&
        override[key] && typeof override[key] === "object" && !Array.isArray(override[key])) {
      result[key] = merge(base[key], override[key])
    }
  }
  return result as T
}

export function normalizeTranslationConfig(input: Partial<TranslationConfig> | undefined): TranslationConfig {
  const value = input || {}
  return {
    ...DEFAULT_TRANSLATION_CONFIG,
    ...value,
    tiers: merge(DEFAULT_TRANSLATION_CONFIG.tiers, value.tiers),
    roles: { ...DEFAULT_TRANSLATION_CONFIG.roles, ...(value.roles || {}) },
    claude: merge(DEFAULT_TRANSLATION_CONFIG.claude, value.claude),
    codex: merge(DEFAULT_TRANSLATION_CONFIG.codex, value.codex)
  }
}

export function normalizeAgentName(filename: string, prefix: string): string {
  let name = path.basename(filename)
  if (name.toLowerCase().endsWith(".md")) name = name.slice(0, -3)
  if (prefix && name.startsWith(prefix)) name = name.slice(prefix.length)
  return name.toLowerCase()
}

export function resolveRole(agent: AgentInfo, config: TranslationConfig): string {
  return normalizeAgentName(agent.filename, config.prefix)
}

export interface InferenceIndex {
  byFull: Map<string, Set<string>>
  byBare: Map<string, Set<string>>
}

/** Source models match on the trimmed, lowercased id and on the bare id after the last slash. */
function normalizeSourceModel(model: string): { full: string; bare: string } {
  const full = String(model).trim().toLowerCase()
  return { full, bare: full.slice(full.lastIndexOf("/") + 1) }
}

export function buildInferenceIndex(agents: AgentInfo[], config: TranslationConfig): InferenceIndex {
  const index: InferenceIndex = { byFull: new Map(), byBare: new Map() }
  for (const candidate of agents) {
    const role = resolveRole(candidate, config)
    const tier = Object.prototype.hasOwnProperty.call(config.roles, role) ? config.roles[role] : undefined
    const model = candidate.frontmatter?.model || candidate.model
    if (!tier || !Object.prototype.hasOwnProperty.call(config.tiers, tier) || !model) continue
    const { full, bare } = normalizeSourceModel(model)
    for (const [map, key] of [[index.byFull, full], [index.byBare, bare]] as const) {
      const tiers = map.get(key) || new Set<string>()
      tiers.add(tier)
      map.set(key, tiers)
    }
  }
  return index
}

export function resolveModelTarget(
  agent: AgentInfo,
  index: InferenceIndex,
  config: TranslationConfig,
  target: TranslationTarget
): { role: string; tier: string; model: ModelTarget; source: "override" | "model-map" | "role" | "inferred" | "default"; inferredFrom?: string } {
  const name = normalizeAgentName(agent.filename, config.prefix)
  const role = resolveRole(agent, config)
  const overrides = config[target].overrides
  const override = Object.prototype.hasOwnProperty.call(overrides, name) ? overrides[name] : undefined
  const fallback = Object.prototype.hasOwnProperty.call(config.tiers, config.defaultTier)
    ? config.defaultTier
    : Object.keys(config.tiers)[0]
  const roleTier = Object.prototype.hasOwnProperty.call(config.roles, role) ? config.roles[role] : undefined
  if (override) return { role, tier: roleTier || fallback, model: override, source: "override" }
  const sourceModel = agent.frontmatter?.model || agent.model
  if (sourceModel) {
    const { full, bare } = normalizeSourceModel(sourceModel)
    const modelMap = config[target].modelMap
    const mapped = modelMap && Object.prototype.hasOwnProperty.call(modelMap, full) ? modelMap[full]
      : modelMap && Object.prototype.hasOwnProperty.call(modelMap, bare) ? modelMap[bare]
        : modelMap && Object.prototype.hasOwnProperty.call(modelMap, "*") ? modelMap["*"]
          : undefined
    if (mapped !== undefined) return { role, tier: roleTier || fallback, model: { model: mapped }, source: "model-map" }
  }
  let tier = roleTier
  let source: "role" | "inferred" | "default" = tier && Object.prototype.hasOwnProperty.call(config.tiers, tier) ? "role" : "default"
  let inferredFrom: string | undefined
  if (!tier && config.inference !== false && sourceModel) {
    const { full, bare } = normalizeSourceModel(sourceModel)
    for (const [map, key] of [[index.byFull, full], [index.byBare, bare]] as const) {
      const matches = map.get(key)
      if (matches?.size === 1) { tier = [...matches][0]; source = "inferred"; inferredFrom = String(sourceModel); break }
       // A per-map ambiguity abstains rather than falling through to another
       // key. This is structurally unobservable: identical full-model matches
       // always contribute the same bare-model matches as well.
       if (matches && matches.size > 1) break
    }
  }
  tier ||= fallback
  const tierConfig = Object.prototype.hasOwnProperty.call(config.tiers, tier) ? config.tiers[tier] : undefined
  const model = tierConfig?.[target] || { model: "" }
  return { role, tier, model, source, ...(inferredFrom ? { inferredFrom } : {}) }
}

/** Model-map keys that no agent's source model (full or provider-bare form) would ever hit. */
export function unusedModelMapKeys(agents: AgentInfo[], config: TranslationConfig, target: TranslationTarget): string[] {
  const modelMap = config[target].modelMap
  if (!modelMap) return []
  const used = new Set<string>()
  for (const candidate of agents) {
    const model = candidate.frontmatter?.model || candidate.model
    if (!model) continue
    const { full, bare } = normalizeSourceModel(model)
    used.add(full)
    used.add(bare)
  }
  return Object.keys(modelMap).filter(key => key !== "*" && !used.has(key))
}

const CLAUDE_MODEL_PATTERN = /^(fable|sonnet|opus|haiku|inherit)$|^claude-[a-z0-9][a-z0-9.-]*$/

export function validateClaudeModelName(value: string): void {
  if (!CLAUDE_MODEL_PATTERN.test(value)) {
    throw new Error(`Invalid Claude model "${value}". Use an alias (fable, sonnet, opus, haiku, inherit) or a full claude-* model ID.`)
  }
}

const MARKETPLACE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/
const RESERVED_MARKETPLACE_PREFIXES = ["claude-", "anthropic-", "anthropics-"]
const RESERVED_MARKETPLACE_NAMES = ["claude", "claude-code"]

export function validateMarketplaceName(name: string): void {
  if (!MARKETPLACE_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid marketplace name "${name}". Use letters, digits, dots, underscores and hyphens, starting with a letter or digit.`)
  }
  const lower = name.toLowerCase()
  if (RESERVED_MARKETPLACE_NAMES.includes(lower) || RESERVED_MARKETPLACE_PREFIXES.some(prefix => lower.startsWith(prefix))) {
    throw new Error(`Invalid marketplace name "${name}". Names equal to "claude" or "claude-code" and names starting with "claude-", "anthropic-" or "anthropics-" are reserved.`)
  }
}

/** Configured marketplace name, or a local one scoped to the plugin. */
export function resolveMarketplaceName(pluginName: string, configured?: string): string {
  return configured && configured.trim() ? configured : `${pluginName}-local`
}

export function validateTranslationConfig(config: TranslationConfig): void {
  if (Object.keys(config.tiers).length === 0) throw new Error("Translation config tiers must not be empty")
  for (const [role, tier] of Object.entries(config.roles)) if (!Object.prototype.hasOwnProperty.call(config.tiers, tier)) throw new Error(`Translation role "${role}" points to missing tier "${tier}"`)
  if (!Object.prototype.hasOwnProperty.call(config.tiers, config.defaultTier)) throw new Error(`Translation config defaultTier "${config.defaultTier}" does not exist in tiers`)
  for (const [name, tier] of Object.entries(config.tiers)) {
    if (!tier.claude?.model) throw new Error(`Translation tier "${name}" is missing claude.model`)
    if (!tier.codex?.model) throw new Error(`Translation tier "${name}" is missing codex.model`)
  }
  for (const [source, value] of Object.entries(config.claude.modelMap || {})) {
    try {
      validateClaudeModelName(value)
    } catch (error) {
      throw new Error(`claude.modelMap["${source}"]: ${(error as Error).message}`)
    }
  }
  for (const [source, value] of Object.entries(config.codex.modelMap || {})) {
    if (typeof value !== "string" || !value.trim()) throw new Error(`Translation codex.modelMap["${source}"] must be a non-empty model name`)
  }
  if (config.claude.marketplaceName !== undefined) validateMarketplaceName(config.claude.marketplaceName)
  for (const key of ["emitMarketplace", "emitCommands", "emitSkills", "autoValidate", "autoRegister"] as const) {
    const value = config.claude[key]
    if (value !== undefined && typeof value !== "boolean") throw new Error(`Translation claude.${key} must be a boolean`)
  }
  if (!isWorkspaceRelativePath(config.sourceDir)) {
    throw new Error(`Translation config sourceDir must stay inside workspace: ${config.sourceDir}`)
  }
}

function warnMigration(message: string): void {
  console.error(`Translation config migration: ${message}`)
}

export function migrateV1(raw: Record<string, any>): TranslationConfig {
  const claude = raw.claude || {}
  const codex = raw.codex || {}
  const mapping = codex.modelMapping || {}
  const planningCodex = mapping.primary || mapping.opus
  if (mapping.primary && mapping.opus && JSON.stringify(mapping.primary) !== JSON.stringify(mapping.opus)) {
    warnMigration("codex.modelMapping.opus differs from primary; primary wins")
  }
  for (const key of Object.keys(claude.modelMap || {})) {
    warnMigration(`discarded claude.modelMap key "${key}"; use overrides instead${key.includes("*") ? " (v1 keys are wildcard patterns; v2 modelMap uses exact source-model ids plus the \"*\" catch-all)" : ""}`)
  }
  for (const key of Object.keys(mapping.exact || {})) {
    warnMigration(`discarded codex.modelMapping.exact key "${key}"; use overrides instead${key.includes("*") ? " (v1 keys are wildcard patterns; v2 modelMap uses exact source-model ids plus the \"*\" catch-all)" : ""}`)
  }
  const migrated: any = {
    version: 2,
    target: raw.target,
    pluginName: raw.pluginName,
    prefix: raw.prefix,
    sourceDir: raw.sourceDir || "general",
    defaultTier: "execution",
    tiers: merge(DEFAULT_TIERS, {
      planning: {
        claude: { model: claude.primaryModel },
        codex: planningCodex
      },
      execution: {
        claude: { model: claude.defaultSubagentModel }
        , codex: mapping.default
      }
    }),
    claude: { overrides: {} },
    codex: {
      overrides: {},
      emitSkills: codex.emitSkills,
      emitReadme: codex.emitReadme,
      emitMcp: codex.emitMcp
    }
  }
  return normalizeTranslationConfig(migrated)
}

function rejectSymlink(filePath: string): void {
  try {
    if (fs.lstatSync(filePath).isSymbolicLink()) throw new Error(`Translation config path must not be a symlink: ${filePath}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}

function assertRealpathInsideWorkspace(workspaceRoot: string, configPath: string, originalPath: string): void {
  const relative = path.relative(realpathThroughExistingAncestor(workspaceRoot), realpathThroughExistingAncestor(configPath))
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Translation config must stay inside workspace: ${originalPath}`)
  }
}

export function loadTranslationConfig(
  workspaceRoot: string,
  configPath?: string,
  options: { persistMigration?: boolean } = { persistMigration: true }
): TranslationConfig {
  const filePath = configPath || translationConfigPath(workspaceRoot)
  rejectSymlink(filePath)
  if (!fs.existsSync(filePath)) {
    const config = normalizeTranslationConfig(undefined)
    validateTranslationConfig(config)
    return config
  }
  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, any>
  const migrated = raw.version === undefined || raw.version === 1
  if (migrated) {
    const config = migrateV1(raw)
    validateTranslationConfig(config)
    if (options.persistMigration) saveTranslationConfig(workspaceRoot, config, configPath)
    return config
  }
  if (raw.version !== 2) throw new Error(`unsupported config version: ${raw.version}`)
  const config = normalizeTranslationConfig(raw)
  validateTranslationConfig(config)
  return config
}

export function saveTranslationConfig(workspaceRoot: string, config: Partial<TranslationConfig>, configPath?: string): string {
  const filePath = configPath || translationConfigPath(workspaceRoot)
  const normalized = normalizeTranslationConfig(config)
  validateTranslationConfig(normalized)
  const parent = path.dirname(filePath)
  const resolvedRoot = path.resolve(workspaceRoot)
  const resolvedPath = path.resolve(filePath)
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Translation config must stay inside workspace: ${filePath}`)
  }
  rejectSymlink(filePath)
  assertRealpathInsideWorkspace(resolvedRoot, resolvedPath, filePath)
  fs.mkdirSync(parent, { recursive: true })
  // Re-check now that the parent exists, mirroring the plugin writer's
  // post-creation gate against links planted while we were creating it.
  rejectSymlink(filePath)
  assertRealpathInsideWorkspace(resolvedRoot, resolvedPath, filePath)
  fs.writeFileSync(filePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf-8")
  return filePath
}

export function parseKeyValueMappings(input: string): Record<string, string> {
  const mappings: Record<string, string> = {}
  for (const item of input.split(",").map(value => value.trim()).filter(Boolean)) {
    const separator = item.indexOf("=")
    if (separator <= 0 || separator === item.length - 1) throw new Error(`Invalid mapping '${item}'. Use source-model=target-model.`)
    mappings[item.slice(0, separator).trim()] = item.slice(separator + 1).trim()
  }
  return mappings
}

export function parseCodexExactMappings(input: string): Record<string, { model: string; reasoningEffort: string }> {
  const mappings: Record<string, { model: string; reasoningEffort: string }> = {}
  for (const item of input.split(",").map(value => value.trim()).filter(Boolean)) {
    const separator = item.indexOf("=")
    if (separator <= 0 || separator === item.length - 1) throw new Error(`Invalid Codex mapping '${item}'. Use source-model=target-model[:effort].`)
    const parts = item.slice(separator + 1).trim().split(":")
    mappings[item.slice(0, separator).trim()] = { model: parts[0], reasoningEffort: parts[1] || "max" }
  }
  return mappings
}
