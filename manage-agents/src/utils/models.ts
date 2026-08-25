import { execSync } from "node:child_process"

export type ModelCatalog =
  | { status: "verified"; models: string[] }
  | { status: "unavailable"; models: []; error?: string }

export type CommandRunner = (command: string) => string

const defaultRunner: CommandRunner = command => execSync(command, {
  encoding: "utf-8",
  stdio: ["ignore", "pipe", "ignore"]
})

/** Parse only complete, exact provider/model entries. Model names may contain slashes. */
export function parseModelCatalog(output: string): string[] {
  const models = output.split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => /^[^/\s]+\/[^\s]+$/.test(line))
  return Array.from(new Set(models))
}

export function loadModelCatalog(runnerOrRefresh: CommandRunner | boolean = defaultRunner, refresh = false): ModelCatalog {
  const runner = typeof runnerOrRefresh === "function" ? runnerOrRefresh : defaultRunner
  if (typeof runnerOrRefresh === "boolean") refresh = runnerOrRefresh
  try {
    const models = parseModelCatalog(runner(refresh ? "opencode models --refresh" : "opencode models"))
    return models.length > 0 ? { status: "verified", models } : { status: "unavailable", models: [], error: "No complete model entries returned" }
  } catch (error: any) {
    return { status: "unavailable", models: [], error: error?.message || String(error) }
  }
}

/** Compatibility wrapper; callers must inspect the catalog state when writes matter. */
export function fetchModels(runner: CommandRunner = defaultRunner, refresh = false): string[] {
  const catalog = loadModelCatalog(runner, refresh)
  return catalog.status === "verified" ? catalog.models : []
}

export function isVerifiedModel(model: unknown, catalog: ModelCatalog): model is string {
  return catalog.status === "verified" && typeof model === "string" && catalog.models.includes(model)
}

export function hasExplicitModel(agent: { frontmatter?: Record<string, any> }): boolean {
  return Object.prototype.hasOwnProperty.call(agent.frontmatter || {}, "model")
}

/** Model labels distinguish inherited configuration from explicit invalid values. */
export function modelDisplayValue(agent: { frontmatter?: Record<string, any> }, short = false, catalogOrInvalid?: ModelCatalog | boolean): string {
  if (!hasExplicitModel(agent)) return "Inherited"
  const value = agent.frontmatter?.model
  if (value === null) return "Invalid: null"
  if (value === false) return "Invalid: false"
  if (value === "") return "Invalid: empty"
  const isInvalidExplicit = typeof catalogOrInvalid === "boolean"
    ? catalogOrInvalid
    : typeof value !== "string" || (catalogOrInvalid?.status === "verified" ? !isVerifiedModel(value, catalogOrInvalid) : !value.includes("/"))
  const safeValue = String(value)
  if (isInvalidExplicit) return `Invalid: ${safeValue}`
  return short ? safeValue.split("/").pop() || safeValue : safeValue
}

export interface InvalidModelGroup<T = any> {
  value: T
  agents: any[]
}

/** Only explicit, own frontmatter values are repair candidates. Missing means inherited. */
export function collectInvalidModelGroups<T extends { frontmatter?: Record<string, any> }>(agents: T[], catalog: ModelCatalog): InvalidModelGroup[] {
  if (catalog.status !== "verified") return []
  const groups = new Map<string, InvalidModelGroup>()
  for (const agent of agents) {
    const frontmatter = agent.frontmatter || {}
    if (!hasExplicitModel({ frontmatter })) continue
    const value = frontmatter.model
    if (isVerifiedModel(value, catalog)) continue
    const key = `${typeof value}:${typeof value === "string" ? value : JSON.stringify(value)}`
    const group = groups.get(key) || { value, agents: [] }
    group.agents.push(agent)
    groups.set(key, group)
  }
  return Array.from(groups.values())
}

function modelParts(entry: string): [string, string] {
  const slash = entry.indexOf("/")
  return [entry.slice(0, slash), entry.slice(slash + 1)]
}

function similarity(a: string, b: string): number {
  const aa = new Set(a.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))
  const bb = new Set(b.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))
  return [...aa].filter(token => bb.has(token)).length / Math.max(aa.size, bb.size, 1)
}

/** Suggestions are always verbatim catalog entries; low confidence returns none. */
export function suggestModels(current: unknown, catalog: ModelCatalog, limit = 3): string[] {
  if (catalog.status !== "verified" || typeof current !== "string" || !current.includes("/")) return []
  const [provider, model] = modelParts(current)
  const ranked = catalog.models.map(entry => {
    const [candidateProvider, candidateModel] = modelParts(entry)
    const sameProvider = candidateProvider === provider ? 1 : 0
    const score = sameProvider * 2 + similarity(model, candidateModel)
    return { entry, score, sameProvider, lexical: entry, similarity: similarity(model, candidateModel) }
  }).sort((a, b) => b.score - a.score || b.sameProvider - a.sameProvider || a.lexical.localeCompare(b.lexical))
  return ranked
    .filter(item => item.entry !== current && item.similarity >= 0.4)
    .slice(0, limit)
    .map(item => item.entry)
}
