import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { parse } from "yaml"

function agent(name) {
  const source = readFileSync(new URL(`../../agents/${name}.md`, import.meta.url), "utf8")
  return parse(/^---\r?\n([\s\S]*?)\r?\n---/.exec(source)[1])
}

function matches(pattern, value) {
  const regex = pattern.replace(/[|\\{}()[\]^$+.]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")
  return new RegExp(`^${regex}$`).test(value)
}

function effect(agent, action, resource = "*") {
  return agent.permissions.findLast(rule => matches(rule.action, action) && matches(rule.resource, resource))?.effect
}

const plan = agent("flow-plan")
const build = agent("flow-build")
const eye = agent("flow-eye")

test("both Flow primaries can delegate to the visual reviewer", () => {
  assert.equal(eye.mode, "subagent")
  assert.equal(effect(build, "subagent", "flow-eye"), "allow", "flow-build can delegate")
  assert.equal(effect(plan, "subagent", "flow-eye"), "allow", "flow-plan can delegate")
  assert.equal(effect(plan, "subagent", "general"), "deny")
  assert.equal(effect(plan, "edit", ".opencode/plans/ui.md"), "allow")
  assert.equal(effect(plan, "edit", "src/App.tsx"), "deny")
  assert.equal(effect(eye, "edit", "src/App.tsx"), "deny")
})

test("screenshot tools stay out of Flow primary sessions without removing textual checks", () => {
  for (const [name, primary] of [["flow-build", build], ["flow-plan", plan]]) {
    for (const tool of ["chrome-devtools_take_screenshot", "XcodeBuildMCP_screenshot"]) {
      assert.equal(effect(primary, tool), "deny", `${name}: ${tool}`)
    }
  }
  assert.equal(effect(eye, "chrome-devtools_take_screenshot"), "allow")
  assert.equal(effect(eye, "read", "artifacts/ios-settings.png"), "allow")
  assert.equal(effect(build, "chrome-devtools_take_snapshot"), "allow")
  assert.equal(effect(build, "chrome-devtools_list_console_messages"), "allow")
  assert.equal(effect(build, "XcodeBuildMCP_snapshot_ui"), "allow")
  assert.equal(effect(build, "XcodeBuildMCP_test_sim"), "allow")
})
