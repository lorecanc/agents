/**
 * OpenCode V1 ↔ V2 frontmatter compatibility layer.
 *
 * V2 introduced several breaking changes to agent frontmatter:
 * - `max_steps` → `steps`
 * - `temperature`, `top_p` → `request.body.temperature`, `request.body.top_p`
 * - `permission` (object) → `permissions` (array of {action, resource, effect})
 * - `disable` → `disabled`
 * - `prompt` → `system`
 * - `variant` (separate field) → `model#variant` (joined with #)
 *
 * These functions translate between formats bidirectionally so the manager
 * works with both V1 and V2 agent files.
 */

// --- Types ---

export interface V1PermissionObject {
  [key: string]: string | boolean | Record<string, string>
}

export interface V2PermissionRule {
  action: string
  resource: string
  effect: "allow" | "ask" | "deny"
}

export interface V1Frontmatter {
  model?: string
  variant?: string
  prompt?: string
  disable?: boolean
  max_steps?: number
  temperature?: number
  top_p?: number
  permission?: V1PermissionObject
  [key: string]: any
}

export interface V2Frontmatter {
  model?: string
  system?: string
  disabled?: boolean
  steps?: number
  request?: {
    body?: {
      temperature?: number
      top_p?: number
      [key: string]: any
    }
    [key: string]: any
  }
  permissions?: V2PermissionRule[]
  [key: string]: any
}

// --- Permission translation ---

/**
 * Translate V1 permission object to V2 permissions array.
 * V1: { bash: "allow", edit: { "*": "deny" } }
 * V2: [{ action: "shell", resource: "*", effect: "allow" }, { action: "edit", resource: "*", effect: "deny" }]
 */
export function translatePermissionsV1ToV2(perm: V1PermissionObject): V2PermissionRule[] {
  const rules: V2PermissionRule[] = []

  for (const [key, value] of Object.entries(perm)) {
    if (typeof value === "string" || typeof value === "boolean") {
      const effect = (value === "allow" || value === true) ? "allow" as const
        : (value === "deny" || value === false) ? "deny" as const
        : "ask" as const
      rules.push({ action: mapPermissionKeyToAction(key), resource: "*", effect })
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      for (const [resource, effectValue] of Object.entries(value as Record<string, string | boolean>)) {
        const effect = (effectValue === "allow" || effectValue === true) ? "allow" as const
          : (effectValue === "deny" || effectValue === false) ? "deny" as const
          : "ask" as const
        rules.push({ action: mapPermissionKeyToAction(key), resource, effect })
      }
    }
  }

  return rules
}

/**
 * Translate V2 permissions array to V1 permission object.
 * V2: [{ action: "shell", resource: "*", effect: "allow" }]
 * V1: { bash: "allow" }
 */
export function translatePermissionsV2ToV1(perms: V2PermissionRule[]): V1PermissionObject {
  const result: V1PermissionObject = {}

  for (const rule of perms) {
    const key = mapActionToPermissionKey(rule.action)
    if (!key) continue

    if (rule.resource === "*") {
      result[key] = rule.effect
    } else {
      // If there's already a non-object value (e.g., from a previous "*" rule),
      // convert it to an object to preserve both rules
      if (result[key] !== undefined && typeof result[key] !== "object") {
        const existingValue = result[key] as string | boolean
        result[key] = { "*": String(existingValue) }
      }
      if (typeof result[key] !== "object" || result[key] === undefined) {
        result[key] = {}
      }
      ;(result[key] as Record<string, string>)[rule.resource] = rule.effect
    }
  }

  return result
}

function mapPermissionKeyToAction(key: string): string {
  const map: Record<string, string> = {
    bash: "shell",
    execute: "shell",
    read: "read",
    write: "edit",
    edit: "edit",
    grep: "grep",
    glob: "glob",
    lsp: "lsp",
    webfetch: "webfetch",
    task: "subagent",
    question: "question",
  }
  return map[key] || key
}

function mapActionToPermissionKey(action: string): string | null {
  const map: Record<string, string> = {
    shell: "bash",
    read: "read",
    edit: "edit",
    grep: "grep",
    glob: "glob",
    lsp: "lsp",
    webfetch: "webfetch",
    subagent: "task",
    question: "question",
  }
  return map[action] || null
}

// --- Frontmatter translation ---

/**
 * Translate V1 frontmatter to V2 format.
 * Preserves all unknown fields as-is.
 */
