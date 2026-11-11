import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { tempDir, writePack } from "../../test/helpers.js"
import { changeTarget, installChange, reconcileChange, uninstallChange, type ChangeOptions } from "./installer.js"
import { addSource, type SourceRegistry } from "./sources.js"
import {
  buildRuntimeRouting, effectiveOverrides, loadOverrideSettings, loadRoutingSettings, patchFrontmatter, saveOverrideSettings, saveRoutingSettings,
  scopeOf, setOverride, setRoutes, unsetOverride, unsetRoutes,
} from "./userSettings.js"

const FLOW = {
  "agents/flow-build.md": "---\nmode: primary\n---\nbuild\n",
  "agents/flow-explore.md": "---\ndescription: explore\nmode: subagent\n---\nexplore body\n",
  "agents/flow-eye.md": "---\nmode: subagent\nmodel: vision/v1\n---\neye\n",
  "commands/flow-go.md": "---\ndescription: go\n---\ngo\n",
}

function setup(t: test.TestContext) {
  const base = tempDir(t)
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(base, "config"), XDG_CACHE_HOME: path.join(base, "cache") }
  const source = path.join(base, "catalog")
  writePack(path.join(source, "flow"), FLOW, {
    name: "flow",
    archetype: { callers: ["flow-build"], reference: "flow-build" },
    routingDefaults: { mistral: { "flow-explore": "mistral/small" } },
  })
  writePack(path.join(source, "plain"), { "agents/plain.md": "plain\n" }, { name: "plain" })
  const registry: SourceRegistry = { schemaVersion: 1, sources: [], prefer: {} }
  addSource(registry, "main", source, { trusted: true })
  const target = path.join(base, "target")
  const options: ChangeOptions = { env, confirm: async () => true }
  const reconcile = () => changeTarget(target, "reconcile", registry, reconcileChange, options)
  const install = (names: string[]) => changeTarget(target, "install", registry, installChange(registry, names, env), options)
  const routing = () => JSON.parse(fs.readFileSync(path.join(target, "plugins/manage-agents-router/routing.json"), "utf8"))
  return { env, target, registry, options, reconcile, install, routing }
}

test("patchFrontmatter sets and removes fields and keeps the body byte for byte", () => {
  assert.equal(patchFrontmatter("---\nmode: subagent\nmodel: a/b\n---\n\nbody  \n", { model: null, steps: 30 }), "---\nmode: subagent\nsteps: 30\n---\n\nbody  \n")
  assert.equal(patchFrontmatter("no frontmatter\n", { hidden: true }), "---\nhidden: true\n---\nno frontmatter\n")
  assert.equal(patchFrontmatter("---\nmodel: a/b\n---\nx", { model: null }), "x")
})

test("settings: validation, scopes, effective merge and edits", (t) => {
  const { env, target } = setup(t)
  const routing = loadRoutingSettings(env)
  setRoutes(scopeOf(routing, null), "flow", "mistral", { "flow-explore": "mistral/medium" })
  setRoutes(scopeOf(routing, target), "flow", "mistral", { "flow-review": "inherit" })
  assert.throws(() => setRoutes(scopeOf(routing, null), "flow", "bad trigger", { a: "x/y" }), /invalid trigger/)
  assert.throws(() => setRoutes(scopeOf(routing, null), "flow", "mistral", { a: "nope" }), /not "inherit"/)
  saveRoutingSettings(routing, env)
  assert.deepEqual(loadRoutingSettings(env).targets[target], { flow: { mistral: { "flow-review": "inherit" } } })
  assert.equal(unsetRoutes(scopeOf(routing, target), "flow", "mistral", []), true)
  assert.equal(unsetRoutes(scopeOf(routing, target), "flow", "mistral", []), false)

  const overrides = loadOverrideSettings(env)
  setOverride(scopeOf(overrides, null), "flow", "agents", "flow-explore", { steps: 10, description: "global" })
  setOverride(scopeOf(overrides, target), "flow", "agents", "flow-explore", { steps: 40 })
  assert.throws(() => setOverride(scopeOf(overrides, null), "flow", "agents", "x", { body: "no" }), /"body" cannot be overridden/)
  assert.throws(() => setOverride(scopeOf(overrides, null), "flow", "agents", "x", { model: "bad" }), /model must be/)
  assert.deepEqual(effectiveOverrides(overrides, target, "flow").agents["flow-explore"], { steps: 40, description: "global" })
  assert.equal(unsetOverride(scopeOf(overrides, null), "flow", "agents", "flow-explore", ["steps"]), true)
  assert.deepEqual(scopeOf(overrides, null).flow.agents!["flow-explore"], { description: "global" })

  fs.writeFileSync(path.join(env.XDG_CONFIG_HOME, "manage-agents", "routing.json"), JSON.stringify({ version: 1, default: { "../x": {} } }))
  assert.throws(() => loadRoutingSettings(env), /invalid pack name/)
  fs.writeFileSync(path.join(env.XDG_CONFIG_HOME, "manage-agents", "routing.json"), JSON.stringify({ version: 1, default: {}, targets: { relative: {} } }))
  assert.throws(() => loadRoutingSettings(env), /absolute path/)
})

