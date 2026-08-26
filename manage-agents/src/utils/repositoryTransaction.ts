import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"

export const AUTO_COMMIT_MESSAGES = {
  create: "chore(agent-manager): create agent",
  import: "chore(agent-manager): import agents",
  rename: "chore(agent-manager): fix names/rename agents",
  tune: "chore(agent-manager): update/tune agents",
  organize: "chore(agent-manager): organize agents",
  fork: "chore(agent-manager): fork agent category",
  bridge: "chore(agent-manager): generate bridge",
  config: "chore(agent-manager): save/migrate translation config",
} as const

export class RepositoryTransactionError extends Error {}
export interface RepositoryTransactionPlan { localPaths: string[]; externalPaths?: string[] }
export interface RepositoryTransactionOptions {}
type LockIdentity = { dev: number; ino: number }

const dangerousGitVariables = /^(?:GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES|GIT_COMMON_DIR|GIT_NAMESPACE|GIT_CEILING_DIRECTORIES|GIT_DISCOVERY_ACROSS_FILESYSTEM|GIT_OPTIONAL_LOCKS)$/i

function cleanGitEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!dangerousGitVariables.test(key) && !/^GIT_CONFIG(?:_|$)/i.test(key)) safe[key] = value
  }
  Object.assign(safe, overrides)
  return safe
}

function git(root: string, args: string[], overrides: NodeJS.ProcessEnv = {}, input?: Buffer) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", env: cleanGitEnvironment(overrides), input })
  if (result.error) throw result.error
  return result
}

function gitRoot(start: string): string {
  const result = spawnSync("git", ["-C", start, "rev-parse", "--show-toplevel"], { encoding: "utf8", env: cleanGitEnvironment() })
  if (result.error) throw result.error
  if (result.status !== 0) throw new RepositoryTransactionError("Auto-commit requires a Git repository.")
  return fs.realpathSync(result.stdout.trim())
}

type StatusEntry = { xy: string; path: string; category: "staged" | "unstaged" | "staged+unstaged" | "untracked"; renamePeer?: string }
function status(root: string): StatusEntry[] {
  const result = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { GIT_OPTIONAL_LOCKS: "0" })
  if (result.status !== 0) throw new RepositoryTransactionError(result.stderr.trim() || "Unable to inspect Git status.")
  const fields = result.stdout.split("\0")
  const entries: StatusEntry[] = []
  for (let i = 0; i < fields.length; i++) {
    const raw = fields[i]
    if (!raw) continue
    const xy = raw.slice(0, 2)
    const filePath = raw.slice(3)
    const entry = { xy, path: filePath, category: xy === "??" ? "untracked" : xy[0] !== " " && xy[1] !== " " ? "staged+unstaged" : xy[0] !== " " ? "staged" : "unstaged" } as StatusEntry
    entries.push(entry)
    if (/^[RC][RC ]/.test(raw)) {
      const source = fields[++i]
      if (source) { entry.renamePeer = source; entries.push({ ...entry, path: source, renamePeer: filePath }) }
    }
  }
  return entries
}

function statusText(entries: StatusEntry[]): string { return entries.map(entry => `${entry.category}: ${entry.path}`).join(", ") || "clean" }
function relative(root: string, file: string): string { return path.relative(root, path.resolve(file)).split(path.sep).join("/") }

function normalizedAbsolute(root: string, file: string): string {
  const portable = file.replace(/[\\/]/g, path.sep)
  const candidate = path.resolve(root, path.isAbsolute(portable) ? portable : path.join(root, portable))
  if (fs.existsSync(candidate)) return fs.realpathSync(candidate)
  const tail: string[] = []
  let ancestor = candidate
  while (!fs.existsSync(ancestor)) { tail.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor) }
  return path.join(fs.realpathSync(ancestor), ...tail)
}

