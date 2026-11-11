import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { tempDir, writePack } from "../../test/helpers.js"
import { buildLock, confirmationsNeeded, diffLocks, readLock, serializeLock, writeLock, type PackLock } from "./lock.js"
import { parsePackRequest, resolvePacks } from "./resolver.js"
import { addSource, discoverAllPacks, type SourceRegistry } from "./sources.js"

type PackSpec = { manifest: Record<string, unknown>; files?: Record<string, string> }

/** One local source per entry: { sourceName: { packDir: spec } }. */
function catalog(t: test.TestContext, sources: Record<string, Record<string, PackSpec>>, trusted = true) {
  const registry: SourceRegistry = { schemaVersion: 1, sources: [], prefer: {} }
  for (const [name, packs] of Object.entries(sources)) {
    const root = tempDir(t)
    for (const [dir, spec] of Object.entries(packs)) writePack(path.join(root, dir), spec.files ?? {}, spec.manifest)
    addSource(registry, name, root, { trusted })
  }
  return { registry, candidates: discoverAllPacks(registry).candidates }
}

const requests = (...specs: string[]) => specs.map(parsePackRequest)

test("parsePackRequest accepts [source/]name[@range] and rejects anything else", () => {
  assert.deepEqual(parsePackRequest("official/flow@^2.0.0"), { name: "flow", source: "official", range: "^2.0.0" })
  assert.deepEqual(parsePackRequest("flow"), { name: "flow" })
  assert.throws(() => parsePackRequest("../flow"), /invalid pack request/)
  assert.throws(() => parsePackRequest("flow@not-a-range"), /invalid version range/)
})

test("resolves a root with its dependency, dependencies first", (t) => {
  const { candidates } = catalog(t, { main: {
    flow: { manifest: { name: "flow", version: "2.0.0", requires: { "dev-tools": "^2.0.0" } } },
    "dev-tools": { manifest: { name: "dev-tools", version: "2.1.0" } },
    unused: { manifest: { name: "unused" } },
  } })
  const resolution = resolvePacks(requests("flow"), candidates)

  assert.deepEqual(resolution.problems, [])
  assert.deepEqual(resolution.packs.map(pack => `${pack.name}@${pack.version}`), ["dev-tools@2.1.0", "flow@2.0.0"])
  assert.deepEqual(resolution.packs.map(pack => [pack.root, pack.requiredBy]), [[false, ["flow"]], [true, []]])
})

test("missing dependency, unsatisfiable range and cycles are problems", (t) => {
  const { candidates } = catalog(t, { main: {
    a: { manifest: { name: "a", requires: { ghost: "^1.0.0" } } },
    b: { manifest: { name: "b", requires: { c: "^2.0.0" } } },
    c: { manifest: { name: "c", version: "1.0.0" } },
    x: { manifest: { name: "x", requires: { y: "*" } } },
    y: { manifest: { name: "y", requires: { x: "*" } } },
  } })

  assert.match(resolvePacks(requests("a"), candidates).problems[0], /"ghost" is not offered by any source \(required by a\)/)
  assert.match(resolvePacks(requests("b"), candidates).problems[0], /no version of "c" satisfies \^2\.0\.0 \(b\); available: main\/c@1\.0\.0/)
  assert.ok(resolvePacks(requests("x"), candidates).problems.includes("dependency cycle: x -> y -> x"))
})

test("the same pack in two sources is ambiguous until the user picks a source or a preference", (t) => {
  const { candidates } = catalog(t, {
    official: { flow: { manifest: { name: "flow", version: "2.0.0" } } },
    fork: { flow: { manifest: { name: "flow", version: "2.5.0" } } },
  })

  assert.match(resolvePacks(requests("flow"), candidates).problems[0], /ambiguous.*request fork\/flow or official\/flow, or run `manage-agents source prefer flow <source>`/)
  assert.equal(resolvePacks(requests("official/flow"), candidates).packs[0].version, "2.0.0")
  assert.equal(resolvePacks(requests("flow"), candidates, { prefer: { flow: "fork" } }).packs[0].version, "2.5.0")
  assert.match(resolvePacks(requests("flow"), candidates, { prefer: { flow: "gone" } }).problems[0], /not offered by source "gone"/)
})