export function translateFrontmatterV1ToV2(fm: V1Frontmatter): V2Frontmatter {
  const result: V2Frontmatter = { ...fm }

  // max_steps → steps
  if (fm.max_steps !== undefined) {
    result.steps = fm.max_steps
    delete result.max_steps
  }

  // temperature, top_p → request.body
  if (fm.temperature !== undefined || fm.top_p !== undefined) {
    result.request = { ...result.request }
    result.request.body = { ...result.request?.body }
    if (fm.temperature !== undefined) {
      result.request.body.temperature = fm.temperature
      delete result.temperature
    }
    if (fm.top_p !== undefined) {
      result.request.body.top_p = fm.top_p
      delete result.top_p
    }
  }

  // permission → permissions
  if (fm.permission !== undefined) {
    result.permissions = translatePermissionsV1ToV2(fm.permission)
    delete result.permission
  }

  // disable → disabled
  if (fm.disable !== undefined) {
    result.disabled = fm.disable
    delete result.disable
  }

  // prompt → system
  if (fm.prompt !== undefined) {
    result.system = fm.prompt
    delete result.prompt
  }

  // variant → model#variant
  if (fm.variant !== undefined) {
    const baseModel = fm.model || ""
    result.model = fm.variant ? `${baseModel}#${fm.variant}` : baseModel
    delete result.variant
  }

  return result
}

/**
 * Translate V2 frontmatter to V1 format.
 * Preserves all unknown fields as-is.
 */
export function translateFrontmatterV2ToV1(fm: V2Frontmatter): V1Frontmatter {
  const result: V1Frontmatter = { ...fm }

  // steps → max_steps
  if (fm.steps !== undefined) {
    result.max_steps = fm.steps
    delete result.steps
  }

  // request.body → temperature, top_p
  if (fm.request?.body) {
    const body = fm.request.body
    if (body.temperature !== undefined) {
      result.temperature = body.temperature
    }
    if (body.top_p !== undefined) {
      result.top_p = body.top_p
    }
    // Clean up empty request.body
    if (Object.keys(body).length === 0) {
      delete result.request
    } else {
      result.request = { ...fm.request }
      delete result.request.body
      if (Object.keys(result.request).length === 0) {
        delete result.request
      }
    }
  }

  // permissions → permission
  if (fm.permissions !== undefined) {
    result.permission = translatePermissionsV2ToV1(fm.permissions)
    delete result.permissions
  }

  // disabled → disable
  if (fm.disabled !== undefined) {
    result.disable = fm.disabled
    delete result.disabled
  }

  // system → prompt
  if (fm.system !== undefined) {
    result.prompt = fm.system
    delete result.system
  }

  // model#variant → model + variant
  if (fm.model && fm.model.includes("#")) {
    const [baseModel, variant] = fm.model.split("#", 2)
    result.model = baseModel
    result.variant = variant
  }

  return result
}

// --- Config translation ---

/**
 * Translate V1 opencode.json config to V2 format.
 * V1: { agent: {...}, mode: {...}, command: {...}, subtask: {...} }
 * V2: { agents: {...}, commands: {...}, subagent: {...} }
 */
export function translateConfigV1ToV2(config: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = { ...config }

  // agent → agents
  if (config.agent !== undefined) {
    result.agents = config.agent
    delete result.agent
  }

  // mode → agents (with mode: primary)
  if (config.mode !== undefined) {
    result.agents = { ...result.agents }
    for (const [name, agentDef] of Object.entries(config.mode)) {
      result.agents[name] = { ...agentDef as any, mode: "primary" }
    }
    delete result.mode
  }

  // command → commands
  if (config.command !== undefined) {
    result.commands = config.command
    delete result.command
  }

  // subtask → subagent
  if (config.subtask !== undefined) {
    result.subagent = config.subtask
    delete result.subtask
  }

  // Provider filters → policies (V2 uses internal policies)
  // These are accepted but unsupported in V2, so we just warn
  if (config.enabled_providers !== undefined) {
    delete result.enabled_providers
  }
  if (config.disabled_providers !== undefined) {
    delete result.disabled_providers
  }
  if (config.autoupdate !== undefined) {
    delete result.autoupdate
  }
  if (config.small_model !== undefined) {
    delete result.small_model
  }

  return result
}

/**
 * Translate V2 opencode.json config to V1 format.
 */
export function translateConfigV2ToV1(config: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = { ...config }

  // agents → agent
  if (config.agents !== undefined) {
    result.agent = config.agents
    delete result.agents
  }

  // commands → command
  if (config.commands !== undefined) {
    result.command = config.commands
    delete result.commands
  }

  // subagent → subtask
  if (config.subagent !== undefined) {
    result.subtask = config.subagent
    delete result.subagent
  }

  return result
}

// --- Detection ---

/**
 * Detect whether frontmatter is V1 or V2 format.
 * Returns "v1", "v2", or "unknown".
 */
export function detectFrontmatterVersion(fm: Record<string, any>): "v1" | "v2" | "unknown" {
  const v2OnlyFields = ["steps", "disabled", "system", "permissions", "request"]
  const v1OnlyFields = ["max_steps", "disable", "prompt", "permission"]

  const hasV2 = v2OnlyFields.some(f => f in fm)
  const hasV1 = v1OnlyFields.some(f => f in fm)

  if (hasV2 && !hasV1) return "v2"
  if (hasV1 && !hasV2) return "v1"
  return "unknown"
}
