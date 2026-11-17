import assert from "node:assert/strict"
import { test } from "node:test"
import { registerHooks } from "node:module"
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { mkTmp } from "../dev-tools/_testutil.test.mjs"

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

const plugin = (await import("../../plugins/flow-guard/index.ts")).default

function mkRepo() {
  const dir = mkTmp("flow-guard-children-")
  const sh = (...a) => execFileSync("git", a, { cwd: dir, stdio: "ignore" })
  sh("init", "-q", "-b", "main")
  sh("config", "user.email", "t@example.com")
  sh("config", "user.name", "T")
  sh("config", "core.autocrlf", "false")
  fs.mkdirSync(path.join(dir, "src"), { recursive: true })
  fs.writeFileSync(path.join(dir, "src", "app.ts"), "export const value = 1\n")
  sh("add", "-A")
  sh("commit", "-qm", "init")
  return dir
}

function makeContext(directory, { getSession } = {}) {
  const handlers = { session: {}, tool: {}, event: null }
  const hookFor = (kind) => (name, callback) => {
    handlers[kind][name] = callback
    return () => { delete handlers[kind][name] }
  }
  const session = { hook: hookFor("session") }
  if (getSession) session.get = getSession
  return {
    handlers,
    ctx: {
      location: { directory },
      session,
      tool: { hook: hookFor("tool") },
      event: { subscribe: (_options, callback) => { handlers.event = callback; return () => { handlers.event = null } } },
    },
  }
}

function remember(h, sessionID, agent, parentID = undefined) {
  const event = { sessionID, agent }
  if (parentID !== undefined) event.parentID = parentID
  return h.handlers.session["model.request"](event)
}

test("general child inherits flow-build protections and scan notes", async () => {
  const dir = mkRepo()
  const file = path.join(dir, "src", "app.ts")
  const h = makeContext(dir)
  const cleanup = await plugin.setup(h.ctx)
  const before = (tool, input) => h.handlers.tool["execute.before"]({ sessionID: "s_child", tool, input })

  await remember(h, "s_flow", "flow-build", null)
  await remember(h, "s_child", "general", "s_flow")
  await assert.rejects(before("shell", { command: "git reset --hard" }), /\[flow-guard\] Blocked:.*destructive/)
  await assert.rejects(before("write", { filePath: "/tmp/flow-guard-child.txt", content: "x" }), /outside the repository/)
  await assert.rejects(before("edit", { filePath: "/tmp/flow-guard-child.txt", oldString: "x", newString: "y" }), /outside the repository/)
  await assert.rejects(before("read", { filePath: path.join(dir, ".env") }), /secrets/)
  await assert.rejects(before("edit", { filePath: file, oldString: "1", newString: "console.log(value)" }), /has not been read/)

  await h.handlers.tool["execute.after"]({
    sessionID: "s_child", tool: "read", status: "completed", input: { filePath: file }, result: { content: [] },
  })
  await before("edit", { filePath: file, oldString: "1", newString: "console.log(value)" })
  const event = {
    sessionID: "s_child", tool: "edit", status: "completed",
    input: { filePath: file, oldString: "1", newString: "console.log(value)" },
    result: { content: [{ type: "text", text: "Edit applied" }] },
  }
  await h.handlers.tool["execute.after"](event)
  assert.match(event.result.content[1].text, /\[flow-guard\] Check .*console\.log/)
  cleanup()
})

test("general child inherits the read-only flow-explore role", async () => {
  const dir = mkRepo()
  const h = makeContext(dir)
  const cleanup = await plugin.setup(h.ctx)
  const before = (tool, input) => h.handlers.tool["execute.before"]({ sessionID: "s_child", tool, input })

  await remember(h, "s_explore", "flow-explore", null)
  await remember(h, "s_child", "general", "s_explore")
  await assert.rejects(before("write", { filePath: path.join(dir, "new.txt"), content: "x" }), /read-only/)
  await assert.rejects(before("shell", { command: "echo x > src/app.ts" }), /read-only/)
  cleanup()
})

