import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { saveAgentFile } from "./agents.js"
import {
  agentRoutingOutputPath,
  buildAgentRouting,
  callersLabel,
  checkAgentRouting,
  describeAgentRouting,
  describeArchetype,
  resolveAgentRouting,
  saveAgentRoutingConfig,
  setArchetypeConfig,
  stampedModels,
} from "./agentRouting.js"

const FLASH = "mistral/flash#high"

function workspace(options: { pinEye?: string; referenceModel?: string } = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-routing-"))
  const agent = (role: string, mode: string, extra: Record<string, any> = {}) =>
    saveAgentFile(path.join(root, "src", "agents", `flow-${role}.md`), { description: role, mode, ...extra }, `${role}.`)
  agent("build", "primary", options.referenceModel ? { model: options.referenceModel } : {})
  agent("plan", "primary")
  agent("explore", "subagent")
  agent("review", "subagent")
  agent("eye", "subagent", options.pinEye ? { model: options.pinEye } : {})
  saveAgentRoutingConfig(root, { version: 2, archetypes: { flow: { configs: { mistral: { explore: FLASH, review: FLASH } } } } })
  return root
}

const read = (root: string) => JSON.parse(fs.readFileSync(agentRoutingOutputPath(root), "utf8"))

test("the archetype view: reference, related subagents, pinned subagents, configurations", () => {
  const root = workspace({ pinEye: "vision/large", referenceModel: "mistral/large" })
  const view = describeArchetype(root, "flow")!
  assert.equal(view.reference.name, "flow-build")
  assert.equal(view.reference.model, "mistral/large")
  assert.deepEqual(view.callers.map(agent => agent.name), ["flow-build", "flow-plan"], "build and plan both pick the configuration")
  assert.equal(callersLabel(view), "flow-build or flow-plan")
  assert.deepEqual(view.related.map(agent => agent.role), ["explore", "review"], "primaries are callers, not related")
  assert.deepEqual(view.pinned.map(agent => agent.name), ["flow-eye"])
  assert.deepEqual(Object.keys(view.configs), ["mistral"])
  assert.equal(describeArchetype(root, "pipeline"), null, "routable, but this workspace has no pipeline-orchestrator")
  assert.equal(describeArchetype(root, "docs"), null, "not an archetype")
})

test("build writes the plugin file; idempotent; drift fails the check", () => {
  const root = workspace()
  assert.equal(buildAgentRouting(root).changed, true)
  const flow = read(root).archetypes.flow
  assert.deepEqual(flow.roles, ["build", "explore", "eye", "plan", "review"])
  assert.deepEqual(flow.pinned, [])
  assert.deepEqual(flow.routes, { mistral: { roles: { explore: FLASH, review: FLASH } } })
  assert.equal(buildAgentRouting(root).changed, false)
  assert.deepEqual(checkAgentRouting(root).problems, [])
  saveAgentRoutingConfig(root, { version: 2, archetypes: { flow: { configs: {} } } })
  assert.match(checkAgentRouting(root).problems[0], /out of date/)
})

test("setArchetypeConfig saves, renames, deletes and rebuilds; invalid input is rejected before saving", () => {
  const root = workspace()
  setArchetypeConfig(root, "flow", "mistral/glm", { review: "mistral/large", explore: "inherit" })
  assert.deepEqual(read(root).archetypes.flow.routes["mistral/glm"].roles, { explore: "inherit", review: "mistral/large" })
  setArchetypeConfig(root, "flow", "mistral/glm-2", { review: "mistral/large" }, { previousTrigger: "mistral/glm" })
  assert.deepEqual(Object.keys(read(root).archetypes.flow.routes), ["mistral", "mistral/glm-2"])
  assert.throws(() => setArchetypeConfig(root, "flow", "mistral", {}, { previousTrigger: "mistral/glm-2" }), /already has a configuration/)
  setArchetypeConfig(root, "flow", "mistral/glm-2", null)
  assert.throws(() => setArchetypeConfig(root, "flow", "mistral/glm-2", null), /No configuration/)

  assert.throws(() => setArchetypeConfig(root, "flow", "bad key", {}), /provider\/model/)
  assert.throws(() => setArchetypeConfig(root, "flow", "mistral", { review: "flash" }), /not "inherit"/)
  assert.throws(() => setArchetypeConfig(root, "docs", "mistral", {}), /not a routable archetype/)
  assert.deepEqual(Object.keys(read(root).archetypes.flow.routes), ["mistral"], "rejected changes never reach the files")
})

