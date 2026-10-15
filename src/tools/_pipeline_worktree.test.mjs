import assert from "node:assert/strict"
import { test } from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { mkTmp } from "./_pipeline_testutil.mjs"

import { slugify, startWorktree, finishWorktree, abortWorktree, listWorktrees, gcWorktrees } from "../bin/opencode-wt.mjs"

function mkRepo(extra = {}) {
  const dir = mkTmp("pipe-wt-")
  const sh = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  sh("init", "-q", "-b", "main")
  sh("config", "user.email", "t@example.com")
  sh("config", "user.name", "T")
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n")
  for (const [name, content] of Object.entries(extra)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    fs.writeFileSync(path.join(dir, name), content)
  }
  sh("add", "-A")
  sh("commit", "-qm", "init")
  return { dir, sh }
}

const commitIn = (wt, file, content, msg = "work") => {
  fs.writeFileSync(path.join(wt, file), content)
  execFileSync("git", ["add", file], { cwd: wt })
  execFileSync("git", ["-c", "user.email=t@e.c", "-c", "user.name=T", "commit", "-qm", msg], { cwd: wt })
}

test("slugify", () => {
  assert.equal(slugify("Fix Login Bug!!"), "fix-login-bug")
  assert.equal(slugify("a".repeat(80)).length, 40)
  assert.throws(() => slugify("***"), /letters or digits/)
  assert.throws(() => slugify(""), /letters or digits/)
})

test("start: worktree lives under .git, invisible to the main checkout, with copied env files and setup", async () => {
  const { dir, sh } = mkRepo({ ".opencode/pipeline.json": JSON.stringify({ setup: "echo installed > setup.marker", worktree: { copy: [".env.local", "missing.env"] } }) })
  fs.writeFileSync(path.join(dir, ".env.local"), "SECRET=1\n") // untracked, not committed
  const r = await startWorktree(dir, "Fix login")
  assert.equal(r.slug, "fix-login")
  assert.equal(r.path, path.join(fs.realpathSync(dir), ".git", "opencode-worktrees", "fix-login"))
  assert.equal(r.branch, "pipeline/fix-login")
  assert.deepEqual(r.copied, [".env.local"])
  assert.equal(r.setupResult.exitCode, 0)
  assert.equal(fs.readFileSync(path.join(r.path, "setup.marker"), "utf8").trim(), "installed")
  assert.equal(fs.readFileSync(path.join(r.path, ".env.local"), "utf8"), "SECRET=1\n")
  assert.equal(sh("status", "--porcelain"), "?? .env.local", "the main checkout must not see the worktree")
  assert.equal(sh("branch", "--show-current"), "main")
  await assert.rejects(startWorktree(dir, "fix-login"), /already exists/)
  await assert.rejects(startWorktree(r.path, "nested"), /already inside a linked worktree/)
})

test("start: refuses detached HEAD without --base, unknown base, and a pre-existing branch", async () => {
  const { dir, sh } = mkRepo()
  sh("branch", "pipeline/taken")
  await assert.rejects(startWorktree(dir, "taken"), /branch pipeline\/taken already exists/)
  await assert.rejects(startWorktree(dir, "x", { base: "nope" }), /does not exist/)
  sh("checkout", "-q", "--detach")
  await assert.rejects(startWorktree(dir, "y"), /detached HEAD/)
  const ok = await startWorktree(dir, "y", { base: "main" })
  assert.equal(ok.base, "main")
})

