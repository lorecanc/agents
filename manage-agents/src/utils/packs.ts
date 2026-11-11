import fs from "node:fs"
import { builtinModules } from "node:module"
import path from "node:path"
import semver from "semver"
import YAML from "yaml"
import { isModelRef, isTrigger } from "./values.js"
import { extractFrontmatter } from "./agents.js"

/** Pack contract implemented by this engine (contract/CONTRACT.md). */
export const CONTRACT_VERSION = { major: 1, minor: 0 } as const
export const MANIFEST_FILE = "opencode-pack.json"

export interface PackManifest {
  contract: string
  name: string
  version: string
  description: string
  requires: Record<string, string>
  archetype?: { callers: string[]; reference: string }
  routingDefaults?: Record<string, Record<string, string>>
}

export interface PackAgent {
  id: string
  mode?: string
  model?: string
}

export interface PackIds {
  agents: string[]
  commands: string[]
  skills: string[]
  plugins: string[]
  themes: string[]
  mcpServers: string[]
}

export interface ExecutableSurface {
  plugins: string[]
  pluginPackages: string[]
  toolModules: string[]
  skillScripts: string[]
  mcpServers: Array<{ name: string; type: string; command?: string[]; url?: string }>
  externalCommands: string[]
}

/** A validated reference whose target is not in this pack: the resolver must find it in a required pack. */
export interface UnresolvedReference {
  from: string
  kind: "plugin" | "skill" | "instruction" | "file" | "import"
  target: string
}

export interface PackIssue {
  level: "error" | "warning"
  code: string
  path?: string
  message: string
}

export interface PackValidation {
  root: string
  manifest: PackManifest | null
  files: string[]
  agents: PackAgent[]
  ids: PackIds
  executable: ExecutableSurface
  unresolved: UnresolvedReference[]
  issues: PackIssue[]
}

export interface ValidatePackOptions {
  /** Git sources are pinned to revisions, so `requires: "*"` is accepted only for local sources. */
  sourceKind?: "local" | "git"
}

export const PACK_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
const CONTRACT_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const MANIFEST_KEYS = new Set(["$schema", "contract", "name", "version", "description", "requires", "archetype", "routingDefaults"])
const ROOT_FILE_RE = /^(?:opencode-pack\.json|opencode\.jsonc?|AGENTS\.md|(?:README|LICENSE|LICENCE|CHANGELOG)(?:\.(?:md|txt|rst))?)$/i
const NATIVE_DIRS = new Set(["agents", "commands", "skills", "plugins", "themes", "tools"])
const LEGACY_DIRS = new Map([["agent", "agents"], ["mode", "agents"], ["modes", "agents"], ["command", "commands"], ["skill", "skills"], ["plugin", "plugins"], ["tool", "tools"]])
const RESERVED_DIRS = new Set(["instructions", ".manage-agents"])
const IGNORED_NAMES = new Set([".DS_Store", "node_modules"])
const CONFIG_KEYS = new Set(["$schema", "plugins", "mcp", "skills", "instructions", "agents", "commands", "formatter", "lsp"])
const PLUGIN_ENTRY_RE = /^(?:index|server)\.(?:ts|js|mjs)$/
const CODE_RE = /\.(?:ts|mts|cts|js|mjs|cjs)$/
const SCRIPT_RE = /\.(?:sh|bash|zsh|py|rb|pl|ts|mts|js|mjs|cjs)$/
const TEXT_RE = /\.(?:md|txt|json|jsonc|ya?ml|toml|ts|mts|cts|js|mjs|cjs|sh|bash|zsh|py|rb|html|css)$/i
const DEPRECATED_AGENT_KEYS: Record<string, string> = { tools: "permissions", permission: "permissions", name: "the file path" }
const AGENT_MODES = new Set(["primary", "subagent", "all"])
// [^{}] keeps the scan linear on hostile input made of many unterminated "{file:" prefixes.
const FILE_REF_RE = /\{file:([^{}]*)\}/g
const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"'\n]+)["']/g
const ABSOLUTE_CONFIG_RE = /~\/\.config\/opencode\b|\$\{?XDG_CONFIG_HOME\}?\/opencode\b|\/\.config\/opencode\//
const BUILTINS = new Set(builtinModules)
/** Files larger than this are not read: packs may come from untrusted sources. */
export const MAX_SCANNED_BYTES = 2 * 1024 * 1024

