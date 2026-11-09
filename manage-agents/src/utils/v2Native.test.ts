import assert from "node:assert/strict"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { parse as parseYaml } from "yaml"

// Contract test for the locked V2-native layout. It is written against the
// repository root (NOT the manage-agents cwd) and parses files as text so it
// never depends on the V1/V2 runtime being installed.
//
// Expected state after the migration:
//   - src/agents/*.md use `permissions: [{action, resource, effect}]`
//   - src/opencode.json uses `mcp.servers` + `plugins: ["./plugins/..."]`,
//     where local plugin paths resolve relative to the config file directory
//     (the blueprint is copied to ~/.config/opencode/opencode.json)
//   - src/plugins/<plugin>/index.ts, importing from `@opencode/plugin`
//   - one tools registry per domain: pipeline-tools, doc-tools, slide-tools
//   - src/tools/*.ts stop importing the legacy `@opencode-ai/plugin`
//   - manage-agents/src/utils/v2Compat.ts translates MCP config and is wired
//     into production code (not only its own test)

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, "../../..")
const srcDir = path.join(repoRoot, "src")
const agentsDir = path.join(srcDir, "agents")
const commandsDir = path.join(srcDir, "commands")
const categoriesDir = path.join(repoRoot, "export", "categories")
const pluginsDir = path.join(srcDir, "plugins")
const toolsDir = path.join(srcDir, "tools")
const configPath = path.join(srcDir, "opencode.json")
const agentManagerDir = path.join(repoRoot, ".agent-manager")
const manageSrcDir = path.join(repoRoot, "manage-agents", "src")
const v2CompatPath = path.join(manageSrcDir, "utils", "v2Compat.ts")

const rel = (p: string) => path.relative(repoRoot, p) || "."
const read = (p: string) => readFileSync(p, "utf8")

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

function splitFrontmatter(text: string): string | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  return match ? match[1] : null
}

function walkFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walkFiles(full))
    else out.push(full)
  }
  return out
}

function topLevel(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir) : []
}

function readIfExists(file: string): string | null {
  return existsSync(file) ? read(file) : null
}

// Match actual module syntax (import/export ... from, side-effect import,
// require). A raw substring match would also flag header comments that merely
// mention the legacy package, such as src/tools/_tool.ts.
const LEGACY_PLUGIN_IMPORT =
  /^[ \t]*(?:import|export)\b[^\n]*\bfrom[ \t]*["']@opencode-ai\/plugin["']|^[ \t]*import[ \t]*["']@opencode-ai\/plugin["']|\brequire[ \t]*\([ \t]*["']@opencode-ai\/plugin["'][ \t]*\)/m

function importsLegacyPlugin(source: string): boolean {
  return LEGACY_PLUGIN_IMPORT.test(source)
}

// --- 1. Agent frontmatter -------------------------------------------------

