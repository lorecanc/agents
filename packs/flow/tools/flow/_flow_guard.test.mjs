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

import { checkFlowBash, fileStamp, flowGitPolicy, inPlaceTargets, isFlowAgent, isSecretEnvFile, scanAddedCode, addedText, staleEditReason } from "./_flow_guard.js"
import { repoInfo, scratchDir } from "../dev-tools/_repo.js"
import { checkBash } from "../dev-tools/_bash_guard.js"

const plugin = (await import("../../plugins/flow-guard/index.ts")).default

function mkRepo() {
  const dir = mkTmp("flow-guard-")
  const sh = (...a) => execFileSync("git", a, { cwd: dir, stdio: "ignore" })
  sh("init", "-q", "-b", "main")
  sh("config", "user.email", "t@example.com")
  sh("config", "user.name", "T")
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n")
  sh("add", "-A")
  sh("commit", "-qm", "init")
  return dir
}

const repo = mkRepo()
const info = repoInfo(repo)
const ctx = { info, cwd: repo, scratch: scratchDir(info) }
const bash = (command, role = "build") => checkFlowBash(command, role, ctx)

function makeContext(directory) {
  const handlers = { session: {}, tool: {}, event: null }
  const hookFor = (kind) => (name, callback) => {
    handlers[kind][name] = callback
    return () => { delete handlers[kind][name] }
  }
  return {
    handlers,
    ctx: {
      location: { directory },
      session: { hook: hookFor("session") },
      tool: { hook: hookFor("tool") },
      event: { subscribe: (_options, callback) => { handlers.event = callback; return () => { handlers.event = null } } },
    },
  }
}

test("flow agent names", () => {
  assert.ok(isFlowAgent("flow-build"))
  assert.ok(isFlowAgent("flow-review"))
  assert.ok(isFlowAgent("hybrid-flow-build"), "stamped multi-provider copies are flow agents")
  assert.ok(!isFlowAgent("workflow-build"))
  assert.ok(!isFlowAgent("hybrid-pipeline-executor"))
  assert.ok(!isFlowAgent("build"))
})

test("everyday read commands that the v1 guard rejected for read-only roles are allowed", () => {
  for (const command of [
    "grep -rn foo src 2>/dev/null",
    "rg process.env src",
    "rg import.meta.env",
    "curl -s http://localhost:3000/health",
    "tar -tzf archive.tgz",
    "ls config 2>&1 | head",
  ]) {
    assert.equal(bash(command, "explore"), null, command)
    assert.equal(bash(command, "build"), null, command)
  }
})

test("read-only flow agents cannot write through the shell", () => {
  assert.match(bash("echo x > a.txt", "review"), /read-only/)
  assert.match(bash("curl -s -o out.html http://x", "explore"), /read-only/)
  assert.equal(bash("echo x > a.txt", "build"), null)
})

test("writes outside the repository, sudo and real .env reads are blocked", () => {
  assert.match(bash("echo x > /etc/flow-test"), /outside the repository/)
  assert.match(bash("sudo ls"), /not allowed/)
  assert.match(bash("cat .env"), /\.env/)
  assert.equal(bash("cat .env.example"), null)
  assert.equal(bash("echo x > /tmp/flow-guard-ok.txt"), null)
})

test("workspace git is allowed, destructive or interactive git is blocked", () => {
  for (const command of [
    "git status", "git switch -c feat/x", "git checkout -b feat/y", "git stash", "git stash pop",
    "git add src/a.ts", 'git commit -m "feat: x"', "git push -u origin feat/x", "git branch -d old", "git clean -n",
    "git restore --staged a.txt", "git checkout -- a.txt",
  ]) {
    assert.equal(bash(command), null, command)
  }
  for (const [command, re] of [
    ["git push --force origin main", /destructive/],
    ["git push -f", /destructive/],
    ["git push origin +main", /destructive/],
    ["git reset --hard HEAD~1", /destructive/],
    ["git clean -fd", /destructive/],
    ["git checkout .", /destructive/],
    ["git restore .", /destructive/],
    ["git branch -D old", /destructive/],
    ["git stash drop", /destructive/],
    ["git rebase -i HEAD~3", /interactive/i],
    ["git add -p", /interactive|explicit/i],
    ["git add .", /explicit/],
    ["git commit", /editor/],
    ["git commit --amend", /editor/],
    ["git fetch --upload-pack=evil origin", /transport/],
    ["git config core.hooksPath /tmp/h", /not allowed/],
    ["git config --global user.name x", /outside/],
    ["cd sub && git reset --hard", /destructive/],
  ]) {
    assert.match(bash(command) || "", re, command)
  }
  assert.equal(bash('git commit --amend --no-edit'), null)
  assert.equal(bash("git config user.name T"), null)
})