/** Copies text while dropping comments; outside strings and comments, `onCode` may replace a character (null keeps it). */
function scanOutsideStrings(text: string, onCode: (source: string, index: number) => string | null, quotes = '"'): string {
  let out = ""
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quotes.includes(char)) {
      let j = i + 1
      while (j < text.length && text[j] !== char && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1
      out += text.slice(i, j + 1)
      i = j
    } else if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++
      out += "\n"
    } else if (char === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2)
      i = end === -1 ? text.length : end + 1
    } else out += onCode(text, i) ?? char
  }
  return out
}

/** JSON with comments and trailing commas, as OpenCode accepts in opencode.jsonc. */
export function parseJsonc(text: string): unknown {
  const withoutComments = scanOutsideStrings(text, () => null)
  return JSON.parse(scanOutsideStrings(withoutComments, (source, index) => {
    if (source[index] !== ",") return null
    let next = index + 1
    while (next < source.length && /\s/.test(source[next])) next++
    return source[next] === "}" || source[next] === "]" ? "" : null
  }))
}

/** Best effort: drops JS comments so commented-out imports are not checked. Template literals are not parsed. */
const stripJsComments = (source: string) => scanOutsideStrings(source, () => null, `"'`)

const isAbsoluteRef = (ref: string) => path.posix.isAbsolute(ref) || path.win32.isAbsolute(ref) || ref.startsWith("~")

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const foldKey = (rel: string) => rel.normalize("NFC").toLowerCase()

/** Pack-relative POSIX path of `ref` resolved from `fromDir`, or null when it leaves the pack. */
function resolveInPack(fromDir: string, ref: string): string | null {
  const joined = path.posix.normalize(path.posix.join(fromDir, ref))
  return joined === ".." || joined.startsWith("../") || path.posix.isAbsolute(joined) ? null : joined.replace(/\/$/, "")
}

function walk(root: string, issues: PackIssue[]): string[] {
  const files: string[] = []
  const realRoot = fs.realpathSync(root)
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name)
      const rel = path.relative(root, full).split(path.sep).join("/")
      if (IGNORED_NAMES.has(entry.name) || entry.name.startsWith(".git")) {
        if (entry.name === "node_modules") issues.push({ level: "warning", code: "node-modules", path: rel, message: "node_modules is never installed; vendor plugin dependencies as bundled files" })
        continue
      }
      if (entry.isSymbolicLink()) {
        let target: string
        try {
          target = fs.realpathSync(full)
        } catch {
          issues.push({ level: "error", code: "symlink-broken", path: rel, message: "broken symlink" })
          continue
        }
        const inside = path.relative(realRoot, target)
        if (inside.startsWith("..") || path.isAbsolute(inside)) issues.push({ level: "error", code: "symlink-escape", path: rel, message: "symlink points outside the pack" })
        else if (fs.statSync(target).isDirectory()) issues.push({ level: "error", code: "symlink-directory", path: rel, message: "symlinked directories are not supported" })
        else if (!fs.statSync(target).isFile()) issues.push({ level: "error", code: "symlink-special", path: rel, message: "a symlink must point to a regular file" })
        else files.push(rel)
      } else if (entry.isDirectory()) visit(full)
      else if (entry.isFile()) files.push(rel)
    }
  }
  visit(root)
  return files
}

/** Reads a pack file for scanning, or reports it and returns null when it is too large. */
function readText(root: string, rel: string, issues: PackIssue[]): string | null {
  const full = path.join(root, rel)
  if (fs.statSync(full).size > MAX_SCANNED_BYTES) {
    if (!issues.some(issue => issue.code === "file-too-large" && issue.path === rel)) issues.push({ level: "warning", code: "file-too-large", path: rel, message: `larger than ${MAX_SCANNED_BYTES} bytes; its content was not checked` })
    return null
  }
  return fs.readFileSync(full, "utf8")
}

