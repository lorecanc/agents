import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { tempDir, writePack } from "../../test/helpers.js"
import { applyPlan, changeTarget, installChange, planReconcile, readInstalled, reconcileChange, restoreBackup, rollbackInterrupted, targetStatus, uninstallChange, updateChange, withTargetLock, type ChangeOptions } from "./installer.js"
import { readLock } from "./lock.js"
import { addSource, pullSource, type SourceRegistry } from "./sources.js"

const BASE = {
  "tools/base/repo.js": "export const repo = 1\n",
  "plugins/guard/index.ts": `import { repo } from "../../tools/base/repo.js"\nexport default repo\n`,
  "AGENTS.md": "# base\n",
  "skills/base-hello/SKILL.md": "---\ndescription: hello\n---\nhi\n",
  "skills/base-hello/scripts/run.sh": "#!/bin/sh\necho hi\n",
  "opencode.json": JSON.stringify({ mcp: { servers: { db: { type: "local", command: ["db-mcp"] } } }, instructions: ["resources/base/rules.md"] }),
  "resources/base/rules.md": "rules\n",
}
const FLOW = {
  "agents/flow-build.md": "---\nmode: primary\n---\nbuild\n",
  "agents/flow-scout.md": "---\nmode: subagent\n---\nscout\n",
  "commands/flow-go.md": "go\n",
  "opencode.json": JSON.stringify({ plugins: [{ package: "./plugins/guard", options: { strict: true } }] }),
}

function setup(t: test.TestContext, overrides: { flow?: Record<string, string>; trusted?: boolean } = {}) {
  const base = tempDir(t)
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(base, "config"), XDG_CACHE_HOME: path.join(base, "cache") }
  const source = path.join(base, "catalog")
  writePack(path.join(source, "base"), BASE, { name: "base", version: "1.0.0" })
  writePack(path.join(source, "flow"), overrides.flow ?? FLOW, { name: "flow", version: "2.0.0", requires: { base: "^1.0.0" } })
  writePack(path.join(source, "app"), { "agents/app.md": "app\n" }, { name: "app", requires: { base: "^1.0.0" } })
  fs.chmodSync(path.join(source, "base", "skills/base-hello/scripts/run.sh"), 0o755)
  const registry: SourceRegistry = { schemaVersion: 1, sources: [], prefer: {} }
  addSource(registry, "main", source, { trusted: overrides.trusted ?? true })
  const target = path.join(base, "opencode target")
  fs.mkdirSync(target)
  const options: ChangeOptions = { env, confirm: async () => true }
  const install = (names: string[], extra: Partial<ChangeOptions> = {}) => changeTarget(target, "install", registry, installChange(registry, names, env), { ...options, ...extra })
  return { base, env, source, registry, target, options, install }
}

/** Every file under dir (state and transaction dirs excluded) with its sha256; absolute target paths normalized. */
function snapshot(dir: string, ignoreState = true): Record<string, string> {
  const out: Record<string, string> = {}
  const visit = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      const rel = path.relative(dir, full).split(path.sep).join("/")
      if (ignoreState && rel === ".manage-agents") continue
      if (entry.isDirectory()) visit(full)
      else out[rel] = crypto.createHash("sha256").update(fs.readFileSync(full, "utf8").split(dir).join("<target>")).digest("hex")
    }
  }
  visit(dir)
  return out
}

const config = (target: string) => JSON.parse(fs.readFileSync(path.join(target, "opencode.json"), "utf8"))

test("install: root with dependency, rewritten config, state files, exec bits", async (t) => {
  const { target, install } = setup(t)
  const result = await install(["flow"])

  assert.equal(result.status, "applied", JSON.stringify(result.plan?.conflicts ?? result.change?.problems))
  assert.ok(fs.existsSync(path.join(target, "agents/flow-build.md")))
  assert.ok(fs.existsSync(path.join(target, "tools/base/repo.js")))
  assert.equal(fs.readFileSync(path.join(target, "instructions/base.md"), "utf8"), "# base\n")
  assert.ok(!fs.existsSync(path.join(target, "opencode-pack.json")))
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(target, "skills/base-hello/scripts/run.sh")).mode & 0o111, 0o111)
  assert.deepEqual(config(target), {
    $schema: "https://opencode.ai/config.json",
    plugins: [{ package: "./plugins/guard", options: { strict: true } }],
    instructions: [path.join(target, "resources", "base", "rules.md"), path.join(target, "instructions", "base.md")],
    mcp: { servers: { db: { type: "local", command: ["db-mcp"] } } },
  })
  assert.deepEqual(Object.keys(readLock(target)!.packs), ["base", "flow"])
  assert.equal(readInstalled(target).files["tools/base/repo.js"].owner, "base")
  assert.ok(!fs.existsSync(path.join(target, ".manage-agents", "journal.json")))
  assert.ok(!fs.existsSync(path.join(target, ".manage-agents", "install.lock")))
})

