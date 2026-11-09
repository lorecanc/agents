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

import { archetypeOf, decideSubagentModel, isModelRef, modelOf, routeFor, validateRouting } from "./_agent_router.js"

const plugin = (await import("../plugins/agent-router/index.ts")).default

const ROUTING = {
  version: 1,
  archetypes: {
    flow: {
      roles: ["build", "plan", "explore", "review", "research", "eye", "ops"],
      pinned: ["eye"],
      routes: {
        mistral: { roles: { explore: "opencode-go/flash#high", review: "opencode-go/flash#high", research: "opencode-go/flash" } },
        "mistral/tiny": { roles: { review: "mistral/big", explore: "inherit" } },
        "opencode-go": { roles: { review: "opencode-go/flash#high", general: "opencode-go/flash" } },
      },
    },
  },
}

const decide = (overrides) => decideSubagentModel(ROUTING, {
  callerAgent: "flow-build", callerModel: { providerID: "mistral", id: "glm", variant: "high" }, targetAgent: "flow-review", ...overrides,
})

test("model references and normalization", () => {
  assert.ok(isModelRef("opencode-go/deepseek-v4.1-flash#high"))
  assert.ok(isModelRef("openrouter/meta/llama-4"))
  assert.ok(!isModelRef("inherit"))
  assert.ok(!isModelRef("mistral"))
  assert.ok(!isModelRef("a/b#c#d"))
  assert.deepEqual(modelOf({ providerID: "mistral", id: "glm", variant: "high" }), { provider: "mistral", model: "glm", full: "mistral/glm#high" })
  assert.deepEqual(modelOf({ providerID: "openai", modelID: "gpt" }), { provider: "openai", model: "gpt", full: "openai/gpt" })
  assert.deepEqual(modelOf("openrouter/meta/llama#x"), { provider: "openrouter", model: "meta/llama", full: "openrouter/meta/llama#x" })
  assert.equal(modelOf({ providerID: "x" }), null)
})

test("canonical archetype agents are recognized, stamped and foreign ones are not", () => {
  assert.equal(archetypeOf(ROUTING, "flow-build")?.[2], "build")
  assert.equal(archetypeOf(ROUTING, "hybrid-flow-build"), null, "stamped bundles keep their fixed models")
  assert.equal(archetypeOf(ROUTING, "flow-frontend"), null)
  assert.equal(archetypeOf(ROUTING, "build"), null)
})

test("routes match the exact model first, then the provider", () => {
  const flow = ROUTING.archetypes.flow
  assert.equal(routeFor(flow, { providerID: "mistral", id: "tiny" }), flow.routes["mistral/tiny"])
  assert.equal(routeFor(flow, { providerID: "mistral", id: "glm" }), flow.routes.mistral)
  assert.equal(routeFor(flow, "mistral/tiny#high"), flow.routes["mistral/tiny"], "the variant does not change the route")
  assert.equal(routeFor(flow, { providerID: "anthropic", id: "x" }), null)
  assert.equal(routeFor(flow, undefined), null)
})

test("decision: route by caller provider; explicit, pinned, inherit and unknown are left alone", () => {
  assert.deepEqual(decide(), { model: "opencode-go/flash#high", role: "review" })
  assert.equal(decide({ targetAgent: "flow-ops" }), null, "no rule for the role: inherit")
  assert.equal(decide({ targetAgent: "flow-eye" }), null, "pinned roles use their own model")
  assert.equal(decide({ requestedModel: "anthropic/x" }), null, "an explicit model wins")
  assert.equal(decide({ callerModel: { providerID: "mistral", id: "tiny" }, targetAgent: "flow-explore" }), null, "explicit inherit")
  assert.equal(decide({ callerModel: { providerID: "mistral", id: "tiny" } }).model, "mistral/big")
  assert.equal(decide({ callerModel: { providerID: "anthropic", id: "x" } }), null, "unknown provider: inherit")
  assert.equal(decide({ callerAgent: "hybrid-flow-build" }), null)
  assert.equal(decide({ callerAgent: "build" }), null)
  assert.equal(decide({ callerModel: undefined }), null)
  assert.equal(decide({ callerModel: { providerID: "opencode-go", id: "flash", variant: "high" } }), null, "same model as the caller: nothing to change")
  assert.equal(decide({ callerModel: { providerID: "opencode-go", id: "kimi" }, targetAgent: "general" }).model, "opencode-go/flash", "built-in subagents by name")
  assert.equal(decideSubagentModel(null, { callerAgent: "flow-build" }), null)
})

test("validateRouting rejects malformed files", () => {
  assert.equal(validateRouting(structuredClone(ROUTING)).version, 1)
  const broken = (mutate) => { const value = structuredClone(ROUTING); mutate(value); return () => validateRouting(value) }
  assert.throws(broken(v => { v.version = 2 }), /version/)
  assert.throws(broken(v => { v.archetypes.flow.pinned = "eye" }), /pinned/)
  assert.throws(broken(v => { v.archetypes.flow.routes.mistral.roles.review = "flash" }), /not "inherit"/)
  assert.throws(broken(v => { v.archetypes.flow.routes["bad key"] = { roles: {} } }), /route key/)
  assert.throws(broken(v => { v.archetypes["Flow!"] = v.archetypes.flow }), /archetype id/)
})

