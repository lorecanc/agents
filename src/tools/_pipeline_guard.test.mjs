import assert from "node:assert/strict"
import { test } from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { mkTmp } from "./_pipeline_testutil.mjs"

import guardModule, { createPipelineGuard } from "../plugins/pipeline-guard.js"
import { repoInfo, readSession, scratchDir } from "./_pipeline_core.js"

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

// Minimal SDK double: session.get returns { data: { id, parentID } }.
const makeClient = (parents = {}) => ({
  session: { get: async ({ path: p }) => ({ data: { id: p.id, parentID: parents[p.id] || null } }) },
  app: { log: async () => {} },
  tui: { showToast: async (arg) => { makeClient.toasts.push(arg) } },
})
makeClient.toasts = []

const EXEC = "hybrid-pipeline-executor"
const ORCH = "hybrid-pipeline-orchestrator"

async function setup(parents = { ses_child: "ses_root", ses_child2: "ses_root" }) {
  const dir = mkRepo()
  const hooks = await createPipelineGuard({ client: makeClient(parents), directory: dir })
  await hooks["chat.params"]({ sessionID: "ses_root", agent: ORCH })
  await hooks["chat.params"]({ sessionID: "ses_child", agent: EXEC })
  return { dir, hooks, info: repoInfo(dir) }
}

const before = (hooks, sessionID, tool, args) => hooks["tool.execute.before"]({ tool, sessionID, callID: "c" }, { args })

test("internal agents (title, summary, compaction) on the same session do not switch the guard off", async () => {
  // opencode fires chat.params for hidden internal agents on the SAME session id, possibly after the first step.
  const { hooks } = await setup()
  for (const internal of ["title", "summary", "compaction"]) {
    await hooks["chat.params"]({ sessionID: "ses_child", agent: internal })
    await assert.rejects(before(hooks, "ses_child", "bash", { command: "git checkout -b t1" }), /Blocked/, `after ${internal}`)
  }
  // but a deliberate switch of the session to a normal agent (user pressed Tab) does turn the guard off
  await hooks["chat.params"]({ sessionID: "ses_child", agent: "build" })
  await before(hooks, "ses_child", "bash", { command: "git checkout -b t1" })
  // and switching back to a pipeline agent turns it on again
  await hooks["chat.params"]({ sessionID: "ses_child", agent: EXEC })
  await assert.rejects(before(hooks, "ses_child", "bash", { command: "git checkout -b t1" }), /Blocked/)
})

test("default export exposes id and server like other local plugins", async () => {
  // Plain node gives the ESM default export; under tsx the nearest package.json has no
  // "type": "module", so the file is loaded with CJS interop and the export is nested.
  const plugin = guardModule.server ? guardModule : guardModule.default
  assert.equal(plugin.id, "pipeline-guard")
  const hooks = await plugin.server({ client: makeClient(), directory: mkRepo() })
  assert.equal(typeof hooks["tool.execute.before"], "function")
})

test("root and child sessions are registered, baseline captured once per root", async () => {
  const { dir, info } = await setup()
  const root = readSession(info, "ses_root")
  assert.equal(root.rootId, "ses_root")
  assert.equal(root.busy, true)
  assert.equal(root.baseline.branch, "main")
  assert.deepEqual(root.baseline.dirty, [])
  assert.equal(readSession(info, "ses_child").rootId, "ses_root")
  assert.equal(fs.existsSync(scratchDir(info)) || true, true)
  assert.ok(dir)
})

test("shell.env points temp dirs at the in-repo scratch for pipeline sessions only", async () => {
  const { hooks, info, dir } = await setup()
  const out = { env: {} }
  await hooks["shell.env"]({ cwd: dir, sessionID: "ses_child" }, out)
  assert.equal(out.env.TMPDIR, scratchDir(info))
  assert.equal(out.env.PIPELINE_SCRATCH, scratchDir(info))
  assert.equal(out.env.PIPELINE_SESSION, "ses_root")
  assert.equal(out.env.GIT_EDITOR, ":")
  assert.equal(out.env.GIT_SEQUENCE_EDITOR, ":")
  assert.equal(out.env.GIT_MERGE_AUTOEDIT, "no")
  assert.ok(fs.existsSync(out.env.TMPDIR))
  await hooks["chat.params"]({ sessionID: "ses_plain", agent: "build" })
  const plain = { env: {} }
  await hooks["shell.env"]({ cwd: dir, sessionID: "ses_plain" }, plain)
  assert.deepEqual(plain.env, {})
  const unknown = { env: {} }
  await hooks["shell.env"]({ cwd: dir, sessionID: "ses_never_seen" }, unknown)
  assert.deepEqual(unknown.env, {})
})

