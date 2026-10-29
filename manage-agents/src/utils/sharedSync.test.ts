import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { after, test } from "node:test"
import { tsImport } from "tsx/esm/api"

const sharedSync: any = await tsImport("./sharedSync.ts", import.meta.url)
const {
  applySharedSync,
  collectComponentFiles,
  compareSharedSync,
  loadSharedSyncManifest,
  parseSharedSyncArgs,
  releaseSharedSync,
  satisfiesSemverRange,
  validateSharedSyncManifest
} = sharedSync

const temporaryRoots: string[] = []

after(() => {
  for (const root of temporaryRoots) fs.rmSync(root, { recursive: true, force: true })
})

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shared-sync-test-"))
  temporaryRoots.push(root)
  return root
}

function manifest(overrides: { managerVersion?: string; pipelineVersion?: string; requires?: string } = {}): any {
  return {
    schemaVersion: 1,
    components: {
      agentManager: {
        version: overrides.managerVersion ?? "1.1.0",
        description: "Fixture manager",
        include: [
          "manage-agents.sh",
          "manage-agents/manage-agents.mjs",
          "manage-agents/package.json",
          "manage-agents/package-lock.json",
          "manage-agents/tsconfig.json",
          "manage-agents/README.md",
          "manage-agents/GUIDA.md",
          "manage-agents/assets/**",
          "manage-agents/src/**",
          ".agent-manager/bash-profiles.json",
          ".agent-manager/translation-config.json"
        ],
        exclude: ["manage-agents/node_modules/**", "manage-agents/dist/**"]
      },
      pipelineCore: {
        version: overrides.pipelineVersion ?? "1.1.0",
        requiresAgentManager: overrides.requires ?? ">=1.1.0 <2.0.0",
        description: "Fixture pipeline",
        include: [
          "src/agents/pipeline-*.md",
          "src/commands/pipeline-*.md",
          "src/plugins/pipeline-guard.js",
          "src/plugins/README.md",
          "src/tools/*pipeline*",
          "src/tools/_guards*",
          "src/tools/_paths.js",
          "src/tools/_safeName*",
          "src/docs/mcp-configuration.md"
        ],
        exclude: []
      }
    },
    localOverlay: {
      neverOverwrite: [
        "src/agents/ontology-*.md",
        "src/tools/ontology/**",
        "src/skills/ontology-*/**",
        "src/resources/ontology/**",
        "src/ontology-pipeline.md",
        ".agent-manager/pipeline-profiles.json",
        ".agent-manager/companion-links.json",
        ".agent-manager/categories/**",
        "src/opencode.json",
        "export/categories/**",
        "export/bridges/**"
      ]
    }
  }
}

function writeFile(root: string, relative: string, content: string, mode = 0o644): string {
  const file = path.join(root, ...relative.split("/"))
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, { mode })
  fs.chmodSync(file, mode)
  return file
}

function createRepo(root: string, config = manifest()): string {
  fs.mkdirSync(root, { recursive: true })
  writeFile(root, ".agent-manager/shared-sync.json", `${JSON.stringify(config, null, 2)}\n`)
  return root
}

function writePipelineSource(root: string, body = "@pipeline-tester\n") {
  writeFile(root, "src/agents/pipeline-orchestrator.md", `---\ndescription: Canonical pipeline\nmodel: fixture/model\n---\n\n${body}`)
  writeFile(root, "src/tools/_pipeline_core.js", "export const pipelineCore = true\n")
  writeFile(root, "src/commands/pipeline-run.md", "Canonical pipeline command\n")
}

function gitCommitAll(root: string): void {
  execFileSync("git", ["-C", root, "init", "-q"])
  execFileSync("git", ["-C", root, "config", "user.email", "shared-sync@example.invalid"])
  execFileSync("git", ["-C", root, "config", "user.name", "Shared Sync Test"])
  execFileSync("git", ["-C", root, "add", "-A"])
  execFileSync("git", ["-C", root, "commit", "-qm", "fixture baseline"])
}

