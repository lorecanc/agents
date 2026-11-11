import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { atomicWriteRestrictedFile } from "./agents.js"
import { MANIFEST_FILE, PACK_NAME_RE, readPackManifest, type PackManifest } from "./packs.js"
import { cleanGitEnvironment } from "./repositoryTransaction.js"

export type Source =
  | { name: string; kind: "local"; path: string; trusted: boolean }
  | { name: string; kind: "git"; url: string; ref?: string; trusted: boolean }

export interface SourceRegistry {
  schemaVersion: 1
  sources: Source[]
  /** pack name -> source name, used when several sources offer the same pack. */
  prefer: Record<string, string>
}

export interface PackCandidate {
  source: string
  sourceKind: Source["kind"]
  trusted: boolean
  dir: string
  /** Pack directory relative to the source root, POSIX separators. */
  relativeDir: string
  manifest: PackManifest
}

export interface GitOptions {
  /** file: URLs and local paths are accepted only by tests (bare repositories on disk). */
  allowFileUrls?: boolean
}

const GIT_URL_RE = /^(?:https:\/\/[^\s]+|ssh:\/\/[^\s]+|[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s-][^\s]*)$/
const GIT_REF_RE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]+$/
const DISCOVERY_DEPTH = 4
const SKIPPED_DIRS = new Set([".git", "node_modules"])

export function engineConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "manage-agents")
}

export function engineCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "manage-agents")
}

const registryPath = (env: NodeJS.ProcessEnv) => path.join(engineConfigDir(env), "sources.json")

export function loadSources(env: NodeJS.ProcessEnv = process.env): SourceRegistry {
  const file = registryPath(env)
  if (!fs.existsSync(file)) return { schemaVersion: 1, sources: [], prefer: {} }
  const raw = JSON.parse(fs.readFileSync(file, "utf8"))
  if (raw?.schemaVersion !== 1 || !Array.isArray(raw.sources)) throw new Error(`${file}: unsupported sources registry`)
  const names = new Set<string>()
  for (const source of raw.sources) {
    const valid = typeof source === "object" && source !== null && PACK_NAME_RE.test(source.name) && !names.has(source.name) && typeof source.trusted === "boolean" && (
      source.kind === "local" ? typeof source.path === "string" && path.isAbsolute(source.path)
        : source.kind === "git" && typeof source.url === "string" && (source.ref === undefined || GIT_REF_RE.test(source.ref)))
    if (!valid) throw new Error(`${file}: invalid source entry ${JSON.stringify(source?.name ?? null)}`)
    names.add(source.name)
  }
  const prefer = raw.prefer ?? {}
  if (typeof prefer !== "object" || Array.isArray(prefer) || !Object.entries(prefer).every(([pack, source]) => PACK_NAME_RE.test(pack) && names.has(source as string))) throw new Error(`${file}: invalid "prefer" map`)
  return { schemaVersion: 1, sources: raw.sources, prefer }
}

export function saveSources(registry: SourceRegistry, env: NodeJS.ProcessEnv = process.env): void {
  const sorted = { schemaVersion: 1, sources: [...registry.sources].sort((a, b) => a.name.localeCompare(b.name)), prefer: Object.fromEntries(Object.entries(registry.prefer).sort()) }
  atomicWriteRestrictedFile(registryPath(env), Buffer.from(`${JSON.stringify(sorted, null, 2)}\n`))
}

function isGitLocation(location: string, options: GitOptions): boolean {
  if (location.startsWith("file:")) return options.allowFileUrls === true
  return GIT_URL_RE.test(location)
}

/** Credentials in a URL would be stored in sources.json and printed by `source list`; use a git credential helper instead. */
const hasUrlCredentials = (location: string) => /^https:\/\/[^/]*@/.test(location) || /^ssh:\/\/[^/@]*:[^/@]*@/.test(location)