test("determinism: the same desired state and lock give the same tree on two clean targets; reruns change nothing", async (t) => {
  const first = setup(t)
  await first.install(["flow"])
  const second = path.join(first.base, "second target")
  fs.mkdirSync(second)
  fs.mkdirSync(path.join(second, ".manage-agents"))
  for (const file of ["desired.json", "lock.json"]) fs.copyFileSync(path.join(first.target, ".manage-agents", file), path.join(second, ".manage-agents", file))
  const result = await changeTarget(second, "reconcile", first.registry, reconcileChange, first.options)

  assert.equal(result.status, "applied")
  assert.deepEqual(snapshot(second), snapshot(first.target))
  assert.equal((await changeTarget(first.target, "reconcile", first.registry, reconcileChange, first.options)).status, "unchanged")
  assert.equal((await first.install(["flow"])).status, "unchanged")
})

test("user config is preserved; a JSONC file with comments is backed up with a warning", async (t) => {
  const { target, install } = setup(t)
  fs.writeFileSync(path.join(target, "opencode.jsonc"), `{\n  // mine\n  "model": "x/y",\n  "plugins": ["my-npm-plugin"],\n}\n`)
  const result = await install(["flow"])

  assert.equal(result.status, "applied")
  const next = JSON.parse(fs.readFileSync(path.join(target, "opencode.jsonc"), "utf8"))
  assert.equal(next.model, "x/y")
  assert.deepEqual(next.plugins, ["my-npm-plugin", { package: "./plugins/guard", options: { strict: true } }])
  assert.ok(result.plan!.warnings.some(warning => /comments/.test(warning)))
  assert.match(fs.readFileSync(path.join(target, ".manage-agents", "backups", result.backupId!, "files", "opencode.jsonc"), "utf8"), /\/\/ mine/)
})

test("unmanaged collisions block before any write; --adopt backs up, restore puts it back", async (t) => {
  const { target, install, options } = setup(t)
  fs.mkdirSync(path.join(target, "agents"))
  fs.writeFileSync(path.join(target, "agents/flow-build.md"), "mine\n")
  fs.writeFileSync(path.join(target, "opencode.json"), JSON.stringify({ mcp: { servers: { db: { type: "remote", url: "https://mine" } } } }))
  const before = snapshot(target, false)

  const blocked = await install(["flow"])
  assert.equal(blocked.status, "failed")
  assert.deepEqual(blocked.plan!.conflicts.map(conflict => conflict.split(" ")[0]).sort(), ["agents/flow-build.md", "opencode.json:"])
  assert.deepEqual(snapshot(target, false), before)

  const adopted = await install(["flow"], { adopt: true })
  assert.equal(adopted.status, "applied")
  assert.equal(fs.readFileSync(path.join(target, "agents/flow-build.md"), "utf8"), FLOW["agents/flow-build.md"])
  assert.equal(config(target).mcp.servers.db.type, "local")

  await restoreBackup(target, adopted.backupId!)
  assert.equal(fs.readFileSync(path.join(target, "agents/flow-build.md"), "utf8"), "mine\n")
  assert.deepEqual(config(target).mcp.servers.db, { type: "remote", url: "https://mine" })
  assert.equal(readInstalled(target).files["agents/flow-build.md"], undefined)
  assert.ok(targetStatus(target, setup(t).registry, options.env).drift.length > 0)
})

