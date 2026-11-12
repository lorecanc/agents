import assert from "node:assert/strict"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { parse as parseYaml } from "yaml"

// Conformance test for the V2-native layout of the catalog packs. It reads
// packs/ directly and parses files as text, so it never depends on the
// OpenCode runtime being installed.
//
// Expected state:
//   - packs/*/agents/**/*.md use `permissions: [{action, resource, effect}]`
//   - packs/*/commands/**/*.md have no `subtask` and no separate `variant`
//   - packs/*/opencode.json(c) use `mcp.servers` (no `enabled` flags) and
//     config-relative `./plugins/<name>` entries that resolve to a directory
//     plugin of the pack or of a pack it requires directly
//   - packs/*/plugins/<name>/index.ts|js import from `@opencode/plugin`
//   - no plugin or tool imports the legacy `@opencode-ai/plugin`
//   - every `<family>_*.ts` tool is registered by the `<family>-tools` plugin
//     of the same pack

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, "..")
const packsDir = path.join(repoRoot, "packs")

const rel = (p) => path.relative(repoRoot, p) || "."
const read = (p) => readFileSync(p, "utf8")
const isDir = (p) => existsSync(p) && statSync(p).isDirectory()
const isFile = (p) => existsSync(p) && statSync(p).isFile()
const CODE_FILE = /\.(?:[cm]?[jt]s|tsx)$/
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/

const FORBIDDEN_AGENT_KEYS = ["permission", "temperature", "top_p", "top_k", "max_steps", "disable", "prompt", "variant", "tools"]
// `lsp` IS a valid V2 permission action; `doom_loop` is not.
const FORBIDDEN_RULE_ACTIONS = new Set([
  "doom_loop",
  "list",
  "read_mcp_resource",
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "bash",
  "task",
  "write",
  "patch",
  "multiedit",
  "apply_patch",
])
const RULE_KEYS = ["action", "effect", "resource"]

function splitFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  return match ? match[1] : null
}

function walkFiles(dir) {
  if (!isDir(dir)) return []
  const out = []
  for (const entry of readdirSync(dir).sort()) {
    if (entry === "node_modules") continue
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walkFiles(full))
    else out.push(full)
  }
  return out
}

function packNames() {
  return readdirSync(packsDir)
    .filter((name) => isFile(path.join(packsDir, name, "opencode-pack.json")))
    .sort()
}

function readManifest(pack) {
  return JSON.parse(read(path.join(packsDir, pack, "opencode-pack.json")))
}

function pluginDirsOf(pack) {
  const dir = path.join(packsDir, pack, "plugins")
  return isDir(dir) ? readdirSync(dir).filter((entry) => isDir(path.join(dir, entry))).sort() : []
}

function pluginIndex(pack, plugin) {
  const base = path.join(packsDir, pack, "plugins", plugin)
  const ts = path.join(base, "index.ts")
  const js = path.join(base, "index.js")
  return isFile(ts) ? ts : isFile(js) ? js : null
}

// Strips // and /* */ comments outside strings, then trailing commas.
function parseJsonc(text) {
  let out = ""
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1
      out += text.slice(i, j + 1)
      i = j
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++
      out += "\n"
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2)
      i = end === -1 ? text.length : end + 1
    } else {
      out += ch
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"))
}

function packConfigs() {
  const out = []
  for (const pack of packNames()) {
    for (const name of ["opencode.json", "opencode.jsonc"]) {
      const file = path.join(packsDir, pack, name)
      if (isFile(file)) out.push({ pack, file })
    }
  }
  return out
}

// Match actual module syntax (import/export ... from, side-effect import,
// require). A raw substring match would also flag header comments that merely
// mention the legacy package, such as packs/toolkit/tools/toolkit/_tool.ts.
const LEGACY_PLUGIN_IMPORT =
  /^[ \t]*(?:import|export)\b[^\n]*\bfrom[ \t]*["']@opencode-ai\/plugin["']|^[ \t]*import[ \t]*["']@opencode-ai\/plugin["']|\brequire[ \t]*\([ \t]*["']@opencode-ai\/plugin["'][ \t]*\)/m