test("the v1 role check is unchanged when no gitPolicy is given", () => {
  assert.match(checkBash("git switch -c feat/x", "executor", ctx) || "", /managed by the pipeline/)
  assert.equal(flowGitPolicy(["switch", "-c", "feat/x"], ctx), null)
})

test("real dotenv files are secret, templates are not", () => {
  assert.ok(isSecretEnvFile("/repo/.env"))
  assert.ok(isSecretEnvFile(".env.local"))
  assert.ok(!isSecretEnvFile(".env.example"))
  assert.ok(!isSecretEnvFile("src/env.ts"))
})

test("post-edit scan flags secrets, sinks, SQL interpolation and leftovers", () => {
  const w = (text, file = "src/app.ts") => scanAddedCode(text, file).join(" | ")
  assert.match(w('const key = "AKIAABCDEFGHIJKLMNOP"'), /AWS/)
  assert.match(w('const apiKey = "s3cr3tValue123456"'), /credential literal/)
  assert.equal(w('const apiKey = process.env.API_KEY'), "")
  assert.equal(w('const password = "changeme"'), "")
  assert.match(w("el.innerHTML = userInput"), /XSS/)
  assert.match(w("db.query(`SELECT * FROM users WHERE id = ${id}`)"), /SQL/)
  assert.match(w('cursor.execute("SELECT * FROM t WHERE id = " + uid)', "app.py"), /SQL/)
  assert.match(w('cursor.execute(f"SELECT * FROM t WHERE id = {uid}")', "app.py"), /SQL/)
  assert.match(w("subprocess.run(cmd, shell=True)", "run.py"), /shell=True/)
  assert.match(w("console.log(user)"), /console\.log/)
  assert.equal(w("console.log(user)", "src/app.test.ts"), "")
  assert.equal(w("console.log(user)", "README.md"), "")
  assert.match(w("// TODO: handle errors"), /TODO/)
  assert.equal(w("const total = items.reduce((a, b) => a + b, 0)"), "")
})

test("addedText reads edit, write, multiedit and patch inputs", () => {
  assert.equal(addedText("edit", { filePath: "a", oldString: "x", newString: "y" }), "y")
  assert.equal(addedText("write", { filePath: "a", content: "c" }), "c")
  assert.equal(addedText("multiedit", { edits: [{ newString: "a" }, { newString: "b" }] }), "a\nb")
  assert.equal(addedText("apply_patch", { patchText: "*** Update File: a\n+new\n-old\n context" }), "new")
})