test("locally changed managed files: update conflicts without --adopt, uninstall leaves them in place unmanaged", async (t) => {
  const { target, source, install, registry, options } = setup(t)
  await install(["flow"])
  fs.writeFileSync(path.join(target, "agents/flow-scout.md"), "edited by me\n")
  assert.ok(targetStatus(target, registry, options.env).drift.some(line => line.startsWith("agents/flow-scout.md was changed locally")))

  fs.writeFileSync(path.join(source, "flow", "agents/flow-scout.md"), "---\nmode: subagent\n---\nnew scout\n")
  const update = await changeTarget(target, "update", registry, updateChange(registry, ["flow"], options.env), options)
  assert.equal(update.status, "failed")
  assert.match(update.plan!.conflicts[0], /agents\/flow-scout\.md was changed locally; rerun with --adopt/)

  const removed = await changeTarget(target, "uninstall", registry, uninstallChange(["flow"]), options)
  assert.equal(removed.status, "applied")
  assert.equal(fs.readFileSync(path.join(target, "agents/flow-scout.md"), "utf8"), "edited by me\n")
  assert.ok(!fs.existsSync(path.join(target, "agents/flow-build.md")))
  assert.ok(!fs.existsSync(path.join(target, "tools")), "empty directories are removed")
  assert.deepEqual(config(target), { $schema: "https://opencode.ai/config.json" })
})

test("uninstall keeps a dependency still required and refuses to remove it directly", async (t) => {
  const { target, install, registry, options } = setup(t)
  await install(["flow", "app"])

  const direct = await changeTarget(target, "uninstall", registry, uninstallChange(["base"]), options)
  assert.deepEqual(direct.change!.problems, ["base is installed as a dependency of app, flow; uninstall that instead"])

  assert.equal((await changeTarget(target, "uninstall", registry, uninstallChange(["flow"]), options)).status, "applied")
  assert.deepEqual(Object.keys(readLock(target)!.packs), ["app", "base"])
  assert.ok(fs.existsSync(path.join(target, "tools/base/repo.js")))
})

test("local source edits: reconcile refuses until update, install keeps other packs pinned", async (t) => {
  const { target, source, install, registry, options } = setup(t)
  await install(["flow"])
  writePack(path.join(source, "base"), { ...BASE, "resources/base/rules.md": "new rules\n" }, { name: "base", version: "1.1.0" })

  const reconcile = await changeTarget(target, "reconcile", registry, reconcileChange, options)
  assert.match(reconcile.plan!.conflicts[0], /base: the source changed since the lock; run `manage-agents update base`/)

  const install2 = await install(["app"])
  assert.match(install2.change!.problems[0], /pack "base" is locked at main@1\.0\.0/)

  const update = await changeTarget(target, "update", registry, updateChange(registry, [], options.env), options)
  assert.equal(update.status, "applied")
  assert.deepEqual(update.changes.map(change => `${change.kind} ${change.name}`), ["upgrade base"])
  assert.equal(fs.readFileSync(path.join(target, "resources/base/rules.md"), "utf8"), "new rules\n")
})

test("confirmation: untrusted executable content is declined without writing; accepted once, not asked again", async (t) => {
  const { target, install, registry, options } = setup(t, { trusted: false })
  const asked: string[][] = []
  const declined = await install(["flow"], { confirm: async reasons => { asked.push(reasons); return false } })

  assert.equal(declined.status, "declined")
  assert.ok(asked[0].some(reason => /base: source "main" is not trusted/.test(reason)))
  assert.deepEqual(fs.readdirSync(target).filter(name => name !== ".manage-agents"), [])

  assert.equal((await install(["flow"])).status, "applied")
  const reconcile = await changeTarget(target, "reconcile", registry, reconcileChange, { ...options, confirm: async () => assert.fail("must not ask again") })
  assert.equal(reconcile.status, "unchanged")
})

test("legacy export files and plugin entries are replaced without --adopt", async (t) => {
  const { target, install } = setup(t)
  fs.mkdirSync(path.join(target, "agents"))
  fs.writeFileSync(path.join(target, "agents/flow-build.md"), "old export\n")
  fs.writeFileSync(path.join(target, ".resource-export-manifest.json"), JSON.stringify({ owner: "manage-agents", version: 1, resources: ["agents/flow-build.md", "plugins/guard/index.ts"] }))
  fs.writeFileSync(path.join(target, "opencode.json"), JSON.stringify({ plugins: ["./plugins/guard", "./plugins/other"] }))
  const result = await install(["flow"])

  assert.equal(result.status, "applied", JSON.stringify(result.plan?.conflicts))
  assert.deepEqual(config(target).plugins, ["./plugins/other", { package: "./plugins/guard", options: { strict: true } }])
})

