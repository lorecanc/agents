// pipeline-guard: keeps `pipeline-*` and `*-pipeline-*` agent sessions inside the repository.
//
// Scope: acts ONLY on sessions whose agent name matches `pipeline-*` or `*-pipeline-*`
// (any fork: hybrid-, mistral-, free-, ...). Every other session is untouched.
//
// What it does for pipeline sessions (V2 plugin API)
//   shell.create.before    TMPDIR/TMP/TEMP/PIPELINE_SCRATCH -> a scratch dir inside the repo
//                          (so mktemp, test runners, etc. never write to /var/folders or /tmp)
//   tool.execute.before    blocks writes outside the repo / into .git, git branch/worktree/stash/
//                          reset/commit commands, and edits to files another LIVE session is changing;
//                          rejects the third consecutive identical tool call (V2 has no doom_loop action)
//   tool.execute.after     records which files the session edited (used by pipeline_state/commit)
//   event subscription     tracks busy/idle; when idle: stops the service the session started with
//                          pipeline_serve, compares git state with the baseline and warns if
//                          branches, worktrees or stashes appeared
//   permission.evaluate    records permission asks in the activity log
//   session.compaction     keeps the session baseline and touched files in the compacted context
//   activity log           appends tool calls (ok / error / denied), guard blocks, permission events and
//                          per-session step counts to <git-common-dir>/opencode-pipeline/logs/<rootId>.jsonl
//                          (read back by pipeline_state as `activity`)
//
// Fail-open: anything unexpected (unparseable command, no git repo, API differences) lets the call
// through. Permissions in the agent files remain the primary control; this is defense in depth.
// Emergency switch: OPENCODE_PIPELINE_GUARD=off

import path from "node:path"

import { Plugin } from "@opencode/plugin"

import {
  FILE_WRITE_TOOLS, appendActivity, bashWriteTargets, clipText, isDenialText, checkBash, checkWritePath,
  conflictingClaims, editTargets, ensureScratch, gitAnomalies, isInside, isLive, isPipelineAgent, isShellTool,
  readSession, realpathLoose, removeStaleSessions, repoInfo, roleOf, scratchDir, snapshot, toRel, writeSession,
} from "../../tools/_pipeline_core.js"
import { stopServicesOwnedBy } from "../../tools/_pipeline_serve.js"

const HEARTBEAT_MS = 30_000
const INTERNAL_AGENTS = new Set(["title", "summary", "compaction"])
// V2 has no `doom_loop` permission action, so the guard reproduces it: the third consecutive
// identical call is rejected. Keep at most LIMIT signatures per session and MAX_SESSIONS sessions.
const DOOM_LOOP_LIMIT = 3
const DOOM_LOOP_MAX_SESSIONS = 500

class GuardBlock extends Error {}

// One process-level exit listener for any number of plugin instances.
const exitCallbacks = new Set()
function onProcessExit(fn) {
  if (exitCallbacks.size === 0) {
    process.once("exit", () => {
      for (const cb of exitCallbacks) {
        try {
          cb()
        } catch {
          /* ignore */
        }
      }
    })
  }
  exitCallbacks.add(fn)
  return () => exitCallbacks.delete(fn)
}

/**
 * V2 plugin setup. `Plugin.define` is an identity function, so returning this function is enough.
 * `ctx` is the plugin context: location.directory, session/tool/shell/permission hooks.
 */
