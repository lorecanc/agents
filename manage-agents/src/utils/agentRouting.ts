import fs from "node:fs"
import path from "node:path"
import { parseAgentFile, resolveCategoriesSubdir, resolveSourceSubdir } from "./agents.js"
import { buildCategoryDistribution } from "./categoryDistribution.js"
import { isModelRef, isTrigger } from "./values.js"

// Model configurations for archetypes (see ARCHETIPI.md and src/plugins/agent-router).
//
// An archetype (flow, pipeline) is one set of canonical agents in src/agents/<id>-*.md with a
// reference agent (flow-build, pipeline-orchestrator) and possibly other primaries (flow-plan, its plan
// mode). The primaries
// are the callers: a configuration says, when the calling primary runs on <trigger> (a provider
// "mistral" or an exact model "mistral/zai-glm-5-3"; the exact model wins), each related subagent
// runs on this model, or inherits the caller's one. Build and plan may run on different models; the
// plugin always looks at the one that is calling.
//
// Authored:  .agent-manager/agent-routing.json, written by the TUI (M on the archetype folder) or
//            `manage-agents routing set`. Plain storage: it can be edited, but the TUI owns it.
// Generated: <source>/plugins/agent-router/routing.json, read by the plugin at runtime. Never edited
//            by hand; `routing build` rewrites it and `category check` reports drift.
// Bridges (Claude Code, Codex) have no plugin and ignore the configurations: they translate models to
// Claude or Codex aliases through .agent-manager/translation-config.json.
//
// Pinned agents are not configured here: a canonical subagent with a `model` in its frontmatter (set
// with M on the agent) keeps it, and the configurations skip it. A primary's own model in frontmatter
// is just its starting model in OpenCode.

export const AGENT_ROUTING_VERSION = 2
const ROUTING_OUTPUT_VERSION = 1
export const INHERIT = "inherit"
const AUTHORED_COMMENT = "Model configurations per archetype, owned by manage-agents (TUI: M on the archetype folder; CLI: `manage-agents routing`). configs.<trigger>: trigger = the provider (\"mistral\") or exact model (\"mistral/zai-glm-5-3\") the calling primary (build or plan) runs on, the exact model wins; value = { <role>: \"provider/model#variant\" | \"inherit\" }, a missing role inherits. See ARCHETIPI.md."

/** role -> "provider/model#variant" | "inherit" */
export type RoleModels = Record<string, string>
export interface AgentRoutingConfig {
  version: 2
  $comment?: string
  archetypes: Record<string, { configs: Record<string, RoleModels> }>
}
export interface ResolvedRoute { roles: RoleModels }
export interface ResolvedArchetype { roles: string[]; pinned: string[]; routes: Record<string, ResolvedRoute> }
export interface ResolvedRouting { version: 1; $comment: string; archetypes: Record<string, ResolvedArchetype> }

export interface ArchetypeAgent { role: string; name: string; subagent: boolean; model?: string }
export interface ArchetypeView {
  id: string
  reference: ArchetypeAgent
  /** Primaries whose model picks the configuration: the reference first, then the others (plan). */
  callers: ArchetypeAgent[]
  /** Subagents a configuration can set: canonical subagents without a fixed model. */
  related: ArchetypeAgent[]
  /** Canonical subagents with a fixed model: configurations skip them. */
  pinned: ArchetypeAgent[]
  configs: Record<string, RoleModels>
}

// One entry per archetype whose canonical agents are installed as-is (see ARCHETIPI.md).
const ARCHETYPES: Record<string, { reference: string }> = {
  flow: { reference: "build" },
  pipeline: { reference: "orchestrator" },
}

export const ROUTABLE_ARCHETYPES = Object.keys(ARCHETYPES)

/** Archetypes distributed through a category manifest: each bundle ships the shared routing.json. */
export function archetypeBundles(workspaceRoot: string): Array<{ id: string; output: string }> {
  return ROUTABLE_ARCHETYPES
    .filter(id => fs.existsSync(path.join(workspaceRoot, ".agent-manager", "categories", `${id}.json`)))
    .map(id => ({ id, output: path.join(workspaceRoot, resolveCategoriesSubdir(workspaceRoot), id) }))
}

/** routing.json holds every archetype, so a configuration change rebuilds every archetype bundle. */
export function rebuildArchetypeBundles(workspaceRoot: string): void {
  for (const { id } of archetypeBundles(workspaceRoot)) buildCategoryDistribution(workspaceRoot, id)
}

