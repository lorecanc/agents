import assert from "node:assert/strict"
import { test } from "node:test"
import { registerHooks } from "node:module"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { mkTmp } from "../dev-tools/_testutil.test.mjs"

// @opencode-ai/plugin is not installed in this repo: stub it exactly as _guards.test.mjs does.
const STUB_SOURCE = `
const selfReturning = () => new Proxy(function () {}, {
  get(_t, prop) { if (prop === "then") return undefined; return selfReturning() },
  apply() { return selfReturning() },
})
export const tool = Object.assign((def) => def, { schema: selfReturning() })
`
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@opencode-ai/plugin") return { url: "opencode-plugin-stub://plugin", shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.startsWith("opencode-plugin-stub:")) return { format: "module", source: STUB_SOURCE, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const { repoInfo, snapshot } = await import("../dev-tools/_repo.js")
const { writeSession } = await import("../dev-tools/_sessions.js")
const { appendActivity } = await import("./_pipeline_core.js")
// pipeline_* tools sit next to this test; dev_* tools come from the dev-tools pack in the merged tree.
const loadTool = async (name) => (await import(name.startsWith("dev_") ? `../dev-tools/${name}.ts` : `./${name}.ts`)).default

function mkRepo(contract = null) {
  const dir = mkTmp("pipe-tools-")
  const sh = (...a) => execFileSync("git", a, { cwd: dir, stdio: "ignore" })
  sh("init", "-q", "-b", "main")
  sh("config", "user.email", "t@example.com")
  sh("config", "user.name", "T")
  sh("config", "core.autocrlf", "false")
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n")
  fs.writeFileSync(path.join(dir, "b.txt"), "b\n")
  if (contract) {
    fs.mkdirSync(path.join(dir, ".opencode"))
    fs.writeFileSync(path.join(dir, ".opencode", "pipeline.json"), JSON.stringify(contract))
  }
  sh("add", "-A")
  sh("commit", "-qm", "init")
  return dir
}

const ctx = (dir, sessionID = "ses_root") => ({ directory: dir, worktree: dir, sessionID, abort: new AbortController().signal })
const call = async (name, args, c) => JSON.parse(await (await loadTool(name)).execute(args, c))

function registerRoot(dir, files = {}) {
  const info = repoInfo(dir)
  writeSession(info, { sessionId: "ses_root", rootId: "ses_root", agent: "x-pipeline-orchestrator", pid: process.pid, busy: true, updatedAt: Date.now(), baseline: snapshot(info), files })
  return info
}

test("pipeline_state: degraded without a registry, precise buckets with one", async () => {
  const dir = mkRepo()
  fs.writeFileSync(path.join(dir, "a.txt"), "pre-existing user edit\n")
  const degraded = await call("pipeline_state", {}, ctx(dir))
  assert.equal(degraded.degraded, true)
  assert.match(degraded.warning, /No session baseline/)
  assert.deepEqual(degraded.changed.unattributed.map((f) => f.path), ["a.txt"])

  registerRoot(dir, { "src/session.ts": 1, "b.txt": 1 })
  fs.mkdirSync(path.join(dir, "src"))
  fs.writeFileSync(path.join(dir, "src", "session.ts"), "export {}\n")
  fs.writeFileSync(path.join(dir, "b.txt"), "session edit\n")
  fs.writeFileSync(path.join(dir, "stray.txt"), "stray\n")
  const state = await call("pipeline_state", {}, ctx(dir))
  assert.equal(state.degraded, false)
  assert.match(state.base_commit, /^[0-9a-f]{40}$/)
  assert.deepEqual(state.baseline_dirty, ["a.txt"])
  assert.deepEqual(state.changed.session.map((f) => [f.path, f.status]), [["b.txt", "modified"], ["src/session.ts", "new"]])
  assert.deepEqual(state.changed.pre_existing.map((f) => f.path), ["a.txt"])
  assert.deepEqual(state.changed.unattributed.map((f) => f.path), ["stray.txt"])
  assert.deepEqual(state.untracked_files_need_full_read.sort(), ["src/session.ts", "stray.txt"])
  assert.deepEqual(state.anomalies, [])
})

