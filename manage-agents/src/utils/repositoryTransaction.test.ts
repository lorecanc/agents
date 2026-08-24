import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { afterEach, test } from "node:test"
import { AUTO_COMMIT_MESSAGES, RepositoryTransactionError, repositoryTransaction } from "./repositoryTransaction.js"

const temporaryRoots: string[] = []

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim()
}

function makeRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-manager-git-"))
  temporaryRoots.push(root)
  git(root, "init", "-q")
  git(root, "config", "user.name", "Test User")
  git(root, "config", "user.email", "test@example.com")
  fs.writeFileSync(path.join(root, "tracked.txt"), "before\n")
  git(root, "add", ".")
  git(root, "commit", "-qm", "initial")
  return fs.realpathSync(root)
}

function commits(root: string): string[] {
  return git(root, "log", "--format=%s").split("\n")
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  delete process.env.AGENT_MANAGER_AUTO_COMMIT
})

test("refuses a dirty repository before invoking the mutation", () => {
  const root = makeRepo()
  fs.writeFileSync(path.join(root, "unrelated.txt"), "local work\n")
  let invoked = false
  assert.throws(
    () => repositoryTransaction(root, [path.join(root, "tracked.txt")], AUTO_COMMIT_MESSAGES.tune, () => { invoked = true }),
    RepositoryTransactionError,
  )
  assert.equal(invoked, false)
  assert.equal(fs.readFileSync(path.join(root, "tracked.txt"), "utf8"), "before\n")
})

test("commits the exact scoped edit and excludes unrelated files", () => {
  const root = makeRepo()
  const tracked = path.join(root, "tracked.txt")
  repositoryTransaction(root, [tracked], AUTO_COMMIT_MESSAGES.tune, () => {
    fs.writeFileSync(tracked, "after\n")
  })
  assert.equal(git(root, "show", "--format=%s", "--name-only", "HEAD"), `${AUTO_COMMIT_MESSAGES.tune}\n\ntracked.txt`)
  assert.equal(git(root, "status", "--porcelain"), "")
})

test("stages paths with spaces, Unicode, and leading hyphens without shell interpretation", () => {
  const root = makeRepo()
  const target = path.join(root, "- spaced–ユニコード.txt")
  repositoryTransaction(root, [target], AUTO_COMMIT_MESSAGES.create, () => {
    fs.writeFileSync(target, "safe\n")
  })
  assert.equal(git(root, "show", "--format=%s", "-s"), AUTO_COMMIT_MESSAGES.create)
  assert.equal(git(root, "-c", "core.quotePath=false", "ls-tree", "--name-only", "-r", "HEAD"), `- spaced–ユニコード.txt\ntracked.txt`)
  assert.equal(git(root, "status", "--porcelain"), "")
})

test("commits a rename when both old and new paths are declared", () => {
  const root = makeRepo()
  const source = path.join(root, "tracked.txt")
  const destination = path.join(root, "renamed.txt")
  repositoryTransaction(root, [source, destination], AUTO_COMMIT_MESSAGES.rename, () => {
    fs.renameSync(source, destination)
  })
  assert.equal(git(root, "show", "--format=%s", "--name-status", "HEAD"), `${AUTO_COMMIT_MESSAGES.rename}\n\nR100\ttracked.txt\trenamed.txt`)
  assert.equal(git(root, "status", "--porcelain"), "")
})

test("handles additions, deletions, and no-op mutations", () => {
  const root = makeRepo()
  const added = path.join(root, "added.txt")
  repositoryTransaction(root, [added], AUTO_COMMIT_MESSAGES.create, () => fs.writeFileSync(added, "new\n"))
  assert.equal(git(root, "show", "--format=%s", "--name-only", "HEAD"), `${AUTO_COMMIT_MESSAGES.create}\n\nadded.txt`)

  const tracked = path.join(root, "tracked.txt")
  repositoryTransaction(root, [tracked], AUTO_COMMIT_MESSAGES.tune, () => fs.unlinkSync(tracked))
  assert.equal(
    git(root, "show", "--format=%s", "--name-status", "HEAD"),
    `${AUTO_COMMIT_MESSAGES.tune}\n\nD\ttracked.txt`,
  )

  const before = git(root, "rev-parse", "HEAD")
  repositoryTransaction(root, [added], AUTO_COMMIT_MESSAGES.tune, () => undefined)
  assert.equal(git(root, "rev-parse", "HEAD"), before)
})