test("buildRuntimeRouting layers pack defaults, default and target settings; only subagents are routed; fixed models pin", () => {
  const manifest = { contract: "1.0", name: "flow", version: "1.0.0", description: "x", requires: {}, archetype: { callers: ["lead"], reference: "lead" }, routingDefaults: { p: { a: "p/1", b: "p/1", lead: "p/9" } } }
  const agents = { lead: { mode: "primary" }, a: { mode: "subagent" }, b: { mode: "subagent", model: "p/fixed" }, other: { mode: "primary" } }
  const settings = { version: 1 as const, default: { flow: { p: { a: "p/2", general: "p/3", other: "p/4" } } }, targets: { "/t": { flow: { p: { a: "inherit" }, q: { a: "q/1" } } } } }
  const routing = buildRuntimeRouting([{ manifest, agents }], settings, "/t")

  assert.deepEqual(routing?.archetypes.flow, { callers: ["lead"], pinned: ["b"], routes: { p: { a: "inherit", b: "p/1" }, q: { a: "q/1" } } })
  assert.deepEqual(buildRuntimeRouting([{ manifest, agents: { ...agents, other: { mode: "subagent", model: "p/x" } } }], settings, "/t")?.archetypes.flow.pinned, ["b", "other"], "effective mode decides")
  assert.equal(buildRuntimeRouting([{ manifest: { ...manifest, archetype: undefined }, agents }], { version: 1, default: {}, targets: {} }, "/t"), null)
})

test("settings keys such as __proto__ never touch Object.prototype", () => {
  const routes: Record<string, any> = {}
  setRoutes(routes, "flow", "__proto__", { probe: "p/m" })
  assert.equal(({} as any).probe, undefined)
  assert.deepEqual(Object.getOwnPropertyNames(routes.flow), ["__proto__"])
  assert.equal(unsetRoutes({}, "flow", "__proto__", ["toString"]), false)
  assert.equal(typeof ({} as any).toString, "function")

  const overrides: Record<string, any> = {}
  setOverride(overrides, "flow", "agents", "__proto__", { steps: 3 })
  assert.equal(unsetOverride({ flow: { agents: {} } }, "flow", "agents", "__proto__", ["hasOwnProperty"]), false)
  assert.equal(typeof ({} as any).hasOwnProperty, "function")
  assert.deepEqual(effectiveOverrides({ version: 1, default: overrides, targets: {} }, "/t", "flow").agents["__proto__" as string], { steps: 3 })
  assert.equal(({} as any).steps, undefined)
})

