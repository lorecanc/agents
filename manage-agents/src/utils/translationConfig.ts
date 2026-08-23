import fs from "node:fs"
import path from "node:path"
import type { AgentInfo } from "./agents.js"
import { isWorkspaceRelativePath } from "./pathValidation.js"

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
  claude: { overrides: Record<string, ModelTarget> }
  codex: {
    overrides: Record<string, ModelTarget>
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
  }
}
const DEFAULT_ROLES: Record<string, string> = {
  orchestrator: "planning", planner: "planning", reasoner: "planning", critic: "planning",
  code_reviewer: "planning", executor: "execution", explorer: "execution", refactorer: "execution",
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
  claude: { overrides: {} },
  codex: { overrides: {}, emitSkills: true, emitReadme: true }
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

export function buildInferenceIndex(agents: AgentInfo[], config: TranslationConfig): InferenceIndex {
  const index: InferenceIndex = { byFull: new Map(), byBare: new Map() }
  for (const candidate of agents) {
    const tier = config.roles[resolveRole(candidate, config)]
    const model = candidate.frontmatter?.model || candidate.model
    if (!tier || !config.tiers[tier] || !model) continue
    const full = String(model).trim().toLowerCase()
    const bare = full.slice(full.lastIndexOf("/") + 1)
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
): { role: string; tier: string; model: ModelTarget; source: "override" | "role" | "inferred" | "default"; inferredFrom?: string } {
  const name = normalizeAgentName(agent.filename, config.prefix)
  const role = resolveRole(agent, config)
  const override = config[target].overrides[name]
  const fallback = config.tiers[config.defaultTier] ? config.defaultTier : Object.keys(config.tiers)[0]
  if (override) return { role, tier: config.roles[role] || fallback, model: override, source: "override" }
  let tier = config.roles[role]
  let source: "role" | "inferred" | "default" = tier && config.tiers[tier] ? "role" : "default"
  let inferredFrom: string | undefined
  if (!tier && config.inference !== false) {
    const model = agent.frontmatter?.model || agent.model
    if (model) for (const [map, key] of [[index.byFull, String(model).trim().toLowerCase()], [index.byBare, String(model).trim().toLowerCase().split("/").pop()!]] as const) {
      const matches = map.get(key)
      if (matches?.size === 1) { tier = [...matches][0]; source = "inferred"; inferredFrom = String(model); break }
       // A per-map ambiguity abstains rather than falling through to another
       // key. This is structurally unobservable: identical full-model matches
       // always contribute the same bare-model matches as well.
       if (matches && matches.size > 1) break
    }
  }
  tier ||= fallback
  const model = config.tiers[tier]?.[target] || { model: "" }
  return { role, tier, model, source, ...(inferredFrom ? { inferredFrom } : {}) }
}

export function validateTranslationConfig(config: TranslationConfig): void {
  if (Object.keys(config.tiers).length === 0) throw new Error("Translation config tiers must not be empty")
  for (const [role, tier] of Object.entries(config.roles)) if (!config.tiers[tier]) throw new Error(`Translation role "${role}" points to missing tier "${tier}"`)
  if (!config.tiers[config.defaultTier]) throw new Error(`Translation config defaultTier "${config.defaultTier}" does not exist in tiers`)
  for (const [name, tier] of Object.entries(config.tiers)) {
    if (!tier.claude?.model) throw new Error(`Translation tier "${name}" is missing claude.model`)
    if (!tier.codex?.model) throw new Error(`Translation tier "${name}" is missing codex.model`)
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
    warnMigration(`discarded claude.modelMap key "${key}"; use overrides instead${key.includes("*") ? " (wildcards are not supported in v2)" : ""}`)
  }
  for (const key of Object.keys(mapping.exact || {})) {
    warnMigration(`discarded codex.modelMapping.exact key "${key}"; use overrides instead${key.includes("*") ? " (wildcards are not supported in v2)" : ""}`)
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

export function loadTranslationConfig(
  workspaceRoot: string,
  configPath?: string,
  options: { persistMigration?: boolean } = { persistMigration: true }
): TranslationConfig {
  const filePath = configPath || translationConfigPath(workspaceRoot)
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
  fs.mkdirSync(parent, { recursive: true })
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
