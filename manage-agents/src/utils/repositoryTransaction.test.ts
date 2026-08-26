import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { afterEach, test } from "node:test"
import { AUTO_COMMIT_MESSAGES, parseAutoCommitArgs, repositoryTransaction } from "./repositoryTransaction.js"

const roots: string[] = []
const git = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim()
function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-manager-git-")); roots.push(root)
  git(root, "init", "-q"); git(root, "config", "user.name", "Test"); git(root, "config", "user.email", "test@example.com")
  fs.writeFileSync(path.join(root, "tracked.txt"), "before\n"); git(root, "add", "."); git(root, "commit", "-qm", "initial"); return fs.realpathSync(root)
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  delete process.env.AGENT_MANAGER_AUTO_COMMIT
  delete process.env.GIT_INDEX_FILE
  delete process.env.GIT_CONFIG_COUNT
  delete process.env.GIT_CONFIG_KEY_0
  delete process.env.GIT_CONFIG_VALUE_0
})

test("auto-commit policy is opt-in and CLI wins", () => {
  assert.equal(parseAutoCommitArgs([], {}).enabled, false)
  assert.equal(parseAutoCommitArgs([], { AGENT_MANAGER_AUTO_COMMIT: "0" }).enabled, false)
  assert.equal(parseAutoCommitArgs([], { AGENT_MANAGER_AUTO_COMMIT: "1" }).enabled, true)
  assert.equal(parseAutoCommitArgs(["--no-auto-commit"], { AGENT_MANAGER_AUTO_COMMIT: "1" }).enabled, false)
  assert.equal(parseAutoCommitArgs(["--auto-commit"], { AGENT_MANAGER_AUTO_COMMIT: "0" }).enabled, true)
  assert.deepEqual(parseAutoCommitArgs(["--auto-commit", "category", "build"], {}).argv, ["category", "build"])
  assert.deepEqual(parseAutoCommitArgs(["--no-auto-commit", "--", "category", "build"], { AGENT_MANAGER_AUTO_COMMIT: "1" }).argv, ["--", "category", "build"])
  assert.deepEqual(parseAutoCommitArgs(["--", "--auto-commit", "--no-auto-commit"], {}).argv, ["--", "--auto-commit", "--no-auto-commit"])
  assert.throws(() => parseAutoCommitArgs(["--auto-commit", "--no-auto-commit"], {}), /cannot be used together/)
  assert.throws(() => parseAutoCommitArgs([], { AGENT_MANAGER_AUTO_COMMIT: "yes" }), /expected exactly 0 or 1/)
})

test("default off mutates directly without Git", () => {
  const root = repo(); const target = path.join(root, "tracked.txt")
  repositoryTransaction(root, [target], AUTO_COMMIT_MESSAGES.tune, () => fs.writeFileSync(target, "direct\n"))
  assert.equal(fs.readFileSync(target, "utf8"), "direct\n"); assert.equal(git(root, "rev-parse", "HEAD"), git(root, "rev-parse", "HEAD~0"))
})

test("enabled transaction commits exact changes through the real index", () => {
  const root = repo(); const target = path.join(root, "tracked.txt"); process.env.AGENT_MANAGER_AUTO_COMMIT = "1"
  repositoryTransaction(root, [target], AUTO_COMMIT_MESSAGES.tune, () => fs.writeFileSync(target, "after\n"))
  assert.equal(git(root, "show", "--format=%s", "--name-only", "HEAD"), `${AUTO_COMMIT_MESSAGES.tune}\n\ntracked.txt`)
  assert.equal(git(root, "status", "--porcelain"), "")
})

test("enabled transaction commits a second update and leaves the real index clean", () => {
  const root = repo(); const target = path.join(root, "tracked.txt"); process.env.AGENT_MANAGER_AUTO_COMMIT = "1"
  repositoryTransaction(root, [target], AUTO_COMMIT_MESSAGES.tune, () => fs.writeFileSync(target, "one\n"))
  const first = git(root, "rev-parse", "HEAD")
  repositoryTransaction(root, [target], AUTO_COMMIT_MESSAGES.tune, () => fs.writeFileSync(target, "two\n"))
  assert.notEqual(git(root, "rev-parse", "HEAD"), first)
  assert.equal(git(root, "show", "HEAD:tracked.txt"), "two")
  assert.equal(git(root, "status", "--porcelain"), "")
})

test("enabled transaction commits exact add, delete, rename, mode, and special paths", () => {
  const root = repo(); process.env.AGENT_MANAGER_AUTO_COMMIT = "1"
  const source = path.join(root, "tracked.txt"); const destination = path.join(root, "renamed file–ユニコード.txt")
  const added = path.join(root, "- leading space.txt")
  repositoryTransaction(root, [source, destination, added], AUTO_COMMIT_MESSAGES.rename, () => {
    fs.renameSync(source, destination); fs.chmodSync(destination, 0o755); fs.writeFileSync(added, "added\n")
  })
  assert.deepEqual(git(root, "-c", "core.quotePath=false", "ls-tree", "-r", "-z", "--name-only", "HEAD").split("\0").filter(Boolean), ["- leading space.txt", "renamed file–ユニコード.txt"])
  assert.match(git(root, "ls-tree", "-r", "HEAD"), /100644 .*leading space\.txt/)
  assert.match(git(root, "ls-tree", "-r", "HEAD"), /100755 .*renamed file/)
  assert.equal(git(root, "status", "--porcelain"), "")
  repositoryTransaction(root, [destination], AUTO_COMMIT_MESSAGES.tune, () => fs.unlinkSync(destination))
  assert.equal(git(root, "ls-tree", "-r", "--name-only", "HEAD"), "- leading space.txt")
  assert.equal(git(root, "status", "--porcelain"), "")
})

