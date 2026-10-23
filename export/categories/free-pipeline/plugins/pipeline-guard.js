// pipeline-guard: keeps `pipeline-*` and `*-pipeline-*` agent sessions inside the repository.
//
// Scope: acts ONLY on sessions whose agent name matches `pipeline-*` or `*-pipeline-*`
// (any fork: hybrid-, mistral-, free-, ...). Every other session is untouched.
//
// What it does for pipeline sessions
//   shell.env              TMPDIR/TMP/TEMP/PIPELINE_SCRATCH -> a scratch dir inside the repo
//                          (so mktemp, test runners, etc. never write to /var/folders or /tmp)
//   tool.execute.before    blocks writes outside the repo / into .git, git branch/worktree/stash/
//                          reset/commit commands, and edits to files another LIVE session is changing
//   tool.execute.after     records which files the session edited (used by pipeline_state/commit)
//   event                  tracks busy/idle; when idle: stops the service the session started with
//                          pipeline_serve, compares git state with the baseline and warns if
//                          branches, worktrees or stashes appeared
//   session.compacting     keeps the session baseline and touched files in the compacted context
//   activity log           appends tool calls (ok / error / denied), guard blocks, permission events and
//                          per-session step counts to <git-common-dir>/opencode-pipeline/logs/<rootId>.jsonl
//                          (read back by pipeline_state as `activity`)
//
// Fail-open: anything unexpected (unparseable command, no git repo, SDK differences) lets the call
// through. Permissions in the agent files remain the primary control; this is defense in depth.
// Emergency switch: OPENCODE_PIPELINE_GUARD=off

import path from "node:path"

import {
  FILE_WRITE_TOOLS, appendActivity, bashWriteTargets, clipText, isDenialText, checkBash, checkWritePath, conflictingClaims, editTargets, ensureScratch, gitAnomalies,
  isPipelineAgent, readSession, removeStaleSessions, repoInfo, roleOf, scratchDir, snapshot, toRel, writeSession,
} from "../tools/_pipeline_core.js"
import { stopServicesOwnedBy } from "../tools/_pipeline_serve.js"

const HEARTBEAT_MS = 30_000
const INTERNAL_AGENTS = new Set(["title", "summary", "compaction"])

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
}