function assertNoSymlinkComponents(root: string, file: string): void {
  let current = path.resolve(root)
  for (const part of path.relative(current, path.resolve(file)).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new RepositoryTransactionError(`Refusing auto-commit through symlink: ${file}`)
    } catch (error: any) {
      if (error instanceof RepositoryTransactionError) throw error
      if (error.code !== "ENOENT") throw error
      break
    }
  }
}

function isIgnored(root: string, file: string): boolean { return git(root, ["check-ignore", "-q", "--", file]).status === 0 }
function inScope(root: string, file: string, scopes: string[]): boolean {
  const rel = relative(root, path.join(root, file))
  return scopes.some(scope => rel === scope || rel.startsWith(`${scope}/`))
}

function parseIndexEntries(output: string): Map<string, { mode: string; oid: string; stage: string }> {
  const result = new Map<string, { mode: string; oid: string; stage: string }>()
  for (const record of output.split("\0")) {
    if (!record) continue
    const match = record.match(/^(\d+) ([0-9a-f]+) (\d)\t([\s\S]*)$/)
    if (match) result.set(match[4], { mode: match[1], oid: match[2], stage: match[3] })
  }
  return result
}

export function parseAutoCommitArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): { argv: string[]; enabled: boolean } {
  const value = env.AGENT_MANAGER_AUTO_COMMIT
  if (value !== undefined && value !== "0" && value !== "1") throw new Error(`Invalid AGENT_MANAGER_AUTO_COMMIT value '${value}'; expected exactly 0 or 1.`)
  let selected: boolean | undefined
  const remaining: string[] = []
  let beforeTerminator = true
  for (const arg of argv) {
    if (arg === "--") { beforeTerminator = false; remaining.push(arg); continue }
    if (!beforeTerminator) { remaining.push(arg); continue }
    if (arg === "--auto-commit") {
      if (selected === false) throw new Error("--auto-commit and --no-auto-commit cannot be used together.")
      selected = true
    } else if (arg === "--no-auto-commit") {
      if (selected === true) throw new Error("--auto-commit and --no-auto-commit cannot be used together.")
      selected = false
    } else remaining.push(arg)
  }
  return { argv: remaining, enabled: selected ?? value === "1" }
}

export function autoCommitEnabled(): boolean {
  const value = process.env.AGENT_MANAGER_AUTO_COMMIT
  if (value !== undefined && value !== "0" && value !== "1") throw new RepositoryTransactionError(`Invalid AGENT_MANAGER_AUTO_COMMIT value '${value}'; expected exactly 0 or 1.`)
  return value === "1"
}

