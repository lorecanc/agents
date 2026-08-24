import fs from "node:fs"
import os from "node:os"
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
export interface RepositoryTransactionPlan {
  localPaths: string[]
  externalPaths?: string[]
}
export interface RepositoryTransactionOptions { afterObservation?: () => void }

const dangerousGitVariables = /^(?:GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES|GIT_COMMON_DIR|GIT_NAMESPACE|GIT_CEILING_DIRECTORIES|GIT_DISCOVERY_ACROSS_FILESYSTEM|GIT_OPTIONAL_LOCKS)$/i

function cleanGitEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!dangerousGitVariables.test(key) && !/^GIT_CONFIG(?:_|$)/i.test(key)) safe[key] = value
  }
  // Trusted call-site settings are deliberately applied after hostile inherited
  // settings have been removed (notably GIT_CONFIG_NOSYSTEM for commits).
  Object.assign(safe, overrides)
  return safe
}

function git(root: string, args: string[], overrides: NodeJS.ProcessEnv = {}) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", env: cleanGitEnvironment(overrides) })
  if (result.error) throw result.error
  return result
}

function gitRoot(start: string): string {
  const result = spawnSync("git", ["-C", start, "rev-parse", "--show-toplevel"], { encoding: "utf8", env: cleanGitEnvironment() })
  if (result.error) throw result.error
  if (result.status !== 0) throw new RepositoryTransactionError("Auto-commit requires a Git repository.")
  return fs.realpathSync(result.stdout.trim())
}

function status(root: string): string[] {
  const result = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
  if (result.status !== 0) throw new RepositoryTransactionError(result.stderr.trim() || "Unable to inspect Git status.")
  const fields = result.stdout.split("\0")
  const paths: string[] = []
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i]
    if (!entry) continue
    paths.push(entry.length > 2 ? entry.slice(3) : entry)
    if (/^[RC][RC ]/.test(entry)) i++
  }
  return paths
}

function relative(root: string, file: string): string {
  return path.relative(root, path.resolve(file)).split(path.sep).join("/")
}

function normalizedAbsolute(root: string, file: string): string {
  // Git paths are slash-separated even on Windows; accepting both separators
  // keeps CLI plans portable without allowing traversal outside the workspace.
  const portable = file.replace(/[\\/]/g, path.sep)
  const candidate = path.resolve(root, path.isAbsolute(portable) ? portable : path.join(root, portable))
  if (fs.existsSync(candidate)) return fs.realpathSync(candidate)
  const tail: string[] = []
  let ancestor = candidate
  while (!fs.existsSync(ancestor)) { tail.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor) }
  return path.join(fs.realpathSync(ancestor), ...tail)
}

function assertNoSymlinkComponents(root: string, file: string): void {
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(file)
  const parts = path.relative(resolvedRoot, resolved).split(path.sep).filter(Boolean)
  let current = resolvedRoot
  for (const part of parts) {
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

function isIgnored(root: string, file: string): boolean {
  return git(root, ["check-ignore", "-q", "--", file]).status === 0
}

function inScope(root: string, file: string, scopes: string[]): boolean {
  const rel = relative(root, path.join(root, file))
  return scopes.some(scope => rel === scope || rel.startsWith(`${scope}/`))
}

function fingerprint(file: string): string {
  try {
    const stat = fs.lstatSync(file)
    if (stat.isSymbolicLink()) return `link:${fs.readlinkSync(file)}`
    if (!stat.isFile()) return `other:${stat.mode}:${stat.size}:${stat.mtimeMs}`
    return `file:${stat.mode}:${stat.size}:${stat.mtimeMs}:${requireHash(file)}`
  } catch (error: any) {
    if (error.code === "ENOENT") return "missing"
    throw error
  }
}

function requireHash(file: string): string {
  // Avoid mutable metadata being the sole signal while keeping this module
  // synchronous and portable across supported Node runtimes.
  let hash = 2166136261
  for (const byte of fs.readFileSync(file)) hash = Math.imul(hash ^ byte, 16777619)
  return (hash >>> 0).toString(16)
}

function manifest(root: string, scopes: string[]): string[] {
  const files = new Set<string>()
  const visit = (file: string) => {
    let stat: fs.Stats
    try { stat = fs.lstatSync(file) } catch (error: any) { if (error.code === "ENOENT") return; throw error }
    if (stat.isSymbolicLink()) throw new RepositoryTransactionError(`Refusing auto-commit because a symlink exists in mutation scope: ${relative(root, file)}`)
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(file)) visit(path.join(file, child))
    } else if (!isIgnored(root, relative(root, file))) files.add(file)
  }
  for (const scope of scopes) visit(path.join(root, scope))
  return [...files]
}

