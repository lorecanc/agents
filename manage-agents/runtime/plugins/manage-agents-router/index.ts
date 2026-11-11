// manage-agents-router: picks the model of each subagent of an archetype from the model its caller runs on.
// Installed and kept up to date by `manage-agents reconcile`; the rules are in ./router.js and the data in the
// generated ./routing.json. Fail-open: a missing or broken routing.json, or any unexpected error, leaves the call
// as it is. OPENCODE_AGENT_ROUTER=off disables it.
//
// V2 plugin API: `model.request` remembers the agent and model of each session; `tool.execute.before` sets
// input.model on subagent calls. OpenCode picks a subagent's model as input.model ?? agent.model ?? parent model.

import fs from "node:fs"
import { fileURLToPath } from "node:url"

import { Plugin } from "@opencode/plugin"

import { SUBAGENT_TOOLS, decideSubagentModel, validateRouting } from "./router.js"

const MAX_SESSIONS = 1000
// Hidden system agents run on their own small model inside a session; they must not hide the owner's model.
const INTERNAL_AGENTS = new Set(["title", "summary", "compaction"])

export async function setupRouter(ctx, options = {}) {
  if (options.disabled === true || String(process.env.OPENCODE_AGENT_ROUTER ?? "").toLowerCase() === "off") return () => {}
  const routingPath = fileURLToPath(new URL("./routing.json", import.meta.url))
  const sessions = new Map()
  const disposers = []
  const keep = (dispose) => {
    if (typeof dispose === "function") disposers.push(dispose)
  }

  // Read on every subagent call (a few KB); parse only when it changed.
  let cached = { text: null, routing: null }
  const routing = () => {
    try {
      const text = fs.readFileSync(routingPath, "utf8")
      if (text !== cached.text) cached = { text, routing: validateRouting(JSON.parse(text)) }
    } catch {
      cached = { text: null, routing: null }
    }
    return cached.routing
  }

  keep(ctx.session.hook("model.request", async (event) => {
    try {
      const id = event?.sessionID || event?.sessionId
      const agent = event?.agent
      if (!id || typeof agent !== "string" || INTERNAL_AGENTS.has(agent)) return
      if (sessions.size >= MAX_SESSIONS && !sessions.has(id)) sessions.delete(sessions.keys().next().value)
      sessions.set(id, { agent, model: event.model })
    } catch {
      /* fail open */
    }
  }))

  keep(ctx.tool.hook("execute.before", async (event) => {
    try {
      if (!SUBAGENT_TOOLS.has(event?.tool)) return
      const input = event.input
      if (!input || typeof input !== "object") return
      const session = sessions.get(event.sessionID || event.sessionId)
      const decision = decideSubagentModel(routing(), {
        callerAgent: typeof event.agent === "string" ? event.agent : session?.agent,
        callerModel: session?.model,
        targetAgent: input.agent ?? input.subagent_type,
        requestedModel: input.model,
      })
      if (decision) input.model = decision.model
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
    sessions.clear()
  }
}

export default Plugin.define({
  id: "manage-agents-router",
  setup: setupRouter,
})
