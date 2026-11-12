// flow-guard: minimal safety net for `flow-*` agent sessions.
//
// Scope: acts ONLY on sessions whose agent name matches `flow-*` or a stamped `<profile>-flow-*`
// (hybrid-flow-build, ...). Every other session, pipeline agents included, is untouched.
//
// What it does (V2 plugin API)
//   model.request / prompt   remembers which agent owns each session (V2 tool hooks carry only the id)
//   tool.execute.before      blocks: writes outside the repository or into .git, destructive or
//                            interactive git, sudo, dangerous env overrides, reading real .env files,
//                            any repository write from the read-only agents (all but flow-build;
//                            flow-plan may write .opencode/plans/*)
//   tool.execute.after       scans the text an edit adds (secrets, injection sinks, TLS off, debug
//                            leftovers, TODOs) and appends one short note to the tool result
//   event subscription       stops the service a session started with dev_serve when it goes idle
//   read before edit         an edit, write or patch that changes an existing file needs a read of that
//                            file in the same session, and the file must not have changed since
//
// Deliberately absent (compared with pipeline-guard): no session registry, no git snapshots, no
// activity log, no doom-loop rule, no cross-session edit locks, no redirect or curl bans. Allow/ask
// decisions belong to the agent permissions; this plugin only stops what must never run, plus blind
// edits of files the session has not read.
//
// Fail-open: anything unexpected lets the call through. Emergency switch: OPENCODE_FLOW_GUARD=off

import path from "node:path"

import { Plugin } from "@opencode/plugin"

import {
  addedText, checkFlowBash, checkFlowWrite, fileStamp, flowRole, formatScanNote, inPlaceTargets, isFlowAgent, isSecretEnvFile,
  scanAddedCode, staleEditReason,
} from "../../tools/flow/_flow_guard.js"
import { repoInfo, scratchDir } from "../../tools/dev-tools/_repo.js"
import { FILE_WRITE_TOOLS, editTargets, isShellTool } from "../../tools/dev-tools/_bash_guard.js"
import { stopServicesOwnedBy } from "../../tools/dev-tools/_serve.js"

const MAX_SESSIONS = 1000
const MAX_FILES_PER_SESSION = 5000
const READ_TOOLS = new Set(["read", "view"])
// Hidden system agents that may run inside a flow session (compaction etc.) must not switch it off.
const INTERNAL_AGENTS = new Set(["title", "summary", "compaction"])

class GuardBlock extends Error {}