/** Adds a source; `location` is a directory or a git URL (https:, ssh:, git@host:path). */
export function addSource(registry: SourceRegistry, name: string, location: string, settings: { ref?: string; trusted?: boolean } = {}, options: GitOptions = {}): Source {
  if (!PACK_NAME_RE.test(name)) throw new Error(`invalid source name "${name}": use lowercase letters, digits and hyphens`)
  if (registry.sources.some(source => source.name === name)) throw new Error(`source "${name}" already exists`)
  if (settings.ref !== undefined && !GIT_REF_RE.test(settings.ref)) throw new Error(`invalid git ref "${settings.ref}"`)
  let source: Source
  if (isGitLocation(location, options)) {
    if (hasUrlCredentials(location)) throw new Error("credentials in source URLs are not stored: configure a git credential helper or an SSH key instead")
    source = { name, kind: "git", url: location, ...(settings.ref ? { ref: settings.ref } : {}), trusted: settings.trusted === true }
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(location) && !path.win32.isAbsolute(location)) {
    throw new Error(`unsupported source URL "${location}": use https:, ssh: or git@host:path`)
  } else {
    const dir = path.resolve(location)
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`${dir} is not a directory`)
    if (settings.ref !== undefined) throw new Error("--ref applies only to git sources")
    source = { name, kind: "local", path: fs.realpathSync(dir), trusted: settings.trusted === true }
  }
  registry.sources.push(source)
  return source
}

export function removeSource(registry: SourceRegistry, name: string): void {
  const index = registry.sources.findIndex(source => source.name === name)
  if (index === -1) throw new Error(`unknown source "${name}"`)
  registry.sources.splice(index, 1)
  for (const [pack, preferred] of Object.entries(registry.prefer)) if (preferred === name) delete registry.prefer[pack]
}

export function findSource(registry: SourceRegistry, name: string): Source {
  const source = registry.sources.find(candidate => candidate.name === name)
  if (!source) throw new Error(`unknown source "${name}"`)
  return source
}

export function sourceRoot(source: Source, env: NodeJS.ProcessEnv = process.env): string {
  return source.kind === "local" ? source.path : path.join(engineCacheDir(env), "sources", source.name)
}

function git(args: string[], cwd?: string) {
  const result = spawnSync("git", cwd ? ["-C", cwd, ...args] : args, { encoding: "utf8", env: cleanGitEnvironment({ GIT_TERMINAL_PROMPT: "0" }), stdio: ["ignore", "pipe", "pipe"] })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${(result.stderr || "").trim().split("\n").slice(-1)[0] || `exit ${result.status}`}`)
  return result.stdout.trim()
}

/** Clones or fetches a git source into the cache and checks out its ref (default: the remote HEAD). Returns the commit. */
export function pullSource(source: Source, env: NodeJS.ProcessEnv = process.env, options: GitOptions = {}): string | null {
  if (source.kind === "local") return null
  if (!isGitLocation(source.url, options)) throw new Error(`source "${source.name}": refusing git URL "${source.url}"`)
  const dir = sourceRoot(source, env)
  const protocol = options.allowFileUrls ? [] : ["-c", "protocol.file.allow=never"]
  if (!fs.existsSync(path.join(dir, ".git"))) {
    fs.mkdirSync(path.dirname(dir), { recursive: true })
    git([...protocol, "clone", "--quiet", "--no-checkout", "--", source.url, dir])
  } else {
    // The cache may predate a remove + re-add of the same name with another URL.
    git(["remote", "set-url", "origin", source.url], dir)
    git([...protocol, "fetch", "--quiet", "--force", "--tags", "--prune", "origin"], dir)
  }
  const commit = fetchedRevision(source, dir)
  if (!commit) throw new Error(`source "${source.name}": ref "${source.ref ?? "HEAD"}" not found`)
  git(["checkout", "--quiet", "--force", "--detach", commit], dir)
  return commit
}

/** Commit the source's ref points to after the last fetch (no network). */
function fetchedRevision(source: Source & { kind: "git" }, dir: string): string | undefined {
  const ref = source.ref
  const candidates = ref ? [`refs/remotes/origin/${ref}`, `refs/tags/${ref}`, ref] : ["refs/remotes/origin/HEAD"]
  return candidates.map(candidate => {
    try {
      return git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${candidate}^{commit}`], dir)
    } catch {
      return ""
    }
  }).find(Boolean)
}