test("interrupted apply rolls back to the exact previous tree", async (t) => {
  const { target, source, install, registry, options } = setup(t)
  await install(["flow"])
  writePack(path.join(source, "flow"), { ...FLOW, "agents/flow-scout.md": "---\nmode: subagent\n---\nv2\n", "commands/flow-new.md": "new\n" }, { name: "flow", version: "2.1.0", requires: { base: "^1.0.0" } })
  const before = snapshot(target, false)
  const rename = fs.renameSync
  let calls = 0
  t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (++calls === 4) throw new Error("disk full")
    return rename(from, to)
  })

  await assert.rejects(changeTarget(target, "update", registry, updateChange(registry, ["flow"], options.env), options), /disk full/)
  t.mock.restoreAll()
  assert.deepEqual(snapshot(target, false), before)
})

test("a crash mid-transaction is rolled back by the next operation", (t) => {
  const target = tempDir(t)
  const txn = path.join(target, ".manage-agents", "txn", "crash")
  fs.mkdirSync(path.join(txn, "prev"), { recursive: true })
  fs.writeFileSync(path.join(txn, "prev", "a.md"), "old a\n")
  fs.writeFileSync(path.join(target, "a.md"), "new a\n")
  fs.writeFileSync(path.join(target, "b.md"), "new b\n")
  fs.writeFileSync(path.join(target, "c.md"), "untouched c\n")
  fs.writeFileSync(path.join(target, "d.md"), "user file that appeared\n")
  const sha = (text: string) => crypto.createHash("sha256").update(text).digest("hex")
  fs.writeFileSync(path.join(target, ".manage-agents", "journal.json"), JSON.stringify({ id: "crash", ops: [
    { rel: "a.md", existed: true, hash: sha("new a\n") },
    { rel: "b.md", existed: false, hash: sha("new b\n") },
    { rel: "c.md", existed: true },
    { rel: "d.md", existed: false, hash: sha("what the transaction would have written\n") },
  ] }))

  assert.equal(rollbackInterrupted(target), true)
  assert.equal(fs.readFileSync(path.join(target, "a.md"), "utf8"), "old a\n")
  assert.ok(!fs.existsSync(path.join(target, "b.md")))
  assert.equal(fs.readFileSync(path.join(target, "c.md"), "utf8"), "untouched c\n")
  assert.equal(fs.readFileSync(path.join(target, "d.md"), "utf8"), "user file that appeared\n", "only bytes the transaction wrote are removed")
  assert.ok(!fs.existsSync(txn))

  fs.writeFileSync(path.join(target, ".manage-agents", "journal.json"), JSON.stringify({ id: "x", ops: [{ rel: "../escape", existed: false }] }))
  assert.throws(() => rollbackInterrupted(target), /damaged/)
})

test("target lock: a live holder blocks, a dead or unreadable one is reclaimed", async (t) => {
  const target = tempDir(t)
  const file = path.join(target, ".manage-agents", "install.lock")
  fs.mkdirSync(path.dirname(file))
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, host: os.hostname(), command: "install", started: "now" }))
  await assert.rejects(withTargetLock(target, "test", () => 1), /locked by install \(pid/)

  fs.writeFileSync(file, JSON.stringify({ pid: 2 ** 22 + 12345, host: os.hostname(), command: "install", started: "then" }))
  assert.equal(await withTargetLock(target, "test", () => 7), 7)
  assert.ok(!fs.existsSync(file))

  fs.writeFileSync(file, JSON.stringify({ pid: 1, host: "other-host", command: "install", started: "now" }))
  await assert.rejects(withTargetLock(target, "test", () => 1), /other-host/)

  fs.writeFileSync(file, "{broken")
  fs.utimesSync(file, new Date(0), new Date(0))
  assert.equal(await withTargetLock(target, "test", () => 3), 3)
})

test("conflicting packs: the same agent ID from two packs blocks the install", async (t) => {
  const { source, install, registry } = setup(t)
  writePack(path.join(source, "clone"), { "agents/flow-build.md": "other\n" }, { name: "clone" })
  const result = await install(["flow", "clone"])

  assert.equal(result.status, "failed")
  assert.match(result.plan!.conflicts.join("\n"), /agent "flow-build" is provided by both (clone and flow|flow and clone)/)
  assert.equal(registry.sources.length, 1)
})