test("plugin: blocks only flow sessions and appends scan notes to edit results", async () => {
  const h = makeContext(repo)
  const cleanup = await plugin.setup(h.ctx)
  const before = (sessionID, tool, input) => h.handlers.tool["execute.before"]({ sessionID, tool, input })

  await h.handlers.session["model.request"]({ sessionID: "s_flow", agent: "flow-build" })
  await h.handlers.session["model.request"]({ sessionID: "s_other", agent: "build" })
  await assert.rejects(before("s_flow", "shell", { command: "git reset --hard" }), /\[flow-guard\] Blocked/)
  await before("s_other", "shell", { command: "git reset --hard" })
  await assert.rejects(before("s_flow", "write", { filePath: "/etc/flow-test", content: "x" }), /outside the repository/)
  await assert.rejects(before("s_flow", "read", { filePath: path.join(repo, ".env") }), /secrets/)
  await before("s_flow", "write", { filePath: path.join(repo, "b.txt"), content: "x" })

  // compaction runs as an internal agent and must not switch the guard off
  await h.handlers.session.prompt({ sessionID: "s_flow", agent: "compaction" })
  await assert.rejects(before("s_flow", "shell", { command: "git clean -fdx" }), /Blocked/)

  await h.handlers.session["model.request"]({ sessionID: "s_plan", agent: "flow-plan" })
  await before("s_plan", "write", { filePath: path.join(repo, ".opencode/plans/x.md"), content: "# plan" })
  await assert.rejects(before("s_plan", "write", { filePath: path.join(repo, "src/x.ts"), content: "x" }), /read-only/)

  await h.handlers.session["model.request"]({ sessionID: "s_review", agent: "flow-review" })
  await assert.rejects(before("s_review", "edit", { filePath: path.join(repo, "a.txt"), oldString: "a", newString: "b" }), /read-only/)

  const event = {
    sessionID: "s_flow", tool: "edit", status: "completed",
    input: { filePath: path.join(repo, "src/x.ts"), oldString: "a", newString: "el.innerHTML = q" },
    result: { content: [{ type: "text", text: "Edit applied" }] },
  }
  await h.handlers.tool["execute.after"](event)
  assert.equal(event.result.content.length, 2)
  assert.match(event.result.content[1].text, /\[flow-guard\] Check .*XSS/)

  const clean = { ...event, input: { ...event.input, newString: "const x = 1" }, result: { content: [{ type: "text", text: "ok" }] } }
  await h.handlers.tool["execute.after"](clean)
  assert.equal(clean.result.content.length, 1)

  cleanup()
  assert.equal(h.handlers.tool["execute.before"], undefined)
})

test("read before edit: unread or changed files need a read, new files and deletes do not", () => {
  const file = path.join(repo, "a.txt")
  const stamp = fileStamp(file)
  assert.match(staleEditReason(file, undefined), /has not been read/)
  assert.equal(staleEditReason(file, stamp), null)
  assert.match(staleEditReason(file, "0:0"), /changed since you last read/)
  assert.equal(staleEditReason(path.join(repo, "new.txt"), undefined), null)
  assert.equal(fileStamp(repo), null)
  const patch = "*** Begin Patch\n*** Add File: n.txt\n+x\n*** Update File: a.txt\n-a\n+b\n*** Delete File: d.txt\n*** End Patch"
  assert.deepEqual(inPlaceTargets("apply_patch", { patchText: patch }), ["a.txt"])
  assert.deepEqual(inPlaceTargets("edit", { filePath: "a.txt" }), ["a.txt"])
})

test("plugin: an edit needs a fresh read in the same session; its own edits stay fresh", async () => {
  const dir = mkRepo()
  const file = path.join(dir, "a.txt")
  const h = makeContext(dir)
  const cleanup = await plugin.setup(h.ctx)
  const before = (sessionID, tool, input) => h.handlers.tool["execute.before"]({ sessionID, tool, input })
  const after = (sessionID, tool, input) => h.handlers.tool["execute.after"]({ sessionID, tool, input, status: "completed", result: { content: [] } })
  const edit = { filePath: file, oldString: "a", newString: "b" }

  await h.handlers.session["model.request"]({ sessionID: "s1", agent: "flow-build" })
  await h.handlers.session["model.request"]({ sessionID: "s2", agent: "flow-build" })
  await assert.rejects(before("s1", "edit", edit), /has not been read/)
  await assert.rejects(before("s1", "write", { filePath: file, content: "x" }), /has not been read/)
  await before("s1", "write", { filePath: path.join(dir, "fresh.txt"), content: "x" })

  await after("s1", "read", { filePath: "a.txt" })
  await before("s1", "edit", edit)
  await assert.rejects(before("s2", "edit", edit), /has not been read/)

  fs.writeFileSync(file, "b\n")
  await after("s1", "edit", edit)
  await before("s1", "edit", { ...edit, oldString: "b", newString: "c" })

  fs.writeFileSync(file, "changed by a formatter\n")
  await assert.rejects(before("s1", "edit", edit), /changed since you last read/)
  cleanup()
})

test("plugin: OPENCODE_FLOW_GUARD=off disables every hook", async () => {
  const h = makeContext(repo)
  await plugin.setup(h.ctx, { disabled: true })
  assert.equal(h.handlers.tool["execute.before"], undefined)
})