export function isRoutableArchetype(id: string | undefined | null): id is string {
  return typeof id === "string" && Object.prototype.hasOwnProperty.call(ARCHETYPES, id)
}


export function agentRoutingConfigPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".agent-manager", "agent-routing.json")
}

export function agentRoutingOutputPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, resolveSourceSubdir(workspaceRoot), "plugins", "agent-router", "routing.json")
}

export function loadAgentRoutingConfig(workspaceRoot: string): AgentRoutingConfig | null {
  const file = agentRoutingConfigPath(workspaceRoot)
  if (!fs.existsSync(file)) return null
  const config = JSON.parse(fs.readFileSync(file, "utf8")) as AgentRoutingConfig
  if (!config || config.version !== AGENT_ROUTING_VERSION || typeof config.archetypes !== "object" || config.archetypes === null) {
    throw new Error(`${file}: expected { "version": ${AGENT_ROUTING_VERSION}, "archetypes": { "<id>": { "configs": { ... } } } }`)
  }
  return config
}

export function saveAgentRoutingConfig(workspaceRoot: string, config: AgentRoutingConfig): string {
  const file = agentRoutingConfigPath(workspaceRoot)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify({ version: config.version, $comment: AUTHORED_COMMENT, archetypes: config.archetypes }, null, 2)}\n`, "utf8")
  return file
}

const sortedObject = <T>(entries: Array<[string, T]>): Record<string, T> =>
  Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)))

/** Canonical agents of an archetype: src/agents/<id>-<role>.md, in file-name order. */
function archetypeAgents(workspaceRoot: string, id: string): ArchetypeAgent[] {
  const agentsDir = path.join(workspaceRoot, resolveSourceSubdir(workspaceRoot), "agents")
  if (!fs.existsSync(agentsDir)) return []
  return fs.readdirSync(agentsDir).filter(file => file.startsWith(`${id}-`) && file.endsWith(".md")).sort().flatMap(file => {
    const agent = parseAgentFile(path.join(agentsDir, file), workspaceRoot)
    if (!agent) return []
    const name = file.slice(0, -3)
    const model = typeof agent.frontmatter.model === "string" && agent.frontmatter.model ? agent.frontmatter.model : undefined
    return [{ role: name.slice(id.length + 1), name, subagent: agent.frontmatter.mode !== "primary", ...(model ? { model } : {}) }]
  })
}

/** Everything the TUI shows for an archetype; null when it is not routable or has no reference agent. */
export function describeArchetype(workspaceRoot: string, id: string, config = loadAgentRoutingConfig(workspaceRoot)): ArchetypeView | null {
  if (!isRoutableArchetype(id)) return null
  const agents = archetypeAgents(workspaceRoot, id)
  const reference = agents.find(agent => agent.role === ARCHETYPES[id].reference)
  if (!reference) return null
  const subagents = agents.filter(agent => agent.subagent)
  return {
    id,
    reference,
    callers: [reference, ...agents.filter(agent => !agent.subagent && agent !== reference)],
    related: subagents.filter(agent => !agent.model),
    pinned: subagents.filter(agent => agent.model),
    configs: config?.archetypes[id]?.configs ?? {},
  }
}

/** "flow-build or flow-plan": the primaries a configuration's trigger refers to. */
export function callersLabel(view: ArchetypeView): string {
  const names = view.callers.map(agent => agent.name)
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}` : names[0]
}

/** Problems with one configuration; `view` decides which roles exist and which are pinned. */
function configProblems(view: ArchetypeView, trigger: string, roles: RoleModels): { errors: string[]; warnings: string[] } {
  const where = `${view.id}.configs["${trigger}"]`
  const errors: string[] = [], warnings: string[] = []
  if (!isTrigger(trigger)) errors.push(`${where}: the trigger must be "provider" or "provider/model"`)
  if (!roles || typeof roles !== "object" || Array.isArray(roles)) return { errors: [...errors, `${where}: expected { <role>: model | "inherit" }`], warnings }
  for (const [role, model] of Object.entries(roles)) {
    if (model !== INHERIT && !isModelRef(model)) errors.push(`${where}.${role}: '${model}' is not "inherit" or provider/model[#variant]`)
    else if (view.pinned.some(agent => agent.role === role)) warnings.push(`${where}.${role}: ignored, ${view.id}-${role} has a fixed model`)
    else if (!view.related.some(agent => agent.role === role)) warnings.push(`${where}.${role}: ignored, ${view.id} has no subagent '${role}'`)
  }
  return { errors, warnings }
}

