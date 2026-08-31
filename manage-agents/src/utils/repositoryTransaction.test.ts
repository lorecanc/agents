import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync, spawnSync } from "node:child_process"
import { afterEach, test } from "node:test"
import { AUTO_COMMIT_MESSAGES, parseAutoCommitArgs, repositoryTransaction, type GitRunner } from "./repositoryTransaction.js"

const roots: string[] = []
const git = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim()
function withGitFailure<T>(root: string, operation: string, action: (runner: GitRunner) => T): T {
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim()
  const runner: GitRunner = { run: (runRoot, args, overrides = {}, input) => {
    if (args.includes(operation)) return { ...spawnSync(realGit, ["-C", runRoot, ...args], { encoding: "utf8", env: { ...process.env, ...overrides }, input }), status: 91 }
    return spawnSync(realGit, ["-C", runRoot, ...args], { encoding: "utf8", env: { ...process.env, ...overrides }, input })
  } }
  return action(runner)
}
function withGitRace<T>(target: string, action: (runner: GitRunner) => T): T {
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim()
  let hashCalls = 0
  const runner: GitRunner = { run: (runRoot, args, overrides = {}, input) => {
    const result = spawnSync(realGit, ["-C", runRoot, ...args], { encoding: "utf8", env: { ...process.env, ...overrides }, input })
    if (args.includes("hash-object") && ++hashCalls === 1) fs.writeFileSync(target, "race\n")
    return result
  } }
  return action(runner)
}
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
  delete process.env.REAL_GIT
  delete process.env.RACE_TARGET
  delete process.env.RACE_COUNT
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