test("leaves mutation failures and unexpected paths for recovery", () => {
  const root = makeRepo()
  const tracked = path.join(root, "tracked.txt")
  assert.throws(() => repositoryTransaction(root, [tracked], AUTO_COMMIT_MESSAGES.tune, () => {
    fs.writeFileSync(tracked, "temporary\n")
    throw new Error("mutation failed")
  }), /mutation failed/)
  assert.equal(fs.readFileSync(tracked, "utf8"), "temporary\n")
  assert.match(git(root, "status", "--porcelain"), /tracked\.txt/)

  const secondRoot = makeRepo()
  const secondTracked = path.join(secondRoot, "tracked.txt")
  assert.throws(() => repositoryTransaction(secondRoot, [secondTracked], AUTO_COMMIT_MESSAGES.tune, () => {
    fs.writeFileSync(secondTracked, "scoped\n")
    fs.writeFileSync(path.join(secondRoot, "surprise.txt"), "unexpected\n")
  }), /Unexpected repository path changed/)
  assert.equal(fs.readFileSync(secondTracked, "utf8"), "scoped\n")
  assert.equal(fs.existsSync(path.join(secondRoot, "surprise.txt")), true)
})

test("bypasses hooks, signing, and supports opt-out, ignored, external, nested, and locked paths", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "agent-manager-parent-"))
  temporaryRoots.push(parent)
  const root = path.join(parent, "workspace")
  fs.mkdirSync(root)
  git(parent, "init", "-q")
  git(parent, "config", "user.name", "Test User")
  git(parent, "config", "user.email", "test@example.com")
  fs.writeFileSync(path.join(root, "file.txt"), "one\n")
  git(parent, "add", ".")
  git(parent, "commit", "-qm", "initial")
  fs.writeFileSync(path.join(parent, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n")
  fs.chmodSync(path.join(parent, ".git", "hooks", "pre-commit"), 0o755)
  fs.writeFileSync(path.join(parent, ".gitignore"), "workspace/ignored.txt\n")
  git(parent, "add", ".gitignore")
  git(parent, "commit", "-qm", "ignore")

  const file = path.join(root, "file.txt")
  repositoryTransaction(root, [file], AUTO_COMMIT_MESSAGES.tune, () => fs.writeFileSync(file, "two\n"))
  assert.equal(commits(parent)[0], AUTO_COMMIT_MESSAGES.tune)

  const ignored = path.join(root, "ignored.txt")
  repositoryTransaction(root, [ignored], AUTO_COMMIT_MESSAGES.tune, () => fs.writeFileSync(ignored, "ignored\n"))
  assert.equal(commits(parent)[0], AUTO_COMMIT_MESSAGES.tune)

  const external = path.join(os.tmpdir(), `agent-manager-external-${process.pid}.txt`)
  temporaryRoots.push(external)
  process.env.AGENT_MANAGER_AUTO_COMMIT = "0"
  repositoryTransaction(root, [external], AUTO_COMMIT_MESSAGES.tune, () => fs.writeFileSync(external, "external\n"))
  assert.equal(fs.readFileSync(external, "utf8"), "external\n")
  delete process.env.AGENT_MANAGER_AUTO_COMMIT

  const lock = path.join(parent, ".git", "agent-manager.lock")
  fs.writeFileSync(lock, "held")
  assert.throws(() => repositoryTransaction(root, [file], AUTO_COMMIT_MESSAGES.tune, () => {}), /already running/)
  fs.rmSync(lock)
})

test("rejects an unborn repository and an operation in progress", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-manager-empty-"))
  temporaryRoots.push(root)
  git(root, "init", "-q")
  assert.throws(() => repositoryTransaction(root, [path.join(root, "new.txt")], AUTO_COMMIT_MESSAGES.create, () => {}), /unborn|identity/i)

  const ready = makeRepo()
  fs.writeFileSync(path.join(ready, ".git", "MERGE_HEAD"), "deadbeef\n")
  assert.throws(() => repositoryTransaction(ready, [path.join(ready, "tracked.txt")], AUTO_COMMIT_MESSAGES.tune, () => {}), /progress|detached|unborn/i)
})

test("does not overwrite a concurrent edit", () => {
  const root = makeRepo()
  const tracked = path.join(root, "tracked.txt")
  assert.throws(() => repositoryTransaction(root, [tracked], AUTO_COMMIT_MESSAGES.tune, () => {
    fs.writeFileSync(tracked, "manager change\n")
  }, { afterObservation: () => { fs.writeFileSync(tracked, "concurrent change\n"); throw new Error("race") } }), /race/)
  assert.equal(fs.readFileSync(tracked, "utf8"), "concurrent change\n")
})