test("archetype packs install the engine router with generated routing; uninstall removes it", async (t) => {
  const { target, install, registry, options, routing } = setup(t)
  assert.equal((await install(["plain"])).status, "applied")
  assert.ok(!fs.existsSync(path.join(target, "plugins/manage-agents-router")), "no archetype, no router")

  assert.equal((await install(["flow"])).status, "applied")
  assert.ok(fs.existsSync(path.join(target, "plugins/manage-agents-router/index.ts")))
  assert.ok(fs.existsSync(path.join(target, "plugins/manage-agents-router/router.js")))
  assert.deepEqual(routing().archetypes, { flow: { callers: ["flow-build"], pinned: ["flow-eye"], routes: { mistral: { "flow-explore": "mistral/small" } } } })
  assert.ok(JSON.parse(fs.readFileSync(path.join(target, "opencode.json"), "utf8")).plugins.includes("./plugins/manage-agents-router"))

  assert.equal((await changeTarget(target, "uninstall", registry, uninstallChange(["flow"]), options)).status, "applied")
  assert.ok(!fs.existsSync(path.join(target, "plugins/manage-agents-router")))
  assert.ok(!(JSON.parse(fs.readFileSync(path.join(target, "opencode.json"), "utf8")).plugins ?? []).includes("./plugins/manage-agents-router"))
})

test("routing per target: settings change routing.json at reconcile, other targets untouched", async (t) => {
  const { env, target, install, reconcile, routing } = setup(t)
  await install(["flow"])
  const settings = loadRoutingSettings(env)
  setRoutes(scopeOf(settings, target), "flow", "mistral", { "flow-explore": "mistral/large" })
  setRoutes(scopeOf(settings, "/elsewhere"), "flow", "openai", { "flow-explore": "openai/mini" })
  saveRoutingSettings(settings, env)

  assert.equal((await reconcile()).status, "applied")
  assert.deepEqual(routing().archetypes.flow.routes, { mistral: { "flow-explore": "mistral/large" } })
  assert.equal((await reconcile()).status, "unchanged")
})

test("overrides patch installed frontmatter (any source), pinning changes routing, edits to the pack stay detectable", async (t) => {
  const { env, target, install, reconcile, routing } = setup(t)
  await install(["flow"])
  const overrides = loadOverrideSettings(env)
  setOverride(scopeOf(overrides, target), "flow", "agents", "flow-explore", { model: "fixed/one", steps: 12 })
  setOverride(scopeOf(overrides, target), "flow", "agents", "flow-eye", { model: null })
  setOverride(scopeOf(overrides, target), "flow", "commands", "flow-go", { description: "mine" })
  setOverride(scopeOf(overrides, target), "flow", "agents", "ghost", { hidden: true })
  saveOverrideSettings(overrides, env)

  const result = await reconcile()
  assert.equal(result.status, "applied", JSON.stringify(result.plan?.conflicts))
  assert.ok(result.plan!.warnings.some(warning => /override flow\/ghost: the pack has no agent "ghost"/.test(warning)))
  assert.equal(fs.readFileSync(path.join(target, "agents/flow-explore.md"), "utf8"), "---\ndescription: explore\nmode: subagent\nmodel: fixed/one\nsteps: 12\n---\nexplore body\n")
  assert.equal(fs.readFileSync(path.join(target, "agents/flow-eye.md"), "utf8"), "---\nmode: subagent\n---\neye\n")
  assert.match(fs.readFileSync(path.join(target, "commands/flow-go.md"), "utf8"), /description: mine/)
  assert.deepEqual(routing().archetypes.flow.pinned, ["flow-explore"])

  fs.writeFileSync(path.join(target, "agents/flow-explore.md"), "hand edit\n")
  assert.match((await reconcile()).plan!.conflicts[0], /agents\/flow-explore\.md was changed locally/)
})

test("routing settings for packs that are not archetypes are reported", async (t) => {
  const { env, install, reconcile } = setup(t)
  await install(["flow", "plain"])
  const settings = loadRoutingSettings(env)
  setRoutes(scopeOf(settings, null), "plain", "mistral", { plain: "mistral/x" })
  setRoutes(scopeOf(settings, null), "flow", "mistral", { "flow-ghost": "mistral/x" })
  saveRoutingSettings(settings, env)

  const warnings = (await reconcile()).plan!.warnings
  assert.ok(warnings.some(warning => /routing for "plain" has no effect/.test(warning)))
  assert.ok(warnings.some(warning => /"flow-ghost" is not a subagent of the pack; ignored/.test(warning)))
})