/**
 * Resolve the authored configurations into the file the plugin reads. Errors make them unusable
 * (unknown archetype, malformed trigger or model); warnings point at entries that do nothing.
 */
export function resolveAgentRouting(workspaceRoot: string, config = loadAgentRoutingConfig(workspaceRoot)): { routing: ResolvedRouting | null; errors: string[]; warnings: string[] } {
  if (!config) return { routing: null, errors: [], warnings: [] }
  const errors: string[] = [], warnings: string[] = []
  const archetypes: Record<string, ResolvedArchetype> = {}
  for (const id of Object.keys(config.archetypes).sort()) {
    if (!isRoutableArchetype(id)) { errors.push(`${id}: not a routable archetype (supported: ${ROUTABLE_ARCHETYPES.join(", ")})`); continue }
    const view = describeArchetype(workspaceRoot, id, config)
    if (!view) { errors.push(`${id}: canonical reference agent ${id}-${ARCHETYPES[id].reference} not found`); continue }
    if (view.related.length === 0 && view.pinned.length > 0) warnings.push(`${id}: every subagent has a fixed model, so configurations change nothing`)
    const routes: Array<[string, ResolvedRoute]> = []
    for (const [trigger, roles] of Object.entries(view.configs)) {
      const problems = configProblems(view, trigger, roles)
      errors.push(...problems.errors)
      warnings.push(...problems.warnings)
      if (problems.errors.length) continue
      routes.push([trigger, { roles: sortedObject(Object.entries(roles).filter(([role]) => view.related.some(agent => agent.role === role))) }])
    }
    const agents = archetypeAgents(workspaceRoot, id)
    archetypes[id] = { roles: agents.map(agent => agent.role), pinned: view.pinned.map(agent => agent.role), routes: sortedObject(routes) }
  }
  const routing: ResolvedRouting = {
    version: ROUTING_OUTPUT_VERSION,
    $comment: "Generated by manage-agents from .agent-manager/agent-routing.json. Do not edit: change the configurations in the TUI (M on the archetype folder) or with `manage-agents routing`.",
    archetypes,
  }
  return { routing: errors.length ? null : routing, errors, warnings }
}

export function renderAgentRouting(routing: ResolvedRouting): string {
  return `${JSON.stringify(routing, null, 2)}\n`
}

/**
 * Write routing.json when configurations exist and resolve. Without them nothing is written and an
 * existing routing.json is left alone (the plugin then routes nothing it does not find).
 */
export function buildAgentRouting(workspaceRoot: string, options: { dryRun?: boolean } = {}): { path: string; changed: boolean; configured: boolean; warnings: string[] } {
  const output = agentRoutingOutputPath(workspaceRoot)
  const { routing, errors, warnings } = resolveAgentRouting(workspaceRoot)
  if (errors.length) throw new Error(`Agent routing is invalid:\n${errors.map(error => `  - ${error}`).join("\n")}`)
  if (!routing) return { path: output, changed: false, configured: false, warnings }
  const rendered = renderAgentRouting(routing)
  const current = fs.existsSync(output) ? fs.readFileSync(output, "utf8") : null
  const changed = current !== rendered
  if (changed && !options.dryRun) {
    fs.mkdirSync(path.dirname(output), { recursive: true })
    fs.writeFileSync(output, rendered, "utf8")
  }
  return { path: output, changed, configured: true, warnings }
}

/** Problems that should fail `category check`: invalid configurations or a stale routing.json. */
export function checkAgentRouting(workspaceRoot: string): { problems: string[]; warnings: string[] } {
  try {
    const result = buildAgentRouting(workspaceRoot, { dryRun: true })
    const relative = path.relative(workspaceRoot, result.path).split(path.sep).join("/")
    return { problems: result.changed ? [`${relative} is out of date; run \`routing build\` or \`category build --all\``] : [], warnings: result.warnings }
  } catch (error: any) {
    return { problems: [error?.message || String(error)], warnings: [] }
  }
}

/**
 * Add, replace (`roles`) or remove (`null`) one configuration, then rebuild routing.json.
 * `previousTrigger` renames a configuration whose trigger was changed in the editor.
 */