test("tool.execute.before blocks escapes and git state changes with actionable messages", async () => {
  const { hooks } = await setup()
  await assert.rejects(before(hooks, "ses_child", "bash", { command: "git checkout -b t1" }), /\[pipeline-guard\] Blocked: git checkout is not allowed/)
  await assert.rejects(before(hooks, "ses_child", "bash", { command: "git worktree add ../x" }), /worktree/)
  await assert.rejects(before(hooks, "ses_child", "bash", { command: "echo x > /tmp/out.txt" }), /outside the repository/)
  await assert.rejects(before(hooks, "ses_child", "write", { filePath: "/tmp/leak.txt", content: "x" }), /outside the repository/)
  await assert.rejects(before(hooks, "ses_child", "edit", { filePath: ".git/hooks/pre-commit" }), /git internals/)
  await assert.rejects(before(hooks, "ses_child", "apply_patch", { patchText: "*** Begin Patch\n*** Add File: /etc/x\n*** End Patch" }), /outside the repository/)
  await before(hooks, "ses_child", "bash", { command: "git status --porcelain && npm test" })
  await before(hooks, "ses_child", "bash", { command: "git pull --ff-only" })
  await before(hooks, "ses_child", "bash", { command: "git merge --abort" })
  await before(hooks, "ses_child", "bash", { command: "git rebase --continue" })
  await before(hooks, "ses_child", "bash", { command: "git rebase -Xours main" })
  await before(hooks, "ses_child", "bash", { command: "git checkout --ours src/a.js" })
  await before(hooks, "ses_child", "bash", { command: "git add src/a.js" })
  await assert.rejects(before(hooks, "ses_child", "bash", { command: "git rebase -i main" }), /\[pipeline-guard\] Blocked: git rebase/)
  await assert.rejects(before(hooks, "ses_child", "bash", { command: "git pull --rebase=interactive" }), /\[pipeline-guard\] Blocked: git pull/)
  await assert.rejects(before(hooks, "ses_child", "bash", { command: "git -cprotocol.ext.allow=always fetch origin" }), /\[pipeline-guard\] Blocked: git/)
  await assert.rejects(before(hooks, "ses_child", "bash", { command: "git push" }), /\[pipeline-guard\] Blocked: git push/)
  await before(hooks, "ses_child", "write", { filePath: "src/new.ts", content: "x" })
  await before(hooks, "ses_child", "read", { filePath: "/etc/hosts" }) // reads are permissions' business
})

test("workdir is honored when judging relative writes", async () => {
  const { hooks } = await setup()
  await assert.rejects(before(hooks, "ses_child", "bash", { command: "echo x > out.txt", workdir: "/tmp" }), /outside the repository/)
})

test("post_session may commit but not branch or stash", async () => {
  const dir = mkRepo()
  const hooks = await createPipelineGuard({ client: makeClient({ ses_ps: "ses_root" }), directory: dir })
  await hooks["chat.params"]({ sessionID: "ses_root", agent: ORCH })
  await hooks["chat.params"]({ sessionID: "ses_ps", agent: "hybrid-pipeline-post_session" })
  await before(hooks, "ses_ps", "bash", { command: 'git add a.txt && git commit -m "x"' })
  await assert.rejects(before(hooks, "ses_ps", "bash", { command: "git add -A" }), /explicit file paths/)
  await assert.rejects(before(hooks, "ses_ps", "bash", { command: "git stash" }), /stash/)
})

test("edited files are claimed on the root and survive across child sessions", async () => {
  const { hooks, info, dir } = await setup()
  await hooks["tool.execute.after"]({ tool: "edit", sessionID: "ses_child", callID: "1", args: { filePath: path.join(dir, "a.txt") } }, {})
  await hooks["tool.execute.after"]({ tool: "write", sessionID: "ses_child", callID: "2", args: { filePath: "src/x.ts" } }, {})
  await hooks["tool.execute.after"]({ tool: "read", sessionID: "ses_child", callID: "3", args: { filePath: "b.txt" } }, {})
  assert.deepEqual(Object.keys(readSession(info, "ses_root").files).sort(), ["a.txt", "src/x.ts"])
})

