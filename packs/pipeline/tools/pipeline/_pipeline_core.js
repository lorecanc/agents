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
import { changedFiles, git, gitT, isInternalPath, pidAlive, redact, safeId, toRel, withLock } from "../dev-tools/_repo.js"
import { deleteSession, isLive, listSessions } from "../dev-tools/_sessions.js"

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

export function deleteRootChildren(info, rootId, { force = false, now = Date.now() } = {}) {
  let deleted = 0
  for (const rec of listSessions(info)) {
    if (rec.rootId !== rootId || rec.sessionId === rootId || (!force && isLive(rec, now))) continue
    try {
      deleteSession(info, rec.sessionId)
      deleted++
    } catch {
      /* ignore records removed concurrently */
    }
  }
  return deleted
}

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
      if (rec.sessionId === rec.rootId) deleteRootChildren(info, rec.sessionId, { now })
      try {
        if (rec.sessionId === rec.rootId) fs.unlinkSync(activityLogPath(info, rec.sessionId))
      } catch {
        /* ignore */
      }
    } else if (rec.rootId) kept.add(rec.rootId)
  }
  const rootsOnDisk = new Set(listSessions(info).filter((rec) => rec.sessionId === rec.rootId).map((rec) => rec.sessionId))
  for (const rec of listSessions(info)) {
    if (rec.sessionId === rec.rootId || rootsOnDisk.has(rec.rootId) || isLive(rec, now)) continue
    try {
      deleteSession(info, rec.sessionId)
    } catch {
      /* ignore */
    }
  }
  for (const rec of listSessions(info)) if (rec.rootId) kept.add(rec.rootId)
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

