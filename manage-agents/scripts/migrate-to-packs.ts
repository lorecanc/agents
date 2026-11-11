// One-off migration of the in-repo catalog (export/categories/<id>, built from src/ by the category manifests) into
// packs that satisfy the pack contract. Deleted together with the legacy category code at the repository split.
//
//   node --import tsx scripts/migrate-to-packs.ts propose [--out migration-map.json]
//   node --import tsx scripts/migrate-to-packs.ts apply <migration-map.json> [--out ../packs]
//
// propose groups every bundled file (and MCP server) by the set of bundles that ship it: a file in one bundle goes to
// that category's pack, a file in several bundles goes to a shared pack. The map is meant to be reviewed and edited
// (merge or rename shared packs, write descriptions) before apply, which is deterministic.

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { fileURLToPath } from "node:url"
import { PACK_NAME_RE, validatePack, type PackValidation } from "../src/utils/packs.js"

export interface MigrationMap {
  mapVersion: 1
  /** category id -> its pack; the category's pack requires every pack holding files of its bundle. */
  categories: Record<string, string>
  packs: Record<string, { description: string; version: string; archetype?: { callers: string[]; reference: string }; routingDefaults?: Record<string, Record<string, string>> }>
  /** bundle-relative path -> pack */
  files: Record<string, string>
  /** MCP server name -> pack */
  mcp: Record<string, string>
}