test("pipeline_state: reports git anomalies and other live sessions touching the same files", async () => {
  const dir = mkRepo()
  const info = registerRoot(dir, { "a.txt": 1 })
  writeSession(info, { sessionId: "ses_other", rootId: "ses_other", agent: "x-pipeline-orchestrator", pid: process.pid, busy: true, updatedAt: Date.now(), files: { "a.txt": 1, "z.txt": 1 } })
  execFileSync("git", ["branch", "oops"], { cwd: dir })
  const state = await call("pipeline_state", {}, ctx(dir))
  assert.deepEqual(state.anomalies.map((a) => a.kind), ["new_branches"])
  assert.match(state.warning, /Branches, worktrees, stashes/)
  assert.deepEqual(state.other_active_sessions, [{ session: "ses_other", agent: "x-pipeline-orchestrator", overlapping_files: ["a.txt"] }])
})

test("pipeline_state: not a repository is an error, not a crash", async () => {
  const notRepo = mkTmp("pipe-none-")
  assert.equal((await call("pipeline_state", {}, ctx(notRepo))).error, "not a git repository")
})

test("pipeline_commit: input validation refusals", async () => {
  const dir = mkRepo()
  registerRoot(dir)
  fs.writeFileSync(path.join(dir, "a.txt"), "x\n")
  const base = { mode: "final", message: "fix(x): y", expected_files: ["a.txt"], validation: "passed" }
  assert.match((await call("pipeline_commit", { ...base, expected_files: [] }, ctx(dir))).reason, /NEEDS_EXPECTED_FILES/)
  assert.match((await call("pipeline_commit", { ...base, message: "  " }, ctx(dir))).reason, /single non-empty line/)
  assert.match((await call("pipeline_commit", { ...base, validation: "failed" }, ctx(dir))).reason, /validation failed/)
  assert.match((await call("pipeline_commit", { ...base, validation: "unverified" }, ctx(dir))).reason, /validation_note/)
  assert.match((await call("pipeline_commit", { ...base, expected_files: ["ghost.txt"] }, ctx(dir))).reason, /nothing to commit/)
  // failed validation is allowed for a checkpoint (work in progress)
  const cp = await call("pipeline_commit", { ...base, mode: "checkpoint", validation: "failed", dry_run: true }, ctx(dir))
  assert.equal(cp.status, "dry_run")
})

test("pipeline_commit: scoped commit with trailers; pre-existing and stray changes are left alone", async () => {
  const dir = mkRepo()
  fs.writeFileSync(path.join(dir, "a.txt"), "user's earlier uncommitted work\n")
  registerRoot(dir, { "b.txt": 1 })
  fs.writeFileSync(path.join(dir, "b.txt"), "session\n")
  fs.writeFileSync(path.join(dir, "new.ts"), "export {}\n")
  fs.writeFileSync(path.join(dir, "stray.txt"), "stray\n")
  const args = { mode: "checkpoint", message: "wire feature", expected_files: ["new.ts", "a.txt"], validation: "unverified", validation_note: "smoke blocked: DATABASE_URL missing" }
  const preview = await call("pipeline_commit", { ...args, dry_run: true }, ctx(dir))
  assert.deepEqual(preview.plan.commit, ["new.ts"])
  assert.deepEqual(preview.plan.conflicts, ["a.txt"])
  assert.deepEqual(preview.plan.unattributed, ["stray.txt"])
  assert.deepEqual(preview.plan.claimedOnly, ["b.txt"])
  assert.deepEqual(preview.excluded_claimed_files, ["b.txt"])
  assert.equal(execFileSync("git", ["log", "--oneline"], { cwd: dir, encoding: "utf8" }).trim().split("\n").length, 1, "dry run must not commit")
  const res = await call("pipeline_commit", args, ctx(dir))
  assert.equal(res.status, "committed")
  assert.equal(res.subject, "chore(checkpoint): wire feature")
  assert.deepEqual(res.committed, ["new.ts"])
  assert.deepEqual(res.excluded_claimed_files, ["b.txt"])
  assert.deepEqual(res.unexpected, [])
  const body = execFileSync("git", ["log", "-1", "--format=%B"], { cwd: dir, encoding: "utf8" })
  assert.match(body, /Pipeline-Checkpoint: true/)
  assert.match(body, /Validation: unverified \(smoke blocked: DATABASE_URL missing\)/)
  const status = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" })
  assert.match(status, / M a\.txt/)
  assert.match(status, /\?\? stray\.txt/)
  assert.match(status, / M b\.txt/)
  assert.doesNotMatch(status, /new\.ts/)
})

