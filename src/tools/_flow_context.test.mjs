import assert from "node:assert/strict"
import { test } from "node:test"
import { registerHooks } from "node:module"
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
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

import { STATUS_MAX_CHARS, TODO_REMINDER_EVERY, gitSnapshotText, openTodos, todoReminderText } from "./_flow_context.js"

const plugin = (await import("../plugins/flow-context/index.ts")).default

function mkRepo() {
  const dir = mkTmp("flow-context-")
  const sh = (...a) => execFileSync("git", a, { cwd: dir, stdio: "ignore" })
  sh("init", "-q", "-b", "main")
  sh("config", "user.email", "t@example.com")
  sh("config", "user.name", "T")
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n")
  sh("add", "-A")
  sh("commit", "-qm", "first commit")
  return dir
}

function makeContext(directory) {
  const handlers = { session: {}, tool: {} }
  const hookFor = (kind) => (name, callback) => {
    handlers[kind][name] = callback
    return () => { delete handlers[kind][name] }
  }
  return {
    handlers,
    ctx: { location: { directory }, session: { hook: hookFor("session") }, tool: { hook: hookFor("tool") } },
  }
}

test("git snapshot: branch, main branch, status and commits; null outside a repository", () => {
  const repo = mkRepo()
  fs.writeFileSync(path.join(repo, "b.txt"), "b\n")
  const text = gitSnapshotText(repo)
  assert.match(text, /snapshot and does not update/)
  assert.match(text, /Current branch: main/)
  assert.match(text, /Main branch .*: main/)
  assert.match(text, /\?\? b\.txt/)
  assert.match(text, /first commit/)
  assert.equal(gitSnapshotText(mkTmp("flow-context-nogit-")), null)
})

test("git snapshot: long status is truncated", () => {
  const repo = mkRepo()
  for (let i = 0; i < 200; i++) fs.writeFileSync(path.join(repo, `file-with-a-long-name-${i}.txt`), "x")
  const text = gitSnapshotText(repo)
  assert.match(text, /truncated; run git status/)
  assert.ok(text.length < STATUS_MAX_CHARS + 600)
})

test("open todos skip completed and cancelled items", () => {
  const open = openTodos([
    { content: "a", status: "completed" },
    { content: "b", status: "in_progress" },
    { content: "c", status: "cancelled" },
    { content: "d", status: "pending" },
    null,
  ])
  assert.deepEqual(open.map((t) => t.content), ["b", "d"])
  assert.deepEqual(openTodos(undefined), [])
  assert.match(todoReminderText(open), /\[in_progress\] b/)
})

test("plugin: snapshot for flow-build and flow-plan, todo reminder after idle tool calls", async () => {
  const repo = mkRepo()
  const h = makeContext(repo)
  const cleanup = await plugin.setup(h.ctx)
  const context = async (sessionID, agent) => {
    const event = { sessionID, agent, system: [{ type: "text", text: "base" }], messages: [] }
    await h.handlers.session.context(event)
    return event.system.slice(1).map((p) => p.text)
  }
  const tool = (sessionID, agent, name, input = {}) => h.handlers.tool["execute.after"]({ sessionID, agent, tool: name, input, status: "completed" })

  const first = await context("s1", "flow-build")
  assert.equal(first.length, 1)
  assert.match(first[0], /Current branch: main/)
  fs.writeFileSync(path.join(repo, "later.txt"), "x")
  assert.doesNotMatch((await context("s1", "flow-build"))[0], /later\.txt/, "the snapshot is taken once per session")

  assert.equal((await context("s2", "flow-plan")).length, 1)
  assert.equal((await context("s3", "flow-explore")).length, 0)
  assert.equal((await context("s4", "build")).length, 0)

  await tool("s1", "flow-build", "todowrite", { todos: [{ content: "wire the hook", status: "in_progress" }] })
  for (let i = 0; i < TODO_REMINDER_EVERY - 1; i++) await tool("s1", "flow-build", "read")
  assert.equal((await context("s1", "flow-build")).length, 1)
  await tool("s1", "flow-build", "edit")
  const reminded = await context("s1", "flow-build")
  assert.equal(reminded.length, 2)
  assert.match(reminded[1], /wire the hook/)
  assert.equal((await context("s1", "flow-build")).length, 1, "the reminder waits for another round of idle calls")

  await tool("s1", "flow-build", "todowrite", { todos: [{ content: "wire the hook", status: "completed" }] })
  for (let i = 0; i < TODO_REMINDER_EVERY; i++) await tool("s1", "flow-build", "read")
  assert.equal((await context("s1", "flow-build")).length, 1, "no reminder without open items")

  cleanup()
  assert.equal(h.handlers.session.context, undefined)
})

test("plugin: OPENCODE_FLOW_CONTEXT=off disables every hook", async () => {
  const h = makeContext(mkRepo())
  await plugin.setup(h.ctx, { disabled: true })
  assert.equal(h.handlers.session.context, undefined)
})