const NATIVE = new Set(["agents", "commands", "skills", "plugins", "themes"])
const SKIPPED = [/^CATEGORY\.json$/, /^PROVENANCE\.json$/, /^LICENSE$/, /^README\.md$/, /^opencode\.json$/, /^plugins\/agent-router\//, /^tools\/_agent_router\.js$/]
const CODE_RE = /\.(?:ts|mts|cts|js|mjs|cjs)$/
const IMPORT_SPEC_RE = /((?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'])(\.\.?\/[^"'\n]+)(["'])/g
// Reference agents of the archetypes the legacy engine hardcoded (agentRouting.ts ARCHETYPES).
const ARCHETYPE_REFERENCE: Record<string, string> = { flow: "flow-build", pipeline: "pipeline-orchestrator" }

const REPO = fileURLToPath(new URL("../../", import.meta.url))
const sha = (data: Buffer) => crypto.createHash("sha256").update(data).digest("hex")

function walk(root: string, dir = root, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(root, full, out)
    else out.push(path.relative(root, full).split(path.sep).join("/"))
  }
  return out.sort()
}

const categoryIds = (repo: string) => fs.readdirSync(path.join(repo, ".agent-manager", "categories")).filter(file => file.endsWith(".json")).map(file => file.slice(0, -5)).sort()
const bundleDir = (repo: string, id: string) => path.join(repo, "export", "categories", id)

/** Pack-relative destination: native paths stay, everything else moves under its pack's namespace. */
export function destination(rel: string, pack: string): string {
  const [top, ...rest] = rel.split("/")
  if (!rest.length) return rel === "AGENTS.md" ? rel : `resources/${pack}/${rel}`
  return NATIVE.has(top) ? rel : `${top}/${pack}/${rest.join("/")}`
}

export function propose(repo = REPO): MigrationMap {
  const items = new Map<string, { bundles: string[]; hash: string }>()
  const mcp = new Map<string, { bundles: string[]; value: unknown }>()
  const map: MigrationMap = { mapVersion: 1, categories: {}, packs: {}, files: {}, mcp: {} }
  const routing = JSON.parse(fs.readFileSync(path.join(repo, ".agent-manager", "agent-routing.json"), "utf8")).archetypes ?? {}
  for (const id of categoryIds(repo)) {
    const dir = bundleDir(repo, id)
    const category = JSON.parse(fs.readFileSync(path.join(dir, "CATEGORY.json"), "utf8"))
    map.categories[id] = id
    map.packs[id] = { description: String(category.description ?? `${id} agents`), version: "1.0.0" }
    for (const rel of walk(dir)) {
      if (SKIPPED.some(pattern => pattern.test(rel))) continue
      const hash = sha(fs.readFileSync(path.join(dir, rel)))
      const item = items.get(rel)
      if (!item) items.set(rel, { bundles: [id], hash })
      else if (item.hash !== hash) throw new Error(`${rel} differs between ${item.bundles.join(", ")} and ${id}; align the sources first`)
      else item.bundles.push(id)
    }
    const config = JSON.parse(fs.readFileSync(path.join(dir, "opencode.json"), "utf8"))
    for (const [name, value] of Object.entries(config.mcp?.servers ?? {})) {
      const server = mcp.get(name)
      if (!server) mcp.set(name, { bundles: [id], value })
      else if (!isDeepStrictEqual(server.value, value)) throw new Error(`MCP server ${name} differs between bundles`)
      else server.bundles.push(id)
    }
    const reference = ARCHETYPE_REFERENCE[id]
    if (reference) {
      const callers = walk(path.join(dir, "agents")).map(file => file.slice(0, -3)).filter(agent => /^mode:\s*primary\s*$/m.test(fs.readFileSync(path.join(dir, "agents", `${agent}.md`), "utf8")))
      const routingDefaults: Record<string, Record<string, string>> = {}
      for (const [trigger, roles] of Object.entries<Record<string, string>>(routing[id]?.configs ?? {})) {
        routingDefaults[trigger] = Object.fromEntries(Object.entries(roles).map(([role, model]) => [`${id}-${role}`, model]))
      }
      map.packs[id].archetype = { callers: [reference, ...callers.filter(caller => caller !== reference)], reference }
      if (Object.keys(routingDefaults).length) map.packs[id].routingDefaults = routingDefaults
    }
  }
  const sharedName = (bundles: string[]) => bundles.length === 1 ? bundles[0] : `shared-${bundles.join("-")}`
  for (const [rel, { bundles }] of items) {
    const pack = sharedName(bundles)
    map.files[rel] = pack
    map.packs[pack] ??= { description: `Shared by ${bundles.join(", ")}`, version: "1.0.0" }
  }
  // The legacy global export installs every canonical agent, command and skill, also those no category ships.
  for (const top of ["agents", "commands", "skills"]) {
    const dir = path.join(repo, "src", top)
    for (const rel of fs.existsSync(dir) ? walk(dir).map(file => `${top}/${file}`) : []) {
      if (items.has(rel) || /\.test\./.test(rel)) continue
      map.files[rel] = "general"
      map.packs.general ??= { description: "Standalone agents, commands and skills outside any workflow", version: "1.0.0" }
    }
  }
  for (const [name, { bundles }] of mcp) {
    map.mcp[name] = sharedName(bundles)
    map.packs[map.mcp[name]] ??= { description: `Shared by ${bundles.join(", ")}`, version: "1.0.0" }
  }
  map.files = Object.fromEntries(Object.entries(map.files).sort(([a], [b]) => a.localeCompare(b)))
  return map
}

/** New spelling of a relative import after both files moved; keeps a `.js` specifier for a `.ts` file. */
export function rewriteImport(fromOld: string, fromNew: string, spec: string, moved: Map<string, string>): { spec: string; target?: string } {
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fromOld), spec))
  const asTs = resolved.replace(/\.(m|c)?js$/, ".$1ts")
  const hit = moved.has(resolved) ? resolved : moved.has(asTs) ? asTs : null
  if (!hit) return { spec }
  let newTarget = moved.get(hit)!
  if (hit === asTs && hit !== resolved) newTarget = newTarget.replace(/\.(m|c)?ts$/, ".$1js")
  const relative = path.posix.relative(path.posix.dirname(fromNew), newTarget)
  return { spec: relative.startsWith(".") ? relative : `./${relative}`, target: hit }
}

export interface ApplyResult {
  packs: Record<string, { requires: string[]; validation: PackValidation }>
}