test("a target reached through a symlink installs into the real directory", { skip: process.platform === "win32" }, async (t) => {
  const { base, registry, options, target } = setup(t)
  const link = path.join(base, "link")
  fs.symlinkSync(target, link)
  const real = fs.realpathSync(link)
  const result = await changeTarget(real, "install", registry, installChange(registry, ["flow"], options.env), options)

  assert.equal(result.status, "applied")
  assert.ok(fs.existsSync(path.join(target, "agents/flow-build.md")))
  assert.ok(config(target).instructions.every((entry: string) => entry.startsWith(fs.realpathSync(target))))
})

test("identical content the user already had stays theirs and survives uninstall", async (t) => {
  const { target, install, registry, options } = setup(t)
  fs.mkdirSync(path.join(target, "commands"))
  fs.writeFileSync(path.join(target, "commands/flow-go.md"), FLOW["commands/flow-go.md"])
  fs.writeFileSync(path.join(target, "opencode.json"), JSON.stringify({ mcp: { servers: { db: { type: "local", command: ["db-mcp"] } } } }))
  assert.equal((await install(["flow"])).status, "applied")
  assert.equal(readInstalled(target).files["commands/flow-go.md"], undefined)

  assert.equal((await changeTarget(target, "uninstall", registry, uninstallChange(["flow"]), options)).status, "applied")
  assert.ok(fs.existsSync(path.join(target, "commands/flow-go.md")))
  assert.deepEqual(config(target).mcp.servers.db, { type: "local", command: ["db-mcp"] })
})

test("uninstall drops the config sections it emptied but keeps the user's empty ones", async (t) => {
  const { target, install, registry, options } = setup(t)
  fs.writeFileSync(path.join(target, "opencode.json"), JSON.stringify({ model: "a/b", lsp: {} }))
  assert.equal((await install(["flow"])).status, "applied")
  assert.ok(config(target).mcp.servers.db)

  assert.equal((await changeTarget(target, "uninstall", registry, uninstallChange(["flow"]), options)).status, "applied")
  assert.deepEqual(config(target), { model: "a/b", lsp: {} })
})

test("an empty section the user wrote stays after a pack filled it and was uninstalled", async (t) => {
  const { target, install, registry, options } = setup(t)
  fs.writeFileSync(path.join(target, "opencode.json"), JSON.stringify({ mcp: { servers: {} } }))
  assert.equal((await install(["flow"])).status, "applied")
  assert.ok(config(target).mcp.servers.db)

  assert.equal((await changeTarget(target, "uninstall", registry, uninstallChange(["flow"]), options)).status, "applied")
  assert.deepEqual(config(target), { mcp: { servers: {} } })
})

test("a manifest-only change in a local source is caught as a change since the lock", async (t) => {
  const { target, source, install, registry, options } = setup(t)
  await install(["flow"])
  const manifest = path.join(source, "flow", "opencode-pack.json")
  fs.writeFileSync(manifest, JSON.stringify({ ...JSON.parse(fs.readFileSync(manifest, "utf8")), description: "changed" }))

  const reconcile = await changeTarget(target, "reconcile", registry, reconcileChange, options)
  assert.match(reconcile.plan!.conflicts[0], /flow: the source changed since the lock/)
})

test("the target changing between planning and apply aborts without writing", async (t) => {
  const { target, install } = setup(t)
  const raced = await install(["flow"], {
    confirm: async () => {
      fs.mkdirSync(path.join(target, "agents"), { recursive: true })
      fs.writeFileSync(path.join(target, "agents/flow-build.md"), "typed while the prompt was open\n")
      return true
    },
  }).catch((error: Error) => error)

  assert.ok(raced instanceof Error && /agents\/flow-build\.md changed while installing/.test(raced.message), String(raced))
  assert.equal(fs.readFileSync(path.join(target, "agents/flow-build.md"), "utf8"), "typed while the prompt was open\n")
  assert.ok(!fs.existsSync(path.join(target, "commands")))
  assert.ok(!fs.existsSync(path.join(target, ".manage-agents", "txn")) || !fs.readdirSync(path.join(target, ".manage-agents", "txn")).length)
})

test("a symlinked opencode.json is reported, never replaced", { skip: process.platform === "win32" }, async (t) => {
  const { base, target, install } = setup(t)
  const dotfile = path.join(base, "dotfiles.json")
  fs.writeFileSync(dotfile, "{}")
  fs.symlinkSync(dotfile, path.join(target, "opencode.json"))
  const result = await install(["flow"])

  assert.equal(result.status, "failed")
  assert.match(result.plan!.conflicts.join("\n"), /opencode\.json is a symlink/)
  assert.ok(fs.lstatSync(path.join(target, "opencode.json")).isSymbolicLink())
})

