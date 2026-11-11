import fs from "node:fs"
import path from "node:path"
import YAML from "yaml"
import { isModelRef, isTrigger, own, ownChild, setOwn } from "./values.js"
import { atomicWriteRestrictedFile, extractFrontmatter } from "./agents.js"
import { PACK_NAME_RE, type PackManifest } from "./packs.js"
import { engineConfigDir } from "./sources.js"

// User settings applied at reconcile, never written into packs:
//   routing.json    archetype -> trigger -> subagent ID -> "provider/model#variant" | "inherit"
//   overrides.json  pack -> agents|commands -> ID -> frontmatter field -> value (null removes the field)
// Both have a "default" scope and per-target scopes ("targets.<absolute target path>"); the target scope wins.

export const INHERIT = "inherit"
export type Routes = Record<string, Record<string, string>>
export type FieldPatch = Record<string, unknown>
export interface PackOverrides { agents?: Record<string, FieldPatch>; commands?: Record<string, FieldPatch> }

interface Scoped<T> { version: 1; default: Record<string, T>; targets: Record<string, Record<string, T>> }
export type RoutingSettings = Scoped<Routes>
export type OverrideSettings = Scoped<PackOverrides>

export const AGENT_FIELDS = new Set(["description", "mode", "model", "permissions", "hidden", "color", "steps", "disabled", "request", "temperature", "top_p"])
export const COMMAND_FIELDS = new Set(["description", "agent", "model", "subagent"])
const isObject = (value: unknown): value is Record<string, any> => typeof value === "object" && value !== null && !Array.isArray(value)

const settingsPath = (name: string, env: NodeJS.ProcessEnv) => path.join(engineConfigDir(env), name)

function loadScoped<T>(name: string, env: NodeJS.ProcessEnv, check: (value: unknown, where: string) => string | null): Scoped<T> {
  const file = settingsPath(name, env)
  if (!fs.existsSync(file)) return { version: 1, default: {}, targets: {} }
  const raw = JSON.parse(fs.readFileSync(file, "utf8"))
  if (raw?.version !== 1 || !isObject(raw.default ?? {}) || !isObject(raw.targets ?? {})) throw new Error(`${file}: unsupported settings file`)
  const scopes: Array<[string, unknown]> = [["default", raw.default ?? {}], ...Object.entries(raw.targets ?? {}).map(([target, value]) => [`targets.${target}`, value] as [string, unknown])]
  for (const [scope, value] of scopes) {
    if (!isObject(value)) throw new Error(`${file}: ${scope} must be an object`)
    for (const [pack, entry] of Object.entries(value)) {
      const problem = PACK_NAME_RE.test(pack) ? check(entry, `${scope}.${pack}`) : `invalid pack name "${pack}"`
      if (problem) throw new Error(`${file}: ${problem}`)
    }
  }
  for (const target of Object.keys(raw.targets ?? {})) if (!path.isAbsolute(target)) throw new Error(`${file}: target "${target}" must be an absolute path`)
  return { version: 1, default: raw.default ?? {}, targets: raw.targets ?? {} }
}

function saveScoped(name: string, settings: Scoped<unknown>, env: NodeJS.ProcessEnv) {
  const prune = (value: unknown): unknown => {
    if (!isObject(value)) return value
    const entries = Object.entries(value).map(([key, item]) => [key, prune(item)] as const).filter(([, item]) => !(isObject(item) && !Object.keys(item).length))
    const out: Record<string, unknown> = {}
    for (const [key, item] of entries.sort(([a], [b]) => a.localeCompare(b))) setOwn(out, key, item)
    return out
  }
  const pruned = prune({ default: settings.default, targets: settings.targets }) as Record<string, unknown>
  atomicWriteRestrictedFile(settingsPath(name, env), Buffer.from(`${JSON.stringify({ version: 1, default: pruned.default ?? {}, targets: pruned.targets ?? {} }, null, 2)}\n`), 0o644)
}

