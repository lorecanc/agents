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
import { randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"

// ---------------------------------------------------------------- basics

export const PIPELINE_AGENT_RE = /^(?:[A-Za-z0-9_-]+-)?pipeline-([A-Za-z0-9_]+)$/
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
  const kept = new Set()
  for (const rec of listSessions(info)) {
    if (!pidAlive(rec.pid) && now - (rec.updatedAt || 0) > maxAgeMs) {
      try {
        fs.unlinkSync(path.join(sessionsDir(info), `${safeId(rec.sessionId)}.json`))
      } catch {
        /* ignore */
      }
      try {
        if (rec.sessionId === rec.rootId) fs.unlinkSync(activityLogPath(info, rec.sessionId))
      } catch {
        /* ignore */
      }
    } else if (rec.rootId) kept.add(rec.rootId)
  }
  // Orphan logs (no session record left) are removed once they are old enough.
  let names = []
  try {
    names = fs.readdirSync(logsDir(info))
  } catch {
    return
  }
  for (const n of names) {
    if (!n.endsWith(".jsonl") || kept.has(n.slice(0, -6))) continue
    const file = path.join(logsDir(info), n)
    try {
      if (now - fs.statSync(file).mtimeMs > maxAgeMs) fs.unlinkSync(file)
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------- activity log
//
// One JSONL file per root session under <git-common-dir>/opencode-pipeline/logs/<rootId>.jsonl,
// written by the guard plugin: tool calls (ok / error / denied), guard blocks, permission events and
// per-session step counts. It is recorded data for post-mortems, never instructions.

export const ACTIVITY_MAX_BYTES = 512 * 1024
const DENIAL_RE = /permission|denied|rejected|prevents you from using|not permitted/i

function logsDir(info) {
  return path.join(info.stateDir, "logs")
}

export function activityLogPath(info, rootId) {
  return path.join(logsDir(info), `${safeId(rootId)}.jsonl`)
}

/** True when a tool error text looks like a permission denial (user reject or a deny rule). */
export function isDenialText(text) {
  return typeof text === "string" && DENIAL_RE.test(text)
}

/** Redact and truncate free text before it is logged. */
export function clipText(text, max = 300) {
  if (text === undefined || text === null) return undefined
  const red = redact(typeof text === "string" ? text : String(text))
  return red.length > max ? `${red.slice(0, max)}...` : red
}

/**
 * Append one event. Never throws. When the file would exceed maxBytes, the oldest half of the
 * events is dropped and a `truncated` marker records how many.
 */
export function appendActivity(info, rootId, event, { maxBytes = ACTIVITY_MAX_BYTES } = {}) {
  try {
    if (!info || !rootId || !fs.existsSync(info.common)) return false
    const file = activityLogPath(info, rootId)
    fs.mkdirSync(logsDir(info), { recursive: true })
    const line = `${JSON.stringify({ at: Date.now(), ...event })}\n`
    let size = 0
    try {
      size = fs.statSync(file).size
    } catch {
      size = 0
    }
    if (size + line.length <= maxBytes) {
      fs.appendFileSync(file, line)
      return true
    }
    let dropped = 0
    const rows = []
    for (const l of fs.readFileSync(file, "utf8").split("\n")) {
      if (!l) continue
      const m = /^\{"at":\d+,"type":"truncated","dropped":(\d+)\}$/.exec(l)
      if (m) dropped += Number(m[1])
      else rows.push(l)
    }
    const keep = rows.slice(Math.ceil(rows.length / 2))
    dropped += rows.length - keep.length
    const marker = JSON.stringify({ at: Date.now(), type: "truncated", dropped })
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(tmp, `${[marker, ...keep].join("\n")}\n${line}`)
    fs.renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

export function readActivity(info, rootId) {
  let body = ""
  try {
    body = fs.readFileSync(activityLogPath(info, rootId), "utf8")
  } catch {
    return []
  }
  const out = []
  for (const l of body.split("\n")) {
    if (!l) continue
    try {
      out.push(JSON.parse(l))
    } catch {
      /* partial line */
    }
  }
  return out
}

const isReject = (d) => typeof d === "string" && /^(reject|rejected|deny|denied)$/i.test(d)

/** Aggregate activity events (see appendActivity) for pipeline_state. */
export function summarizeActivity(events, { lastN = 30 } = {}) {
  const perAgent = {}
  const subagents = new Map()
  const agentStats = (e) => {
    const name = e.agent || "unknown"
    if (!perAgent[name]) perAgent[name] = { tool_calls: 0, errors: 0, denied: 0, guard_blocks: 0, sessions: new Set() }
    if (e.sessionId) perAgent[name].sessions.add(e.sessionId)
    return perAgent[name]
  }
  const sub = (e) => {
    if (!e.sessionId) return null
    if (!subagents.has(e.sessionId)) subagents.set(e.sessionId, { session: e.sessionId, agent: e.agent || null, tool_calls: 0, llm_calls: null })
    const s = subagents.get(e.sessionId)
    if (!s.agent && e.agent) s.agent = e.agent
    return s
  }
  const denied = []
  const guardBlocks = []
  const errorsByTool = {}
  const permissions = { asked: 0, replied: {} }
  const deniedCalls = new Set()
  let errors = 0
  let dropped = 0
  for (const e of events) {
    if (!e || typeof e !== "object") continue
    if (e.type === "truncated") dropped += Number(e.dropped) || 0
    else if (e.type === "tool") {
      const a = agentStats(e)
      a.tool_calls++
      const s = sub(e)
      if (s) s.tool_calls++
      if (e.ok === false) {
        a.errors++
        errors++
        const t = e.tool || "unknown"
        errorsByTool[t] = (errorsByTool[t] || 0) + 1
      }
      if (e.denied) {
        a.denied++
        if (e.callId) deniedCalls.add(e.callId)
        denied.push({ at: e.at, agent: e.agent || null, session: e.sessionId || null, tool: e.tool || null, command: e.command ?? null, reason: e.error ?? null, source: "tool_error" })
      }
    } else if (e.type === "guard_block") {
      const a = agentStats(e)
      a.tool_calls++
      a.guard_blocks++
      const s = sub(e)
      if (s) s.tool_calls++
      guardBlocks.push({ at: e.at, agent: e.agent || null, session: e.sessionId || null, tool: e.tool || null, command: e.command ?? null, reason: e.reason ?? null })
    } else if (e.type === "permission") {
      if (e.decision === undefined || e.decision === null) permissions.asked++
      else permissions.replied[e.decision] = (permissions.replied[e.decision] || 0) + 1
      if (isReject(e.decision) && !(e.callId && deniedCalls.has(e.callId))) {
        agentStats(e).denied++
        denied.push({ at: e.at, agent: e.agent || null, session: e.sessionId || null, tool: e.permission || null, command: e.pattern ?? null, reason: `permission ${e.decision}`, source: "permission" })
      }
    } else if (e.type === "steps") {
      const s = sub(e)
      if (s && Number.isFinite(e.llm_calls)) s.llm_calls = e.llm_calls
      // after truncation the counter in the steps event is more complete than the surviving tool events
      if (s && Number.isFinite(e.tool_calls)) s.tool_calls = Math.max(s.tool_calls, e.tool_calls)
    }
  }
  const per = {}
  for (const [name, a] of Object.entries(perAgent)) per[name] = { ...a, sessions: a.sessions.size }
  return {
    events: events.length,
    ...(dropped ? { dropped_old_events: dropped } : {}),
    per_agent: per,
    subagents: [...subagents.values()],
    errors: { total: errors, by_tool: errorsByTool },
    denied: denied.slice(-lastN),
    guard_blocks: guardBlocks.slice(-lastN),
    permissions,
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
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"])
const NEVER = new Set(["sudo", "doas", "su", "pkexec", "sudoedit"])

const GIT_READ = new Set([
  "status", "diff", "log", "show", "ls-files", "rev-parse", "blame", "grep", "ls-tree", "cat-file",
  "describe", "shortlog", "rev-list", "for-each-ref", "merge-base", "name-rev", "diff-tree", "diff-index",
  "show-ref", "check-ignore", "count-objects", "version", "help", "whatchanged", "ls-remote", "show-branch",
  "range-diff", "cherry", "var", "verify-commit", "verify-tag",
])
const GIT_ALWAYS_BLOCKED_CFG = /^(alias\.|core\.(hookspath|sshcommand|editor|pager|fsmonitor)|credential\.|url\.|http\.|protocol\.)/i
const GIT_SYNC_ROLES = new Set(["ops", "fast_lane", "executor", "refactorer"])
const GIT_SAFE_EDITOR_CFG = /^core\.editor=(true|:|\/(?:usr\/)?bin\/true)$/i

/**
 * Tokenize a shell command into segments (best effort, not a full parser).
 * Returns { segments: string[][], redirects: string[], nested: string[] }.
 */
export function tokenize(command) {
  const segments = []
  const redirects = []
  const segmentRedirects = []
  const nested = []
  let tokens = []
  let curRedirects = []
  let cur = ""
  let has = false
  let expectRedirect = false
  let invalidAnsiC = false
  const pendingHeredocs = []
  const pushToken = () => {
    if (!has) return
    if (expectRedirect) {
      redirects.push(cur)
      curRedirects.push(cur)
      expectRedirect = false
    } else {
      tokens.push(cur)
    }
    cur = ""
    has = false
  }
  const pushSegment = () => {
    pushToken()
    if (tokens.length || curRedirects.length) {
      segments.push(tokens)
      segmentRedirects.push(curRedirects)
    }
    tokens = []
    curRedirects = []
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
    if (quote === null && c === "$" && command[i + 1] === "'") {
      let j = i + 2
      let value = ""
      let closed = false
      while (j < command.length) {
        const ch = command[j]
        if (ch === "'") {
          closed = true
          j++
          break
        }
        if (ch !== "\\") {
          value += ch
          j++
          continue
        }
        j++
        if (j >= command.length) break
        const escaped = command[j]
        const simpleEscapes = {
          "\\": "\\", "'": "'", '"': '"', n: "\n", r: "\r", t: "\t",
          v: "\v", f: "\f", b: "\b", a: "\x07", e: "\x1b", E: "\x1b",
        }
        if (Object.hasOwn(simpleEscapes, escaped)) {
          value += simpleEscapes[escaped]
          j++
          continue
        }
        const digitCount = escaped === "x" ? 2 : escaped === "u" ? 4 : escaped === "U" ? 8 : 0
        if (digitCount) {
          let end = j + 1
          while (end < command.length && end <= j + digitCount && /[0-9a-fA-F]/.test(command[end])) end++
          if (end === j + 1) {
            invalidAnsiC = true
            break
          }
          const codePoint = Number.parseInt(command.slice(j + 1, end), 16)
          if (codePoint > 0x10ffff) {
            invalidAnsiC = true
            break
          }
          value += String.fromCodePoint(codePoint)
          j = end
          continue
        }
        if (/[0-7]/.test(escaped)) {
          let end = j + 1
          while (end < command.length && end < j + 3 && /[0-7]/.test(command[end])) end++
          value += String.fromCharCode(Number.parseInt(command.slice(j, end), 8))
          j = end
          continue
        }
        invalidAnsiC = true
        break
      }
      if (!closed) invalidAnsiC = true
      cur += value
      has = true
      i = j
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
  return { segments, redirects, segmentRedirects, nested, invalidAnsiC }
}

function expandArg(arg, ctx) {
  let a = arg
  if (a === "~" || a.startsWith("~/")) a = os.homedir() + a.slice(1)
  a = a.replace(/^\$\{?HOME\}?(?=\/|$)/, os.homedir())
  if (ctx.scratch) a = a.replace(/^\$\{?(TMPDIR|PIPELINE_SCRATCH)\}?(?=\/|$)/, ctx.scratch)
  return a
}

function isSystemTempPath(rawArg, absPath, top) {
  if (typeof rawArg !== "string" || !path.isAbsolute(rawArg) || rawArg.trim().startsWith("~")) return false
  if (isInside(top, path.resolve(top, rawArg))) return false
  if (isInside(top, absPath)) return false
  const tempRoots = ["/tmp", "/private/tmp", os.tmpdir(), realpathLoose("/tmp"), realpathLoose(os.tmpdir())]
  return tempRoots.some((root) => {
    const tempRoot = realpathLoose(root)
    if (!isInside(tempRoot, absPath) || absPath === tempRoot) return false
    if (isInside(tempRoot, top) && (isInside(absPath, top) || path.relative(tempRoot, absPath).split(path.sep)[0].startsWith("pipe-"))) return false
    return true
  })
}

/** Returns null if the path is acceptable (or unresolvable), else a reason string. */
export function checkWritePath(arg, ctx) {
  if (typeof arg !== "string" || !arg) return null
  if (/^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/.test(arg)) return null
  let a = expandArg(arg, ctx)
  if (a.includes("$")) return null // unknown variable: cannot decide
  const expanded = a
  const glob = a.search(/[*?[]/)
  if (glob >= 0) a = a.slice(0, glob) || "."
  const abs = realpathLoose(path.resolve(ctx.cwd || ctx.info.top, a))
  const scratch = ctx.scratch ? realpathLoose(ctx.scratch) : null
  if (scratch && isInside(scratch, abs)) return null
  if (isSystemTempPath(String(arg).trim().startsWith("~") ? "" : expanded, abs, ctx.info.top)) return null
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

function shellCommandArg(cmd, args) {
  if (!SHELLS.has(cmd)) return null
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--") break
    if (arg === "-c" || /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg)) return typeof args[i + 1] === "string" ? args[i + 1] : null
    if (/^[-+][oO]$/.test(arg)) i++
    else if (arg.startsWith("-") || arg.startsWith("+")) continue
    else break
  }
  return null
}

function stripWrappers(tokens) {
  const t = tokens.slice()
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
  return t
}

function inPlaceTargets(cmd, args) {
  if (!args.some((a) => /^-[a-zA-Z]*i/.test(a) || a === "-i" || a.startsWith("--in-place"))) return []
  const positional = []
  let hasExplicitScript = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "-e" || arg === "-f") {
      hasExplicitScript = true
      i++
    } else if (arg === "-i" && args[i + 1] === "") {
      i++
    } else if (arg.startsWith("-") || arg.startsWith("+")) {
      continue
    } else if (arg !== "") positional.push(arg)
  }
  if (hasExplicitScript) return positional
  if (positional.length <= 1) return []
  let scriptIndex = 0
  if (positional.length >= 3 && /^\.[^/]*$/.test(positional[0])) scriptIndex = 1
  return positional.slice(scriptIndex + 1)
}

function segmentWritePaths(tokens) {
  const t = stripWrappers(tokens)
  if (!t.length) return { rawPaths: [], subcommands: [], cwdChange: null }
  const cmd = path.basename(t[0])
  const args = t.slice(1)
  const rawPaths = []
  const subcommands = []
  let cwdChange = null
  const dest = (list) => (list.length ? [list[list.length - 1]] : [])
  if (SHELLS.has(cmd)) {
    const subcmd = shellCommandArg(cmd, args)
    if (subcmd) subcommands.push(subcmd)
  }
  if (cmd === "cd" || cmd === "pushd") {
    cwdChange = args.find((a) => !a.startsWith("-")) || null
  }
  switch (cmd) {
    case "rm": case "rmdir": case "mkdir": case "touch": case "truncate": case "chmod":
    case "chown": case "chgrp": case "tee": case "unlink": case "shred": case "mktemp":
      rawPaths.push(...(cmd === "chmod" || cmd === "chown" || cmd === "chgrp" ? nonFlags(args).slice(1) : nonFlags(args)))
      break
    case "mv":
      rawPaths.push(...nonFlags(args))
      break
    case "cp": case "ln": case "install": case "rsync": case "ditto":
      rawPaths.push(...dest(nonFlags(args)))
      break
    case "dd":
      for (const a of args) if (a.startsWith("of=")) rawPaths.push(a.slice(3))
      break
    case "curl":
      for (let k = 0; k < args.length; k++) {
        if (["-o", "--output", "-D", "--dump-header", "-c", "--cookie-jar"].includes(args[k])) rawPaths.push(args[k + 1])
        else if (["--output", "--dump-header", "--cookie-jar"].some((flag) => args[k].startsWith(`${flag}=`))) rawPaths.push(args[k].slice(args[k].indexOf("=") + 1))
      }
      break
    case "wget":
      for (let k = 0; k < args.length; k++) {
        if (args[k] === "-O" || args[k] === "--output-document") rawPaths.push(args[k + 1])
        else if (args[k].startsWith("--output-document=")) rawPaths.push(args[k].slice(18))
      }
      break
    case "tar":
      for (let k = 0; k < args.length; k++) if (args[k] === "-C" || args[k] === "--directory") rawPaths.push(args[k + 1])
      break
    case "unzip":
      for (let k = 0; k < args.length; k++) if (args[k] === "-d") rawPaths.push(args[k + 1])
      break
    case "sed": case "perl":
      rawPaths.push(...inPlaceTargets(cmd, args))
      break
  }
  return { rawPaths, subcommands, cwdChange }
}

function isGitExplicitFile(file, ctx) {
  if (!file || file === "." || file === "./" || file === ".." || file.endsWith("/") || file.startsWith(":") || file.includes("$") || file.startsWith("~") || /[*?\[\]]/.test(file)) return false
  if (!ctx) return true
  if (checkWritePath(file, ctx)) return false
  try {
    const abs = realpathLoose(path.resolve(ctx.cwd || ctx.info.top, file))
    if (!isInside(ctx.info.top, abs) || fs.statSync(abs).isDirectory()) return false
  } catch {
    // New files can be staged before they exist.
  }
  return true
}

function gitFileArgs(args) {
  const separator = args.indexOf("--")
  return separator >= 0 ? args.slice(separator + 1) : args.filter((r) => !r.startsWith("-"))
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
    if (a === "-c" || (a.startsWith("-c") && a.length > 2)) {
      const v = a === "-c" ? args[i + 1] || "" : a.slice(2)
      if (GIT_ALWAYS_BLOCKED_CFG.test(v) && !GIT_SAFE_EDITOR_CFG.test(v)) return `git -c ${v.split("=")[0]} is not allowed.`
      i += a === "-c" ? 2 : 1
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
      return rest.length === 0 || rest[0] === "-v" || rest[0] === "--verbose" || rest[0] === "show" || rest[0] === "get-url" ? null : deny("remote (modifying)")
    case "fetch":
      return rest.some((r) => r === "--upload-pack" || r.startsWith("--upload-pack=") || r.startsWith("ext::")) ? deny("fetch --upload-pack or ext:: transport") : null
    case "pull":
      if (!GIT_SYNC_ROLES.has(role)) return deny("pull")
      return rest.some((r) => r === "--upload-pack" || r.startsWith("--upload-pack=") || r.startsWith("ext::")) ? deny("pull --upload-pack or ext:: transport")
        : rest.some((r) => ["--rebase=interactive", "--rebase=i", "-r=interactive", "-r=i"].includes(r)) ? deny("pull --rebase=interactive") : null
    case "merge":
    case "cherry-pick":
      if (!GIT_SYNC_ROLES.has(role)) return deny(sub)
      return rest.some((r) => r === "-e" || r === "--edit") ? deny(`${sub} --edit`) : null
    case "rebase":
      if (!GIT_SYNC_ROLES.has(role)) return deny("rebase")
      return rest.some((r) => r === "-i" || r === "--interactive" || r.startsWith("--interactive=") || r === "-x" || r === "--exec" || r.startsWith("--exec=") || (!r.startsWith("--") && r.startsWith("-") && (/[ix]/.test(r.slice(1).replace(/[^a-zA-Z].*$/, "")) || /^-[a-zA-Z]*x.+/.test(r)))) ? deny("rebase -i/--exec") : null
    case "checkout": {
      if (!GIT_SYNC_ROLES.has(role)) return deny("checkout")
      const conflictFlags = rest.some((r) => r === "--ours" || r === "--theirs" || r === "-m" || r === "--merge" || r.startsWith("--conflict="))
      const prohibitedFlags = rest.some((r) => ["-b", "-B", "-d", "--detach", "-f", "--force", "-p", "--patch", "-t", "--track", "--orphan"].includes(r) || (/^-[a-zA-Z]+$/.test(r) && /[bBdfpt]/.test(r)))
      const separator = rest.indexOf("--")
      const files = separator >= 0 ? rest.slice(separator + 1) : rest.filter((r) => !r.startsWith("-"))
      if (!conflictFlags || prohibitedFlags || !files.length || files.some((f) => !isGitExplicitFile(f, ctx))) return deny("checkout")
      return null
    }
    case "stash":
      return rest[0] === "list" || rest[0] === "show" ? null : deny("stash")
    case "worktree":
      return rest[0] === "list" ? null : deny("worktree")
    case "reflog":
      return rest.length === 0 || rest[0] === "show" ? null : deny("reflog (modifying)")
    case "add": {
      if (role !== "post_session" && !GIT_SYNC_ROLES.has(role)) return deny("add")
      const files = gitFileArgs(rest)
      if (rest.some((r) => ["-A", "--all", "--no-ignore-removal", "-u", "--update", "-p", "--patch", "-i", "--interactive"].includes(r) || (/^-[a-zA-Z]+$/.test(r) && /[Aupi]/.test(r))) || !files.length || files.some((f) => !isGitExplicitFile(f, ctx))) {
        return "git add requires explicit file paths (no -A, -u, -p, or .)"
      }
      return null
    }
    case "commit": {
      if (role !== "post_session") return deny("commit")
      const flags = rest.filter((r) => r.startsWith("-"))
      if (flags.some((f) => ["--amend", "-a", "--all", "--no-verify", "-n"].includes(f) || /^-[a-zA-Z]*a[a-zA-Z]*$/.test(f))) {
        return "git commit must not use --amend, -a/--all or --no-verify."
      }
      return null
    }
    case "restore": {
      const flags = rest.filter((r) => r.startsWith("-"))
      const files = gitFileArgs(rest)
      if (role === "post_session") return flags.some((f) => f === "--staged" || f === "-S") && files.length && files.every((f) => isGitExplicitFile(f, ctx)) ? null : "git restore is only allowed with --staged and explicit file paths."
      if (GIT_SYNC_ROLES.has(role)) {
        const conflictFlags = rest.some((r) => r === "--staged" || r === "-S" || r === "--ours" || r === "--theirs" || r === "--merge" || r === "-m" || r.startsWith("--conflict="))
        return conflictFlags && files.length && files.every((f) => isGitExplicitFile(f, ctx)) ? null : deny("restore (working-tree discard)")
      }
      return deny("restore (working-tree discard)")
    }
    default:
      return deny(sub)
  }
}

function checkSegment(tokens, role, ctx, depth = 0) {
  const t = stripWrappers(tokens)
  if (!t.length) return null
  const cmd = path.basename(t[0])
  const args = t.slice(1)
  if (SHELLS.has(cmd)) {
    const subcmd = shellCommandArg(cmd, args)
    if (subcmd) return checkBash(subcmd, role, ctx, depth + 1)
  }
  if (NEVER.has(cmd)) return `${cmd} is not allowed.`
  if (cmd === "rm" && args.some((a) => /^--(?:recursive|force)/.test(a) || /^-[^-]*[rRfF]/.test(a))) {
    return "recursive or forced rm is not allowed."
  }
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
      paths.push(...inPlaceTargets(cmd, args))
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
  if (typeof command !== "string") return null
  if (depth > 4) return "Shell command nesting exceeds the validation limit."
  let parsed
  try {
    parsed = tokenize(command)
  } catch {
    return null
  }
  if (parsed.invalidAnsiC) return "Unable to safely parse ANSI-C quoted string."
  let cwd = ctx.cwd || ctx.info.top
  for (let i = 0; i < parsed.segments.length; i++) {
    const segmentCtx = { ...ctx, cwd }
    for (const target of parsed.segmentRedirects[i] || []) {
      const reason = checkWritePath(target, segmentCtx)
      if (reason) return `output redirection to ${reason}`
    }
    const seg = parsed.segments[i]
    const reason = checkSegment(seg, role, segmentCtx, depth)
    if (reason) return reason
    const command = segmentWritePaths(seg)
    if (command.cwdChange) {
      const next = command.cwdChange === "-" ? cwd : path.resolve(cwd, expandArg(command.cwdChange, { scratch: ctx.scratch }))
      if (!next.includes("$")) cwd = next
    }
  }
  for (const inner of parsed.nested) {
    const reason = checkBash(inner, role, { ...ctx, cwd }, depth + 1)
    if (reason) return reason
  }
  return null
}

/** Repo-relative files a bash command may modify. */
export function bashWriteTargets(command, ctx, depth = 0) {
  if (typeof command !== "string" || depth > 4) return []
  const info = ctx?.info || ctx || {
    top: process.cwd(),
    gitDir: path.join(process.cwd(), ".git"),
    common: process.cwd(),
    isLinked: false,
  }
  if (!info.top) return []
  const baseCwd = ctx?.cwd || info.top
  const scratchPath = ctx?.scratch || info.scratchDir || scratchDir(info)
  let parsed
  try {
    parsed = tokenize(command)
  } catch {
    return []
  }
  const targets = new Set()
  let cwd = baseCwd
  const collect = (rawPaths, atCwd = cwd) => {
    for (const raw of rawPaths) {
      if (typeof raw !== "string" || !raw || raw === "-" || raw.startsWith("&") || raw.startsWith("/dev/")) continue
      const expanded = expandArg(raw, { scratch: scratchPath })
      if (expanded.includes("$")) continue
      const abs = realpathLoose(path.resolve(atCwd, expanded))
      if (isSystemTempPath(String(raw).trim().startsWith("~") ? "" : expanded, abs, info.top)) continue
      if (isInside(realpathLoose(scratchPath), abs)) continue
      if (info.gitDir && isInside(realpathLoose(info.gitDir), abs)) continue
      const rel = toRel(info, abs)
      if (rel && rel !== "") targets.add(rel)
    }
  }
  for (let i = 0; i < parsed.segments.length; i++) {
    const seg = parsed.segments[i]
    collect(parsed.segmentRedirects[i] || [], cwd)
    const result = segmentWritePaths(seg)
    collect(result.rawPaths, cwd)
    for (const sub of result.subcommands) {
      for (const rel of bashWriteTargets(sub, { ...ctx, info, cwd, scratch: scratchPath }, depth + 1)) targets.add(rel)
    }
    if (result.cwdChange) {
      const next = result.cwdChange === "-" ? cwd : path.resolve(cwd, expandArg(result.cwdChange, { scratch: scratchPath }))
      if (!next.includes("$")) cwd = next
    }
  }
  for (const inner of parsed.nested) {
    for (const rel of bashWriteTargets(inner, { ...ctx, info, cwd, scratch: scratchPath }, depth + 1)) targets.add(rel)
  }
  return [...targets]
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
