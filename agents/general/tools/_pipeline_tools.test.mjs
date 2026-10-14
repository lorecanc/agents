import assert from "node:assert/strict"
import { test } from "node:test"
import { registerHooks } from "node:module"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { mkTmp } from "./_pipeline_testutil.mjs"

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

const { repoInfo, writeSession, snapshot } = await import("./_pipeline_core.js")
const loadTool = async (name) => (await import(`./${name}.ts`)).default

function mkRepo(contract = null) {
  const dir = mkTmp("pipe-tools-")
  const sh = (...a) => execFileSync("git", a, { cwd: dir, stdio: "ignore" })
  sh("init", "-q", "-b", "main")
  sh("config", "user.email", "t@example.com")
  sh("config", "user.name", "T")
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
  assert.deepEqual(preview.plan.commit, ["b.txt", "new.ts"])
  assert.deepEqual(preview.plan.conflicts, ["a.txt"])
  assert.deepEqual(preview.plan.unattributed, ["stray.txt"])
  assert.equal(execFileSync("git", ["log", "--oneline"], { cwd: dir, encoding: "utf8" }).trim().split("\n").length, 1, "dry run must not commit")
  const res = await call("pipeline_commit", args, ctx(dir))
  assert.equal(res.status, "committed")
  assert.equal(res.subject, "chore(checkpoint): wire feature")
  assert.deepEqual(res.committed, ["b.txt", "new.ts"])
  assert.deepEqual(res.unexpected, [])
  const body = execFileSync("git", ["log", "-1", "--format=%B"], { cwd: dir, encoding: "utf8" })
  assert.match(body, /Pipeline-Checkpoint: true/)
  assert.match(body, /Validation: unverified \(smoke blocked: DATABASE_URL missing\)/)
  const status = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" })
  assert.match(status, / M a\.txt/)
  assert.match(status, /\?\? stray\.txt/)
  assert.doesNotMatch(status, /b\.txt|new\.ts/)
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

test("pipeline_verify: runs the contract and returns structured results", async () => {
  const dir = mkRepo({ verify: { lint: "echo ok", test_fast: "echo boom >&2; exit 4" } })
  const res = await call("pipeline_verify", { checks: ["lint", "test_fast"] }, ctx(dir))
  assert.equal(res.status, "fail")
  assert.deepEqual(res.results.map((r) => r.status), ["pass", "fail"])
  assert.equal(res.contract_source, "file")
})

test("pipeline_smoke: no contract is inconclusive and suggests nothing it cannot justify", async () => {
  const res = await call("pipeline_smoke", {}, ctx(mkRepo()))
  assert.equal(res.status, "inconclusive")
  assert.match(res.reason, /no smoke contract/)
  assert.equal(res.suggested_smoke, null)
})

test("pipeline_serve: a child session resolves to the root owner; start, status and stop go through the tool", async () => {
  const node = JSON.stringify(process.execPath)
  const dir = mkRepo({ smoke: { start: `${node} server.js`, ready: { url: "http://127.0.0.1:${PORT}/", timeout_s: 15 }, checks: [] } })
  fs.writeFileSync(path.join(dir, "server.js"), 'require("http").createServer((q,r)=>{r.writeHead(200);r.end("tool-ok")}).listen(Number(process.env.PORT),"127.0.0.1")')
  const info = registerRoot(dir)
  writeSession(info, { sessionId: "ses_child", rootId: "ses_root", agent: "x-pipeline-chrome_devtools", pid: process.pid, updatedAt: Date.now() })
  const child = ctx(dir, "ses_child")
  try {
    const started = await call("pipeline_serve", { action: "start", ttl_s: 60 }, child)
    assert.equal(started.status, "running", JSON.stringify(started))
    assert.equal(started.owner_session, "ses_root", "owner must be the root session, not the child")
    assert.equal(await (await fetch(started.url)).text(), "tool-ok")
    assert.equal((await call("pipeline_serve", { action: "status" }, child)).status, "running")
    // a different root session is refused
    writeSession(info, { sessionId: "ses_other", rootId: "ses_other", agent: "x-pipeline-orchestrator", pid: process.pid, busy: true, updatedAt: Date.now(), files: {} })
    assert.equal((await call("pipeline_serve", { action: "stop" }, ctx(dir, "ses_other"))).status, "refused")
    const stopped = await call("pipeline_serve", { action: "stop" }, child)
    assert.equal(stopped.status, "stopped")
    assert.equal(stopped.port_free, true)
    assert.equal((await call("pipeline_serve", { action: "status" }, child)).status, "stopped")
  } finally {
    await call("pipeline_serve", { action: "stop" }, child)
  }
})

test("pipeline_serve: no contract is inconclusive; not a repository is an error", async () => {
  const res = await call("pipeline_serve", { action: "start" }, ctx(mkRepo()))
  assert.equal(res.status, "inconclusive")
  const notRepo = mkTmp("pipe-none-")
  assert.equal((await call("pipeline_serve", { action: "start" }, ctx(notRepo))).error, "not a git repository")
})