function readManifest(root: string, issues: PackIssue[], options: ValidatePackOptions): PackManifest | null {
  const file = path.join(root, MANIFEST_FILE)
  if (!fs.existsSync(file)) {
    issues.push({ level: "error", code: "manifest-missing", path: MANIFEST_FILE, message: "a pack needs opencode-pack.json at its root" })
    return null
  }
  if (!fs.lstatSync(file).isFile()) {
    issues.push({ level: "error", code: "manifest-invalid", path: MANIFEST_FILE, message: "opencode-pack.json must be a regular file, not a symlink or directory" })
    return null
  }
  let raw: unknown
  try {
    const text = readText(root, MANIFEST_FILE, issues)
    if (text === null) return null
    raw = JSON.parse(text)
  } catch (error) {
    issues.push({ level: "error", code: "manifest-invalid", path: MANIFEST_FILE, message: `invalid JSON: ${(error as Error).message}` })
    return null
  }
  const error = (message: string) => issues.push({ level: "error", code: "manifest-invalid", path: MANIFEST_FILE, message })
  if (!isObject(raw)) {
    error("the manifest must be a JSON object")
    return null
  }
  const contract = typeof raw.contract === "string" ? CONTRACT_RE.exec(raw.contract) : null
  if (!contract) {
    error('"contract" must be a "MAJOR.MINOR" string, e.g. "1.0"')
    return null
  }
  if (Number(contract[1]) !== CONTRACT_VERSION.major) {
    issues.push({ level: "error", code: "contract-unsupported", path: MANIFEST_FILE, message: `contract ${raw.contract} is not supported (this engine implements ${CONTRACT_VERSION.major}.${CONTRACT_VERSION.minor})` })
    return null
  }
  if (Number(contract[2]) > CONTRACT_VERSION.minor) issues.push({ level: "warning", code: "contract-newer-minor", path: MANIFEST_FILE, message: `contract ${raw.contract} is newer than ${CONTRACT_VERSION.major}.${CONTRACT_VERSION.minor}; newer optional features are ignored` })

  for (const key of Object.keys(raw)) if (!MANIFEST_KEYS.has(key)) error(`unknown key "${key}"`)
  const name = raw.name
  if (typeof name !== "string" || !PACK_NAME_RE.test(name)) error('"name" must be lowercase letters, digits and hyphens (max 64)')
  if (typeof raw.version !== "string" || semver.valid(raw.version) !== raw.version) error('"version" must be a full semver version, e.g. "1.2.0"')
  if (typeof raw.description !== "string" || !raw.description.trim()) error('"description" must be a non-empty string')

  const requires: Record<string, string> = {}
  if (raw.requires !== undefined) {
    if (!isObject(raw.requires)) error('"requires" must be a map of pack name to semver range, e.g. {"dev-tools": "^2.0.0"}')
    else for (const [dependency, range] of Object.entries(raw.requires)) {
      if (!PACK_NAME_RE.test(dependency)) error(`"requires" has an invalid pack name "${dependency}"`)
      else if (dependency === name) error("a pack cannot require itself")
      else if (typeof range !== "string" || semver.validRange(range) === null) error(`"requires.${dependency}" must be a semver range`)
      else if (range.trim() === "*" && options.sourceKind === "git") error(`"requires.${dependency}": "*" is allowed only in local sources`)
      else requires[dependency] = range
    }
  }

  let archetype: PackManifest["archetype"]
  if (raw.archetype !== undefined) {
    const value = raw.archetype
    const callers = isObject(value) && Array.isArray(value.callers) ? value.callers : null
    if (!isObject(value) || !callers?.length || !callers.every(caller => typeof caller === "string") || new Set(callers).size !== callers.length) error('"archetype.callers" must be a non-empty list of distinct agent IDs')
    else if (typeof value.reference !== "string" || !callers.includes(value.reference)) error('"archetype.reference" must be one of "archetype.callers"')
    else if (Object.keys(value).some(key => key !== "callers" && key !== "reference")) error('"archetype" accepts only "callers" and "reference"')
    else archetype = { callers: callers as string[], reference: value.reference }
  }

  let routingDefaults: PackManifest["routingDefaults"]
  if (raw.routingDefaults !== undefined) {
    if (raw.archetype === undefined) error('"routingDefaults" requires "archetype"')
    else if (!isObject(raw.routingDefaults)) error('"routingDefaults" must map a trigger (provider or provider/model) to {agent: model}')
    else {
      routingDefaults = {}
      for (const [trigger, roles] of Object.entries(raw.routingDefaults)) {
        if (!isTrigger(trigger)) error(`"routingDefaults" has an invalid trigger "${trigger}"`)
        else if (!isObject(roles) || !Object.values(roles).every(model => model === "inherit" || isModelRef(model))) error(`"routingDefaults.${trigger}" must map agent IDs to "provider/model[#variant]" or "inherit"`)
        else routingDefaults[trigger] = roles as Record<string, string>
      }
    }
  }

  if (issues.some(issue => issue.level === "error" && issue.path === MANIFEST_FILE)) return null
  return { contract: raw.contract as string, name: name as string, version: raw.version as string, description: raw.description as string, requires, ...(archetype ? { archetype } : {}), ...(routingDefaults ? { routingDefaults } : {}) }
}