export async function setupPipelineGuard(ctx, options = {}) {
  const disabled = options.disabled === true || String(process.env.OPENCODE_PIPELINE_GUARD ?? "").toLowerCase() === "off"
  if (disabled) return () => {}

  const directory = ctx?.location?.directory || process.cwd()
  /** sessionId -> { pipeline, agent, rootId, rootKnown, directory } */
  const sessions = new Map()
  /** rootId -> registry record (mirrors the file in <git-common-dir>/opencode-pipeline/sessions) */
  const roots = new Map()
  /**
   * Directory -> root session ids. `shell.create.before` carries no sessionID in V2, so this index
   * is the only link between a shell call and a pipeline root. It is a heuristic: when two live
   * pipeline roots share (or contain) the shell cwd we cannot tell which one issued it, so the
   * hook fails open and logs instead of injecting the wrong scratch directory.
   */
  const rootsByDir = new Map()
  const infos = new Map()
  const lastWrite = new Map()
  /** sessionId -> { llm, tools, flushedLlm, flushedTools } (per-session step counters) */
  const steps = new Map()
  /** callIDs already logged (by the after hook or as a guard block), so error events are not doubled */
  const loggedCalls = new Set()
  /** permission request id -> { permission, pattern, callId } (to complete the reply event) */
  const permissionAsks = new Map()
  /** sessionId -> signatures of the last consecutive identical tool calls (doom-loop guard) */
  const streaks = new Map()

  const disposers = []
  const keep = (handle) => {
    if (typeof handle === "function") disposers.push(handle)
    else if (handle && typeof handle.dispose === "function") disposers.push(() => handle.dispose())
    return handle
  }

  const infoFor = (cwd) => {
    const dir = cwd || directory
    if (!dir) return null
    if (infos.has(dir)) return infos.get(dir)
    let info = null
    try {
      info = repoInfo(dir)
    } catch {
      info = null
    }
    if (info) infos.set(dir, info)
    return info
  }

  const log = (level, message) => {
    const line = `[pipeline-guard] ${message}`
    if (level === "error") console.error(line)
    else console.warn(line)
  }

  async function fetchSession(id) {
    try {
      const res = await ctx.session.get({ sessionID: id })
      const data = res && res.data !== undefined ? res.data : res
      if (data && typeof data === "object" && (data.id || "parentID" in data)) return data
    } catch {
      /* session lookup is fail-open */
    }
    return null
  }

  /** Walk parentID links up to the root session. rootKnown=false when the API could not tell. */
  async function resolveRoot(sessionId) {
    let current = sessionId
    for (let depth = 0; depth < 8; depth++) {
      const data = await fetchSession(current)
      if (!data) return { rootId: current, rootKnown: depth > 0 }
      const parent = data.parentID || data.parentId || null
      if (!parent) return { rootId: current, rootKnown: true }
      current = parent
    }
    return { rootId: current, rootKnown: false }
  }

  function persist(rec, force = false) {
    const info = infoFor(rec.cwd)
    if (!info) return
    const now = Date.now()
    if (!force && now - (lastWrite.get(rec.sessionId) || 0) < HEARTBEAT_MS) return
    lastWrite.set(rec.sessionId, now)
    rec.updatedAt = now
    try {
      writeSession(info, rec)
    } catch (e) {
      log("warn", `cannot write session record: ${e.message}`)
    }
  }

  function trackRoot(rec) {
    const key = realpathLoose(rec.cwd || directory)
    let ids = rootsByDir.get(key)
    if (!ids) {
      ids = new Set()
      rootsByDir.set(key, ids)
    }
    ids.add(rec.sessionId)
  }

  /** Live roots whose repository directory contains (or equals) the shell cwd. */
  function liveRootsFor(cwd) {
    const abs = realpathLoose(cwd || directory)
    const out = []
    for (const [dir, ids] of rootsByDir) {
      if (!isInside(dir, abs)) continue
      for (const id of ids) {
        const rec = roots.get(id)
        if (rec && isLive(rec)) out.push(rec)
      }
    }
    return out
  }

  /** True when this repository has ever registered a pipeline root (used only for the skip log). */
  function hasTrackedRootFor(cwd) {
    const abs = realpathLoose(cwd || directory)
    for (const dir of rootsByDir.keys()) if (isInside(dir, abs)) return true
    return false
  }

  function newRoot(rootId, agent, cwd, info) {
    let baseline = null
    try {
      baseline = snapshot(info)
    } catch {
      /* no baseline: pipeline_state reports degraded */
    }
    const rec = {
      sessionId: rootId, rootId, agent, pid: process.pid, cwd, startedAt: Date.now(), updatedAt: Date.now(),
      busy: true, baseline, files: {}, anomalies: [],
    }
    roots.set(rootId, rec)
    trackRoot(rec)
    try {
      removeStaleSessions(info)
    } catch {
      /* ignore */
    }
    persist(rec, true)
    return rec
  }

  function ensureRoot(rootId, agent, info) {
    let rec = roots.get(rootId)
    if (rec) {
      trackRoot(rec)
      return rec
    }
    const onDisk = readSession(info, rootId)
    // Reuse a record only if this very process owns it (a stale one from a dead process gets a fresh baseline).
    if (onDisk && onDisk.pid === process.pid) {
      rec = onDisk
      roots.set(rootId, rec)
      trackRoot(rec)
      return rec
    }
    return newRoot(rootId, agent, directory, info)
  }

  async function register(sessionId, agent) {
    if (!sessionId) return null
    const known = sessions.get(sessionId)
    if (known && known.agent === agent) return known
    if (!isPipelineAgent(agent)) {
      // Hidden internal agents (title generation, summaries, compaction) run on the SAME session id,
      // possibly after the pipeline agent's first step: they must not switch the guard off.
      if (known && known.pipeline && INTERNAL_AGENTS.has(agent)) return known
      const entry = { pipeline: false, agent }
      sessions.set(sessionId, entry)
      return entry
    }
    const { rootId, rootKnown } = await resolveRoot(sessionId)
    const s = { pipeline: true, agent, rootId, rootKnown, directory }
    sessions.set(sessionId, s)
    const info = infoFor(directory)
    if (!info) return s
    ensureRoot(rootId, agent, info)
    if (rootId !== sessionId) {
      try {
        writeSession(info, { sessionId, rootId, agent, pid: process.pid, cwd: directory, updatedAt: Date.now() })
      } catch {
        /* ignore */
      }
    }
    return s
  }

  const rootRec = (s) => (s ? roots.get(s.rootId) : null)

  // ------------------------------------------------------------ activity log (never throws)

  function record(sessionId, event) {
    try {
      const s = sessions.get(sessionId)
      if (!s || !s.pipeline || !s.rootId) return
      const info = infoFor(s.directory || directory)
      if (!info) return
      appendActivity(info, s.rootId, { ...event, sessionId, agent: s.agent })
    } catch {
      /* logging must never interfere */
    }
  }

  function markLogged(callID) {
    if (!callID) return
    if (loggedCalls.size > 5000) loggedCalls.clear()
    loggedCalls.add(callID)
  }

  function counter(sessionId) {
    let c = steps.get(sessionId)
    if (!c) {
      c = { llm: 0, tools: 0, flushedLlm: 0, flushedTools: 0 }
      steps.set(sessionId, c)
    }
    return c
  }

  function flushSteps(sessionId) {
    const c = steps.get(sessionId)
    if (!c || (c.llm === c.flushedLlm && c.tools === c.flushedTools)) return
    c.flushedLlm = c.llm
    c.flushedTools = c.tools
    record(sessionId, { type: "steps", llm_calls: c.llm, tool_calls: c.tools })
  }

  const callSubject = (tool, args) => {
    if (!args || typeof args !== "object") return undefined
    if (isShellTool(tool)) return clipText(args.command)
    const p = args.filePath || args.file_path || args.path
    return typeof p === "string" ? clipText(p, 200) : undefined
  }

  const callIdOf = (event) => event?.id || event?.callID || event?.callId || null

  /** JSON with object keys sorted at every level, so key order cannot defeat the signature. */
  function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
    if (value && typeof value === "object") {
      const fields = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      return `{${fields.join(",")}}`
    }
    return JSON.stringify(value) ?? "null"
  }

  function callSignature(tool, input) {
    let serialized = ""
    try {
      serialized = stableStringify(input && typeof input === "object" ? input : {})
    } catch {
      /* circular input: fall back to an empty signature (never blocks on the serializer) */
    }
    return `${tool}\u0000${serialized}`
  }

  /**
   * Record an allowed call and reject the third consecutive identical one. Runs only after the
   * path/shell checks pass, so a call they already block never reaches this function.
   */
  function noteToolCall(sessionId, tool, input) {
    const signature = callSignature(tool, input)
    let history = streaks.get(sessionId)
    if (!history) {
      if (streaks.size >= DOOM_LOOP_MAX_SESSIONS) {
        const oldest = streaks.keys().next().value
        if (oldest !== undefined) streaks.delete(oldest)
      }
      history = []
      streaks.set(sessionId, history)
    }
    // A different call ends the current streak; keep the history capped at the limit.
    if (history.length && history[history.length - 1] !== signature) history.length = 0
    history.push(signature)
    if (history.length > DOOM_LOOP_LIMIT) history.shift()
    if (history.length < DOOM_LOOP_LIMIT) return
    throw blocked(
      `${tool} was called ${DOOM_LOOP_LIMIT} times in a row with identical input (doom_loop).`,
      "Bound the wait inside one command instead of polling with the same call: widen the timeout, add a readiness loop, or change the input.",
    )
  }

  function onPermissionEvent(type, props) {
    const sessionId = props.sessionID || props.sessionId || (props.info && props.info.sessionID)
    const s = sessionId ? sessions.get(sessionId) : null
    if (!s || !s.pipeline) return
    const id = props.id || props.permissionID || props.permissionId || props.requestID || props.requestId || null
    const toolRef = props.tool && typeof props.tool === "object" ? props.tool : null
    const rawPattern = props.patterns ?? props.pattern
    const pattern = Array.isArray(rawPattern) ? rawPattern.join(" | ") : rawPattern
    const replied = /replied|reply|responded/.test(type)
    let detail = {
      permission: props.permission || (typeof props.type === "string" ? props.type : null) || (typeof props.tool === "string" ? props.tool : null),
      pattern: pattern === undefined || pattern === null ? null : clipText(pattern),
      callId: props.callID || props.callId || (toolRef && (toolRef.callID || toolRef.callId)) || null,
    }
    if (replied) {
      const ask = id ? permissionAsks.get(id) : null
      if (ask) detail = { permission: detail.permission || ask.permission, pattern: detail.pattern || ask.pattern, callId: detail.callId || ask.callId }
      if (id) permissionAsks.delete(id)
    } else if (id) {
      if (permissionAsks.size > 500) permissionAsks.clear()
      permissionAsks.set(id, detail)
    }
    const decisionRaw = replied ? (props.response ?? props.reply ?? props.decision ?? props.answer ?? "unknown") : null
    const decision = decisionRaw === null ? null : typeof decisionRaw === "string" ? decisionRaw : clipText(JSON.stringify(decisionRaw), 60)
    record(sessionId, { type: "permission", event: type, id, ...detail, decision })
  }

  function onPartUpdated(props) {
    const part = props.part
    if (!part || part.type !== "tool" || !part.state || part.state.status !== "error") return
    if (part.callID && loggedCalls.has(part.callID)) return
    const s = sessions.get(part.sessionID)
    if (!s || !s.pipeline) return
    markLogged(part.callID)
    const error = clipText(part.state.error)
    record(part.sessionID, {
      type: "tool", tool: part.tool, callId: part.callID || null, ok: false, error,
      ...(callSubject(part.tool, part.state.input) !== undefined ? { command: callSubject(part.tool, part.state.input) } : {}),
      ...(isDenialText(part.state.error) ? { denied: true } : {}),
    })
  }

  function touchBusy(s) {
    const rec = rootRec(s)
    if (!rec) return
    if (!rec.busy) {
      rec.busy = true
      persist(rec, true)
    } else persist(rec)
  }

  function ctxFor(s, cwd) {
    const info = infoFor(s.directory || directory)
    if (!info) return null
    return { info, cwd: cwd || s.directory || directory, scratch: scratchDir(info) }
  }

  const blocked = (reason, hint = "") => new GuardBlock(`[pipeline-guard] Blocked: ${reason}${hint ? ` ${hint}` : ""}`)

  async function onIdle(sessionId) {
    const rec = roots.get(sessionId)
    if (!rec) return
    rec.busy = false
    try {
      const info = infoFor(rec.cwd)
      // A service started for this session (pipeline_serve) must not outlive its work.
      if (info) await stopServicesOwnedBy(info, rec.sessionId)
    } catch (e) {
      log("warn", `stopping the session's service failed: ${e.message}`)
    }
    try {
      const info = infoFor(rec.cwd)
      if (info && rec.baseline) {
        const anomalies = gitAnomalies(rec.baseline, snapshot(info))
        rec.anomalies = anomalies
        if (anomalies.length) {
          const text = anomalies
            .map((a) => (a.kind === "branch_changed" ? `branch ${a.from} -> ${a.to}` : a.kind === "new_stashes" ? `${a.count} new stash(es)` : `${a.kind.replace("new_", "new ")}: ${a.items.join(", ")}`))
            .join("; ")
          log("warn", `git state changed during the session: ${text}`)
          record(rec.sessionId, { type: "warning", message: clipText(`git state changed during the session: ${text}`, 400) })
        }
      }
    } catch {
      /* ignore */
    }
    persist(rec, true)
  }

  const offExit = onProcessExit(() => {
    for (const id of steps.keys()) flushSteps(id)
    for (const rec of roots.values()) {
      if (rec.pid !== process.pid) continue
      const info = infoFor(rec.cwd)
      if (info) writeSession(info, { ...rec, busy: false, updatedAt: Date.now() })
    }
  })

  // ---------------------------------------------------------------- hooks

  // chat.params -> model.request
  keep(ctx.session.hook("model.request", async (event) => {
    try {
      const id = event?.sessionID || event?.sessionId
      if (!id) return
      const known = sessions.get(id)
      const agent = event?.agent || (known && known.agent)
      await register(id, agent)
      const s = sessions.get(id)
      if (s && s.pipeline && !INTERNAL_AGENTS.has(agent)) counter(id).llm++
      touchBusy(s)
    } catch (e) {
      log("warn", `model.request: ${e.message}`)
    }
  }))

  // chat.message -> prompt
  keep(ctx.session.hook("prompt", async (event) => {
    try {
      const id = event?.sessionID || event?.sessionId
      if (!id) return
      const known = sessions.get(id)
      const agent = event?.agent || (known && known.agent)
      if (!isPipelineAgent(agent)) return
      const s = await register(id, agent)
      const rec = s && s.rootId === id ? roots.get(s.rootId) : null
      if (rec && !rec.busy) {
        // new user turn on an idle root session: the baseline is "what is dirty now".
        const info = infoFor(rec.cwd)
        if (info) {
          try {
            rec.baseline = snapshot(info)
          } catch {
            /* keep previous */
          }
          rec.files = {}
          rec.anomalies = []
        }
      }
      touchBusy(s)
    } catch (e) {
      log("warn", `prompt: ${e.message}`)
    }
  }))

  // shell.env -> shell.create.before. No sessionID in V2: see rootsByDir.
  keep(ctx.shell.hook("create.before", (event) => {
    try {
      if (!event || typeof event !== "object") return
      const matches = liveRootsFor(event.cwd)
      if (matches.length !== 1) {
        if (matches.length > 1) {
          log("warn", `shell env not injected: ${matches.length} live pipeline roots match ${event.cwd || directory}`)
        } else if (hasTrackedRootFor(event.cwd)) {
          log("warn", `shell env not injected: no live pipeline root matches ${event.cwd || directory}`)
        }
        return
      }
      const rec = matches[0]
      const info = infoFor(rec.cwd)
      if (!info) return
      const scratch = ensureScratch(info)
      if (!event.env || typeof event.env !== "object") event.env = {}
      event.env.TMPDIR = scratch
      event.env.TMP = scratch
      event.env.TEMP = scratch
      event.env.PIPELINE_SCRATCH = scratch
      event.env.GIT_EDITOR = ":"
      event.env.GIT_SEQUENCE_EDITOR = ":"
      event.env.GIT_MERGE_AUTOEDIT = "no"
      event.env.PIPELINE_SESSION = rec.sessionId
    } catch {
      /* fail open */
    }
  }))

  keep(ctx.tool.hook("execute.before", async (event) => {
    let s
    const id = event?.sessionID || event?.sessionId
    try {
      s = sessions.get(id)
      if (!s || !s.pipeline) return
      counter(id).tools++
      touchBusy(s)
      const guardCtx = ctxFor(s)
      if (!guardCtx) return
      const role = roleOf(s.agent)
      const args = event.input && typeof event.input === "object" ? event.input : {}
      if (isShellTool(event.tool)) {
        const cwd = typeof args.workdir === "string" ? path.resolve(guardCtx.cwd, args.workdir) : guardCtx.cwd
        const reason = checkBash(args.command, role, { ...guardCtx, cwd })
        if (reason) throw blocked(reason)
        if (s.rootKnown) {
          for (const rel of bashWriteTargets(args.command, { ...guardCtx, cwd })) {
            const clash = conflictingClaims(guardCtx.info, s.rootId, rel)
            if (clash.length) {
              throw blocked(
                `${rel} is being modified by another active opencode session (${clash.map((c) => c.sessionId).join(", ")}).`,
                "Do not edit it now: finish the other work first or report the conflict to the orchestrator.",
              )
            }
          }
        }
      } else if (FILE_WRITE_TOOLS.has(event.tool)) {
        for (const target of editTargets(event.tool, args)) {
          const abs = path.resolve(guardCtx.cwd, target)
          const reason = checkWritePath(abs, guardCtx)
          if (reason) throw blocked(`${event.tool}: ${reason}`)
          if (s.rootKnown) {
            const rel = toRel(guardCtx.info, abs)
            const clash = rel ? conflictingClaims(guardCtx.info, s.rootId, rel) : []
            if (clash.length) {
              throw blocked(
                `${rel} is being modified by another active opencode session (${clash.map((c) => c.sessionId).join(", ")}).`,
                "Do not edit it now: finish the other work first or report the conflict to the orchestrator.",
              )
            }
          }
        }
      }
      noteToolCall(id, event.tool, args)
    } catch (e) {
      if (e instanceof GuardBlock) {
        markLogged(callIdOf(event))
        const subject = callSubject(event.tool, event.input)
        record(id, {
          type: "guard_block", tool: event.tool, callId: callIdOf(event),
          ...(subject !== undefined ? { command: subject } : {}),
          reason: clipText(e.message.replace(/^\[pipeline-guard\] Blocked: /, ""), 400),
        })
        throw e
      }
      log("warn", `tool.execute.before: ${e.message}`)
    }
  }))

  keep(ctx.tool.hook("execute.after", async (event) => {
    const id = event?.sessionID || event?.sessionId
    const tool = event?.tool
    const args = event?.input && typeof event.input === "object" ? event.input : {}
    const callId = callIdOf(event)
    try {
      const s = sessions.get(id)
      if (s && s.pipeline && !(callId && loggedCalls.has(callId))) {
        markLogged(callId)
        const subject = callSubject(tool, args)
        const failed = event?.status === "error"
        const meta = event?.result?.metadata && typeof event.result.metadata === "object" ? event.result.metadata : {}
        const exit = Number.isInteger(meta.exit) ? meta.exit : Number.isInteger(meta.exitCode) ? meta.exitCode : undefined
        record(id, {
          type: "tool", tool, callId, ok: !failed,
          ...(subject !== undefined ? { command: subject } : {}),
          ...(exit !== undefined ? { exit } : {}),
          ...(failed ? { error: clipText(event.error) } : {}),
          ...(failed && isDenialText(event.error) ? { denied: true } : {}),
        })
      }
    } catch {
      /* logging is fail-open */
    }
    try {
      const s = sessions.get(id)
      if (!s || !s.pipeline || (!FILE_WRITE_TOOLS.has(tool) && !isShellTool(tool))) return
      const rec = rootRec(s)
      const info = infoFor(s.directory)
      if (!rec || !info) return
      let changed = false
      const baseCwd = typeof args.workdir === "string"
        ? path.resolve(s.directory || directory, args.workdir)
        : (s.directory || directory)
      const targets = isShellTool(tool)
        ? bashWriteTargets(args.command, { info, cwd: baseCwd, scratch: scratchDir(info) })
        : editTargets(tool, args)
      for (const target of targets) {
        const rel = isShellTool(tool) ? target : toRel(info, path.resolve(baseCwd, target))
        if (rel && !rec.files[rel]) {
          rec.files[rel] = Date.now()
          changed = true
        }
      }
      if (changed) persist(rec, true)
    } catch {
      /* fail open */
    }
  }))

  // permission.evaluate runs only for allow/ask (explicit deny never reaches it).
  keep(ctx.permission.hook("evaluate", (event) => {
    try {
      const id = event?.sessionID
      const s = id ? sessions.get(id) : null
      if (!s || !s.pipeline) return
      if (event.effect && event.effect !== "ask") return
      const resources = Array.isArray(event.resources)
        ? event.resources
        : event.resources === undefined || event.resources === null ? [] : [event.resources]
      record(id, {
        type: "permission", event: "permission.asked",
        permission: event.action || null,
        pattern: resources.length ? clipText(resources.join(" | ")) : null,
        callId: event.metadata?.callID || event.metadata?.callId || null,
        decision: null,
      })
    } catch (e) {
      log("warn", `permission.evaluate: ${e.message}`)
    }
  }))

  keep(ctx.event.subscribe({}, async (payload) => {
    try {
      const event = payload && payload.event ? payload.event : payload
      if (!event) return
      const type = event.type
      const props = event.properties || {}
      const id = props.sessionID || props.sessionId
      if (typeof type === "string" && type.startsWith("permission.")) {
        onPermissionEvent(type, props)
        return
      }
      if (type === "message.part.updated") {
        onPartUpdated(props)
        return
      }
      if (type === "session.error" && id) {
        const err = props.error
        const text = err && (err.data && err.data.message ? err.data.message : err.message || err.name)
        record(id, { type: "session_error", error: clipText(text || JSON.stringify(err ?? null)) })
      }
      const idle = (type === "session.idle" && id) || (type === "session.status" && id && props.status && props.status.type === "idle")
      if (idle) {
        flushSteps(id)
        streaks.delete(id)
      }
      const ended = type === "session.deleted" || type === "session.end" || type === "session.ended" || type === "session.closed"
      if (ended) {
        const endedId = id || (props.info && typeof props.info.id === "string" ? props.info.id : undefined)
        if (endedId) streaks.delete(endedId)
      }
      if (type === "session.idle" && id) await onIdle(id)
      else if (type === "session.status" && id && props.status && props.status.type === "idle") await onIdle(id)
      else if (type === "session.status" && id && props.status && props.status.type === "busy") {
        const s = sessions.get(id)
        if (s && s.pipeline) touchBusy(s)
      }
    } catch (e) {
      log("warn", `event: ${e.message}`)
    }
  }))

  // The compaction payload shape is not pinned. Inject into an existing array field only; if none
  // exists, log and fail open instead of guessing a new shape.
  keep(ctx.session.hook("compaction", (event) => {
    try {
      const id = event?.sessionID || event?.sessionId
      const s = sessions.get(id)
      const rec = rootRec(s)
      if (!s || !s.pipeline || !rec) return
      const files = Object.keys(rec.files || {})
      const lines = [
        "## Pipeline session state (must survive compaction, copy verbatim)",
        "Keep in the summary, unchanged: the Phase 1 assessment (Size/Risk/Clarity/Type), the chosen lane and the remaining agents of it, the planner task graph and per-task status, retry/fix-round counters, every verification result with its failure class, and the current verification status (VERIFIED / PARTIALLY VERIFIED / UNVERIFIED).",
        rec.baseline ? `Session baseline: base_commit=${rec.baseline.head}, branch=${rec.baseline.branch}, baseline_dirty=${JSON.stringify((rec.baseline.dirty || []).slice(0, 40))}` : "Session baseline: not registered",
        `Files edited by this session so far (${files.length}): ${JSON.stringify(files.slice(0, 60))}`,
        "Workspace rules still apply: repo-only paths, scratch in $PIPELINE_SCRATCH, no branches/worktrees/stashes.",
      ]
      const field = ["context", "messages", "parts"].find((name) => Array.isArray(event[name]))
      if (!field) {
        log("warn", "compaction: no array field (context/messages/parts) to inject pipeline state")
        record(id, { type: "warning", message: "compaction: no array field to inject pipeline state" })
        return
      }
      event[field].push(lines.join("\n"))
    } catch {
      /* fail open */
    }
  }))

  return () => {
    streaks.clear()
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        /* ignore */
      }
    }
    offExit()
  }
}

export default Plugin.define({
  id: "pipeline-guard",
  setup: setupPipelineGuard,
})