function importsLegacyPlugin(source) {
  return LEGACY_PLUGIN_IMPORT.test(source)
}

function markdownFiles(kind) {
  return packNames().flatMap((pack) => walkFiles(path.join(packsDir, pack, kind)).filter((file) => file.endsWith(".md")))
}

// --- 1. Agent frontmatter -------------------------------------------------

function collectAgentViolations() {
  const v = []
  const files = markdownFiles("agents")
  if (files.length === 0) v.push(`${rel(packsDir)}: no agent markdown files found`)

  for (const file of files) {
    const where = rel(file)
    const raw = splitFrontmatter(read(file))
    if (raw === null) {
      v.push(`${where}: missing YAML frontmatter`)
      continue
    }
    let fm
    try {
      fm = parseYaml(raw)
    } catch (error) {
      v.push(`${where}: unparseable frontmatter (${error.message})`)
      continue
    }
    if (!fm || typeof fm !== "object" || Array.isArray(fm)) {
      v.push(`${where}: frontmatter is not a mapping`)
      continue
    }

    if (!("permissions" in fm)) {
      v.push(`${where}: missing "permissions" key`)
    } else if (!Array.isArray(fm.permissions)) {
      v.push(`${where}: "permissions" must be an array`)
    }
    for (const key of FORBIDDEN_AGENT_KEYS) {
      if (key in fm) v.push(`${where}: legacy key "${key}" is forbidden in V2`)
    }
    const requestBody = fm.request?.body
    if (requestBody && typeof requestBody === "object" && !Array.isArray(requestBody)) {
      for (const key of ["temperature", "top_p", "top_k"]) {
        if (key in requestBody) v.push(`${where}: frontmatter request.body contains legacy sampling key "${key}"`)
      }
    }

    if (Array.isArray(fm.permissions)) {
      fm.permissions.forEach((rule, index) => {
        const at = `${where}: permissions[${index}]`
        if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
          v.push(`${at} is not an object`)
          return
        }
        const keys = Object.keys(rule).sort()
        if (keys.join(",") !== RULE_KEYS.join(",")) {
          v.push(`${at} must have exactly action/resource/effect, found [${keys.join(", ")}]`)
        }
        if (!["allow", "deny", "ask"].includes(rule.effect)) {
          v.push(`${at} has invalid effect ${JSON.stringify(rule.effect)}`)
        }
        if (FORBIDDEN_RULE_ACTIONS.has(rule.action)) {
          v.push(`${at} uses forbidden action "${rule.action}"`)
        }
        if (rule.action === "execute" && rule.effect === "allow") {
          v.push(`${at} grants execute (execute must be denied or absent)`)
        }
      })
    }
  }
  return v
}

// --- 2. Command frontmatter -----------------------------------------------

function collectCommandViolations() {
  const v = []
  for (const file of markdownFiles("commands")) {
    const text = read(file)
    const raw = splitFrontmatter(text)
    const where = rel(file)
    if (raw === null) {
      if (text.startsWith("---")) v.push(`${where}: malformed or unclosed YAML frontmatter delimiter`)
      continue
    }
    let fm
    try {
      fm = parseYaml(raw)
    } catch {
      const keys = new Set([...raw.matchAll(/^([A-Za-z0-9_-]+)\s*:/gm)].map(([, key]) => key))
      for (const key of ["subtask", "variant"]) {
        if (keys.has(key)) v.push(`${where}: legacy command key "${key}" is forbidden in V2`)
      }
      continue
    }
    if (!fm || typeof fm !== "object" || Array.isArray(fm)) continue
    for (const key of ["subtask", "variant"]) {
      if (key in fm) v.push(`${where}: legacy command key "${key}" is forbidden in V2`)
    }
  }
  return v
}

