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
//   event subscription       stops the service a session started with pipeline_serve when it goes idle
//
// Deliberately absent (compared with pipeline-guard): no session registry, no git snapshots, no
// activity log, no doom-loop rule, no cross-session edit locks, no redirect or curl bans. Allow/ask
// decisions belong to the agent permissions; this plugin only stops what must never run.
//
// Fail-open: anything unexpected lets the call through. Emergency switch: OPENCODE_FLOW_GUARD=off

import path from "node:path"

import { Plugin } from "@opencode/plugin"

import {
  addedText, checkFlowBash, checkFlowWrite, flowRole, formatScanNote, isFlowAgent, isSecretEnvFile, scanAddedCode,
} from "../../tools/_flow_guard.js"
import { FILE_WRITE_TOOLS, editTargets, isShellTool, repoInfo, scratchDir } from "../../tools/_pipeline_core.js"
import { stopServicesOwnedBy } from "../../tools/_pipeline_serve.js"

const MAX_SESSIONS = 1000
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
  /** sessionId -> true once the session called pipeline_serve */
  const served = new Set()
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
      if (event.tool === "pipeline_serve") served.add(id)
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
      }
    } catch (e) {
      if (e instanceof GuardBlock) throw e
    }
  }))

  keep(ctx.tool.hook("execute.after", async (event) => {
    try {
      const id = event?.sessionID || event?.sessionId
      if (!isFlowAgent(agents.get(id)) || !FILE_WRITE_TOOLS.has(event?.tool) || event?.status === "error") return
      const args = event.input && typeof event.input === "object" ? event.input : {}
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
  }
}

export default Plugin.define({
  id: "flow-guard",
  setup: setupFlowGuard,
})
