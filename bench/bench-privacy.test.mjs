import assert from "node:assert/strict"
import { test } from "node:test"
import fs from "node:fs"
import path from "node:path"

import { runTask } from "./bench.mjs"

for (const v2 of [false, true]) {
  test(`runTask scores the full ${v2 ? "V2" : "V1"} answer without exposing it in JSON`, { skip: process.platform === "win32" }, async (t) => {
    const scratch = path.resolve(".git/opencode-scratch")
    fs.mkdirSync(scratch, { recursive: true })
    const dir = fs.mkdtempSync(path.join(scratch, "bench-privacy-"))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

    const marker = "PRIVATE-MARKER-7392"
    const indicator = "SCORING-INDICATOR-8264"
    const answer = `${marker} ${"x".repeat(650)} ${indicator}`
    const text = { type: "text", text: answer }
    const message = v2
      ? { id: "m1", type: "assistant", agent: "flow-build", content: [text] }
      : { info: { role: "assistant", id: "m1", agent: "flow-build" }, parts: [{ type: "step-start" }, text, { type: "step-finish", cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }] }
    const exp = { info: { id: "ses_root", agent: "flow-build", time: { created: 1000, updated: 2000 } }, messages: v2 ? [message, { id: "m2", type: "idle", outcome: "succeeded" }] : [message] }
    const bin = path.join(dir, "opencode")
    fs.writeFileSync(bin, `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args[0] === "--version") console.log(${JSON.stringify(v2 ? "2.3.2" : "fake 1.0")})
else if (args[0] === "run") console.log(JSON.stringify(${JSON.stringify(v2 ? { type: "session.step.started", data: { sessionID: "ses_root" } } : { type: "step_start", sessionID: "ses_root" })}))
else if (args[0] === "api" && args.includes("session.list")) console.log(JSON.stringify({ data: [], cursor: {} }))
else if (args[0] === "export" || (args[0] === "session" && args[1] === "export" && args.includes("--standalone"))) console.log(JSON.stringify(${JSON.stringify(exp)}))
else process.exit(2)
`)
    fs.chmodSync(bin, 0o755)
    const options = { bin, timeoutMs: 30000, workRoot: dir, keep: false, dryRun: false, agent: "flow-build" }
    const task = { id: "privacy", fixture: "sample-app", prompt: "test", checks: [{ type: "text_contains", pattern: indicator }] }
    assert.ok(answer.indexOf(indicator) > 600)
    const result = await runTask(task, options)
    assert.equal(result.checks[0].pass, true, "scoring must use the full answer")
    assert.equal(result.pass, true, JSON.stringify(result.checks))
    const negative = await runTask({ ...task, checks: [{ type: "text_contains", pattern: "ABSENT-INDICATOR-4591" }] }, options)
    assert.equal(negative.checks[0].pass, false)
    assert.equal(negative.pass, false)
    assert.equal(JSON.stringify(result).includes(marker), false, "serialized result must not expose the answer")
  })
}