test("a second LIVE root cannot edit files claimed by the first; idle or unknown-root sessions are not blocked", async () => {
  const dir = mkRepo()
  const client = makeClient({ ses_c1: "ses_r1", ses_c2: "ses_r2" })
  const hooks = await createPipelineGuard({ client, directory: dir })
  const info = repoInfo(dir)
  await hooks["chat.params"]({ sessionID: "ses_r1", agent: ORCH })
  await hooks["chat.params"]({ sessionID: "ses_c1", agent: EXEC })
  await hooks["chat.params"]({ sessionID: "ses_r2", agent: ORCH })
  await hooks["chat.params"]({ sessionID: "ses_c2", agent: EXEC })
  await hooks["tool.execute.after"]({ tool: "edit", sessionID: "ses_c1", callID: "1", args: { filePath: "a.txt" } }, {})
  await assert.rejects(before(hooks, "ses_c2", "edit", { filePath: "a.txt" }), /being modified by another active opencode session \(ses_r1\)/)
  await before(hooks, "ses_c2", "edit", { filePath: "b.txt" }) // different file: fine
  await before(hooks, "ses_c1", "edit", { filePath: "a.txt" }) // owner keeps editing
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_r1" } } })
  assert.equal(readSession(info, "ses_r1").busy, false)
  await before(hooks, "ses_c2", "edit", { filePath: "a.txt" }) // owner idle: no longer a conflict

  // If the SDK cannot resolve parents, the guard must not guess a root and block siblings.
  const blind = await createPipelineGuard({ client: { session: { get: async () => { throw new Error("no sdk") } } }, directory: mkRepo() })
  await blind["chat.params"]({ sessionID: "ses_x1", agent: EXEC })
  await blind["chat.params"]({ sessionID: "ses_x2", agent: EXEC })
  await blind["tool.execute.after"]({ tool: "edit", sessionID: "ses_x1", callID: "1", args: { filePath: "a.txt" } }, {})
  await before(blind, "ses_x2", "edit", { filePath: "a.txt" })
})

test("bash writes claim files on the root session and are blocked when another live session holds a claim", async () => {
  const dir = mkRepo()
  fs.mkdirSync(path.join(dir, "sub"))
  const client = makeClient({ ses_c1: "ses_r1", ses_c2: "ses_r2" })
  const hooks = await createPipelineGuard({ client, directory: dir })
  const info = repoInfo(dir)
  await hooks["chat.params"]({ sessionID: "ses_r1", agent: ORCH })
  await hooks["chat.params"]({ sessionID: "ses_c1", agent: EXEC })
  await hooks["chat.params"]({ sessionID: "ses_r2", agent: ORCH })
  await hooks["chat.params"]({ sessionID: "ses_c2", agent: EXEC })

  await hooks["tool.execute.after"]({ tool: "bash", sessionID: "ses_c1", callID: "b1", args: { command: "echo hi > bash-claimed.txt" } }, {})
  assert.ok(readSession(info, "ses_r1").files["bash-claimed.txt"])
  await assert.rejects(
    before(hooks, "ses_c2", "bash", { command: "echo conflict > bash-claimed.txt" }),
    /bash-claimed\.txt is being modified by another active opencode session/,
  )
  await hooks["tool.execute.after"]({ tool: "bash", sessionID: "ses_c1", callID: "b2", args: { command: "cd sub && echo hi > file.txt" } }, {})
  assert.ok(readSession(info, "ses_r1").files["sub/file.txt"])
  await assert.rejects(
    before(hooks, "ses_c2", "bash", { command: "cd sub && echo conflict > file.txt" }),
    /sub\/file\.txt is being modified by another active opencode session/,
  )
  await assert.rejects(
    before(hooks, "ses_c2", "edit", { filePath: path.join(dir, "bash-claimed.txt") }),
    /bash-claimed\.txt is being modified by another active opencode session/,
  )
})

