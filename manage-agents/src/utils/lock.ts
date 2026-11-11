import fs from "node:fs"
import path from "node:path"
import semver from "semver"
import { atomicWriteRestrictedFile, getExportDestination } from "./agents.js"
import { CONTRACT_VERSION, PACK_NAME_RE } from "./packs.js"
import { formatRequest, type Resolution } from "./resolver.js"

export interface LockedPack {
  source: string
  sourceKind: "local" | "git"
  path: string
  version: string
  revision: string | null
  manifestHash: string
  contentHash: string
  trusted: boolean
  requires: Record<string, string>
  executable: string[]
  executableHash: string
}

export interface PackLock {
  lockVersion: 1
  contract: string
  roots: string[]
  packs: Record<string, LockedPack>
}

export interface LockChange {
  name: string
  kind: "added" | "removed" | "upgrade" | "downgrade" | "source" | "revision" | "content"
  from?: string
  to?: string
}

export interface ExecutableChange {
  name: string
  added: string[]
  removed: string[]
  /** The code or the structured MCP/command config changed, even if the descriptions did not. */
  changed: boolean
}

/** Install target: an OpenCode config directory. Default: $XDG_CONFIG_HOME/opencode. */
export const defaultTarget = (env: NodeJS.ProcessEnv = process.env) => path.dirname(getExportDestination(env))

export const targetStateDir = (target: string) => path.join(target, ".manage-agents")
const lockPath = (target: string) => path.join(targetStateDir(target), "lock.json")

/** Only a resolution without problems can be locked. */
export function buildLock(resolution: Resolution): PackLock {
  if (resolution.problems.length) throw new Error(`cannot lock a failed resolution: ${resolution.problems[0]}`)
  const packs = Object.fromEntries([...resolution.packs].sort((a, b) => a.name.localeCompare(b.name)).map(pack => [pack.name, {
    source: pack.source,
    sourceKind: pack.sourceKind,
    path: pack.relativeDir,
    version: pack.version,
    revision: pack.revision,
    manifestHash: pack.manifestHash,
    contentHash: pack.contentHash,
    trusted: pack.trusted,
    requires: Object.fromEntries(Object.entries(pack.requires).sort()),
    executable: pack.executable,
    executableHash: pack.executableHash,
  } satisfies LockedPack]))
  return { lockVersion: 1, contract: `${CONTRACT_VERSION.major}.${CONTRACT_VERSION.minor}`, roots: resolution.roots.map(formatRequest).sort(), packs }
}

export const serializeLock = (lock: PackLock) => `${JSON.stringify(lock, null, 2)}\n`

const HASH_RE = /^[0-9a-f]{64}$/
const isStringMap = (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value) && Object.values(value).every(item => typeof item === "string")

function lockProblem(name: string, pack: any): string | null {
  if (!PACK_NAME_RE.test(name)) return "invalid pack name"
  if (typeof pack !== "object" || pack === null) return "not an object"
  if (!PACK_NAME_RE.test(pack.source) || (pack.sourceKind !== "local" && pack.sourceKind !== "git") || typeof pack.path !== "string") return "invalid source"
  if (typeof pack.version !== "string" || semver.valid(pack.version) !== pack.version) return "invalid version"
  if (pack.revision !== null && !/^[0-9a-f]{40,64}$/.test(pack.revision)) return "invalid revision"
  if (![pack.manifestHash, pack.contentHash, pack.executableHash].every(hash => typeof hash === "string" && HASH_RE.test(hash))) return "invalid hash"
  if (typeof pack.trusted !== "boolean" || !isStringMap(pack.requires) || !Array.isArray(pack.executable) || !pack.executable.every((item: unknown) => typeof item === "string")) return "invalid fields"
  return null
}

export function readLock(target: string): PackLock | null {
  const file = lockPath(target)
  if (!fs.existsSync(file)) return null
  const lock = JSON.parse(fs.readFileSync(file, "utf8"))
  if (lock?.lockVersion !== 1 || typeof lock.contract !== "string" || !Array.isArray(lock.roots) || !lock.roots.every((root: unknown) => typeof root === "string") || typeof lock.packs !== "object" || lock.packs === null) throw new Error(`${file}: unsupported lock file`)
  for (const [name, pack] of Object.entries(lock.packs)) {
    const problem = lockProblem(name, pack)
    if (problem) throw new Error(`${file}: pack "${name}": ${problem}`)
  }
  return lock
}

export function writeLock(target: string, lock: PackLock): void {
  atomicWriteRestrictedFile(lockPath(target), Buffer.from(serializeLock(lock)), 0o644)
}

export function diffLocks(previous: PackLock | null, next: PackLock): { changes: LockChange[]; executable: ExecutableChange[] } {
  const before = previous?.packs ?? {}
  const changes: LockChange[] = []
  const executable: ExecutableChange[] = []
  for (const name of [...new Set([...Object.keys(before), ...Object.keys(next.packs)])].sort()) {
    const old = before[name]
    const now = next.packs[name]
    if (!old) changes.push({ name, kind: "added", to: `${now.source}@${now.version}` })
    else if (!now) changes.push({ name, kind: "removed", from: `${old.source}@${old.version}` })
    else if (old.source !== now.source) changes.push({ name, kind: "source", from: old.source, to: now.source })
    else if (old.version !== now.version) changes.push({ name, kind: semver.gt(now.version, old.version) ? "upgrade" : "downgrade", from: old.version, to: now.version })
    else if (old.revision !== now.revision) changes.push({ name, kind: "revision", from: old.revision ?? "none", to: now.revision ?? "none" })
    else if (old.contentHash !== now.contentHash) changes.push({ name, kind: "content" })
    if (now && now.executableHash !== old?.executableHash && (now.executable.length || old?.executable.length)) {
      const was = new Set(old?.executable ?? [])
      const is = new Set(now.executable)
      executable.push({ name, added: now.executable.filter(item => !was.has(item)), removed: (old?.executable ?? []).filter(item => !is.has(item)), changed: true })
    }
  }
  return { changes, executable }
}

/** Packs whose executable content needs an explicit yes: new or changed packs from untrusted sources, or executable code that changed since the lock. */
export function confirmationsNeeded(next: PackLock, previous: PackLock | null): string[] {
  const reasons: string[] = []
  for (const [name, pack] of Object.entries(next.packs)) {
    const before = previous?.packs[name]
    const accepted = before !== undefined && before.trusted === pack.trusted && before.source === pack.source && before.executableHash === pack.executableHash
    if (!pack.trusted && pack.executable.length && !accepted) reasons.push(`${name}: source "${pack.source}" is not trusted and the pack carries executable content`)
  }
  for (const change of diffLocks(previous, next).executable) {
    if (change.added.length) reasons.push(`${change.name}: new executable surface: ${change.added.join("; ")}`)
    else if (next.packs[change.name].executable.length) reasons.push(`${change.name}: executable code changed in: ${next.packs[change.name].executable.join("; ")}`)
  }
  return reasons
}
