// Pure logic for the flow-mode plugin (src/plugins/flow-mode): plan mode as a mode of the same
// conversation, the way Claude Code does it with EnterPlanMode / ExitPlanMode.
//
//   flow_plan_enter  flow-build -> flow-plan, after the user confirms (OpenCode permission prompt)
//   flow_plan_exit   flow-plan  -> flow-build, after the user approves the plan file; a rejection
//                    keeps plan mode and hands the user's feedback back to the planner
//
// OpenCode re-reads the session agent before every model step, so the switch applies to the next
// step of the same turn: prompt, permissions and tools change, the model stays the session's.

import fs from "node:fs"
import path from "node:path"

export const BUILD_AGENT = "flow-build"
export const PLAN_AGENT = "flow-plan"
export const PLAN_DIR = path.join(".opencode", "plans")
const MAX_REASON = 160

export const ENTER_DESCRIPTION = `Switch this conversation to plan mode (flow-plan) before a non-trivial implementation: explore read-only, ask the decisive questions, write a plan, and get the user's approval before any edit. The user confirms the switch.

Use it when ANY of these applies:
- New feature with real design choices (where it goes, how it behaves)
- Several valid approaches (caching: in-memory vs Redis vs file; real-time: WebSocket vs SSE vs polling)
- Changes to existing behaviour or structure, or an architectural decision
- More than 2-3 files are likely to change
- Unclear requirements: you must explore before you know the scope
- The user's preferences matter and you would otherwise ask several clarifying questions

Do NOT use it for: typo and few-line fixes, one function with clear requirements, tasks the user specified in detail, pure research or questions about the code, or when the user asked you to just do it.`

export const EXIT_DESCRIPTION = `Ask the user to approve your plan and leave plan mode. Call it only when the plan file in ${PLAN_DIR}/ is complete and you have no open questions (resolve those with \`question\` first).

- Pass the plan file path. The user sees an approval prompt for it.
- Approved: the conversation switches back to flow-build, which implements the plan.
- Rejected: you stay in plan mode. If the user wrote feedback you get it back: revise the plan and call this tool again.
- Never ask "is the plan ok?" or "should I proceed?" in text or with \`question\`: this tool is how you ask.
- Only for plans that implement code. For research or questions, just answer.`

/** The agent a mode tool switches to, or an error message when `agent` may not call it. */
export function modeTarget(tool, agent) {
  if (tool === "enter") return agent === BUILD_AGENT ? { target: PLAN_AGENT } : { error: `flow_plan_enter is for ${BUILD_AGENT}; you are ${agent || "unknown"}.` }
  if (tool === "exit") return agent === PLAN_AGENT ? { target: BUILD_AGENT } : { error: `flow_plan_exit is for ${PLAN_AGENT}; you are ${agent || "unknown"}.` }
  return { error: `unknown mode tool '${tool}'` }
}

/** One short line for the permission prompt. */
export function shortReason(reason) {
  const text = typeof reason === "string" ? reason.replace(/\s+/g, " ").trim() : ""
  if (!text) return "plan before implementing"
  return text.length > MAX_REASON ? `${text.slice(0, MAX_REASON - 1)}…` : text
}

/**
 * Resolve the plan file: it must be a non-empty .md file inside <directory>/.opencode/plans.
 * Returns { relative, absolute } or { error }.
 */
export function resolvePlanFile(directory, file) {
  if (typeof file !== "string" || !file.trim()) return { error: `pass the plan file path (${PLAN_DIR}/<slug>.md).` }
  const plans = path.resolve(directory, PLAN_DIR)
  const absolute = path.resolve(directory, file.trim())
  const relative = path.relative(plans, absolute)
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !absolute.endsWith(".md")) {
    return { error: `the plan must be a .md file in ${PLAN_DIR}/ (got ${file}).` }
  }
  let stat
  try {
    stat = fs.statSync(absolute)
  } catch {
    return { error: `${path.join(PLAN_DIR, relative)} does not exist: write the plan first.` }
  }
  if (!stat.isFile() || stat.size === 0) return { error: `${path.join(PLAN_DIR, relative)} is empty: write the plan first.` }
  return { relative: path.join(PLAN_DIR, relative), absolute }
}

/**
 * The user's answer to a rejected permission prompt. OpenCode rejects with Permission.DeclinedError
 * (no message) or Permission.CorrectedError { feedback }; the plugin bridge may wrap either.
 * Returns { declined: true, feedback? } for a rejection, null for any other error.
 */
export function declineOf(error) {
  const seen = new Set()
  let declined = false
  const visit = (value, depth) => {
    if (!value || typeof value !== "object" || seen.has(value) || depth > 5) return undefined
    seen.add(value)
    const tag = String(value._tag ?? value.name ?? "")
    if (/Permission\.(Declined|Corrected)Error/.test(tag)) declined = true
    if (typeof value.feedback === "string" && value.feedback.trim()) return value.feedback.trim()
    for (const key of ["cause", "error", "failure", "defect"]) {
      const found = visit(value[key], depth + 1)
      if (found) return found
    }
    return undefined
  }
  const feedback = visit(error, 0)
  if (feedback) return { declined: true, feedback }
  return declined ? { declined: true } : null
}

export function enteredMessage(reason) {
  return [
    "Plan mode is on: you are now flow-plan in this same conversation (read-only; you may only write",
    `${PLAN_DIR}/*.md). Reason: ${shortReason(reason)}.`,
    "Follow the flow-plan workflow: explore (flow-explore in parallel), ask the decisive questions with",
    "`question`, write the plan file, then call flow_plan_exit with its path for the user's approval.",
  ].join(" ")
}

export function approvedMessage(planFile) {
  return [
    `The user approved the plan in ${planFile}. Plan mode is off: you are flow-build again, with write access.`,
    "Start by turning the plan into a todo list (todowrite), then implement it, verify, and report.",
  ].join(" ")
}

export function declinedMessage(planFile, feedback) {
  return feedback
    ? `The user did not approve ${planFile} and said: "${feedback}". You are still in plan mode: revise the plan accordingly (ask with \`question\` if something is unclear), then call flow_plan_exit again.`
    : `The user did not approve ${planFile}. You are still in plan mode: ask what should change (\`question\`), revise the plan, then call flow_plan_exit again.`
}
