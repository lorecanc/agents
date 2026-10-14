// Shared, dependency-free core for the *-pipeline-* agent family.
//
// Used by:
//   - plugins/pipeline-guard.js   (hooks: env, write guards, session registry)
//   - tools/pipeline_state.ts     (read-only change-set / baseline report)
//   - tools/pipeline_commit.ts    (deterministic, scoped commit)
//   - tools/_pipeline_run.js      (verify / smoke runners)
//   - bin/opencode-wt.mjs         (opt-in worktree launcher)
//
// Design rules:
//   * Node builtins only, no shell string interpolation for git (execFile).
//   * Every guard here is defense in depth. Permissions in the agent files are
//     the primary control; these checks give precise error messages and cover
//     what permission patterns cannot express.
//   * Guards fail OPEN on anything they cannot parse or resolve.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"

// ---------------------------------------------------------------- basics

export const PIPELINE_AGENT_RE = /-pipeline-([A-Za-z0-9_]+)$/
export const LIVE_TTL_MS = 15 * 60 * 1000

export function isPipelineAgent(agent) {
  return typeof agent === "string" && PIPELINE_AGENT_RE.test(agent)
}

export function roleOf(agent) {
  const m = typeof agent === "string" ? PIPELINE_AGENT_RE.exec(agent) : null
  return m ? m[1] : null
}

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

// ------------------------------------------------------ session registry
//
// One JSON file per session under <git-common-dir>/opencode-pipeline/sessions.
// Root sessions carry the baseline, the claimed files and the liveness data;
// child sessions only point to their root.

const sessionsDir = (info) => path.join(info.stateDir, "sessions")

export function readSession(info, id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(sessionsDir(info), `${safeId(id)}.json`), "utf8"))
  } catch {
    return null
  }
}

