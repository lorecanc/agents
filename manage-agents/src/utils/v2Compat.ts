/**
 * OpenCode V1 ↔ V2 frontmatter compatibility layer.
 *
 * V2 introduced several breaking changes to agent frontmatter:
 * - `max_steps` → `steps`
 * - Sampling fields (`temperature`, `top_p`, `top_k`) are removed from agent frontmatter
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
  const seen = new Set<string>()

  // V2 rules are last-match-wins, so iteration order must follow the V1 object
  // exactly. Identical rules are dropped: the legacy `mcp-resource` key expands
  // to the same actions as the explicit resource keys.
  const push = (action: string, resource: string, effect: V2PermissionRule["effect"]) => {
    const id = `${action}\u0000${resource}\u0000${effect}`
    if (seen.has(id)) return
    seen.add(id)
    rules.push({ action, resource, effect })
  }

  // The V1 action-level `"*"` is the global rule. Emit it first, whatever its
  // position in the V1 object, so V2 last-match-wins sees it as the fallback.
  const globalValue = Object.hasOwn(perm, "*") ? perm["*"] : undefined
  if (typeof globalValue === "string" || typeof globalValue === "boolean") {
    push("*", "*", toEffect(globalValue))
  }

  const emit = (key: string, resource: string, effect: V2PermissionRule["effect"]) => {
    const expanded = Object.hasOwn(V1_ACTION_EXPANSIONS, key) ? V1_ACTION_EXPANSIONS[key] : null
    if (expanded) {
      for (const action of expanded) push(action, resource, effect)
      return
    }
    const action = resolveV1PermissionKey(key)
    if (!action) return
    push(action, resource, effect)
  }

  for (const [key, value] of Object.entries(perm)) {
    if (typeof value === "string" || typeof value === "boolean") {
      emit(key, "*", toEffect(value))
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      for (const [resource, effectValue] of Object.entries(value as Record<string, string | boolean>)) {
        emit(key, resource, toEffect(effectValue))
      }
    }
  }

  return rules
}

function toEffect(value: string | boolean): V2PermissionRule["effect"] {
  return (value === "allow" || value === true) ? "allow"
    : (value === "deny" || value === false) ? "deny"
    : "ask"
}

/**
 * Translate V2 permissions array to V1 permission object.
 * V2: [{ action: "shell", resource: "*", effect: "allow" }]
 * V1: { bash: "allow" }
 */
export function translatePermissionsV2ToV1(perms: V2PermissionRule[]): V1PermissionObject {
  // A global `{action:"*", resource:"*"}` rule maps back to the V1 `"*"` key
  // and always comes first, mirroring the write-side ordering.
  const globalRule = perms.find(rule => rule.action === "*" && rule.resource === "*")
  const result: V1PermissionObject = globalRule ? { "*": globalRule.effect } : {}

  for (const rule of perms) {
    if (rule.action === "*" && rule.resource === "*") continue
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
 * V2 action vocabulary provenance: OpenCode v2.2.5. The config schema published
 * at https://opencode.ai/config.json leaves `permissions[].action` as a plain
 * string, so the concrete names below are taken from the runtime permission
 * assertions (`action:"opencode_*"`) in the v2.2.5 binary.
 *
 * INTENTIONAL, irreversible collapses between V2 actions and V1 permission
 * keys. The V2 runtime carries no action that could map back to the finer V1
 * spelling, so these must not be "fixed":
 * - V2 `read` covers V1 `read` and `list`.
 * - V2 `edit` covers V1 `write`, `patch`, `apply_patch` and `multiedit`.
 * - V2 `shell` covers V1 `bash` and `execute`.
 * - V2 `opencode_list_mcp_resources` covers V1 `list_mcp_resources` and
 *   `list_mcp_resource_templates`.
 * V2 `subagent` similarly covers V1 `task`. The existing tests pin these
 * collapses.
 */
function mapPermissionKeyToAction(key: string): string | null {
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
    read_mcp_resource: "opencode_read_mcp_resource",
    list_mcp_resources: "opencode_list_mcp_resources",
    list_mcp_resource_templates: "opencode_list_mcp_resources",
  }
  // Own-property reads only: `constructor`, `toString` and friends must not
  // resolve to inherited Object members.
  return Object.hasOwn(map, key) ? map[key] : null
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
    opencode_read_mcp_resource: "read_mcp_resource",
    opencode_list_mcp_resources: "list_mcp_resources",
  }
  return Object.hasOwn(map, action) ? map[action] : null
}