test("manifest validation, semver ranges, and overlay exclusions", () => {
  const root = createRepo(makeTempRoot())
  const loaded = loadSharedSyncManifest(root)
  validateSharedSyncManifest(loaded)
  assert.equal(satisfiesSemverRange("1.1.0", ">=1.1.0 <2.0.0"), true)
  assert.equal(satisfiesSemverRange("2.0.0", ">=1.1.0 <2.0.0"), false)
  assert.equal(satisfiesSemverRange("1.2.9", "^1.1.0"), true)
  assert.equal(satisfiesSemverRange("1.2.0", "~1.1.0"), false)
  assert.throws(() => validateSharedSyncManifest({ ...loaded, schemaVersion: 2 }), /schemaVersion/)
  assert.throws(() => validateSharedSyncManifest({
    ...loaded,
    components: { ...loaded.components, agentManager: { ...loaded.components.agentManager, include: ["../outside"] } }
  }), /unsafe glob/)
  assert.throws(() => validateSharedSyncManifest({
    ...loaded,
    components: { ...loaded.components, agentManager: { ...loaded.components.agentManager, include: ["src/**"] } }
  }), /allowed component prefixes/)
  assert.throws(() => validateSharedSyncManifest({
    ...loaded,
    components: { ...loaded.components, pipelineCore: { ...loaded.components.pipelineCore, include: ["src/agents/**"] } }
  }), /allowed component prefixes/)

  const broad = structuredClone(loaded)
  broad.components.agentManager.include = ["manage-agents/**", ".agent-manager/**"]
  writeFile(root, ".agent-manager/shared-sync.json", `${JSON.stringify(broad, null, 2)}\n`)
  for (const relative of [
    ".agent-manager/pipeline-profiles.json",
    ".agent-manager/companion-links.json"
  ]) writeFile(root, relative, "local overlay\n")
  const paths = collectComponentFiles(root, broad, "agentManager").map(entry => entry.path)
  for (const relative of [
    ".agent-manager/pipeline-profiles.json",
    ".agent-manager/companion-links.json"
  ]) assert.equal(paths.includes(relative), false, `${relative} must be protected`)
})

test("collectComponentFiles rejects symlinks", () => {
  const root = createRepo(makeTempRoot())
  writeFile(root, "src/agents/pipeline-orchestrator.md", "pipeline\n")
  fs.symlinkSync(path.join(root, "src/agents/pipeline-orchestrator.md"), path.join(root, "src/agents/pipeline-link.md"))
  assert.throws(() => collectComponentFiles(root, loadSharedSyncManifest(root), "pipelineCore"), /symlink/)
})

test("compareSharedSync reports identical, modified, missing, and dirty shared paths", () => {
  const source = createRepo(makeTempRoot())
  const target = createRepo(makeTempRoot())
  writePipelineSource(source)
  writePipelineSource(target)
  writeFile(target, "src/tools/_pipeline_core.js", "export const pipelineCore = false\n")
  writeFile(source, "src/plugins/README.md", "Pipeline plugin documentation\n")
  const comparison = compareSharedSync({ sourceRoot: source, targetRoot: target, components: ["pipelineCore"] })
  assert.deepEqual(comparison.identical, ["src/agents/pipeline-orchestrator.md", "src/commands/pipeline-run.md"])
  assert.deepEqual(comparison.modified, ["src/tools/_pipeline_core.js"])
  assert.deepEqual(comparison.missingInTarget, ["src/plugins/README.md"])
  assert.deepEqual(comparison.protectedByOverlay, [])
  writeFile(target, ".agent-manager/shared-sync-state.json", `${JSON.stringify({
    schemaVersion: 1,
    installedComponents: { agentManager: "1.1.0", pipelineCore: "1.1.0" },
    sourceCommit: null,
    syncedAt: "2026-01-01T00:00:00.000Z",
    files: { "src/tools/_pipeline_core.js": crypto.createHash("sha256").update("export const pipelineCore = true\n").digest("hex") }
  }, null, 2)}\n`)
  const withDrift = compareSharedSync({ sourceRoot: source, targetRoot: target, components: ["pipelineCore"] })
  assert.deepEqual(withDrift.dirtyTargetFiles, ["src/tools/_pipeline_core.js"])
})

