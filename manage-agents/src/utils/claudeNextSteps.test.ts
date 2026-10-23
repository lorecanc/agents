import assert from "node:assert/strict"
import test from "node:test"
import { claudeNextSteps } from "./claudeNextSteps.js"

test("claudeNextSteps scopes the orchestrator agent to the plugin", () => {
  const lines = claudeNextSteps("decent-pipeline", "orchestrator", "/some/dir")

  assert.ok(
    lines.some(line => line.includes("--agent decent-pipeline:orchestrator")),
    `expected a plugin-scoped agent line, got ${JSON.stringify(lines)}`
  )
  assert.equal(
    lines.some(line => line.includes("--agent orchestrator")),
    false,
    `must not emit the unscoped agent name, got ${JSON.stringify(lines)}`
  )
})

test("claudeNextSteps omits the agent line when there is no orchestrator", () => {
  const lines = claudeNextSteps("decent-pipeline", null, "/some/dir")

  assert.equal(
    lines.some(line => line.includes("--agent")),
    false,
    `expected no agent line, got ${JSON.stringify(lines)}`
  )
  assert.ok(
    lines.some(line => line.trim() === "claude plugin validate /some/dir --strict"),
    `expected the validate line to remain, got ${JSON.stringify(lines)}`
  )
})