function stagedPaths(root: string): string[] {
  const result = git(root, ["diff", "--cached", "--name-only", "-z"])
  if (result.status !== 0) throw new RepositoryTransactionError(result.stderr.trim() || "Unable to inspect staged Git paths.")
  return result.stdout.split("\0").filter(Boolean)
}

function scopedObservation(root: string, scopes: string[]): Map<string, string> {
  const result = new Map<string, string>()
  const visit = (file: string) => {
    let stat: fs.Stats
    try { stat = fs.lstatSync(file) } catch (error: any) {
      if (error.code === "ENOENT") { result.set(relative(root, file), "missing"); return }
      throw error
    }
    if (stat.isSymbolicLink()) throw new RepositoryTransactionError(`Refusing auto-commit because a symlink exists in mutation scope: ${relative(root, file)}`)
    const rel = relative(root, file)
    result.set(rel, stat.isDirectory() ? `directory:${stat.mode}` : `file:${fingerprint(file)}`)
    if (stat.isDirectory()) for (const child of fs.readdirSync(file)) visit(path.join(file, child))
  }
  for (const scope of scopes) visit(path.join(root, scope))
  return result
}

function assertObservation(root: string, scopes: string[], observation: Map<string, string>): void {
  const current = scopedObservation(root, scopes)
  if (current.size !== observation.size || [...observation].some(([file, value]) => current.get(file) !== value)) {
    const changed = new Set([...observation.keys(), ...current.keys()].filter(file => observation.get(file) !== current.get(file)))
    throw new RepositoryTransactionError(`Concurrent edit detected in declared scope: ${[...changed].join(", ")}`)
  }
}