test("pipeline_commit: without a registered baseline it still protects files the caller declares dirty", async () => {
  const dir = mkRepo()
  fs.writeFileSync(path.join(dir, "a.txt"), "x\n")
  fs.writeFileSync(path.join(dir, "b.txt"), "y\n")
  const args = { mode: "final", message: "feat(x): y", expected_files: ["a.txt", "b.txt"], validation: "passed" }
  const unsafe = await call("pipeline_commit", { ...args, dry_run: true }, ctx(dir))
  assert.equal(unsafe.degraded, true)
  assert.match(unsafe.warning, /cannot be detected/)
  const safe = await call("pipeline_commit", { ...args, baseline_dirty: ["a.txt"], dry_run: true }, ctx(dir))
  assert.deepEqual(safe.plan.commit, ["b.txt"])
  assert.deepEqual(safe.plan.conflicts, ["a.txt"])
  assert.equal(safe.warning, undefined)
})

const manyLineFile = (n) => Array.from({ length: n }, (_, i) => `line ${i}\n`).join("")

/** Build a mixed a.txt: HEAD base commit, user edit at the top, session edit appended at the bottom. */
function mkMixedRepo() {
  const dir = mkRepo()
  const sh = (...a) => execFileSync("git", a, { cwd: dir, stdio: "ignore" })
  fs.writeFileSync(path.join(dir, "a.txt"), manyLineFile(20))
  sh("add", "--", "a.txt")
  sh("commit", "-qm", "base")
  const tail19 = Array.from({ length: 19 }, (_, i) => `line ${i + 1}\n`).join("")
  fs.writeFileSync(path.join(dir, "a.txt"), `user's earlier uncommitted work\n${tail19}`)
  registerRoot(dir, { "a.txt": 1 })
  fs.appendFileSync(path.join(dir, "a.txt"), "session tail\n")
  return dir
}

/** Keep only the LAST hunk of `git diff HEAD -- <file>` (the session hunk of a mixed file). */
function lastHunkOnly(dir, file) {
  const full = execFileSync("git", ["diff", "HEAD", "--", file], { cwd: dir, encoding: "utf8" })
  const at = full.indexOf("@@")
  assert.ok(at > 0, `expected at least one hunk in the diff of ${file}`)
  const parts = full.slice(at).split("\n@@ ")
  let last = parts[parts.length - 1]
  if (!last.startsWith("@@")) last = `@@ ${last}`
  const head = full.slice(0, at)
  return `${head}${last}${last.endsWith("\n") ? "" : "\n"}`
}

test("pipeline_commit: staging_patch commits only the session hunks of a dirty file, the rest stays in the worktree", async () => {
  const dir = mkMixedRepo()
  const args = {
    mode: "checkpoint", message: "split dirty file", expected_files: ["a.txt"],
    validation: "unverified", validation_note: "wave test", staging_patch: lastHunkOnly(dir, "a.txt"),
  }
  const preview = await call("pipeline_commit", { ...args, dry_run: true }, ctx(dir))
  assert.equal(preview.status, "dry_run")
  assert.deepEqual(preview.plan.commit, [])
  assert.deepEqual(preview.plan.patched, ["a.txt"])
  assert.deepEqual(preview.plan.conflicts, [])
  const res = await call("pipeline_commit", args, ctx(dir))
  assert.equal(res.status, "committed")
  assert.equal(res.subject, "chore(checkpoint): split dirty file")
  assert.deepEqual(res.committed, ["a.txt"])
  assert.deepEqual(res.unexpected, [])
  // the commit holds the HEAD content plus the session hunk, WITHOUT the user's edit
  const inCommit = execFileSync("git", ["show", "HEAD:a.txt"], { cwd: dir, encoding: "utf8" })
  assert.ok(inCommit.includes("session tail"))
  assert.ok(!inCommit.includes("user's earlier"))
  // the pre-existing edit stays uncommitted in the worktree and the index is clean
  const status = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" })
  assert.match(status, /^ M a\.txt/m)
  assert.equal(execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: dir, encoding: "utf8" }), "")
  const leftover = execFileSync("git", ["diff", "--", "a.txt"], { cwd: dir, encoding: "utf8" })
  assert.match(leftover, /user's earlier/)
  assert.doesNotMatch(leftover, /session tail/)
})