// --- 3. Pack opencode.json(c) ---------------------------------------------

function collectConfigViolations() {
  const v = []
  for (const { pack, file } of packConfigs()) {
    const where = rel(file)
    let config
    try {
      config = parseJsonc(read(file))
    } catch (error) {
      v.push(`${where}: unparseable (${error.message})`)
      continue
    }
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      v.push(`${where}: not a JSON object`)
      continue
    }

    if ("mcp" in config) {
      const mcp = config.mcp
      if (!mcp || typeof mcp !== "object" || Array.isArray(mcp)) {
        v.push(`${where}: "mcp" is not an object`)
      } else {
        for (const key of Object.keys(mcp)) {
          if (key !== "servers") v.push(`${where}: mcp.${key} is a top-level server entry (must live under mcp.servers)`)
        }
        const servers = mcp.servers
        if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
          v.push(`${where}: missing "mcp.servers" object`)
        } else {
          for (const [name, server] of Object.entries(servers)) {
            const at = `${where}: mcp.servers.${name}`
            if (!server || typeof server !== "object" || Array.isArray(server)) {
              v.push(`${at} is not an object`)
              continue
            }
            if ("disabled" in server && server.disabled !== true) v.push(`${at} has "disabled" that is not true`)

            if (server.type === "local") {
              if (server.codemode !== false) v.push(`${at} is local but does not set "codemode": false`)
              if (!Array.isArray(server.command) || server.command.length === 0) {
                v.push(`${at} is local but has no non-empty "command" array`)
              }
            } else {
              // The V2 schema rejects codemode on remote servers.
              if ("codemode" in server) v.push(`${at} is not local and must not set "codemode"`)
              if (server.command !== undefined) v.push(`${at} has a command but type is ${JSON.stringify(server.type)} (must be "local")`)
              if (server.type !== "remote") v.push(`${at} has unsupported type ${JSON.stringify(server.type)} (must be "local" or "remote")`)
            }
          }
        }
      }
    }

    if ("plugins" in config) {
      const plugins = config.plugins
      if (!Array.isArray(plugins)) {
        v.push(`${where}: "plugins" must be an array`)
      } else {
        // The pack's own plugins and those of the packs it requires directly.
        const visible = new Map(pluginDirsOf(pack).map((name) => [name, pack]))
        for (const dep of Object.keys(readManifest(pack).requires ?? {})) {
          if (!isFile(path.join(packsDir, dep, "opencode-pack.json"))) continue
          for (const name of pluginDirsOf(dep)) if (!visible.has(name)) visible.set(name, dep)
        }
        plugins.forEach((entry, index) => {
          const at = `${where}: plugins[${index}]`
          const spec = typeof entry === "string" ? entry : entry && typeof entry === "object" ? entry.package : undefined
          if (typeof spec !== "string") {
            v.push(`${at} is neither a string nor { package, options }`)
            return
          }
          if (!spec.startsWith(".") && !spec.startsWith("/")) return // npm/git package spec
          const match = /^\.\/plugins\/([^/]+)\/?$/.exec(spec)
          if (!match) {
            v.push(`${at} ${JSON.stringify(spec)} is not config-relative "./plugins/<name>"`)
            return
          }
          const owner = visible.get(match[1])
          if (!owner) {
            v.push(`${at} ${JSON.stringify(spec)} does not resolve to a directory plugin of ${pack} or of a pack it requires`)
          } else if (!pluginIndex(owner, match[1])) {
            v.push(`${at} ${JSON.stringify(spec)} resolves to packs/${owner}/plugins/${match[1]} without index.ts/index.js`)
          }
        })
      }
    }
  }
  return v
}

// --- 4. Plugins -----------------------------------------------------------