test("flow role propagates through grandchildren and session lookup shapes", async () => {
  const dir = mkRepo()
  const parents = {
    "api-child": { data: { id: "api-child", parentID: "s_flow" } },
    "api-child-data-parent-id": { data: { parentId: "s_flow" } },
    "api-child-direct-parent-id": { parentId: "s_flow" },
    "api-child-direct-parent-ID": { parentID: "s_flow" },
    "cycle-a": { data: { id: "cycle-a", parentID: "cycle-b" } },
    "cycle-b": { parentId: "cycle-a" },
  }
  const h = makeContext(dir, { getSession: async ({ sessionID }) => parents[sessionID] })
  const cleanup = await plugin.setup(h.ctx)
  const before = (sessionID, tool, input) => h.handlers.tool["execute.before"]({ sessionID, tool, input })

  await remember(h, "s_flow", "flow-build", null)
  await remember(h, "s_child", "general", "s_flow")
  await remember(h, "s_grandchild", "general", "s_child")
  await assert.rejects(before("s_grandchild", "shell", { command: "git reset --hard" }), /destructive/)
  for (const id of ["api-child", "api-child-data-parent-id", "api-child-direct-parent-id", "api-child-direct-parent-ID"]) {
    await remember(h, id, "general")
    await assert.rejects(before(id, "shell", { command: "git reset --hard" }), /destructive/)
  }

  await remember(h, "cycle-a", "general")
  await assert.doesNotReject(before("cycle-a", "shell", { command: "git reset --hard" }))
  cleanup()
})

test("child role follows late parent registration and ancestor agent switches", async () => {
  const dir = mkRepo()
  const h = makeContext(dir)
  const cleanup = await plugin.setup(h.ctx)
  const before = (tool, input) => h.handlers.tool["execute.before"]({ sessionID: "s_child", tool, input })

  await remember(h, "s_child", "general", "s_parent")
  await assert.doesNotReject(before("shell", { command: "git reset --hard" }))

  await remember(h, "s_parent", "flow-build", null)
  await before("write", { filePath: path.join(dir, "child-write.txt"), content: "x" })

  await remember(h, "s_parent", "flow-plan", null)
  await assert.rejects(before("write", { filePath: path.join(dir, "plan-blocked.txt"), content: "x" }), /read-only/)

  await remember(h, "s_parent", "build", null)
  await assert.doesNotReject(before("shell", { command: "git reset --hard" }))
  cleanup()
})

test("a delayed session lookup cannot overwrite a newer remember update", async () => {
  const dir = mkRepo()
  let markStarted
  let resolveLookup
  const started = new Promise((resolve) => { markStarted = resolve })
  const h = makeContext(dir, {
    getSession: ({ sessionID }) => {
      if (sessionID !== "s_child") return undefined
      markStarted()
      return new Promise((resolve) => { resolveLookup = () => resolve({ parentId: "s_flow" }) })
    },
  })
  const cleanup = await plugin.setup(h.ctx)
  const before = h.handlers.tool["execute.before"]({
    sessionID: "s_child", tool: "shell", input: { command: "git reset --hard" },
  })

  await remember(h, "s_flow", "flow-build", null)
  await remember(h, "s_child", "general")
  await started
  await remember(h, "s_child", "build", null)
  resolveLookup()
  await assert.doesNotReject(before)
  await assert.doesNotReject(h.handlers.tool["execute.before"]({
    sessionID: "s_child", tool: "shell", input: { command: "git reset --hard" },
  }))
  cleanup()
})

test("unrelated roots and a root agent switch remain unguarded", async () => {
  const dir = mkRepo()
  const h = makeContext(dir)
  const cleanup = await plugin.setup(h.ctx)
  const before = (sessionID) => h.handlers.tool["execute.before"]({ sessionID, tool: "shell", input: { command: "git reset --hard" } })

  await remember(h, "s_general", "general", null)
  await remember(h, "s_build", "build", null)
  await assert.doesNotReject(before("s_general"))
  await assert.doesNotReject(before("s_build"))
  await remember(h, "s_switch", "flow-build", null)
  await remember(h, "s_switch", "build", null)
  await assert.doesNotReject(before("s_switch"))
  cleanup()
})

test("missing session lookup fails open without throwing", async () => {
  const dir = mkRepo()
  const h = makeContext(dir)
  const cleanup = await plugin.setup(h.ctx)
  await remember(h, "s_orphan", "general")
  await assert.doesNotReject(h.handlers.tool["execute.before"]({
    sessionID: "s_orphan", tool: "shell", input: { command: "git reset --hard" },
  }))
  cleanup()
})
