import assert from "node:assert/strict"
import { test } from "node:test"
import { registerHooks } from "node:module"
import fs from "node:fs"
import path from "node:path"
import { mkTmp } from "./_testutil.mjs"

// @opencode/plugin is not installed in this repo: stub it before the dynamic import below.
const STUB_SOURCE = `
export const Plugin = { define(definition) { return { ...definition, __defined: true } } }
`
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@opencode/plugin") return { url: "opencode-plugin-v2-stub://plugin", shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.startsWith("opencode-plugin-v2-stub:")) return { format: "module", source: STUB_SOURCE, shortCircuit: true }
    return nextLoad(url, context)
  },
})

import { declineOf, modeTarget, resolvePlanFile, shortReason } from "./_flow_mode.js"

const plugin = (await import("../plugins/flow-mode/index.ts")).default

test("modeTarget: enter only from flow-build, exit only from flow-plan", () => {
  assert.deepEqual(modeTarget("enter", "flow-build"), { target: "flow-plan" })
  assert.deepEqual(modeTarget("exit", "flow-plan"), { target: "flow-build" })
  assert.match(modeTarget("enter", "flow-plan").error, /for flow-build/)
  assert.match(modeTarget("exit", "flow-build").error, /for flow-plan/)
  assert.match(modeTarget("exit", undefined).error, /unknown/)
})

test("resolvePlanFile: a non-empty .md inside .opencode/plans only", () => {
  const dir = mkTmp("flow-mode-")
  const plans = path.join(dir, ".opencode", "plans")
  fs.mkdirSync(plans, { recursive: true })
  fs.writeFileSync(path.join(plans, "auth.md"), "# Plan\n")
  fs.writeFileSync(path.join(plans, "empty.md"), "")
  assert.equal(resolvePlanFile(dir, ".opencode/plans/auth.md").relative, path.join(".opencode", "plans", "auth.md"))
  assert.equal(resolvePlanFile(dir, path.join(plans, "auth.md")).absolute, path.join(plans, "auth.md"), "absolute paths too")
  assert.match(resolvePlanFile(dir, ".opencode/plans/missing.md").error, /does not exist/)
  assert.match(resolvePlanFile(dir, ".opencode/plans/empty.md").error, /empty/)
  assert.match(resolvePlanFile(dir, ".opencode/plans/../../README.md").error, /in \.opencode/)
  assert.match(resolvePlanFile(dir, ".opencode/plans/auth.txt").error, /\.md file/)
  assert.match(resolvePlanFile(dir, "").error, /pass the plan file/)
})

test("declineOf: rejection with and without feedback, through wrappers; other errors are not rejections", () => {
  assert.deepEqual(declineOf({ _tag: "Permission.DeclinedError" }), { declined: true })
  assert.deepEqual(declineOf({ _tag: "Permission.CorrectedError", feedback: " use JWT " }), { declined: true, feedback: "use JWT" })
  assert.deepEqual(declineOf(Object.assign(new Error("fiber"), { cause: { failure: { _tag: "Permission.CorrectedError", feedback: "no" } } })), { declined: true, feedback: "no" })
  assert.equal(declineOf(new Error("network down")), null)
  assert.equal(declineOf(undefined), null)
})

test("shortReason: one trimmed line with a default", () => {
  assert.equal(shortReason("  add\n auth  "), "add auth")
  assert.equal(shortReason(""), "plan before implementing")
  assert.equal(shortReason("x".repeat(500)).length, 160)
})

function makeContext(directory, answer) {
  const tools = {}
  const asked = []
  const switched = []
  const ctx = {
    location: { directory },
    permission: { assert: async (request) => { asked.push(request); return answer(request) } },
    session: { switchAgent: async (request) => { switched.push(request) } },
    tool: { transform: async (fn) => fn({ add: (t) => { tools[`${t.options.namespace}_${t.name}`] = t } }) },
  }
  return { ctx, tools, asked, switched }
}

const call = (agent) => ({ sessionID: "s1", agent, messageID: "m1", id: "c1" })
const textOf = (result) => result.content.map(part => part.text).join("\n")

test("plugin: flow_plan_enter asks, then switches flow-build to flow-plan; a refusal keeps build", async () => {
  const h = makeContext(mkTmp("flow-mode-"), () => undefined)
  await plugin.setup(h.ctx)
  assert.deepEqual(Object.keys(h.tools).sort(), ["flow_plan_enter", "flow_plan_exit"])
  assert.equal(h.tools.flow_plan_enter.options.permission, "flow_plan_enter")

  const result = await h.tools.flow_plan_enter.execute({ reason: "new auth flow" }, call("flow-build"))
  assert.deepEqual(h.asked[0], { sessionID: "s1", agent: "flow-build", action: "flow_plan_enter", resources: ["new auth flow"], source: { type: "tool", messageID: "m1", id: "c1" } })
  assert.deepEqual(h.switched, [{ sessionID: "s1", agent: "flow-plan" }])
  assert.match(textOf(result), /Plan mode is on/)
  await assert.rejects(h.tools.flow_plan_enter.execute({ reason: "x" }, call("flow-plan")), /for flow-build/)

  const refused = makeContext(mkTmp("flow-mode-"), () => { throw { _tag: "Permission.DeclinedError" } })
  await plugin.setup(refused.ctx)
  assert.match(textOf(await refused.tools.flow_plan_enter.execute({ reason: "x" }, call("flow-build"))), /Continue as flow-build/)
  assert.deepEqual(refused.switched, [])
})

test("plugin: flow_plan_exit needs the plan file, asks for approval, switches back or returns feedback", async () => {
  const dir = mkTmp("flow-mode-")
  fs.mkdirSync(path.join(dir, ".opencode", "plans"), { recursive: true })
  fs.writeFileSync(path.join(dir, ".opencode", "plans", "auth.md"), "# Plan\n")
  const plan = path.join(".opencode", "plans", "auth.md")

  const approved = makeContext(dir, () => undefined)
  await plugin.setup(approved.ctx)
  await assert.rejects(approved.tools.flow_plan_exit.execute({ plan: ".opencode/plans/none.md" }, call("flow-plan")), /does not exist/)
  assert.equal(approved.asked.length, 0, "no prompt without a plan")
  const ok = await approved.tools.flow_plan_exit.execute({ plan: ".opencode/plans/auth.md" }, call("flow-plan"))
  assert.equal(approved.asked[0].action, "flow_plan_exit")
  assert.deepEqual(approved.asked[0].resources, [plan])
  assert.equal(approved.asked[0].save, undefined, "approval is never saved as always-allow")
  assert.deepEqual(approved.switched, [{ sessionID: "s1", agent: "flow-build" }])
  assert.match(textOf(ok), /approved the plan.*todo list/s)

  const corrected = makeContext(dir, () => { throw { _tag: "Permission.CorrectedError", feedback: "use sessions, not JWT" } })
  await plugin.setup(corrected.ctx)
  const no = await corrected.tools.flow_plan_exit.execute({ plan: ".opencode/plans/auth.md" }, call("flow-plan"))
  assert.match(textOf(no), /use sessions, not JWT.*still in plan mode/s)
  assert.deepEqual(corrected.switched, [])

  const broken = makeContext(dir, () => { throw new Error("server gone") })
  await plugin.setup(broken.ctx)
  await assert.rejects(broken.tools.flow_plan_exit.execute({ plan: ".opencode/plans/auth.md" }, call("flow-plan")), /server gone/)
  assert.deepEqual(broken.switched, [], "unknown errors never switch")
})
