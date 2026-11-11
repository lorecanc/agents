import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import semver from "semver"
import { installableFiles, MANIFEST_FILE, PACK_NAME_RE, validatePack, type PackValidation, type UnresolvedReference } from "./packs.js"
import type { PackCandidate } from "./sources.js"

export interface PackRequest {
  name: string
  source?: string
  range?: string
}

export interface ResolvedPack {
  name: string
  version: string
  source: string
  sourceKind: PackCandidate["sourceKind"]
  trusted: boolean
  dir: string
  relativeDir: string
  revision: string | null
  manifestHash: string
  contentHash: string
  requires: Record<string, string>
  root: boolean
  requiredBy: string[]
  /** Sorted one-line descriptions of the executable surface ("plugin x", "mcp db: db-mcp --ro", ...), for display. */
  executable: string[]
  /** Hash of the executable code (plugin, tool and skill-script bytes) and of the structured MCP and command config. */
  executableHash: string
  validation: PackValidation
}

export interface Resolution {
  roots: PackRequest[]
  /** Dependencies first, then alphabetical: the install order. */
  packs: ResolvedPack[]
  problems: string[]
  warnings: string[]
}

export interface ResolveOptions {
  prefer?: Record<string, string>
  /** Checked-out commit of a git source; asked only for the sources of selected packs. */
  revisionOf?: (source: string) => string | null
  /** Packs kept at their locked source and version (install and partial update never move them). */
  pins?: Record<string, { source: string; version: string }>
}

/** "[source/]name[@range]" */
export function parsePackRequest(spec: string): PackRequest {
  const match = /^(?:([a-z0-9-]+)\/)?([a-z0-9-]+)(?:@(.+))?$/.exec(spec)
  if (!match || !PACK_NAME_RE.test(match[2]) || (match[1] && !PACK_NAME_RE.test(match[1]))) throw new Error(`invalid pack request "${spec}": use [source/]name[@range]`)
  if (match[3] !== undefined && semver.validRange(match[3]) === null) throw new Error(`invalid version range in "${spec}"`)
  return { name: match[2], ...(match[1] ? { source: match[1] } : {}), ...(match[3] ? { range: match[3] } : {}) }
}

export const formatRequest = (request: PackRequest) => `${request.source ? `${request.source}/` : ""}${request.name}${request.range ? `@${request.range}` : ""}`

/** Streams the file so a large pack file is never held in memory. */
export function hashFile(file: string): string {
  const hash = crypto.createHash("sha256")
  const buffer = Buffer.allocUnsafe(1 << 16)
  const fd = fs.openSync(file, "r")
  try {
    for (let read; (read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0;) hash.update(buffer.subarray(0, read))
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest("hex")
}

const combineHashes = (fileHashes: Record<string, string>, extra = "") => {
  const hash = crypto.createHash("sha256").update(extra)
  for (const file of Object.keys(fileHashes).sort()) hash.update(`${file}\0${fileHashes[file]}\0`)
  return hash.digest("hex")
}

const hashFileMap = (root: string, files: string[]) => Object.fromEntries(files.map(file => [file, hashFile(path.join(root, file))]))

/**
 * Hashes of one byte snapshot of the pack: per installable file, combined (the lock's contentHash), and of the
 * executable code plus the structured MCP and command config (the lock's executableHash).
 */
export function packContent(validation: PackValidation): { fileHashes: Record<string, string>; contentHash: string; executableHash: string } {
  const fileHashes = hashFileMap(validation.root, installableFiles(validation))
  const { executable } = validation
  const code = Object.fromEntries(Object.entries(fileHashes).filter(([file]) => file.startsWith("plugins/") || executable.toolModules.includes(file) || executable.skillScripts.includes(file)))
  return {
    fileHashes,
    contentHash: combineHashes(fileHashes),
    executableHash: combineHashes(code, JSON.stringify({ packages: executable.pluginPackages, mcp: executable.mcpServers, commands: executable.externalCommands })),
  }
}

export function describeExecutable(validation: PackValidation): string[] {
  const { executable } = validation
  return [
    ...executable.plugins.map(id => `plugin ${id}`),
    ...executable.pluginPackages.map(spec => `plugin package ${spec}`),
    ...executable.toolModules.map(file => `tool module ${file}`),
    ...executable.skillScripts.map(file => `skill script ${file}`),
    ...executable.mcpServers.map(server => `mcp ${server.name}: ${server.command?.join(" ") ?? server.url ?? server.type}`),
    ...executable.externalCommands.map(command => `external command ${command}`),
  ].sort()
}

function providesTarget(validation: PackValidation, ref: UnresolvedReference): boolean {
  const { target } = ref
  if (ref.kind === "plugin") return validation.ids.plugins.includes(target.slice("plugins/".length))
  if (validation.files.includes(target)) return true
  if (ref.kind === "import") return /\.(?:m|c)?js$/.test(target) && validation.files.includes(target.replace(/\.(m|c)?js$/, ".$1ts"))
  return (ref.kind === "skill" || ref.kind === "instruction") && validation.files.some(file => file.startsWith(`${target}/`))
}

interface Constraint {
  sources: Set<string>
  ranges: Array<{ range: string; by: string }>
  root: boolean
}

function constraintsFor(roots: PackRequest[], selected: Map<string, PackCandidate>): Map<string, Constraint> {
  const constraints = new Map<string, Constraint>()
  const get = (name: string) => {
    if (!constraints.has(name)) constraints.set(name, { sources: new Set(), ranges: [], root: false })
    return constraints.get(name)!
  }
  for (const request of roots) {
    const constraint = get(request.name)
    constraint.root = true
    if (request.source) constraint.sources.add(request.source)
    if (request.range) constraint.ranges.push({ range: request.range, by: "request" })
  }
  for (const candidate of selected.values()) {
    for (const [dependency, range] of Object.entries(candidate.manifest.requires)) get(dependency).ranges.push({ range, by: candidate.manifest.name })
  }
  return constraints
}

const constraintKey = (constraints: Map<string, Constraint>) =>
  JSON.stringify([...constraints.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, c]) => [name, [...c.sources].sort(), c.ranges.map(r => `${r.by}:${r.range}`).sort()]))