test("several versions in one source: ranges select, otherwise ambiguous (never the newest by default)", (t) => {
  const { candidates } = catalog(t, { main: {
    "flow-1": { manifest: { name: "flow", version: "1.4.0" } },
    "flow-2": { manifest: { name: "flow", version: "2.0.0" } },
    app: { manifest: { name: "app", requires: { flow: "^1.0.0" } } },
  } })

  assert.match(resolvePacks(requests("flow"), candidates).problems[0], /ambiguous.*narrow the version range/)
  assert.equal(resolvePacks(requests("flow@^2"), candidates).packs[0].version, "2.0.0")
  assert.deepEqual(resolvePacks(requests("app"), candidates).packs.map(pack => `${pack.name}@${pack.version}`), ["flow@1.4.0", "app@1.0.0"])
  assert.match(resolvePacks(requests("app", "flow@^2"), candidates).problems[0], /no version of "flow" satisfies \^2 \(request\) and \^1\.0\.0 \(app\)/)
})

test("references into another pack must be provided by a directly required pack", (t) => {
  const plugin = { "plugins/guard/index.ts": `import { repo } from "../../tools/base/repo.js"\nexport default 1` }
  const { candidates } = catalog(t, { main: {
    flow: { manifest: { name: "flow", requires: { base: "^1.0.0" } }, files: plugin },
    base: { manifest: { name: "base" }, files: { "tools/base/repo.ts": "export const repo = 1" } },
    lonely: { manifest: { name: "lonely", requires: { other: "^1.0.0" } }, files: plugin },
    other: { manifest: { name: "other" } },
  } })

  assert.deepEqual(resolvePacks(requests("flow"), candidates).problems, [])
  assert.match(resolvePacks(requests("lonely"), candidates).problems[0], /references import "tools\/base\/repo\.js", which no required pack \(other\) provides/)
})

test("contract violations in a selected pack fail the resolution", (t) => {
  const { candidates } = catalog(t, { main: { bad: { manifest: { name: "bad" }, files: { "notes.txt": "x" } } } })
  assert.match(resolvePacks(requests("bad"), candidates).problems[0], /main\/bad: \[root-file\] notes\.txt/)
})

test("lock: deterministic, round-trips, and diffs report every kind of change", (t) => {
  const make = (version: string, extra: Record<string, string> = {}) => catalog(t, { main: { flow: { manifest: { name: "flow", version }, files: { "agents/a.md": "x", ...extra } } } })
  const lockOf = (version: string, extra: Record<string, string> = {}) => buildLock(resolvePacks(requests("flow"), make(version, extra).candidates))
  const lock1 = lockOf("1.0.0")
  assert.equal(serializeLock(lock1), serializeLock(lockOf("1.0.0")))

  const target = tempDir(t)
  assert.equal(readLock(target), null)
  writeLock(target, lock1)
  assert.deepEqual(readLock(target), lock1)

  const kinds = (next: PackLock) => diffLocks(lock1, next).changes.map(change => change.kind)
  assert.deepEqual(kinds(lockOf("1.1.0")), ["upgrade"])
  assert.deepEqual(kinds(lockOf("0.9.0")), ["downgrade"])
  assert.deepEqual(kinds({ ...lock1, packs: { flow: { ...lock1.packs.flow, revision: "b".repeat(40) } } }), ["revision"])
  assert.deepEqual(kinds({ ...lock1, packs: { flow: { ...lock1.packs.flow, source: "fork" } } }), ["source"])
  assert.deepEqual(kinds(lockOf("1.0.0", { "README.md": "docs only" })), [], "root README is not installed")
  const plugin = lockOf("1.0.0", { "plugins/p/index.ts": "export default 1" })
  assert.deepEqual(kinds(plugin), ["content"])
  assert.deepEqual(diffLocks(lock1, plugin).executable, [{ name: "flow", added: ["plugin p"], removed: [], changed: true }])
  assert.deepEqual(diffLocks(null, lock1).changes, [{ name: "flow", kind: "added", to: "main@1.0.0" }])
  assert.deepEqual(diffLocks(lock1, { ...lock1, packs: {} }).changes, [{ name: "flow", kind: "removed", from: "main@1.0.0" }])
  assert.deepEqual(confirmationsNeeded(plugin, lock1), ["flow: new executable surface: plugin p"])

  const edited = lockOf("1.0.0", { "plugins/p/index.ts": "export default 2" })
  assert.deepEqual(confirmationsNeeded(edited, plugin), ["flow: executable code changed in: plugin p"])
})

