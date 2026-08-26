import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"

export const AUTO_COMMIT_MESSAGES = {
  create: "chore(agent-manager): create agent", import: "chore(agent-manager): import agents",
  rename: "chore(agent-manager): fix names/rename agents", tune: "chore(agent-manager): update/tune agents",
  organize: "chore(agent-manager): organize agents", fork: "chore(agent-manager): fork agent category",
  bridge: "chore(agent-manager): generate bridge", config: "chore(agent-manager): save/migrate translation config",
} as const

export class RepositoryTransactionError extends Error {}
export interface RepositoryTransactionPlan { localPaths: string[]; externalPaths?: string[] }
export interface RepositoryTransactionOptions { onWarning?: (warning: TransactionWarning) => void }
export type CommitStatus = "off" | "committed" | "skipped" | "failed"
export interface TransactionWarning { code: string; phase: string; message: string; recovery: string }
export interface TransactionResult<T> { value: T; commit: CommitStatus; warning?: TransactionWarning; commitHash?: string }
type LockIdentity = { dev: number; ino: number }
type StatusEntry = { xy: string; path: string; category: "staged" | "unstaged" | "staged+unstaged" | "untracked"; renamePeer?: string }
type Fingerprint = { oid: string; mode: string }

const dangerousGitVariables = /^(?:GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES|GIT_COMMON_DIR|GIT_NAMESPACE|GIT_CEILING_DIRECTORIES|GIT_DISCOVERY_ACROSS_FILESYSTEM|GIT_OPTIONAL_LOCKS)$/i
function cleanGitEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) if (!dangerousGitVariables.test(key) && !/^GIT_CONFIG(?:_|$)/i.test(key)) safe[key] = value
  Object.assign(safe, overrides); return safe
}
function git(root: string, args: string[], overrides: NodeJS.ProcessEnv = {}, input?: Buffer) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", env: cleanGitEnvironment(overrides), input })
  if (result.error) throw result.error
  return result
}
function gitRoot(start: string): string {
  const result = git(start, ["rev-parse", "--show-toplevel"])
  if (result.status !== 0) throw new RepositoryTransactionError("Auto-commit requires a Git repository.")
  return fs.realpathSync(result.stdout.trim())
}
function status(root: string): StatusEntry[] {
  const result = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { GIT_OPTIONAL_LOCKS: "0" })
  if (result.status !== 0) throw new RepositoryTransactionError("Unable to inspect Git status.")
  const fields = result.stdout.split("\0"), entries: StatusEntry[] = []
  for (let i = 0; i < fields.length; i++) {
    const raw = fields[i]; if (!raw) continue
    const xy = raw.slice(0, 2), filePath = raw.slice(3)
    const category = xy === "??" ? "untracked" : xy[0] !== " " && xy[1] !== " " ? "staged+unstaged" : xy[0] !== " " ? "staged" : "unstaged"
    const entry = { xy, path: filePath, category } as StatusEntry; entries.push(entry)
    if (/^[RC][RC ]/.test(raw)) { const source = fields[++i]; if (source) { entry.renamePeer = source; entries.push({ ...entry, path: source, renamePeer: filePath }) } }
  }
  return entries
}
function relative(root: string, file: string): string { return path.relative(root, path.resolve(file)).split(path.sep).join("/") }
function normalizedAbsolute(root: string, file: string): string {
  const candidate = path.resolve(root, file.replace(/[\\/]/g, path.sep))
  const tail: string[] = []
  let ancestor = candidate
  while (!fs.existsSync(ancestor)) { tail.unshift(path.basename(ancestor)); const parent = path.dirname(ancestor); if (parent === ancestor) break; ancestor = parent }
  return path.join(fs.realpathSync.native(ancestor), ...tail)
}
function assertNoSymlinkComponents(root: string, file: string): void {
  let current = path.resolve(root)
  for (const part of path.relative(current, path.resolve(file)).split(path.sep).filter(Boolean)) { current = path.join(current, part)
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new RepositoryTransactionError("Refusing auto-commit through a symlink.") }
    catch (error: any) { if (error instanceof RepositoryTransactionError) throw error; if (error.code !== "ENOENT") throw error; break }
  }
}
function safeMessage(value: unknown): string { return String(value instanceof Error ? value.message : value).replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 240) }
function warning(code: string, phase: string, message: unknown): TransactionWarning {
  return { code, phase, message: safeMessage(message), recovery: "Your mutation was kept. Review Git status and commit or recover manually." }
}
function planPaths(workspacePath: string, plan: string[] | RepositoryTransactionPlan): { local: string[]; external: string[] } {
  const root = path.resolve(workspacePath), local = Array.isArray(plan) ? plan : plan.localPaths, external = Array.isArray(plan) ? [] : plan.externalPaths || []
  if (!local.length && !external.length) return { local: [], external: [] }
  const normalized = local.map(file => { const portable = file.replace(/[\\/]/g, path.sep)
    if (!path.isAbsolute(file) && portable.split(path.sep).includes("..")) throw new RepositoryTransactionError("Repository-local path may not contain traversal.")
    const candidate = path.resolve(root, portable); assertNoSymlinkComponents(root, candidate); const rel = relative(root, candidate)
    if (rel === ".." || rel.startsWith("../") || path.isAbsolute(rel)) throw new RepositoryTransactionError("Auto-commit only supports repository-local paths.")
    return normalizedAbsolute(root, candidate)
  })
  const externalPaths = external.map(file => { const candidate = path.resolve(root, file.replace(/[\\/]/g, path.sep)); assertNoSymlinkComponents(path.parse(candidate).root, candidate); return candidate })
  if (normalized.some(file => externalPaths.includes(file))) throw new RepositoryTransactionError("A path cannot be both local and external.")
  return { local: normalized, external: externalPaths }
}
function repositoryStateMarkers(root: string): void {
  const gitDirResult = git(root, ["rev-parse", "--git-dir"]), commonDirResult = git(root, ["rev-parse", "--git-common-dir"])
  if (gitDirResult.status !== 0 || commonDirResult.status !== 0) throw new RepositoryTransactionError("Unable to inspect Git repository state.")
  const resolve = (value: string) => path.isAbsolute(value) ? value : path.resolve(root, value)
  const dirs = new Set([resolve(gitDirResult.stdout.trim()), resolve(commonDirResult.stdout.trim())])
  if ([...dirs].some(dir => ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"].some(marker => fs.existsSync(path.join(dir, marker))))) throw new RepositoryTransactionError("Git operation in progress.")
}
function sameFile(file: string, identity: LockIdentity): boolean { try { const s = fs.lstatSync(file); return !s.isSymbolicLink() && s.dev === identity.dev && s.ino === identity.ino } catch { return false } }
function pathspec(paths: Iterable<string>): Buffer { return Buffer.from([...paths].join("\0") + "\0") }
function fingerprint(root: string, file: string): Fingerprint {
  const absolute = path.join(root, file)
  const stat = fs.lstatSync(absolute, { throwIfNoEntry: false })
  if (!stat) return { oid: "0", mode: "0" }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new RepositoryTransactionError(`Refusing auto-commit for non-regular path: ${file}`)
  const hash = git(root, ["hash-object", "-w", "--stdin"], {}, fs.readFileSync(absolute))
  if (hash.status !== 0) throw new RepositoryTransactionError(hash.stderr.trim() || "hash-object failed")
  return { oid: hash.stdout.trim(), mode: stat.mode & 0o111 ? "100755" : "100644" }
}
function fingerprintsEqual(left: Fingerprint, right: Fingerprint): boolean { return left.oid === right.oid && left.mode === right.mode }

export function parseAutoCommitArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): { argv: string[]; enabled: boolean } {
  const value = env.AGENT_MANAGER_AUTO_COMMIT
  if (value !== undefined && value !== "0" && value !== "1") throw new Error(`Invalid AGENT_MANAGER_AUTO_COMMIT value '${value}'; expected exactly 0 or 1.`)
  let selected: boolean | undefined; const remaining: string[] = []; let before = true
  for (const arg of argv) { if (arg === "--") { before = false; remaining.push(arg) } else if (!before) remaining.push(arg); else if (arg === "--auto-commit") { if (selected === false) throw new Error("--auto-commit and --no-auto-commit cannot be used together."); selected = true } else if (arg === "--no-auto-commit") { if (selected === true) throw new Error("--auto-commit and --no-auto-commit cannot be used together."); selected = false } else remaining.push(arg) }
  return { argv: remaining, enabled: selected ?? value === "1" }
}
export function autoCommitEnabled(): boolean { const value = process.env.AGENT_MANAGER_AUTO_COMMIT; if (value !== undefined && value !== "0" && value !== "1") throw new RepositoryTransactionError(`Invalid AGENT_MANAGER_AUTO_COMMIT value '${value}'; expected exactly 0 or 1.`); return value === "1" }

export function repositoryTransaction<T>(workspacePath: string, plan: string[] | RepositoryTransactionPlan, message: string, mutation: () => T, options: RepositoryTransactionOptions = {}): TransactionResult<T> {
  const { local } = planPaths(workspacePath, plan)
  const notify = (result: TransactionResult<T>): TransactionResult<T> => { if (result.warning && options.onWarning) { try { options.onWarning(result.warning) } catch {} } return result }
  const run = () => mutation()
  if (!autoCommitEnabled()) return { value: run(), commit: "off" }
  let root = "", managerFd: number | undefined, managerLock = "", managerIdentity: LockIdentity | undefined
  const releaseManager = () => { if (managerFd === undefined) return; try { fs.closeSync(managerFd) } catch {} ; managerFd = undefined; try { if (managerIdentity && sameFile(managerLock, managerIdentity)) fs.unlinkSync(managerLock) } catch {} }
  const skip = (value: T, code: string, phase: string, message: unknown) => notify({ value, commit: "skipped", warning: warning(code, phase, message) })
  const runSkippedWithoutLock = (message: unknown): TransactionResult<T> => skip(run(), "checkpoint-locked", "lock", message)
  try {
    root = gitRoot(workspacePath)
    const common = git(root, ["rev-parse", "--git-common-dir"]); if (common.status !== 0) throw new Error("Unable to resolve Git common directory.")
    const commonDir = path.isAbsolute(common.stdout.trim()) ? common.stdout.trim() : path.resolve(root, common.stdout.trim() || ".git")
    managerLock = path.join(commonDir, "agent-manager.lock")
    try {
      managerFd = fs.openSync(managerLock, "wx", 0o600)
    } catch (error: any) {
      if (error?.code === "EEXIST") {
        // Git never blocks the mutation. Mutators own their disk checks and
        // atomic writes, but concurrent managers can still race.
        return runSkippedWithoutLock("Another Agent Manager mutation is already running; concurrent managers may race.")
      }
      throw error
    }
    const lockStat = fs.fstatSync(managerFd); managerIdentity = { dev: lockStat.dev, ino: lockStat.ino }
    repositoryStateMarkers(root)
    if (status(root).length) throw new RepositoryTransactionError("The repository already contains changes.")
    const head = git(root, ["rev-parse", "--verify", "HEAD"]), ref = git(root, ["symbolic-ref", "--quiet", "HEAD"])
    if (head.status !== 0 || ref.status !== 0) throw new RepositoryTransactionError("The repository is detached or unborn.")
    if (git(root, ["var", "GIT_AUTHOR_IDENT"]).status !== 0) throw new RepositoryTransactionError("Git identity is not configured.")
  } catch (error) {
    const text = String(error instanceof Error ? error.message : error)
    const code = text.includes("already running") ? "preflight-lock" : text.includes("operation in progress") ? "unsupported-repository-state" : text.includes("already contains changes") ? "dirty-repository" : "git-unavailable"
     // A manager that acquired the lock keeps it through the fallback mutation.
    try { return skip(run(), code, code === "preflight-lock" ? "lock" : "preflight", error) } finally { releaseManager() }
  }

  let value: T
  try { value = run() } catch (error) { releaseManager(); throw error }
  let hooksDir: string | undefined, hooksIdentity: LockIdentity | undefined
  try {
    const scopes = new Set(local.map(file => relative(root, file)))
    const inScope = (file: string | undefined) => Boolean(file && (scopes.has(file) || [...scopes].some(scope => file.startsWith(`${scope}/`) || scope.startsWith(`${file}/`))))
    const changed = status(root), unexpected = changed.filter(entry => !inScope(entry.path) && !inScope(entry.renamePeer))
    if (unexpected.length) return notify({ value, commit: "failed", warning: warning("unexpected-path", "capture", `${unexpected.length} unexpected change(s): ${JSON.stringify([...scopes])} ${JSON.stringify(changed)}`) })
     const selected = new Set(changed.flatMap(entry => entry.renamePeer ? [entry.path, entry.renamePeer] : [entry.path])); if (!selected.size) return { value, commit: "skipped" }
     const captured = new Map<string, Fingerprint>([...selected].map(file => [file, fingerprint(root, file)]))
      const changedBeforeCommit = [...captured].some(([file, expected]) => !fingerprintsEqual(expected, fingerprint(root, file)))
    if (changedBeforeCommit) return notify({ value, commit: "failed", warning: warning("concurrent-worktree-change", "capture", "A selected worktree path changed before commit; no commit was attempted.") })
    for (const entry of changed) if (entry.category === "untracked" && selected.has(entry.path)) {
      const add = git(root, ["--literal-pathspecs", "add", "--intent-to-add", "--pathspec-from-file=-", "--pathspec-file-nul"], {}, pathspec([entry.path]))
      if (add.status !== 0) throw new Error("intent-to-add failed; the index may contain intent-to-add entries.")
    }
    hooksDir = fs.mkdtempSync(path.join(path.dirname(root), ".agent-manager-hooks-")); fs.chmodSync(hooksDir, 0o700); const hs = fs.lstatSync(hooksDir); hooksIdentity = { dev: hs.dev, ino: hs.ino }
    const commit = git(root, ["--literal-pathspecs", "-c", `core.hooksPath=${hooksDir}`, "commit", "--only", "--no-gpg-sign", "--no-edit", "--cleanup=verbatim", "--pathspec-from-file=-", "--pathspec-file-nul", "-m", message], { GIT_CONFIG_NOSYSTEM: "1", GIT_EDITOR: ":" }, pathspec(selected))
    if (commit.status !== 0) throw new Error(`commit failed${commit.stderr ? `: ${commit.stderr}` : ""}; the index may contain intent-to-add entries.`)
    const hashResult = git(root, ["rev-parse", "--verify", "HEAD"]), hash = hashResult.stdout.trim()
    const committedPaths = git(root, ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", hash], { GIT_OPTIONAL_LOCKS: "0" }).stdout.split("\0").filter(Boolean)
    const tree = git(root, ["ls-tree", "-z", "-r", hash, "--"])
    const committed = new Map<string, Fingerprint>()
    for (const record of tree.stdout.split("\0").filter(Boolean)) {
      const match = record.match(/^(\d+) \w+ ([0-9a-f]+)\t([\s\S]*)$/)
      if (match) committed.set(match[3], { mode: match[1], oid: match[2] })
    }
    const blobMismatch = [...captured].some(([file, expected]) => {
      const actual = committed.get(file) || { oid: "0", mode: "0" }
      return !fingerprintsEqual(expected, actual)
    })
    if (hashResult.status !== 0 || tree.status !== 0 || blobMismatch || committedPaths.some(file => !selected.has(file)) || status(root).some(entry => selected.has(entry.path) || selected.has(entry.renamePeer || ""))) return notify({ value, commit: "committed", commitHash: hash || undefined, warning: warning(blobMismatch ? "post-commit-fingerprint-mismatch" : "post-verification", "verify", "Commit completed, but post-commit verification found a concurrent or unexpected change.") })
    return { value, commit: "committed", commitHash: hash }
  } catch (error) { return notify({ value, commit: "failed", warning: warning("git-failure", "commit", error) })
  } finally {
    releaseManager()
    if (hooksDir && hooksIdentity && sameFile(hooksDir, hooksIdentity)) try { fs.rmdirSync(hooksDir) } catch {}
  }
}
export function isRepositoryLocalPath(workspacePath: string, file: string): boolean { const root = path.resolve(workspacePath), resolved = path.resolve(root, file); return resolved === root || resolved.startsWith(`${root}${path.sep}`) }
