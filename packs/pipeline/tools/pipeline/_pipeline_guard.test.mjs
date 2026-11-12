import assert from "node:assert/strict"
import { test } from "node:test"
import { registerHooks } from "node:module"
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { mkTmp } from "../dev-tools/_testutil.test.mjs"

// @opencode/plugin is not installed in this repo: stub it before the dynamic import below.
// Plugin.define is an identity function in V2; the stub marks the result so the test can prove
// the default export really went through it.
const STUB_SOURCE = `
export const Plugin = {
  define(definition) {
    globalThis.__pipelineGuardDefineCalls = (globalThis.__pipelineGuardDefineCalls || 0) + 1
    return { ...definition, __defined: true }
  },
}
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

import { repoInfo, scratchDir } from "../dev-tools/_repo.js"
import { readSession } from "../dev-tools/_sessions.js"
import { activityLogPath, readActivity, summarizeActivity } from "./_pipeline_core.js"

const plugin = (await import("../../plugins/pipeline-guard/index.ts")).default

const EXEC = "hybrid-pipeline-executor"
const ORCH = "hybrid-pipeline-orchestrator"

function mkRepo() {
  const dir = mkTmp("pipe-guard-")
  const sh = (...a) => execFileSync("git", a, { cwd: dir, stdio: "ignore" })
  sh("init", "-q", "-b", "main")
  sh("config", "user.email", "t@example.com")
  sh("config", "user.name", "T")
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n")
  fs.writeFileSync(path.join(dir, "b.txt"), "b\n")
  sh("add", "-A")
  sh("commit", "-qm", "init")
  return dir
}

// Fake V2 plugin context: every hook registration is recorded so cleanup can be asserted.
function makeContext(directory, { parents = {}, failSession = false } = {}) {
  const registrations = []
  const calls = { sessionGet: [], subscribe: [] }
  const handlers = { session: {}, tool: {}, shell: {}, permission: {}, event: null }

  const keep = (label, remove) => {
    const entry = {
      label,
      disposed: false,
      dispose() {
        if (entry.disposed) return
        entry.disposed = true
        remove?.()
      },
    }
    registrations.push(entry)
    return entry
  }

  const hookFor = (kind) => (name, callback) => {
    handlers[kind][name] = callback
    return keep(`${kind}:${name}`, () => { delete handlers[kind][name] })
  }

  const ctx = {
    location: { directory },
    session: {
      get: async (arg) => {
        calls.sessionGet.push(arg)
        if (failSession) throw new Error("no sdk")
        return { data: { id: arg.sessionID, parentID: parents[arg.sessionID] || null } }
      },
      hook: hookFor("session"),
    },
    tool: { hook: hookFor("tool") },
    shell: { hook: hookFor("shell") },
    permission: { hook: hookFor("permission") },
    event: {
      subscribe: (options, callback) => {
        calls.subscribe.push(options)
        handlers.event = callback
        return keep("event:subscribe", () => { handlers.event = null })
      },
    },
  }

  return { ctx, handlers, calls, registrations }
}

async function setup({ parents = {}, failSession = false, dir = null, options = {} } = {}) {
  const repository = dir || mkRepo()
  const harness = makeContext(repository, { parents, failSession })
  const cleanup = await plugin.setup(harness.ctx, options)
  return { ...harness, dir: repository, cleanup, info: repoInfo(repository) }
}

const modelRequest = (h, sessionID, agent) => h.handlers.session["model.request"]({ sessionID, agent })
const promptEvent = (h, sessionID, agent) => h.handlers.session.prompt({ sessionID, agent })
const before = (h, sessionID, tool, input, id = "call") =>
  h.handlers.tool["execute.before"]({ tool, sessionID, id, input })
const after = (h, sessionID, tool, input, id = "call", status = "completed", error) =>
  h.handlers.tool["execute.after"]({ tool, sessionID, id, input, status, error })
const shellCreate = (h, event) => h.handlers.shell["create.before"](event)
const emit = (h, event) => h.handlers.event({ event })
const evaluate = (h, event) => h.handlers.permission.evaluate(event)
const compact = (h, event) => h.handlers.session.compaction(event)

async function withWarnings(fn) {
  const lines = []
  const original = console.warn
  console.warn = (...args) => { lines.push(args.join(" ")) }
  try {
    await fn()
  } finally {
    console.warn = original
  }
  return lines
}

test("default export is produced by Plugin.define with the pipeline-guard id", () => {
  assert.equal(globalThis.__pipelineGuardDefineCalls, 1)
  assert.equal(plugin.__defined, true)
  assert.equal(plugin.id, "pipeline-guard")
  assert.equal(typeof plugin.setup, "function")
})

test("session.get resolves the parent chain and registers a child under its root", async () => {
  const h = await setup({ parents: { ses_child: "ses_parent", ses_parent: "ses_root" } })
  await modelRequest(h, "ses_child", EXEC)

  assert.deepEqual(h.calls.sessionGet.map((c) => c.sessionID), ["ses_child", "ses_parent", "ses_root"])
  for (const call of h.calls.sessionGet) {
    assert.deepEqual(Object.keys(call), ["sessionID"])
  }
  const root = readSession(h.info, "ses_root")
  assert.equal(root.rootId, "ses_root")
  assert.equal(root.busy, true)
  assert.equal(root.baseline.branch, "main")
  assert.deepEqual(root.baseline.dirty, [])
  assert.equal(readSession(h.info, "ses_child").rootId, "ses_root")
})

test("internal agents (title, summary, compaction) do not switch the guard off", async () => {
  const h = await setup({ parents: { ses_child: "ses_root" } })
  await modelRequest(h, "ses_root", ORCH)
  await modelRequest(h, "ses_child", EXEC)
  for (const internal of ["title", "summary", "compaction"]) {
    await promptEvent(h, "ses_child", internal)
    await assert.rejects(before(h, "ses_child", "shell", { command: "git checkout -b t1" }), /Blocked/, `after ${internal}`)
  }
  // A deliberate switch to a normal agent (user pressed Tab) turns the guard off...
  await modelRequest(h, "ses_child", "build")
  await before(h, "ses_child", "shell", { command: "git checkout -b t1" })
  // ...and switching back to a pipeline agent turns it on again.
  await promptEvent(h, "ses_child", EXEC)
  await assert.rejects(before(h, "ses_child", "shell", { command: "git checkout -b t1" }), /Blocked/)
})

test("shell.create.before injects scratch env for exactly one live root and fails open for two", async () => {
  const h = await setup()
  await modelRequest(h, "ses_root_a", ORCH)

  const first = { command: "mktemp", cwd: h.dir, env: {} }
  await shellCreate(h, first)
  assert.equal(first.env.TMPDIR, scratchDir(h.info))
  assert.equal(first.env.TMP, scratchDir(h.info))
  assert.equal(first.env.TEMP, scratchDir(h.info))
  assert.equal(first.env.PIPELINE_SCRATCH, scratchDir(h.info))
  assert.equal(first.env.PIPELINE_SESSION, "ses_root_a")
  assert.equal(first.env.GIT_EDITOR, ":")
  assert.equal(first.env.GIT_SEQUENCE_EDITOR, ":")
  assert.equal(first.env.GIT_MERGE_AUTOEDIT, "no")
  assert.ok(fs.existsSync(first.env.TMPDIR))

  // A shell in a subdirectory of the root still matches.
  fs.mkdirSync(path.join(h.dir, "sub"))
  const nested = { command: "ls", cwd: path.join(h.dir, "sub"), env: {} }
  await shellCreate(h, nested)
  assert.equal(nested.env.PIPELINE_SESSION, "ses_root_a")

  // Two live pipeline roots share the directory: cwd alone cannot tell which one runs the shell.
  await modelRequest(h, "ses_root_b", ORCH)
  const ambiguous = { command: "ls", cwd: h.dir, env: {} }
  const warnings = await withWarnings(async () => { await shellCreate(h, ambiguous) })
  assert.deepEqual(ambiguous.env, {})
  assert.ok(warnings.some((line) => line.includes("[pipeline-guard]") && line.includes("2 live pipeline roots")))

  // Once one root goes idle only the other stays live and injection resumes.
  await emit(h, { type: "session.idle", properties: { sessionID: "ses_root_a" } })
  const unambiguous = { command: "ls", cwd: h.dir, env: {} }
  await shellCreate(h, unambiguous)
  assert.equal(unambiguous.env.PIPELINE_SESSION, "ses_root_b")

  // Outside every pipeline root nothing is injected.
  const outside = { command: "ls", cwd: mkTmp("pipe-guard-outside-"), env: {} }
  await shellCreate(h, outside)
  assert.deepEqual(outside.env, {})
})

test("tool.execute.before blocks outside writes and forbidden git commands", async () => {
  const h = await setup({ parents: { ses_child: "ses_root" } })
  await modelRequest(h, "ses_root", ORCH)
  await modelRequest(h, "ses_child", EXEC)

  await assert.rejects(before(h, "ses_child", "shell", { command: "git checkout -b t1" }), /\[pipeline-guard\] Blocked: git checkout is not allowed/)
  await assert.rejects(before(h, "ses_child", "shell", { command: "git worktree add ../x" }), /worktree/)
  await assert.rejects(before(h, "ses_child", "shell", { command: "git push" }), /Blocked/)
  await assert.rejects(before(h, "ses_child", "shell", { command: "echo x > ~/out.txt" }), /outside the repository/)
  await assert.rejects(before(h, "ses_child", "shell", { command: "git rebase -i main" }), /Blocked: git rebase/)
  // Legacy V1 tool name still gets the same checks.
  await assert.rejects(before(h, "ses_child", "bash", { command: "git stash" }), /Blocked/)
  await assert.rejects(before(h, "ses_child", "edit", { filePath: "/etc/leak.txt" }), /outside the repository/)
  await assert.rejects(before(h, "ses_child", "write", { filePath: ".git/hooks/pre-commit" }), /git internals/)
  await assert.rejects(
    before(h, "ses_child", "apply_patch", { patchText: "*** Begin Patch\n*** Add File: /etc/x\n*** End Patch" }),
    /outside the repository/,
  )

  // Safe shell calls, in-repo edits and reads pass.
  await before(h, "ses_child", "shell", { command: "git status --porcelain && npm test" })
  await before(h, "ses_child", "shell", { command: "echo x > /tmp/ok.log" })
  await before(h, "ses_child", "edit", { filePath: "src/new.ts" })
  await before(h, "ses_child", "read", { filePath: "/etc/hosts" })
})

test("tool.execute.before honors workdir and post_session may commit but not branch or stash", async () => {
  const h = await setup({ parents: { ses_child: "ses_root", ses_ps: "ses_root" } })
  await modelRequest(h, "ses_root", ORCH)
  await modelRequest(h, "ses_child", EXEC)
  await modelRequest(h, "ses_ps", "hybrid-pipeline-post_session")

  await assert.rejects(
    before(h, "ses_child", "shell", { command: "echo x > out.txt", workdir: "/tmp" }),
    /outside the repository/,
  )
  await before(h, "ses_ps", "shell", { command: 'git add a.txt && git commit -m "x"' })
  await assert.rejects(before(h, "ses_ps", "shell", { command: "git add -A" }), /explicit file paths/)
  await assert.rejects(before(h, "ses_ps", "shell", { command: "git stash" }), /stash/)
})

test("tool.execute.after records a touched file on the root", async () => {
  const h = await setup({ parents: { ses_child: "ses_root" } })
  await modelRequest(h, "ses_root", ORCH)
  await modelRequest(h, "ses_child", EXEC)

  await after(h, "ses_child", "edit", { filePath: path.join(h.dir, "a.txt") }, "1")
  await after(h, "ses_child", "write", { filePath: "src/x.ts" }, "2")
  await after(h, "ses_child", "read", { filePath: "b.txt" }, "3")
  assert.deepEqual(Object.keys(readSession(h.info, "ses_root").files).sort(), ["a.txt", "src/x.ts"])
})

test("a second LIVE root cannot edit files claimed by the first; an idle root stops blocking", async () => {
  const h = await setup({ parents: { ses_c1: "ses_r1", ses_c2: "ses_r2" } })
  await modelRequest(h, "ses_r1", ORCH)
  await modelRequest(h, "ses_c1", EXEC)
  await modelRequest(h, "ses_r2", ORCH)
  await modelRequest(h, "ses_c2", EXEC)

  await after(h, "ses_c1", "edit", { filePath: "a.txt" }, "1")
  await assert.rejects(before(h, "ses_c2", "edit", { filePath: "a.txt" }), /being modified by another active opencode session \(ses_r1\)/)
  await before(h, "ses_c2", "edit", { filePath: "b.txt" })
  await before(h, "ses_c1", "edit", { filePath: "a.txt" })

  await emit(h, { type: "session.idle", properties: { sessionID: "ses_r1" } })
  assert.equal(readSession(h.info, "ses_r1").busy, false)
  await before(h, "ses_c2", "edit", { filePath: "a.txt" })
})

test("unresolvable parents do not create false claim conflicts", async () => {
  const h = await setup({ failSession: true })
  await modelRequest(h, "ses_x1", EXEC)
  await modelRequest(h, "ses_x2", EXEC)
  await after(h, "ses_x1", "edit", { filePath: "a.txt" }, "1")
  await before(h, "ses_x2", "edit", { filePath: "a.txt" })
})

test("shell writes claim files on the root and conflict with another live session", async () => {
  const h = await setup({ parents: { ses_c1: "ses_r1", ses_c2: "ses_r2" } })
  fs.mkdirSync(path.join(h.dir, "sub"))
  await modelRequest(h, "ses_r1", ORCH)
  await modelRequest(h, "ses_c1", EXEC)
  await modelRequest(h, "ses_r2", ORCH)
  await modelRequest(h, "ses_c2", EXEC)

  await after(h, "ses_c1", "shell", { command: "echo hi > bash-claimed.txt" }, "b1")
  assert.ok(readSession(h.info, "ses_r1").files["bash-claimed.txt"])
  await assert.rejects(
    before(h, "ses_c2", "shell", { command: "echo conflict > bash-claimed.txt" }),
    /bash-claimed\.txt is being modified by another active opencode session/,
  )
  await after(h, "ses_c1", "shell", { command: "cd sub && echo hi > file.txt" }, "b2")
  assert.ok(readSession(h.info, "ses_r1").files["sub/file.txt"])
})

test("permission.evaluate records an ask in the activity log", async () => {
  const h = await setup({ parents: { ses_child: "ses_root" } })
  await modelRequest(h, "ses_root", ORCH)
  await modelRequest(h, "ses_child", EXEC)

  await evaluate(h, {
    sessionID: "ses_child", agent: EXEC, action: "shell", resources: ["docker ps"], effect: "ask",
    metadata: { callID: "call_perm" },
  })
  // allow/deny evaluations are not asks and are not recorded here
  await evaluate(h, { sessionID: "ses_child", action: "shell", resources: ["ls"], effect: "allow" })

  const events = readActivity(h.info, "ses_root")
  assert.ok(fs.existsSync(activityLogPath(h.info, "ses_root")))
  const perms = events.filter((e) => e.type === "permission")
  assert.deepEqual(perms.map((e) => [e.event, e.permission, e.pattern, e.decision, e.callId]), [
    ["permission.asked", "shell", "docker ps", null, "call_perm"],
  ])
  assert.deepEqual(summarizeActivity(events).permissions, { asked: 1, replied: {} })
})

test("session.compaction injects state into an existing array field and otherwise fails open", async () => {
  const h = await setup({ parents: { ses_child: "ses_root" } })
  await modelRequest(h, "ses_root", ORCH)
  await modelRequest(h, "ses_child", EXEC)
  await after(h, "ses_child", "edit", { filePath: "a.txt" }, "1")

  const context = { sessionID: "ses_child", context: [] }
  await compact(h, context)
  assert.equal(context.context.length, 1)
  assert.match(context.context[0], /base_commit=[0-9a-f]{40}/)
  assert.match(context.context[0], /"a.txt"/)
  assert.match(context.context[0], /UNVERIFIED/)

  const messages = { sessionID: "ses_child", messages: [] }
  await compact(h, messages)
  assert.equal(messages.messages.length, 1)

  const unknown = { sessionID: "ses_child", payload: {} }
  const warnings = await withWarnings(async () => { await compact(h, unknown) })
  assert.deepEqual(unknown.payload, {})
  assert.ok(warnings.some((line) => line.includes("[pipeline-guard] compaction: no array field")))

  const stranger = { sessionID: "ses_unknown", context: [] }
  await compact(h, stranger)
  assert.deepEqual(stranger.context, [])
})

test("a new user turn on an idle root resets baseline and claims", async () => {
  const h = await setup({ parents: { ses_child: "ses_root" } })
  await modelRequest(h, "ses_root", ORCH)
  await modelRequest(h, "ses_child", EXEC)
  await after(h, "ses_child", "edit", { filePath: "a.txt" }, "1")
  fs.writeFileSync(path.join(h.dir, "a.txt"), "dirty from previous turn\n")

  await emit(h, { type: "session.idle", properties: { sessionID: "ses_root" } })
  await promptEvent(h, "ses_root", ORCH)
  const rec = readSession(h.info, "ses_root")
  assert.deepEqual(rec.files, {})
  assert.deepEqual(rec.baseline.dirty, ["a.txt"])
  assert.equal(rec.busy, true)
})

test("idle reports git state changes as a console warning", async () => {
  const h = await setup({ parents: { ses_child: "ses_root" } })
  await modelRequest(h, "ses_root", ORCH)
  const sh = (...a) => execFileSync("git", a, { cwd: h.dir, stdio: "ignore" })
  sh("branch", "task-t1")
  sh("worktree", "add", "-q", path.join(path.dirname(h.dir), path.basename(h.dir) + "-t1"), "-b", "task-t1-wt")

  const warnings = await withWarnings(async () => {
    await emit(h, { type: "session.status", properties: { sessionID: "ses_root", status: { type: "idle" } } })
  })
  const rec = readSession(h.info, "ses_root")
  assert.deepEqual(rec.anomalies.map((a) => a.kind).sort(), ["new_branches", "new_worktrees"])
  assert.ok(warnings.some((line) => line.startsWith("[pipeline-guard]") && line.includes("task-t1")))
})

test("activity log records tool calls, guard blocks and step counts", async () => {
  const h = await setup({ parents: { ses_child: "ses_root" } })
  await modelRequest(h, "ses_root", ORCH)
  await modelRequest(h, "ses_child", EXEC)

  const longCmd = `curl -H "Authorization: Bearer abcdefghijklmnop1234" http://localhost/${"x".repeat(400)}`
  await before(h, "ses_child", "shell", { command: longCmd }, "call_ok")
  await after(h, "ses_child", "shell", { command: longCmd }, "call_ok")
  await before(h, "ses_child", "read", { filePath: "a.txt" }, "call_read")
  await after(h, "ses_child", "read", { filePath: "a.txt" }, "call_read")
  await assert.rejects(before(h, "ses_child", "shell", { command: "git push origin main" }, "call_blk"), /Blocked/)
  await emit(h, {
    type: "message.part.updated",
    properties: { part: { type: "tool", sessionID: "ses_child", callID: "call_blk", tool: "shell", state: { status: "error", input: { command: "git push origin main" }, error: "[pipeline-guard] Blocked: git push" } } },
  })
  await emit(h, {
    type: "message.part.updated",
    properties: { part: { type: "tool", sessionID: "ses_child", callID: "call_den", tool: "shell", state: { status: "error", input: { command: "psql -c 'select 1'" }, error: "The user rejected permission to use this specific tool call." } } },
  })
  await modelRequest(h, "ses_child", EXEC)
  await emit(h, { type: "session.idle", properties: { sessionID: "ses_child" } })

  const events = readActivity(h.info, "ses_root")
  const tools = events.filter((e) => e.type === "tool")
  assert.deepEqual(tools.map((e) => [e.callId, e.ok, Boolean(e.denied)]), [
    ["call_ok", true, false], ["call_read", true, false], ["call_den", false, true],
  ])
  assert.equal(tools[0].agent, EXEC)
  assert.ok(tools[0].command.length <= 303, "command truncated")
  assert.ok(!tools[0].command.includes("abcdefghijklmnop1234"), "command redacted")
  const blocks = events.filter((e) => e.type === "guard_block")
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].command, "git push origin main")
  assert.match(blocks[0].reason, /push/)
  assert.doesNotMatch(blocks[0].reason, /^\[pipeline-guard\]/)
  const steps = events.filter((e) => e.type === "steps")
  assert.deepEqual(steps.map((e) => [e.sessionId, e.agent, e.tool_calls, e.llm_calls]), [["ses_child", EXEC, 3, 2]])
})

