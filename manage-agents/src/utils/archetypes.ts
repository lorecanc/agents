import fs from "node:fs"
import path from "node:path"
import { parseAgentFile } from "./agents.js"
import { packDir, readManifest } from "./catalog.js"
import { hasErrors, MANIFEST_FILE, validatePack } from "./packs.js"
import { isModelRef, isTrigger, setOwn } from "./values.js"

// Model routing of archetype packs, as authored in a local pack catalog (the TUI's M on an archetype pack).
//
// An archetype pack declares `archetype.callers` (primary agents that delegate) and `routingDefaults`: when a
// caller runs on <trigger> (a provider "mistral" or an exact model "mistral/x"; the exact model wins), each subagent
// runs on the configured model, or inherits the caller's ("inherit" or absent). These defaults ship with the pack;
// a user overrides them per target with `manage-agents models` (userSettings.ts). Subagents with a `model` in their
// frontmatter are pinned and never routed.
//
// The TUI works with roles: an agent's ID without the "<pack>-" prefix (flow-review -> review), as in the legacy
// archetypes. They are converted back to agent IDs when the manifest is written.

export const INHERIT = "inherit"

/** role -> "provider/model#variant" | "inherit" */
export type RoleModels = Record<string, string>
export interface ArchetypeAgent { role: string; name: string; subagent: boolean; model?: string }
export interface ArchetypeView {
  id: string
  reference: ArchetypeAgent
  /** Primaries whose model picks the configuration: the reference first. */
  callers: ArchetypeAgent[]
  /** Subagents a configuration can set: subagents without a fixed model. */
  related: ArchetypeAgent[]
  /** Subagents with a fixed model: configurations skip them. */
  pinned: ArchetypeAgent[]
  configs: Record<string, RoleModels>
}

export function isRoutableArchetype(workspaceRoot: string, id: string | undefined | null): id is string {
  if (typeof id !== "string") return false
  const dir = packDir(workspaceRoot, id)
  if (!dir) return false
  try {
    return Boolean(readManifest(dir).archetype)
  } catch {
    return false
  }
}

const roleOf = (pack: string, agent: string) => agent.startsWith(`${pack}-`) ? agent.slice(pack.length + 1) : agent

function archetypeAgents(workspaceRoot: string, id: string, dir: string, callers: string[]): ArchetypeAgent[] {
  const agentsDir = path.join(dir, "agents")
  if (!fs.existsSync(agentsDir)) return []
  return (fs.readdirSync(agentsDir, { recursive: true }) as string[]).map(file => file.split(path.sep).join("/")).filter(file => file.endsWith(".md")).sort().flatMap(file => {
    const agent = parseAgentFile(path.join(agentsDir, file), workspaceRoot)
    if (!agent) return []
    const name = file.slice(0, -3)
    const model = typeof agent.frontmatter.model === "string" && agent.frontmatter.model ? agent.frontmatter.model : undefined
    return [{ role: roleOf(id, name), name, subagent: !callers.includes(name) && agent.frontmatter.mode !== "primary", ...(model ? { model } : {}) }]
  })
}

/** Everything the TUI shows for an archetype pack; null when the pack declares no archetype. */
export function describeArchetype(workspaceRoot: string, id: string): ArchetypeView | null {
  const dir = packDir(workspaceRoot, id)
  if (!dir) return null
  const manifest = readManifest(dir)
  if (!manifest.archetype) return null
  const callerIds: string[] = manifest.archetype.callers ?? []
  const agents = archetypeAgents(workspaceRoot, id, dir, callerIds)
  const reference = agents.find(agent => agent.name === manifest.archetype.reference)
  if (!reference) return null
  const subagents = agents.filter(agent => agent.subagent)
  const configs: Record<string, RoleModels> = {}
  for (const [trigger, routed] of Object.entries<Record<string, string>>(manifest.routingDefaults ?? {})) {
    const roles: RoleModels = {}
    for (const [agent, model] of Object.entries(routed)) setOwn(roles, roleOf(id, agent), model)
    setOwn(configs, trigger, roles)
  }
  return {
    id,
    reference,
    callers: [reference, ...agents.filter(agent => callerIds.includes(agent.name) && agent !== reference)],
    related: subagents.filter(agent => !agent.model),
    pinned: subagents.filter(agent => agent.model),
    configs,
  }
}

/** "flow-build or flow-plan": the primaries a configuration's trigger refers to. */
export function callersLabel(view: ArchetypeView): string {
  const names = view.callers.map(agent => agent.name)
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}` : names[0]
}

/**
 * Add, replace (`roles`) or remove (`null`) one configuration in the pack's routingDefaults, then validate the pack.
 * `previousTrigger` renames a configuration whose trigger was changed in the editor. Returns the manifest path.
 */
export function setArchetypeConfig(workspaceRoot: string, id: string, trigger: string, roles: RoleModels | null, options: { previousTrigger?: string } = {}): string {
  const view = describeArchetype(workspaceRoot, id)
  const dir = packDir(workspaceRoot, id)
  if (!view || !dir) throw new Error(`'${id}' is not an archetype pack of this catalog`)
  if (!isTrigger(trigger)) throw new Error(`the trigger must be "provider" or "provider/model"; got '${trigger}'`)
  const configs = { ...view.configs }
  if (roles === null) {
    if (!Object.hasOwn(configs, trigger)) throw new Error(`No configuration '${trigger}' in ${id}`)
    delete configs[trigger]
  } else {
    if (options.previousTrigger && options.previousTrigger !== trigger) {
      if (Object.hasOwn(configs, trigger)) throw new Error(`${id} already has a configuration for '${trigger}'`)
      delete configs[options.previousTrigger]
    }
    for (const [role, model] of Object.entries(roles)) {
      if (model !== INHERIT && !isModelRef(model)) throw new Error(`${role}: '${model}' is not "inherit" or provider/model[#variant]`)
      if (!view.related.some(agent => agent.role === role)) throw new Error(`${role}: not a routable subagent of ${id}${view.pinned.some(agent => agent.role === role) ? " (it has a fixed model)" : ""}`)
    }
    setOwn(configs, trigger, roles)
  }
  const nameOf = (role: string) => view.related.find(agent => agent.role === role)?.name ?? role
  const routingDefaults: Record<string, Record<string, string>> = {}
  for (const trigger of Object.keys(configs).sort()) {
    const entries = Object.entries(configs[trigger]).map(([role, model]) => [nameOf(role), model] as const).sort(([a], [b]) => a.localeCompare(b))
    if (entries.length) setOwn(routingDefaults, trigger, Object.fromEntries(entries))
  }
  const file = path.join(dir, MANIFEST_FILE)
  const before = fs.readFileSync(file, "utf8")
  const manifest = JSON.parse(before)
  if (Object.keys(routingDefaults).length) manifest.routingDefaults = routingDefaults
  else delete manifest.routingDefaults
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)
  const validation = validatePack(dir)
  if (hasErrors(validation)) {
    fs.writeFileSync(file, before)
    throw new Error(`Configuration rejected:\n${validation.issues.filter(issue => issue.level === "error").map(issue => `  - ${issue.message}`).join("\n")}`)
  }
  return file
}