test("pinned and unknown roles are warned about and left out of the plugin file", () => {
  const root = workspace({ pinEye: "vision/large" })
  setArchetypeConfig(root, "flow", "x", { eye: "a/b", ghost: "a/b", review: "a/c" })
  const { warnings } = resolveAgentRouting(root)
  assert.ok(warnings.some(warning => /x"\]\.eye: ignored, flow-eye has a fixed model/.test(warning)))
  assert.ok(warnings.some(warning => /ghost: ignored/.test(warning)))
  assert.deepEqual(read(root).archetypes.flow.routes.x.roles, { review: "a/c" })
  assert.deepEqual(read(root).archetypes.flow.pinned, ["eye"])
})

test("stampedModels: what a bridge writes for one reference model", () => {
  const root = workspace({ pinEye: "vision/large" })
  setArchetypeConfig(root, "flow", "mistral/glm", { review: "mistral/large" })
  assert.deepEqual(stampedModels(root, "flow", "mistral/large-4#high"), {
    "flow-build": "mistral/large-4#high", "flow-plan": "mistral/large-4#high",
    "flow-explore": FLASH, "flow-review": FLASH, "flow-eye": "vision/large",
  }, "provider configuration, pinned eye kept")
  assert.equal(stampedModels(root, "flow", "mistral/glm")["flow-review"], "mistral/large", "the exact model wins")
  assert.equal(stampedModels(root, "flow", "mistral/glm")["flow-explore"], "mistral/glm", "a missing role inherits")
  assert.throws(() => stampedModels(root, "flow", "anthropic/x"), /no configuration/)
})

test("pipeline: the orchestrator is the reference and roles may contain underscores", () => {
  const root = workspace()
  const agent = (role: string, mode: string, extra: Record<string, any> = {}) =>
    saveAgentFile(path.join(root, "src", "agents", `pipeline-${role}.md`), { description: role, mode, ...extra }, `${role}.`)
  agent("orchestrator", "primary", { model: "mistral/large" })
  agent("code_reviewer", "subagent")
  agent("planner", "subagent")
  const view = describeArchetype(root, "pipeline")!
  assert.equal(view.reference.name, "pipeline-orchestrator")
  assert.deepEqual(view.callers.map(a => a.name), ["pipeline-orchestrator"])
  assert.deepEqual(view.related.map(a => a.role), ["code_reviewer", "planner"])
  setArchetypeConfig(root, "pipeline", "mistral", { code_reviewer: FLASH })
  const pipeline = read(root).archetypes.pipeline
  assert.deepEqual(pipeline.roles, ["code_reviewer", "orchestrator", "planner"])
  assert.deepEqual(pipeline.routes, { mistral: { roles: { code_reviewer: FLASH } } })
  assert.deepEqual(read(root).archetypes.flow.routes, { mistral: { roles: { explore: FLASH, review: FLASH } } }, "flow is untouched")
})

test("without configurations nothing is written", () => {
  const root = workspace()
  fs.rmSync(path.join(root, ".agent-manager", "agent-routing.json"))
  assert.deepEqual(buildAgentRouting(root), { path: agentRoutingOutputPath(root), changed: false, configured: false, warnings: [] })
  assert.ok(!fs.existsSync(agentRoutingOutputPath(root)))
  assert.deepEqual(checkAgentRouting(root).problems, [])
  assert.match(describeAgentRouting(root).join("\n"), /configurations: none/)
})