export function setArchetypeConfig(workspaceRoot: string, id: string, trigger: string, roles: RoleModels | null, options: { previousTrigger?: string } = {}): AgentRoutingConfig {
  if (!isRoutableArchetype(id)) throw new Error(`'${id}' is not a routable archetype (supported: ${ROUTABLE_ARCHETYPES.join(", ")})`)
  const config = loadAgentRoutingConfig(workspaceRoot) ?? { version: AGENT_ROUTING_VERSION, archetypes: {} }
  const configs = { ...(config.archetypes[id]?.configs ?? {}) }
  if (roles === null) {
    if (!(trigger in configs)) throw new Error(`No configuration '${trigger}' in ${id}`)
    delete configs[trigger]
  } else {
    if (options.previousTrigger && options.previousTrigger !== trigger) {
      if (trigger in configs) throw new Error(`${id} already has a configuration for '${trigger}'`)
      delete configs[options.previousTrigger]
    }
    configs[trigger] = sortedObject(Object.entries(roles))
  }
  const next: AgentRoutingConfig = { version: AGENT_ROUTING_VERSION, archetypes: { ...config.archetypes, [id]: { configs: sortedObject(Object.entries(configs)) } } }
  const { errors } = resolveAgentRouting(workspaceRoot, next)
  if (errors.length) throw new Error(`Configuration rejected:\n${errors.map(error => `  - ${error}`).join("\n")}`)
  saveAgentRoutingConfig(workspaceRoot, next)
  buildAgentRouting(workspaceRoot)
  return next
}

/**
 * Model each agent gets when one configuration is stamped (bridges have no runtime plugin).
 * `referenceModel` is the exact model the reference runs on; `trigger` picks the configuration
 * (defaults to the one routeFor would choose for `referenceModel`). Pinned agents keep their model.
 */
export function stampedModels(workspaceRoot: string, id: string, referenceModel: string, trigger?: string): Record<string, string> {
  const view = describeArchetype(workspaceRoot, id)
  if (!view) throw new Error(`'${id}' is not a routable archetype with a reference agent`)
  if (!isModelRef(referenceModel)) throw new Error(`'${referenceModel}' is not provider/model[#variant]`)
  const base = referenceModel.split("#")[0]
  const key = trigger ?? (base in view.configs ? base : base.split("/")[0])
  const roles = view.configs[key]
  if (!roles) throw new Error(`${id} has no configuration for '${trigger ?? referenceModel}' (have: ${Object.keys(view.configs).join(", ") || "none"})`)
  const models: Record<string, string> = {}
  for (const agent of archetypeAgents(workspaceRoot, id)) {
    if (agent.model && agent.subagent) models[agent.name] = agent.model
    else if (!agent.subagent) models[agent.name] = referenceModel
    else models[agent.name] = roles[agent.role] && roles[agent.role] !== INHERIT ? roles[agent.role] : referenceModel
  }
  return models
}

/** Human-readable summary: per archetype, the reference, pinned agents and every configuration. */
export function describeAgentRouting(workspaceRoot: string): string[] {
  const { errors, warnings } = resolveAgentRouting(workspaceRoot)
  if (errors.length) return ["Agent routing is invalid:", ...errors.map(error => `  - ${error}`)]
  const lines: string[] = []
  for (const id of ROUTABLE_ARCHETYPES) {
    const view = describeArchetype(workspaceRoot, id)
    if (!view) continue
    lines.push(`${id}: reference ${view.reference.name}${view.reference.model ? ` (starts on ${view.reference.model})` : ""}; callers ${callersLabel(view)}`)
    lines.push(`  pinned: ${view.pinned.length ? view.pinned.map(agent => `${agent.name} = ${agent.model}`).join(", ") : "none"}`)
    const configs = Object.entries(view.configs)
    if (configs.length === 0) lines.push("  configurations: none (every subagent inherits the caller's model)")
    for (const [trigger, roles] of configs) {
      lines.push(`  ${callersLabel(view)} on ${trigger}:`)
      for (const agent of view.related) lines.push(`    ${agent.name}: ${roles[agent.role] ?? INHERIT}`)
    }
    lines.push("  any other model: every subagent inherits the caller's model")
  }
  return [...lines, ...warnings.map(warning => `warning: ${warning}`)]
}