export function writeSession(info, rec) {
  // Never resurrect a repository that was removed while the session was running.
  if (!fs.existsSync(info.common)) return
  const dir = sessionsDir(info)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${safeId(rec.sessionId)}.json`)
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(rec))
  fs.renameSync(tmp, file)
}

export function listSessions(info) {
  let names = []
  try {
    names = fs.readdirSync(sessionsDir(info))
  } catch {
    return []
  }
  const out = []
  for (const n of names) {
    if (!n.endsWith(".json")) continue
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(sessionsDir(info), n), "utf8")))
    } catch {
      /* ignore partial/corrupt files */
    }
  }
  return out
}

export function removeStaleSessions(info, now = Date.now(), maxAgeMs = 7 * 24 * 3600 * 1000) {
  for (const rec of listSessions(info)) {
    if (!pidAlive(rec.pid) && now - (rec.updatedAt || 0) > maxAgeMs) {
      try {
        fs.unlinkSync(path.join(sessionsDir(info), `${safeId(rec.sessionId)}.json`))
      } catch {
        /* ignore */
      }
    }
  }
}

export function isLive(rec, now = Date.now()) {
  return Boolean(rec && rec.busy && pidAlive(rec.pid) && now - (rec.updatedAt || 0) < LIVE_TTL_MS)
}

/** Resolve the root record for a session id (child or root). */
export function rootRecordFor(info, sessionId) {
  const rec = readSession(info, sessionId)
  if (!rec) return null
  if (rec.rootId && rec.rootId !== rec.sessionId) return readSession(info, rec.rootId)
  return rec
}

export function toRel(info, p) {
  const abs = realpathLoose(path.resolve(info.top, p))
  if (!isInside(info.top, abs)) return null
  return path.relative(info.top, abs).split(path.sep).join("/")
}

export function conflictingClaims(info, rootId, rel, now = Date.now()) {
  return listSessions(info)
    .filter((r) => r.sessionId === r.rootId && r.sessionId !== rootId && isLive(r, now) && r.files && r.files[rel])
    .map((r) => ({ sessionId: r.sessionId, agent: r.agent, claimedAt: r.files[rel] }))
}

// --------------------------------------------------------------- locking

/** Cross-process mutual exclusion on a named lock (mkdir is atomic). */
export async function withLock(info, name, fn, { timeoutMs = 300000, staleMs = 20 * 60 * 1000, owner = String(process.pid) } = {}) {
  const dir = path.join(info.stateDir, "locks")
  fs.mkdirSync(dir, { recursive: true })
  const lock = path.join(dir, `${name}.lock`)
  const started = Date.now()
  for (;;) {
    try {
      fs.mkdirSync(lock)
      fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid, owner, at: Date.now() }))
      break
    } catch (e) {
      if (e.code !== "EEXIST") throw e
      let holder = null
      try {
        holder = JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8"))
      } catch {
        /* lock being created */
      }
      const dead = holder && !pidAlive(holder.pid)
      const old = holder && Date.now() - holder.at > staleMs
      if (dead || old) {
        fs.rmSync(lock, { recursive: true, force: true })
        continue
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
    fs.rmSync(lock, { recursive: true, force: true })
  }
}

// ----------------------------------------------------------- commit plan

function normalizeRel(info, p) {
  if (typeof p !== "string" || !p.trim()) return null
  const rel = toRel(info, p.trim())
  if (!rel || rel === ".git" || rel.startsWith(".git/") || isInternalPath(rel)) return null
  return rel
}

/**
 * Decide what a scoped commit may contain.
 *  commit      : files the session touched (claimed ∪ expected) that are really changed
 *  conflicts   : touched files that were ALREADY dirty before the session (cannot be split)
 *  notChanged  : listed files with no change
 *  unattributed: changed files that no one claimed and that were not dirty before
 *  rejected    : listed paths that are invalid or outside the repository
 */
export function planCommit(info, rootRec, expected = []) {
  const items = changedFiles(info)
  const byPath = new Map()
  for (const it of items) {
    byPath.set(it.path, it)
    if (it.orig) byPath.set(it.orig, it)
  }
  const claimed = Object.keys((rootRec && rootRec.files) || {})
  const baselineDirty = new Set((rootRec && rootRec.baseline && rootRec.baseline.dirty) || [])
  const rejected = []
  const wanted = new Set()
  for (const p of claimed) wanted.add(p)
  for (const p of expected) {
    const rel = normalizeRel(info, p)
    if (rel) wanted.add(rel)
    else rejected.push(p)
  }
  const commit = new Set()
  const conflicts = []
  const notChanged = []
  for (const p of wanted) {
    const it = byPath.get(p)
    if (!it) notChanged.push(p)
    else if (baselineDirty.has(p) || (it.orig && baselineDirty.has(it.orig))) conflicts.push(p)
    else {
      commit.add(it.path)
      if (it.orig) commit.add(it.orig)
    }
  }
  const unattributed = items
    .filter((it) => !wanted.has(it.path) && !baselineDirty.has(it.path))
    .map((it) => it.path)
  return {
    commit: [...commit].sort(),
    conflicts: conflicts.sort(),
    notChanged: notChanged.sort(),
    unattributed: unattributed.sort(),
    rejected,
    claimedOnly: claimed.filter((p) => !(expected || []).some((e) => normalizeRel(info, e) === p)).sort(),
  }
}

/** Stage explicit paths and commit ONLY them (other staged content is left untouched). */
export function executeCommit(info, plan, message, trailers = []) {
  if (!plan.commit.length) throw new Error("nothing to commit")
  const cwd = info.top
  for (const p of plan.commit) {
    if (fs.existsSync(path.join(cwd, p))) git(cwd, ["add", "--", p])
    else git(cwd, ["rm", "--cached", "-q", "--ignore-unmatch", "--", p]) // deletion (or rename source)
  }
  const args = ["commit", "-m", message]
  for (const t of trailers) args.push("-m", t)
  args.push("--", ...plan.commit)
  git(cwd, args)
  const hash = gitT(cwd, ["rev-parse", "--short", "HEAD"])
  const committed = git(cwd, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "HEAD"])
    .split("\0")
    .filter(Boolean)
    .sort()
  const expected = new Set(plan.commit)
  const unexpected = committed.filter((p) => !expected.has(p))
  return { hash, committed, unexpected }
}

// ------------------------------------------------------------ bash guard

const WRAPPERS = new Set(["env", "command", "time", "nohup", "exec", "builtin", "xargs", "nice", "setsid", "stdbuf", "timeout", "gtimeout"])
const NEVER = new Set(["sudo", "doas", "su"])

const GIT_READ = new Set([
  "status", "diff", "log", "show", "ls-files", "rev-parse", "blame", "grep", "ls-tree", "cat-file",
  "describe", "shortlog", "rev-list", "for-each-ref", "merge-base", "name-rev", "diff-tree", "diff-index",
  "show-ref", "check-ignore", "count-objects", "version", "help", "whatchanged", "ls-remote", "show-branch",
])
const GIT_ALWAYS_BLOCKED_CFG = /^(alias\.|core\.(hookspath|sshcommand|editor|pager|fsmonitor)|credential\.|url\.|http\.)/i

/**
 * Tokenize a shell command into segments (best effort, not a full parser).
 * Returns { segments: string[][], redirects: string[], nested: string[] }.
 */
export function tokenize(command) {
  const segments = []
  const redirects = []
  const nested = []
  let tokens = []
  let cur = ""
  let has = false
  let expectRedirect = false
  const pendingHeredocs = []
  const pushToken = () => {
    if (!has) return
    if (expectRedirect) {
      redirects.push(cur)
      expectRedirect = false
    } else {
      tokens.push(cur)
    }
    cur = ""
    has = false
  }
  const pushSegment = () => {
    pushToken()
    if (tokens.length) segments.push(tokens)
    tokens = []
  }
  const grabNested = (i, open, close) => {
    let depth = 1
    let j = i
    while (j < command.length && depth > 0) {
      const ch = command[j]
      if (ch === open && open !== close) depth++
      else if (ch === close) depth--
      j++
    }
    nested.push(command.slice(i, depth === 0 ? j - 1 : j))
    return j
  }
  let i = 0
  let quote = null
  while (i < command.length) {
    const c = command[i]
    if (quote === "'") {
      if (c === "'") quote = null
      else cur += c
      i++
      continue
    }
    if (c === "\\" && quote !== "'") {
      if (i + 1 < command.length) {
        cur += command[i + 1]
        has = true
      }
      i += 2
      continue
    }
    if (quote === '"') {
      if (c === '"') quote = null
      else if (c === "$" && command[i + 1] === "(") {
        i = grabNested(i + 2, "(", ")")
        cur += "$(…)"
        continue
      } else if (c === "`") {
        i = grabNested(i + 1, "`", "`")
        cur += "$(…)"
        continue
      } else cur += c
      i++
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      has = true
      i++
      continue
    }
    if (c === "$" && command[i + 1] === "(") {
      i = grabNested(i + 2, "(", ")")
      cur += "$(…)"
      has = true
      continue
    }
    if (c === "`") {
      i = grabNested(i + 1, "`", "`")
      cur += "$(…)"
      has = true
      continue
    }
    if (c === "#" && !has) {
      while (i < command.length && command[i] !== "\n") i++
      continue
    }
    if (c === "$" && command[i + 1] === "{") {
      const end = command.indexOf("}", i)
      const stop = end < 0 ? command.length : end + 1
      cur += command.slice(i, stop)
      has = true
      i = stop
      continue
    }
    if (c === "\n" && pendingHeredocs.length) {
      pushSegment()
      i++
      for (const delim of pendingHeredocs.splice(0)) {
        while (i < command.length) {
          let e = command.indexOf("\n", i)
          if (e < 0) e = command.length
          const lineText = command.slice(i, e).trim()
          i = Math.min(e + 1, command.length)
          if (lineText === delim) break
        }
      }
      continue
    }
    if (c === "\n" || c === ";" || c === "(" || c === ")") {
      pushSegment()
      i++
      continue
    }
    if (c === "|" || c === "&") {
      if (c === "&" && command[i + 1] === ">") {
        pushToken()
        i += command[i + 2] === ">" ? 3 : 2
        expectRedirect = true
        continue
      }
      pushSegment()
      i += command[i + 1] === c ? 2 : 1
      continue
    }
    if (c === ">" || c === "<") {
      if (has && /^\d+$/.test(cur)) {
        cur = ""
        has = false
      } else pushToken()
      let j = i + 1
      if (command[j] === ">" || command[j] === "|") j++
      if (c === ">" && command[j] === "&") {
        // fd duplication (>&2, >&-): no file target
        j++
        while (j < command.length && /[0-9-]/.test(command[j])) j++
        i = j
        continue
      }
      if (c === "<" && command[j] === "<") {
        // heredoc (<<EOF, <<-EOF, <<'EOF') or herestring (<<<): skip the delimiter token
        j++
        const herestring = command[j] === "<"
        if (herestring) j++
        if (command[j] === "-") j++
        while (command[j] === " ") j++
        let delim = ""
        while (j < command.length && !/[\s;&|)]/.test(command[j])) {
          if (command[j] !== "'" && command[j] !== '"' && command[j] !== "\\") delim += command[j]
          j++
        }
        if (!herestring && delim) pendingHeredocs.push(delim)
        i = j
        continue
      }
      i = j
      expectRedirect = c === ">"
      if (c === "<") {
        // input redirect: consume its target without checking
        while (command[i] === " ") i++
        while (i < command.length && !/[\s;&|]/.test(command[i])) i++
      }
      continue
    }
    if (c === " " || c === "\t") {
      pushToken()
      i++
      continue
    }
    cur += c
    has = true
    i++
  }
  pushSegment()
  return { segments, redirects, nested }
}