test("activity logging failures never block a tool call", async () => {
  const h = await setup({ parents: { ses_child: "ses_root" } })
  await modelRequest(h, "ses_root", ORCH)
  await modelRequest(h, "ses_child", EXEC)
  fs.mkdirSync(h.info.stateDir, { recursive: true })
  fs.writeFileSync(path.join(h.info.stateDir, "logs"), "not a dir")

  await before(h, "ses_child", "shell", { command: "ls" })
  await after(h, "ses_child", "shell", { command: "ls" }, "c1")
  await assert.rejects(before(h, "ses_child", "shell", { command: "git checkout -b x" }), /Blocked/)
  assert.deepEqual(readActivity(h.info, "ses_root"), [])
})

test("the third consecutive identical tool call is rejected with an actionable message", async () => {
  const h = await setup({ parents: { ses_child: "ses_root" } })
  await modelRequest(h, "ses_root", ORCH)
  await modelRequest(h, "ses_child", EXEC)

  await before(h, "ses_child", "read", { filePath: "a.txt" }, "c1")
  await before(h, "ses_child", "read", { filePath: "a.txt" }, "c2")
  await assert.rejects(
    before(h, "ses_child", "read", { filePath: "a.txt" }, "c3"),
    (error) => {
      assert.match(error.message, /\[pipeline-guard\] Blocked: read was called 3 times in a row with identical input \(doom_loop\)\./)
      assert.match(error.message, /Bound the wait inside one command instead of polling with the same call/)
      return true
    },
  )
  // Staying in the loop keeps being rejected.
  await assert.rejects(before(h, "ses_child", "read", { filePath: "a.txt" }, "c4"), /doom_loop/)
})