test("release and apply round-trip through a release bundle and reject tampering", () => {
  const source = createRepo(makeTempRoot())
  const target = createRepo(makeTempRoot(), manifest({ managerVersion: "1.0.0" }))
  const output = path.join(makeTempRoot(), "release")
  writePipelineSource(source)
  writeFile(source, "manage-agents/manage-agents.mjs", "#!/usr/bin/env node\n", 0o755)
  const release = releaseSharedSync({ sourceRoot: source, outputDir: output })
  assert.equal(release.kind, "shared-sync-release")
  const applied = applySharedSync({ sourceRoot: output, targetRoot: target })
  assert.equal(applied.dryRun, false)
  assert.equal(fs.readFileSync(path.join(target, "src/tools/_pipeline_core.js"), "utf8"), "export const pipelineCore = true\n")
  assert.equal(fs.readFileSync(path.join(target, "manage-agents/manage-agents.mjs"), "utf8"), "#!/usr/bin/env node\n")
  assert.equal(fs.statSync(path.join(target, "manage-agents/manage-agents.mjs")).mode & 0o111 ? 0o755 : 0o644, 0o755)
  const state = JSON.parse(fs.readFileSync(path.join(target, ".agent-manager/shared-sync-state.json"), "utf8"))
  assert.equal(state.installedComponents.agentManager, "1.1.0")
  assert.equal(state.installedComponents.pipelineCore, "1.1.0")

  const tampered = path.join(output, "files/src/tools/_pipeline_core.js")
  fs.writeFileSync(tampered, "tampered\n")
  assert.throws(() => applySharedSync({ sourceRoot: output, targetRoot: makeTempRoot() }), /hash mismatch/)
  fs.writeFileSync(tampered, fs.readFileSync(path.join(source, "src/tools/_pipeline_core.js")))
  const bundledManifest = path.join(output, "files/.agent-manager/shared-sync.json")
  fs.appendFileSync(bundledManifest, " ")
  assert.throws(() => applySharedSync({ sourceRoot: output, targetRoot: makeTempRoot() }), /hash mismatch/)
})

test("release output stays outside protected paths and replaces only release directories", () => {
  const source = createRepo(makeTempRoot())
  writePipelineSource(source)
  const agentPath = path.join(source, "src/agents/pipeline-orchestrator.md")
  const originalAgent = fs.readFileSync(agentPath, "utf8")

  assert.throws(() => releaseSharedSync({ sourceRoot: source, outputDir: path.join(source, "src/agents") }), /protected repository paths/)
  assert.equal(fs.readFileSync(agentPath, "utf8"), originalAgent)

  const emptyOutput = path.join(source, "artifacts/empty-release")
  fs.mkdirSync(emptyOutput, { recursive: true })
  assert.throws(() => releaseSharedSync({ sourceRoot: source, outputDir: emptyOutput }), /non-release directory/)
  assert.deepEqual(fs.readdirSync(emptyOutput), [])

  const decoyOutput = path.join(source, "artifacts/decoy-release")
  fs.mkdirSync(decoyOutput, { recursive: true })
  writeFile(decoyOutput, "release-index.json", JSON.stringify({ kind: "shared-sync-release" }))
  const sentinel = writeFile(decoyOutput, "keep.txt", "keep me\n")
  assert.throws(() => releaseSharedSync({ sourceRoot: source, outputDir: decoyOutput }), /non-release directory/)
  assert.equal(fs.readFileSync(sentinel, "utf8"), "keep me\n")

  const existingOutput = path.join(source, "dist/shared-release")
  const release = releaseSharedSync({ sourceRoot: source, outputDir: existingOutput })
  assert.equal(release.kind, "shared-sync-release")
  const extraFile = path.join(existingOutput, "files/extra.txt")
  fs.writeFileSync(extraFile, "unexpected\n")
  assert.throws(() => releaseSharedSync({ sourceRoot: source, outputDir: existingOutput }), /outside its manifest and entries/)
  assert.equal(fs.readFileSync(extraFile, "utf8"), "unexpected\n")
  fs.unlinkSync(extraFile)
  writePipelineSource(source, "Updated pipeline body\n")
  releaseSharedSync({ sourceRoot: source, outputDir: existingOutput })
  assert.equal(fs.readFileSync(path.join(existingOutput, "files/src/agents/pipeline-orchestrator.md"), "utf8").includes("Updated pipeline body"), true)
})

