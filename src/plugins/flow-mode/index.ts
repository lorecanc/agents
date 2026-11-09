// flow-mode: plan mode for the flow family as a mode of the same conversation (Claude Code style).
//
//   flow_plan_enter  (flow-build) the user confirms, the session switches to flow-plan
//   flow_plan_exit   (flow-plan)  the user approves the plan file, the session switches back to
//                    flow-build; a rejection keeps plan mode and returns the user's feedback
//
// How (V2 plugin API, verified against OpenCode 2.1.3)
//   ctx.permission.assert  shows OpenCode's permission prompt. Plugin tools get no permission check
//                          of their own (a `deny` rule only hides them), so each tool asks here.
//                          No `save`: "always" cannot turn the approval off for good.
//   ctx.session.switchAgent  sets the session agent; OpenCode re-reads it before every model step,
//                          so the next step of the same turn already runs as the new agent.
// Users can still switch by hand (Shift+Tab, /flow-plan); these tools make the switch part of the
// workflow. The rules and texts live in ../../tools/_flow_mode.js.

import { Plugin } from "@opencode/plugin"

import {
  ENTER_DESCRIPTION, EXIT_DESCRIPTION, approvedMessage, declineOf, declinedMessage, enteredMessage, modeTarget,
  resolvePlanFile, shortReason,
} from "../../tools/_flow_mode.js"

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] })

export async function setupFlowMode(ctx: any) {
  const directory: string = ctx?.location?.directory || process.cwd()

  const ask = (action: string, resource: string, call: any) =>
    ctx.permission.assert({
      sessionID: call.sessionID,
      agent: call.agent,
      action,
      resources: [resource],
      source: { type: "tool", messageID: call.messageID, id: call.id },
    })

  const enter = {
    name: "plan_enter",
    description: ENTER_DESCRIPTION,
    input: {
      type: "object",
      properties: { reason: { type: "string", description: "One line: why this task needs a plan first" } },
      required: ["reason"],
      additionalProperties: false,
    },
    options: { namespace: "flow", permission: "flow_plan_enter" },
    async execute(input: { reason?: string }, call: any) {
      const { target, error } = modeTarget("enter", call?.agent)
      if (error) throw new Error(error)
      try {
        await ask("flow_plan_enter", shortReason(input?.reason), call)
      } catch (e) {
        const decline = declineOf(e)
        if (!decline) throw e
        return text(`The user chose not to enter plan mode${decline.feedback ? ` and said: "${decline.feedback}"` : ""}. Continue as flow-build.`)
      }
      await ctx.session.switchAgent({ sessionID: call.sessionID, agent: target })
      return text(enteredMessage(input?.reason))
    },
  }

  const exit = {
    name: "plan_exit",
    description: EXIT_DESCRIPTION,
    input: {
      type: "object",
      properties: { plan: { type: "string", description: "Path of the plan file, .opencode/plans/<slug>.md" } },
      required: ["plan"],
      additionalProperties: false,
    },
    options: { namespace: "flow", permission: "flow_plan_exit" },
    async execute(input: { plan?: string }, call: any) {
      const { target, error } = modeTarget("exit", call?.agent)
      if (error) throw new Error(error)
      const plan = resolvePlanFile(directory, input?.plan)
      if (plan.error) throw new Error(plan.error)
      try {
        await ask("flow_plan_exit", plan.relative!, call)
      } catch (e) {
        const decline = declineOf(e)
        if (!decline) throw e
        return text(declinedMessage(plan.relative!, decline.feedback))
      }
      await ctx.session.switchAgent({ sessionID: call.sessionID, agent: target })
      return text(approvedMessage(plan.relative!))
    },
  }

  await ctx.tool.transform((editor: any) => {
    editor.add(enter)
    editor.add(exit)
  })
}

export default Plugin.define({
  id: "flow-mode",
  setup: setupFlowMode,
})