function expandArg(arg, ctx) {
  let a = arg
  if (a === "~" || a.startsWith("~/")) a = os.homedir() + a.slice(1)
  a = a.replace(/^\$\{?HOME\}?(?=\/|$)/, os.homedir())
  if (ctx.scratch) a = a.replace(/^\$\{?(TMPDIR|PIPELINE_SCRATCH)\}?(?=\/|$)/, ctx.scratch)
  return a
}

/** Returns null if the path is acceptable (or unresolvable), else a reason string. */
export function checkWritePath(arg, ctx) {
  if (typeof arg !== "string" || !arg) return null
  if (/^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/.test(arg)) return null
  let a = expandArg(arg, ctx)
  if (a.includes("$")) return null // unknown variable: cannot decide
  const glob = a.search(/[*?[]/)
  if (glob >= 0) a = a.slice(0, glob) || "."
  const abs = realpathLoose(path.resolve(ctx.cwd || ctx.info.top, a))
  const scratch = ctx.scratch ? realpathLoose(ctx.scratch) : null
  if (scratch && isInside(scratch, abs)) return null
  const internals = `"${arg}" is inside the git internals. Do not modify .git; use the scratch directory for throwaway files.`
  if (isInside(ctx.info.top, abs)) {
    return isInside(path.join(ctx.info.top, ".git"), abs) ? internals : null
  }
  if (isInside(ctx.info.common, abs) || isInside(ctx.info.gitDir, abs)) return internals
  return `"${arg}" resolves outside the repository (${abs}). Stay inside the repo; throwaway files go in $PIPELINE_SCRATCH${scratch ? ` (${scratch})` : ""}.`
}

function nonFlags(args) {
  return args.filter((a) => !a.startsWith("-"))
}

function checkGitCommand(args, role, ctx) {
  let i = 0
  while (i < args.length) {
    const a = args[i]
    if (a === "-C") {
      const d = args[i + 1]
      if (d !== undefined && checkWritePath(d, ctx)) return `git -C ${d} points outside the repository.`
      i += 2
      continue
    }
    if (a === "-c") {
      const v = args[i + 1] || ""
      if (GIT_ALWAYS_BLOCKED_CFG.test(v)) return `git -c ${v.split("=")[0]} is not allowed.`
      i += 2
      continue
    }
    if (a.startsWith("--git-dir") || a.startsWith("--work-tree") || a === "--bare") {
      return `${a.split("=")[0]} is not allowed: operate on the repository you were started in.`
    }
    if (a.startsWith("-")) {
      i++
      continue
    }
    break
  }
  const sub = args[i]
  if (sub === undefined) return null
  const rest = args.slice(i + 1)
  const hint = " Branches, worktrees, stashes, resets and commits are managed by the pipeline; report what you need instead."
  const deny = (what) => `git ${what} is not allowed for ${role || "this agent"} in a pipeline session.${hint}`
  if (GIT_READ.has(sub)) {
    if ((sub === "diff" || sub === "show" || sub === "log") && rest.some((r) => r.startsWith("--output"))) return deny(`${sub} --output`)
    return null
  }
  switch (sub) {
    case "branch": {
      const mutating = ["-d", "-D", "-m", "-M", "-c", "-C", "-f", "-u", "--delete", "--move", "--copy", "--force", "--set-upstream-to", "--unset-upstream", "--edit-description"]
      if (rest.some((r) => mutating.includes(r))) return deny("branch (renaming, deleting or reconfiguring)")
      const listing = ["--show-current", "--list", "-l", "-a", "-r", "-v", "-vv", "--all", "--remotes", "--contains", "--merged", "--no-merged"]
      return rest.length === 0 || rest.some((r) => listing.includes(r)) ? null : deny("branch (creating)")
    }
    case "tag":
      return rest.length === 0 || rest[0] === "-l" || rest[0] === "--list" ? null : deny("tag")
    case "config":
      return rest.some((r) => ["--get", "--get-all", "--list", "-l", "--get-regexp"].includes(r)) ? null : deny("config (writing)")
    case "remote":
      return rest.length === 0 || rest[0] === "-v" || rest[0] === "show" || rest[0] === "get-url" ? null : deny("remote (modifying)")
    case "stash":
      return rest[0] === "list" || rest[0] === "show" ? null : deny("stash")
    case "worktree":
      return rest[0] === "list" ? null : deny("worktree")
    case "reflog":
      return rest.length === 0 || rest[0] === "show" ? null : deny("reflog (modifying)")
    case "add":
    case "commit":
    case "restore": {
      if (role !== "post_session") return deny(sub)
      const flags = rest.filter((r) => r.startsWith("-"))
      if (sub === "add" && rest.some((r) => ["-A", "--all", "-u", "--update", "-p", "--patch", "-i", "--interactive", "."].includes(r))) {
        return "git add must list explicit file paths (no -A, -u, -p, -i or '.')."
      }
      if (sub === "commit" && flags.some((f) => ["--amend", "-a", "--all", "--no-verify", "-n"].includes(f) || /^-[a-zA-Z]*a[a-zA-Z]*$/.test(f))) {
        return "git commit must not use --amend, -a/--all or --no-verify."
      }
      if (sub === "restore" && !flags.some((f) => f === "--staged" || f === "-S")) return "git restore is only allowed with --staged."
      return null
    }
    default:
      return deny(sub)
  }
}

function checkSegment(tokens, role, ctx) {
  let t = tokens.slice()
  for (;;) {
    while (t.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0])) t.shift()
    if (t.length && WRAPPERS.has(t[0])) {
      const wrapper = t.shift()
      while (t.length && (t[0].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0]))) t.shift()
      if ((wrapper === "timeout" || wrapper === "gtimeout") && t.length) t.shift()
      continue
    }
    break
  }
  if (!t.length) return null
  const cmd = path.basename(t[0])
  const args = t.slice(1)
  if (NEVER.has(cmd)) return `${cmd} is not allowed.`
  if (cmd === "git") return checkGitCommand(args, role, ctx)
  if (cmd === "cd" || cmd === "pushd") {
    const target = args.find((a) => !a.startsWith("-"))
    if (target && checkWritePath(target, ctx)) return `cd "${target}" leaves the repository. Stay inside the repo.`
    return null
  }
  const paths = []
  const dest = (list) => (list.length ? [list[list.length - 1]] : [])
  switch (cmd) {
    case "rm": case "rmdir": case "mkdir": case "touch": case "truncate": case "chmod":
    case "chown": case "chgrp": case "tee": case "unlink": case "shred": case "mktemp":
      paths.push(...(cmd === "chmod" || cmd === "chown" || cmd === "chgrp" ? nonFlags(args).slice(1) : nonFlags(args)))
      break
    case "mv":
      paths.push(...nonFlags(args))
      break
    case "cp": case "ln": case "install": case "rsync": case "ditto":
      paths.push(...dest(nonFlags(args)))
      break
    case "dd":
      for (const a of args) if (a.startsWith("of=")) paths.push(a.slice(3))
      break
    case "curl":
      for (let k = 0; k < args.length; k++) {
        if (args[k] === "-o" || args[k] === "--output" || args[k] === "--output-dir") paths.push(args[k + 1])
        else if (args[k].startsWith("--output=")) paths.push(args[k].slice(9))
      }
      break
    case "wget":
      for (let k = 0; k < args.length; k++) {
        if (args[k] === "-O" || args[k] === "-P" || args[k] === "--directory-prefix") paths.push(args[k + 1])
        else if (args[k].startsWith("--output-document=")) paths.push(args[k].slice(18))
      }
      break
    case "tar":
      for (let k = 0; k < args.length; k++) if (args[k] === "-C" || args[k] === "--directory") paths.push(args[k + 1])
      break
    case "unzip":
      for (let k = 0; k < args.length; k++) if (args[k] === "-d") paths.push(args[k + 1])
      break
    case "sed": case "perl":
      if (args.some((a) => /^-[a-zA-Z]*i/.test(a) || a === "-i" || a.startsWith("--in-place"))) {
        paths.push(...nonFlags(args).filter((a) => a.startsWith("/") || a.startsWith("~")))
      }
      break
    default:
      break
  }
  for (const p of paths) {
    const reason = checkWritePath(p, ctx)
    if (reason) return `${cmd}: ${reason}`
  }
  return null
}