/**
 * V1 keys that expand to more than one V2 action. `mcp-resource` was the
 * legacy shorthand for the two MCP resource tools.
 */
const V1_ACTION_EXPANSIONS: Record<string, string[]> = {
  "mcp-resource": ["opencode_read_mcp_resource", "opencode_list_mcp_resources"],
}

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

/**
 * V1-only spellings that also look like `<server>_<tool>`. They must fail
 * closed on the V2 side and must not be forwarded as MCP actions from V1.
 */
const V1_ONLY_PERMISSION_KEYS = new Set([
  "bash", "execute", "write", "patch", "apply_patch", "multiedit", "list",
  "task", "doom_loop", "read_mcp_resource", "list_mcp_resources",
  "list_mcp_resource_templates",
])

/** Repository custom tools (`src/tools/{dev,pipeline}_*.ts`) are V2-only as well. */
const CUSTOM_TOOL_ACTION = /^(?:dev|pipeline)_[a-z][a-z0-9_]*$/

/**
 * MCP tool action: `<server>_<tool>` or the `<server>_*` wildcard. The server
 * prefix must start with an alphanumeric so inherited names such as
 * `__proto__` cannot pass as an MCP server.
 */
const MCP_ACTION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*_(?:\*|[A-Za-z0-9][A-Za-z0-9._-]*)$/

function resolveV2PermissionKey(action: string): string | null {
  const mapped = mapActionToPermissionKey(action)
  if (mapped) return mapped
  if (V1_ONLY_PERMISSION_KEYS.has(action)) return null
  if (V2_PASSTHROUGH_ACTIONS.has(action) || CUSTOM_TOOL_ACTION.test(action)) return action
  return MCP_ACTION_NAME.test(action) ? action : null
}