test("does not stage or commit a same-scope edit after observation", () => {
  const root = makeRepo()
  const tracked = path.join(root, "tracked.txt")
  assert.throws(() => repositoryTransaction(root, [tracked], AUTO_COMMIT_MESSAGES.tune, () => {
    fs.writeFileSync(tracked, "manager change\n")
  }, { afterObservation: () => fs.writeFileSync(tracked, "concurrent change\n") }), /Concurrent edit|Recovery required/)
  assert.equal(fs.readFileSync(tracked, "utf8"), "concurrent change\n")
  assert.equal(git(root, "rev-parse", "HEAD"), git(root, "rev-parse", "HEAD~0"))
  assert.match(git(root, "status", "--porcelain"), /tracked\.txt/)
})

test("directory observations reject new, removed, and nested descendants", () => {
  const root = makeRepo()
  const scope = path.join(root, "nested")
  fs.mkdirSync(path.join(scope, "child"), { recursive: true })
  fs.writeFileSync(path.join(scope, "child", "one.txt"), "one\n")
  git(root, "add", ".")
  git(root, "commit", "-qm", "nested")
  const target = path.join(scope, "child", "one.txt")
  assert.throws(() => repositoryTransaction(root, [scope], AUTO_COMMIT_MESSAGES.tune, () => {
    fs.writeFileSync(target, "manager\n")
  }, { afterObservation: () => fs.writeFileSync(path.join(scope, "child", "new.txt"), "concurrent\n") }), /Concurrent edit|scope/)
  assert.equal(fs.readFileSync(path.join(scope, "child", "new.txt"), "utf8"), "concurrent\n")
  assert.equal(git(root, "status", "--porcelain"), "M nested/child/one.txt\n?? nested/child/new.txt")
})

test("Git discovery ignores hostile environment overrides and preserves trusted NOSYSTEM", () => {
  const root = makeRepo()
  const target = path.join(root, "tracked.txt")
  process.env.GIT_DIR = path.join(os.tmpdir(), "not-a-git-dir")
  process.env.GIT_WORK_TREE = os.tmpdir()
  process.env.GIT_INDEX_FILE = path.join(os.tmpdir(), "hostile-index")
  process.env.GIT_CONFIG_COUNT = "1"
  process.env.GIT_CONFIG_KEY_0 = "user.name"
  process.env.GIT_CONFIG_VALUE_0 = "attacker"
  process.env["gIt_CoNfIg"] = path.join(os.tmpdir(), "hostile-config")
  process.env["gIt_InDeX_FiLe"] = path.join(os.tmpdir(), "hostile-index-2")
  repositoryTransaction(root, [target], AUTO_COMMIT_MESSAGES.tune, () => fs.writeFileSync(target, "safe\n"))
  delete process.env.GIT_DIR
  delete process.env.GIT_WORK_TREE
  delete process.env.GIT_INDEX_FILE
  delete process.env.GIT_CONFIG_COUNT
  delete process.env.GIT_CONFIG_KEY_0
  delete process.env.GIT_CONFIG_VALUE_0
  delete process.env["gIt_CoNfIg"]
  delete process.env["gIt_InDeX_FiLe"]
  assert.equal(git(root, "show", "--format=%s", "-s"), AUTO_COMMIT_MESSAGES.tune)
})

test("refuses symlink scopes and symlinks appearing during verification", () => {
  const root = makeRepo()
  const target = path.join(root, "tracked.txt")
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "agent-manager-outside-"))
  temporaryRoots.push(outside)
  const link = path.join(root, "link")
  fs.symlinkSync(outside, link, "dir")
  assert.throws(() => repositoryTransaction(root, [link], AUTO_COMMIT_MESSAGES.tune, () => {}), /symlink/i)
  fs.rmSync(link)
  assert.throws(() => repositoryTransaction(root, [target], AUTO_COMMIT_MESSAGES.tune, () => {
    fs.writeFileSync(target, "changed\n")
    fs.symlinkSync(outside, path.join(root, "nested-link"), "dir")
  }), /symlink/i)
  assert.equal(fs.readFileSync(target, "utf8"), "changed\n")
  assert.equal(fs.existsSync(path.join(root, "nested-link")), true)
})