function choose(name: string, constraint: Constraint, candidates: PackCandidate[], prefer: Record<string, string>, pin?: { source: string; version: string }): PackCandidate | string {
  let pool = candidates.filter(candidate => candidate.manifest.name === name)
  if (!pool.length) return `pack "${name}" is not offered by any source${constraint.ranges.length ? ` (required by ${constraint.ranges.map(r => r.by).join(", ")})` : ""}`
  if (constraint.sources.size > 1) return `pack "${name}" is requested from several sources (${[...constraint.sources].sort().join(", ")}); a pack name can come from only one`
  const pinnedSource = [...constraint.sources][0] ?? pin?.source ?? prefer[name]
  if (pinnedSource) {
    pool = pool.filter(candidate => candidate.source === pinnedSource)
    if (!pool.length) return `pack "${name}" is not offered by source "${pinnedSource}"`
  }
  if (pin && !constraint.sources.size) {
    const locked = pool.filter(candidate => candidate.manifest.version === pin.version && constraint.ranges.every(({ range }) => semver.satisfies(pin.version, range)))
    if (!locked.length) return `pack "${name}" is locked at ${pin.source}@${pin.version}, which is no longer offered or does not satisfy ${constraint.ranges.map(r => `${r.range} (${r.by})`).join(" and ") || "the request"}; run \`manage-agents update ${name}\``
    pool = locked
  }
  const satisfying = pool.filter(candidate => constraint.ranges.every(({ range }) => semver.satisfies(candidate.manifest.version, range)))
  const describe = (list: PackCandidate[]) => [...list].sort((a, b) => a.source.localeCompare(b.source) || semver.compare(a.manifest.version, b.manifest.version)).map(candidate => `${candidate.source}/${name}@${candidate.manifest.version} (${candidate.relativeDir})`).join(", ")
  if (!satisfying.length) return `no version of "${name}" satisfies ${constraint.ranges.map(r => `${r.range} (${r.by})`).join(" and ")}; available: ${describe(pool)}`
  if (satisfying.length > 1) {
    const sources = [...new Set(satisfying.map(candidate => candidate.source))].sort()
    const hint = sources.length > 1 ? `request ${sources.map(source => `${source}/${name}`).join(" or ")}, or run \`manage-agents source prefer ${name} <source>\`` : "narrow the version range"
    return `pack "${name}" is ambiguous: ${describe(satisfying)}; ${hint}`
  }
  return satisfying[0]
}