test("release refuses destinations redirected through symlink ancestors", () => {
  const source = createRepo(makeTempRoot())
  writePipelineSource(source)
  const protectedDirectory = path.join(source, "src/agents")
  const nestedNodeModules = path.join(makeTempRoot(), "nested", "node_modules")
  fs.mkdirSync(path.dirname(nestedNodeModules), { recursive: true })
  fs.symlinkSync(protectedDirectory, nestedNodeModules)
  const output = path.join(nestedNodeModules, "release")

  assert.throws(() => releaseSharedSync({ sourceRoot: source, outputDir: output }), /symlink/)
  assert.equal(fs.existsSync(path.join(protectedDirectory, "release-index.json")), false)
  assert.equal(fs.existsSync(path.join(protectedDirectory, "files")), false)
})

test("apply rejects release entries outside component allowlists despite recomputed hashes", () => {
  for (const unauthorizedPath of [".git/hooks/pre-commit", "README.md", "src/agents/pipeline-evil.txt"]) {
    const source = createRepo(makeTempRoot())
    const output = path.join(makeTempRoot(), "release")
    writePipelineSource(source)
    releaseSharedSync({ sourceRoot: source, outputDir: output, components: ["pipelineCore"] })

    const bytes = Buffer.from("unauthorized entry\n")
    const file = path.join(output, "files", ...unauthorizedPath.split("/"))
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, bytes, { mode: 0o644 })
    const indexFile = path.join(output, "release-index.json")
    const index = JSON.parse(fs.readFileSync(indexFile, "utf8"))
    const entry = {
      component: "pipelineCore",
      path: unauthorizedPath,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
      mode: 0o644
    }
    index.entries = [...index.entries, entry].sort((left: any, right: any) => {
      const byComponent = left.component < right.component ? -1 : left.component > right.component ? 1 : 0
      return byComponent || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    })
    index.contentDigest = crypto.createHash("sha256").update(JSON.stringify(index.entries)).digest("hex")
    fs.writeFileSync(indexFile, `${JSON.stringify(index, null, 2)}\n`)

    const target = createRepo(makeTempRoot())
    const originalTarget = "Target pipeline must remain unchanged\n"
    writeFile(target, "src/agents/pipeline-orchestrator.md", originalTarget)
    assert.throws(() => compareSharedSync({ sourceRoot: output, targetRoot: target }), /unsafe entry|not allowed/)
    assert.throws(() => applySharedSync({ sourceRoot: output, targetRoot: target }), /unsafe entry|not allowed/)
    assert.equal(fs.readFileSync(path.join(target, "src/agents/pipeline-orchestrator.md"), "utf8"), originalTarget)
    assert.equal(fs.existsSync(path.join(target, unauthorizedPath)), false)
  }
})

test("compare and apply enforce the target manifest component allowlist", () => {
  const source = createRepo(makeTempRoot())
  writePipelineSource(source)
  for (const restriction of ["include", "exclude", "neverOverwrite"] as const) {
    const targetConfig = manifest()
    if (restriction === "include") targetConfig.components.pipelineCore.include = ["src/tools/*pipeline*"]
    if (restriction === "exclude") targetConfig.components.pipelineCore.exclude = ["src/agents/pipeline-*.md"]
    if (restriction === "neverOverwrite") targetConfig.localOverlay.neverOverwrite.push("src/agents/pipeline-*.md")
    const target = createRepo(makeTempRoot(), targetConfig)

    assert.throws(() => compareSharedSync({ sourceRoot: source, targetRoot: target, components: ["pipelineCore"] }), /target manifest/)
    assert.throws(() => applySharedSync({ sourceRoot: source, targetRoot: target, components: ["pipelineCore"] }), /target manifest/)
  }
})

test("pipelineCore application enforces its required agentManager version", () => {
  const source = createRepo(makeTempRoot(), manifest({ pipelineVersion: "2.4.0", requires: ">=1.2.0 <2.0.0" }))
  const target = createRepo(makeTempRoot(), manifest({ managerVersion: "1.1.0" }))
  writePipelineSource(source)
  assert.throws(() => applySharedSync({ sourceRoot: source, targetRoot: target, components: ["pipelineCore"] }), /requires agentManager >=1\.2\.0 <2\.0\.0/)
  assert.equal(fs.existsSync(path.join(target, "src/agents/pipeline-orchestrator.md")), false)
})