export async function setupFlowGuard(ctx, options = {}) {
  const disabled = options.disabled === true || String(process.env.OPENCODE_FLOW_GUARD ?? "").toLowerCase() === "off"
  if (disabled) return () => {}

  const directory = ctx?.location?.directory || process.cwd()
  /** sessionId -> agent name */
  const agents = new Map()
  /** sessionId -> true once the session called dev_serve */
  const served = new Set()
  /** sessionId -> (absolute path -> file stamp at the last read or own edit) */
  const seen = new Map()
  const infos = new Map()
  const disposers = []
  const keep = (dispose) => {
    if (typeof dispose === "function") disposers.push(dispose)
  }

  const infoFor = (cwd) => {
    const key = cwd || directory
    if (!infos.has(key)) infos.set(key, repoInfo(key))
    return infos.get(key)
  }
  const remember = (event) => {
    const id = event?.sessionID || event?.sessionId
    const agent = event?.agent
    if (!id || typeof agent !== "string" || INTERNAL_AGENTS.has(agent)) return
    if (agents.size >= MAX_SESSIONS && !agents.has(id)) agents.delete(agents.keys().next().value)
    agents.set(id, agent)
  }
  const blocked = (reason) => new GuardBlock(`[flow-guard] Blocked: ${reason}`)
  const filePathOf = (args) => {
    const fp = args.filePath ?? args.file_path ?? args.path
    return typeof fp === "string" && fp ? path.resolve(directory, fp) : null
  }
  const markSeen = (id, file) => {
    if (!seen.has(id)) {
      if (seen.size >= MAX_SESSIONS) seen.delete(seen.keys().next().value)
      seen.set(id, new Map())
    }
    const files = seen.get(id)
    if (files.size >= MAX_FILES_PER_SESSION && !files.has(file)) files.delete(files.keys().next().value)
    files.set(file, fileStamp(file))
  }

  keep(ctx.session.hook("model.request", async (event) => {
    try {
      remember(event)
    } catch {
      /* fail open */
    }
  }))
  keep(ctx.session.hook("prompt", async (event) => {
    try {
      remember(event)
    } catch {
      /* fail open */
    }
  }))

  keep(ctx.tool.hook("execute.before", async (event) => {
    try {
      const id = event?.sessionID || event?.sessionId
      const agent = agents.get(id)
      if (!isFlowAgent(agent)) return
      const role = flowRole(agent)
      const args = event.input && typeof event.input === "object" ? event.input : {}
      const info = infoFor(directory)
      if (event.tool === "dev_serve") served.add(id)
      if (READ_TOOLS.has(event.tool)) {
        const fp = args.filePath ?? args.file_path ?? args.path
        if (isSecretEnvFile(fp)) throw blocked(`reading ${path.basename(fp)} is not allowed (secrets). Use .env.example or ask the user which variables are set.`)
        return
      }
      if (!info) return
      const guardCtx = { info, cwd: directory, scratch: scratchDir(info) }
      if (isShellTool(event.tool)) {
        const cwd = typeof args.workdir === "string" ? path.resolve(directory, args.workdir) : directory
        const reason = checkFlowBash(args.command, role, { ...guardCtx, cwd })
        if (reason) throw blocked(reason)
      } else if (FILE_WRITE_TOOLS.has(event.tool)) {
        for (const target of editTargets(event.tool, args)) {
          const reason = checkFlowWrite(path.resolve(directory, target), role, guardCtx)
          if (reason) throw blocked(`${event.tool}: ${reason}`)
        }
        for (const target of inPlaceTargets(event.tool, args)) {
          const file = path.resolve(directory, target)
          const reason = staleEditReason(file, seen.get(id)?.get(file))
          if (reason) throw blocked(`${event.tool}: ${reason}`)
        }
      }
    } catch (e) {
      if (e instanceof GuardBlock) throw e
    }
  }))

  keep(ctx.tool.hook("execute.after", async (event) => {
    try {
      const id = event?.sessionID || event?.sessionId
      if (!isFlowAgent(agents.get(id)) || event?.status === "error") return
      const args = event.input && typeof event.input === "object" ? event.input : {}
      if (READ_TOOLS.has(event.tool)) {
        const read = filePathOf(args)
        if (read) markSeen(id, read)
        return
      }
      if (!FILE_WRITE_TOOLS.has(event.tool)) return
      // The agent knows what it just wrote: a follow-up edit needs no re-read.
      for (const target of editTargets(event.tool, args)) markSeen(id, path.resolve(directory, target))
      const file = editTargets(event.tool, args)[0] || ""
      const note = formatScanNote(file, scanAddedCode(addedText(event.tool, args), file))
      if (!note) return
      const result = event.result
      if (result && Array.isArray(result.content)) result.content.push({ type: "text", text: note })
      else if (result && typeof result.output === "string") result.output += `\n\n${note}`
      else if (typeof event.output === "string") event.output += `\n\n${note}`
    } catch {
      /* the scan is advisory */
    }
  }))

  keep(ctx.event.subscribe({}, async (payload) => {
    try {
      const event = payload && payload.event ? payload.event : payload
      const props = (event && event.properties) || {}
      const id = props.sessionID || props.sessionId
      const idle = event?.type === "session.idle" || (event?.type === "session.status" && props.status?.type === "idle")
      if (!idle || !id || !served.has(id)) return
      served.delete(id)
      const info = infoFor(directory)
      if (info) await stopServicesOwnedBy(info, id)
    } catch {
      /* fail open */
    }
  }))

  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        /* ignore */
      }
    }
    agents.clear()
    served.clear()
    seen.clear()
  }
}

export default Plugin.define({
  id: "flow-guard",
  setup: setupFlowGuard,
})