function checkRoutes(value: unknown, where: string): string | null {
  if (!isObject(value)) return `${where} must map triggers to {agent: model}`
  for (const [trigger, agents] of Object.entries(value)) {
    if (!isTrigger(trigger)) return `${where}: invalid trigger "${trigger}"`
    if (!isObject(agents) || !Object.values(agents).every(model => model === INHERIT || isModelRef(model))) return `${where}.${trigger}: values must be "provider/model[#variant]" or "inherit"`
  }
  return null
}

function checkOverrides(value: unknown, where: string): string | null {
  if (!isObject(value) || Object.keys(value).some(key => key !== "agents" && key !== "commands")) return `${where} accepts only "agents" and "commands"`
  for (const kind of ["agents", "commands"] as const) {
    const entries = value[kind]
    if (entries === undefined) continue
    if (!isObject(entries)) return `${where}.${kind} must be an object keyed by ID`
    const allowed = kind === "agents" ? AGENT_FIELDS : COMMAND_FIELDS
    for (const [id, patch] of Object.entries(entries)) {
      if (!isObject(patch)) return `${where}.${kind}.${id} must be an object`
      const unknown = Object.keys(patch).find(field => !allowed.has(field))
      if (unknown) return `${where}.${kind}.${id}: "${unknown}" cannot be overridden (allowed: ${[...allowed].join(", ")})`
      if (patch.model !== undefined && patch.model !== null && !isModelRef(patch.model)) return `${where}.${kind}.${id}.model must be "provider/model[#variant]" or null`
    }
  }
  return null
}

export const loadRoutingSettings = (env: NodeJS.ProcessEnv = process.env) => loadScoped<Routes>("routing.json", env, checkRoutes)
export const saveRoutingSettings = (settings: RoutingSettings, env: NodeJS.ProcessEnv = process.env) => saveScoped("routing.json", settings, env)
export const loadOverrideSettings = (env: NodeJS.ProcessEnv = process.env) => loadScoped<PackOverrides>("overrides.json", env, checkOverrides)
export const saveOverrideSettings = (settings: OverrideSettings, env: NodeJS.ProcessEnv = process.env) => saveScoped("overrides.json", settings, env)

/** The settings scope to edit: one target, or the default for every target. */
export function scopeOf<T>(settings: Scoped<T>, target: string | null): Record<string, T> {
  if (target === null) return settings.default
  return ownChild(settings.targets, target)
}

/** Overrides of one pack for one target: the target scope patches the default field by field. */
export function effectiveOverrides(settings: OverrideSettings, target: string, pack: string): Required<PackOverrides> {
  const out: Required<PackOverrides> = { agents: {}, commands: {} }
  for (const scope of [own(settings.default, pack), own(own(settings.targets, target), pack)]) {
    for (const kind of ["agents", "commands"] as const) {
      for (const [id, patch] of Object.entries(scope?.[kind] ?? {})) for (const [field, value] of Object.entries(patch)) setOwn(ownChild(out[kind], id), field, value)
    }
  }
  return out
}

/** Rewrites a Markdown file's frontmatter with the patch applied (null removes a field); the body is kept byte for byte. */
export function patchFrontmatter(text: string, patch: FieldPatch): string {
  const { yamlText, body } = extractFrontmatter(text)
  const parsed = yamlText === null ? {} : YAML.parse(yamlText) ?? {}
  if (!isObject(parsed)) throw new Error("frontmatter is not a mapping")
  for (const [field, value] of Object.entries(patch)) {
    if (value === null) delete parsed[field]
    else setOwn(parsed, field, value)
  }
  return Object.keys(parsed).length ? `---\n${YAML.stringify(parsed).trimEnd()}\n---\n${body}` : body
}

