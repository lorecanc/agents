// flow-context: extra system text for `flow-*` sessions, the way Claude Code adds context reminders.
//
//   session "context"     before each model call: the git snapshot taken at the session's first call
//                         (flow-build and flow-plan), and a todo reminder for flow-build when the list
//                         has open items and was not updated for TODO_REMINDER_EVERY tool calls.
//                         Context changes are per request and never persisted.
//   tool.execute.after    tracks the latest `todowrite` list and the tool calls since it.
//
// Event shapes (verified against OpenCode 2.1.3): the context event carries sessionID, agent and a
// `system` array of { type: "text", text } parts; tool events carry sessionID, agent, tool and input.
// Fail-open: anything unexpected leaves the request untouched. Switch: OPENCODE_FLOW_CONTEXT=off

import { Plugin } from "@opencode/plugin"

import { flowRole, isFlowAgent } from "../../tools/flow/_flow_guard.js"
import { TODO_REMINDER_EVERY, gitSnapshotText, openTodos, todoReminderText } from "../../tools/flow/_flow_context.js"

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
  /** sessionId -> { open, calls } for the latest todowrite list */
  const todos = new Map()
  /** sessionId -> agent, learnt from context events in case a tool event lacks it */
  const agents = new Map()
  const disposers = []
  const keep = (dispose) => {
    if (typeof dispose === "function") disposers.push(dispose)
  }

  keep(ctx.tool.hook("execute.after", async (event) => {
    try {
      const id = event?.sessionID || event?.sessionId
      if (!id || !isFlowAgent(event?.agent ?? agents.get(id)) || event?.status === "error") return
      if (event.tool === "todowrite") {
        bounded(todos, id, { open: openTodos(event.input?.todos), calls: 0 })
        return
      }
      const state = todos.get(id)
      if (state) state.calls++
    } catch {
      /* fail open */
    }
  }))

  keep(ctx.session.hook("context", async (event) => {
    try {
      const id = event?.sessionID || event?.sessionId
      const role = flowRole(event?.agent)
      if (!id || !role || !Array.isArray(event.system)) return
      bounded(agents, id, event.agent)
      if (SNAPSHOT_ROLES.has(role)) {
        if (!snapshots.has(id)) bounded(snapshots, id, gitSnapshotText(directory))
        const snapshot = snapshots.get(id)
        if (snapshot) event.system.push({ type: "text", text: snapshot })
      }
      const state = role === "build" ? todos.get(id) : undefined
      if (state && state.open.length > 0 && state.calls >= TODO_REMINDER_EVERY) {
        event.system.push({ type: "text", text: todoReminderText(state.open) })
        state.calls = 0
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
    todos.clear()
    agents.clear()
  }
}

export default Plugin.define({
  id: "flow-context",
  setup: setupFlowContext,
})
