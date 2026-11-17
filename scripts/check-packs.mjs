import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { parse as parseYaml } from "yaml"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/
const BUILTIN_AGENTS = new Set(["build", "plan", "general", "explore"])
const EXTERNAL_MCP_SERVERS = new Set(["google-developer-knowledge"])
// These are OpenCode or pack tool namespaces, not MCP servers.
const NON_MCP_TOOL_PREFIXES = new Set(["opencode", "doc", "slide"])

const exists = (file) => fs.existsSync(file)
const isFile = (file) => exists(file) && fs.statSync(file).isFile()
const isDir = (file) => exists(file) && fs.statSync(file).isDirectory()
const relative = (root, file) => path.relative(root, file).split(path.sep).join("/")

function walkFiles(dir) {
  if (!isDir(dir)) return []
  const files = []
  for (const entry of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, entry)
    if (fs.statSync(full).isDirectory()) files.push(...walkFiles(full))
    else files.push(full)
  }
  return files
}

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

function packNames(root) {
  const packsDir = path.join(root, "packs")
  if (!isDir(packsDir)) return []
  return fs.readdirSync(packsDir).filter((name) => isFile(path.join(packsDir, name, "opencode-pack.json"))).sort()
}

function readFrontmatter(file) {
  const text = fs.readFileSync(file, "utf8")
  const match = FRONTMATTER_RE.exec(text)
  if (!match) return { body: text, frontmatter: null }
  try {
    const parsed = parseYaml(match[1])
    return {
      body: text.slice(match[0].length),
      frontmatter: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null,
    }
  } catch {
    return { body: text.slice(match[0].length), frontmatter: null }
  }
}

function parseManifest(root, name) {
  return JSON.parse(fs.readFileSync(path.join(root, "packs", name, "opencode-pack.json"), "utf8"))
}

function packData(root) {
  return packNames(root).map((name) => ({
    name,
    dir: path.join(root, "packs", name),
    manifest: parseManifest(root, name),
  }))
}

function directDependencies(pack) {
  const requires = pack.manifest?.requires
  return requires && typeof requires === "object" && !Array.isArray(requires) ? Object.keys(requires) : []
}

function visiblePacks(pack, packsByName) {
  return [pack.name, ...directDependencies(pack)].filter((name) => packsByName.has(name))
}

function isConcreteName(name) {
  return typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)
}

function agentFiles(pack) {
  return walkFiles(path.join(pack.dir, "agents")).filter((file) => file.endsWith(".md"))
}

function commandFiles(pack) {
  return walkFiles(path.join(pack.dir, "commands")).filter((file) => file.endsWith(".md"))
}

function agentTarget(root, packsByName, pack, name) {
  for (const owner of visiblePacks(pack, packsByName)) {
    const file = path.join(root, "packs", owner, "agents", `${name}.md`)
    if (isFile(file)) return { file }
  }
  if (BUILTIN_AGENTS.has(name)) return { file: null }
  return null
}

function skillTarget(root, packsByName, pack, name) {
  for (const owner of visiblePacks(pack, packsByName)) {
    const file = path.join(root, "packs", owner, "skills", name, "SKILL.md")
    if (isFile(file)) return file
  }
  return null
}

const SKILL_PLACEHOLDERS = new Set(["example", "id", "name", "placeholder", "skill", "skill-id", "skill-name", "skill_id", "skill_name", "your-skill"])

function isSkillPlaceholder(name) {
  return !isConcreteName(name) || SKILL_PLACEHOLDERS.has(name.toLowerCase())
}

function referencedSkills(body) {
  const found = new Set()
  const addReference = (name) => {
    if (!isSkillPlaceholder(name)) found.add(name)
  }
  const loadSkill = /\bload\s+(?:the\s+)?`([^`]+)`\s+skill\b/gi
  for (const match of body.matchAll(loadSkill)) addReference(match[1])

  let inSkillsTable = false
  for (const line of body.split(/\r?\n/)) {
    const heading = /^#{2,3}\s+(.+?)\s*#*\s*$/.exec(line)
    if (heading) {
      inSkillsTable = /^(?:Skills|Available Skills)$/i.test(heading[1])
      continue
    }
    if (!inSkillsTable) continue
    for (const cell of line.matchAll(/\|\s*`([^`]+)`\s*(?=\||$)/g)) addReference(cell[1])
  }
  return found
}