/** Run one manager mutation and, unless opted out, commit only its declared paths. */
export function repositoryTransaction<T>(workspacePath: string, plan: string[] | RepositoryTransactionPlan, message: string, mutation: () => T, options: RepositoryTransactionOptions = {}): T {
  if (process.env.AGENT_MANAGER_AUTO_COMMIT === "0") return mutation()
  const localPaths = Array.isArray(plan) ? plan : plan.localPaths
  if (localPaths.length === 0) return mutation()

  const root = gitRoot(workspacePath)
  const commonDirRaw = git(root, ["rev-parse", "--git-common-dir"]).stdout.trim()
  const commonDir = path.resolve(root, commonDirRaw || ".git")
  const lockPath = path.join(commonDir, "agent-manager.lock")
  let lockFd: number | undefined
  let hooks: string | undefined
  try {
    try { lockFd = fs.openSync(lockPath, "wx") } catch { throw new RepositoryTransactionError("Another Agent Manager mutation is already running.") }

    const scopes = Array.from(new Set(localPaths.map(file => {
      if (!path.isAbsolute(file) && file.replace(/[\\/]/g, path.sep).split(path.sep).includes("..")) throw new RepositoryTransactionError(`Repository-local path may not contain traversal: ${file}`)
      const candidate = path.resolve(root, file.replace(/[\\/]/g, path.sep))
      try { if (fs.lstatSync(candidate).isSymbolicLink()) throw new RepositoryTransactionError(`Refusing auto-commit through symlink: ${file}`) } catch (error: any) {
        if (error instanceof RepositoryTransactionError) throw error
        if (error.code !== "ENOENT") throw error
      }
      const absolute = normalizedAbsolute(root, candidate)
      const rel = relative(root, absolute)
      if (rel === ".." || rel.startsWith("../") || path.isAbsolute(rel)) throw new RepositoryTransactionError(`Auto-commit only supports repository-local paths; external exports must remain non-committing: ${file}`)
      assertNoSymlinkComponents(root, absolute)
      return rel
    })))
    const initial = status(root).filter(file => !isIgnored(root, file))
    if (initial.length) throw new RepositoryTransactionError(`Refusing auto-commit because the repository is dirty (${initial.join(", ")}). Re-run with --no-auto-commit or AGENT_MANAGER_AUTO_COMMIT=0.`)
    const head = git(root, ["rev-parse", "--verify", "HEAD"])
    if (head.status !== 0 || git(root, ["symbolic-ref", "--quiet", "HEAD"]).status !== 0) throw new RepositoryTransactionError("Refusing auto-commit in an unborn or detached repository.")
    const gitDir = path.resolve(root, git(root, ["rev-parse", "--git-dir"]).stdout.trim())
    if (["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"].some(file => fs.existsSync(path.join(commonDir, file)) || fs.existsSync(path.join(gitDir, file)))) throw new RepositoryTransactionError("Refusing auto-commit while a merge, rebase, cherry-pick, or revert is in progress.")
    if (git(root, ["var", "GIT_AUTHOR_IDENT"]).status !== 0) throw new RepositoryTransactionError("Git author identity is not configured; configure user.name and user.email before using auto-commit.")

    const result = mutation()
    // Mutation callbacks are trusted and synchronous. External writes during
    // callback execution cannot be attributed; writes after this observation
    // are detected and left untouched.
    const observation = scopedObservation(root, scopes)
    options.afterObservation?.()
    assertObservation(root, scopes, observation)
    const changed = status(root).filter(file => !isIgnored(root, file))
    for (const file of changed) {
      const absolute = path.join(root, file)
      if (fs.existsSync(absolute) && fs.lstatSync(absolute).isSymbolicLink()) throw new RepositoryTransactionError(`Refusing auto-commit because a symlink appeared in mutation scope: ${file}`)
    }
    const unexpected = changed.filter(file => !inScope(root, file, scopes))
    if (unexpected.length) throw new RepositoryTransactionError(`Unexpected repository path changed: ${unexpected.join(", ")}`)
    if (changed.length === 0) return result

    // Recheck immediately before staging: a concurrent staged/working change
    // must never be absorbed into, or reset by, this operation.
    const beforeStage = status(root).filter(file => !isIgnored(root, file))
    if (beforeStage.some(file => !inScope(root, file, scopes))) throw new RepositoryTransactionError(`Unexpected repository path changed: ${beforeStage.filter(file => !inScope(root, file, scopes)).join(", ")}`)
    assertObservation(root, scopes, observation)
    hooks = fs.mkdtempSync(path.join(os.tmpdir(), "agent-manager-hooks-"))
    const add = git(root, ["add", "--", ...changed])
    if (add.status !== 0) throw new Error(add.stderr.trim() || "git add failed")
    const staged = stagedPaths(root)
    if (staged.some(file => !inScope(root, file, scopes))) throw new RepositoryTransactionError(`Refusing commit because staged paths exceed the declared scope: ${staged.join(", ")}`)
    assertObservation(root, scopes, observation)
    const commit = git(root, ["-c", `core.hooksPath=${hooks}`, "-c", "commit.gpgSign=false", "-c", "tag.gpgSign=false", "commit", "-m", message], { GIT_CONFIG_NOSYSTEM: "1" })
    if (commit.status !== 0) throw new Error(commit.stderr.trim() || "git commit failed")
    return result
  } catch (error: any) {
    const current = (() => { try { return status(root).filter(file => !isIgnored(root, file)) } catch { return [] } })()
    if (error instanceof Error) error.message += ` Recovery required; no repository rollback was attempted. Current status: ${current.join(", ") || "clean"}`
    throw error
  } finally {
    if (hooks) fs.rmSync(hooks, { recursive: true, force: true })
    if (lockFd !== undefined) { fs.closeSync(lockFd); fs.rmSync(lockPath, { force: true }) }
  }
}

export function isRepositoryLocalPath(workspacePath: string, file: string): boolean {
  const root = path.resolve(workspacePath)
  const resolved = normalizedAbsolute(root, file)
  return resolved === root || resolved.startsWith(`${root}${path.sep}`)
}

export function autoCommitEnabled(): boolean { return process.env.AGENT_MANAGER_AUTO_COMMIT !== "0" }
