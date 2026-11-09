import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { buildCategoryDistribution, buildAllCategoryDistributions, checkCategoryDistribution, loadCategoryManifest, packageCategoryDistributions, parseCategoryArgs, recoverBuildAllCategoryDistributions, validateCategoryManifest, validateCategoryPackage, listBundleFiles, pruneGeneratedBundle, extraGeneratedBundleFiles } from "./categoryDistribution.js"
import { refreshStampedPipelinesFromSource, syncPipelineProfile } from "./pipelineProfiles.js"
import { findAgentFiles, organizeAgents } from "./agents.js"
import { execFileSync } from "node:child_process"
import crypto from "node:crypto"

const repo = path.resolve(import.meta.dirname, "../../..")
const sourceFiles = ["src/AGENTS.md", "src/agents/wiki-analyzer.md", "src/agents/wiki-indexer.md", "src/agents/wiki-orchestrator.md", "src/agents/wiki-updater.md", "src/agents/wiki-writer.md", "src/commands/wiki.md", "src/skills/wiki-conventions/SKILL.md", "src/skills/wiki-navigate/SKILL.md", "src/skills/wiki-templates/SKILL.md", "src/skills/italiano-decente/SKILL.md", "src/skills/seo-copywriting/SKILL.md"]

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "category-distribution-"))
  fs.mkdirSync(path.join(root, "agents", ".agent-manager", "categories"), { recursive: true })
  fs.mkdirSync(path.join(root, "agents", "src"), { recursive: true })
  fs.mkdirSync(path.join(root, "agents", "export"), { recursive: true })
  for (const file of sourceFiles) {
    const destination = path.join(root, "agents", file)
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.copyFileSync(path.join(repo, file), destination)
  }
  fs.copyFileSync(path.join(repo, ".agent-manager/categories/wiki.json"), path.join(root, "agents/.agent-manager/categories/wiki.json"))
  return root
}

function output(root: string) { return path.join(root, "agents/export/categories/wiki") }

function regularFiles(current: string, logical = ""): string[] {
  const files: string[] = []
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const name = logical ? `${logical}/${entry.name}` : entry.name
    const fullPath = path.join(current, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`Refusing symbolic link at ${name}`)
    if (entry.isDirectory()) files.push(...regularFiles(fullPath, name))
    else if (entry.isFile()) files.push(name)
    else throw new Error(`Refusing non-regular entry at ${name}`)
  }
  return files.sort()
}

test("regularFiles fails closed for symlinks without reading their targets", () => {
  if (process.platform === "win32") return
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "category-regular-files-"))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "category-regular-files-outside-"))
  try {
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret\n")
    fs.symlinkSync(outside, path.join(root, "linked"), "dir")
    assert.throws(() => regularFiles(root), /symbolic link/i)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  }
})

test("manifest is the source of truth and the Wiki distribution is complete", () => {
  const root = fixture()
  const manifest = loadCategoryManifest(root, "wiki")
  assert.equal(manifest.resources.length, 12)
  const result = buildCategoryDistribution(root, "wiki")
  assert.equal(result.status, "current")
  const readme = fs.readFileSync(path.join(output(root), "README.md"), "utf8")
  assert.match(readme, /agents\/\.agent-manager\/categories\/wiki\.json/)
  assert.match(readme, /Do not edit this directory directly/)
  const expected = ["AGENTS.md", "CATEGORY.json", "LICENSE", "PROVENANCE.json", "README.md", ...manifest.resources.map(r => r.target), ...manifest.generated.map(g => g.target)]
  assert.deepEqual(regularFiles(output(root)), [...new Set(expected)].sort())
})

test("generated category config uses the V2 MCP shape and omits plugins when none ship", () => {
  const root = fixture()
  buildCategoryDistribution(root, "wiki")
  const config = JSON.parse(fs.readFileSync(path.join(output(root), "opencode.json"), "utf8"))
  assert.deepEqual(config, {
    mcp: { servers: { "codebase-memory-mcp": { type: "local", command: ["codebase-memory-mcp"], codemode: false } } }
  })
})

test("generated category config lists shipped plugin directories relative to itself", () => {
  const root = fixture()
  const manifestPath = path.join(root, "agents/.agent-manager/categories/wiki.json")
  const pluginDir = path.join(root, "agents/src/tools/wiki-plugin")
  fs.mkdirSync(pluginDir, { recursive: true })
  fs.writeFileSync(path.join(pluginDir, "index.ts"), "export {}\n")
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
  manifest.resources.push({ kind: "directory", source: "src/tools/wiki-plugin", target: "plugins/wiki-plugin", policy: "text", primary: true })
  fs.writeFileSync(manifestPath, JSON.stringify(manifest))

  buildCategoryDistribution(root, "wiki")

  const config = JSON.parse(fs.readFileSync(path.join(output(root), "opencode.json"), "utf8"))
  assert.deepEqual(config.plugins, ["./plugins/wiki-plugin"])
  assert.equal(config.mcp.servers["codebase-memory-mcp"].codemode, false)
})

