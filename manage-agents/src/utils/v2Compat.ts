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
    // Fail closed: an action outside the V2 vocabulary is dropped instead of
    // copied verbatim, so a V1 spelling cannot smuggle a permission through.
    const key = resolveV2PermissionKey(rule.action)
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

/**
 * V2 action vocabulary provenance: OpenCode v2.1, the config schema published
 * at https://opencode.ai/config.json plus the permissions documentation,
 * verified against `opencode debug agents` on v2.1.3.
 *
 * INTENTIONAL, irreversible collapses between V2 actions and V1 permission
 * keys. The V2 runtime carries no action that could map back to the finer V1
 * spelling, so these must not be "fixed":
 * - V2 `read` covers V1 `read` and `list`.
 * - V2 `edit` covers V1 `write`, `patch`, `apply_patch` and `multiedit`.
 * - V2 `shell` covers V1 `bash` and `execute`.
 * V2 `subagent` similarly covers V1 `task`. The existing tests pin these
 * collapses.
 */
function mapPermissionKeyToAction(key: string): string {
  const map: Record<string, string> = {
    bash: "shell",
    execute: "shell",
    read: "read",
    write: "edit",
    edit: "edit",
    apply_patch: "edit",
    patch: "edit",
    multiedit: "edit",
    list: "read",
    grep: "grep",
    glob: "glob",
    lsp: "lsp",
    webfetch: "webfetch",
    task: "subagent",
    question: "question",
  }
  // Own-property reads only: `constructor`, `toString` and friends must not
  // resolve to inherited Object members.
  return Object.hasOwn(map, key) ? map[key] : key
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
    external_directory: "external_directory",
  }
  return Object.hasOwn(map, action) ? map[action] : null
}

/** Permission key names are lowercase identifiers; anything else is rejected. */
const PERMISSION_KEY_NAME = /^[a-z][a-z0-9_-]*$/

/**
 * V2-only action names with no V1 spelling. Only these reach the V1 layer
 * verbatim. The set is closed on purpose: an action missing from the V2
 * vocabulary (including a V1 spelling such as `bash`, `write` or `task`) must
 * be dropped, not forwarded, so the translation fails closed.
 */
const V2_PASSTHROUGH_ACTIONS = new Set([
  "todowrite", "skill", "websearch", "mcp-resource", "artifact", "file-diff",
  "opencode_session_rename", "opencode_session_move",
  "opencode_worktree_create", "opencode_worktree_list", "opencode_worktree_remove",
])

/** Repository custom tools (`src/tools/pipeline_*.ts`) are V2-only as well. */
const PIPELINE_TOOL_ACTION = /^pipeline_[a-z][a-z0-9_]*$/

function resolveV2PermissionKey(action: string): string | null {
  const mapped = mapActionToPermissionKey(action)
  if (mapped) return mapped
  if (!PERMISSION_KEY_NAME.test(action)) return null
  return V2_PASSTHROUGH_ACTIONS.has(action) || PIPELINE_TOOL_ACTION.test(action) ? action : null
}

/**
 * Built-in tool permission keys and the V2-only action names that reach the V1
 * layer verbatim. Anything else containing an underscore is an MCP tool key
 * (`<server>_<tool>`), never a built-in.
 */
const KNOWN_PERMISSION_KEYS = new Set([
  "read", "grep", "glob", "edit", "write", "patch", "multiedit", "apply_patch",
  "shell", "bash", "execute", "lsp", "webfetch", "websearch", "skill", "question",
  "task", "subagent", "todowrite", "external_directory", "doom_loop", "list",
  "mcp-resource", "artifact", "file-diff",
  "opencode_session_rename", "opencode_session_move",
  "opencode_worktree_create", "opencode_worktree_list", "opencode_worktree_remove",
  "read_mcp_resource", "list_mcp_resources", "list_mcp_resource_templates"
])

/**
 * Single source of truth for "built-in tool permission key vs MCP server key".
 * Bridges must call this instead of keeping their own key lists.
 *
 * The `pipeline_*` test mirrors `isOpenCodeCustomToolKey` in
 * bridgeToolReferences.ts, which cannot be imported here without a module
 * cycle (that file already imports this one).
 */
export function isKnownPermissionKey(key: string): boolean {
  return KNOWN_PERMISSION_KEYS.has(key) || /^pipeline_[a-z][a-z0-9_]*$/.test(key)
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

  // V1 agent files in this repository use `steps` alongside singular `permission`.
  if ("steps" in fm && "permission" in fm && !["disabled", "system", "permissions", "request"].some(f => f in fm)) return "v1"
  if (hasV2 && !hasV1) return "v2"
  if (hasV1 && !hasV2) return "v1"
  return "unknown"
}