test("pipeline_commit: a staging_patch out of scope is refused with a reason", async () => {
  const dir = mkRepo()
  fs.writeFileSync(path.join(dir, "a.txt"), "user's earlier uncommitted work\n")
  registerRoot(dir, { "a.txt": 1, "b.txt": 1 })
  fs.writeFileSync(path.join(dir, "a.txt"), "user's earlier uncommitted work\nsession\n")
  fs.writeFileSync(path.join(dir, "b.txt"), "session\n")
  const base = { mode: "checkpoint", message: "wire feature", expected_files: ["a.txt", "b.txt"], validation: "passed" }
  // b.txt is declared but NOT baseline_dirty: no reason to be in the patch
  const cleanFilePatch = execFileSync("git", ["diff", "HEAD", "--", "b.txt"], { cwd: dir, encoding: "utf8" })
  const notDirty = await call("pipeline_commit", { ...base, staging_patch: cleanFilePatch }, ctx(dir))
  assert.equal(notDirty.status, "refused")
  assert.match(notDirty.reason, /not baseline_dirty/)
  // a file not declared in expected_files at all
  const undeclared = await call("pipeline_commit", { ...base, expected_files: ["a.txt"], staging_patch: cleanFilePatch }, ctx(dir))
  assert.equal(undeclared.status, "refused")
  assert.match(undeclared.reason, /expected_files/)
  // refusals never stage anything
  assert.equal(execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: dir, encoding: "utf8" }), "")
})

test("pipeline_commit: a malformed staging_patch is refused and the index stays clean", async () => {
  const dir = mkRepo()
  fs.writeFileSync(path.join(dir, "a.txt"), "user's earlier uncommitted work\n")
  registerRoot(dir, { "a.txt": 1 })
  fs.writeFileSync(path.join(dir, "a.txt"), "user's earlier uncommitted work\nsession\n")
  const base = { mode: "checkpoint", message: "wire feature", expected_files: ["a.txt"], validation: "passed" }
  const garbage = await call("pipeline_commit", { ...base, staging_patch: "this is not a unified diff" }, ctx(dir))
  assert.equal(garbage.status, "refused")
  assert.match(garbage.reason, /malformed/)
  // headers for a declared dirty file, but hunk content that does not apply to the index
  const broken = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-wrong context\n+new content\n"
  const badHunks = await call("pipeline_commit", { ...base, staging_patch: broken }, ctx(dir))
  assert.equal(badHunks.status, "refused")
  assert.match(badHunks.reason, /staging_patch/)
  assert.equal(execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: dir, encoding: "utf8" }), "")
})

test("pipeline_commit: without staging_patch a mixed file stays a conflict (current behavior)", async () => {
  const dir = mkMixedRepo()
  const args = { mode: "checkpoint", message: "wire feature", expected_files: ["a.txt"], validation: "passed" }
  const preview = await call("pipeline_commit", { ...args, dry_run: true }, ctx(dir))
  assert.deepEqual(preview.plan.commit, [])
  assert.deepEqual(preview.plan.conflicts, ["a.txt"])
  const res = await call("pipeline_commit", args, ctx(dir))
  assert.equal(res.status, "refused")
  assert.match(res.reason, /nothing to commit/)
  assert.equal(execFileSync("git", ["log", "--oneline"], { cwd: dir, encoding: "utf8" }).trim().split("\n").length, 2)
})

test("pipeline_commit: when the hunk commit fails the index is restored", async () => {
  const dir = mkMixedRepo()
  const hook = path.join(dir, ".git", "hooks", "pre-commit")
  fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n")
  fs.chmodSync(hook, 0o755)
  const args = {
    mode: "checkpoint", message: "split dirty file", expected_files: ["a.txt"],
    validation: "passed", staging_patch: lastHunkOnly(dir, "a.txt"),
  }
  const res = await call("pipeline_commit", args, ctx(dir))
  assert.equal(res.status, "error")
  assert.match(res.error, /failed/)
  // the index is clean again and the worktree still holds both edits
  assert.equal(execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: dir, encoding: "utf8" }), "")
  assert.equal(execFileSync("git", ["log", "--oneline"], { cwd: dir, encoding: "utf8" }).trim().split("\n").length, 2)
  const body = fs.readFileSync(path.join(dir, "a.txt"), "utf8")
  assert.match(body, /user's earlier/)
  assert.match(body, /session tail/)
})

