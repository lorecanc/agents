import assert from "node:assert/strict"
import test from "node:test"
import {
  translatePermissionsV1ToV2,
  translatePermissionsV2ToV1,
  translateFrontmatterV1ToV2,
  translateFrontmatterV2ToV1,
  translateConfigV1ToV2,
  translateConfigV2ToV1,
  detectFrontmatterVersion,
} from "./v2Compat.js"

// --- Permission translation ---

test("translatePermissionsV1ToV2 converts simple string permissions", () => {
  const v1 = { bash: "allow", edit: "deny", read: "ask" }
  const v2 = translatePermissionsV1ToV2(v1)
  assert.deepEqual(v2, [
    { action: "shell", resource: "*", effect: "allow" },
    { action: "edit", resource: "*", effect: "deny" },
    { action: "read", resource: "*", effect: "ask" },
  ])
})

test("translatePermissionsV1ToV2 converts boolean permissions", () => {
  const v1 = { bash: true, edit: false }
  const v2 = translatePermissionsV1ToV2(v1)
  assert.deepEqual(v2, [
    { action: "shell", resource: "*", effect: "allow" },
    { action: "edit", resource: "*", effect: "deny" },
  ])
})

test("translatePermissionsV1ToV2 converts nested object permissions", () => {
  const v1 = { bash: { "*": "deny", "git status": "allow" } }
  const v2 = translatePermissionsV1ToV2(v1)
  assert.deepEqual(v2, [
    { action: "shell", resource: "*", effect: "deny" },
    { action: "shell", resource: "git status", effect: "allow" },
  ])
})

test("translatePermissionsV2ToV1 converts array to object", () => {
  const v2 = [
    { action: "shell", resource: "*", effect: "allow" as const },
    { action: "edit", resource: "*", effect: "deny" as const },
  ]
  const v1 = translatePermissionsV2ToV1(v2)
  assert.deepEqual(v1, { bash: "allow", edit: "deny" })
})

test("translatePermissionsV2ToV1 converts nested resources", () => {
  const v2 = [
    { action: "shell", resource: "*", effect: "deny" as const },
    { action: "shell", resource: "git status", effect: "allow" as const },
  ]
  const v1 = translatePermissionsV2ToV1(v2)
  assert.deepEqual(v1, { bash: { "*": "deny", "git status": "allow" } })
})

test("permission translation is idempotent for simple cases", () => {
  const v1 = { bash: "allow", edit: "deny", read: "ask" }
  const v2 = translatePermissionsV1ToV2(v1)
  const v1Again = translatePermissionsV2ToV1(v2)
  assert.deepEqual(v1Again, v1)
})

// --- Frontmatter translation ---

test("translateFrontmatterV1ToV2 converts max_steps to steps", () => {
  const v1 = { max_steps: 50 }
  const v2 = translateFrontmatterV1ToV2(v1)
  assert.equal(v2.steps, 50)
  assert.equal(v2.max_steps, undefined)
})

test("translateFrontmatterV1ToV2 moves temperature and top_p to request.body", () => {
  const v1 = { temperature: 0.7, top_p: 0.9 }
  const v2 = translateFrontmatterV1ToV2(v1)
  assert.equal(v2.request?.body?.temperature, 0.7)
  assert.equal(v2.request?.body?.top_p, 0.9)
  assert.equal(v2.temperature, undefined)
  assert.equal(v2.top_p, undefined)
})

test("translateFrontmatterV1ToV2 converts permission to permissions", () => {
  const v1 = { permission: { bash: "allow" } }
  const v2 = translateFrontmatterV1ToV2(v1)
  assert.deepEqual(v2.permissions, [{ action: "shell", resource: "*", effect: "allow" }])
  assert.equal(v2.permission, undefined)
})

test("translateFrontmatterV1ToV2 converts disable to disabled", () => {
  const v1 = { disable: true }
  const v2 = translateFrontmatterV1ToV2(v1)
  assert.equal(v2.disabled, true)
  assert.equal(v2.disable, undefined)
})

test("translateFrontmatterV1ToV2 converts prompt to system", () => {
  const v1 = { prompt: "You are a helpful assistant" }
  const v2 = translateFrontmatterV1ToV2(v1)
  assert.equal(v2.system, "You are a helpful assistant")
  assert.equal(v2.prompt, undefined)
})

test("translateFrontmatterV1ToV2 joins variant to model with #", () => {
  const v1 = { model: "anthropic/claude-sonnet-4-5", variant: "high" }
  const v2 = translateFrontmatterV1ToV2(v1)
  assert.equal(v2.model, "anthropic/claude-sonnet-4-5#high")
  assert.equal(v2.variant, undefined)
})

test("translateFrontmatterV2ToV1 converts steps to max_steps", () => {
  const v2 = { steps: 50 }
  const v1 = translateFrontmatterV2ToV1(v2)
  assert.equal(v1.max_steps, 50)
  assert.equal(v1.steps, undefined)
})

test("translateFrontmatterV2ToV1 moves request.body to top-level", () => {
  const v2 = { request: { body: { temperature: 0.7, top_p: 0.9 } } }
  const v1 = translateFrontmatterV2ToV1(v2)
  assert.equal(v1.temperature, 0.7)
  assert.equal(v1.top_p, 0.9)
  assert.equal(v1.request, undefined)
})