test("category README escapes adversarial text and inline paths deterministically", () => {
  const root = fixture(), manifestPath = path.join(root, "agents/.agent-manager/categories/wiki.json")
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
  manifest.title = "Title <script>\n# link [x](javascript:bad) `code`"
  manifest.description = "Description **bold** & <tag>\nsecond line"
  manifest.resources[0].source = "general/AGENTS.md"
  manifest.resources[0].target = "safe`-target [x]"
  fs.writeFileSync(manifestPath, JSON.stringify(manifest))
  buildCategoryDistribution(root, "wiki")
  const readme = fs.readFileSync(path.join(output(root), "README.md"), "utf8")
  assert.doesNotMatch(readme, /<script>|<tag>|\n# link/)
  assert.match(readme, /Title.*script.*link/)
  assert.match(readme, /`general\/AGENTS\.md` → ``safe`-target \[x\]``/)
  assert.match(readme, /Title.*\\`code\\`/)
  assert.equal(readme.includes("\nsecond line"), false)
})

for (const id of ["wiki", "docs", "slides"]) {
  test(`generated README inventory is sourced from the ${id} manifest`, () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(repo, `.agent-manager/categories/${id}.json`), "utf8"))
    const readme = fs.readFileSync(path.join(repo, manifest.output, "README.md"), "utf8")
    for (const resource of manifest.resources) assert.ok(readme.includes(`- \`${resource.source}\` → \`${resource.target}\``))
  })
}

test("build normalizes source CRLF and preserves deterministic output", () => {
  const root = fixture(), source = path.join(root, "agents/src/AGENTS.md")
  fs.writeFileSync(source, fs.readFileSync(source, "utf8").replace(/\n/g, "\r\n"))
  buildCategoryDistribution(root, "wiki")
  const first = fs.readFileSync(output(root) + "/AGENTS.md")
  assert.equal(first.includes(Buffer.from("\r")), false)
  assert.equal(first[first.length - 1], 10)
  const provenance = JSON.parse(fs.readFileSync(output(root) + "/PROVENANCE.json", "utf8"))
  assert.equal(provenance.manifestHash, JSON.parse(fs.readFileSync(output(root) + "/CATEGORY.json", "utf8")).manifestHash)
  assert.equal(checkCategoryDistribution(root, "wiki").status, "current")
})

test("check is read-only and reports missing, changed, and extra files", () => {
  const root = fixture(); buildCategoryDistribution(root, "wiki")
  const dir = output(root)
  fs.unlinkSync(path.join(dir, "README.md")); fs.writeFileSync(path.join(dir, "AGENTS.md"), "changed\n"); fs.writeFileSync(path.join(dir, "stale.txt"), "stale\n")
  const before = fs.readdirSync(dir, { recursive: true }).map(String).sort()
  const result = checkCategoryDistribution(root, "wiki")
  assert.equal(result.status, "stale"); assert.ok(result.missing.includes("README.md")); assert.ok(result.changed.includes("AGENTS.md")); assert.deepEqual(result.extra, ["stale.txt"])
  assert.deepEqual(fs.readdirSync(dir, { recursive: true }).map(String).sort(), before)
})

test("check reports relative tool imports and opencodePath assets missing from the manifest", (t) => {
  const root = fixture(), workspace = path.join(root, "agents"), tools = path.join(workspace, "src", "tools")
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(tools, { recursive: true })
  fs.writeFileSync(path.join(tools, "checker.ts"), 'import "./_helper.js"\nopencodePath("_asset.css")\nopencodePath("./missing.css")\nopencodePath("nested", "missing.css")\n')
  const manifestPath = path.join(workspace, ".agent-manager/categories/wiki.json")
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
  manifest.resources.push({ kind: "file", source: "src/tools/checker.ts", target: "tools/checker.ts", policy: "text" })
  fs.writeFileSync(manifestPath, JSON.stringify(manifest))

  buildCategoryDistribution(root, "wiki")
  const manifestBefore = fs.readFileSync(manifestPath)
  const before = snapshot(output(root))
  const result = checkCategoryDistribution(root, "wiki")

  assert.equal(result.status, "stale")
  assert.ok(result.missing.includes("tools/_helper.ts"))
  assert.ok(result.missing.includes("tools/_asset.css"))
  assert.ok(result.missing.includes("tools/missing.css"))
  assert.ok(result.missing.includes("tools/nested/missing.css"))
  assert.deepEqual(fs.readFileSync(manifestPath), manifestBefore)
  assert.deepEqual(snapshot(output(root)), before)
})