test("pipeline_commit: a failed post-commit assertion rolls the checkpoint back", async () => {
  const dir = mkMixedRepo()
  fs.writeFileSync(path.join(dir, "extra.txt"), "snuck in by the pre-commit hook\n")
  const hook = path.join(dir, ".git", "hooks", "pre-commit")
  fs.writeFileSync(hook, "#!/bin/sh\ngit add extra.txt\n")
  fs.chmodSync(hook, 0o755)
  const args = {
    mode: "checkpoint", message: "split dirty file", expected_files: ["a.txt"],
    validation: "passed", staging_patch: lastHunkOnly(dir, "a.txt"),
  }
  const res = await call("pipeline_commit", args, ctx(dir))
  assert.equal(res.status, "error")
  assert.match(res.error, /post-commit assertion failed/)
  assert.match(res.error, /extra\.txt/)
  // the checkpoint commit is gone, the index is clean, the worktree keeps both edits
  assert.equal(execFileSync("git", ["log", "--oneline"], { cwd: dir, encoding: "utf8" }).trim().split("\n").length, 2)
  assert.equal(execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: dir, encoding: "utf8" }), "")
  const body = fs.readFileSync(path.join(dir, "a.txt"), "utf8")
  assert.match(body, /user's earlier/)
  assert.match(body, /session tail/)
})

test("pipeline_commit: a rename-only section without headers is refused explicitly", async () => {
  const dir = mkRepo()
  registerRoot(dir)
  const base = { mode: "checkpoint", message: "wire feature", expected_files: ["a.txt"], validation: "passed" }
  const ren = await call("pipeline_commit", {
    ...base,
    staging_patch: "diff --git a/old.txt b/new.txt\nsimilarity index 100%\nrename from old.txt\nrename to new.txt\n",
  }, ctx(dir))
  assert.equal(ren.status, "refused")
  assert.match(ren.reason, /rename-only/)
  assert.equal(execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: dir, encoding: "utf8" }), "")
})

test("pipeline_commit: a rename in the plan plus patched hunks commits without a staged-set mismatch", async () => {
  const dir = mkMixedRepo()
  registerRoot(dir, { "a.txt": 1, "b.txt": 1, "newb.txt": 1 }) // snapshot taken while only a.txt is dirty
  fs.rmSync(path.join(dir, "b.txt"))
  fs.writeFileSync(path.join(dir, "newb.txt"), "b\n") // same content: rename detection would collapse the pair
  const args = {
    mode: "checkpoint", message: "rename plus hunks", expected_files: ["a.txt", "b.txt", "newb.txt"],
    validation: "passed", staging_patch: lastHunkOnly(dir, "a.txt"),
  }
  const res = await call("pipeline_commit", args, ctx(dir))
  assert.equal(res.status, "committed")
  assert.deepEqual(res.unexpected, [])
  assert.equal(execFileSync("git", ["show", "HEAD:newb.txt"], { cwd: dir, encoding: "utf8" }), "b\n")
  assert.equal(execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: dir, encoding: "utf8" }), "")
})

test("pipeline_commit: a plain commit also serializes on the commit lock", async () => {
  const dir = mkRepo()
  registerRoot(dir, { "b.txt": 1 })
  fs.writeFileSync(path.join(dir, "b.txt"), "session\n")
  const info = repoInfo(dir)
  // hold the commit lock exactly like a parallel session in its hunk commit would
  const lockDir = path.join(info.stateDir, "locks", "commit.lock")
  fs.mkdirSync(lockDir, { recursive: true })
  fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, owner: "other", at: Date.now(), identity: "other" }))
  let completed = false
  const pending = call("pipeline_commit", { mode: "final", message: "feat(x): y", expected_files: ["b.txt"], validation: "passed" }, ctx(dir))
    .then((r) => { completed = true; return r })
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(completed, false, "the plain commit must wait for the commit lock")
  fs.rmSync(lockDir, { recursive: true, force: true })
  assert.equal((await pending).status, "committed")
})

