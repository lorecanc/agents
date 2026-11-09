// Core specific to the *-pipeline-* agent family.
//
// Used by:
//   - plugins/pipeline-guard/index.ts   (hooks: write guards, session registry, activity log)
//   - tools/pipeline_state.ts     (read-only change-set / baseline report)
//   - tools/pipeline_commit.ts    (deterministic, scoped commit)
//
// Shared primitives live in _repo.js (git, paths, lock), _sessions.js (session registry) and
// _bash_guard.js (bash / git / write guards).

import fs from "node:fs"
import path from "node:path"
import { changedFiles, git, gitT, isInternalPath, pidAlive, redact, safeId, toRel } from "./_repo.js"
import { deleteSession, isLive, listSessions } from "./_sessions.js"

// ---------------------------------------------------------------- basics

export const PIPELINE_AGENT_RE = /^(?:[A-Za-z0-9_-]+-)?pipeline-([A-Za-z0-9_]+)$/

export function isPipelineAgent(agent) {
  return typeof agent === "string" && PIPELINE_AGENT_RE.test(agent)
}

export function roleOf(agent) {
  const m = typeof agent === "string" ? PIPELINE_AGENT_RE.exec(agent) : null
  return m ? m[1] : null
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

export function removeStaleSessions(info, now = Date.now(), maxAgeMs = 7 * 24 * 3600 * 1000) {
  const kept = new Set()
  for (const rec of listSessions(info)) {
    if (!pidAlive(rec.pid) && now - (rec.updatedAt || 0) > maxAgeMs) {
      try {
        deleteSession(info, rec.sessionId)
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

export function conflictingClaims(info, rootId, rel, now = Date.now()) {
  return listSessions(info)
    .filter((r) => r.sessionId === r.rootId && r.sessionId !== rootId && isLive(r, now) && r.files && r.files[rel])
    .map((r) => ({ sessionId: r.sessionId, agent: r.agent, claimedAt: r.files[rel] }))
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