test("MCP argv changes that render the same text still change the executable surface", (t) => {
  const lockFor = (command: string[]) => buildLock(resolvePacks(requests("flow"), catalog(t, { main: { flow: { manifest: { name: "flow" }, files: { "opencode.json": JSON.stringify({ mcp: { servers: { db: { type: "local", command } } } }) } } } }).candidates))
  const before = lockFor(["tool", "arg one"])
  const after = lockFor(["tool", "arg", "one"])

  assert.deepEqual(before.packs.flow.executable, after.packs.flow.executable)
  assert.deepEqual(confirmationsNeeded(after, before), ["flow: executable code changed in: external command tool; mcp db: tool arg one"])
})

test("lock: failed resolutions cannot be locked, malformed lock files are rejected", (t) => {
  const { candidates } = catalog(t, { main: { app: { manifest: { name: "app", requires: { ghost: "^1.0.0" } } } } })
  assert.throws(() => buildLock(resolvePacks(requests("app"), candidates)), /cannot lock a failed resolution/)

  const target = tempDir(t)
  const good = buildLock(resolvePacks(requests("flow"), catalog(t, { main: { flow: { manifest: { name: "flow" } } } }).candidates))
  writeLock(target, { ...good, packs: { flow: { ...good.packs.flow, version: "not-semver" } } })
  assert.throws(() => readLock(target), /pack "flow": invalid version/)
  writeLock(target, { ...good, packs: { "../x": good.packs.flow } })
  assert.throws(() => readLock(target), /invalid pack name/)
})

test("conflicting explicit sources and prereleases outside the range are rejected", (t) => {
  const { candidates } = catalog(t, {
    a: { flow: { manifest: { name: "flow", version: "1.1.0-beta.1" } } },
    b: { flow: { manifest: { name: "flow", version: "1.0.0" } } },
  })

  assert.match(resolvePacks(requests("a/flow", "b/flow"), candidates).problems[0], /requested from several sources \(a, b\)/)
  assert.match(resolvePacks(requests("a/flow@^1.0.0"), candidates).problems[0], /no version of "flow" satisfies \^1\.0\.0/)
  assert.equal(resolvePacks(requests("a/flow@^1.1.0-beta"), candidates).packs[0].version, "1.1.0-beta.1")
})

test("long dependency chains resolve", (t) => {
  const packs: Record<string, PackSpec> = {}
  for (let i = 0; i < 40; i++) packs[`p${i}`] = { manifest: { name: `p${i}`, ...(i < 39 ? { requires: { [`p${i + 1}`]: "^1.0.0" } } : {}) } }
  const resolution = resolvePacks(requests("p0"), catalog(t, { main: packs }).candidates)

  assert.deepEqual(resolution.problems, [])
  assert.equal(resolution.packs.length, 40)
  assert.equal(resolution.packs[0].name, "p39")
})

test("untrusted sources with executable content need confirmation", (t) => {
  const { candidates } = catalog(t, { main: { flow: { manifest: { name: "flow" }, files: { "plugins/p/index.ts": "export default 1" } } } }, false)
  const lock = buildLock(resolvePacks(requests("flow"), candidates))

  assert.deepEqual(confirmationsNeeded(lock, null), ['flow: source "main" is not trusted and the pack carries executable content', "flow: new executable surface: plugin p"])
  assert.deepEqual(confirmationsNeeded(lock, lock), [], "already accepted")
})