/** Reads only the manifest, for discovery; `validatePack` does the full check. */
export function readPackManifest(packRoot: string, options: ValidatePackOptions = {}): { manifest: PackManifest | null; issues: PackIssue[] } {
  const issues: PackIssue[] = []
  return { manifest: readManifest(path.resolve(packRoot), issues, options), issues }
}

/** Validates a pack directory against contract 1.x. Never writes. */
export function validatePack(packRoot: string, options: ValidatePackOptions = {}): PackValidation {
  const root = path.resolve(packRoot)
  const issues: PackIssue[] = []
  const ids: PackIds = { agents: [], commands: [], skills: [], plugins: [], themes: [], mcpServers: [] }
  const executable: ExecutableSurface = { plugins: [], pluginPackages: [], toolModules: [], skillScripts: [], mcpServers: [], externalCommands: [] }
  const result: PackValidation = { root, manifest: null, files: [], agents: [], ids, executable, unresolved: [], issues }
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    issues.push({ level: "error", code: "pack-missing", message: `${root} is not a directory` })
    return result
  }
  const manifest = readManifest(root, issues, options)
  result.manifest = manifest
  if (issues.some(issue => issue.code === "contract-unsupported")) return result

  const files = walk(root, issues)
  result.files = files
  const fileSet = new Set(files)
  const dirSet = new Set(files.flatMap(file => file.split("/").slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join("/"))))
  const error = (code: string, rel: string, message: string) => issues.push({ level: "error", code, path: rel, message })
  const warning = (code: string, rel: string, message: string) => issues.push({ level: "warning", code, path: rel, message })
  const packName = manifest?.name
  const hasRequires = Object.keys(manifest?.requires ?? {}).length > 0
  const reference = (from: string, kind: UnresolvedReference["kind"], target: string | null, raw: string, exists: (target: string) => boolean) => {
    if (raw.includes("\\")) return error("reference-backslash", from, `${kind} reference "${raw}" must use forward slashes`)
    if (target === null) return error("reference-escape", from, `${kind} reference "${raw}" leaves the pack`)
    if (exists(target)) return
    if (hasRequires) result.unresolved.push({ from, kind, target })
    else error("reference-missing", from, `${kind} reference "${raw}" does not exist in the pack and the pack requires no other pack`)
  }

  const folded = new Map<string, string>()
  for (const file of files) {
    const key = foldKey(file)
    const previous = folded.get(key)
    if (previous) error("case-collision", file, `collides with "${previous}" on case-insensitive filesystems`)
    else folded.set(key, file)
  }

  const configFiles = files.filter(file => file === "opencode.json" || file === "opencode.jsonc")
  if (configFiles.length > 1) error("config-duplicate", "opencode.jsonc", "use either opencode.json or opencode.jsonc, not both")

  const skillRoots = files.filter(file => file.startsWith("skills/") && file.endsWith("/SKILL.md")).map(file => file.slice(0, -"/SKILL.md".length)).sort((a, b) => b.length - a.length)
  const skillOf = (file: string) => skillRoots.find(dir => file.startsWith(`${dir}/`))

  for (const file of files) {
    const [top, ...rest] = file.split("/")
    const tail = rest.join("/")
    if (!rest.length) {
      if (!ROOT_FILE_RE.test(top)) error("root-file", file, "only opencode-pack.json, opencode.json(c), AGENTS.md, README, LICENSE and CHANGELOG may sit at the pack root")
      continue
    }
    const folded = top.normalize("NFC").toLowerCase()
    if (folded !== top && (NATIVE_DIRS.has(folded) || RESERVED_DIRS.has(folded) || LEGACY_DIRS.has(folded))) { error("directory-case", file, `the ${folded}/ directory must be spelled in lowercase`); continue }
    if (RESERVED_DIRS.has(top)) { error("reserved-path", file, `${top}/ is reserved for the engine`); continue }
    if (LEGACY_DIRS.has(top)) { error("legacy-directory", file, `use ${LEGACY_DIRS.get(top)}/ instead of the legacy ${top}/`); continue }
    if (top === "agents" || top === "commands") {
      if (!file.endsWith(".md")) { error("not-markdown", file, `${top}/ holds only Markdown files`); continue }
      const id = tail.slice(0, -3)
      if (top === "commands") { ids.commands.push(id); continue }
      const agent: PackAgent = { id }
      ids.agents.push(id)
      result.agents.push(agent)
      const text = readText(root, file, issues)
      const { yamlText } = text === null ? { yamlText: null } : extractFrontmatter(text)
      if (yamlText !== null) {
        let frontmatter: unknown
        try {
          frontmatter = YAML.parse(yamlText)
        } catch (parseError) {
          error("frontmatter-invalid", file, `invalid YAML frontmatter: ${(parseError as Error).message}`)
        }
        if (frontmatter !== undefined && frontmatter !== null && !isObject(frontmatter)) error("frontmatter-invalid", file, "frontmatter must be a mapping")
        else if (isObject(frontmatter)) {
          if (frontmatter.mode !== undefined && !AGENT_MODES.has(String(frontmatter.mode))) error("agent-mode", file, 'mode must be "primary", "subagent" or "all"')
          for (const [key, replacement] of Object.entries(DEPRECATED_AGENT_KEYS)) if (key in frontmatter) warning("agent-deprecated-key", file, `"${key}" is a V1 key ignored by OpenCode V2; use ${replacement}`)
          if (typeof frontmatter.mode === "string") agent.mode = frontmatter.mode
          if (typeof frontmatter.model === "string") agent.model = frontmatter.model
        }
      }
    } else if (top === "skills") {
      const skill = skillOf(file)
      if (!skill) { error("skill-orphan", file, "every file under skills/ must be inside a directory with SKILL.md"); continue }
      if (file === `${skill}/SKILL.md`) {
        ids.skills.push(skill.slice("skills/".length))
        const text = readText(root, file, issues)
        const { yamlText } = text === null ? { yamlText: null } : extractFrontmatter(text)
        let description: unknown
        try {
          description = yamlText ? (YAML.parse(yamlText) as Record<string, unknown> | null)?.description : undefined
        } catch {
          error("frontmatter-invalid", file, "invalid YAML frontmatter")
        }
        if (text !== null && (typeof description !== "string" || !description.trim())) warning("skill-description", file, "without a description the model cannot discover the skill")
      } else if (SCRIPT_RE.test(file) || (fs.statSync(path.join(root, file)).mode & 0o111) !== 0) executable.skillScripts.push(file)
    } else if (top === "plugins") {
      if (rest.length === 1) error("plugin-single-file", file, "use a directory plugin: plugins/<name>/index.ts")
      else if (rest.length === 2 && (PLUGIN_ENTRY_RE.test(rest[1]) || rest[1] === "package.json") && !ids.plugins.includes(rest[0])) ids.plugins.push(rest[0])
    } else if (top === "themes") {
      if (rest.length !== 1 || !file.endsWith(".json")) error("theme-file", file, "themes/ holds only <name>.json files")
      else ids.themes.push(tail.slice(0, -5))
    } else {
      const namespaced = packName !== undefined && (rest[0] === packName && rest.length > 1 || top === "tools" && rest.length === 1 && rest[0].startsWith(`_${packName}_`))
      if (!namespaced) error("namespace", file, `non-native paths must live under ${top}/${packName ?? "<pack>"}/${top === "tools" ? ` or tools/_${packName ?? "<pack>"}_*` : ""}`)
      if (top === "tools" && CODE_RE.test(file)) executable.toolModules.push(file)
    }
  }

  for (const plugin of new Set(files.filter(file => /^plugins\/[^/]+\//.test(file)).map(file => file.split("/")[1]))) {
    if (!ids.plugins.includes(plugin)) error("plugin-entry", `plugins/${plugin}`, "a directory plugin needs index.ts|js, server.ts|js or package.json at its root")
  }
  ids.plugins.sort()
  executable.plugins = [...ids.plugins]

  const configFile = configFiles[0]
  if (configFile) {
    let config: unknown
    try {
      const text = readText(root, configFile, issues)
      if (text !== null) config = parseJsonc(text)
    } catch (parseError) {
      error("config-invalid", configFile, `invalid JSON: ${(parseError as Error).message}`)
    }
    if (config !== undefined && !isObject(config)) error("config-invalid", configFile, "must be a JSON object")
    else if (isObject(config)) validateConfig(config, configFile)
  }

  function validateConfig(config: Record<string, unknown>, file: string) {
    for (const key of Object.keys(config)) if (!CONFIG_KEYS.has(key)) error("config-key", file, `"${key}" belongs to the user's configuration; a pack may set only ${[...CONFIG_KEYS].filter(k => k !== "$schema").join(", ")}`)
    const pathList = (key: "skills" | "instructions", kind: "skill" | "instruction") => {
      const value = config[key]
      if (value === undefined) return
      if (!Array.isArray(value) || !value.every(item => typeof item === "string")) return error("config-invalid", file, `"${key}" must be a list of paths or URLs`)
      for (const item of value) {
        if (/^https?:\/\//.test(item)) continue
        if (isAbsoluteRef(item)) { error("absolute-path", file, `"${key}" entry "${item}" must be relative to the pack root`); continue }
        if (/[*?[]/.test(item)) continue
        reference(file, kind, resolveInPack(".", item), item, target => fileSet.has(target) || dirSet.has(target))
      }
    }
    pathList("skills", "skill")
    pathList("instructions", "instruction")

    if (config.plugins !== undefined) {
      if (!Array.isArray(config.plugins)) error("config-invalid", file, '"plugins" must be a list')
      else for (const entry of config.plugins) {
        const spec = typeof entry === "string" ? entry : isObject(entry) && typeof entry.package === "string" ? entry.package : null
        if (spec === null || (isObject(entry) && entry.options !== undefined && !isObject(entry.options))) { error("config-invalid", file, '"plugins" entries are "<spec>" or {"package": "<spec>", "options": {...}}'); continue }
        const local = spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("file:")
        if (!local) { if (isAbsoluteRef(spec)) error("absolute-path", file, `plugin "${spec}" must be relative to the pack root`); else executable.pluginPackages.push(spec); continue }
        const rel = spec.startsWith("file:") ? spec.replace(/^file:(?:\/\/)?/, "") : spec
        if (isAbsoluteRef(rel)) { error("absolute-path", file, `plugin "${spec}" must be relative to the pack root`); continue }
        const target = resolveInPack(".", rel)
        if (target !== null && !/^plugins\/[^/]+$/.test(target)) { error("plugin-path", file, `plugin "${spec}" must point to ./plugins/<name>`); continue }
        reference(file, "plugin", target, spec, candidate => ids.plugins.includes(candidate.slice("plugins/".length)))
      }
    }

    if (config.mcp !== undefined) {
      const servers = isObject(config.mcp) ? config.mcp.servers : undefined
      if (!isObject(config.mcp) || Object.keys(config.mcp).some(key => key !== "servers") || (servers !== undefined && !isObject(servers))) error("config-invalid", file, 'MCP servers go under "mcp.servers.<name>"')
      else for (const [name, server] of Object.entries((servers ?? {}) as Record<string, unknown>)) {
        if (!isObject(server) || (server.type !== "local" && server.type !== "remote")) { error("config-invalid", file, `mcp.servers.${name} needs "type": "local" or "remote"`); continue }
        ids.mcpServers.push(name)
        if (server.type === "local") {
          const command = Array.isArray(server.command) && server.command.every(part => typeof part === "string") ? server.command as string[] : null
          if (!command?.length) { error("config-invalid", file, `mcp.servers.${name}.command must be a non-empty list of strings`); continue }
          executable.mcpServers.push({ name, type: "local", command })
          executable.externalCommands.push(command[0])
        } else executable.mcpServers.push({ name, type: "remote", ...(typeof server.url === "string" ? { url: server.url } : {}) })
      }
    }

    for (const key of ["formatter", "lsp"] as const) {
      const section = config[key]
      if (isObject(section)) for (const entry of Object.values(section)) {
        if (isObject(entry) && Array.isArray(entry.command) && typeof entry.command[0] === "string") executable.externalCommands.push(entry.command[0])
      }
    }
    for (const key of ["agents", "commands"] as const) {
      const section = config[key]
      if (section === undefined) continue
      if (!isObject(section)) { error("config-invalid", file, `"${key}" must be an object keyed by ID`); continue }
      for (const id of Object.keys(section)) {
        const list = key === "agents" ? ids.agents : ids.commands
        if (list.includes(id)) warning("config-duplicate-id", file, `${key.slice(0, -1)} "${id}" is defined both as a file and in ${file}`)
        else {
          list.push(id)
          if (key === "agents") {
            const entry = section[id]
            result.agents.push({ id, ...(isObject(entry) && typeof entry.mode === "string" ? { mode: entry.mode } : {}), ...(isObject(entry) && typeof entry.model === "string" ? { model: entry.model } : {}) })
          }
        }
      }
    }

    const visitStrings = (value: unknown) => {
      if (typeof value === "string") {
        for (const match of value.matchAll(FILE_REF_RE)) {
          const raw = match[1].trim()
          if (isAbsoluteRef(raw)) error("absolute-path", file, `{file:${raw}} must be relative to the pack root`)
          else reference(file, "file", resolveInPack(".", raw), raw, target => fileSet.has(target))
        }
      } else if (Array.isArray(value)) value.forEach(visitStrings)
      else if (isObject(value)) Object.values(value).forEach(visitStrings)
    }
    visitStrings(config)
  }

  for (const file of files.filter(file => (file.startsWith("plugins/") || file.startsWith("tools/")) && CODE_RE.test(file))) {
    const text = readText(root, file, issues)
    if (text === null) continue
    for (const match of stripJsComments(text).matchAll(IMPORT_RE)) {
      const spec = match[1]
      // Text such as `Theme compiled from "${name}"` inside a template literal is not an import; relative
      // specifiers are still checked, so a path leaving the pack is never skipped.
      if (spec.includes("${") && !spec.startsWith(".")) continue
      if (spec.startsWith("./") || spec.startsWith("../")) {
        reference(file, "import", resolveInPack(path.posix.dirname(file), spec), spec, target =>
          fileSet.has(target) || (/\.(?:m|c)?js$/.test(target) && fileSet.has(target.replace(/\.(m|c)?js$/, ".$1ts"))))
      } else if (!spec.startsWith("node:") && !BUILTINS.has(spec) && spec !== "@opencode/plugin" && !spec.startsWith("@opencode/plugin/")) {
        warning("import-dependency", file, `"${spec}" is not installed by OpenCode for local plugins; vendor it or use Node built-ins`)
      }
    }
  }

  for (const file of files.filter(file => TEXT_RE.test(file))) {
    const lines = readText(root, file, issues)?.split(/\r?\n/) ?? []
    const line = lines.findIndex(text => ABSOLUTE_CONFIG_RE.test(text))
    if (line !== -1) warning("absolute-config-path", `${file}:${line + 1}`, "absolute OpenCode config path; it breaks under XDG_CONFIG_HOME or a custom target (best-effort check)")
  }

  if (manifest) checkArchetype(manifest, result)
  for (const list of Object.values(ids)) list.sort()
  executable.externalCommands = [...new Set(executable.externalCommands)].sort()
  return result
}

function checkArchetype(manifest: PackManifest, result: PackValidation) {
  const byId = new Map(result.agents.map(agent => [agent.id, agent]))
  const error = (message: string) => result.issues.push({ level: "error", code: "archetype", path: MANIFEST_FILE, message })
  for (const caller of manifest.archetype?.callers ?? []) {
    const agent = byId.get(caller)
    if (!agent) error(`archetype caller "${caller}" is not an agent of this pack`)
    else if (agent.mode === "subagent") error(`archetype caller "${caller}" is a subagent; callers must be primary agents`)
  }
  for (const [trigger, roles] of Object.entries(manifest.routingDefaults ?? {})) {
    for (const id of Object.keys(roles)) {
      const agent = byId.get(id)
      if (!agent || manifest.archetype?.callers.includes(id) || agent.mode === "primary") error(`routingDefaults.${trigger}: "${id}" is not a subagent of this pack`)
      else if (agent.model) result.issues.push({ level: "warning", code: "archetype-pinned", path: MANIFEST_FILE, message: `routingDefaults.${trigger}: "${id}" has a fixed model and is not routed` })
    }
  }
}

export const hasErrors = (validation: PackValidation) => validation.issues.some(issue => issue.level === "error")

const NOT_INSTALLED_RE = /^(?:opencode-pack\.json|(?:README|LICENSE|LICENCE|CHANGELOG)(?:\.(?:md|txt|rst))?)$/i

/** Files the installer copies: everything except the manifest and the root README, LICENSE and CHANGELOG. */
export const installableFiles = (validation: PackValidation) => validation.files.filter(file => file.includes("/") || !NOT_INSTALLED_RE.test(file))
