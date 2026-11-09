// Repository primitives shared by every agent family (flow, pipeline, ...) and by the dev_* tools.
//
// Path helpers, git access, repository facts and scratch directory, change snapshots and a
// cross-process lock. Node builtins only, no shell string interpolation for git (execFile).

import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"

export function safeId(id) {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    throw new Error(`Invalid session id: ${JSON.stringify(id)}`)
  }
  return id
}

export function realpathLoose(p) {
  const abs = path.resolve(p)
  let cur = abs
  const rest = []
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur)
      return rest.length ? path.join(real, ...rest.reverse()) : real
    } catch {
      const parent = path.dirname(cur)
      if (parent === cur) return abs
      rest.push(path.basename(cur))
      cur = parent
    }
  }
}

export function isInside(root, p) {
  const rel = path.relative(root, p)
  if (rel === "") return true
  return !(rel === ".." || rel.startsWith(".." + path.sep)) && !path.isAbsolute(rel)
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e && e.code === "EPERM"
  }
}

export function redact(text) {
  if (typeof text !== "string") return text
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, "Bearer [REDACTED]")
    .replace(/(\b(?:api[_-]?key|access[_-]?key|secret|token|passwd|password|authorization)\b\s*[=:]\s*)(?!Bearer\b)(["']?)[^\s"']{4,}\2/gi, "$1[REDACTED]")
    .replace(/\b(sk|pk|ghp|gho|ghs|xox[abp])[-_][A-Za-z0-9_-]{16,}/g, "[REDACTED]")
}

// ------------------------------------------------------------------- git

export function git(cwd, args, opts = {}) {
  try {
    return execFileSync("git", ["-c", "core.quotepath=false", ...args], {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
    })
  } catch (e) {
    if (opts.allowFail) return null
    const detail = String(e.stderr || e.message || "").trim()
    throw new Error(`git ${args.join(" ")} failed: ${detail}`)
  }
}

export function gitT(cwd, args, opts = {}) {
  const out = git(cwd, args, opts)
  return out === null ? null : out.trim()
}

const lines = (s) => (s ? s.split("\n").map((l) => l.trim()).filter(Boolean) : [])

/** Resolve repository facts for a working directory, or null if not a git repo. */
export function repoInfo(cwd) {
  const top = gitT(cwd, ["rev-parse", "--show-toplevel"], { allowFail: true })
  if (!top) return null
  const gitDir = gitT(cwd, ["rev-parse", "--absolute-git-dir"], { allowFail: true })
  const commonRaw = gitT(cwd, ["rev-parse", "--git-common-dir"], { allowFail: true })
  if (!gitDir || !commonRaw) return null
  const common = realpathLoose(path.resolve(cwd, commonRaw))
  const realGitDir = realpathLoose(gitDir)
  return {
    top: realpathLoose(top),
    gitDir: realGitDir,
    common,
    isLinked: realGitDir !== common,
    stateDir: path.join(common, "opencode-pipeline"),
  }
}

/** Scratch directory for throwaway files: inside the repo, never committable. */
export function scratchDir(info) {
  return info.isLinked
    ? path.join(info.top, ".opencode-scratch")
    : path.join(info.common, "opencode-scratch")
}

export function ensureScratch(info) {
  const dir = scratchDir(info)
  fs.mkdirSync(dir, { recursive: true })
  if (info.isLinked) addInfoExclude(info, ".opencode-scratch/")
  return dir
}

export function addInfoExclude(info, pattern) {
  try {
    const file = path.join(info.common, "info", "exclude")
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""
    if (!current.split("\n").includes(pattern)) {
      fs.appendFileSync(file, (current && !current.endsWith("\n") ? "\n" : "") + pattern + "\n")
    }
  } catch {
    /* best effort */
  }
}

export function parsePorcelainZ(out) {
  const items = []
  const parts = out.split("\0")
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (!entry) continue
    const x = entry[0]
    const y = entry[1]
    const p = entry.slice(3)
    let orig
    if (x === "R" || x === "C" || y === "R" || y === "C") orig = parts[++i]
    items.push({
      path: p,
      orig,
      x,
      y,
      untracked: x === "?",
      deleted: x === "D" || y === "D",
    })
  }
  return items
}

export function changedFiles(info) {
  const out = git(info.top, ["status", "--porcelain=v1", "-z", "-uall"])
  return parsePorcelainZ(out).filter((i) => !isInternalPath(i.path))
}

export function isInternalPath(rel) {
  return rel === ".opencode-scratch" || rel.startsWith(".opencode-scratch/")
}

export function parseWorktreeList(out) {
  return (out || "")
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => realpathLoose(l.slice("worktree ".length).trim()))
}