test("build reconciles dependencies from listed tools without importing unlisted tools", (t) => {
  const root = fixture(), workspace = path.join(root, "agents"), tools = path.join(workspace, "src", "tools")
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(tools, { recursive: true })
  fs.writeFileSync(path.join(tools, "checker.ts"), 'import "./_auto_helper.js"\nopencodePath("_auto_theme.css")\n')
  fs.writeFileSync(path.join(tools, "_auto_helper.js"), "export {}\n")
  fs.writeFileSync(path.join(tools, "_auto_theme.css"), "body {}\n")
  fs.writeFileSync(path.join(tools, "unlisted.ts"), 'import "./_unlisted_helper.js"\n')
  fs.writeFileSync(path.join(tools, "_unlisted_helper.js"), "export {}\n")
  const manifestPath = path.join(workspace, ".agent-manager/categories/wiki.json")
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
  manifest.resources.push({ kind: "file", source: "src/tools/checker.ts", target: "tools/checker.ts", policy: "text" })
  fs.writeFileSync(manifestPath, JSON.stringify(manifest))

  buildCategoryDistribution(root, "wiki")

  const updatedManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
  const dependencyTargets = updatedManifest.resources.map((resource: { target: string }) => resource.target)
  assert.ok(dependencyTargets.includes("tools/_auto_helper.js"))
  assert.ok(dependencyTargets.includes("tools/_auto_theme.css"))
  assert.equal(dependencyTargets.includes("tools/_unlisted_helper.js"), false)
  assert.ok(fs.existsSync(path.join(output(root), "tools/_auto_helper.js")))
  assert.ok(fs.existsSync(path.join(output(root), "tools/_auto_theme.css")))
})

test("all-category build reconciles listed tool dependencies before staging", (t) => {
  const root = fixture(), workspace = path.join(root, "agents"), tools = path.join(workspace, "src", "tools")
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(tools, { recursive: true })
  fs.writeFileSync(path.join(tools, "checker.ts"), 'import "./_auto_helper.js"\nopencodePath("_auto_theme.css")\n')
  fs.writeFileSync(path.join(tools, "_auto_helper.js"), "export {}\n")
  fs.writeFileSync(path.join(tools, "_auto_theme.css"), "body {}\n")
  const manifestPath = path.join(workspace, ".agent-manager/categories/wiki.json")
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
  manifest.resources.push({ kind: "file", source: "src/tools/checker.ts", target: "tools/checker.ts", policy: "text" })
  fs.writeFileSync(manifestPath, JSON.stringify(manifest))

  const results = buildAllCategoryDistributions(root)

  const updatedManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
  const dependencyTargets = updatedManifest.resources.map((resource: { target: string }) => resource.target)
  assert.ok(dependencyTargets.includes("tools/_auto_helper.js"))
  assert.ok(dependencyTargets.includes("tools/_auto_theme.css"))
  assert.ok(fs.existsSync(path.join(output(root), "tools/_auto_helper.js")))
  assert.ok(fs.existsSync(path.join(output(root), "tools/_auto_theme.css")))
  assert.deepEqual(results.map(result => result.status), ["current"])
  assert.equal(checkCategoryDistribution(root, "wiki").status, "current")
  assert.equal(fs.existsSync(path.join(workspace, ".agent-manager/category-control/build-all.journal")), false)
})