test("restore recreates an adopted symlink as a link", { skip: process.platform === "win32" }, async (t) => {
  const { target, install } = setup(t)
  fs.mkdirSync(path.join(target, "agents"))
  fs.symlinkSync("../elsewhere/flow-build.md", path.join(target, "agents/flow-build.md"))
  const adopted = await install(["flow"], { adopt: true })
  assert.equal(adopted.status, "applied")

  await restoreBackup(target, adopted.backupId!)
  assert.equal(fs.readlinkSync(path.join(target, "agents/flow-build.md")), "../elsewhere/flow-build.md")
})

test("config keys named __proto__ are kept as plain entries", async (t) => {
  const { target, install } = setup(t, { flow: { ...FLOW, "opencode.json": `{"plugins":[{"package":"./plugins/guard","options":{"strict":true}}],"agents":{"__proto__":{"mode":"primary"}}}` } })
  const result = await install(["flow"])

  assert.equal(result.status, "applied", JSON.stringify(result.plan?.conflicts))
  const written = JSON.parse(fs.readFileSync(path.join(target, "opencode.json"), "utf8"))
  assert.ok(Object.hasOwn(written.agents, "__proto__"))
  assert.deepEqual(written.agents["__proto__"], { mode: "primary" })
})

test("planReconcile writes nothing", (t) => {
  const { target, registry, options } = setup(t)
  const before = snapshot(target, false)
  planReconcile(target, { lockVersion: 1, contract: "1.0", roots: [], packs: {} }, registry, options)
  assert.deepEqual(snapshot(target, false), before)
  assert.throws(() => applyPlan({ ...planReconcile(target, { lockVersion: 1, contract: "1.0", roots: [], packs: {} }, registry, options), conflicts: ["x"] }, { desired: { desiredVersion: 1, roots: [] }, lock: { lockVersion: 1, contract: "1.0", roots: [], packs: {} } }), /refusing/)
})

const hasGit = spawnSync("git", ["--version"]).status === 0
function gitIn(cwd: string, ...args: string[]) {
  const result = spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

test("git sources: reconcile installs the locked revision after a pull; update moves to the new one", { skip: !hasGit }, async (t) => {
  const base = tempDir(t)
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(base, "config"), XDG_CACHE_HOME: path.join(base, "cache") }
  const repo = path.join(base, "repo")
  fs.mkdirSync(repo)
  gitIn(repo, "init", "--quiet", "--initial-branch=main")
  writePack(path.join(repo, "packs", "notes"), { "agents/notes.md": "v1\n" }, { name: "notes", version: "1.0.0" })
  gitIn(repo, "add", "-A")
  gitIn(repo, "commit", "--quiet", "-m", "v1")
  const registry: SourceRegistry = { schemaVersion: 1, sources: [], prefer: {} }
  const source = addSource(registry, "remote", `file://${repo}`, { ref: "main", trusted: true }, { allowFileUrls: true })
  pullSource(source, env, { allowFileUrls: true })
  const target = path.join(base, "target")
  const options: ChangeOptions = { env, confirm: async () => true }
  assert.equal((await changeTarget(target, "install", registry, installChange(registry, ["notes"], env), options)).status, "applied")

  writePack(path.join(repo, "packs", "notes"), { "agents/notes.md": "v2\n" }, { name: "notes", version: "1.1.0" })
  gitIn(repo, "commit", "--quiet", "-am", "v2")
  pullSource(source, env, { allowFileUrls: true })
  fs.rmSync(path.join(target, "agents", "notes.md"))

  assert.equal((await changeTarget(target, "reconcile", registry, reconcileChange, options)).status, "applied")
  assert.equal(fs.readFileSync(path.join(target, "agents/notes.md"), "utf8"), "v1\n")
  assert.ok(targetStatus(target, registry, env).drift.some(line => /source remote is checked out at/.test(line)))

  const update = await changeTarget(target, "update", registry, updateChange(registry, ["notes"], env, { allowFileUrls: true }), options)
  assert.equal(update.status, "applied")
  assert.equal(fs.readFileSync(path.join(target, "agents/notes.md"), "utf8"), "v2\n")
  assert.deepEqual(targetStatus(target, registry, env).drift, [])
})