export function snapshot(info) {
  const cwd = info.top
  return {
    takenAt: Date.now(),
    head: gitT(cwd, ["rev-parse", "--verify", "-q", "HEAD"], { allowFail: true }) || null,
    branch: gitT(cwd, ["branch", "--show-current"], { allowFail: true }) || null,
    dirty: changedFiles(info).flatMap((i) => (i.orig ? [i.path, i.orig] : [i.path])),
    branches: lines(gitT(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/heads"], { allowFail: true })),
    worktrees: parseWorktreeList(git(cwd, ["worktree", "list", "--porcelain"], { allowFail: true })),
    stash: lines(gitT(cwd, ["stash", "list"], { allowFail: true })).length,
  }
}

export function gitAnomalies(base, now) {
  if (!base) return []
  const out = []
  const newBranches = now.branches.filter((b) => !base.branches.includes(b))
  if (newBranches.length) out.push({ kind: "new_branches", items: newBranches })
  const newWorktrees = now.worktrees.filter((w) => !base.worktrees.includes(w))
  if (newWorktrees.length) out.push({ kind: "new_worktrees", items: newWorktrees })
  if (now.stash > base.stash) out.push({ kind: "new_stashes", count: now.stash - base.stash })
  if (base.branch !== now.branch) out.push({ kind: "branch_changed", from: base.branch, to: now.branch })
  return out
}

export function toRel(info, p) {
  const abs = realpathLoose(path.resolve(info.top, p))
  if (!isInside(info.top, abs)) return null
  return path.relative(info.top, abs).split(path.sep).join("/")
}

// --------------------------------------------------------------- locking

/** Cross-process mutual exclusion on a named lock (mkdir is atomic). */
export async function withLock(info, name, fn, { timeoutMs = 300000, staleMs = 20 * 60 * 1000, owner = String(process.pid) } = {}) {
  const dir = path.join(info.stateDir, "locks")
  fs.mkdirSync(dir, { recursive: true })
  const lock = path.join(dir, `${name}.lock`)
  const started = Date.now()
  const myToken = { pid: process.pid, owner, at: Date.now(), identity: randomUUID() }
  for (;;) {
    try {
      fs.mkdirSync(lock)
      fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify(myToken))
      break
    } catch (e) {
      if (e.code !== "EEXIST") throw e
      let holder = null
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8"))
        if (parsed && typeof parsed === "object") holder = parsed
      } catch {
        /* lock being created */
      }
      if (holder && Number.isInteger(holder.pid) && !pidAlive(holder.pid)) {
        fs.rmSync(lock, { recursive: true, force: true })
        continue
      }
      if (holder && !Number.isInteger(holder.pid) && Date.now() - (holder.at || 0) > staleMs) {
        fs.rmSync(lock, { recursive: true, force: true })
        continue
      }
      if (!holder) {
        try {
          const age = Date.now() - fs.statSync(lock).mtimeMs
          if (age > Math.min(staleMs, 5000)) {
            fs.rmSync(lock, { recursive: true, force: true })
            continue
          }
        } catch {
          /* lock may have been removed concurrently */
        }
      }
      if (Date.now() - started > timeoutMs) {
        const err = new Error(`lock "${name}" busy (held by ${holder ? holder.owner : "unknown"})`)
        err.code = "LOCK_TIMEOUT"
        throw err
      }
      await new Promise((r) => setTimeout(r, 250))
    }
  }
  try {
    return await fn()
  } finally {
    let ownsLock = false
    try {
      const cur = JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8"))
      ownsLock = Boolean(
        cur && cur.pid === myToken.pid && cur.owner === myToken.owner && cur.identity === myToken.identity,
      )
    } catch {
      /* owner file may be missing or corrupt */
    }
    if (ownsLock) fs.rmSync(lock, { recursive: true, force: true })
  }
}