function makeContext() {
  const handlers = { session: {}, tool: {} }
  const hookFor = (kind) => (name, callback) => {
    handlers[kind][name] = callback
    return () => { delete handlers[kind][name] }
  }
  return { handlers, ctx: { location: { directory: process.cwd() }, session: { hook: hookFor("session") }, tool: { hook: hookFor("tool") } } }
}

function writeRouting(dir, value) {
  const file = path.join(dir, "routing.json")
  fs.writeFileSync(file, JSON.stringify(value))
  return file
}

test("plugin: injects the routed model into subagent calls and follows model switches", async () => {
  const dir = mkTmp("agent-router-")
  const routingPath = writeRouting(dir, ROUTING)
  const h = makeContext()
  const cleanup = await plugin.setup(h.ctx, { routingPath })
  const request = (sessionID, agent, model) => h.handlers.session["model.request"]({ sessionID, agent, model, kind: "primary" })
  const call = async (sessionID, input, extra = {}) => {
    const event = { tool: "subagent", sessionID, input, ...extra }
    await h.handlers.tool["execute.before"](event)
    return event.input
  }

  await request("s1", "flow-build", { providerID: "mistral", id: "glm", variant: "high" })
  assert.equal((await call("s1", { agent: "flow-review", prompt: "x" })).model, "opencode-go/flash#high")
  assert.equal((await call("s1", { agent: "flow-eye", prompt: "x" })).model, undefined)
  assert.equal((await call("s1", { agent: "flow-review", model: "anthropic/x" })).model, "anthropic/x")
  assert.equal((await call("s1", { subagent_type: "flow-explore" }, { tool: "task" })).model, "opencode-go/flash#high", "legacy task tool")

  // the title agent runs on a small model inside the same session: it must not change the route
  await request("s1", "title", { providerID: "opencode-go", id: "small" })
  assert.equal((await call("s1", { agent: "flow-review" })).model, "opencode-go/flash#high")

  // plan mode in the same session, on its own model: the caller's model picks the configuration
  await request("s1", "flow-plan", { providerID: "mistral", id: "tiny" })
  assert.equal((await call("s1", { agent: "flow-review" })).model, "mistral/big", "flow-plan on mistral/tiny")
  assert.equal((await call("s1", { agent: "flow-explore" })).model, undefined, "inherit keeps the caller's model")
  await request("s1", "flow-build", { providerID: "mistral", id: "glm", variant: "high" })
  assert.equal((await call("s1", { agent: "flow-review" })).model, "opencode-go/flash#high", "back to flow-build")

  // the user switches the primary to another provider mid-session
  await request("s1", "flow-build", { providerID: "anthropic", id: "x" })
  assert.equal((await call("s1", { agent: "flow-review" })).model, undefined)

  // other agents and other tools are never touched
  await request("s2", "build", { providerID: "mistral", id: "glm" })
  assert.equal((await call("s2", { agent: "flow-review" })).model, undefined)
  await request("s3", "flow-build", { providerID: "mistral", id: "glm" })
  const shell = { tool: "shell", sessionID: "s3", input: { command: "ls" } }
  await h.handlers.tool["execute.before"](shell)
  assert.deepEqual(shell.input, { command: "ls" })

  cleanup()
  assert.equal(h.handlers.tool["execute.before"], undefined)
})

test("plugin: reloads routing.json when it changes and fails open when it is broken or missing", async () => {
  const dir = mkTmp("agent-router-")
  const routingPath = writeRouting(dir, ROUTING)
  const h = makeContext()
  await plugin.setup(h.ctx, { routingPath })
  await h.handlers.session["model.request"]({ sessionID: "s", agent: "flow-build", model: { providerID: "mistral", id: "glm" } })
  const call = async () => {
    const event = { tool: "subagent", sessionID: "s", agent: "flow-build", input: { agent: "flow-review" } }
    await h.handlers.tool["execute.before"](event)
    return event.input.model
  }
  assert.equal(await call(), "opencode-go/flash#high")

  const changed = structuredClone(ROUTING)
  changed.archetypes.flow.routes.mistral.roles.review = "mistral/reviewer-large"
  writeRouting(dir, changed)
  assert.equal(await call(), "mistral/reviewer-large")

  fs.writeFileSync(routingPath, "{ not json")
  assert.equal(await call(), undefined)
  fs.rmSync(routingPath)
  assert.equal(await call(), undefined)
})

test("plugin: OPENCODE_AGENT_ROUTER=off disables every hook", async () => {
  const h = makeContext()
  await plugin.setup(h.ctx, { disabled: true })
  assert.equal(h.handlers.tool["execute.before"], undefined)
  assert.equal(h.handlers.session["model.request"], undefined)
})