test("finish: fast-forwards the work into the base, then removes worktree, branch and metadata", async () => {
  const { dir, sh } = mkRepo()
  const r = await startWorktree(dir, "feat")
  commitIn(r.path, "new.txt", "hello\n", "add new")
  const res = finishWorktree(dir, "feat")
  assert.deepEqual(res, { status: "merged", commits: 1, into: "main" })
  assert.equal(fs.readFileSync(path.join(dir, "new.txt"), "utf8"), "hello\n")
  assert.equal(sh("log", "-1", "--format=%s"), "add new")
  assert.equal(sh("worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length, 1)
  assert.equal(sh("branch", "--list", "pipeline/*"), "")
  assert.deepEqual(listWorktrees(dir), [])
  assert.equal(fs.existsSync(r.path), false)
})

test("finish: rebases when the base moved without conflicts", async () => {
  const { dir, sh } = mkRepo()
  const r = await startWorktree(dir, "feat")
  commitIn(r.path, "wt.txt", "from worktree\n", "wt change")
  fs.writeFileSync(path.join(dir, "main.txt"), "from main\n")
  sh("add", "main.txt")
  sh("commit", "-qm", "main moved")
  const res = finishWorktree(dir, "feat")
  assert.equal(res.status, "merged")
  assert.equal(sh("log", "--format=%s", "-3"), "wt change\nmain moved\ninit")
})

test("finish: conflicts, dirty worktree and wrong base branch leave everything intact", async () => {
  const { dir, sh } = mkRepo()
  const r = await startWorktree(dir, "feat")
  fs.writeFileSync(path.join(r.path, "a.txt"), "uncommitted\n")
  const dirty = finishWorktree(dir, "feat")
  assert.equal(dirty.status, "left")
  assert.match(dirty.reason, /uncommitted changes/)
  execFileSync("git", ["checkout", "--", "a.txt"], { cwd: r.path })

  commitIn(r.path, "a.txt", "worktree version\n", "wt edits a")
  fs.writeFileSync(path.join(dir, "a.txt"), "main version\n")
  sh("add", "a.txt")
  sh("commit", "-qm", "main edits a")
  const conflict = finishWorktree(dir, "feat")
  assert.equal(conflict.status, "left")
  assert.match(conflict.reason, /conflicts/)
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: r.path, encoding: "utf8" }).trim(), "", "rebase must be aborted")
  assert.equal(sh("branch", "--list", "pipeline/feat").length > 0, true)

  sh("checkout", "-q", "-b", "other")
  const wrong = finishWorktree(dir, "feat")
  assert.equal(wrong.status, "left")
  assert.match(wrong.reason, /not on the base branch "main"/)
  assert.equal(fs.existsSync(r.path), true)
})

test("finish: a branch without commits is simply removed", async () => {
  const { dir, sh } = mkRepo()
  const r = await startWorktree(dir, "empty")
  fs.mkdirSync(path.join(r.path, ".opencode-scratch"), { recursive: true })
  fs.writeFileSync(path.join(r.path, ".opencode-scratch", "junk.log"), "x")
  assert.equal(finishWorktree(dir, "empty").status, "removed")
  assert.equal(sh("branch", "--list", "pipeline/*"), "")
})

test("abort discards commits and uncommitted work and reports what was lost", async () => {
  const { dir, sh } = mkRepo()
  const r = await startWorktree(dir, "risky")
  commitIn(r.path, "x.txt", "x\n")
  fs.writeFileSync(path.join(r.path, "y.txt"), "uncommitted\n")
  assert.deepEqual(abortWorktree(dir, "risky"), { status: "discarded", commits: 1, hadUncommitted: true })
  assert.equal(fs.existsSync(r.path), false)
  assert.equal(sh("branch", "--list", "pipeline/*"), "")
  assert.throws(() => abortWorktree(dir, "risky"), /unknown worktree/)
})

test("list and gc: states, stale metadata, merged branches deleted, unmerged orphans kept", async () => {
  const { dir, sh } = mkRepo()
  const a = await startWorktree(dir, "aaa")
  commitIn(a.path, "a2.txt", "x\n")
  const listed = listWorktrees(dir)
  assert.deepEqual(listed.map((w) => [w.slug, w.ahead, w.dirty, w.exists]), [["aaa", 1, false, true]])

  // simulate someone deleting the directory by hand, and leftover branches
  fs.rmSync(a.path, { recursive: true, force: true })
  sh("worktree", "prune")
  sh("branch", "-D", "pipeline/aaa")
  sh("branch", "pipeline/merged") // points at HEAD: already merged
  sh("branch", "pipeline/orphan")
  sh("checkout", "-q", "pipeline/orphan")
  fs.writeFileSync(path.join(dir, "o.txt"), "o\n")
  sh("add", "o.txt")
  sh("commit", "-qm", "orphan work")
  sh("checkout", "-q", "main")
  const dry = gcWorktrees(dir, { dryRun: true })
  assert.deepEqual(dry.map((x) => x.action).sort(), ["delete_merged_branch", "drop_metadata", "orphan_branch_kept"])
  assert.equal(sh("branch", "--list", "pipeline/merged").length > 0, true, "dry run deletes nothing")
  gcWorktrees(dir)
  assert.equal(sh("branch", "--list", "pipeline/merged"), "")
  assert.equal(sh("branch", "--list", "pipeline/orphan").length > 0, true)
  assert.deepEqual(listWorktrees(dir), [])
})