test("apply protects Git-dirty and locally drifted shared files unless forced", () => {
  const source = createRepo(makeTempRoot())
  const target = createRepo(makeTempRoot())
  writePipelineSource(source)
  writePipelineSource(target)
  const sharedFile = "src/tools/_pipeline_core.js"
  const original = "export const pipelineCore = true\n"
  const local = "export const pipelineCore = locallyChanged\n"
  writeFile(target, sharedFile, original)
  const originalHash = crypto.createHash("sha256").update(original).digest("hex")
  writeFile(target, ".agent-manager/shared-sync-state.json", `${JSON.stringify({
    schemaVersion: 1,
    installedComponents: { agentManager: "1.1.0", pipelineCore: "1.1.0" },
    sourceCommit: null,
    syncedAt: "2026-01-01T00:00:00.000Z",
    files: { [sharedFile]: originalHash }
  }, null, 2)}\n`)
  gitCommitAll(target)
  writeFile(target, sharedFile, local)
  assert.throws(() => applySharedSync({ sourceRoot: source, targetRoot: target, components: ["pipelineCore"] }), /locally modified shared files/)
  assert.equal(fs.readFileSync(path.join(target, sharedFile), "utf8"), local)
  const result = applySharedSync({ sourceRoot: source, targetRoot: target, components: ["pipelineCore"], force: true })
  assert.equal(result.updated.includes(sharedFile), true)
  assert.equal(fs.readFileSync(path.join(target, sharedFile), "utf8"), "export const pipelineCore = true\n")
})

test("apply preserves overlay configuration and refreshes the target's stamped pipeline profile", () => {
  const source = createRepo(makeTempRoot())
  const target = createRepo(makeTempRoot())
  writePipelineSource(source, "New pipeline body\n@pipeline-tester\n")
  writeFile(source, "src/agents/pipeline-tester.md", "---\ndescription: Pipeline tester\nmodel: fixture/model\n---\n\nTester role\n")
  writeFile(source, "src/plugins/pipeline-guard.js", "export const guardVersion = 2\n")
  writeFile(target, "src/agents/pipeline-orchestrator.md", "old canonical pipeline\n")
  writeFile(target, "src/agents/ontology-orchestrator.md", "local ontology agent\n")
  writeFile(target, ".agent-manager/pipeline-profiles.json", `${JSON.stringify({
    version: 1,
    baseCategory: "pipeline",
    profiles: { spark: { description: "Local Spark profile", defaults: { all: { model: "local/spark" } } } }
  }, null, 2)}\n`)
  const companionLinks = `${JSON.stringify({ version: 1, categories: {} }, null, 2)}\n`
  writeFile(target, ".agent-manager/companion-links.json", companionLinks)
  writeFile(target, "export/categories/local-note.txt", "keep local export\n")
  writeFile(target, "export/categories/spark-pipeline/agents/spark-pipeline-orchestrator.md", "---\ndescription: Local stamped agent\nmodel: local/spark\n---\n\nOld stamped body\n")

  applySharedSync({ sourceRoot: source, targetRoot: target, components: ["pipelineCore"] })
  const stamped = fs.readFileSync(path.join(target, "export/categories/spark-pipeline/agents/spark-pipeline-orchestrator.md"), "utf8")
  assert.match(stamped, /New pipeline body/)
  assert.match(stamped, /model: local\/spark/)
  assert.equal(fs.readFileSync(path.join(target, "src/agents/ontology-orchestrator.md"), "utf8"), "local ontology agent\n")
  assert.equal(fs.readFileSync(path.join(target, ".agent-manager/pipeline-profiles.json"), "utf8").includes("Local Spark profile"), true)
  assert.equal(fs.readFileSync(path.join(target, ".agent-manager/companion-links.json"), "utf8"), companionLinks)
  assert.equal(fs.readFileSync(path.join(target, "export/categories/local-note.txt"), "utf8"), "keep local export\n")
})

test("shared sync argument parser accepts command and component aliases", () => {
  assert.deepEqual(parseSharedSyncArgs(["apply", "--from", "release", "--target", "repo", "--component", "pipeline", "--dry-run", "--force"]), {
    command: "apply",
    components: ["pipelineCore"],
    from: "release",
    target: "repo",
    dryRun: true,
    force: true
  })
  assert.equal(parseSharedSyncArgs(["release", "--out", "bundle", "--component", "all"]).out, "bundle")
  assert.throws(() => parseSharedSyncArgs(["apply", "--component", "unknown"]), /Unknown shared sync component/)
})