/** Mutate directly by default; when enabled, publish exactly the declared worktree changes. */
function repositoryTransactionImpl<T>(workspacePath: string, plan: string[] | RepositoryTransactionPlan, message: string, mutation: () => T): T {
  if (!autoCommitEnabled()) return mutation()
  const localPaths = Array.isArray(plan) ? plan : plan.localPaths
  if (localPaths.length === 0) return mutation()

  const root = gitRoot(workspacePath)
  const commonDirRaw = git(root, ["rev-parse", "--git-common-dir"]).stdout.trim()
  const commonDir = path.resolve(root, commonDirRaw || ".git")
  const managerLock = path.join(commonDir, "agent-manager.lock")
  let lockFd: number | undefined
  let lockIdentity: LockIdentity | undefined
  let failed = false
  let phase = "pre-mutation"
  try {
    try {
      lockFd = fs.openSync(managerLock, "wx")
      const stat = fs.fstatSync(lockFd)
      lockIdentity = { dev: stat.dev, ino: stat.ino }
    } catch { throw new RepositoryTransactionError("Another Agent Manager mutation is already running.") }
    const scopes = Array.from(new Set(localPaths.map(file => {
      if (!path.isAbsolute(file) && file.replace(/[\\/]/g, path.sep).split(path.sep).includes("..")) throw new RepositoryTransactionError(`Repository-local path may not contain traversal: ${file}`)
      const candidate = path.resolve(root, file.replace(/[\\/]/g, path.sep))
      assertNoSymlinkComponents(root, candidate)
      const absolute = normalizedAbsolute(root, candidate)
      const rel = relative(root, absolute)
      if (rel === ".." || rel.startsWith("../") || path.isAbsolute(rel)) throw new RepositoryTransactionError(`Auto-commit only supports repository-local paths; external exports must remain non-committing: ${file}`)
      return rel
    })))
    const initial = status(root).filter(file => !isIgnored(root, file.path))
    if (initial.length) throw new RepositoryTransactionError(`Auto-commit refused before mutation: ${statusText(initial)}. No mutation performed. Re-run with --no-auto-commit or AGENT_MANAGER_AUTO_COMMIT=0; this opt-out modifies files without committing them.`)
    const head = git(root, ["rev-parse", "--verify", "HEAD"])
    const refResult = git(root, ["symbolic-ref", "--quiet", "HEAD"])
    if (head.status !== 0 || refResult.status !== 0) throw new RepositoryTransactionError("Refusing auto-commit in an unborn or detached repository.")
    const headOid = head.stdout.trim()
    const ref = refResult.stdout.trim()
    const gitDir = path.resolve(root, git(root, ["rev-parse", "--git-dir"]).stdout.trim())
    if (["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"].some(file => fs.existsSync(path.join(commonDir, file)) || fs.existsSync(path.join(gitDir, file)))) throw new RepositoryTransactionError("Refusing auto-commit while a merge, rebase, cherry-pick, or revert is in progress.")
    if (git(root, ["var", "GIT_AUTHOR_IDENT"]).status !== 0) throw new RepositoryTransactionError("Git author identity is not configured; configure user.name and user.email before using auto-commit.")

    phase = "mutation"
    const result = mutation()
    phase = "capture"
    let changed = status(root).filter(file => !isIgnored(root, file.path))
    for (const file of changed) if (file.renamePeer && inScope(root, file.path, scopes) && !inScope(root, file.renamePeer, scopes)) scopes.push(file.renamePeer)
    const unexpected = changed.filter(file => !inScope(root, file.path, scopes))
    if (unexpected.length) throw new RepositoryTransactionError(`Unexpected repository path changed: ${statusText(unexpected)}`)
    const changedPaths = new Set(changed.flatMap(file => file.renamePeer ? [file.path, file.renamePeer] : [file.path]))
    if (changedPaths.size === 0) return result

    const objectFormat = git(root, ["rev-parse", "--show-object-format"]).stdout.trim()
    const zeroOid = objectFormat === "sha256" ? "0".repeat(64) : "0".repeat(40)
    const captures = new Map<string, { oid: string; mode: string }>()
    for (const file of changedPaths) {
      const absolute = path.join(root, file)
      const stat = fs.lstatSync(absolute, { throwIfNoEntry: false })
      if (!stat) { captures.set(file, { oid: zeroOid, mode: "0" }); continue }
      if (!stat.isFile() || stat.isSymbolicLink()) throw new RepositoryTransactionError(`Refusing auto-commit for non-regular path: ${file}`)
      const hash = git(root, ["hash-object", "-w", "--stdin"], {}, fs.readFileSync(absolute))
      if (hash.status !== 0) throw new RepositoryTransactionError(hash.stderr.trim() || "hash-object failed")
      captures.set(file, { oid: hash.stdout.trim(), mode: stat.mode & 0o111 ? "100755" : "100644" })
    }

    phase = "index"
    for (const [file, capture] of captures) {
      if (capture.mode === "0") {
        const remove = git(root, ["update-index", "--remove", file])
        if (remove.status !== 0) throw new RepositoryTransactionError(`Unable to update the real Git index: ${remove.stderr.trim() || "update-index failed"}. The manager may have staged changes; manual recovery is required.`)
      }
    }
    const input = Buffer.from([...captures].filter(([, capture]) => capture.mode !== "0").map(([file, capture]) => `${capture.mode} ${capture.oid}\t${file}\0`).join(""))
    const update = git(root, ["update-index", "--add", "-z", "--index-info"], {}, input)
    if (update.status !== 0) throw new RepositoryTransactionError(`Unable to update the real Git index: ${update.stderr.trim() || "update-index failed"}. The manager may have staged changes; manual recovery is required.`)
    const cachedNames = git(root, ["diff", "--cached", "--name-only", "-z"]).stdout.split("\0").filter(Boolean)
    // A deletion is represented by a zero-mode entry in the candidate, but it
    // is still expected to appear in the cached diff (as a deletion).
    const expectedNames = new Set(captures.keys())
    if (cachedNames.some(file => !expectedNames.has(file))) throw new RepositoryTransactionError(`Cached index contains paths outside the candidate (${cachedNames.join(", ")} vs ${[...expectedNames].join(", ")}); manual recovery is required.`)
    const cached = parseIndexEntries(git(root, ["ls-files", "--stage", "-z"]).stdout)
    for (const [file, capture] of captures) {
      if (capture.mode === "0") continue
      const entry = cached.get(file)
      if (!entry || entry.stage !== "0" || entry.oid !== capture.oid || (capture.mode !== "0" && entry.mode !== capture.mode)) throw new RepositoryTransactionError(`Cached index candidate mismatch for ${file}; manual recovery is required.`)
    }

    phase = "tree"
    const tree = git(root, ["write-tree"])
    if (tree.status !== 0) throw new RepositoryTransactionError(tree.stderr.trim() || "write-tree failed; the real index may be staged and requires manual recovery.")
    phase = "commit"
    const commitTree = git(root, ["commit-tree", tree.stdout.trim(), "-p", headOid], { GIT_CONFIG_NOSYSTEM: "1" }, Buffer.from(`${message}\n`))
    if (commitTree.status !== 0) throw new RepositoryTransactionError(commitTree.stderr.trim() || "commit-tree failed; the real index may be staged and requires manual recovery.")
    phase = "publish"
    const updateRef = git(root, ["update-ref", "-m", "agent-manager auto-commit", ref, commitTree.stdout.trim(), headOid])
    if (updateRef.status !== 0) throw new RepositoryTransactionError(updateRef.stderr.trim() || "update-ref failed; the real index remains staged and requires manual recovery.")
    const remaining = status(root).filter(file => !isIgnored(root, file.path))
    if (remaining.length) console.error(`Auto-commit published; concurrent changes were preserved: ${statusText(remaining)}`)
    return result
  } catch (error: any) {
    failed = true
    const current = (() => { try { return status(root).filter(file => !isIgnored(root, file.path)) } catch { return [] } })()
    if (error instanceof Error && !(phase === "pre-mutation" && error instanceof RepositoryTransactionError)) error.message += ` Auto-commit failed during ${phase}; modifications may remain. Manual recovery is required; no repository rollback was attempted. Current status: ${statusText(current)}`
    throw error
  } finally {
    if (lockFd !== undefined) {
      fs.closeSync(lockFd)
      let owned = false
      try {
        const stat = fs.lstatSync(managerLock)
        owned = stat.isFile() && !stat.isSymbolicLink() && lockIdentity !== undefined && stat.dev === lockIdentity.dev && stat.ino === lockIdentity.ino
      } catch {}
      if (owned) fs.unlinkSync(managerLock)
      else if (failed && fs.existsSync(managerLock)) console.error(`Agent Manager lock was replaced; preserving ${managerLock}.`)
    }
  }
}

export function repositoryTransaction<T>(workspacePath: string, plan: string[] | RepositoryTransactionPlan, message: string, mutation: () => T, _options: RepositoryTransactionOptions = {}): T {
  return repositoryTransactionImpl(workspacePath, plan, message, mutation)
}

export function isRepositoryLocalPath(workspacePath: string, file: string): boolean {
  const root = path.resolve(workspacePath)
  const resolved = normalizedAbsolute(root, file)
  return resolved === root || resolved.startsWith(`${root}${path.sep}`)
}