/** Picks exactly one candidate per pack name; never chooses between equal candidates on its own. Writes nothing. */
export function resolvePacks(roots: PackRequest[], candidates: PackCandidate[], options: ResolveOptions = {}): Resolution {
  const prefer = options.prefer ?? {}
  const problems: string[] = []
  const warnings: string[] = []
  let selected = new Map<string, PackCandidate>()
  let constraints = constraintsFor(roots, selected)
  // Each round can only add packs reachable through requires, so the fixpoint comes within one round per offered pack.
  const maxRounds = new Set(candidates.map(candidate => candidate.manifest.name)).size + roots.length + 2
  for (let round = 0; ; round++) {
    if (round === maxRounds) return { roots, packs: [], problems: ["dependency resolution does not converge"], warnings }
    const next = new Map<string, PackCandidate>()
    const roundProblems: string[] = []
    for (const [name, constraint] of [...constraints.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const choice = choose(name, constraint, candidates, prefer, options.pins?.[name])
      if (typeof choice === "string") roundProblems.push(choice)
      else next.set(name, choice)
    }
    const nextConstraints = constraintsFor(roots, next)
    selected = next
    if (constraintKey(nextConstraints) === constraintKey(constraints)) {
      problems.push(...roundProblems)
      break
    }
    constraints = nextConstraints
  }

  const cycle = findCycle(selected)
  if (cycle) problems.push(`dependency cycle: ${cycle.join(" -> ")}`)

  const resolved = new Map<string, ResolvedPack>()
  for (const [name, candidate] of selected) {
    const validation = validatePack(candidate.dir, { sourceKind: candidate.sourceKind })
    const errors = validation.issues.filter(issue => issue.level === "error")
    for (const issue of errors) problems.push(`${candidate.source}/${name}: [${issue.code}]${issue.path ? ` ${issue.path}` : ""}: ${issue.message}`)
    const constraint = constraints.get(name)!
    // An invalid pack is never installed, so its files are not read for hashing.
    const hashes = errors.length === 0 ? packContent(validation) : { contentHash: "", executableHash: "" }
    resolved.set(name, {
      name,
      version: candidate.manifest.version,
      source: candidate.source,
      sourceKind: candidate.sourceKind,
      trusted: candidate.trusted,
      dir: candidate.dir,
      relativeDir: candidate.relativeDir,
      revision: candidate.sourceKind === "git" ? options.revisionOf?.(candidate.source) ?? null : null,
      manifestHash: hashFile(path.join(candidate.dir, MANIFEST_FILE)),
      contentHash: hashes.contentHash,
      requires: candidate.manifest.requires,
      root: constraint.root,
      requiredBy: [...new Set(constraint.ranges.map(r => r.by).filter(by => by !== "request"))].sort(),
      executable: describeExecutable(validation),
      executableHash: hashes.executableHash,
      validation,
    })
  }

  for (const pack of resolved.values()) {
    for (const ref of pack.validation.unresolved) {
      const providers = Object.keys(pack.requires).map(name => resolved.get(name)).filter(Boolean) as ResolvedPack[]
      if (!providers.some(provider => providesTarget(provider.validation, ref))) problems.push(`${pack.name}: ${ref.from} references ${ref.kind} "${ref.target}", which no required pack (${Object.keys(pack.requires).join(", ")}) provides`)
    }
    if (pack.sourceKind === "local" && Object.values(pack.requires).some(range => range.trim() === "*")) warnings.push(`${pack.name}: "*" in requires accepts any version; pin a range before publishing`)
  }

  return { roots, packs: cycle ? [...resolved.values()] : topologicalOrder(resolved), problems: [...new Set(problems)], warnings }
}

function findCycle(selected: Map<string, PackCandidate>): string[] | null {
  const state = new Map<string, "visiting" | "done">()
  const stack: string[] = []
  const visit = (name: string): string[] | null => {
    if (state.get(name) === "done" || !selected.has(name)) return null
    if (state.get(name) === "visiting") return [...stack.slice(stack.indexOf(name)), name]
    state.set(name, "visiting")
    stack.push(name)
    for (const dependency of Object.keys(selected.get(name)!.manifest.requires).sort()) {
      const cycle = visit(dependency)
      if (cycle) return cycle
    }
    stack.pop()
    state.set(name, "done")
    return null
  }
  for (const name of [...selected.keys()].sort()) {
    const cycle = visit(name)
    if (cycle) return cycle
  }
  return null
}

function topologicalOrder(resolved: Map<string, ResolvedPack>): ResolvedPack[] {
  return orderByRequires([...resolved.keys()], name => Object.keys(resolved.get(name)!.requires)).map(name => resolved.get(name)!)
}

/** Dependencies first, ties alphabetical: the deterministic install order. Unknown dependencies are skipped. */
export function orderByRequires(names: string[], requiresOf: (name: string) => string[]): string[] {
  const known = new Set(names)
  const ordered: string[] = []
  const done = new Set<string>()
  const visit = (name: string) => {
    if (done.has(name) || !known.has(name)) return
    done.add(name)
    for (const dependency of [...requiresOf(name)].sort()) visit(dependency)
    ordered.push(name)
  }
  for (const name of [...names].sort()) visit(name)
  return ordered
}
