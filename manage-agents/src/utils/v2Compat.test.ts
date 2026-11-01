import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import YAML from "yaml"
import { extractFrontmatter, parseAgentFile, saveAgentFile } from "./agents.js"
import {
  translatePermissionsV1ToV2,
  translatePermissionsV2ToV1,
  translateFrontmatterV1ToV2,
  translateFrontmatterV2ToV1,
  translateConfigV1ToV2,
  translateConfigV2ToV1,
  detectFrontmatterVersion,
  isKnownPermissionKey,
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

test("translatePermissionsV1ToV2 maps file-manipulation and list permissions", () => {
  const v1 = { apply_patch: "allow", patch: "deny", multiedit: "ask", list: "allow", pipeline_env: "allow" }
  const v2 = translatePermissionsV1ToV2(v1)
  assert.deepEqual(v2, [
    { action: "edit", resource: "*", effect: "allow" },
    { action: "edit", resource: "*", effect: "deny" },
    { action: "edit", resource: "*", effect: "ask" },
    { action: "read", resource: "*", effect: "allow" },
    { action: "pipeline_env", resource: "*", effect: "allow" },
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

test("translatePermissionsV1ToV2 lifts the global V1 wildcard to the first rule", () => {
  const v2 = translatePermissionsV1ToV2({ read: "allow", "*": "deny" })
  assert.deepEqual(v2, [
    { action: "*", resource: "*", effect: "deny" },
    { action: "read", resource: "*", effect: "allow" },
  ], "the global rule stays first even when the V1 key is written last")
})

test("translatePermissionsV2ToV1 restores the global wildcard as the first key", () => {
  const v1 = translatePermissionsV2ToV1([
    { action: "read", resource: "*", effect: "allow" },
    { action: "*", resource: "*", effect: "deny" },
  ])
  assert.deepEqual(v1, { "*": "deny", read: "allow" })
  assert.deepEqual(Object.keys(v1), ["*", "read"])
})

test("global wildcard translation is idempotent and never duplicated", () => {
  const v1 = { "*": "deny", read: "allow" }
  const v2 = translatePermissionsV1ToV2(v1)
  assert.equal(v2.filter(rule => rule.action === "*").length, 1)
  assert.deepEqual(translatePermissionsV1ToV2(translatePermissionsV2ToV1(v2)), v2)
})

test("parseAgentFile → saveAgentFile keeps the V2 global deny first", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "v2-global-permission-"))
  const filePath = path.join(workspace, "general", "agents", "pipeline-executor.md")
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, [
    "---",
    "description: Global deny",
    "model: test/model",
    "permissions:",
    '  - action: "*"',
    '    resource: "*"',
    "    effect: deny",
    "  - action: read",
    '    resource: "*"',
    "    effect: allow",
    "---",
    "",
    "Agent body."
  ].join("\n"))

  const agent = parseAgentFile(filePath, workspace)!
  assert.deepEqual(agent.frontmatter.permission, { "*": "deny", read: "allow" })
  saveAgentFile(filePath, agent.frontmatter, agent.body, agent.frontmatterVersion)

  const written = YAML.parse(extractFrontmatter(fs.readFileSync(filePath, "utf8")).yamlText!)
  assert.deepEqual(written.permissions[0], { action: "*", resource: "*", effect: "deny" })
  assert.equal(written.permissions.filter((rule: any) => rule.action === "*").length, 1)
  assert.deepEqual(parseAgentFile(filePath, workspace)!.frontmatter.permission, { "*": "deny", read: "allow" })
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

test("external_directory permissions round-trip through V2 without losing order or other permissions", () => {
  const v1 = {
    external_directory: {
      "*": "ask",
      "~/.config/opencode/skills/*": "allow",
      "/tmp/*": "allow",
    },
    bash: "deny",
    read: "allow",
  }

  const v2 = translatePermissionsV1ToV2(v1)
  assert.deepEqual(v2, [
    { action: "external_directory", resource: "*", effect: "ask" },
    { action: "external_directory", resource: "~/.config/opencode/skills/*", effect: "allow" },
    { action: "external_directory", resource: "/tmp/*", effect: "allow" },
    { action: "shell", resource: "*", effect: "deny" },
    { action: "read", resource: "*", effect: "allow" },
  ], "V2 rules preserve V1 permission and external resource order")
  const v1Again = translatePermissionsV2ToV1(v2)
  assert.deepEqual(v1Again, v1)
  assert.deepEqual(Object.keys(v1Again.external_directory), Object.keys(v1.external_directory),
    "V1 round-trip preserves external_directory rule order")
  assert.deepEqual(Object.keys(v1Again), Object.keys(v1), "V1 round-trip preserves top-level permission order")
})

test("translatePermissionsV2ToV1 passes through only the closed set of V2-only actions", () => {
  const v2 = [
    { action: "todowrite", resource: "*", effect: "allow" as const },
    { action: "skill", resource: "*", effect: "allow" as const },
    { action: "mcp-resource", resource: "*", effect: "allow" as const },
    { action: "opencode_session_rename", resource: "*", effect: "allow" as const },
    { action: "pipeline_env", resource: "*", effect: "allow" as const },
  ]
  const v1 = translatePermissionsV2ToV1(v2)
  assert.deepEqual(v1, {
    todowrite: "allow",
    skill: "allow",
    "mcp-resource": "allow",
    opencode_session_rename: "allow",
    pipeline_env: "allow",
  }, "V2-only actions must keep their own key so no permission silently disappears")
})

test("translatePermissionsV2ToV1 drops V1 spellings and unknown actions (fail closed)", () => {
  const actions = ["bash", "write", "task", "execute", "list", "apply_patch", "patch", "multiedit", "not-a-tool"]
  const v2 = actions.map(action => ({ action, resource: "*", effect: "allow" as const }))

  assert.deepEqual(translatePermissionsV2ToV1(v2), {},
    "an action outside the V2 vocabulary must not become a V1 permission key")
})

test("translatePermissionsV2ToV1 rejects inherited member and malformed action names", () => {
  const v2 = [
    { action: "constructor", resource: "*", effect: "allow" as const },
    { action: "toString", resource: "pattern", effect: "allow" as const },
    { action: "__proto__", resource: "pattern", effect: "allow" as const },
    { action: "Not A Tool", resource: "*", effect: "allow" as const },
  ]
  const v1 = translatePermissionsV2ToV1(v2)

  assert.deepEqual(v1, {})
  assert.equal(Object.getPrototypeOf(v1), Object.prototype, "no action may touch the result prototype")
})

test("V1 permission keys never resolve inherited Object members", () => {
  assert.deepEqual(translatePermissionsV1ToV2({ constructor: "allow", toString: "allow" }), [],
    "inherited member names are unknown keys and fail closed")
})

test("V1 permission translation drops unknown non-MCP keys but keeps MCP and pipeline actions", () => {
  const v1 = {
    "not-a-tool": "allow",
    constructor: "allow",
    "codebase-memory-mcp_*": "allow",
    "chrome-devtools_click": "deny",
    pipeline_env: "allow",
  }

  assert.deepEqual(translatePermissionsV1ToV2(v1), [
    { action: "codebase-memory-mcp_*", resource: "*", effect: "allow" },
    { action: "chrome-devtools_click", resource: "*", effect: "deny" },
    { action: "pipeline_env", resource: "*", effect: "allow" },
  ])
})

test("V1 bash rules keep their resource order (V2 last-match-wins)", () => {
  const v1 = {
    bash: {
      "git push *": "ask",
      "git status": "allow",
      "*": "deny",
    },
  }

  assert.deepEqual(translatePermissionsV1ToV2(v1), [
    { action: "shell", resource: "git push *", effect: "ask" },
    { action: "shell", resource: "git status", effect: "allow" },
    { action: "shell", resource: "*", effect: "deny" },
  ], "bash resource order is preserved for last-match-wins evaluation")
})

test("V1 task maps to subagent and external_directory keeps ask-before-allow order", () => {
  const v1 = {
    task: "allow",
    external_directory: {
      "*": "ask",
      "~/.config/opencode/skills/*": "allow",
    },
  }

  assert.deepEqual(translatePermissionsV1ToV2(v1), [
    { action: "subagent", resource: "*", effect: "allow" },
    { action: "external_directory", resource: "*", effect: "ask" },
    { action: "external_directory", resource: "~/.config/opencode/skills/*", effect: "allow" },
  ])
})

test("V1 translation drops doom_loop and keeps lsp", () => {
  const v2 = translatePermissionsV1ToV2({ doom_loop: "deny", lsp: "allow" })
  assert.deepEqual(v2, [{ action: "lsp", resource: "*", effect: "allow" }])
  assert.equal(v2.some(rule => rule.action === "doom_loop"), false)
})

test("V1 MCP server actions survive a V1 → V2 → V1 round trip", () => {
  const v1 = {
    "codebase-memory-mcp_*": "allow",
    "chrome-devtools_click": { "*": "ask", page: "deny" },
    bash: "ask",
  }

  const v2 = translatePermissionsV1ToV2(v1)
  assert.deepEqual(v2, [
    { action: "codebase-memory-mcp_*", resource: "*", effect: "allow" },
    { action: "chrome-devtools_click", resource: "*", effect: "ask" },
    { action: "chrome-devtools_click", resource: "page", effect: "deny" },
    { action: "shell", resource: "*", effect: "ask" },
  ])

  const v1Again = translatePermissionsV2ToV1(v2)
  assert.deepEqual(v1Again, v1)
  assert.deepEqual(Object.keys(v1Again), Object.keys(v1))
})

test("MCP resource keys map to the V2 runtime actions and collapse list templates", () => {
  const v1 = {
    read_mcp_resource: "allow",
    list_mcp_resources: "allow",
    list_mcp_resource_templates: "allow",
  }

  assert.deepEqual(translatePermissionsV1ToV2(v1), [
    { action: "opencode_read_mcp_resource", resource: "*", effect: "allow" },
    { action: "opencode_list_mcp_resources", resource: "*", effect: "allow" },
  ], "list_mcp_resource_templates and list_mcp_resources collapse to one V2 action")

  assert.deepEqual(translatePermissionsV2ToV1(translatePermissionsV1ToV2(v1)), {
    read_mcp_resource: "allow",
    list_mcp_resources: "allow",
  })
})

test("legacy mcp-resource does not duplicate the explicit MCP resource actions", () => {
  const v2 = translatePermissionsV1ToV2({
    "mcp-resource": "allow",
    read_mcp_resource: "allow",
    list_mcp_resources: "allow",
    list_mcp_resource_templates: "allow",
  })

  assert.deepEqual(v2, [
    { action: "opencode_read_mcp_resource", resource: "*", effect: "allow" },
    { action: "opencode_list_mcp_resources", resource: "*", effect: "allow" },
  ])
})

test("V2 → V1 → V2 round trip preserves a unique action/resource set", () => {
  const v2 = [
    { action: "opencode_read_mcp_resource", resource: "codebase-memory:*", effect: "allow" as const },
    { action: "opencode_list_mcp_resources", resource: "*", effect: "ask" as const },
    { action: "codebase-memory-mcp_*", resource: "*", effect: "allow" as const },
    { action: "codebase-memory-mcp_query_graph", resource: "graph", effect: "allow" as const },
    { action: "shell", resource: "git status", effect: "allow" as const },
  ]

  assert.deepEqual(translatePermissionsV1ToV2(translatePermissionsV2ToV1(v2)), v2)
})

test("translatePermissionsV2ToV1 keeps the explicit V2-to-V1 renames", () => {
  const v1 = translatePermissionsV2ToV1([
    { action: "shell", resource: "*", effect: "allow" as const },
    { action: "subagent", resource: "reviewer", effect: "allow" as const },
    { action: "edit", resource: "*", effect: "allow" as const },
  ])
  assert.deepEqual(v1, { bash: "allow", task: { reviewer: "allow" }, edit: "allow" })
})

test("documented lossy collapse: V2 'read' becomes V1 'read' and cannot reconstruct a V2 'list' rule", () => {
  // The V1 vocabulary has both `read` and `list`; V2 only has `read`. The
  // collapse is intentional, so a V2 corpus without `list` stays without it.
  const v1 = translatePermissionsV2ToV1([{ action: "read", resource: "*", effect: "allow" as const }])
  assert.deepEqual(v1, { read: "allow" })
  assert.equal("list" in v1, false, "list cannot be recovered and must not be invented")
  assert.deepEqual(translatePermissionsV1ToV2(v1), [{ action: "read", resource: "*", effect: "allow" }])
})

test("isKnownPermissionKey accepts the built-in V1/V2 tool vocabulary", () => {
  for (const key of [
    "read", "grep", "glob", "edit", "write", "patch", "multiedit", "apply_patch",
    "shell", "bash", "execute", "lsp", "webfetch", "websearch", "skill", "question",
    "task", "subagent", "todowrite", "external_directory", "doom_loop",
    "mcp-resource", "artifact", "file-diff",
    "opencode_session_rename", "opencode_session_move",
    "opencode_worktree_create", "opencode_worktree_list", "opencode_worktree_remove",
    "pipeline_env",
  ]) {
    assert.equal(isKnownPermissionKey(key), true, `${key} is part of the known vocabulary`)
  }
})

test("isKnownPermissionKey does not accept arbitrary opencode_* MCP tool keys", () => {
  // `opencode_search` is the tool `search` of a server named `opencode`.
  assert.equal(isKnownPermissionKey("opencode_search"), false)
  assert.equal(isKnownPermissionKey("opencode_tools_query"), false)
})

test("isKnownPermissionKey rejects concrete MCP server tool keys", () => {
  for (const key of [
    "codebase-memory-mcp_delete_project",
    "chrome-devtools_click",
    "some_future_mcp_tool",
  ]) {
    assert.equal(isKnownPermissionKey(key), false, `${key} must be treated as an MCP server tool`)
  }
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

test("frontmatter V1 → V2 translation is idempotent and keeps existing permissions", () => {
  const permissions = [{ action: "shell", resource: "*", effect: "allow" as const }]
  const input = { permissions, permission: { bash: "deny" } }

  const once = translateFrontmatterV1ToV2(input)
  assert.deepEqual(once.permissions, permissions, "existing V2 permissions are never rebuilt")
  assert.equal(once.permission, undefined, "the singular legacy key is removed")

  assert.deepEqual(translateFrontmatterV1ToV2(once), once)
})

test("model#variant is composed at most once", () => {
  const composed = translateFrontmatterV1ToV2({ model: "anthropic/claude-sonnet-4-5", variant: "high" })
  assert.equal(composed.model, "anthropic/claude-sonnet-4-5#high")
  assert.equal(translateFrontmatterV1ToV2(composed).model, "anthropic/claude-sonnet-4-5#high")

  const alreadyJoined = translateFrontmatterV1ToV2({ model: "anthropic/claude-sonnet-4-5#high", variant: "high" })
  assert.equal(alreadyJoined.model, "anthropic/claude-sonnet-4-5#high")
  assert.equal(alreadyJoined.model.includes("##"), false)
})

test("temperature and top_p merge into an existing request.body", () => {
  const v1 = { temperature: 0.2, top_p: 0.8, request: { headers: { "x-test": "1" }, body: { seed: 7 } } }
  const v2 = translateFrontmatterV1ToV2(v1)

  assert.deepEqual(v2.request, {
    headers: { "x-test": "1" },
    body: { seed: 7, temperature: 0.2, top_p: 0.8 },
  })
  assert.equal(v2.temperature, undefined)
  assert.equal(v2.top_p, undefined)
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

test("translateConfigV1ToV2 moves flat mcp servers under mcp.servers and inverts enabled", () => {
  const v1 = {
    mcp: {
      "codebase-memory-mcp": {
        type: "local",
        command: ["npx", "codebase-memory-mcp"],
        environment: { GRAPH: "1" },
        enabled: true,
      },
      "remote-docs": { type: "remote", url: "https://example.test/mcp", enabled: false },
    },
  }

  const v2 = translateConfigV1ToV2(v1)
  assert.deepEqual(v2.mcp, {
    servers: {
      "codebase-memory-mcp": {
        type: "local",
        command: ["npx", "codebase-memory-mcp"],
        environment: { GRAPH: "1" },
        disabled: false,
      },
      "remote-docs": { type: "remote", url: "https://example.test/mcp", disabled: true },
    },
  })
  assert.equal("codemode" in (v2.mcp as any).servers["codebase-memory-mcp"], false)
})

test("translateConfigV1ToV2 preserves an explicit codemode on every server", () => {
  const v2 = translateConfigV1ToV2({
    mcp: {
      "local-server": { type: "local", command: ["npx", "x"], codemode: false },
      "remote-server": { type: "remote", url: "https://example.test/mcp", codemode: true },
    },
  })

  assert.equal(v2.mcp.servers["local-server"].codemode, false, "an explicit false survives")
  assert.equal(v2.mcp.servers["remote-server"].codemode, true, "the translator does not strip an existing value")
})

test("translateConfigV1ToV2 preserves codemode in an existing mcp.servers block", () => {
  const v2 = translateConfigV1ToV2({
    mcp: {
      servers: { "local-server": { type: "local", command: ["npx", "x"], codemode: true } },
    },
  })

  assert.equal(v2.mcp.servers["local-server"].codemode, true)
})

test("translateConfigV1ToV2 never invents codemode", () => {
  const v2 = translateConfigV1ToV2({
    mcp: {
      "local-server": { type: "local", command: ["npx", "x"] },
      "remote-server": { type: "remote", url: "https://example.test/mcp" },
    },
  })

  for (const name of ["local-server", "remote-server"]) {
    assert.equal("codemode" in v2.mcp.servers[name], false, `${name} must not gain codemode`)
  }
})

test("translateConfigV1ToV2 is idempotent and keeps keys outside the translation scope", () => {
  const v1 = {
    agent: { reviewer: { prompt: "Review" } },
    command: { build: { prompt: "Build" } },
    subtask: { helper: { prompt: "Help" } },
    mode: { orchestrator: { prompt: "Orchestrate" } },
    mcp: {
      "local-server": { type: "local", command: ["npx", "x"], enabled: true, codemode: false },
    },
    unrelated: { nested: { keep: true } },
  }

  const once = translateConfigV1ToV2(v1)
  assert.deepEqual(translateConfigV1ToV2(once), once, "a translated config translates to itself")
  assert.deepEqual(once.unrelated, v1.unrelated, "unknown top-level keys are untouched")
  assert.equal(once.mcp.servers["local-server"].codemode, false)

  assert.deepEqual(translateConfigV1ToV2(translateConfigV2ToV1(once)), once,
    "V2 → V1 → V2 keeps server policy and unknown keys")
})

test("mcp servers round trip from V2 back to flat V1 entries", () => {
  const v1 = {
    mcp: {
      "codebase-memory-mcp": { type: "local", command: ["npx", "x"], enabled: true },
      "remote-docs": { type: "remote", url: "https://example.test/mcp", enabled: false },
    },
  }

  assert.deepEqual(translateConfigV2ToV1(translateConfigV1ToV2(v1)), v1)
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

test("detectFrontmatterVersion detects repository V1 steps with singular permission", () => {
  assert.equal(detectFrontmatterVersion({ steps: 120, permission: { bash: "allow" } }), "v1")
})

test("detectFrontmatterVersion returns unknown for mixed or empty", () => {
  assert.equal(detectFrontmatterVersion({}), "unknown")
  assert.equal(detectFrontmatterVersion({ model: "test/model" }), "unknown")
  assert.equal(detectFrontmatterVersion({ steps: 50, max_steps: 30 }), "unknown")
})