test("a different call in between resets the repetition streak", async () => {
  const h = await setup({ parents: { ses_child: "ses_root" } })
  await modelRequest(h, "ses_root", ORCH)
  await modelRequest(h, "ses_child", EXEC)

  await before(h, "ses_child", "read", { filePath: "a.txt" })
  await before(h, "ses_child", "read", { filePath: "a.txt" })
  await before(h, "ses_child", "read", { filePath: "b.txt" })
  await before(h, "ses_child", "read", { filePath: "a.txt" })
  await before(h, "ses_child", "read", { filePath: "a.txt" })
  await assert.rejects(before(h, "ses_child", "read", { filePath: "a.txt" }), /doom_loop/)
})

test("the same input with keys in a different order counts as identical", async () => {
  const h = await setup({ parents: { ses_child: "ses_root" } })
  await modelRequest(h, "ses_root", ORCH)
  await modelRequest(h, "ses_child", EXEC)

  await before(h, "ses_child", "read", { filePath: "a.txt", options: { limit: 10, offset: 0 } })
  await before(h, "ses_child", "read", { options: { offset: 0, limit: 10 }, filePath: "a.txt" })
  await assert.rejects(
    before(h, "ses_child", "read", { filePath: "a.txt", options: { limit: 10, offset: 0 } }),
    /doom_loop/,
  )
})