function collectPluginsViolations() {
  const v = []
  let count = 0
  for (const pack of packNames()) {
    const dir = path.join(packsDir, pack, "plugins")
    if (!isDir(dir)) continue
    for (const entry of readdirSync(dir).sort()) {
      const full = path.join(dir, entry)
      if (!statSync(full).isDirectory() && CODE_FILE.test(entry)) {
        v.push(`${rel(full)}: top-level plugin file (plugins must be directories)`)
      }
    }
    for (const plugin of pluginDirsOf(pack)) {
      count++
      const index = pluginIndex(pack, plugin)
      if (!index) {
        v.push(`${rel(path.join(dir, plugin))}: plugin directory has no index.ts/index.js`)
        continue
      }
      const source = read(index)
      if (!/^[ \t]*import\b[^\n]*\bfrom[ \t]*["']@opencode\/plugin["']/m.test(source)) {
        v.push(`${rel(index)}: plugin does not import from "@opencode/plugin"`)
      }
      if (!/Plugin\s*\.\s*define\s*\(/.test(source)) {
        v.push(`${rel(index)}: plugin does not use Plugin.define(`)
      }
    }
  }
  if (count === 0) v.push(`${rel(packsDir)}: no plugin directories found`)
  return v
}

// --- 5. Tools -------------------------------------------------------------

function collectLegacyImportViolations() {
  const v = []
  for (const pack of packNames()) {
    for (const kind of ["plugins", "tools"]) {
      for (const file of walkFiles(path.join(packsDir, pack, kind))) {
        if (!CODE_FILE.test(file) || TEST_FILE.test(file) || file.endsWith(".d.ts")) continue
        if (importsLegacyPlugin(read(file))) v.push(`${rel(file)}: imports the legacy "@opencode-ai/plugin"`)
      }
    }
  }
  return v
}

// A tool is a top-level `tools/<namespace>/<family>_<name>.ts` file; helpers
// start with `_`. The `<family>-tools` plugin of the same pack registers it by
// importing `.../<family>_<name>.js` (or .ts).
function collectRegistryViolations() {
  const v = []
  for (const pack of packNames()) {
    const toolsRoot = path.join(packsDir, pack, "tools")
    if (!isDir(toolsRoot)) continue
    const byFamily = new Map()
    for (const ns of readdirSync(toolsRoot).sort()) {
      const nsDir = path.join(toolsRoot, ns)
      if (!isDir(nsDir)) continue
      for (const entry of readdirSync(nsDir).sort()) {
        if (!entry.endsWith(".ts") || entry.endsWith(".d.ts") || TEST_FILE.test(entry) || entry.startsWith("_")) continue
        if (!isFile(path.join(nsDir, entry))) continue
        const stem = entry.replace(/\.ts$/, "")
        const family = /^([a-z0-9]+)_/.exec(stem)?.[1]
        if (!family) {
          v.push(`${rel(path.join(nsDir, entry))}: tool name has no "<family>_" prefix`)
          continue
        }
        if (!byFamily.has(family)) byFamily.set(family, [])
        byFamily.get(family).push({ ns, stem })
      }
    }
    for (const [family, tools] of byFamily) {
      const index = pluginIndex(pack, `${family}-tools`)
      if (!index) {
        v.push(`packs/${pack}/plugins: no ${family} tools registry (expected packs/${pack}/plugins/${family}-tools/index.ts)`)
        continue
      }
      const source = read(index)
      const missing = tools.filter(({ ns, stem }) => {
        const spec = new RegExp(`["'][./]*tools/${ns}/${stem}\\.(?:js|ts)["']`)
        return !spec.test(source)
      })
      if (missing.length > 0) {
        v.push(`${rel(index)}: registry is missing [${missing.map(({ stem }) => stem).join(", ")}]`)
      }
    }
  }
  return v
}

// --- 6. no MCP "enabled" flags --------------------------------------------

// Only the MCP node and the direct server objects are inspected, so an env var
// literally named ENABLED cannot produce a false positive.
function collectEnabledFlagViolations() {
  const v = []
  const flag = (node, at) => {
    if (node && typeof node === "object" && !Array.isArray(node) && "enabled" in node) {
      v.push(`${at}.enabled is forbidden under mcp (use disabled: true)`)
    }
  }
  for (const { file } of packConfigs()) {
    let config
    try {
      config = parseJsonc(read(file))
    } catch {
      continue // reported by the config check
    }
    const mcp = config?.mcp
    if (!mcp || typeof mcp !== "object" || Array.isArray(mcp)) continue
    const at = `${rel(file)}: mcp`
    flag(mcp, at)
    const servers = mcp.servers
    if (servers && typeof servers === "object" && !Array.isArray(servers)) {
      for (const [name, server] of Object.entries(servers)) flag(server, `${at}.servers.${name}`)
      continue
    }
    // V1 shape (servers live directly under mcp) must also be caught.
    for (const [name, server] of Object.entries(mcp)) {
      if (server && typeof server === "object" && !Array.isArray(server)) flag(server, `${at}.${name}`)
    }
  }
  return v
}

const checks = [
  ["agents", collectAgentViolations],
  ["commands", collectCommandViolations],
  ["config", collectConfigViolations],
  ["plugins", collectPluginsViolations],
  ["legacy-imports", collectLegacyImportViolations],
  ["registries", collectRegistryViolations],
  ["enabled-flags", collectEnabledFlagViolations],
]

function assertNoViolations(violations) {
  assert.deepEqual(
    violations,
    [],
    `${violations.length} V2-native contract violation(s):\n${violations.map((line) => `- ${line}`).join("\n")}`,
  )
}

// --- Tests ----------------------------------------------------------------

test("agents: V2-native permissions arrays with normalized rules", () => {
  assertNoViolations(collectAgentViolations())
})

test("commands: V2-native frontmatter without subtask or separate variant", () => {
  assertNoViolations(collectCommandViolations())
})

test("config: mcp.servers, codemode/disabled, and config-relative plugins", () => {
  assertNoViolations(collectConfigViolations())
})

test("plugins: directory-based plugins importing @opencode/plugin", () => {
  assertNoViolations(collectPluginsViolations())
})

test("plugins and tools: no legacy @opencode-ai/plugin import", () => {
  assertNoViolations(collectLegacyImportViolations())
})

test("tools: per-domain registries are complete", () => {
  assertNoViolations(collectRegistryViolations())
})

test("tools: legacy plugin import detection ignores comments and catches real imports", () => {
  assert.equal(importsLegacyPlugin("// legacy @opencode-ai/plugin adapter\n/** mentions @opencode-ai/plugin */\nexport const x = 1\n"), false)
  assert.equal(importsLegacyPlugin('import { tool } from "@opencode-ai/plugin"\n'), true)
  assert.equal(importsLegacyPlugin('import type { Tool } from "@opencode-ai/plugin"\n'), true)
  assert.equal(importsLegacyPlugin('export * from "@opencode-ai/plugin"\n'), true)
  assert.equal(importsLegacyPlugin('import "@opencode-ai/plugin"\n'), true)
  assert.equal(importsLegacyPlugin('const plugin = require("@opencode-ai/plugin")\n'), true)
})

test("config: JSONC comments and trailing commas are accepted", () => {
  assert.deepEqual(parseJsonc('{\n  // c\n  "a": "x//y", /* b */ "b": [1, 2,],\n}'), { a: "x//y", b: [1, 2] })
})

test("no MCP 'enabled' flags in pack configs", () => {
  assertNoViolations(collectEnabledFlagViolations())
})

test("summary: zero V2-native contract violations", () => {
  const all = []
  for (const [area, collect] of checks) {
    for (const line of collect()) all.push(`[${area}] ${line}`)
  }
  assert.equal(all.length, 0, `${all.length} V2-native contract violation(s):\n${all.map((line) => `- ${line}`).join("\n")}`)
})