test("pipeline_commit: a moved HEAD during a failed post-commit assertion skips the rollback", async () => {
  const dir = mkMixedRepo()
  fs.writeFileSync(path.join(dir, "extra.txt"), "snuck in by the pre-commit hook\n")
  const pre = path.join(dir, ".git", "hooks", "pre-commit")
  fs.writeFileSync(pre, "#!/bin/sh\ngit add extra.txt\n")
  fs.chmodSync(pre, 0o755)
  const post = path.join(dir, ".git", "hooks", "post-commit")
  fs.writeFileSync(post, "#!/bin/sh\nprintf 'raced\\n' > raced.txt\ngit add raced.txt\ngit commit -q --no-verify -m raced\n")
  fs.chmodSync(post, 0o755)
  const args = {
    mode: "checkpoint", message: "split dirty file", expected_files: ["a.txt"],
    validation: "passed", staging_patch: lastHunkOnly(dir, "a.txt"),
  }
  const res = await call("pipeline_commit", args, ctx(dir))
  assert.equal(res.status, "error")
  assert.match(res.error, /post-commit assertion failed/)
  assert.match(res.error, /HEAD moved/)
  // no reset: the checkpoint stays in history, with the raced commit on top of it
  const log = execFileSync("git", ["log", "--oneline"], { cwd: dir, encoding: "utf8" }).trim().split("\n")
  assert.equal(log.length, 4)
  assert.match(log[0], /raced/)
})

test("dev_verify: runs the contract and returns structured results", async () => {
  const dir = mkRepo({ verify: { lint: "echo ok", test_fast: "echo boom >&2; exit 4" } })
  const res = await call("dev_verify", { checks: ["lint", "test_fast"] }, ctx(dir))
  assert.equal(res.status, "fail")
  assert.deepEqual(res.results.map((r) => r.status), ["pass", "fail"])
  assert.equal(res.contract_source, "file")
})

test("dev_smoke: no contract is inconclusive and suggests nothing it cannot justify", async () => {
  const res = await call("dev_smoke", {}, ctx(mkRepo()))
  assert.equal(res.status, "inconclusive")
  assert.match(res.reason, /no smoke contract/)
  assert.equal(res.suggested_smoke, null)
})

test("dev_serve: a child session resolves to the root owner; start, status and stop go through the tool", { skip: process.platform === "win32" }, async () => {
  const node = JSON.stringify(process.execPath)
  const dir = mkRepo({ smoke: { start: `${node} server.js`, ready: { url: "http://127.0.0.1:${PORT}/", timeout_s: 15 }, checks: [] } })
  fs.writeFileSync(path.join(dir, "server.js"), 'require("http").createServer((q,r)=>{r.writeHead(200);r.end("tool-ok")}).listen(Number(process.env.PORT),"127.0.0.1")')
  const info = registerRoot(dir)
  writeSession(info, { sessionId: "ses_child", rootId: "ses_root", agent: "x-pipeline-chrome_devtools", pid: process.pid, updatedAt: Date.now() })
  const child = ctx(dir, "ses_child")
  try {
    const started = await call("dev_serve", { action: "start", ttl_s: 60 }, child)
    assert.equal(started.status, "running", JSON.stringify(started))
    assert.equal(started.owner_session, "ses_root", "owner must be the root session, not the child")
    assert.equal(await (await fetch(started.url)).text(), "tool-ok")
    assert.equal((await call("dev_serve", { action: "status" }, child)).status, "running")
    // a different root session is refused
    writeSession(info, { sessionId: "ses_other", rootId: "ses_other", agent: "x-pipeline-orchestrator", pid: process.pid, busy: true, updatedAt: Date.now(), files: {} })
    assert.equal((await call("dev_serve", { action: "stop" }, ctx(dir, "ses_other"))).status, "refused")
    const stopped = await call("dev_serve", { action: "stop" }, child)
    assert.equal(stopped.status, "stopped")
    assert.equal(stopped.port_free, true)
    assert.equal((await call("dev_serve", { action: "status" }, child)).status, "stopped")
  } finally {
    await call("dev_serve", { action: "stop" }, child)
  }
})

test("dev_serve: no contract is inconclusive; not a repository is an error", async () => {
  const res = await call("dev_serve", { action: "start" }, ctx(mkRepo()))
  assert.equal(res.status, "inconclusive")
  assert.match(res.reason, /pass command .*workspace.*directly/)
  const notRepo = mkTmp("pipe-none-")
  assert.equal((await call("dev_serve", { action: "start" }, ctx(notRepo))).error, "not a git repository")
})

