// flow-context: extra system text for `flow-*` sessions, the way Claude Code adds context reminders.
//
//   session "context"     before each model call: the git snapshot taken at the session's first call
//                         (flow-build and flow-plan). Context changes are per request and never persisted.
//
// Event shape (verified against OpenCode 2.1.3): the context event carries sessionID, agent and a
// `system` array of { type: "text", text } parts.
// Fail-open: anything unexpected leaves the request untouched. Switch: OPENCODE_FLOW_CONTEXT=off

import { Plugin } from "@opencode/plugin"

import { flowRole } from "../../tools/flow/_flow_guard.js"
import { gitSnapshotText } from "../../tools/flow/_flow_context.js"

const MAX_SESSIONS = 1000
const SNAPSHOT_ROLES = new Set(["build", "plan"])

const bounded = (map, id, value) => {
  if (map.size >= MAX_SESSIONS && !map.has(id)) map.delete(map.keys().next().value)
  map.set(id, value)
}

export async function setupFlowContext(ctx, options = {}) {
  const disabled = options.disabled === true || String(process.env.OPENCODE_FLOW_CONTEXT ?? "").toLowerCase() === "off"
  if (disabled) return () => {}

  const directory = ctx?.location?.directory || process.cwd()
  /** sessionId -> snapshot text (null outside a repository) */
  const snapshots = new Map()
  const disposers = []
  const keep = (dispose) => {
    if (typeof dispose === "function") disposers.push(dispose)
  }

  keep(ctx.session.hook("context", async (event) => {
    try {
      const id = event?.sessionID || event?.sessionId
      const role = flowRole(event?.agent)
      if (!id || !role || !Array.isArray(event.system)) return
      if (SNAPSHOT_ROLES.has(role)) {
        if (!snapshots.has(id)) bounded(snapshots, id, gitSnapshotText(directory))
        const snapshot = snapshots.get(id)
        if (snapshot) event.system.push({ type: "text", text: snapshot })
      }
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
    snapshots.clear()
  }
}

export default Plugin.define({
  id: "flow-context",
  setup: setupFlowContext,
})
