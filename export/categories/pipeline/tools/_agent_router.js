// Pure routing logic for the agent-router plugin (src/plugins/agent-router).
//
// The plugin decides, at the moment a canonical archetype agent (flow-build, ...) delegates to a
// subagent, which model that subagent runs on. The decision follows the provider (or exact model)
// the calling agent is using right now, so one set of canonical agents serves every provider:
//
//   1. a model the caller passed explicitly (the user asked for it)  -> untouched
//   2. a pinned role (its canonical agent has a model in frontmatter) -> untouched, OpenCode uses it
//   3. the configuration for "<provider>/<model>", then "<provider>" -> that role's model
//   4. no configuration, or the role is "inherit"                     -> untouched: OpenCode falls
//      back to the parent session's model, i.e. the caller's
//
// The configurations come from routing.json next to the plugin. manage-agents generates it from
// .agent-manager/agent-routing.json (edited in its TUI); it is never edited by hand. Agents that are
// not canonical archetype agents (stamped *-pipeline-* bundles, ...) are never routed.

export const ROUTING_VERSION = 1
export const SUBAGENT_TOOLS = new Set(["subagent", "task"])
const MODEL_RE = /^[^\s/#]+\/[^\s#]+(?:#[^\s#]+)?$/
const ROLE_RE = /^[A-Za-z0-9_]+$/

/** "provider/model#variant" in OpenCode's V2 notation. */
export function isModelRef(value) {
  return typeof value === "string" && MODEL_RE.test(value)
}

/**
 * Normalize a model reference from a hook payload ({providerID, id|modelID, variant}) or a string.
 * Returns { provider, model, full } or null.
 */
export function modelOf(ref) {
  if (typeof ref === "string") {
    if (!isModelRef(ref)) return null
    const [base] = ref.split("#")
    const slash = base.indexOf("/")
    return { provider: base.slice(0, slash), model: base.slice(slash + 1), full: ref }
  }
  if (!ref || typeof ref !== "object") return null
  const provider = ref.providerID ?? ref.provider
  const model = ref.id ?? ref.modelID ?? ref.model
  if (typeof provider !== "string" || !provider || typeof model !== "string" || !model) return null
  const variant = typeof ref.variant === "string" && ref.variant ? `#${ref.variant}` : ""
  return { provider, model, full: `${provider}/${model}${variant}` }
}

/** Validate a parsed routing.json; returns the routing or throws with the first problem. */
export function validateRouting(value) {
  const fail = (message) => { throw new Error(`routing.json: ${message}`) }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("not an object")
  if (value.version !== ROUTING_VERSION) fail(`unsupported version ${value.version}`)
  if (!value.archetypes || typeof value.archetypes !== "object" || Array.isArray(value.archetypes)) fail("missing archetypes")
  for (const [id, archetype] of Object.entries(value.archetypes)) {
    if (!/^[a-z0-9][a-z0-9_]*$/.test(id)) fail(`invalid archetype id '${id}'`)
    if (!Array.isArray(archetype?.roles) || !archetype.roles.every(role => ROLE_RE.test(role))) fail(`${id}: roles must be a list of names`)
    if (!Array.isArray(archetype.pinned) || !archetype.pinned.every(role => ROLE_RE.test(role))) fail(`${id}: pinned must be a list of names`)
    if (!archetype.routes || typeof archetype.routes !== "object" || Array.isArray(archetype.routes)) fail(`${id}: missing routes`)
    for (const [key, route] of Object.entries(archetype.routes)) {
      if (!/^[^\s/#]+(?:\/[^\s#]+)?$/.test(key)) fail(`${id}: invalid route key '${key}'`)
      if (!route?.roles || typeof route.roles !== "object" || Array.isArray(route.roles)) fail(`${id}.${key}: missing roles`)
      for (const [role, model] of Object.entries(route.roles)) {
        if (!ROLE_RE.test(role)) fail(`${id}.${key}: invalid role '${role}'`)
        if (model !== "inherit" && !isModelRef(model)) fail(`${id}.${key}.${role}: '${model}' is not "inherit" or provider/model[#variant]`)
      }
    }
  }
  return value
}

/** [archetypeId, archetype, role] for a canonical archetype agent name, else null. */
export function archetypeOf(routing, agentName) {
  if (typeof agentName !== "string") return null
  for (const [id, archetype] of Object.entries(routing?.archetypes ?? {})) {
    if (!agentName.startsWith(`${id}-`)) continue
    const role = agentName.slice(id.length + 1)
    if (archetype.roles.includes(role)) return [id, archetype, role]
  }
  return null
}

/** The configuration for the caller's model: exact "provider/model" first, then "provider". */
export function routeFor(archetype, callerModel) {
  const model = modelOf(callerModel)
  if (!model) return null
  const routes = archetype.routes ?? {}
  return routes[`${model.provider}/${model.model}`] ?? routes[model.provider] ?? null
}

/** Model to inject into a subagent call as { model, role }, or null to leave the call as it is. */
export function decideSubagentModel(routing, { callerAgent, callerModel, targetAgent, requestedModel }) {
  if (!routing || (typeof requestedModel === "string" && requestedModel.trim())) return null
  const caller = archetypeOf(routing, callerAgent)
  if (!caller) return null
  const [id, archetype] = caller
  if (typeof targetAgent !== "string" || !targetAgent) return null
  // Inside the archetype the role is the suffix (flow-review -> review); built-ins keep their name.
  const role = targetAgent.startsWith(`${id}-`) ? targetAgent.slice(id.length + 1) : targetAgent
  if (archetype.pinned.includes(role)) return null
  const route = routeFor(archetype, callerModel)
  const model = route?.roles?.[role]
  if (!isModelRef(model)) return null
  if (modelOf(model)?.full === modelOf(callerModel)?.full) return null
  return { model, role }
}