function collectAgentViolations(): string[] {
  const v: string[] = []
  const files = topLevel(agentsDir)
    .filter((name) => name.endsWith(".md") && statSync(path.join(agentsDir, name)).isFile())
    .map((name) => path.join(agentsDir, name))
  if (files.length === 0) v.push(`${rel(agentsDir)}: no agent markdown files found`)
  for (const category of topLevel(categoriesDir).sort()) {
    const categoryPath = path.join(categoriesDir, category)
    if (!statSync(categoryPath).isDirectory()) continue
    const categoryAgentsDir = path.join(categoryPath, "agents")
    files.push(...topLevel(categoryAgentsDir)
      .filter((name) => name.endsWith(".md") && statSync(path.join(categoryAgentsDir, name)).isFile())
      .map((name) => path.join(categoryAgentsDir, name)))
  }
  files.sort()

  for (const file of files) {
    const where = rel(file)
    const raw = splitFrontmatter(read(file))
    if (raw === null) {
      v.push(`${where}: missing YAML frontmatter`)
      continue
    }
    let fm: any
    try {
      fm = parseYaml(raw)
    } catch (error) {
      v.push(`${where}: unparseable frontmatter (${(error as Error).message})`)
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
      fm.permissions.forEach((rule: any, index: number) => {
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

function collectCommandViolations(): string[] {
  const v: string[] = []
  const files = topLevel(commandsDir)
    .filter((name) => name.endsWith(".md") && statSync(path.join(commandsDir, name)).isFile())
    .map((name) => path.join(commandsDir, name))
  for (const category of topLevel(categoriesDir).sort()) {
    const categoryPath = path.join(categoriesDir, category)
    if (!statSync(categoryPath).isDirectory()) continue
    const categoryCommandsDir = path.join(categoryPath, "commands")
    files.push(...topLevel(categoryCommandsDir)
      .filter((name) => name.endsWith(".md") && statSync(path.join(categoryCommandsDir, name)).isFile())
      .map((name) => path.join(categoryCommandsDir, name)))
  }

  for (const file of files.sort()) {
    const text = read(file)
    const raw = splitFrontmatter(text)
    const where = rel(file)
    if (raw === null) {
      if (text.startsWith("---")) v.push(`${where}: malformed or unclosed YAML frontmatter delimiter`)
      continue
    }
    let fm: any
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

// --- 2. src/opencode.json -------------------------------------------------

function readConfig(): any {
  return JSON.parse(read(configPath))
}

function collectConfigViolations(): string[] {
  const v: string[] = []
  if (!existsSync(configPath)) return [`${rel(configPath)}: missing`]
  const config = readConfig()
  const where = rel(configPath)
  // The blueprint is copied to ~/.config/opencode/opencode.json, so local
  // plugin paths resolve against the config file directory, not the repo root.
  const configDir = path.dirname(configPath)
  const pluginRoot = path.join(configDir, "plugins")
  const mcp = config.mcp

  if (!mcp || typeof mcp !== "object" || Array.isArray(mcp)) {
    v.push(`${where}: missing "mcp" object`)
  } else {
    for (const key of Object.keys(mcp)) {
      if (key !== "servers") v.push(`${where}: mcp.${key} is a top-level server entry (must live under mcp.servers)`)
    }
    const servers = mcp.servers
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
      v.push(`${where}: missing "mcp.servers" object`)
    } else {
      for (const [name, server] of Object.entries<any>(servers)) {
        const at = `${where}: mcp.servers.${name}`
        if (!server || typeof server !== "object" || Array.isArray(server)) {
          v.push(`${at} is not an object`)
          continue
        }
        if ("enabled" in server) v.push(`${at} still uses "enabled" (use "disabled: true")`)
        if ("disabled" in server && server.disabled !== true) v.push(`${at} has "disabled" that is not true`)

        const isLocal = server.type === "local"
        if (isLocal) {
          if (server.codemode !== false) v.push(`${at} is local but does not set "codemode": false`)
          if (!Array.isArray(server.command)) v.push(`${at} is local but has no "command" array`)
        } else {
          // The V2 schema rejects codemode on remote servers.
          if ("codemode" in server) v.push(`${at} is not local and must not set "codemode"`)
          if (server.command !== undefined) v.push(`${at} has a command but type is ${JSON.stringify(server.type)} (must be "local")`)
          if (server.type !== "remote") v.push(`${at} has unsupported type ${JSON.stringify(server.type)} (must be "local" or "remote")`)
        }
      }
    }
  }

  const plugins = config.plugins
  if (!Array.isArray(plugins)) {
    v.push(`${where}: missing "plugins" array`)
  } else {
    const entries = plugins
      .filter((entry: any): entry is string => typeof entry === "string")
      .filter((entry) => entry.startsWith(".") || entry.startsWith("/"))
      .map((entry) => ({ entry, target: path.resolve(configDir, entry) }))

    for (const { entry, target } of entries) {
      if (!existsSync(target)) {
        v.push(`${where}: plugin entry ${JSON.stringify(entry)} does not resolve from ${rel(configDir)} (${rel(target)})`)
      } else if (!statSync(target).isDirectory()) {
        v.push(`${where}: plugin entry ${JSON.stringify(entry)} is not a directory`)
      }
    }

    const pluginDirs = entries.filter(
      ({ target }) => existsSync(target) && statSync(target).isDirectory() && target.startsWith(pluginRoot + path.sep),
    )
    const pipelineDirs = pluginDirs.filter(({ target }) => path.basename(target).startsWith("pipeline"))
    if (pipelineDirs.length < 2) {
      v.push(
        `${where}: "plugins" lists ${pipelineDirs.length} pipeline plugin directory entries resolved from ${rel(configDir)} (need at least 2)`,
      )
    }
  }
  return v
}

// --- 3. src/plugins/ ------------------------------------------------------

function collectPluginsViolations(): string[] {
  const v: string[] = []
  if (!existsSync(pluginsDir)) return [`${rel(pluginsDir)}: missing`]
  const entries = topLevel(pluginsDir).sort()

  for (const entry of entries) {
    const full = path.join(pluginsDir, entry)
    if (!statSync(full).isDirectory() && /\.(?:[cm]?[jt]s|tsx)$/.test(entry)) {
      v.push(`${rel(full)}: top-level plugin file (plugins must be directories)`)
    }
  }

  const pluginDirs = entries.filter((entry) => statSync(path.join(pluginsDir, entry)).isDirectory())
  if (pluginDirs.length === 0) v.push(`${rel(pluginsDir)}: contains no plugin directories`)
  for (const dir of pluginDirs) {
    const full = path.join(pluginsDir, dir)
    if (!existsSync(path.join(full, "index.ts")) && !existsSync(path.join(full, "index.js"))) {
      v.push(`${rel(full)}: plugin directory has no index.ts/index.js`)
    }
  }

  const guardDirs = pluginDirs.filter((dir) => dir.includes("guard"))
  if (guardDirs.length === 0) {
    v.push(`${rel(pluginsDir)}: no guard plugin directory found`)
  } else {
    for (const dir of guardDirs) {
      const full = path.join(pluginsDir, dir)
      const index = existsSync(path.join(full, "index.ts")) ? path.join(full, "index.ts") : path.join(full, "index.js")
      if (!existsSync(index)) continue // already reported above
      const source = read(index)
      if (!/["']@opencode\/plugin["']/.test(source)) {
        v.push(`${rel(index)}: guard plugin does not import from "@opencode/plugin"`)
      }
      if (!/Plugin\s*\.\s*define\s*\(/.test(source)) {
        v.push(`${rel(index)}: guard plugin does not use Plugin.define(`)
      }
    }
  }

  for (const file of walkFiles(pluginsDir)) {
    if (!/\.(?:[cm]?[jt]s|tsx)$/.test(file)) continue
    if (importsLegacyPlugin(read(file))) {
      v.push(`${rel(file)}: imports the legacy "@opencode-ai/plugin"`)
    }
  }
  return v
}

// --- 4. src/tools/ --------------------------------------------------------

const TOOL_FAMILIES = [
  { id: "pipeline", prefix: "pipeline_" },
  { id: "doc", prefix: "doc_" },
  { id: "slide", prefix: "slide_" },
] as const

function collectToolsViolations(): string[] {
  const v: string[] = []
  if (!existsSync(toolsDir)) return [`${rel(toolsDir)}: missing`]
  const entries = topLevel(toolsDir).sort()
  const tsFiles = entries.filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".d.ts"))

  for (const entry of tsFiles) {
    const file = path.join(toolsDir, entry)
    if (importsLegacyPlugin(read(file))) {
      v.push(`${rel(file)}: imports the legacy "@opencode-ai/plugin"`)
    }
  }

  const stems = tsFiles.map((entry) => entry.replace(/\.ts$/, ""))
  // Each domain owns a registry: src/plugins/<domain>-tools/index.ts.
  const registryIndexes = topLevel(pluginsDir)
    .filter((entry) => statSync(path.join(pluginsDir, entry)).isDirectory())
    .map((dir) => {
      const indexTs = path.join(pluginsDir, dir, "index.ts")
      const indexJs = path.join(pluginsDir, dir, "index.js")
      return { dir, file: existsSync(indexTs) ? indexTs : existsSync(indexJs) ? indexJs : null }
    })

  for (const family of TOOL_FAMILIES) {
    const expected = stems.filter((stem) => stem.startsWith(family.prefix))
    const registryDirs = registryIndexes.filter(({ dir }) => {
      const lower = dir.toLowerCase()
      return lower.includes(family.id) && /(?:^|[-_])tools$/.test(lower)
    })
    if (registryDirs.length === 0) {
      v.push(`${rel(pluginsDir)}: no ${family.id} tools registry (expected src/plugins/${family.id}-tools/index.ts)`)
      continue
    }
    const source = registryDirs.map(({ file }) => (file ? read(file) : "")).join("\n")
    const missing = expected.filter((stem) => !source.includes(stem))
    if (missing.length > 0) {
      v.push(`${rel(pluginsDir)}/${family.id}-tools: registry is missing [${missing.join(", ")}]`)
    }
  }
  return v
}

// --- 5. manage-agents v2Compat -------------------------------------------

function collectCompatViolations(): string[] {
  const v: string[] = []
  if (!existsSync(v2CompatPath)) return [`${rel(v2CompatPath)}: missing`]
  const source = read(v2CompatPath)
  const where = rel(v2CompatPath)

  if (!/servers/i.test(source)) v.push(`${where}: no MCP "servers" normalization`)
  if (!/disabled/i.test(source)) v.push(`${where}: no MCP "disabled" handling`)
  if (!/codemode/i.test(source)) v.push(`${where}: no MCP "codemode" handling`)

  const callers = walkFiles(manageSrcDir).filter((file) => {
    if (!/\.(?:[cm]?[jt]s|tsx)$/.test(file)) return false
    if (file === v2CompatPath) return false
    if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)) return false
    return /translateConfigV1ToV2/.test(read(file))
  })
  if (callers.length === 0) {
    v.push(`${where}: translateConfigV1ToV2 has no production call site under manage-agents/src`)
  }
  if (!/export\s+function\s+translateCommandFrontmatterV1ToV2\s*\(/.test(source)) {
    v.push(`${where}: translateCommandFrontmatterV1ToV2 is not exported`)
  }
  return v
}

// --- 6. no MCP "enabled" flags outside the config -------------------------

// Only the MCP node and the direct server objects are inspected, so an env var
// literally named ENABLED cannot produce a false positive.
function collectEnabledFlagViolations(): string[] {
  const v: string[] = []
  const flag = (node: any, at: string) => {
    if (node && typeof node === "object" && !Array.isArray(node) && "enabled" in node) {
      v.push(`${at}.enabled is forbidden under mcp (use disabled: true)`)
    }
  }
  const scanMcp = (mcp: any, at: string) => {
    if (!mcp || typeof mcp !== "object" || Array.isArray(mcp)) return
    flag(mcp, at)
    const servers = (mcp as any).servers
    if (servers && typeof servers === "object" && !Array.isArray(servers)) {
      for (const [name, server] of Object.entries<any>(servers)) flag(server, `${at}.servers.${name}`)
      return
    }
    // V1 shape (servers live directly under mcp) must also be caught, otherwise
    // `enabled` flags would silently survive the migration.
    for (const [name, server] of Object.entries<any>(mcp)) {
      if (server && typeof server === "object" && !Array.isArray(server)) flag(server, `${at}.${name}`)
    }
  }

  if (existsSync(configPath)) {
    const config = readConfig()
    scanMcp(config.mcp, `${rel(configPath)}: mcp`)
  }

  for (const file of walkFiles(agentManagerDir)) {
    if (!file.endsWith(".json")) continue
    let parsed: any
    try {
      parsed = JSON.parse(read(file))
    } catch {
      continue
    }
    const findMcp = (node: any, at: string) => {
      if (!node || typeof node !== "object") return
      if (Array.isArray(node)) {
        node.forEach((child, index) => findMcp(child, `${at}[${index}]`))
        return
      }
      for (const [key, value] of Object.entries(node)) {
        if (key === "mcp") scanMcp(value, `${rel(file)}: ${at}.mcp`)
        else findMcp(value, `${at}.${key}`)
      }
    }
    findMcp(parsed, "")
  }
  return v
}

const checks: Array<[string, () => string[]]> = [
  ["agents", collectAgentViolations],
  ["commands", collectCommandViolations],
  ["config", collectConfigViolations],
  ["plugins", collectPluginsViolations],
  ["tools", collectToolsViolations],
  ["compat", collectCompatViolations],
  ["enabled-flags", collectEnabledFlagViolations],
]

function assertNoViolations(violations: string[]) {
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

test("tools: no legacy @opencode-ai/plugin and per-domain registries complete", () => {
  assertNoViolations(collectToolsViolations())
})

test("tools: legacy plugin import detection ignores comments and catches real imports", () => {
  assert.equal(importsLegacyPlugin("// legacy @opencode-ai/plugin adapter\n/** mentions @opencode-ai/plugin */\nexport const x = 1\n"), false)
  assert.equal(importsLegacyPlugin('import { tool } from "@opencode-ai/plugin"\n'), true)
  assert.equal(importsLegacyPlugin('import type { Tool } from "@opencode-ai/plugin"\n'), true)
  assert.equal(importsLegacyPlugin('export * from "@opencode-ai/plugin"\n'), true)
  assert.equal(importsLegacyPlugin('import "@opencode-ai/plugin"\n'), true)
  assert.equal(importsLegacyPlugin('const plugin = require("@opencode-ai/plugin")\n'), true)
})

test("v2Compat: MCP translation present and wired into production", () => {
  assertNoViolations(collectCompatViolations())
})

test("no MCP 'enabled' flags in config or .agent-manager", () => {
  assertNoViolations(collectEnabledFlagViolations())
})

test("summary: zero V2-native contract violations", () => {
  const all: string[] = []
  for (const [area, collect] of checks) {
    for (const line of collect()) all.push(`[${area}] ${line}`)
  }
  assert.equal(all.length, 0, `${all.length} V2-native contract violation(s):\n${all.map((line) => `- ${line}`).join("\n")}`)
})
