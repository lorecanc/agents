import assert from "node:assert/strict"
import test from "node:test"

import { repoInfo, scratchDir } from "../.tree/tools/dev-tools/_repo.js"
import { childSessionIds, summarizeSession } from "./metrics.mjs"

const tool = (messageID, name, input = {}, state = {}) => ({
  type: "tool",
  messageID,
  tool: name,
  state: { status: "completed", input, metadata: {}, ...state },
})

const session = (messages, agent = "pipeline-orchestrator") => ({
  info: { id: "ses_root", agent, model: null, time: { created: 0, updated: 1 } },
  messages,
})

const assistant = (id, agent, parts) => ({ info: { role: "assistant", id, agent }, parts })

test("childSessionIds supports V2 subagent and legacy task tool calls", () => {
  const exp = session([
    assistant("m1", "pipeline-orchestrator", [
      { ...tool("m1", "subagent", { agent: "flow-explore" }), metadata: { sessionId: "ses_v2" } },
      tool("m1", "task", { subagent_type: "pipeline-explorer" }, { metadata: { sessionID: "ses_v1" } }),
    ]),
  ])

  assert.deepEqual(childSessionIds(exp).sort(), ["ses_v1", "ses_v2"])
})

test("summarizeSession counts V2 and legacy delegations, batches, width, and agent names", () => {
  const exp = session([
    assistant("m1", "pipeline-orchestrator", [
      tool("m1", "subagent", { agent: "flow-explore" }),
      tool("m1", "subagent", { subagent_type: "pipeline-explorer" }),
    ]),
    assistant("m2", "pipeline-orchestrator", [tool("m2", "task", { subagent_type: "wiki-writer" })]),
  ])

  const summary = summarizeSession(exp)
  assert.deepEqual(summary.delegations, { "flow-explore": 1, "pipeline-explorer": 1, "wiki-writer": 1 })
  assert.equal(summary.parallel_batches, 1)
  assert.equal(summary.max_parallel, 2)
})

test("summarizeSession counts pipeline and flow guard blocks", () => {
  const exp = session([
    assistant("m1", "pipeline-executor", [
      tool("m1", "shell", {}, { status: "error", error: "[pipeline-guard] Blocked: denied" }),
      tool("m1", "shell", {}, { status: "error", error: "[flow-guard] Blocked: denied" }),
    ]),
  ])

  assert.equal(summarizeSession(exp).guard_blocks, 2)
})

test("safety scan checks forbidden commands from V2 shell calls", () => {
  const info = repoInfo(process.cwd())
  const exp = session([
    assistant("m1", "pipeline-executor", [tool("m1", "shell", { command: "git checkout -b forbidden" })]),
  ])

  const summary = summarizeSession(exp, { info, scratch: scratchDir(info) })
  assert.equal(summary.violations.attempted.length, 1)
  assert.equal(summary.violations.executed.length, 1)
  assert.match(summary.violations.attempted[0].reason, /not allowed/)
})