export function conflictingClaims(info, rootId, rel, now = Date.now(), callerSessionId = null) {
  return listSessions(info)
    .filter((r) => isLive(r, now) && r.files?.[rel] && (
      (r.sessionId === r.rootId && r.sessionId !== rootId)
      || (callerSessionId && callerSessionId !== rootId && r.rootId === rootId && r.sessionId !== rootId && r.sessionId !== callerSessionId)
    ))
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
 *  commit      : files listed in expected (or claimed when expected is empty) that are really changed
 *  patched     : conflicting files covered by patchFiles — their session hunks arrive via a staging patch
 *  conflicts   : touched files that were ALREADY dirty before the session and are not covered by a
 *                staging patch either: committing them whole would drag pre-existing changes (cannot be split)
 *  notChanged  : listed files with no change
 *  unattributed: changed files that were neither claimed nor expected and were not dirty before
 *  rejected    : listed paths that are invalid or outside the repository
 */
export function planCommit(info, rootRec, expected = [], patchFiles = null) {
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
  const hasExpected = Array.isArray(expected) && expected.length > 0
  const useClaimed = expected === undefined || (Array.isArray(expected) && expected.length === 0)
  if (useClaimed) for (const p of claimed) wanted.add(p)
  if (hasExpected) for (const p of expected) {
    const rel = normalizeRel(info, p)
    if (rel) wanted.add(rel)
    else rejected.push(p)
  }
  const claimedOnly = claimed.filter((p) => !wanted.has(p)).sort()
  const claimedOnlySet = new Set(claimedOnly)
  const patchSet = Array.isArray(patchFiles) ? new Set(patchFiles) : null
  const commit = new Set()
  const patched = []
  const conflicts = []
  const notChanged = []
  for (const p of wanted) {
    const it = byPath.get(p)
    if (!it) notChanged.push(p)
    else if (baselineDirty.has(p) || (it.orig && baselineDirty.has(it.orig))) {
      // A mixed file is a conflict by default; a staging patch makes only its session hunks committable.
      if (patchSet && patchSet.has(p)) patched.push(it.path)
      else conflicts.push(p)
    } else {
      commit.add(it.path)
      if (it.orig) commit.add(it.orig)
    }
  }
  const unattributed = items
    .filter((it) => !wanted.has(it.path) && !claimedOnlySet.has(it.path) && !(it.orig && claimedOnlySet.has(it.orig)) && !baselineDirty.has(it.path))
    .map((it) => it.path)
  return {
    commit: [...commit].sort(),
    patched: patched.sort(),
    conflicts: conflicts.sort(),
    notChanged: notChanged.sort(),
    unattributed: unattributed.sort(),
    rejected,
    claimedOnly,
  }
}

/** Stage explicit paths and commit ONLY them (other staged content is left untouched). */
export async function executeCommit(info, plan, message, trailers = []) {
  if (!plan.commit.length) throw new Error("nothing to commit")
  // Same lock as the hunk commit: a plain commit of a parallel session must not interleave
  // with an apply+stage+assert+commit sequence (its assertion, and the git reset of
  // unstageIndexed, would clobber the other session's staging).
  return withLock(info, "commit", () => executeCommitLocked(info, plan, message, trailers))
}

function executeCommitLocked(info, plan, message, trailers) {
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

// ------------------------------------------------ hunk-scoped commit
//
// A session can end with an expected file that ALSO carries pre-existing edits. The caller may
// then pass `staging_patch`: a unified diff holding ONLY the session hunks of those files (a
// hunk-level subset of `git diff HEAD -- <paths>`). The patch is applied to the index alone
// (`git apply --cached`, the worktree is never touched) and the commit runs WITHOUT pathspec:
// `git commit -- <paths>` would take the worktree version and undo the partial staging, so the
// hunks must be applied to the index first and the pathspec left out, guarded by the clean-index
// precondition and the staged-set assertion below.

/** Write the patch to the pipeline state dir (never the working tree). */
function writePatchFile(info, patch) {
  fs.mkdirSync(info.stateDir, { recursive: true })
  const file = path.join(info.stateDir, `staging-patch.${process.pid}.${Date.now()}.tmp`)
  fs.writeFileSync(file, patch.endsWith("\n") ? patch : `${patch}\n`)
  return file
}

function stripDiffQuotes(s) {
  return s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s
}

/**
 * b-side path of every file section of a git-style unified diff. Header `---`/`+++` lines are
 * taken from the section head only (before the first @@), so hunk body content cannot fool the
 * parser; a `+++ /dev/null` section (deletion) falls back to its `--- a/<path>`. Sections without
 * `---`/`+++` headers (pure renames) are reported as `renameOnly` for the caller to reject.
 */
function parsePatchPaths(patch) {
  const paths = []
  const renameOnly = []
  let binary = false
  const sections = patch.split(/^diff --git /m).filter(Boolean)
  for (const section of sections) {
    if (section.includes("GIT binary patch")) {
      binary = true
      continue
    }
    const at = section.search(/^@@ /m)
    let aPath = null
    let bPath = null
    for (const l of (at < 0 ? section : section.slice(0, at)).split("\n")) {
      const del = /^--- (.*)$/.exec(l)
      if (del) aPath = stripDiffQuotes(del[1].replace(/\t.*$/, ""))
      const add = /^\+\+\+ (.*)$/.exec(l)
      if (add) bPath = stripDiffQuotes(add[1].replace(/\t.*$/, ""))
    }
    if (!aPath && !bPath) {
      const ren = /^rename to (.+)$/m.exec(section)
      if (ren) renameOnly.push(stripDiffQuotes(ren[1].trim()))
      continue
    }
    if (bPath === "/dev/null") {
      if (aPath && aPath !== "/dev/null") paths.push(aPath.replace(/^a\//, ""))
    } else paths.push(bPath.replace(/^b\//, ""))
  }
  return { paths, renameOnly, binary, hunks: (patch.match(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/gm) || []).length }
}

/**
 * Validate a staging patch for pipeline_commit. The hunks may touch ONLY files that are declared
 * in expected_files AND were already dirty before the session (the plan's conflicts); anything
 * else is refused with a reason. The patch must also apply to the index (checked with
 * `git apply --cached --check`, which touches nothing). Returns { ok: true, files } with the
 * repo-relative patch paths, or { ok: false, reason }.
 */
export function validateStagingPatch(info, patch, { expected = [], baselineDirty = [] } = {}) {
  if (typeof patch !== "string" || !patch.trim()) return { ok: false, reason: "malformed staging_patch: empty" }
  const parsed = parsePatchPaths(patch)
  if (parsed.binary) return { ok: false, reason: "malformed staging_patch: binary hunks are not supported" }
  if (parsed.renameOnly.length) return { ok: false, reason: `malformed staging_patch: rename-only section(s) without ---/+++ headers are not supported: ${parsed.renameOnly.join(", ")}` }
  if (!parsed.paths.length) return { ok: false, reason: "malformed staging_patch: no file section found" }
  if (!parsed.hunks) return { ok: false, reason: "malformed staging_patch: no hunk (@@) found" }
  const expectedSet = new Set()
  for (const p of expected || []) {
    const rel = normalizeRel(info, p)
    if (rel) expectedSet.add(rel)
  }
  const dirtySet = new Set(baselineDirty || [])
  const files = []
  for (const raw of parsed.paths) {
    const rel = normalizeRel(info, raw)
    if (!rel) return { ok: false, reason: `staging_patch touches a path outside the repository or invalid: ${raw}` }
    if (!expectedSet.has(rel)) {
      return { ok: false, reason: `staging_patch touches files not declared in expected_files: ${rel}` }
    }
    if (!dirtySet.has(rel)) {
      return { ok: false, reason: `staging_patch touches ${rel}, which is not baseline_dirty: it is not in conflict, leave it out of the patch` }
    }
    files.push(rel)
  }
  const patchFile = writePatchFile(info, patch)
  try {
    git(info.top, ["apply", "--cached", "--check", patchFile])
  } catch (e) {
    const detail = clipText(String(e && e.message ? e.message : e), 200)
    return { ok: false, reason: `staging_patch does not apply to the index: ${detail}` }
  } finally {
    try {
      fs.rmSync(patchFile, { force: true })
    } catch {
      /* best effort */
    }
  }
  return { ok: true, files }
}

/** Unstage what executeHunkCommit staged. It only ever runs when the index was clean on entry. */
function unstageIndexed(cwd, paths) {
  if (paths.length) git(cwd, ["reset", "-q", "--", ...paths], { allowFail: true })
  if (gitT(cwd, ["diff", "--cached", "--name-only"], { allowFail: true })) git(cwd, ["reset", "-q"], { allowFail: true })
}

/**
 * Commit a plan whose `patched` files hold mixed changes: apply the staging patch to the index,
 * stage the plain `commit` files whole, assert that the staged set is exactly the planned one,
 * then commit WITHOUT pathspec (the index already holds only the hunks to commit). The whole
 * apply+stage+assert+commit sequence runs under the "commit" lock, so a parallel session cannot
 * stage anything between the precondition check and the commit. The post-commit assertion must
 * hold too: if HEAD picked up anything outside the plan the commit is undone with
 * `git reset --soft HEAD^` and an error is rethrown. On any failure the index is restored to the
 * clean state it was found in; the worktree is never modified.
 */
export async function executeHunkCommit(info, plan, patchText, message, trailers = []) {
  if (!plan.commit.length && !plan.patched.length) throw new Error("nothing to commit")
  if (typeof patchText !== "string" || !patchText.trim()) throw new Error("staging_patch is required when the plan has patched files")
  return withLock(info, "commit", () => hunkCommitLocked(info, plan, patchText, message, trailers))
}

function hunkCommitLocked(info, plan, patchText, message, trailers) {
  const cwd = info.top
  const alreadyStaged = gitT(cwd, ["diff", "--cached", "--name-only"])
  if (alreadyStaged) {
    throw new Error(`staging_patch requires a clean index, but something is already staged: ${alreadyStaged.split("\n").join(" ")}`)
  }
  const patchFile = writePatchFile(info, patchText)
  try {
    git(cwd, ["apply", "--cached", "--check", patchFile])
    git(cwd, ["apply", "--cached", patchFile])
    try {
      for (const p of plan.commit) {
        if (fs.existsSync(path.join(cwd, p))) git(cwd, ["add", "--", p])
        else git(cwd, ["rm", "--cached", "-q", "--ignore-unmatch", "--", p]) // deletion (or rename source)
      }
      const planned = [...new Set([...plan.commit, ...plan.patched])].sort()
      // --no-renames: rename detection would collapse a delete+add pair onto one name and
      // turn a planned rename into a spurious staged-set mismatch
      const staged = git(cwd, ["diff", "--cached", "--no-renames", "--name-only", "-z"]).split("\0").filter(Boolean).sort()
      if (staged.join("\n") !== planned.join("\n")) {
        throw new Error(`staged set does not match the planned commit set (staged: ${staged.join(", ") || "none"}; planned: ${planned.join(", ") || "none"})`)
      }
      const args = ["commit", "-m", message]
      for (const t of trailers) args.push("-m", t)
      const preHead = gitT(cwd, ["rev-parse", "HEAD"], { allowFail: true })
      git(cwd, args) // no pathspec: it would take the worktree and undo the partial staging
      const hash = gitT(cwd, ["rev-parse", "--short", "HEAD"])
      const committed = git(cwd, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "HEAD"])
        .split("\0")
        .filter(Boolean)
        .sort()
      const plannedSet = new Set(planned)
      const unexpected = committed.filter((p) => !plannedSet.has(p))
      if (unexpected.length) {
        // HEAD must still be the commit we just created (its parent is preHead): if an
        // external actor committed on top, reset would discard THEIR commit instead of ours
        const headParent = gitT(cwd, ["rev-parse", "HEAD^"], { allowFail: true })
        if (headParent !== preHead) {
          throw new Error(`post-commit assertion failed: the commit also contains ${unexpected.join(", ")}; the rollback was skipped because HEAD moved (an external actor committed on top): clean up manually with git reset --soft`)
        }
        git(cwd, ["reset", "--soft", "HEAD^"])
        throw new Error(`post-commit assertion failed: the commit also contains ${unexpected.join(", ")}; the commit was rolled back with git reset --soft HEAD^`)
      }
      return { hash, committed, unexpected }
    } catch (e) {
      unstageIndexed(cwd, [...plan.commit, ...plan.patched])
      throw e
    }
  } finally {
    try {
      fs.rmSync(patchFile, { force: true })
    } catch {
      /* best effort */
    }
  }
}