/** Sets `agent=model|inherit` pairs for one archetype pack and trigger in a scope. */
export function setRoutes(scope: Record<string, Routes>, pack: string, trigger: string, assignments: Record<string, string>): void {
  if (!PACK_NAME_RE.test(pack)) throw new Error(`invalid pack name "${pack}"`)
  if (!isTrigger(trigger)) throw new Error(`invalid trigger "${trigger}": use a provider ("mistral") or provider/model`)
  if (!Object.keys(assignments).length) throw new Error("give at least one <agent>=<provider/model[#variant]|inherit>")
  for (const [agent, model] of Object.entries(assignments)) {
    if (model !== INHERIT && !isModelRef(model)) throw new Error(`${agent}: "${model}" is not "inherit" or provider/model[#variant]`)
    setOwn(ownChild(ownChild(scope, pack), trigger), agent, model)
  }
}

/** Removes some agents of a trigger, or the whole trigger when none is named. Returns false when nothing was set. */
export function unsetRoutes(scope: Record<string, Routes>, pack: string, trigger: string, agents: string[]): boolean {
  const routes = own(own(scope, pack), trigger)
  if (!routes) return false
  if (!agents.length) delete scope[pack][trigger]
  else for (const agent of agents) delete routes[agent]
  return true
}

/** Patches fields of an agent or command of a pack in a scope; `null` removes the field from the installed file. */
export function setOverride(scope: Record<string, PackOverrides>, pack: string, kind: "agents" | "commands", id: string, fields: FieldPatch): void {
  if (!PACK_NAME_RE.test(pack)) throw new Error(`invalid pack name "${pack}"`)
  const next = { ...(own(own(scope, pack)?.[kind], id) ?? {}) }
  for (const [field, value] of Object.entries(fields)) setOwn(next, field, value)
  const problem = checkOverrides({ [kind]: { [id]: next } }, `${pack}`)
  if (problem) throw new Error(problem)
  setOwn(ownChild(ownChild(scope, pack) as Record<string, any>, kind), id, next)
}

/** Drops some overridden fields, or the whole override when none is named. Returns false when nothing was set. */
export function unsetOverride(scope: Record<string, PackOverrides>, pack: string, kind: "agents" | "commands", id: string, fields: string[]): boolean {
  const patch = own(own(scope, pack)?.[kind], id)
  if (!patch) return false
  if (!fields.length) delete scope[pack]![kind]![id]
  else for (const field of fields) delete patch[field]
  return true
}

export interface RoutingArchetype { callers: string[]; pinned: string[]; routes: Routes }
export interface RuntimeRouting { version: 2; generatedBy: string; archetypes: Record<string, RoutingArchetype> }

/**
 * routing.json for the router plugin: per archetype pack, its routingDefaults patched by the default and then the
 * target routing settings, agent by agent. `agents` holds each agent's effective mode and fixed model after
 * overrides: only subagents of the pack are routed (never callers, primaries or agents of other packs), and a
 * subagent with a fixed model is pinned.
 */
export function buildRuntimeRouting(packs: Array<{ manifest: PackManifest; agents: Record<string, { mode?: string; model?: string }> }>, settings: RoutingSettings, target: string): RuntimeRouting | null {
  const archetypes: Record<string, RoutingArchetype> = {}
  for (const { manifest, agents } of [...packs].sort((a, b) => a.manifest.name.localeCompare(b.manifest.name))) {
    if (!manifest.archetype) continue
    const callers = manifest.archetype.callers
    const subagents = new Set(Object.entries(agents).filter(([id, agent]) => !callers.includes(id) && agent.mode !== "primary").map(([id]) => id))
    const routes: Routes = {}
    for (const layer of [manifest.routingDefaults, own(settings.default, manifest.name), own(own(settings.targets, target), manifest.name)]) {
      for (const [trigger, routed] of Object.entries(layer ?? {})) {
        for (const [agent, model] of Object.entries(routed)) if (subagents.has(agent)) setOwn(ownChild(routes, trigger), agent, model)
      }
    }
    const pinned = [...subagents].filter(id => typeof agents[id].model === "string").sort()
    archetypes[manifest.name] = { callers: [...callers], pinned, routes }
  }
  return Object.keys(archetypes).length ? { version: 2, generatedBy: "manage-agents reconcile; edit with `manage-agents models`", archetypes } : null
}