test("dev_serve: tool wrapper starts a direct command in a workspace without pipeline.json", { skip: process.platform === "win32" }, async () => {
  const node = JSON.stringify(process.execPath)
  const dir = mkRepo()
  const app = path.join(dir, "apps", "web")
  fs.mkdirSync(app, { recursive: true })
  fs.writeFileSync(path.join(app, "package.json"), "{}\n")
  fs.writeFileSync(path.join(app, "server.mjs"), 'import http from "node:http"\nhttp.createServer((q,r)=>{r.writeHead(200);r.end(process.argv[2])}).listen(Number(process.env.PORT),"127.0.0.1")\n')
  const info = registerRoot(dir)
  const child = ctx(dir)
  const command = `${node} server.mjs wrapper-ok`
  try {
    for (const unsafe of [`${node} -e 'console.log(1)'`, "python3 -c 'print(1)'", "cmd1 && cmd2"]) {
      const rejected = await call("dev_serve", { action: "start", command: unsafe }, child)
      assert.equal(rejected.status, "error", unsafe)
      assert.equal(rejected.failure_class_hint, "harness", unsafe)
    }
    const started = await call("dev_serve", {
      action: "start", ttl_s: 60, workspace: "apps/web", command, ready_path: "/health", ready_timeout_s: 5,
    }, child)
    assert.equal(started.status, "running", JSON.stringify(started))
    assert.equal(started.workspace, "apps/web")
    assert.equal(await (await fetch(`${started.url}health`)).text(), "wrapper-ok")
  } finally {
    await call("dev_serve", { action: "stop" }, child)
  }
})

test("pipeline_state exposes recorded activity next to the unchanged fields", async () => {
  const dir = mkRepo()
  const without = await call("pipeline_state", {}, ctx(dir))
  assert.deepEqual(without.activity.available, false)
  const info = registerRoot(dir)
  const empty = await call("pipeline_state", {}, ctx(dir))
  assert.equal(empty.activity.available, false)
  assert.equal(empty.activity.events, 0)
  const ev = (e) => appendActivity(info, "ses_root", e)
  ev({ type: "tool", sessionId: "ses_a", agent: "x-pipeline-executor", tool: "bash", ok: true, command: "npm test" })
  ev({ type: "tool", sessionId: "ses_a", agent: "x-pipeline-executor", tool: "bash", ok: false, denied: true, command: "docker ps", error: "The user rejected permission" })
  ev({ type: "guard_block", sessionId: "ses_b", agent: "x-pipeline-ops", tool: "bash", command: "git push", reason: "git push is not allowed" })
  ev({ type: "steps", sessionId: "ses_a", agent: "x-pipeline-executor", tool_calls: 2, llm_calls: 3 })
  const state = await call("pipeline_state", {}, ctx(dir))
  for (const k of ["degraded", "base_commit", "branch", "baseline_dirty", "changed", "untracked_files_need_full_read", "anomalies", "other_active_sessions", "scratch_dir", "how_to_diff"]) assert.ok(k in state, k)
  const a = state.activity
  assert.equal(a.available, true)
  assert.match(a.log_file, /opencode-pipeline[\\/]logs[\\/]ses_root\.jsonl$/)
  assert.deepEqual(a.per_agent["x-pipeline-executor"], { tool_calls: 2, errors: 1, denied: 1, guard_blocks: 0, sessions: 1 })
  assert.deepEqual(a.per_agent["x-pipeline-ops"], { tool_calls: 1, errors: 0, denied: 0, guard_blocks: 1, sessions: 1 })
  assert.deepEqual(a.denied.map((d) => [d.agent, d.command, d.reason]), [["x-pipeline-executor", "docker ps", "The user rejected permission"]])
  assert.deepEqual(a.guard_blocks.map((b) => b.command), ["git push"])
  assert.deepEqual(a.errors, { total: 1, by_tool: { bash: 1 } })
  assert.deepEqual(a.subagents.find((s) => s.session === "ses_a"), { session: "ses_a", agent: "x-pipeline-executor", tool_calls: 2, llm_calls: 3 })
})

test("dev_env tool returns the environment report as JSON", async () => {
  const dir = mkRepo({ verify: { test_fast: "npm test" } })
  const out = await call("dev_env", {}, ctx(dir))
  assert.equal(out.contract.exists, true)
  assert.deepEqual(out.contract.verify_defined, ["test_fast"])
  assert.ok(out.binaries && out.docker && out.pipeline && out.verification_outlook)
  assert.ok(out.pipeline.tools_present.includes("dev_env"))
  const sub = await call("dev_env", { workspace: "missing-dir" }, ctx(dir))
  assert.match(sub.workspace.error, /does not exist/)
})