/** The ref's commit as of the last `source pull`, without fetching; null for local or never-pulled sources. */
export function lastFetchedRevision(source: Source, env: NodeJS.ProcessEnv = process.env): string | null {
  if (source.kind === "local") return null
  const dir = sourceRoot(source, env)
  return fs.existsSync(path.join(dir, ".git")) ? fetchedRevision(source, dir) ?? null : null
}

/** Commit checked out for a git source, or null for local sources and sources never pulled. */
export function sourceRevision(source: Source, env: NodeJS.ProcessEnv = process.env): string | null {
  if (source.kind === "local") return null
  const dir = sourceRoot(source, env)
  if (!fs.existsSync(path.join(dir, ".git"))) return null
  return git(["rev-parse", "HEAD"], dir)
}

/** Read-only checkout of one commit of a git source, created once and reused: reconcile installs exactly the locked revision. */
export function revisionSnapshot(source: Source, revision: string, env: NodeJS.ProcessEnv = process.env): string {
  if (source.kind !== "git") throw new Error(`source "${source.name}" is not a git source`)
  if (!/^[0-9a-f]{40,64}$/.test(revision)) throw new Error(`invalid revision "${revision}"`)
  const dir = path.join(engineCacheDir(env), "revisions", source.name, revision)
  if (fs.existsSync(path.join(dir, ".git"))) return dir
  const repo = sourceRoot(source, env)
  if (!fs.existsSync(path.join(repo, ".git"))) throw new Error(`source "${source.name}" has not been pulled yet: run \`manage-agents source pull ${source.name}\``)
  fs.mkdirSync(path.dirname(dir), { recursive: true })
  const temporary = `${dir}.tmp-${process.pid}-${Date.now()}`
  try {
    git(["clone", "--quiet", "--shared", "--no-checkout", "--", repo, temporary])
    git(["checkout", "--quiet", "--force", "--detach", revision], temporary)
    fs.renameSync(temporary, dir)
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true })
    if (!fs.existsSync(path.join(dir, ".git"))) throw new Error(`source "${source.name}": revision ${revision.slice(0, 12)} is not available; run \`manage-agents source pull ${source.name}\` (${(error as Error).message})`)
  }
  return dir
}

/** Packs inside a source: directories with opencode-pack.json, not nested in another pack. */
export function discoverPacks(source: Source, env: NodeJS.ProcessEnv = process.env): { candidates: PackCandidate[]; problems: string[] } {
  const root = sourceRoot(source, env)
  const candidates: PackCandidate[] = []
  const problems: string[] = []
  if (!fs.existsSync(root)) {
    problems.push(source.kind === "git" ? `source "${source.name}" has not been pulled yet: run \`manage-agents source pull ${source.name}\`` : `source "${source.name}": ${root} does not exist`)
    return { candidates, problems }
  }
  const visit = (dir: string, depth: number) => {
    if (fs.existsSync(path.join(dir, MANIFEST_FILE))) {
      const { manifest, issues } = readPackManifest(dir, { sourceKind: source.kind })
      const relativeDir = path.relative(root, dir).split(path.sep).join("/") || "."
      if (manifest) candidates.push({ source: source.name, sourceKind: source.kind, trusted: source.trusted, dir, relativeDir, manifest })
      else problems.push(`${source.name}:${relativeDir}: ${issues.filter(issue => issue.level === "error").map(issue => issue.message).join("; ")}`)
      return
    }
    if (depth >= DISCOVERY_DEPTH) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory() && !SKIPPED_DIRS.has(entry.name)) visit(path.join(dir, entry.name), depth + 1)
    }
  }
  visit(root, 0)
  return { candidates, problems }
}

export function discoverAllPacks(registry: SourceRegistry, env: NodeJS.ProcessEnv = process.env): { candidates: PackCandidate[]; problems: string[] } {
  const results = registry.sources.map(source => discoverPacks(source, env))
  return { candidates: results.flatMap(result => result.candidates), problems: results.flatMap(result => result.problems) }
}
