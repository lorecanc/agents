import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { buildCategoryDistribution, buildAllCategoryDistributions, checkCategoryDistribution, loadCategoryManifest, packageCategoryDistributions, parseCategoryArgs, recoverBuildAllCategoryDistributions, validateCategoryManifest, validateCategoryPackage } from "./categoryDistribution.js"
import { findAgentFiles, organizeAgents } from "./agents.js"
import { execFileSync } from "node:child_process"
import crypto from "node:crypto"

const repo = path.resolve(process.cwd(), "..")
const sourceFiles = ["general/AGENTS.md", "general/agents/wiki-analyzer.md", "general/agents/wiki-indexer.md", "general/agents/wiki-orchestrator.md", "general/agents/wiki-updater.md", "general/agents/wiki-writer.md", "general/commands/wiki.md", "general/skills/wiki-conventions/SKILL.md", "general/skills/wiki-navigate/SKILL.md", "general/skills/wiki-templates/SKILL.md"]

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "category-distribution-"))
  fs.mkdirSync(path.join(root, "agents", ".agent-manager", "categories"), { recursive: true })
  fs.mkdirSync(path.join(root, "agents", "general"), { recursive: true })
  for (const file of sourceFiles) {
    const destination = path.join(root, "agents", file)
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.copyFileSync(path.join(repo, "agents", file), destination)
  }
  fs.copyFileSync(path.join(repo, "agents", ".agent-manager/categories/wiki.json"), path.join(root, "agents/.agent-manager/categories/wiki.json"))
  return root
}

function output(root: string) { return path.join(root, "agents/categories/wiki") }

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
  assert.equal(manifest.resources.length, 10)
  const result = buildCategoryDistribution(root, "wiki")
  assert.equal(result.status, "current")
  const readme = fs.readFileSync(path.join(output(root), "README.md"), "utf8")
  assert.match(readme, /agents\/\.agent-manager\/categories\/wiki\.json/)
  assert.match(readme, /Do not edit this directory directly/)
  const expected = ["AGENTS.md", "CATEGORY.json", "LICENSE", "PROVENANCE.json", "README.md", ...manifest.resources.map(r => r.target), ...manifest.generated.map(g => g.target)]
  assert.deepEqual(regularFiles(output(root)), [...new Set(expected)].sort())
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
    const manifest = JSON.parse(fs.readFileSync(path.join(repo, `agents/.agent-manager/categories/${id}.json`), "utf8"))
    const readme = fs.readFileSync(path.join(repo, "agents", manifest.output, "README.md"), "utf8")
    for (const resource of manifest.resources) assert.ok(readme.includes(`- \`${resource.source}\` → \`${resource.target}\``))
  })
}