export async function createPipelineGuard({ client, directory } = {}, options = {}) {
  const disabled = options.disabled === true || String(process.env.OPENCODE_PIPELINE_GUARD ?? "").toLowerCase() === "off"
  if (disabled) return {}
  /** sessionId -> { pipeline, agent, rootId, rootKnown, directory } */
  const sessions = new Map()
  /** rootId -> registry record (mirrors the file in <git-common-dir>/opencode-pipeline/sessions) */
  const roots = new Map()
  const infos = new Map()
  const lastWrite = new Map()
  /** sessionId -> { llm, tools, flushedLlm, flushedTools } (per-session step counters) */
  const steps = new Map()
  /** callIDs already logged (by the after hook or as a guard block), so error events are not doubled */
  const loggedCalls = new Set()
  /** permission request id -> { permission, pattern, callId } (to complete the reply event) */
  const permissionAsks = new Map()

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
    try {
      void client?.app?.log?.({ body: { service: "pipeline-guard", level, message } })
    } catch {
      /* ignore */
    }
  }

  const toast = (message) => {
    try {
      void client?.tui?.showToast?.({ body: { message, variant: "warning" } })
    } catch {
      /* ignore */
    }
  }

  async function fetchSession(id) {
    for (const arg of [{ path: { id } }, { sessionID: id }]) {
      try {
        const res = await client.session.get(arg)
        const data = res && res.data !== undefined ? res.data : res
        if (data && typeof data === "object" && (data.id || "parentID" in data)) return data
      } catch {
        /* try next shape */
      }
    }
    return null
  }

  /** Walk parentID links up to the root session. rootKnown=false when the SDK could not tell. */
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
    if (rec) return rec
    const onDisk = readSession(info, rootId)
    // Reuse a record only if this very process owns it (a stale one from a dead process gets a fresh baseline).
    if (onDisk && onDisk.pid === process.pid) {
      rec = onDisk
      roots.set(rootId, rec)
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
    if (tool === "bash") return clipText(args.command)
    const p = args.filePath || args.file_path || args.path
    return typeof p === "string" ? clipText(p, 200) : undefined
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
          toast(`Pipeline session changed git state: ${text}`)
        }
      }
    } catch {
      /* ignore */
    }
    persist(rec, true)
  }

  onProcessExit(() => {
    for (const id of steps.keys()) flushSteps(id)
    for (const rec of roots.values()) {
      if (rec.pid !== process.pid) continue
      const info = infoFor(rec.cwd)
      if (info) writeSession(info, { ...rec, busy: false, updatedAt: Date.now() })
    }
  })

  return {
    "chat.params": async (input) => {
      try {
        await register(input.sessionID, input.agent)
        const s = sessions.get(input.sessionID)
        if (s && s.pipeline && !INTERNAL_AGENTS.has(input.agent)) counter(input.sessionID).llm++
        touchBusy(s)
      } catch (e) {
        log("warn", `chat.params: ${e.message}`)
      }
    },

    "chat.message": async (input) => {
      try {
        const known = sessions.get(input.sessionID)
        const agent = input.agent || (known && known.agent)
        if (!isPipelineAgent(agent)) return
        const s = await register(input.sessionID, agent)
        const rec = s && s.rootId === input.sessionID ? roots.get(s.rootId) : null
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
        log("warn", `chat.message: ${e.message}`)
      }
    },

    "shell.env": async (input, output) => {
      try {
        const s = input.sessionID ? sessions.get(input.sessionID) : null
        if (!s || !s.pipeline) return
        const info = infoFor(input.cwd || s.directory)
        if (!info) return
        const scratch = ensureScratch(info)
        output.env.TMPDIR = scratch
        output.env.TMP = scratch
        output.env.TEMP = scratch
        output.env.PIPELINE_SCRATCH = scratch
        output.env.GIT_EDITOR = ":"
        output.env.GIT_SEQUENCE_EDITOR = ":"
        output.env.GIT_MERGE_AUTOEDIT = "no"
        output.env.PIPELINE_SESSION = s.rootId
      } catch {
        /* fail open */
      }
    },

    "tool.execute.before": async (input, output) => {
      let s
      try {
        s = sessions.get(input.sessionID)
        if (!s || !s.pipeline) return
        counter(input.sessionID).tools++
        touchBusy(s)
        const ctx = ctxFor(s)
        if (!ctx) return
        const role = roleOf(s.agent)
        const args = (output && output.args) || {}
        if (input.tool === "bash") {
          const cwd = typeof args.workdir === "string" ? path.resolve(ctx.cwd, args.workdir) : ctx.cwd
          const reason = checkBash(args.command, role, { ...ctx, cwd })
          if (reason) throw blocked(reason)
          if (s.rootKnown) {
            for (const rel of bashWriteTargets(args.command, { ...ctx, cwd })) {
              const clash = conflictingClaims(ctx.info, s.rootId, rel)
              if (clash.length) {
                throw blocked(
                  `${rel} is being modified by another active opencode session (${clash.map((c) => c.sessionId).join(", ")}).`,
                  "Do not edit it now: finish the other work first or report the conflict to the orchestrator.",
                )
              }
            }
          }
          return
        }
        if (FILE_WRITE_TOOLS.has(input.tool)) {
          for (const target of editTargets(input.tool, args)) {
            const abs = path.resolve(ctx.cwd, target)
            const reason = checkWritePath(abs, ctx)
            if (reason) throw blocked(`${input.tool}: ${reason}`)
            if (s.rootKnown) {
              const rel = toRel(ctx.info, abs)
              const clash = rel ? conflictingClaims(ctx.info, s.rootId, rel) : []
              if (clash.length) {
                throw blocked(
                  `${rel} is being modified by another active opencode session (${clash.map((c) => c.sessionId).join(", ")}).`,
                  "Do not edit it now: finish the other work first or report the conflict to the orchestrator.",
                )
              }
            }
          }
        }
      } catch (e) {
        if (e instanceof GuardBlock) {
          markLogged(input.callID)
          const subject = callSubject(input.tool, output && output.args)
          record(input.sessionID, {
            type: "guard_block", tool: input.tool, callId: input.callID || null,
            ...(subject !== undefined ? { command: subject } : {}),
            reason: clipText(e.message.replace(/^\[pipeline-guard\] Blocked: /, ""), 400),
          })
          throw e
        }
        log("warn", `tool.execute.before: ${e.message}`)
      }
    },

    "tool.execute.after": async (input, output) => {
      try {
        const s = sessions.get(input.sessionID)
        if (s && s.pipeline && !(input.callID && loggedCalls.has(input.callID))) {
          markLogged(input.callID)
          const subject = callSubject(input.tool, input.args)
          const meta = output && output.metadata && typeof output.metadata === "object" ? output.metadata : {}
          const exit = Number.isInteger(meta.exit) ? meta.exit : Number.isInteger(meta.exitCode) ? meta.exitCode : undefined
          record(input.sessionID, {
            type: "tool", tool: input.tool, callId: input.callID || null, ok: true,
            ...(subject !== undefined ? { command: subject } : {}),
            ...(exit !== undefined ? { exit } : {}),
          })
        }
      } catch {
        /* logging is fail-open */
      }
      try {
        const s = sessions.get(input.sessionID)
        if (!s || !s.pipeline || (!FILE_WRITE_TOOLS.has(input.tool) && input.tool !== "bash")) return
        const rec = rootRec(s)
        const info = infoFor(s.directory)
        if (!rec || !info) return
        let changed = false
        const baseCwd = typeof input.args?.workdir === "string"
          ? path.resolve(s.directory || directory, input.args.workdir)
          : (s.directory || directory)
        const targets = input.tool === "bash"
          ? bashWriteTargets(input.args?.command, { info, cwd: baseCwd, scratch: scratchDir(info) })
          : editTargets(input.tool, input.args)
        for (const target of targets) {
          const rel = input.tool === "bash" ? target : toRel(info, path.resolve(baseCwd, target))
          if (rel && !rec.files[rel]) {
            rec.files[rel] = Date.now()
            changed = true
          }
        }
        if (changed) persist(rec, true)
      } catch {
        /* fail open */
      }
    },

    event: async ({ event }) => {
      try {
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
        if (idle) flushSteps(id)
        if (type === "session.idle" && id) await onIdle(id)
        else if (type === "session.status" && id && props.status && props.status.type === "idle") await onIdle(id)
        else if (type === "session.status" && id && props.status && props.status.type === "busy") {
          const s = sessions.get(id)
          if (s && s.pipeline) touchBusy(s)
        }
      } catch (e) {
        log("warn", `event: ${e.message}`)
      }
    },

    "experimental.session.compacting": async (input, output) => {
      try {
        const s = sessions.get(input.sessionID)
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
        output.context.push(lines.join("\n"))
      } catch {
        /* fail open */
      }
    },
  }
}

export default {
  id: "pipeline-guard",
  server: (input, options) => createPipelineGuard(input, options),
}