test("different sessions do not share the repetition streak", async () => {
  const h = await setup({ parents: { ses_c1: "ses_r1", ses_c2: "ses_r2" } })
  await modelRequest(h, "ses_r1", ORCH)
  await modelRequest(h, "ses_c1", EXEC)
  await modelRequest(h, "ses_r2", ORCH)
  await modelRequest(h, "ses_c2", EXEC)

  for (const sessionID of ["ses_c1", "ses_c2"]) {
    await before(h, sessionID, "read", { filePath: "a.txt" })
    await before(h, sessionID, "read", { filePath: "a.txt" })
  }
  await assert.rejects(before(h, "ses_c1", "read", { filePath: "a.txt" }), /doom_loop/)
  // The other session's own streak is independent and still at two.
  await assert.rejects(before(h, "ses_c2", "read", { filePath: "a.txt" }), /doom_loop/)
})

test("an idle or session-end event clears the repetition state", async () => {
  const h = await setup({ parents: { ses_child: "ses_root" } })
  await modelRequest(h, "ses_root", ORCH)
  await modelRequest(h, "ses_child", EXEC)

  await before(h, "ses_child", "read", { filePath: "a.txt" })
  await before(h, "ses_child", "read", { filePath: "a.txt" })
  await emit(h, { type: "session.idle", properties: { sessionID: "ses_child" } })
  await before(h, "ses_child", "read", { filePath: "a.txt" })
  await before(h, "ses_child", "read", { filePath: "a.txt" })
  await assert.rejects(before(h, "ses_child", "read", { filePath: "a.txt" }), /doom_loop/)

  await emit(h, { type: "session.deleted", properties: { sessionID: "ses_child" } })
  await before(h, "ses_child", "read", { filePath: "a.txt" })
  await before(h, "ses_child", "read", { filePath: "a.txt" })
})