test("check reports CRLF category output as stale and changed", () => {
  const root = fixture()
  try {
    buildCategoryDistribution(root, "wiki")
    const file = path.join(output(root), "AGENTS.md")
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/\n/g, "\r\n"))
    const result = checkCategoryDistribution(root, "wiki")
    assert.equal(result.status, "stale")
    assert.deepEqual(result.changed, ["AGENTS.md"])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test("binary and mixed manifest resources remain byte-exact", () => {
  const root = fixture(), workspace = path.join(root, "agents"), manifestPath = path.join(workspace, ".agent-manager/categories/wiki.json")
  try {
    const binary = Buffer.from([0, 255, 13, 10, 128, 42]), mixedBinary = Buffer.from([255, 0, 1, 13, 10])
    fs.mkdirSync(path.join(workspace, "src/tools/mixed"), { recursive: true })
    fs.writeFileSync(path.join(workspace, "src/tools/payload.bin"), binary)
    fs.writeFileSync(path.join(workspace, "src/tools/mixed/data.bin"), mixedBinary)
    fs.writeFileSync(path.join(workspace, "src/tools/mixed/readme.md"), "mixed\r\ntext\r\n")
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    manifest.resources.push(
      { kind: "file", source: "src/tools/payload.bin", target: "tools/payload.bin", policy: "binary" },
      { kind: "directory", source: "src/tools/mixed", target: "tools/mixed", policy: "mixed", extensions: [".md"] },
    )
    fs.writeFileSync(manifestPath, JSON.stringify(manifest))
    buildCategoryDistribution(root, "wiki")
    assert.deepEqual(fs.readFileSync(path.join(output(root), "tools/payload.bin")), binary)
    assert.deepEqual(fs.readFileSync(path.join(output(root), "tools/mixed/data.bin")), mixedBinary)
    assert.deepEqual(fs.readFileSync(path.join(output(root), "tools/mixed/readme.md")), Buffer.from("mixed\ntext\n"))
    const mutated = Buffer.from(fs.readFileSync(path.join(output(root), "tools/payload.bin")))
    mutated[0] ^= 1
    fs.writeFileSync(path.join(output(root), "tools/payload.bin"), mutated)
    const result = checkCategoryDistribution(root, "wiki")
    assert.equal(result.status, "stale")
    assert.ok(result.changed.includes("tools/payload.bin"))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test("manifest rejects unsafe paths, forbidden generated inputs, collisions, and unknown schema fields", () => {
  const base = JSON.parse(fs.readFileSync(path.join(repo, ".agent-manager/categories/wiki.json"), "utf8"))
  for (const mutate of [
    (m: any) => { m.extra = true },
    (m: any) => { m.resources[0].source = "../secret" },
    (m: any) => { m.resources[0].source = "categories/wiki/AGENTS.md" },
    (m: any) => { m.resources[0].source = "wiki-generator/agents/foo.md" },
    (m: any) => { m.resources[0].target = "/tmp/out" },
    (m: any) => { m.resources.push({ ...m.resources[0], source: m.resources[1].source, target: "other" }) },
    (m: any) => { m.resources[0].target = "agents"; m.resources[1].target = "agents/x" },
    (m: any) => { m.generated[0].id = "unknown" },
  ]) { const m = structuredClone(base); mutate(m); assert.throws(() => validateCategoryManifest(m, repo), /Invalid category distribution/) }
})

test("manifest accepts plugin sources under src/ and general/ but rejects sources outside the allowlist", () => {
  const root = fixture(), workspace = path.join(root, "agents")
  try {
    const manifestPath = path.join(workspace, ".agent-manager/categories/wiki.json")
    const base = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    for (const prefix of ["src", "general"]) {
      fs.mkdirSync(path.join(workspace, prefix, "plugins/wiki-plugin"), { recursive: true })
      fs.writeFileSync(path.join(workspace, prefix, "plugins/wiki-plugin/index.ts"), "export {}\n")
      const manifest = structuredClone(base)
      manifest.resources.push({ kind: "directory", source: `${prefix}/plugins/wiki-plugin`, target: `plugins/${prefix}-wiki-plugin`, policy: "text" })
      assert.doesNotThrow(() => validateCategoryManifest(manifest, workspace))
    }
    for (const source of ["plugins/wiki-plugin", "dist/plugins/wiki-plugin"]) {
      const manifest = structuredClone(base)
      manifest.resources.push({ kind: "directory", source, target: "plugins/wiki-plugin", policy: "text" })
      assert.throws(() => validateCategoryManifest(manifest, workspace), /outside the canonical allowlist/)
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test("validateCategoryManifest rejects file targets and index-less directories under plugins/", (t) => {
  const root = fixture(), workspace = path.join(root, "agents")
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const manifest = loadCategoryManifest(root, "wiki")
  fs.mkdirSync(path.join(workspace, "src", "plugins", "empty-dir"), { recursive: true })
  fs.mkdirSync(path.join(workspace, "src", "plugins"), { recursive: true })
  fs.writeFileSync(path.join(workspace, "src", "plugins", "bad.js"), "export default 1\n")

  const resources = [
    { kind: "file", source: "src/plugins/bad.js", target: "plugins/bad.js", policy: "text" },
    { kind: "directory", source: "src/plugins/empty-dir", target: "plugins/empty-dir", policy: "text" }
  ] as const
  const rejected = resources.map(resource => {
    const candidate = structuredClone(manifest)
    candidate.resources.push(resource)
    try {
      validateCategoryManifest(candidate, workspace)
      return false
    } catch (error) {
      return /Invalid category distribution/.test(error instanceof Error ? error.message : String(error))
    }
  })
  assert.deepEqual(rejected, [true, true])
})

test("a second manifest category build preserves mtimeMs on unchanged files", (t) => {
  const root = fixture()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  buildCategoryDistribution(root, "wiki")
  const directory = output(root)
  const files = listBundleFiles(directory)
  const backdated = new Date(1_600_000_000_000)
  for (const file of files) {
    const absolute = path.join(directory, file)
    fs.utimesSync(absolute, backdated, backdated)
  }

  buildCategoryDistribution(root, "wiki")

  for (const file of files) {
    assert.equal(fs.statSync(path.join(directory, file)).mtimeMs, backdated.getTime(), `${file} mtime should be preserved`)
  }
})

test("manifest rejects every generator-reserved target, case-insensitively", () => {
  const base = JSON.parse(fs.readFileSync(path.join(repo, ".agent-manager/categories/wiki.json"), "utf8"))
  for (const reserved of ["LICENSE", "license", "README.md", "readme.MD", "CATEGORY.json", "category.JSON", "PROVENANCE.json", "provenance.JSON"]) {
    const manifest = structuredClone(base); manifest.resources[0].target = reserved
    assert.throws(() => validateCategoryManifest(manifest, repo), /reserved/i)
  }
})

test("manifest relative paths accept portable names and reject unsafe lexical forms", () => {
  const base = JSON.parse(fs.readFileSync(path.join(repo, ".agent-manager/categories/wiki.json"), "utf8"))
  for (const target of ["a..b", " spaced/name", ".well-known/file", "目录/файл.md", "safe name/file.txt"]) {
    const manifest = structuredClone(base); manifest.resources[0].target = target
    assert.doesNotThrow(() => validateCategoryManifest(manifest, repo))
  }
  for (const target of ["", "a//b", "a/./b", "a/../b", "/absolute", "//server/share", "C:/file", "a:b", "a\\b", "a\n b", "a\u0000b", "a\u007fb", "name.", "name ", "CON.txt", "dir/PRN", "COM1.md", "LPT9.log", "a|b", "a?b", "a*b", "a< b", "a> b", "a\"b"]) {
    const manifest = structuredClone(base); manifest.resources[0].target = target
    assert.throws(() => validateCategoryManifest(manifest, repo), /Invalid category distribution/)
  }
})

test("all real category manifests validate", () => {
  for (const id of ["wiki", "docs", "slides"]) assert.doesNotThrow(() => loadCategoryManifest(repo, id))
})

test("organize fails closed for symlinked manager metadata without creating a backup", () => {
  if (process.platform === "win32") return
  const root = fixture(), workspace = path.join(root, "agents"), manager = path.join(workspace, ".agent-manager")
  const backupDir = path.join(workspace, "backups")
  fs.rmSync(manager, { recursive: true }); fs.symlinkSync(os.tmpdir(), manager, "dir")
  const agents = findAgentFiles(workspace, "src")
  assert.throws(() => organizeAgents(workspace, agents), /symlink/i)
  assert.equal(fs.existsSync(backupDir), false)
})

test("build rejects symlinked category parents and output trees", () => {
  if (process.platform === "win32") return
  const root = fixture(), agents = path.join(root, "agents")
  fs.symlinkSync(os.tmpdir(), path.join(agents, "export", "categories"), "dir")
  assert.throws(() => buildCategoryDistribution(root, "wiki"), /symlink/i)
})

test("failed publish restores the previous output and cleans staging", () => {
  const root = fixture(); buildCategoryDistribution(root, "wiki")
  const original = fs.readFileSync(path.join(output(root), "AGENTS.md"), "utf8")
  let calls = 0
  assert.throws(() => buildCategoryDistribution(root, "wiki", { rename: (from, to) => { if (++calls === 2) throw new Error("publish failed"); fs.renameSync(from, to) } }), /publish failed/)
  assert.equal(fs.readFileSync(path.join(output(root), "AGENTS.md"), "utf8"), original)
  assert.equal(fs.readdirSync(path.join(root, "agents/export/categories")).some(name => name.includes(".category-wiki-")), false)
})

test("CLI parser rejects removed source SHA flag", () => {
  assert.throws(() => parseCategoryArgs(["package", "wiki", "--source-sha", "0123456789abcdef0123456789abcdef01234567"]), /unexpected argument/)
})

test("CLI parser supports list/build/check/explain, alias flags, and rejects traversal", () => {
  assert.deepEqual(parseCategoryArgs(["list"]), { action: "list" })
  for (const action of ["build", "check", "explain"] as const) {
    const parsed = parseCategoryArgs([action, "wiki", "--no-auto-commit"])
    assert.equal(parsed.action, action)
    assert.equal(parsed.id, "wiki")
    assert.deepEqual(parsed.ids, ["wiki"])
    assert.equal(parsed.json, false)
    assert.equal(parsed.dryRun, false)
  }
  assert.throws(() => parseCategoryArgs(["build", "../wiki"]), /unsafe/)
  assert.throws(() => parseCategoryArgs(["list", "wiki"]), /takes no arguments/)
})

test("findAgentFiles fails closed for linked directories and files", () => {
  const root = fixture(), workspace = path.join(root, "agents")
  if (process.platform === "win32") return
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "agent-discovery-outside-"))
  fs.writeFileSync(path.join(outside, "outside.md"), "---\ncategory: outside\n---\n")
  fs.symlinkSync(outside, path.join(workspace, "src", "linked"), "dir")
  assert.throws(() => findAgentFiles(workspace, "src"), /symlink/i)
  fs.unlinkSync(path.join(workspace, "src", "linked"))
  fs.symlinkSync(path.join(workspace, "src"), path.join(workspace, "src", "linked"), "dir")
  assert.throws(() => findAgentFiles(workspace, "src/linked"), /source directory does not exist|symlink/i)
})

test("category build uses a per-category lock and releases it", () => {
  const root = fixture(); let acquired = false
  buildCategoryDistribution(root, "wiki", { onLockAcquired: () => { acquired = true; assert.equal(fs.existsSync(path.join(root, "agents/.agent-manager/category-wiki.lock")), true) } })
  assert.equal(acquired, true); assert.equal(fs.existsSync(path.join(root, "agents/.agent-manager/category-wiki.lock")), false)
})

test("canonical source edits make Wiki stale while mirror edits cannot become canonical", () => {
  const root = fixture(); buildCategoryDistribution(root, "wiki")
  fs.appendFileSync(path.join(root, "agents/export/categories/wiki/AGENTS.md"), "mirror-only\n")
  assert.equal(fs.readFileSync(path.join(root, "agents/src/AGENTS.md"), "utf8").includes("mirror-only"), false)
  assert.equal(checkCategoryDistribution(root, "wiki").status, "stale")
  buildCategoryDistribution(root, "wiki")
  fs.appendFileSync(path.join(root, "agents/src/AGENTS.md"), "canonical-change\n")
  assert.equal(checkCategoryDistribution(root, "wiki").status, "stale")
})

test("organize protects manifest-backed Wiki without backup, but organizes unmanifested categories", () => {
  const root = fixture(), workspace = path.join(root, "agents")
  const wikiAgents = findAgentFiles(workspace, "src")
  const before = wikiAgents.map(agent => [agent.currentPath, fs.readFileSync(agent.currentPath, "utf8")])
  const protectedResult = organizeAgents(workspace, wikiAgents)
  assert.equal(protectedResult.backupsPath, null); assert.equal(protectedResult.copied.length, 0)
  for (const [file, content] of before) assert.equal(fs.readFileSync(file, "utf8"), content)

  fs.rmSync(path.join(workspace, ".agent-manager/categories/wiki.json"))
  const unmanifested = findAgentFiles(workspace, "src")
  const result = organizeAgents(workspace, unmanifested)
  assert.ok(result.copied.length > 0)
  assert.ok(fs.existsSync(unmanifested[0].targetPath))
})

test("generated Wiki output has no nested Git metadata, host paths, or secret-shaped material", () => {
  const root = fixture(); buildCategoryDistribution(root, "wiki")
  const files = regularFiles(output(root))
  assert.equal(files.some(name => name.split("/").includes(".git")), false)
  for (const file of files) {
    const text = fs.readFileSync(path.join(output(root), file), "utf8")
    assert.doesNotMatch(text, /(?:\/Users\/|\/home\/|[A-Z]:\\Users\\|BEGIN (?:RSA|OPENSSH|EC) PRIVATE KEY|(?:api[_-]?key|secret|token)\s*[:=]\s*[^\s`]+)/i)
  }
})

test("deprecated topic-export alias does not create an old output", () => {
  const root = fixture()
  execFileSync(process.execPath, [path.join(repo, "manage-agents/manage-agents.mjs"), "topic-export", "--no-auto-commit"], { cwd: root, encoding: "utf8" })
  assert.equal(fs.existsSync(path.join(root, "agents/topic-export")), false)
  assert.equal(fs.existsSync(path.join(root, "agents/export/categories/wiki")), true)
})

test("package records byte hashes and removes stale files", () => {
  const root = fixture(); buildCategoryDistribution(root, "wiki"); fs.mkdirSync(path.join(root, "artifacts"), { recursive: true }); const artifact = path.join(root, "artifacts/categories")
  packageCategoryDistributions(root, ["wiki"], "artifacts/categories")
  const marker = validateCategoryPackage(artifact), entry = marker.entries.find(e => e.path === "wiki/AGENTS.md")!
  assert.deepEqual(Object.keys(marker).sort(), ["categories", "contentDigest", "entries", "kind", "packageVersion", "schema"])
  const hash = crypto.createHash("sha256").update(fs.readFileSync(path.join(artifact, entry.path))).digest("hex")
  assert.equal(entry.sha256, hash); fs.writeFileSync(path.join(artifact, "stale.txt"), "stale")
  assert.throws(() => validateCategoryPackage(artifact), /entries do not match/); packageCategoryDistributions(root, ["wiki"], "artifacts/categories")
  assert.equal(fs.existsSync(path.join(artifact, "stale.txt")), false)
})
test("recovery rejects v3 journals with migration guidance", () => {
  const root = fixture(), journal = path.join(root, "agents/.agent-manager/category-control/build-all.journal")
  fs.mkdirSync(path.dirname(journal), { recursive: true }); fs.writeFileSync(journal, JSON.stringify({ schemaVersion: 3 }))
  assert.throws(() => recoverBuildAllCategoryDistributions(root), /v3 journals are not migrated/); assert.equal(fs.existsSync(journal), true)
})

test("v4 recovery restores identical output after rename-before-journal crash", () => {
  const root = fixture(), original = path.join(output(root), "AGENTS.md")
  buildCategoryDistribution(root, "wiki")
  const before = fs.readFileSync(original, "utf8")
  assert.throws(() => buildAllCategoryDistributions(root, { onPhase: phase => { if (phase === "published-before-journal") throw new Error("crash") } }), /crash/)
  recoverBuildAllCategoryDistributions(root)
  assert.equal(fs.readFileSync(original, "utf8"), before)
  assert.equal(fs.existsSync(path.join(root, "agents/.agent-manager/category-control/build-all.journal")), false)
})

test("v4 recovery removes a newly published category when no original existed", () => {
  const root = fixture()
  assert.equal(fs.existsSync(output(root)), false)
  assert.throws(() => buildAllCategoryDistributions(root, { onPhase: phase => { if (phase === "published-before-journal") throw new Error("crash") } }), /crash/)
  assert.equal(fs.existsSync(output(root)), true)
  recoverBuildAllCategoryDistributions(root)
  assert.equal(fs.existsSync(output(root)), false)
  assert.equal(fs.existsSync(path.join(root, "agents/.agent-manager/category-control/build-all.journal")), false)
})

test("commit-intent recovery preserves verified new output", () => {
  const root = fixture(); buildCategoryDistribution(root, "wiki")
  assert.throws(() => buildAllCategoryDistributions(root, { onPhase: phase => { if (phase === "cleanup-old") throw new Error("crash after commit intent") } }), /crash after commit intent/)
  recoverBuildAllCategoryDistributions(root)
  assert.equal(checkCategoryDistribution(root, "wiki").status, "current")
})

test("v4 recovery fails without mutation for equal-hash backup, staged, and output", () => {
  const root = fixture(), control = path.join(root, "agents/.agent-manager/category-control"), txid = "0123456789abcdef0123456789abcdef", tx = path.join(control, "transactions", txid)
  fs.mkdirSync(path.join(root, "agents/export/categories/wiki"), { recursive: true }); fs.writeFileSync(path.join(root, "agents/export/categories/wiki/file"), "same")
  for (const slot of ["new", "old", "quarantine"]) fs.mkdirSync(path.join(tx, slot, "wiki"), { recursive: true })
  fs.writeFileSync(path.join(tx, "identity.json"), JSON.stringify({ schemaVersion: 4, txid }))
  for (const slot of ["new", "old"]) fs.writeFileSync(path.join(tx, slot, "wiki/file"), "same")
  const plans = { wiki: { oldHash: (null as string | null), newHash: "0".repeat(64), original: true } }
  fs.writeFileSync(path.join(control, "build-all.journal"), JSON.stringify({ schemaVersion: 4, state: "publish-intent", txid, ids: ["wiki"], categories: plans }))
  const before = fs.readFileSync(path.join(root, "agents/export/categories/wiki/file")); assert.throws(() => recoverBuildAllCategoryDistributions(root), /Invalid category build recovery state/); assert.deepEqual(fs.readFileSync(path.join(root, "agents/export/categories/wiki/file")), before)
})

test("v4 setup failures always release the build-all lock", () => {
  for (const phase of ["transaction-mkdir", "identity", "tree-hash", "journal"]) {
    const root = fixture()
    assert.throws(() => buildAllCategoryDistributions(root, { onPhase: actual => { if (actual === phase) throw new Error("setup failure") } }), /setup failure/)
    assert.equal(fs.existsSync(path.join(root, "agents/.agent-manager/category-control/build-all.lock")), false)
  }
})

test("v4 cleanup interruptions are recoverable and idempotent", () => {
  for (const phase of ["cleanup-old", "cleanup-new", "cleanup-quarantine", "cleanup-transaction", "cleanup-journal"]) {
    const root = fixture(); buildCategoryDistribution(root, "wiki")
    assert.throws(() => buildAllCategoryDistributions(root, { onPhase: actual => { if (actual === phase) throw new Error("cleanup failure") } }), /cleanup failure/)
    recoverBuildAllCategoryDistributions(root)
    assert.equal(fs.existsSync(path.join(root, "agents/.agent-manager/category-control/build-all.journal")), false)
    assert.equal(checkCategoryDistribution(root, "wiki").status, "current")
  }
})

test("build refuses an unresolved journal until explicit recovery", () => {
  const root = fixture(), journal = path.join(root, "agents/.agent-manager/category-control/build-all.journal")
  fs.mkdirSync(path.dirname(journal), { recursive: true })
  fs.writeFileSync(journal, "{}")
  assert.throws(() => buildAllCategoryDistributions(root), /recover explicitly/)
  assert.equal(fs.existsSync(journal), true)
})

function stampedFixture(): { root: string; bundle: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "category-stamped-"))
  fs.mkdirSync(path.join(root, "src", "agents"), { recursive: true })
  fs.mkdirSync(path.join(root, "src", "plugins", "pipeline-guard"), { recursive: true })
  fs.mkdirSync(path.join(root, "export"), { recursive: true })
  fs.mkdirSync(path.join(root, ".agent-manager"), { recursive: true })
  fs.writeFileSync(path.join(root, "src", "agents", "pipeline-orchestrator.md"), "---\ndescription: orchestrator\n---\n\nBody for orchestrator\n")
  fs.writeFileSync(path.join(root, "src", "agents", "pipeline-executor.md"), "---\ndescription: executor\n---\n\nBody for executor\n")
  fs.writeFileSync(path.join(root, "src", "plugins", "pipeline-guard", "index.ts"), "export {}\n")
  fs.writeFileSync(path.join(root, ".agent-manager", "companion-links.json"), JSON.stringify({
    version: 1,
    categories: {
      pipeline: { plugins: ["plugins/pipeline-guard"], commands: [], skills: [], tools: [] },
      "go-pipeline": { plugins: [], commands: [], skills: [], tools: [] }
    }
  }))
  syncPipelineProfile(root, "go", "go")
  return { root, bundle: path.join(root, "export", "categories", "go-pipeline") }
}

function stampedExpectedFiles(root: string, category: string): string[] {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "category-stamped-expected-"))
  try {
    for (const relative of [".agent-manager", "src"]) {
      const source = path.join(root, relative)
      if (fs.existsSync(source)) fs.cpSync(source, path.join(temporary, relative), { recursive: true })
    }
    const bundle = path.join(temporary, "export", "categories", category)
    fs.mkdirSync(path.join(bundle, "agents"), { recursive: true })
    refreshStampedPipelinesFromSource(temporary, category)
    return listBundleFiles(bundle)
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
}

function snapshot(directory: string): Map<string, { bytes: Buffer; mtimeMs: number }> {
  return new Map(listBundleFiles(directory).map(file => {
    const absolute = path.join(directory, file)
    return [file, { bytes: fs.readFileSync(absolute), mtimeMs: fs.statSync(absolute).mtimeMs }]
  }))
}

function buildStamped(root: string, bundle: string, category: string): void {
  refreshStampedPipelinesFromSource(root, category)
  pruneGeneratedBundle(bundle, stampedExpectedFiles(root, category))
}

test("build removes stale generated files from a stamped bundle", () => {
  const { root, bundle } = stampedFixture()
  const stale = path.join(bundle, "plugins", "pipeline-guard.js")
  fs.writeFileSync(stale, "export default { id: 'pipeline-guard', server }\n")
  assert.equal(fs.existsSync(stale), true)
  buildStamped(root, bundle, "go-pipeline")
  assert.equal(fs.existsSync(stale), false)
  assert.equal(fs.existsSync(path.join(bundle, "plugins", "pipeline-guard", "index.ts")), true)
})

test("a second stamped build is a byte-identical no-op without touching kept mtimes", () => {
  const { root, bundle } = stampedFixture()
  buildStamped(root, bundle, "go-pipeline")
  const first = snapshot(bundle)
  buildStamped(root, bundle, "go-pipeline")
  const second = snapshot(bundle)
  assert.deepEqual([...second.keys()], [...first.keys()])
  for (const [file, before] of first) {
    assert.deepEqual(second.get(file)!.bytes, before.bytes, `${file} bytes changed`)
    assert.equal(second.get(file)!.mtimeMs, before.mtimeMs, `${file} mtime changed`)
  }
})

test("check reports stale stamped files as extra without writing", () => {
  const { root, bundle } = stampedFixture()
  fs.writeFileSync(path.join(bundle, "plugins", "pipeline-guard.js"), "stale\n")
  const before = snapshot(bundle)
  assert.deepEqual(extraGeneratedBundleFiles(bundle, stampedExpectedFiles(root, "go-pipeline")), ["plugins/pipeline-guard.js"])
  const after = snapshot(bundle)
  assert.deepEqual([...after.keys()], [...before.keys()])
  for (const [file, value] of before) {
    assert.deepEqual(after.get(file)!.bytes, value.bytes)
    assert.equal(after.get(file)!.mtimeMs, value.mtimeMs)
  }
})

test("prune refuses symlinks inside a bundle without following or deleting them", () => {
  if (process.platform === "win32") return
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "category-prune-")), outside = fs.mkdtempSync(path.join(os.tmpdir(), "category-prune-outside-"))
  try {
    fs.mkdirSync(path.join(root, "plugins"))
    fs.writeFileSync(path.join(root, "plugins", "keep.ts"), "keep\n")
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret\n")
    fs.symlinkSync(outside, path.join(root, "plugins", "linked"), "dir")
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "plugins", "linked-file"), "file")
    assert.throws(() => pruneGeneratedBundle(root, ["plugins/keep.ts"]), /symlink/i)
    assert.equal(fs.readFileSync(path.join(outside, "secret.txt"), "utf8"), "secret\n")
    assert.equal(fs.readFileSync(path.join(root, "plugins", "keep.ts"), "utf8"), "keep\n")
    assert.equal(fs.lstatSync(path.join(root, "plugins", "linked")).isSymbolicLink(), true)
    assert.equal(fs.lstatSync(path.join(root, "plugins", "linked-file")).isSymbolicLink(), true)
    assert.throws(() => extraGeneratedBundleFiles(root, ["plugins/keep.ts"]), /unsafe output entry|symlink/i)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  }
})

test("prune validates the whole bundle before deleting a stale file that sorts before an unsafe entry", () => {
  if (process.platform === "win32") return
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "category-prune-validate-")), outside = fs.mkdtempSync(path.join(os.tmpdir(), "category-prune-validate-outside-"))
  try {
    fs.mkdirSync(path.join(root, "plugins"))
    fs.writeFileSync(path.join(root, "plugins", "aa-stale.ts"), "stale\n")
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret\n")
    fs.symlinkSync(outside, path.join(root, "plugins", "zz-linked"), "dir")
    assert.throws(() => pruneGeneratedBundle(root, []), /symlink/i)
    assert.equal(fs.readFileSync(path.join(root, "plugins", "aa-stale.ts"), "utf8"), "stale\n", "nothing may be deleted before validation completes")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  }
})

test("manifest build removes stale generated files", () => {
  const root = fixture()
  buildCategoryDistribution(root, "wiki")
  const stale = path.join(output(root), "legacy", "stale.txt")
  fs.mkdirSync(path.dirname(stale), { recursive: true })
  fs.writeFileSync(stale, "stale\n")
  buildCategoryDistribution(root, "wiki")
  assert.equal(fs.existsSync(path.join(output(root), "legacy")), false)
})