const ORCHESTRATOR_CORRUPTIONS = [
  /(?:docs|slides|wiki)-orchestrator-[A-Za-z0-9_-]+/g,
  /\bautodocs-orchestrator\b/g,
  /\.slides-orchestrator\b/g,
  /office\/(?:slides|docs)-orchestrator\b/g,
  /"(?:slides|docs)-orchestrator"\s*:/g,
  /\bdocs-orchestrator\s*:/g,
  /\bdocs-orchestrator\.description\b/g,
  /\b(?:\d+|two|three|four|five|six|many|multiple|all|adjacent|distinct|later|subsequent|new|restructured|cover|surface|agenda|pull-quote|editing|across|into|build|write|heavy|light|PPTX|HTML-based)\s+slides-orchestrator\b/gi,
]

function corruptionMatches(text) {
  const matches = new Set()
  for (const pattern of ORCHESTRATOR_CORRUPTIONS) {
    pattern.lastIndex = 0
    for (const match of text.matchAll(pattern)) matches.add(match[0])
  }
  return [...matches].sort()
}

function permissionRules(frontmatter) {
  return Array.isArray(frontmatter?.permissions)
    ? frontmatter.permissions.filter((rule) => rule && typeof rule === "object" && !Array.isArray(rule))
    : []
}

function isGlobMatch(pattern, value) {
  if (typeof pattern !== "string") return false
  const regex = pattern.split("").map((ch) => {
    if (ch === "*") return ".*"
    if (ch === "?") return "."
    return ch.replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
  }).join("")
  return new RegExp(`^${regex}$`).test(value)
}

function evaluatedEffect(rules, toolName) {
  let effect
  for (const rule of rules) {
    if (isGlobMatch(rule.action, toolName)) effect = rule.effect
  }
  return effect
}

function mcpServers(config) {
  const mcp = config?.mcp
  if (!mcp || typeof mcp !== "object" || Array.isArray(mcp)) return []
  const servers = mcp.servers && typeof mcp.servers === "object" && !Array.isArray(mcp.servers) ? mcp.servers : mcp
  return Object.keys(servers).filter((name) => name !== "servers")
}

function declaredServers(packs) {
  const byPack = new Map()
  const all = new Set()
  for (const pack of packs) {
    const configFile = path.join(pack.dir, "opencode.json")
    if (!isFile(configFile)) {
      byPack.set(pack.name, new Set())
      continue
    }
    try {
      const servers = new Set(mcpServers(parseJsonc(fs.readFileSync(configFile, "utf8"))))
      byPack.set(pack.name, servers)
      for (const server of servers) all.add(server)
    } catch {
      byPack.set(pack.name, new Set())
    }
  }
  return { byPack, all }
}