function resolveV1PermissionKey(key: string): string | null {
  const mapped = mapPermissionKeyToAction(key)
  if (mapped) return mapped
  if (V1_ONLY_PERMISSION_KEYS.has(key)) return null
  if (V2_PASSTHROUGH_ACTIONS.has(key) || CUSTOM_TOOL_ACTION.test(key)) return key
  return MCP_ACTION_NAME.test(key) ? key : null
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
 * The `dev_*` / `pipeline_*` test mirrors `isOpenCodeCustomToolKey` in
 * bridgeToolReferences.ts, which cannot be imported here without a module
 * cycle (that file already imports this one).
 */
export function isKnownPermissionKey(key: string): boolean {
  return KNOWN_PERMISSION_KEYS.has(key) || CUSTOM_TOOL_ACTION.test(key)
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

  delete result.temperature
  delete result.top_p
  delete result.top_k

  if (isPlainObject(result.request) && isPlainObject(result.request.body)) {
    result.request = { ...result.request, body: { ...result.request.body } }
    delete result.request.body.temperature
    delete result.request.body.top_p
    delete result.request.body.top_k
    if (Object.keys(result.request.body).length === 0) {
      delete result.request.body
    }
    if (Object.keys(result.request).length === 0) {
      delete result.request
    }
  }

  // V1 tools and permission fields → V2 permissions. Existing V2 permissions win.
  const toolPermissions: V1PermissionObject = {}
  if (isPlainObject(fm.tools)) {
    for (const [key, value] of Object.entries(fm.tools)) {
      if (value === true) toolPermissions[key] = "allow"
      else if (value === false) toolPermissions[key] = "deny"
      else if (value === "allow" || value === "ask" || value === "deny") toolPermissions[key] = value
    }
  }
  if (fm.permission !== undefined || isPlainObject(fm.tools)) {
    const permissions = {
      ...toolPermissions,
      ...(isPlainObject(fm.permission) ? fm.permission : {}),
    }
    if (result.permissions === undefined) result.permissions = translatePermissionsV1ToV2(permissions)
    if (fm.permission !== undefined) delete result.permission
  }
  delete result.tools

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

  // variant → model#variant, composed at most once so `#` never doubles.
  if (fm.variant !== undefined) {
    const baseModel = fm.model || ""
    result.model = fm.variant && !baseModel.includes("#") ? `${baseModel}#${fm.variant}` : baseModel
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
  delete result.tools

  // steps → max_steps
  if (fm.steps !== undefined) {
    result.max_steps = fm.steps
    delete result.steps
  }

  delete result.temperature
  delete result.top_p
  delete result.top_k

  if (fm.request?.body) {
    result.request = { ...fm.request, body: { ...fm.request.body } }
    delete result.request.body.temperature
    delete result.request.body.top_p
    delete result.request.body.top_k
    if (Object.keys(result.request.body).length === 0) {
      delete result.request.body
    }
    if (Object.keys(result.request).length === 0) {
      delete result.request
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

export function translateCommandFrontmatterV1ToV2(fm: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = { ...fm }
  if (fm.subtask !== undefined) {
    if (result.subagent === undefined) result.subagent = fm.subtask
    delete result.subtask
  }
  if (fm.variant !== undefined) {
    const baseModel = typeof fm.model === "string" ? fm.model.split("#")[0] : ""
    if (baseModel) result.model = fm.variant ? `${baseModel}#${fm.variant}` : baseModel
    delete result.variant
  }
  return result
}

export function translateCommandFrontmatterV2ToV1(fm: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = { ...fm }
  if (fm.subagent !== undefined) {
    if (result.subtask === undefined) result.subtask = fm.subagent
    delete result.subagent
  }
  if (typeof fm.model === "string" && fm.model.includes("#")) {
    const [baseModel, variant] = fm.model.split("#", 2)
    result.model = baseModel
    result.variant = variant
  }
  return result
}

// --- Config translation ---

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * V1 mcp server `enabled` inverts to V2 `disabled`; every other field is kept.
 *
 * `codemode` is a V2 local-only policy (default false). The translator must
 * not decide that policy: the caller applies it. Here an existing `codemode`
 * value (including an explicit `false`) is preserved and no value is ever
 * invented, so a remote server cannot gain `codemode` through translation.
 */
function mcpServerV1ToV2(server: unknown): any {
  if (!isPlainObject(server)) return server
  const result = { ...server }
  if ("enabled" in result) {
    result.disabled = !result.enabled
    delete result.enabled
  }
  if ("codemode" in server) result.codemode = server.codemode
  return result
}

/** V2 mcp server `disabled` inverts to V1 `enabled`; every other field is kept. */
function mcpServerV2ToV1(server: unknown): any {
  if (!isPlainObject(server)) return server
  const result = { ...server }
  if ("disabled" in result) {
    result.enabled = !result.disabled
    delete result.disabled
  }
  return result
}

/**
 * Translate V1 opencode.json config to V2 format.
 * V1: { agent: {...}, mode: {...}, command: {...}, subtask: {...}, mcp: {...} }
 * V2: { agents: {...}, commands: {...}, subagent: {...}, mcp: { servers: {...} } }
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

  // Flat mcp.<name> → mcp.servers.<name>
  if (isPlainObject(config.mcp)) {
    const { servers: existingServers, ...entries } = config.mcp
    const servers: Record<string, any> = {}
    for (const [name, server] of Object.entries(isPlainObject(existingServers) ? existingServers : {})) {
      servers[name] = mcpServerV1ToV2(server)
    }
    const rest: Record<string, any> = {}
    let moved = false

    for (const [name, server] of Object.entries(entries)) {
      // `timeout` is an mcp-level setting, not a server.
      if (name === "timeout") {
        rest[name] = server
        continue
      }
      servers[name] = mcpServerV1ToV2(server)
      moved = true
    }

    if (moved || isPlainObject(existingServers)) {
      result.mcp = { ...rest, servers }
    }
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

  // mcp.servers.<name> → flat mcp.<name>
  if (isPlainObject(config.mcp) && isPlainObject(config.mcp.servers)) {
    const { servers, ...rest } = config.mcp
    const flat: Record<string, any> = { ...rest }
    for (const [name, server] of Object.entries(servers)) {
      flat[name] = mcpServerV2ToV1(server)
    }
    result.mcp = flat
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
  const v1OnlyFields = ["max_steps", "disable", "prompt", "permission", "temperature", "top_p", "top_k", "tools"]

  const hasV2 = v2OnlyFields.some(f => f in fm)
  const hasV1 = v1OnlyFields.some(f => f in fm)

  // V1 agent files in this repository may use `steps` alongside legacy permissions or sampling fields.
  if ("steps" in fm && ["permission", "temperature", "top_p", "top_k"].some(f => f in fm) && !["disabled", "system", "permissions", "request"].some(f => f in fm)) return "v1"
  if (hasV2 && !hasV1) return "v2"
  if (hasV1 && !hasV2) return "v1"
  return "unknown"
}