test("translateFrontmatterV2ToV1 converts permissions to permission", () => {
  const v2 = { permissions: [{ action: "shell", resource: "*", effect: "allow" as const }] }
  const v1 = translateFrontmatterV2ToV1(v2)
  assert.deepEqual(v1.permission, { bash: "allow" })
  assert.equal(v1.permissions, undefined)
})

test("translateFrontmatterV2ToV1 converts disabled to disable", () => {
  const v2 = { disabled: true }
  const v1 = translateFrontmatterV2ToV1(v2)
  assert.equal(v1.disable, true)
  assert.equal(v1.disabled, undefined)
})

test("translateFrontmatterV2ToV1 converts system to prompt", () => {
  const v2 = { system: "You are a helpful assistant" }
  const v1 = translateFrontmatterV2ToV1(v2)
  assert.equal(v1.prompt, "You are a helpful assistant")
  assert.equal(v1.system, undefined)
})

test("translateFrontmatterV2ToV1 splits model#variant", () => {
  const v2 = { model: "anthropic/claude-sonnet-4-5#high" }
  const v1 = translateFrontmatterV2ToV1(v2)
  assert.equal(v1.model, "anthropic/claude-sonnet-4-5")
  assert.equal(v1.variant, "high")
})

test("frontmatter translation is idempotent for simple cases", () => {
  const v1 = { max_steps: 50, temperature: 0.7, disable: true, prompt: "test" }
  const v2 = translateFrontmatterV1ToV2(v1)
  const v1Again = translateFrontmatterV2ToV1(v2)
  assert.deepEqual(v1Again, v1)
})

// --- Config translation ---

test("translateConfigV1ToV2 converts agent to agents", () => {
  const v1 = { agent: { reviewer: { prompt: "Review" } } }
  const v2 = translateConfigV1ToV2(v1)
  assert.deepEqual(v2.agents, { reviewer: { prompt: "Review" } })
  assert.equal(v2.agent, undefined)
})

test("translateConfigV1ToV2 converts mode to agents with primary", () => {
  const v1 = { mode: { orchestrator: { prompt: "Orchestrate" } } }
  const v2 = translateConfigV1ToV2(v1)
  assert.deepEqual(v2.agents, { orchestrator: { prompt: "Orchestrate", mode: "primary" } })
  assert.equal(v2.mode, undefined)
})

test("translateConfigV1ToV2 converts command to commands", () => {
  const v1 = { command: { build: { prompt: "Build" } } }
  const v2 = translateConfigV1ToV2(v1)
  assert.deepEqual(v2.commands, { build: { prompt: "Build" } })
  assert.equal(v2.command, undefined)
})

test("translateConfigV1ToV2 converts subtask to subagent", () => {
  const v1 = { subtask: { helper: { prompt: "Help" } } }
  const v2 = translateConfigV1ToV2(v1)
  assert.deepEqual(v2.subagent, { helper: { prompt: "Help" } })
  assert.equal(v2.subtask, undefined)
})

test("translateConfigV1ToV2 removes deprecated provider filters", () => {
  const v1 = { enabled_providers: ["anthropic"], disabled_providers: ["openai"], autoupdate: true, small_model: "claude-3-haiku" }
  const v2 = translateConfigV1ToV2(v1)
  assert.equal(v2.enabled_providers, undefined)
  assert.equal(v2.disabled_providers, undefined)
  assert.equal(v2.autoupdate, undefined)
  assert.equal(v2.small_model, undefined)
})

test("translateConfigV2ToV1 converts agents to agent", () => {
  const v2 = { agents: { reviewer: { system: "Review" } } }
  const v1 = translateConfigV2ToV1(v2)
  assert.deepEqual(v1.agent, { reviewer: { system: "Review" } })
  assert.equal(v1.agents, undefined)
})

test("translateConfigV2ToV1 converts commands to command", () => {
  const v2 = { commands: { build: { system: "Build" } } }
  const v1 = translateConfigV2ToV1(v2)
  assert.deepEqual(v1.command, { build: { system: "Build" } })
  assert.equal(v1.commands, undefined)
})

test("translateConfigV2ToV1 converts subagent to subtask", () => {
  const v2 = { subagent: { helper: { system: "Help" } } }
  const v1 = translateConfigV2ToV1(v2)
  assert.deepEqual(v1.subtask, { helper: { system: "Help" } })
  assert.equal(v1.subagent, undefined)
})

// --- Version detection ---

test("detectFrontmatterVersion detects V1 format", () => {
  const v1 = { max_steps: 50, disable: true, prompt: "test", permission: { bash: "allow" } }
  assert.equal(detectFrontmatterVersion(v1), "v1")
})

test("detectFrontmatterVersion detects V2 format", () => {
  const v2 = { steps: 50, disabled: true, system: "test", permissions: [{ action: "shell", resource: "*", effect: "allow" }] }
  assert.equal(detectFrontmatterVersion(v2), "v2")
})

test("detectFrontmatterVersion returns unknown for mixed or empty", () => {
  assert.equal(detectFrontmatterVersion({}), "unknown")
  assert.equal(detectFrontmatterVersion({ model: "test/model" }), "unknown")
  assert.equal(detectFrontmatterVersion({ steps: 50, max_steps: 30 }), "unknown")
})