function visibleServers(pack, packsByName, serversByPack) {
  return new Set(visiblePacks(pack, packsByName).flatMap((name) => [...(serversByPack.get(name) ?? [])]))
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function explicitlyCallsServer(body, server) {
  if (body.includes(`\`${server}_`)) return true
  const words = server.replace(/[-_]+/g, " ")
  const escapedWords = escapeRegex(words)
  const namedMcp = new RegExp(`\\b(?:use|call|invoke|query|access|via|through|using)\\s+(?:the\\s+)?(?:\\\`${escapeRegex(server)}\\\`|${escapedWords})\\s+MCP\\b`, "i")
  return namedMcp.test(body)
}

function explicitlyUnavailable(body, server) {
  const mentions = [`\`${server}_`, server.replace(/[-_]+/g, " ")]
  const availability = /\b(?:unavailable|denied|not available|not in (?:the )?toolset|did not start|failed to start|offline|disabled|not configured)\b/i
  for (const line of body.split(/\r?\n/)) {
    if (mentions.some((mention) => new RegExp(escapeRegex(mention), "i").test(line)) && availability.test(line)) return true
  }
  return false
}

function error(pack, file, rule, message) {
  return { pack, file, rule, message }
}

export function checkPacks({ root = ROOT } = {}) {
  const absoluteRoot = path.resolve(root)
  const packs = packData(absoluteRoot)
  const packsByName = new Map(packs.map((pack) => [pack.name, pack]))
  const { byPack: serversByPack, all: allServers } = declaredServers(packs)
  const errors = []

  for (const pack of packs) {
    for (const file of commandFiles(pack)) {
      const { frontmatter } = readFrontmatter(file)
      const agent = frontmatter?.agent
      if (agent === undefined) continue
      if (typeof agent !== "string" || !isConcreteName(agent) || !agentTarget(absoluteRoot, packsByName, pack, agent)) {
        errors.push(error(pack.name, relative(absoluteRoot, file), "command-agent-resolution", `agent ${JSON.stringify(agent)} is not in this pack, a direct dependency, or the built-ins`))
      }
    }

    for (const file of walkFiles(pack.dir).filter((candidate) => candidate.endsWith(".md"))) {
      for (const corrupted of corruptionMatches(fs.readFileSync(file, "utf8"))) {
        errors.push(error(pack.name, relative(absoluteRoot, file), "orchestrator-corruption", `suspicious orchestrator text '${corrupted}'`))
      }
    }

    for (const file of agentFiles(pack)) {
      const { body, frontmatter } = readFrontmatter(file)
      const permissions = permissionRules(frontmatter)
      const sourceFile = relative(absoluteRoot, file)

      if (frontmatter?.mode === "subagent" && frontmatter.hidden === true) {
        errors.push(error(pack.name, sourceFile, "subagent-visibility-and-resolution", "subagent agents must not set hidden: true"))
      }

      for (const rule of permissions) {
        if (rule.action === "subagent" && rule.effect === "allow" && isConcreteName(rule.resource)) {
          const target = agentTarget(absoluteRoot, packsByName, pack, rule.resource)
          if (!target) {
            errors.push(error(pack.name, sourceFile, "subagent-visibility-and-resolution", `allowed subagent '${rule.resource}' is not in this pack, a direct dependency, or the built-ins`))
          } else if (target.file && readFrontmatter(target.file).frontmatter?.hidden === true) {
            errors.push(error(pack.name, sourceFile, "subagent-visibility-and-resolution", `allowed subagent '${rule.resource}' sets hidden: true`))
          }
        }

        if (rule.action === "skill" && rule.effect === "allow" && isConcreteName(rule.resource)) {
          if (!skillTarget(absoluteRoot, packsByName, pack, rule.resource)) {
            errors.push(error(pack.name, sourceFile, "skill-resolution", `allowed skill '${rule.resource}' is not in this pack or a direct dependency`))
          }
        }
      }

      for (const skill of referencedSkills(body)) {
        if (!skillTarget(absoluteRoot, packsByName, pack, skill)) {
          errors.push(error(pack.name, sourceFile, "skill-resolution", `referenced skill '${skill}' is not in this pack or a direct dependency`))
        }
      }

      for (const server of allServers) {
        if (explicitlyCallsServer(body, server) && evaluatedEffect(permissions, `${server}_probe`) === "deny" && !explicitlyUnavailable(body, server)) {
          errors.push(error(pack.name, sourceFile, "mcp-permission-alignment", `prompt calls '${server}' but permission rules deny '${server}_probe'`))
        }
      }

      const available = visibleServers(pack, packsByName, serversByPack)
      for (const rule of permissions) {
        if (rule.effect !== "allow" || typeof rule.action !== "string") continue
        const prefix = /^([A-Za-z0-9][A-Za-z0-9_-]*)_\*$/.exec(rule.action)?.[1]
        if (!prefix || available.has(prefix) || EXTERNAL_MCP_SERVERS.has(prefix) || NON_MCP_TOOL_PREFIXES.has(prefix)) continue
        errors.push(error(pack.name, sourceFile, "mcp-permission-alignment", `explicitly allows '${prefix}_*' but '${prefix}' is not declared in this pack or a direct dependency`))
      }
    }
  }

  const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
  errors.sort((a, b) => compare(a.file, b.file) || compare(a.rule, b.rule) || compare(a.message, b.message))
  return { ok: errors.length === 0, errors }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = checkPacks()
  if (result.errors.length) {
    for (const item of result.errors) console.error(`${item.file} [${item.rule}]: ${item.message}`)
    console.error(`check-packs: ${result.errors.length} error(s)`)
    process.exitCode = 1
  } else {
    console.log(`check-packs: ${packNames(ROOT).length} packs clean`)
  }
}