export function apply(map: MigrationMap, out: string, repo = REPO): ApplyResult {
  if (map.mapVersion !== 1) throw new Error("unsupported migration map")
  if (fs.existsSync(out) && fs.readdirSync(out).length) throw new Error(`${out} is not empty`)
  const ids = categoryIds(repo)
  const sourceOf = (rel: string) => {
    const id = ids.find(candidate => fs.existsSync(path.join(bundleDir(repo, candidate), rel)))
    return id ? path.join(bundleDir(repo, id), rel) : path.join(repo, "src", rel)
  }
  const moved = new Map<string, string>()
  for (const pack of [...Object.keys(map.packs), ...Object.values(map.categories), ...Object.values(map.mcp)]) {
    if (!PACK_NAME_RE.test(pack) || !map.packs[pack]) throw new Error(`invalid or undeclared pack "${pack}" in the map`)
  }
  for (const [rel, pack] of Object.entries(map.files)) {
    if (!map.packs[pack]) throw new Error(`${rel}: unknown pack "${pack}"`)
    if (path.posix.isAbsolute(rel) || rel.split("/").some(part => part === ".." || part === "." || part === "")) throw new Error(`${rel}: not a relative bundle path`)
    moved.set(rel, destination(rel, pack))
  }
  const requires = new Map<string, Set<string>>(Object.keys(map.packs).map(pack => [pack, new Set<string>()]))
  for (const id of ids) {
    const own = map.categories[id]
    for (const rel of walk(bundleDir(repo, id))) {
      const pack = map.files[rel]
      if (pack && pack !== own) requires.get(own)!.add(pack)
    }
    for (const name of Object.keys(JSON.parse(fs.readFileSync(path.join(bundleDir(repo, id), "opencode.json"), "utf8")).mcp?.servers ?? {})) {
      if (map.mcp[name] !== own) requires.get(own)!.add(map.mcp[name])
    }
  }
  for (const [rel, pack] of Object.entries(map.files)) {
    const dest = moved.get(rel)!
    const file = path.join(out, pack, ...dest.split("/"))
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const source = sourceOf(rel)
    if (CODE_RE.test(rel) && (rel.startsWith("plugins/") || rel.startsWith("tools/"))) {
      const text = fs.readFileSync(source, "utf8").replace(IMPORT_SPEC_RE, (whole, before, spec, after) => {
        const rewritten = rewriteImport(rel, dest, spec, moved)
        if (rewritten.target && map.files[rewritten.target] !== pack) requires.get(pack)!.add(map.files[rewritten.target])
        return `${before}${rewritten.spec}${after}`
      })
      fs.writeFileSync(file, text)
    } else fs.copyFileSync(source, file)
    fs.chmodSync(file, fs.statSync(source).mode & 0o777)
  }
  const bundleServers: Record<string, unknown> = {}
  for (const id of ids) Object.assign(bundleServers, JSON.parse(fs.readFileSync(path.join(bundleDir(repo, id), "opencode.json"), "utf8")).mcp?.servers ?? {})
  for (const [pack, meta] of Object.entries(map.packs)) {
    const dir = path.join(out, pack)
    fs.mkdirSync(dir, { recursive: true })
    const packRequires = Object.fromEntries([...requires.get(pack)!].sort().map(name => [name, `^${map.packs[name].version}`]))
    fs.writeFileSync(path.join(dir, "opencode-pack.json"), `${JSON.stringify({ contract: "1.0", name: pack, version: meta.version, description: meta.description, ...(Object.keys(packRequires).length ? { requires: packRequires } : {}), ...(meta.archetype ? { archetype: meta.archetype } : {}), ...(meta.routingDefaults ? { routingDefaults: meta.routingDefaults } : {}) }, null, 2)}\n`)
    const servers = Object.entries(map.mcp).filter(([, owner]) => owner === pack).map(([name]) => name).sort()
    if (servers.length) fs.writeFileSync(path.join(dir, "opencode.json"), `${JSON.stringify({ $schema: "https://opencode.ai/config.json", mcp: { servers: Object.fromEntries(servers.map(name => [name, bundleServers[name]])) } }, null, 2)}\n`)
  }
  const result: ApplyResult = { packs: {} }
  for (const pack of Object.keys(map.packs).sort()) result.packs[pack] = { requires: [...requires.get(pack)!].sort(), validation: validatePack(path.join(out, pack)) }
  return result
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2)
  const option = (name: string, fallback: string) => {
    const index = args.indexOf(name)
    return index === -1 ? fallback : args[index + 1]
  }
  if (command === "propose") {
    const out = path.resolve(option("--out", "migration-map.json"))
    fs.writeFileSync(out, `${JSON.stringify(propose(), null, 2)}\n`)
    console.log(`wrote ${out}`)
  } else if (command === "apply" && args[0]) {
    const result = apply(JSON.parse(fs.readFileSync(args[0], "utf8")), path.resolve(option("--out", path.join(REPO, "packs"))))
    let errors = 0
    for (const [pack, { requires, validation }] of Object.entries(result.packs)) {
      const issues = validation.issues.map(issue => `    ${issue.level} [${issue.code}] ${issue.path ?? ""}: ${issue.message}`)
      errors += validation.issues.filter(issue => issue.level === "error").length
      console.log(`${pack}: ${validation.files.length} files, requires ${requires.join(", ") || "nothing"}${issues.length ? `\n${issues.join("\n")}` : ""}`)
    }
    process.exitCode = errors ? 1 : 0
  } else {
    console.error("usage: migrate-to-packs.ts propose [--out map.json] | apply <map.json> [--out dir]")
    process.exitCode = 2
  }
}