/**
 * Check a bash command issued by a pipeline agent.
 * ctx: { info, cwd, scratch }, role: pipeline role such as "executor".
 * Returns null when acceptable, otherwise a human-readable reason.
 */
export function checkBash(command, role, ctx, depth = 0) {
  if (typeof command !== "string" || depth > 4) return null
  let parsed
  try {
    parsed = tokenize(command)
  } catch {
    return null
  }
  for (const target of parsed.redirects) {
    const reason = checkWritePath(target, ctx)
    if (reason) return `output redirection to ${reason}`
  }
  for (const seg of parsed.segments) {
    const reason = checkSegment(seg, role, ctx)
    if (reason) return reason
  }
  for (const inner of parsed.nested) {
    const reason = checkBash(inner, role, ctx, depth + 1)
    if (reason) return reason
  }
  return null
}

/** Paths written by an edit/write/apply_patch style tool call. */
export function editTargets(tool, args) {
  if (!args || typeof args !== "object") return []
  if (tool === "edit" || tool === "write" || tool === "multiedit") {
    return typeof args.filePath === "string" ? [args.filePath] : []
  }
  if (tool === "apply_patch" || tool === "patch") {
    const text = typeof args.patchText === "string" ? args.patchText : typeof args.patch === "string" ? args.patch : ""
    const out = []
    for (const m of text.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/gm)) out.push(m[1].trim())
    for (const m of text.matchAll(/^\*\*\* Move to:\s*(.+)$/gm)) out.push(m[1].trim())
    return out
  }
  return []
}

export const FILE_WRITE_TOOLS = new Set(["edit", "write", "multiedit", "apply_patch", "patch"])
