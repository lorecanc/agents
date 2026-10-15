import assert from "node:assert/strict"
import { test } from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { mkTmp } from "./_pipeline_testutil.mjs"
import * as core from "./_pipeline_core.js"

import {
  checkBash, checkWritePath, tokenize, repoInfo, snapshot, gitAnomalies, scratchDir, ensureScratch,
  planCommit, executeCommit, writeSession, readSession, listSessions, rootRecordFor, conflictingClaims,
  isLive, withLock, toRel, editTargets, roleOf, isPipelineAgent, parsePorcelainZ, redact, changedFiles,
} from "./_pipeline_core.js"

function sh(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

function mkRepo() {
  const dir = mkTmp("pipe-core-")
  sh(dir, "init", "-q", "-b", "main")
  sh(dir, "config", "user.email", "t@example.com")
  sh(dir, "config", "user.name", "Test")
  sh(dir, "config", "commit.gpgsign", "false")
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n")
  fs.writeFileSync(path.join(dir, "b.txt"), "b\n")
  sh(dir, "add", ".")
  sh(dir, "commit", "-qm", "init")
  return dir
}

const ctxFor = (dir) => {
  const info = repoInfo(dir)
  return { info, cwd: dir, scratch: scratchDir(info) }
}

// ------------------------------------------------------------- basics

test("agent naming helpers", () => {
  assert.equal(isPipelineAgent("pipeline-orchestrator"), true)
  assert.equal(roleOf("pipeline-executor"), "executor")
  assert.equal(roleOf("pipeline-post_session"), "post_session")
  assert.equal(roleOf("hybrid-pipeline-executor"), "executor")
  assert.equal(roleOf("mistral-pipeline-post_session"), "post_session")
  assert.equal(roleOf("build"), null)
  assert.equal(isPipelineAgent("cp_nightly-pipeline-tester"), true)
  assert.equal(isPipelineAgent("docs-orchestrator"), false)
})

test("parsePorcelainZ handles untracked, deleted and renames", () => {
  const out = ["?? new.txt", " M a.txt", "D  gone.txt", "R  after.txt", "before.txt", ""].join("\0")
  const items = parsePorcelainZ(out)
  assert.deepEqual(items.map((i) => i.path), ["new.txt", "a.txt", "gone.txt", "after.txt"])
  assert.equal(items[0].untracked, true)
  assert.equal(items[2].deleted, true)
  assert.equal(items[3].orig, "before.txt")
})

test("redact masks common secret shapes", () => {
  assert.match(redact("API_KEY=abcd1234efgh"), /\[REDACTED\]/)
  assert.match(redact("Authorization: Bearer abcdef123456789"), /Bearer \[REDACTED\]/)
  assert.equal(redact("nothing to hide"), "nothing to hide")
})

// ------------------------------------------------------------ bash guard

test("tokenize: segments, redirects, nested substitutions", () => {
  const t = tokenize('echo "a b" > out.txt && rm -f x $(cat y) 2>/dev/null')
  assert.deepEqual(t.segments[0], ["echo", "a b"])
  assert.ok(t.redirects.includes("out.txt"))
  assert.ok(t.redirects.includes("/dev/null"))
  assert.deepEqual(t.segments[1].slice(0, 3), ["rm", "-f", "x"])
  assert.deepEqual(t.nested, ["cat y"])
})

test("tokenize: ANSI-C quoted strings do not retain the dollar prefix", () => {
  assert.deepEqual(tokenize("$'git checkout -b evil'").segments, [["git checkout -b evil"]])
  assert.deepEqual(tokenize(String.raw`$'hello\nworld'`).segments, [["hello\nworld"]])
})

test("checkBash: ANSI-C escapes are decoded before recursive shell validation", () => {
  const ctx = ctxFor(mkRepo())
  assert.ok(checkBash(String.raw`bash -c $'git\x20stash'`, "executor", ctx))
  assert.match(checkBash(String.raw`bash -c $'git\qstash'`, "executor", ctx), /ANSI-C/)
})

test("tokenize: heredoc bodies are data, ${VAR} stays one token, >&2 leaves no stray token", () => {
  const t = tokenize("cat <<'EOF'\nrm -rf /tmp/x\nEOF\necho ${HOME}/x >&2")
  const flat = t.segments.map((s) => s.join(" "))
  assert.deepEqual(flat, ["cat", "echo ${HOME}/x"])
})

test("checkBash: git mutations blocked for every role but post_session", () => {
  const dir = mkRepo()
  const ctx = ctxFor(dir)
  for (const cmd of [
    "git checkout -b feature", "git switch main", "git worktree add ../x -b y", "git stash", "git stash pop",
    "git reset --hard", "git clean -fd", "git rebase main", "git merge x", "git push origin main",
    "git commit -m x", "git add a.txt", "git branch newbranch", "git branch -D x", "git tag v1",
    "git -C ../elsewhere status", "git --git-dir=/x status", "git -c core.hooksPath=/x status",
    "git status && git checkout x", "echo $(git stash)",
  ]) {
    assert.ok(checkBash(cmd, "executor", ctx), `should block: ${cmd}`)
  }
  for (const cmd of [
    "git status --porcelain=v1 -uall", "git diff HEAD -- a.txt", "git log -1 --format=%H", "git show HEAD:a.txt",
    "git ls-files --others --exclude-standard", "git rev-parse --git-path opencode-scratch",
    "git branch --show-current", "git branch --list 'pipeline/*'", "git stash list", "git worktree list",
    "git tag", "git config --get user.name", "git -C . status",
  ]) {
    assert.equal(checkBash(cmd, "executor", ctx), null, `should allow: ${cmd}`)
  }
})

test("checkBash: post_session may add explicit files and commit, nothing broader", () => {
  const dir = mkRepo()
  const ctx = ctxFor(dir)
  assert.equal(checkBash("git add a.txt b.txt", "post_session", ctx), null)
  assert.equal(checkBash('git commit -m "x" -m "Pipeline-Checkpoint: true"', "post_session", ctx), null)
  assert.equal(checkBash("git restore --staged a.txt", "post_session", ctx), null)
  for (const cmd of [
    "git add -A", "git add .", "git add -u", "git add --all", "git commit -am x", "git commit --amend -m x",
    "git commit -m x --no-verify", "git restore a.txt", "git push", "git checkout x", "git worktree add x",
  ]) {
    assert.ok(checkBash(cmd, "post_session", ctx), `should block: ${cmd}`)
  }
})

test("checkBash: writes outside the repository are blocked, scratch and repo paths are fine", () => {
  const dir = mkRepo()
  const ctx = ctxFor(dir)
  const scratch = ensureScratch(ctx.info)
  for (const cmd of [
    "echo hi > /tmp/x.txt", "cat a.txt >> ~/notes.md", "cp a.txt /tmp/a.txt", "mv a.txt /var/folders/x/a.txt",
    "mkdir -p /tmp/work", "rm -rf /tmp/work", "touch /etc/foo", "tee /tmp/x < a.txt", "curl -s -o /tmp/r.json http://x",
    "wget -O /tmp/f http://x", "tar -xzf x.tgz -C /tmp", "cd /tmp && ls", "cd ../ && ls", "echo x > ../outside.txt",
    "sed -i 's/a/b/' /etc/hosts", "dd if=a.txt of=/tmp/o", "sudo ls", "echo $(cat a.txt > /tmp/z)",
    "mktemp /tmp/xxx", "cp a.txt .git/hooks/pre-commit", "echo x > .git/config",
  ]) {
    assert.ok(checkBash(cmd, "executor", ctx), `should block: ${cmd}`)
  }
  for (const cmd of [
    "echo hi > out.txt", "echo hi > /dev/null", "cmd 2>&1", "cmd >&2", "cp a.txt c.txt", "mkdir -p src/new", "rm -rf dist",
    `echo x > ${scratch}/log.txt`, "echo x > $TMPDIR/log.txt", "echo x > $PIPELINE_SCRATCH/log.txt",
    "mktemp", "npm test", "ls /usr/bin", "cat /etc/hosts", "cp /usr/share/x ./local", "curl -s http://localhost:3000/health",
    "timeout 10 npm test", "chmod +x script.sh", "sed -i 's/a/b/' a.txt", "echo ${HOME} > out.txt",
    "cat <<'EOF'\nrm -rf /tmp/x\nEOF",
  ]) {
    assert.equal(checkBash(cmd, "executor", ctx), null, `should allow: ${cmd}`)
  }
})

test("checkBash: unknown variables and unparseable input fail open", () => {
  const ctx = ctxFor(mkRepo())
  assert.equal(checkBash("echo x > $SOME_UNKNOWN/file", "executor", ctx), null)
  assert.equal(checkBash(undefined, "executor", ctx), null)
})

test("checkBash: recursively validates sh/bash/zsh -c and -lc command strings", () => {
  const ctx = ctxFor(mkRepo())
  const results = [
    checkBash("sh -c 'git checkout -b evil'", "executor", ctx),
    checkBash("bash -lc 'echo x > /tmp/pwn'", "executor", ctx),
    checkBash("env zsh -ec 'git stash'", "executor", ctx),
    checkBash("sh -c 'git status && echo ok > out.txt'", "executor", ctx),
  ]
  assert.deepEqual(results.map(Boolean), [true, true, true, false])
})

test("checkBash: rejects shell nesting beyond the validation limit", () => {
  const ctx = ctxFor(mkRepo())
  const nest = (command, depth) => {
    for (let i = 0; i < depth; i++) {
      command = `sh -c "${command.replaceAll(/["\\]/g, "\\$&")}"`
    }
    return command
  }

  assert.ok(checkBash(nest("git checkout -b evil", 5), "executor", ctx))
  assert.equal(checkBash(nest("echo ok", 4), "executor", ctx), null)
})

test("bashWriteTargets extracts repo-relative targets from redirects, file commands, sed -i, and nested sh -c", () => {
  assert.equal(typeof core.bashWriteTargets, "function")
  const targets = (command) => core.bashWriteTargets(command)
  assert.ok(targets("echo hi > a.txt").includes("a.txt"))
  assert.ok(targets("cp b.txt c.txt").includes("c.txt"))
  assert.ok(targets("sed -i 's/foo/bar/' a.txt").includes("a.txt"))
  assert.ok(targets("sh -c 'echo hi > d.txt'").includes("d.txt"))
  assert.ok(!targets("echo hi > /dev/null").includes("/dev/null"))
  assert.ok(!targets("echo hi > $PIPELINE_SCRATCH/tmp.txt").includes("$PIPELINE_SCRATCH/tmp.txt"))
})

test("bashWriteTargets resolves redirects after cd from that segment's working directory", () => {
  const dir = mkRepo()
  fs.mkdirSync(path.join(dir, "sub"))
  assert.ok(core.bashWriteTargets("cd sub && echo hi > file.txt", ctxFor(dir)).includes("sub/file.txt"))
})

test("checkWritePath resolves symlinks before comparing roots", () => {
  const dir = mkRepo()
  const outside = mkTmp("pipe-out-")
  fs.symlinkSync(outside, path.join(dir, "escape"))
  const ctx = ctxFor(dir)
  assert.ok(checkWritePath("escape/file.txt", ctx))
  assert.equal(checkWritePath("regular/file.txt", ctx), null)
})

test("editTargets extracts paths from edit/write/apply_patch calls", () => {
  assert.deepEqual(editTargets("edit", { filePath: "/r/a.ts" }), ["/r/a.ts"])
  assert.deepEqual(editTargets("write", { filePath: "x.ts" }), ["x.ts"])
  assert.deepEqual(
    editTargets("apply_patch", { patchText: "*** Begin Patch\n*** Update File: src/a.ts\n*** Add File: src/b.ts\n*** Move to: src/c.ts\n*** End Patch" }),
    ["src/a.ts", "src/b.ts", "src/c.ts"],
  )
  assert.deepEqual(editTargets("read", { filePath: "x" }), [])
})

// -------------------------------------------------- snapshot / anomalies

test("snapshot and gitAnomalies detect new branches, worktrees and stashes", () => {
  const dir = mkRepo()
  const info = repoInfo(dir)
  const base = snapshot(info)
  assert.equal(base.branch, "main")
  assert.equal(base.stash, 0)
  sh(dir, "branch", "side")
  fs.writeFileSync(path.join(dir, "a.txt"), "changed\n")
  sh(dir, "stash")
  sh(dir, "worktree", "add", "-q", path.join(path.dirname(dir), path.basename(dir) + "-wt"), "-b", "wtb")
  const now = snapshot(info)
  const kinds = gitAnomalies(base, now).map((a) => a.kind).sort()
  assert.deepEqual(kinds, ["new_branches", "new_stashes", "new_worktrees"])
  assert.deepEqual(gitAnomalies(null, now), [])
})

test("linked worktree under .git: scratch stays inside it and nothing is flagged as git internals", () => {
  const dir = mkRepo()
  const wt = path.join(dir, ".git", "opencode-worktrees", "s1")
  sh(dir, "worktree", "add", "-q", wt, "-b", "pipeline/s1")
  const info = repoInfo(wt)
  assert.equal(info.isLinked, true)
  assert.equal(info.top, fs.realpathSync(wt))
  const scratch = ensureScratch(info)
  assert.equal(scratch, path.join(info.top, ".opencode-scratch"))
  assert.ok(fs.readFileSync(path.join(info.common, "info", "exclude"), "utf8").includes(".opencode-scratch/"))
  fs.writeFileSync(path.join(scratch, "x.log"), "x")
  assert.deepEqual(changedFiles(info), []) // scratch never shows up as a change
  const ctx = { info, cwd: info.top, scratch }
  assert.equal(checkBash("echo x > src.txt", "executor", ctx), null)
  assert.ok(checkBash("echo x > ../../../../a.txt", "executor", ctx))
  assert.ok(checkBash("echo x > /tmp/x", "executor", ctx))
  assert.deepEqual(snapshot(info).worktrees.length, 2)
})

// ------------------------------------------------------ session registry

test("session registry: roots, children, liveness and claim conflicts", () => {
  const dir = mkRepo()
  const info = repoInfo(dir)
  const now = Date.now()
  writeSession(info, { sessionId: "ses_A", rootId: "ses_A", agent: "x-pipeline-orchestrator", pid: process.pid, busy: true, updatedAt: now, files: { "a.txt": now } })
  writeSession(info, { sessionId: "ses_A1", rootId: "ses_A", agent: "x-pipeline-executor", updatedAt: now })
  writeSession(info, { sessionId: "ses_B", rootId: "ses_B", agent: "x-pipeline-orchestrator", pid: process.pid, busy: true, updatedAt: now, files: {} })
  assert.equal(listSessions(info).length, 3)
  assert.equal(rootRecordFor(info, "ses_A1").sessionId, "ses_A")
  assert.equal(conflictingClaims(info, "ses_B", "a.txt").length, 1)
  assert.equal(conflictingClaims(info, "ses_A", "a.txt").length, 0)
  assert.equal(conflictingClaims(info, "ses_B", "b.txt").length, 0)
  // idle, stale, or dead-pid sessions never block
  writeSession(info, { sessionId: "ses_A", rootId: "ses_A", pid: process.pid, busy: false, updatedAt: now, files: { "a.txt": now } })
  assert.equal(conflictingClaims(info, "ses_B", "a.txt").length, 0)
  writeSession(info, { sessionId: "ses_A", rootId: "ses_A", pid: process.pid, busy: true, updatedAt: now - 3600_000, files: { "a.txt": now } })
  assert.equal(conflictingClaims(info, "ses_B", "a.txt").length, 0)
  writeSession(info, { sessionId: "ses_A", rootId: "ses_A", pid: 2 ** 22 + 12345, busy: true, updatedAt: now, files: { "a.txt": now } })
  assert.equal(isLive(readSession(info, "ses_A"), now), false)
  assert.throws(() => writeSession(info, { sessionId: "../evil", rootId: "x" }), /Invalid session id/)
})

test("writeSession does not recreate the state of a repository that no longer exists", () => {
  const dir = mkRepo()
  const info = repoInfo(dir)
  fs.rmSync(dir, { recursive: true, force: true })
  writeSession(info, { sessionId: "ses_gone", rootId: "ses_gone", busy: false, updatedAt: Date.now() })
  assert.equal(fs.existsSync(dir), false)
})

test("withLock serializes and cleans up", async () => {
  const info = repoInfo(mkRepo())
  const order = []
  const run = (name, ms) => withLock(info, "t", async () => { order.push(`${name}-in`); await new Promise((r) => setTimeout(r, ms)); order.push(`${name}-out`) }, { owner: name })
  await Promise.all([run("a", 80), run("b", 10)])
  assert.deepEqual(order.map((o) => o.split("-")[1]), ["in", "out", "in", "out"])
  assert.equal(fs.existsSync(path.join(info.stateDir, "locks", "t.lock")), false)
  await assert.rejects(
    withLock(info, "busy", () => withLock(info, "busy", async () => {}, { timeoutMs: 300 }), { owner: "outer" }),
    /busy/,
  )
})

test("withLock: never evicts a live pid past staleMs, recovers orphaned lock dirs without owner.json, and checks ownership in finally", async (t) => {
  const info = repoInfo(mkRepo())
  const locks = path.join(info.stateDir, "locks")
  fs.mkdirSync(locks, { recursive: true })
  const liveLock = path.join(locks, "live.lock")
  fs.mkdirSync(liveLock)
  fs.writeFileSync(path.join(liveLock, "owner.json"), JSON.stringify({ pid: process.pid, owner: "holder", at: Date.now() - 60_000 }))
  await t.test("a live PID is not evicted based only on stale timestamp", async () => {
    try {
      await assert.rejects(withLock(info, "live", async () => "stole", { staleMs: 10, timeoutMs: 300 }), /lock "live" busy/)
    } finally {
      fs.rmSync(liveLock, { recursive: true, force: true })
    }
  })

  await t.test("an orphaned lock directory without owner.json is recovered", async () => {
    const orphanLock = path.join(locks, "orphan.lock")
    fs.mkdirSync(orphanLock)
    const past = new Date(Date.now() - 10_000)
    fs.utimesSync(orphanLock, past, past)
    try {
      assert.equal(await withLock(info, "orphan", async () => "recovered", { staleMs: 1000, timeoutMs: 1000 }), "recovered")
    } finally {
      fs.rmSync(orphanLock, { recursive: true, force: true })
    }
  })

  await t.test("finally preserves a lock whose owner changed", async () => {
    const replacedLock = path.join(locks, "replaced.lock")
    try {
      await withLock(info, "replaced", async () => {
        const ownerFile = path.join(replacedLock, "owner.json")
        const original = JSON.parse(fs.readFileSync(ownerFile, "utf8"))
        fs.writeFileSync(ownerFile, JSON.stringify({ ...original, identity: "different-acquisition" }))
      })
      assert.equal(fs.existsSync(replacedLock), true)
    } finally {
      fs.rmSync(replacedLock, { recursive: true, force: true })
    }
  })

  for (const [label, replaceOwner] of [
    ["missing", (ownerFile) => fs.unlinkSync(ownerFile)],
    ["corrupt", (ownerFile) => fs.writeFileSync(ownerFile, "{")],
  ]) {
    await t.test(`finally preserves a lock with a ${label} owner file`, async () => {
      const lock = path.join(locks, `${label}.owner.lock`)
      try {
        await withLock(info, `${label}.owner`, async () => replaceOwner(path.join(lock, "owner.json")))
        assert.equal(fs.existsSync(lock), true)
      } finally {
        fs.rmSync(lock, { recursive: true, force: true })
      }
    })
  }
})

// ----------------------------------------------------------- commit plan

test("planCommit: baseline-dirty files are conflicts, other changes are unattributed, untracked included", () => {
  const dir = mkRepo()
  const info = repoInfo(dir)
  fs.writeFileSync(path.join(dir, "a.txt"), "user edit before session\n") // pre-existing dirty
  const baseline = snapshot(info)
  assert.deepEqual(baseline.dirty, ["a.txt"])
  fs.writeFileSync(path.join(dir, "a.txt"), "user edit + session edit\n")
  fs.writeFileSync(path.join(dir, "b.txt"), "session edit\n")
  fs.writeFileSync(path.join(dir, "new.ts"), "export {}\n")
  fs.writeFileSync(path.join(dir, "stray.txt"), "someone else\n")
  const root = { sessionId: "ses_X", rootId: "ses_X", baseline, files: { "b.txt": 1 } }
  const plan = planCommit(info, root, ["new.ts", "a.txt", "ghost.txt", "../outside", ".git/config"])
  assert.deepEqual(plan.commit, ["b.txt", "new.ts"])
  assert.deepEqual(plan.conflicts, ["a.txt"])
  assert.deepEqual(plan.notChanged, ["ghost.txt"])
  assert.deepEqual(plan.unattributed, ["stray.txt"])
  assert.deepEqual(plan.rejected.sort(), ["../outside", ".git/config"].sort())
  assert.deepEqual(plan.claimedOnly, ["b.txt"])
})

test("executeCommit commits only the plan and leaves other staged content staged", () => {
  const dir = mkRepo()
  const info = repoInfo(dir)
  const baseline = snapshot(info)
  fs.writeFileSync(path.join(dir, "b.txt"), "session\n")
  fs.writeFileSync(path.join(dir, "new.ts"), "export {}\n")
  fs.writeFileSync(path.join(dir, "a.txt"), "user staged change\n")
  sh(dir, "add", "a.txt") // someone else's staged work
  const plan = planCommit(info, { sessionId: "s", rootId: "s", baseline, files: {} }, ["b.txt", "new.ts"])
  const res = executeCommit(info, plan, "feat(x): thing", ["Pipeline-Checkpoint: true"])
  assert.deepEqual(res.committed, ["b.txt", "new.ts"])
  assert.deepEqual(res.unexpected, [])
  assert.match(sh(dir, "log", "-1", "--format=%B"), /Pipeline-Checkpoint: true/)
  assert.equal(sh(dir, "diff", "--cached", "--name-only"), "a.txt")
  assert.equal(sh(dir, "branch", "--list").split("\n").length, 1)
  assert.throws(() => executeCommit(info, { commit: [] }, "x"), /nothing to commit/)
})

test("executeCommit handles deletions and renames", () => {
  const dir = mkRepo()
  const info = repoInfo(dir)
  const baseline = snapshot(info)
  sh(dir, "mv", "a.txt", "a2.txt")
  fs.rmSync(path.join(dir, "b.txt"))
  const plan = planCommit(info, { sessionId: "s", rootId: "s", baseline, files: {} }, ["a2.txt", "b.txt"])
  assert.deepEqual(plan.commit, ["a.txt", "a2.txt", "b.txt"])
  const res = executeCommit(info, plan, "chore: rename and delete")
  assert.deepEqual(res.committed, ["a.txt", "a2.txt", "b.txt"])
  assert.equal(sh(dir, "status", "--porcelain"), "")
})

test("toRel rejects paths outside the repository", () => {
  const dir = mkRepo()
  const info = repoInfo(dir)
  assert.equal(toRel(info, "src/a.ts"), "src/a.ts")
  assert.equal(toRel(info, path.join(dir, "src", "a.ts")), "src/a.ts")
  assert.equal(toRel(info, "../x"), null)
  assert.equal(toRel(info, "/etc/hosts"), null)
})
