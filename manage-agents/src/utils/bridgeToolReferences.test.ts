import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { adaptToolReferences, collectBashAllowlist, isOpenCodeCustomToolKey, renderBashAllowlistSection, RUNTIME_NOTE_MARKER } from "./bridgeToolReferences.js"
import { bridgeToClaudeCode } from "./bridge.js"
import { DEFAULT_TRANSLATION_CONFIG } from "./translationConfig.js"
import type { AgentInfo } from "./agents.js"

function agent(filename: string, frontmatter: Record<string, any>, body: string): AgentInfo {
  return { filename, currentPath: `/tmp/${filename}`, targetPath: `/tmp/${filename}`, category: "pipeline", description: filename, model: "x/y", rawContent: body, frontmatter, body, allowedSubagents: [] }
}

const ORCHESTRATOR_BODY = [
  "# Orchestrator",
  "",
  "## Progress tracking (todowrite)",
  "Use `todowrite` in the same turn as the Task call(s). Launch multiple Task tool calls.",
  "Call `pipeline_state` if it is available; otherwise ask for a baseline. Ask the user (use `question`).",
  "Read untracked files with `read`. The word question and task in prose stay unchanged."
].join("\n")

test("custom tool keys are recognized generically, MCP keys are not", () => {
  for (const key of ["pipeline_state", "pipeline_env", "pipeline_new_tool"]) assert.equal(isOpenCodeCustomToolKey(key), true, key)
  for (const key of ["cwe-search_*", "codebase-memory-mcp_*", "todowrite", "external_directory"]) assert.equal(isOpenCodeCustomToolKey(key), false, key)
})

test("Claude rewrite maps OpenCode tool names and inserts one note after the H1", () => {
  const result = adaptToolReferences(ORCHESTRATOR_BODY, "claude", { permission: { pipeline_state: "allow", pipeline_verify: "allow", pipeline_commit: "deny" } })
  assert.deepEqual(result.unavailable, ["pipeline_state", "pipeline_verify"])
  assert.match(result.body, /^# Orchestrator\n\n> \*\*Runtime note \(OpenCode bridge\)\.\*\* This prompt was written for OpenCode and runs here in Claude Code\./)
  assert.match(result.body, /## Progress tracking \(TodoWrite\)/)
  assert.match(result.body, /Use `TodoWrite` in the same turn as the Agent call\(s\)\. Launch multiple Agent tool calls\./)
  assert.match(result.body, /\(use `AskUserQuestion`\)/)
  assert.match(result.body, /with `Read`\./)
  assert.match(result.body, /The word question and task in prose stay unchanged\./)
  // The original fallback text is preserved, not deleted.
  assert.match(result.body, /Call `pipeline_state` if it is available; otherwise ask for a baseline\./)
  assert.doesNotMatch(result.body, /pipeline_commit/)
  // Idempotent: a second pass leaves the body untouched.
  assert.equal(adaptToolReferences(result.body, "claude").body, result.body)
  assert.equal(result.body.split(RUNTIME_NOTE_MARKER).length - 1, 1)
})

test("bodies without OpenCode-only references are left unchanged", () => {
  const body = "You review code. Report findings."
  assert.equal(adaptToolReferences(body, "claude", { permission: { read: "allow" } }).body, body)
  assert.equal(adaptToolReferences(body, "codex").body, body)
})

test("bash allowlists are collected per decision and documented as not enforced", () => {
  const allowlist = collectBashAllowlist("executor", { permission: { bash: { "*": "deny", "git diff*": "allow", "npm *": "allow", "rm *": "ask", "git push*": "deny" } } })
  assert.deepEqual(allowlist, { agent: "executor", rules: { allow: ["git diff*", "npm *"], ask: ["rm *"], deny: ["git push*"] } })
  assert.equal(collectBashAllowlist("planner", { permission: { bash: "deny" } }), null)
  const section = renderBashAllowlistSection("claude", [allowlist!]).join("\n")
  assert.match(section, /## Per-agent bash allowlists \(not enforced\)/)
  assert.match(section, /only accept a `tools:` list/)
  assert.match(section, /<summary>executor \(4 rules\)<\/summary>/)
  assert.match(section, /- allow: `git diff\*`, `npm \*`/)
})

test("Claude bridge output carries the runtime note, translated names, and allowlist README section", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bridge-tools-"))
  const output = path.join(workspace, "export", "bridges", "claude-code", "decent-pipeline")
  const orchestrator = agent("pipeline-orchestrator.md", { mode: "primary", permission: { pipeline_state: "allow", pipeline_env: "allow", todowrite: "allow", question: "allow" } }, ORCHESTRATOR_BODY)
  const executor = agent("pipeline-executor.md", { mode: "subagent", permission: { edit: "allow", bash: { "*": "deny", "git status*": "allow" } } }, "Implement the plan.")
  const result = bridgeToClaudeCode([orchestrator, executor], "decent-pipeline", "pipeline-", output, workspace, DEFAULT_TRANSLATION_CONFIG, { category: "pipeline" })
  const generated = fs.readFileSync(path.join(output, "agents", "orchestrator.md"), "utf8")
  assert.match(generated, /tools: .*TodoWrite/)
  assert.doesNotMatch(generated, /mcp__pipeline__/)
  assert.match(generated, /not available\*\* in this environment: `pipeline_env`, `pipeline_state`\./)
  assert.match(generated, /Use `TodoWrite`/)
  assert.equal(fs.readFileSync(path.join(output, "agents", "executor.md"), "utf8").includes(RUNTIME_NOTE_MARKER), false)
  const readme = fs.readFileSync(path.join(output, "README.md"), "utf8")
  assert.match(readme, /<summary>executor \(1 rule\)<\/summary>/)
  assert.ok(result.warnings.some(warning => /permission 'pipeline_env' is not representable/.test(warning)))
})