test("preflight skips safely and invokes the mutation exactly once", () => {
  const cases = [
    { name: "non-repository", root: fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-manager-no-git-"))) },
    { name: "detached", root: repo() },
    { name: "unborn", root: fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-manager-unborn-"))) },
    { name: "identity", root: repo() },
  ]
  roots.push(cases[0].root, cases[2].root)
  git(cases[1].root, "checkout", "--detach", "-q")
  git(cases[2].root, "init", "-q")
  git(cases[3].root, "config", "user.name", "")
  git(cases[3].root, "config", "user.email", "")
  process.env.AGENT_MANAGER_AUTO_COMMIT = "1"
  const globalConfig = process.env.GIT_CONFIG_GLOBAL
  process.env.GIT_CONFIG_GLOBAL = "/dev/null"
  for (const item of cases) {
    let calls = 0
    const result = repositoryTransaction(item.root, [path.join(item.root, "model.txt")], AUTO_COMMIT_MESSAGES.tune, () => { calls++; fs.writeFileSync(path.join(item.root, "model.txt"), item.name) })
    assert.equal(result.commit, "skipped", item.name)
    assert.equal(calls, 1, item.name)
    assert.ok(result.warning, item.name)
  }
  if (globalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL
  else process.env.GIT_CONFIG_GLOBAL = globalConfig
})

test("invalid plans throw before mutation, and mutation errors propagate", () => {
  const root = repo(); process.env.AGENT_MANAGER_AUTO_COMMIT = "1"
  let called = false
  assert.throws(() => repositoryTransaction(root, [path.join(root, "..", "escape")], AUTO_COMMIT_MESSAGES.tune, () => { called = true }), /traversal|repository-local/)
  assert.equal(called, false)
  const error = new Error("mutation failed")
  assert.throws(() => repositoryTransaction(root, [path.join(root, "tracked.txt")], AUTO_COMMIT_MESSAGES.tune, () => { throw error }), error)
})

test("default off mutates directly without Git", () => {
  const root = repo(); const target = path.join(root, "tracked.txt")
  repositoryTransaction(root, [target], AUTO_COMMIT_MESSAGES.tune, () => fs.writeFileSync(target, "direct\n"))
  assert.equal(fs.readFileSync(target, "utf8"), "direct\n"); assert.equal(git(root, "rev-parse", "HEAD"), git(root, "rev-parse", "HEAD~0"))
})

test("enabled transaction commits exact changes through the real index", () => {
  const root = repo(); const target = path.join(root, "tracked.txt"); process.env.AGENT_MANAGER_AUTO_COMMIT = "1"
  const result = repositoryTransaction(root, [target], AUTO_COMMIT_MESSAGES.tune, () => fs.writeFileSync(target, "after\n"))
  assert.equal(result.commit, "committed")
  assert.match(result.commitHash || "", /^[0-9a-f]{40,64}$/)
  assert.equal(git(root, "show", "--format=%s", "--name-only", "HEAD"), `${AUTO_COMMIT_MESSAGES.tune}\n\ntracked.txt`)
  assert.equal(git(root, "status", "--porcelain"), "")
})

test("nested workspace resolves the repository root and commits the intended model file", () => {
  const root = repo()
  const workspace = path.join(root, "nested-workspace")
  const target = path.join(workspace, "general", "agents", "model.md")
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, "old model\n")
  git(root, "add", ".")
  git(root, "commit", "-qm", "nested initial")
  process.env.AGENT_MANAGER_AUTO_COMMIT = "1"

  const result = repositoryTransaction(workspace, [target], AUTO_COMMIT_MESSAGES.tune, () => {
    fs.writeFileSync(target, "new model\n")
  })

  assert.equal(result.commit, "committed")
  assert.equal(git(root, "show", "--format=%s", "--name-only", "HEAD"), `${AUTO_COMMIT_MESSAGES.tune}\n\nnested-workspace/general/agents/model.md`)
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

test("dirty initial state skips Git once, preserves status, and does not stage the mutation", () => {
  for (const kind of ["staged", "unstaged", "untracked"] as const) {
    const root = repo(); const target = path.join(root, "tracked.txt"); process.env.AGENT_MANAGER_AUTO_COMMIT = "1"
    if (kind === "staged") { fs.writeFileSync(target, "staged\n"); git(root, "add", target) }
    if (kind === "unstaged") fs.writeFileSync(target, "unstaged\n")
    if (kind === "untracked") fs.writeFileSync(path.join(root, "new.txt"), "new\n")
    let called = 0
    const result = repositoryTransaction(root, [target], AUTO_COMMIT_MESSAGES.tune, () => { called++; fs.writeFileSync(target, "new mutation\n") })
    assert.equal(result.commit, "skipped")
    assert.equal(result.warning?.code, "dirty-repository")
    assert.equal(called, 1)
    assert.match(git(root, "status", "--porcelain"), /tracked\.txt|new\.txt/)
    assert.equal(git(root, "diff", "--cached", "--name-only"), kind === "staged" ? "tracked.txt" : "")
  }
})

test("dirty preflight fallback allows a concurrent mutation without the manager lock", () => {
  const root = repo(); const target = path.join(root, "tracked.txt"); process.env.AGENT_MANAGER_AUTO_COMMIT = "1"
  fs.writeFileSync(path.join(root, "unrelated.txt"), "dirty\n")
  let nested: ReturnType<typeof repositoryTransaction> | undefined
  const result = repositoryTransaction(root, [target], AUTO_COMMIT_MESSAGES.tune, () => {
    fs.writeFileSync(target, "outer\n")
    nested = repositoryTransaction(root, [target], AUTO_COMMIT_MESSAGES.tune, () => fs.writeFileSync(target, "nested\n"))
  })
  assert.equal(result.commit, "skipped")
  assert.equal(nested?.warning?.code, "checkpoint-locked")
  assert.equal(fs.readFileSync(target, "utf8"), "nested\n")
  assert.equal(git(root, "rev-parse", "HEAD"), git(root, "rev-parse", "HEAD~0"))
})

test("occupied checkpoint lock runs the mutation once and returns its value", () => {
  const root = repo(); const target = path.join(root, "tracked.txt"); process.env.AGENT_MANAGER_AUTO_COMMIT = "1"
  fs.writeFileSync(path.join(root, ".git", "agent-manager.lock"), "held\n")
  const value = { result: { exact: true } }
  let calls = 0; let warnings = 0
  const result = repositoryTransaction(root, [target], AUTO_COMMIT_MESSAGES.tune, () => {
    calls++
    fs.writeFileSync(target, "locked mutation\n")
    return value
  }, { onWarning: () => { warnings++ } })
  assert.equal(result.commit, "skipped")
  assert.equal(result.warning?.code, "checkpoint-locked")
  assert.strictEqual(result.value, value)
  assert.equal(result.value.result.exact, true)
  assert.equal(calls, 1)
  assert.equal(warnings, 1)
})

test("occupied checkpoint lock propagates mutation errors", () => {
  const root = repo(); const target = path.join(root, "tracked.txt"); process.env.AGENT_MANAGER_AUTO_COMMIT = "1"
  fs.writeFileSync(path.join(root, ".git", "agent-manager.lock"), "held\n")
  const error = new Error("locked mutation failed")
  assert.throws(() => repositoryTransaction(root, [target], AUTO_COMMIT_MESSAGES.tune, () => { throw error }), error)
})

test("marker and Git-inspection fallbacks allow concurrent mutations without the manager lock", () => {
  const cases: Array<{ setup: (root: string) => void; failGit?: boolean }> = [
    { setup: root => fs.writeFileSync(path.join(root, ".git", "MERGE_HEAD"), "deadbeef\n") },
    { setup: () => {}, failGit: true },
  ]
  for (const item of cases) {
    const root = repo(); const target = path.join(root, "tracked.txt"); process.env.AGENT_MANAGER_AUTO_COMMIT = "1"
    item.setup(root)
    let nested: ReturnType<typeof repositoryTransaction> | undefined
    const run = () => repositoryTransaction(root, [target], AUTO_COMMIT_MESSAGES.tune, () => {
      fs.writeFileSync(target, "fallback\n")
      nested = repositoryTransaction(root, [target], AUTO_COMMIT_MESSAGES.tune, () => fs.writeFileSync(target, "nested\n"))
    })
    const result = item.failGit ? withGitFailure(root, "status", runner => repositoryTransaction(root, [target], AUTO_COMMIT_MESSAGES.tune, () => {
      fs.writeFileSync(target, "fallback\n")
      nested = repositoryTransaction(root, [target], AUTO_COMMIT_MESSAGES.tune, () => fs.writeFileSync(target, "nested\n"), { gitRunner: runner })
    }, { gitRunner: runner })) : run()
    assert.equal(result.commit, "skipped")
    assert.equal(nested?.warning?.code, "checkpoint-locked")
    assert.equal(fs.readFileSync(target, "utf8"), "nested\n")
    fs.rmSync(path.join(root, ".git", "MERGE_HEAD"), { force: true })
  }
})

test("post-capture failure preserves the mutation and reports failed recovery", () => {
  const root = repo(); const target = path.join(root, "tracked.txt"); process.env.AGENT_MANAGER_AUTO_COMMIT = "1"
  const lock = path.join(root, ".git", "index.lock")
  const result = repositoryTransaction(root, [target], AUTO_COMMIT_MESSAGES.tune, () => { fs.writeFileSync(target, "after\n"); fs.writeFileSync(lock, "held") })
  assert.equal(result.commit, "failed")
  assert.equal(result.warning?.code, "git-failure")
  assert.equal(fs.readFileSync(target, "utf8"), "after\n")
  assert.match(git(root, "status", "--porcelain"), /tracked\.txt/)
  fs.rmSync(lock)
})

test("mutation failure releases the manager lock", () => {
  const root = repo(); const target = path.join(root, "tracked.txt"); process.env.AGENT_MANAGER_AUTO_COMMIT = "1"
  assert.throws(() => repositoryTransaction(root, [target], AUTO_COMMIT_MESSAGES.tune, () => { throw new Error("boom") }), /boom/)
  assert.equal(fs.existsSync(path.join(root, ".git", "agent-manager.lock")), false)
  const result = repositoryTransaction(root, [target], AUTO_COMMIT_MESSAGES.tune, () => fs.writeFileSync(target, "after\n"))
  assert.equal(result.commit, "committed")
})

test("selected path changing after capture fails without attempting a commit", () => {
  const root = repo(); const target = path.join(root, "tracked.txt"); process.env.AGENT_MANAGER_AUTO_COMMIT = "1"
  const beforeHead = git(root, "rev-parse", "HEAD")
   const result = withGitRace(target, runner => repositoryTransaction(root, [target], AUTO_COMMIT_MESSAGES.tune, () => fs.writeFileSync(target, "captured\n"), { gitRunner: runner }))
  assert.equal(result.commit, "failed")
  assert.equal(result.warning?.code, "concurrent-worktree-change")
  assert.equal(git(root, "rev-parse", "HEAD"), beforeHead)
  assert.equal(git(root, "status", "--porcelain"), "M tracked.txt")
})

test("healthy commit matches the captured blob and mode", () => {
  const root = repo(); const target = path.join(root, "tracked.txt"); process.env.AGENT_MANAGER_AUTO_COMMIT = "1"
  const content = "executable payload\n"
  const result = repositoryTransaction(root, [target], AUTO_COMMIT_MESSAGES.tune, () => { fs.writeFileSync(target, content); fs.chmodSync(target, 0o755) })
  assert.equal(result.commit, "committed")
  assert.equal(git(root, "show", "HEAD:tracked.txt"), content.trimEnd())
  assert.match(git(root, "ls-tree", "HEAD", "--", "tracked.txt"), /^100755 blob [0-9a-f]+\s+tracked\.txt$/)
  assert.equal(git(root, "status", "--porcelain"), "")
})

test("every warning invokes onWarning once, and callback failures are ignored", () => {
  const cases = [
    (root: string, target: string) => { fs.writeFileSync(target, "dirty\n") },
    (root: string, target: string) => { fs.writeFileSync(path.join(root, ".git", "agent-manager.lock"), "held\n") },
    (root: string, target: string) => { fs.writeFileSync(path.join(root, ".git", "MERGE_HEAD"), "deadbeef\n") },
    (root: string, target: string) => { fs.writeFileSync(target, "after\n"); fs.writeFileSync(path.join(root, ".git", "index.lock"), "held\n") },
  ]
  for (const prepare of cases) {
    const root = repo(); const target = path.join(root, "tracked.txt"); process.env.AGENT_MANAGER_AUTO_COMMIT = "1"
    prepare(root, target)
    let calls = 0
    const result = repositoryTransaction(root, [target], AUTO_COMMIT_MESSAGES.tune, () => fs.writeFileSync(target, "mutation\n"), {
      onWarning: () => { calls++; throw new Error("observer failure") },
    })
    assert.ok(result.warning)
    assert.equal(calls, 1)
    fs.rmSync(path.join(root, ".git", "agent-manager.lock"), { force: true })
    fs.rmSync(path.join(root, ".git", "MERGE_HEAD"), { force: true })
    fs.rmSync(path.join(root, ".git", "index.lock"), { force: true })
  }
})

test("a concurrent staging operation before publish is preserved and the ref is not changed", () => {
  const root = repo(); const target = path.join(root, "tracked.txt"); const other = path.join(root, "other.txt"); process.env.AGENT_MANAGER_AUTO_COMMIT = "1"
  const beforeHead = git(root, "rev-parse", "HEAD")
  const result = repositoryTransaction(root, [target], AUTO_COMMIT_MESSAGES.tune, () => {
    fs.writeFileSync(target, "after\n"); fs.writeFileSync(other, "concurrent\n"); git(root, "add", other)
  })
  assert.equal(result.commit, "failed")
  assert.equal(result.warning?.code, "unexpected-path")
  assert.equal(git(root, "rev-parse", "HEAD"), beforeHead)
  assert.equal(git(root, "diff", "--cached", "--name-only"), "other.txt")
})

test("an index lock held by the mutation blocks a child git add", () => {
  const root = repo(); const target = path.join(root, "tracked.txt"); const other = path.join(root, "other.txt"); process.env.AGENT_MANAGER_AUTO_COMMIT = "1"
  let childFailed = false
  const result = repositoryTransaction(root, [target], AUTO_COMMIT_MESSAGES.tune, () => {
    fs.writeFileSync(target, "after\n"); fs.writeFileSync(path.join(root, ".git", "index.lock"), "held\n")
    fs.writeFileSync(other, "other\n")
    try { execFileSync("git", ["-C", root, "add", other], { stdio: "pipe" }) } catch { childFailed = true }
  })
  assert.equal(childFailed, true)
  assert.equal(result.commit, "failed")
  assert.equal(result.warning?.code, "unexpected-path")
  assert.equal(git(root, "diff", "--cached", "--name-only"), "")
  fs.rmSync(path.join(root, ".git", "index.lock"), { force: true })
})

test("Git operation markers skip auto-commit and invoke the mutation exactly once", () => {
  const markers = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"]
  for (const marker of markers) {
    const root = repo()
    const markerPath = path.join(root, ".git", marker)
    if (marker.startsWith("rebase-")) fs.mkdirSync(markerPath)
    else fs.writeFileSync(markerPath, "marker\n")
    const target = path.join(root, "tracked.txt")
    process.env.AGENT_MANAGER_AUTO_COMMIT = "1"
    let calls = 0

    const result = repositoryTransaction(root, [target], AUTO_COMMIT_MESSAGES.tune, () => {
      calls++
      fs.writeFileSync(target, `${marker}\n`)
    })

    assert.equal(result.commit, "skipped", marker)
    assert.equal(result.warning?.code, "unsupported-repository-state", marker)
    assert.equal(calls, 1, marker)
    assert.equal(git(root, "status", "--porcelain"), "M tracked.txt", marker)
    fs.rmSync(markerPath, { recursive: true, force: true })
  }
})

test("unexpected path discovered after mutation aborts before staging or commit", () => {
  const root = repo(); const target = path.join(root, "tracked.txt"); process.env.AGENT_MANAGER_AUTO_COMMIT = "1"
  const result = repositoryTransaction(root, [target], AUTO_COMMIT_MESSAGES.tune, () => {
    fs.writeFileSync(target, "after\n"); fs.writeFileSync(path.join(root, "outside.txt"), "concurrent\n")
  })
  assert.equal(result.commit, "failed")
  assert.equal(result.warning?.code, "unexpected-path")
  assert.equal(git(root, "rev-parse", "HEAD"), git(root, "rev-parse", "HEAD~0"))
  assert.equal(git(root, "diff", "--cached", "--name-only"), "")
  assert.match(git(root, "status", "--porcelain"), /tracked\.txt|outside\.txt/)
})

test("preserves a replaced lock and keeps it exclusive until cleanup", () => {
  const root = repo(); const target = path.join(root, "tracked.txt"); process.env.AGENT_MANAGER_AUTO_COMMIT = "1"
  const lock = path.join(root, ".git", "agent-manager.lock")
  repositoryTransaction(root, [target], AUTO_COMMIT_MESSAGES.tune, () => {
    fs.unlinkSync(lock); fs.writeFileSync(lock, "replacement\n")
    const nested = repositoryTransaction(root, [target], AUTO_COMMIT_MESSAGES.tune, () => {})
    assert.equal(nested.commit, "skipped")
    assert.equal(nested.warning?.phase, "lock")
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
  assert.match(git(root, "status", "--porcelain"), /linked/)
})

test("sanitizes hostile Git index and bypasses hooks and signing", () => {
  const root = repo(); const target = path.join(root, "tracked.txt"); process.env.AGENT_MANAGER_AUTO_COMMIT = "1"
  process.env.GIT_INDEX_FILE = path.join(os.tmpdir(), "hostile-agent-index")
  process.env.GIT_CONFIG_COUNT = "1"; process.env.GIT_CONFIG_KEY_0 = "user.name"; process.env.GIT_CONFIG_VALUE_0 = "attacker"
  const hook = path.join(root, ".git", "hooks", "pre-commit"); fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n"); fs.chmodSync(hook, 0o755)
  repositoryTransaction(root, [target], AUTO_COMMIT_MESSAGES.tune, () => fs.writeFileSync(target, "safe\n"))
  assert.equal(git(root, "show", "--format=%s", "-s"), AUTO_COMMIT_MESSAGES.tune)
})