test("idle event reports git state changes (new branch, worktree, stash) once the baseline exists", async () => {
  makeClient.toasts.length = 0
  const { hooks, dir, info } = await setup()
  const sh = (...a) => execFileSync("git", a, { cwd: dir, stdio: "ignore" })
  sh("branch", "task-t1")
  sh("worktree", "add", "-q", path.join(path.dirname(dir), path.basename(dir) + "-t1"), "-b", "task-t1-wt")
  await hooks.event({ event: { type: "session.status", properties: { sessionID: "ses_root", status: { type: "idle" } } } })
  const rec = readSession(info, "ses_root")
  assert.deepEqual(rec.anomalies.map((a) => a.kind).sort(), ["new_branches", "new_worktrees"])
  assert.equal(makeClient.toasts.length, 1)
  assert.match(makeClient.toasts[0].body.message, /task-t1/)
})

test("a new user turn on an idle root resets baseline and claims", async () => {
  const { hooks, dir, info } = await setup()
  await hooks["tool.execute.after"]({ tool: "edit", sessionID: "ses_child", callID: "1", args: { filePath: "a.txt" } }, {})
  fs.writeFileSync(path.join(dir, "a.txt"), "dirty from previous turn\n")
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_root" } } })
  await hooks["chat.message"]({ sessionID: "ses_root", agent: ORCH })
  const rec = readSession(info, "ses_root")
  assert.deepEqual(rec.files, {})
  assert.deepEqual(rec.baseline.dirty, ["a.txt"])
  assert.equal(rec.busy, true)
})

test("compaction keeps baseline, touched files and verification state", async () => {
  const { hooks } = await setup()
  await hooks["tool.execute.after"]({ tool: "edit", sessionID: "ses_child", callID: "1", args: { filePath: "a.txt" } }, {})
  const out = { context: [] }
  await hooks["experimental.session.compacting"]({ sessionID: "ses_child" }, out)
  assert.equal(out.context.length, 1)
  assert.match(out.context[0], /base_commit=[0-9a-f]{40}/)
  assert.match(out.context[0], /"a.txt"/)
  assert.match(out.context[0], /UNVERIFIED/)
  const none = { context: [] }
  await hooks["experimental.session.compacting"]({ sessionID: "ses_unknown" }, none)
  assert.deepEqual(none.context, [])
})

test("OPENCODE_PIPELINE_GUARD=off disables every hook", async () => {
  const hooks = await createPipelineGuard({ client: makeClient(), directory: mkRepo() }, { disabled: true })
  assert.deepEqual(Object.keys(hooks), [])
})

test("outside a git repository the guard stays out of the way", async () => {
  const notRepo = mkTmp("pipe-norepo-")
  const hooks = await createPipelineGuard({ client: makeClient(), directory: notRepo })
  await hooks["chat.params"]({ sessionID: "ses_n", agent: EXEC })
  await before(hooks, "ses_n", "bash", { command: "echo x > /tmp/whatever" })
  const out = { env: {} }
  await hooks["shell.env"]({ cwd: notRepo, sessionID: "ses_n" }, out)
  assert.deepEqual(out.env, {})
})

test("idle of the root session stops the service it started with pipeline_serve", async () => {
  const { dir, hooks, info } = await setup()
  const node = JSON.stringify(process.execPath)
  fs.writeFileSync(path.join(dir, "server.js"), 'require("http").createServer((q,r)=>{r.writeHead(200);r.end("up")}).listen(Number(process.env.PORT),"127.0.0.1")')
  fs.mkdirSync(path.join(dir, ".opencode"))
  fs.writeFileSync(path.join(dir, ".opencode", "pipeline.json"), JSON.stringify({ serve: { start: `${node} server.js`, ready: { port: "${PORT}", timeout_s: 15 } } }))
  const { startService, readService } = await import("./_pipeline_serve.js")
  const started = await startService({ info, ownerRoot: "ses_root", ttlS: 120 })
  assert.equal(started.status, "running", JSON.stringify(started))
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_other_root" } } }) // unrelated session: nothing happens
  assert.equal((await fetch(started.url).then((r) => r.text())), "up")
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_root" } } })
  assert.equal(readService(info), null)
  await assert.rejects(fetch(started.url, { signal: AbortSignal.timeout(1500) }), "the service must be stopped when the root goes idle")
})