test("enabled transaction refuses staged, unstaged, and untracked initial state without callback", () => {
  for (const kind of ["staged", "unstaged", "untracked"] as const) {
    const root = repo(); const target = path.join(root, "tracked.txt"); process.env.AGENT_MANAGER_AUTO_COMMIT = "1"
    if (kind === "staged") { fs.writeFileSync(target, "staged\n"); git(root, "add", target) }
    if (kind === "unstaged") fs.writeFileSync(target, "unstaged\n")
    if (kind === "untracked") fs.writeFileSync(path.join(root, "new.txt"), "new\n")
    let called = false
    assert.throws(() => repositoryTransaction(root, [target], AUTO_COMMIT_MESSAGES.tune, () => { called = true }), /refused before mutation/)
    assert.equal(called, false)
  }
})

test("update-index failure preserves the mutation and reports staged recovery", () => {
  const root = repo(); const target = path.join(root, "tracked.txt"); process.env.AGENT_MANAGER_AUTO_COMMIT = "1"
  fs.writeFileSync(path.join(root, ".git", "index.lock"), "held")
  assert.throws(() => repositoryTransaction(root, [target], AUTO_COMMIT_MESSAGES.tune, () => fs.writeFileSync(target, "after\n")), /update-index|manual recovery/i)
  assert.equal(fs.readFileSync(target, "utf8"), "after\n")
  assert.match(git(root, "status", "--porcelain"), /tracked\.txt/)
  fs.rmSync(path.join(root, ".git", "index.lock"))
})

test("unexpected path discovered after mutation aborts before staging or commit", () => {
  const root = repo(); const target = path.join(root, "tracked.txt"); process.env.AGENT_MANAGER_AUTO_COMMIT = "1"
  assert.throws(() => repositoryTransaction(root, [target], AUTO_COMMIT_MESSAGES.tune, () => {
    fs.writeFileSync(target, "after\n"); fs.writeFileSync(path.join(root, "outside.txt"), "concurrent\n")
  }), /Unexpected repository path changed/)
  assert.equal(git(root, "rev-parse", "HEAD"), git(root, "rev-parse", "HEAD~0"))
  assert.equal(git(root, "diff", "--cached", "--name-only"), "")
  assert.match(git(root, "status", "--porcelain"), /tracked\.txt|outside\.txt/)
})

test("preserves a replaced lock and keeps it exclusive until cleanup", () => {
  const root = repo(); const target = path.join(root, "tracked.txt"); process.env.AGENT_MANAGER_AUTO_COMMIT = "1"
  const lock = path.join(root, ".git", "agent-manager.lock")
  repositoryTransaction(root, [target], AUTO_COMMIT_MESSAGES.tune, () => {
    fs.unlinkSync(lock); fs.writeFileSync(lock, "replacement\n")
    assert.throws(() => repositoryTransaction(root, [target], AUTO_COMMIT_MESSAGES.tune, () => {}), /already running/)
    fs.writeFileSync(target, "after\n")
  })
  assert.equal(fs.readFileSync(lock, "utf8"), "replacement\n")
})

test("refuses symlink paths but allows ignored paths", () => {
  const root = repo(); process.env.AGENT_MANAGER_AUTO_COMMIT = "1"
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "agent-manager-outside-")); roots.push(outside)
  fs.symlinkSync(outside, path.join(root, "linked"), "dir")
  assert.throws(() => repositoryTransaction(root, [path.join(root, "linked", "new.txt")], AUTO_COMMIT_MESSAGES.create, () => {}), /symlink/i)
  fs.writeFileSync(path.join(root, ".gitignore"), "ignored.txt\n"); git(root, "add", ".gitignore"); git(root, "commit", "-qm", "ignore")
  repositoryTransaction(root, [path.join(root, "ignored.txt")], AUTO_COMMIT_MESSAGES.create, () => fs.writeFileSync(path.join(root, "ignored.txt"), "ignored\n"))
  assert.equal(git(root, "status", "--porcelain"), "")
})

test("sanitizes hostile Git index and bypasses hooks and signing", () => {
  const root = repo(); const target = path.join(root, "tracked.txt"); process.env.AGENT_MANAGER_AUTO_COMMIT = "1"
  process.env.GIT_INDEX_FILE = path.join(os.tmpdir(), "hostile-agent-index")
  process.env.GIT_CONFIG_COUNT = "1"; process.env.GIT_CONFIG_KEY_0 = "user.name"; process.env.GIT_CONFIG_VALUE_0 = "attacker"
  const hook = path.join(root, ".git", "hooks", "pre-commit"); fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n"); fs.chmodSync(hook, 0o755)
  repositoryTransaction(root, [target], AUTO_COMMIT_MESSAGES.tune, () => fs.writeFileSync(target, "safe\n"))
  assert.equal(git(root, "show", "--format=%s", "-s"), AUTO_COMMIT_MESSAGES.tune)
})