test("build normalizes source CRLF and preserves deterministic output", () => {
  const root = fixture(), source = path.join(root, "agents/general/AGENTS.md")
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

test("manifest rejects unsafe paths, forbidden generated inputs, collisions, and unknown schema fields", () => {
  const base = JSON.parse(fs.readFileSync(path.join(repo, "agents/.agent-manager/categories/wiki.json"), "utf8"))
  for (const mutate of [
    (m: any) => { m.extra = true },
    (m: any) => { m.resources[0].source = "../secret" },
    (m: any) => { m.resources[0].source = "categories/wiki/AGENTS.md" },
    (m: any) => { m.resources[0].source = "wiki-generator/agents/foo.md" },
    (m: any) => { m.resources[0].target = "/tmp/out" },
    (m: any) => { m.resources.push({ ...m.resources[0], source: m.resources[1].source, target: "other" }) },
    (m: any) => { m.resources[0].target = "agents"; m.resources[1].target = "agents/x" },
    (m: any) => { m.generated[0].id = "unknown" },
  ]) { const m = structuredClone(base); mutate(m); assert.throws(() => validateCategoryManifest(m, path.join(repo, "agents")), /Invalid category distribution/) }
})

test("manifest rejects every generator-reserved target, case-insensitively", () => {
  const base = JSON.parse(fs.readFileSync(path.join(repo, "agents/.agent-manager/categories/wiki.json"), "utf8"))
  for (const reserved of ["LICENSE", "license", "README.md", "readme.MD", "CATEGORY.json", "category.JSON", "PROVENANCE.json", "provenance.JSON"]) {
    const manifest = structuredClone(base); manifest.resources[0].target = reserved
    assert.throws(() => validateCategoryManifest(manifest, path.join(repo, "agents")), /reserved/i)
  }
})

test("manifest relative paths accept portable names and reject unsafe lexical forms", () => {
  const base = JSON.parse(fs.readFileSync(path.join(repo, "agents/.agent-manager/categories/wiki.json"), "utf8"))
  for (const target of ["a..b", " spaced/name", ".well-known/file", "目录/файл.md", "safe name/file.txt"]) {
    const manifest = structuredClone(base); manifest.resources[0].target = target
    assert.doesNotThrow(() => validateCategoryManifest(manifest, path.join(repo, "agents")))
  }
  for (const target of ["", "a//b", "a/./b", "a/../b", "/absolute", "//server/share", "C:/file", "a:b", "a\\b", "a\n b", "a\u0000b", "a\u007fb", "name.", "name ", "CON.txt", "dir/PRN", "COM1.md", "LPT9.log", "a|b", "a?b", "a*b", "a< b", "a> b", "a\"b"]) {
    const manifest = structuredClone(base); manifest.resources[0].target = target
    assert.throws(() => validateCategoryManifest(manifest, path.join(repo, "agents")), /Invalid category distribution/)
  }
})

test("all real category manifests validate", () => {
  for (const id of ["wiki", "docs", "slides"]) assert.doesNotThrow(() => loadCategoryManifest(repo, id))
})

test("organize fails closed for symlinked manager metadata without creating a backup", () => {
  const root = fixture(), workspace = path.join(root, "agents"), manager = path.join(workspace, ".agent-manager")
  const backupDir = path.join(workspace, "backups")
  fs.rmSync(manager, { recursive: true }); fs.symlinkSync(os.tmpdir(), manager, "dir")
  const agents = findAgentFiles(workspace, "general")
  assert.throws(() => organizeAgents(workspace, agents), /symlink/i)
  assert.equal(fs.existsSync(backupDir), false)
})

test("build rejects symlinked category parents and output trees", () => {
  const root = fixture(), agents = path.join(root, "agents")
  fs.symlinkSync(os.tmpdir(), path.join(agents, "categories"), "dir")
  assert.throws(() => buildCategoryDistribution(root, "wiki"), /symlink/i)
})

test("failed publish restores the previous output and cleans staging", () => {
  const root = fixture(); buildCategoryDistribution(root, "wiki")
  const original = fs.readFileSync(path.join(output(root), "AGENTS.md"), "utf8")
  let calls = 0
  assert.throws(() => buildCategoryDistribution(root, "wiki", { rename: (from, to) => { if (++calls === 2) throw new Error("publish failed"); fs.renameSync(from, to) } }), /publish failed/)
  assert.equal(fs.readFileSync(path.join(output(root), "AGENTS.md"), "utf8"), original)
  assert.equal(fs.readdirSync(path.join(root, "agents/categories")).some(name => name.includes(".category-wiki-")), false)
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
  fs.symlinkSync(outside, path.join(workspace, "general", "linked"), "dir")
  assert.throws(() => findAgentFiles(workspace, "general"), /symlink/i)
  fs.unlinkSync(path.join(workspace, "general", "linked"))
  fs.symlinkSync(path.join(workspace, "general"), path.join(workspace, "general", "linked"), "dir")
  assert.throws(() => findAgentFiles(workspace, "general/linked"), /source directory does not exist|symlink/i)
})

test("category build uses a per-category lock and releases it", () => {
  const root = fixture(); let acquired = false
  buildCategoryDistribution(root, "wiki", { onLockAcquired: () => { acquired = true; assert.equal(fs.existsSync(path.join(root, "agents/.agent-manager/category-wiki.lock")), true) } })
  assert.equal(acquired, true); assert.equal(fs.existsSync(path.join(root, "agents/.agent-manager/category-wiki.lock")), false)
})

test("canonical source edits make Wiki stale while mirror edits cannot become canonical", () => {
  const root = fixture(); buildCategoryDistribution(root, "wiki")
  fs.appendFileSync(path.join(root, "agents/categories/wiki/AGENTS.md"), "mirror-only\n")
  assert.equal(fs.readFileSync(path.join(root, "agents/general/AGENTS.md"), "utf8").includes("mirror-only"), false)
  assert.equal(checkCategoryDistribution(root, "wiki").status, "stale")
  buildCategoryDistribution(root, "wiki")
  fs.appendFileSync(path.join(root, "agents/general/AGENTS.md"), "canonical-change\n")
  assert.equal(checkCategoryDistribution(root, "wiki").status, "stale")
})

test("organize protects manifest-backed Wiki without backup, but organizes unmanifested categories", () => {
  const root = fixture(), workspace = path.join(root, "agents")
  const wikiAgents = findAgentFiles(workspace, "general")
  const before = wikiAgents.map(agent => [agent.currentPath, fs.readFileSync(agent.currentPath, "utf8")])
  const protectedResult = organizeAgents(workspace, wikiAgents)
  assert.equal(protectedResult.backupsPath, null); assert.equal(protectedResult.copied.length, 0)
  for (const [file, content] of before) assert.equal(fs.readFileSync(file, "utf8"), content)

  fs.rmSync(path.join(workspace, ".agent-manager/categories/wiki.json"))
  const unmanifested = findAgentFiles(workspace, "general")
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
  assert.equal(fs.existsSync(path.join(root, "agents/categories/wiki")), true)
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
  fs.mkdirSync(path.join(root, "agents/categories/wiki"), { recursive: true }); fs.writeFileSync(path.join(root, "agents/categories/wiki/file"), "same")
  for (const slot of ["new", "old", "quarantine"]) fs.mkdirSync(path.join(tx, slot, "wiki"), { recursive: true })
  fs.writeFileSync(path.join(tx, "identity.json"), JSON.stringify({ schemaVersion: 4, txid }))
  for (const slot of ["new", "old"]) fs.writeFileSync(path.join(tx, slot, "wiki/file"), "same")
  const plans = { wiki: { oldHash: (null as string | null), newHash: "0".repeat(64), original: true } }
  fs.writeFileSync(path.join(control, "build-all.journal"), JSON.stringify({ schemaVersion: 4, state: "publish-intent", txid, ids: ["wiki"], categories: plans }))
  const before = fs.readFileSync(path.join(root, "agents/categories/wiki/file")); assert.throws(() => recoverBuildAllCategoryDistributions(root), /Invalid category build recovery state/); assert.deepEqual(fs.readFileSync(path.join(root, "agents/categories/wiki/file")), before)
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
