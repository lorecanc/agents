import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { tempDir, writePack } from "../../test/helpers.js"
import { addSource, discoverPacks, loadSources, pullSource, removeSource, saveSources, sourceRevision, type SourceRegistry } from "./sources.js"

const emptyRegistry = (): SourceRegistry => ({ schemaVersion: 1, sources: [], prefer: {} })
const envFor = (t: test.TestContext) => {
  const base = tempDir(t)
  return { XDG_CONFIG_HOME: path.join(base, "config"), XDG_CACHE_HOME: path.join(base, "cache") }
}

test("registry: add, save, load and remove sources; preferences follow removals", (t) => {
  const env = envFor(t)
  const dir = tempDir(t)
  const registry = emptyRegistry()
  addSource(registry, "catalog", dir, { trusted: true })
  addSource(registry, "remote", "https://example.com/agents.git", { ref: "v2" })
  registry.prefer.flow = "remote"
  saveSources(registry, env)

  const file = path.join(env.XDG_CONFIG_HOME, "manage-agents", "sources.json")
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  const loaded = loadSources(env)
  assert.deepEqual(loaded.sources.map(source => [source.name, source.kind, source.trusted]), [["catalog", "local", true], ["remote", "git", false]])
  assert.equal(loaded.sources[0].kind === "local" && loaded.sources[0].path, fs.realpathSync(dir))

  removeSource(loaded, "remote")
  assert.deepEqual(loaded.prefer, {})
})

test("registry: rejects bad names, duplicates, unsupported URLs, file: URLs and refs on local sources", (t) => {
  const registry = emptyRegistry()
  const dir = tempDir(t)
  addSource(registry, "ok", dir)

  assert.throws(() => addSource(registry, "../escape", dir), /invalid source name/)
  assert.throws(() => addSource(registry, "ok", dir), /already exists/)
  assert.throws(() => addSource(registry, "ftp", "ftp://example.com/x"), /unsupported source URL/)
  assert.throws(() => addSource(registry, "file", "file:///tmp/repo"), /unsupported source URL/)
  assert.throws(() => addSource(registry, "dash", "git@host:-oProxyCommand=x"), /unsupported source URL|not a directory/)
  assert.throws(() => addSource(registry, "badref", "https://example.com/x.git", { ref: "--upload-pack=x" }), /invalid git ref/)
  assert.throws(() => addSource(registry, "localref", dir, { ref: "main" }), /only to git sources/)
  assert.throws(() => addSource(registry, "missing", path.join(dir, "nope")), /not a directory/)
  assert.throws(() => addSource(registry, "token", "https://user:secret@example.com/x.git"), /credentials in source URLs/)
  assert.throws(() => addSource(registry, "token2", "https://ghp_token@example.com/x.git"), /credentials in source URLs/)
  assert.doesNotThrow(() => addSource(registry, "ssh", "ssh://git@example.com/x.git"))
})

test("registry: hand-edited entries are validated on load, so a name cannot escape the cache", (t) => {
  const env = envFor(t)
  const file = path.join(env.XDG_CONFIG_HOME, "manage-agents", "sources.json")
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, sources: [{ name: "../../outside", kind: "git", url: "https://example.com/x.git", trusted: false }] }))
  assert.throws(() => loadSources(env), /invalid source entry/)

  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, sources: [], prefer: { flow: "ghost" } }))
  assert.throws(() => loadSources(env), /invalid "prefer" map/)
})

test("discovery: finds packs, does not descend into a pack, reports broken manifests and unpulled git sources", (t) => {
  const env = envFor(t)
  const root = tempDir(t)
  writePack(path.join(root, "packs", "flow"), {}, { name: "flow" })
  writePack(path.join(root, "packs", "flow", "nested"), {}, { name: "nested" })
  writePack(path.join(root, "packs", "broken"), {}, { name: "Bad Name" })
  writePack(path.join(root, "node_modules", "x"), {}, { name: "hidden" })
  const registry = emptyRegistry()
  const local = addSource(registry, "local", root)
  const remote = addSource(registry, "remote", "https://example.com/x.git")

  const found = discoverPacks(local, env)
  assert.deepEqual(found.candidates.map(candidate => `${candidate.relativeDir} ${candidate.manifest.name}`), ["packs/flow flow"])
  assert.equal(found.problems.length, 1)
  assert.match(found.problems[0], /packs\/broken/)
  assert.match(discoverPacks(remote, env).problems[0], /has not been pulled yet/)
})

const hasGit = spawnSync("git", ["--version"]).status === 0

function gitIn(cwd: string, ...args: string[]) {
  const result = spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { cwd, encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

test("git sources: clone, follow a moving branch, pin a tag, reject unknown refs", { skip: !hasGit }, (t) => {
  const env = envFor(t)
  const work = tempDir(t)
  gitIn(work, "init", "--quiet", "--initial-branch=main")
  writePack(path.join(work, "packs", "flow"), {}, { name: "flow", version: "1.0.0" })
  gitIn(work, "add", "-A")
  gitIn(work, "commit", "--quiet", "-m", "v1")
  gitIn(work, "tag", "v1")
  const first = gitIn(work, "rev-parse", "HEAD")

  const registry = emptyRegistry()
  const url = `file://${work}`
  const branch = addSource(registry, "branch", url, { ref: "main" }, { allowFileUrls: true })
  const tag = addSource(registry, "tag", url, { ref: "v1" }, { allowFileUrls: true })
  const missing = addSource(registry, "missing", url, { ref: "nope" }, { allowFileUrls: true })

  assert.equal(pullSource(branch, env, { allowFileUrls: true }), first)
  assert.equal(sourceRevision(branch, env), first)
  assert.equal(discoverPacks(branch, env).candidates[0].manifest.version, "1.0.0")

  writePack(path.join(work, "packs", "flow"), {}, { name: "flow", version: "1.1.0" })
  gitIn(work, "commit", "--quiet", "-am", "v1.1")
  const second = gitIn(work, "rev-parse", "HEAD")
  assert.equal(pullSource(branch, env, { allowFileUrls: true }), second)
  assert.equal(discoverPacks(branch, env).candidates[0].manifest.version, "1.1.0")

  assert.equal(pullSource(tag, env, { allowFileUrls: true }), first)
  assert.throws(() => pullSource(missing, env, { allowFileUrls: true }), /ref "nope" not found/)
  assert.throws(() => pullSource(branch, env), /refusing git URL/)

  const other = tempDir(t)
  gitIn(other, "init", "--quiet", "--initial-branch=main")
  writePack(path.join(other, "packs", "other"), {}, { name: "other" })
  gitIn(other, "add", "-A")
  gitIn(other, "commit", "--quiet", "-m", "other")
  removeSource(registry, "branch")
  const readded = addSource(registry, "branch", `file://${other}`, { ref: "main" }, { allowFileUrls: true })
  assert.equal(pullSource(readded, env, { allowFileUrls: true }), gitIn(other, "rev-parse", "HEAD"))
  assert.deepEqual(discoverPacks(readded, env).candidates.map(candidate => candidate.manifest.name), ["other"])
})