test("a call blocked by the path or shell check does not increment the streak", async () => {
  const h = await setup({ parents: { ses_child: "ses_root" } })
  await modelRequest(h, "ses_root", ORCH)
  await modelRequest(h, "ses_child", EXEC)

  for (const id of ["b1", "b2", "b3"]) {
    await assert.rejects(
      before(h, "ses_child", "shell", { command: "git push origin main" }, id),
      (error) => {
        assert.match(error.message, /git push/)
        assert.doesNotMatch(error.message, /doom_loop/)
        return true
      },
    )
  }
  for (const id of ["e1", "e2", "e3"]) {
    await assert.rejects(
      before(h, "ses_child", "edit", { filePath: "/etc/leak.txt" }, id),
      (error) => {
        assert.match(error.message, /outside the repository/)
        assert.doesNotMatch(error.message, /doom_loop/)
        return true
      },
    )
  }
  // The blocked calls left no streak behind: a fresh pair of identical calls still passes.
  await before(h, "ses_child", "read", { filePath: "a.txt" })
  await before(h, "ses_child", "read", { filePath: "a.txt" })
})

test("cleanup disposes every registration", async () => {
  const h = await setup()
  assert.equal(h.registrations.length, 8)
  h.cleanup()
  assert.ok(h.registrations.every((r) => r.disposed))
  assert.deepEqual(Object.keys(h.handlers.session), [])
  assert.deepEqual(Object.keys(h.handlers.tool), [])
  assert.deepEqual(Object.keys(h.handlers.shell), [])
  assert.deepEqual(Object.keys(h.handlers.permission), [])
  assert.equal(h.handlers.event, null)
  h.cleanup() // idempotent
})

test("OPENCODE_PIPELINE_GUARD=off and the disabled option register nothing", async () => {
  const previous = process.env.OPENCODE_PIPELINE_GUARD
  try {
    process.env.OPENCODE_PIPELINE_GUARD = "off"
    const off = await setup()
    assert.equal(off.registrations.length, 0)
    assert.equal(typeof off.cleanup, "function")
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_PIPELINE_GUARD
    else process.env.OPENCODE_PIPELINE_GUARD = previous
  }
  const disabled = await setup({ options: { disabled: true } })
  assert.equal(disabled.registrations.length, 0)
})

test("outside a git repository the guard stays out of the way", async () => {
  const notRepo = mkTmp("pipe-norepo-")
  const h = await setup({ dir: notRepo })
  await modelRequest(h, "ses_n", EXEC)
  await before(h, "ses_n", "shell", { command: "echo x > /tmp/whatever" })
  const out = { command: "ls", cwd: notRepo, env: {} }
  await shellCreate(h, out)
  assert.deepEqual(out.env, {})
})
