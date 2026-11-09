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
          "manage-agents/README.md",
          "manage-agents/GUIDA.md",
          "manage-agents/assets/**",
          "manage-agents/src/**",
          ".agent-manager/bash-profiles.json",
          ".agent-manager/translation-config.json"
        ],
        exclude: [
          "manage-agents/node_modules/**",
          "manage-agents/dist/**",
          "manage-agents/package.json",
          "manage-agents/package-lock.json",
          "manage-agents/tsconfig.json",
          "manage-agents/bun.lock",
          "manage-agents/bunfig.toml",
          "manage-agents/.npmrc",
          "manage-agents/integration/**"
        ]
      },
      pipelineCore: {
        version: overrides.pipelineVersion ?? "1.1.0",
        requiresAgentManager: overrides.requires ?? ">=1.1.0 <2.0.0",
        description: "Fixture pipeline",
        include: [
          "src/agents/pipeline-*.md",
          "src/commands/pipeline-*.md",
          "src/plugins/pipeline-guard/**",
          "src/plugins/pipeline-tools/**",
          "src/plugins/doc-tools/**",
          "src/plugins/slide-tools/**",
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
        ".agent-manager/agent-routing.json",
        "src/plugins/agent-router/routing.json",
        ".agent-manager/companion-links.json",
        ".agent-manager/categories/**",
        "src/opencode.json",
        "export/categories/**",
        "export/bridges/**",
        "manage-agents/package.json",
        "manage-agents/package-lock.json",
        "manage-agents/tsconfig.json",
        "manage-agents/bun.lock",
        "manage-agents/bunfig.toml",
        "manage-agents/.npmrc",
        "manage-agents/integration/**"
      ]
    }
  }
}

const STRUCTURAL_PIPELINE_INCLUDE = [
  "src/agents/pipeline-*.md",
  "src/commands/pipeline-*",
  "src/plugins/**",
  "src/tools/**",
  "src/skills/**",
  "src/resources/**",
  "src/docs/mcp-configuration.md"
]

function structuralPipelineManifest(): any {
  const config = manifest()
  config.components.pipelineCore.include = [...STRUCTURAL_PIPELINE_INCLUDE]
  return config
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

function writeCompanionDiscoverySource(root: string): void {
  writeFile(root, "src/agents/pipeline-orchestrator.md", "---\ndescription: Pipeline orchestrator\nmodel: fixture/model\n---\n\nPipeline orchestration.\n")
  writeFile(root, "src/agents/pipeline-executor.md", "---\ndescription: Pipeline executor\nmodel: fixture/model\n---\n\nPipeline execution.\n")
  writeFile(root, ".agent-manager/companion-links.json", JSON.stringify({
    version: 1,
    categories: {
      pipeline: {
        plugins: ["plugins/pipeline-tools"],
        commands: [],
        skills: ["skills/code-review-antipatterns"],
        tools: []
      }
    }
  }))
  writeFile(root, "src/plugins/pipeline-tools/index.ts", "import { create } from \"../../tools/doc_create.js\"\nexport default create\n")
  writeFile(root, "src/tools/doc_create.ts", "import { helper } from \"./_tool.js\"\nexport default helper\n")
  writeFile(root, "src/tools/_tool.ts", "import { python } from \"./_python.js\"\nexport default python\n")
  writeFile(root, "src/tools/_python.js", "export const theme = opencodePath(\"_doc_theme.template.css\")\n")
  writeFile(root, "src/tools/_doc_theme.template.css", "body {}\n")
  writeFile(root, "src/tools/docx/scripts/create_document.py", "# unrelated docs tool\n")
  writeFile(root, "src/skills/code-review-antipatterns/SKILL.md", "# Pipeline skill\n")
  writeFile(root, "src/skills/wiki-navigate/SKILL.md", "# Wiki skill\n")
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
    components: { ...loaded.components, pipelineCore: { ...loaded.components.pipelineCore, include: ["src/opencode.json"] } }
  }), /allowed component prefixes/)

  const broad = structuredClone(loaded)
  broad.components.agentManager.include = ["manage-agents/**", ".agent-manager/**"]
  broad.components.agentManager.exclude = ["manage-agents/node_modules/**", "manage-agents/dist/**"]
  writeFile(root, ".agent-manager/shared-sync.json", `${JSON.stringify(broad, null, 2)}\n`)
  const overlayFiles = [
    ".agent-manager/agent-routing.json",
    ".agent-manager/companion-links.json",
    "manage-agents/package.json",
    "manage-agents/package-lock.json",
    "manage-agents/tsconfig.json",
    "manage-agents/bun.lock",
    "manage-agents/bunfig.toml",
    "manage-agents/.npmrc",
    "manage-agents/integration/example.test.ts"
  ]
  for (const relative of overlayFiles) writeFile(root, relative, "local overlay\n")
  const paths = collectComponentFiles(root, broad, "agentManager").map(entry => entry.path)
  for (const relative of overlayFiles) assert.equal(paths.includes(relative), false, `${relative} must be protected`)
})

test("collectComponentFiles rejects symlinks", { skip: process.platform === "win32" }, () => {
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

test("pipelineCore ships V2 plugin directory files", () => {
  const source = createRepo(makeTempRoot())
  const target = createRepo(makeTempRoot())
  const plugins = [
    "src/plugins/pipeline-guard/index.ts",
    "src/plugins/pipeline-tools/index.ts",
    "src/plugins/doc-tools/index.ts",
    "src/plugins/slide-tools/index.ts"
  ]
  for (const relative of plugins) writeFile(source, relative, `${relative}\n`)
  const collected = collectComponentFiles(source, loadSharedSyncManifest(source), "pipelineCore").map(entry => entry.path)
  assert.deepEqual(collected, [...plugins].sort())

  applySharedSync({ sourceRoot: source, targetRoot: target, components: ["pipelineCore"] })
  for (const relative of plugins) {
    assert.equal(fs.readFileSync(path.join(target, ...relative.split("/")), "utf8"), `${relative}\n`)
  }
  assert.equal(fs.existsSync(path.join(target, "src/plugins/pipeline-guard" + ".js")), false)
})

test("pipelineCore structural trees ship whole, linked or not", () => {
  const source = createRepo(makeTempRoot(), structuralPipelineManifest())
  writeCompanionDiscoverySource(source)

  const collected = collectComponentFiles(source, loadSharedSyncManifest(source), "pipelineCore").map(entry => entry.path)
  for (const relative of [
    "src/plugins/pipeline-tools/index.ts",
    "src/tools/doc_create.ts",
    "src/tools/_tool.ts",
    "src/tools/_python.js",
    "src/tools/_doc_theme.template.css",
    "src/skills/code-review-antipatterns/SKILL.md",
    "src/skills/wiki-navigate/SKILL.md",
    "src/tools/docx/scripts/create_document.py"
  ]) assert.ok(collected.includes(relative), `${relative} must be included`)
})

test("apply accepts discovered tools and skills allowed by structural target trees", () => {
  const config = structuralPipelineManifest()
  const source = createRepo(makeTempRoot(), config)
  const target = createRepo(makeTempRoot(), structuredClone(config))
  writeCompanionDiscoverySource(source)

  const result = applySharedSync({ sourceRoot: source, targetRoot: target, components: ["pipelineCore"] })
  for (const relative of [
    "src/tools/doc_create.ts",
    "src/tools/_tool.ts",
    "src/tools/_python.js",
    "src/tools/_doc_theme.template.css",
    "src/skills/code-review-antipatterns/SKILL.md"
  ]) {
    assert.ok(result.updated.includes(relative), `${relative} must be applied`)
    assert.equal(fs.readFileSync(path.join(target, ...relative.split("/")), "utf8"), fs.readFileSync(path.join(source, ...relative.split("/")), "utf8"))
  }
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
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.join(target, "manage-agents/manage-agents.mjs")).mode & 0o111 ? 0o755 : 0o644, 0o755)
  }
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

test("release refuses destinations redirected through symlink ancestors", { skip: process.platform === "win32" }, () => {
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

test("apply preserves the target's overlay configuration and local model routing", () => {
  const source = createRepo(makeTempRoot())
  const target = createRepo(makeTempRoot())
  writePipelineSource(source, "New pipeline body\n@pipeline-tester\n")
  writeFile(source, "src/plugins/pipeline-guard/index.ts", "export const guardVersion = 2\n")
  writeFile(source, "src/plugins/agent-router/routing.json", "{ \"source\": true }\n")
  writeFile(target, "src/agents/pipeline-orchestrator.md", "old canonical pipeline\n")
  writeFile(target, "src/agents/ontology-orchestrator.md", "local ontology agent\n")
  const routing = "{ \"target\": true }\n"
  writeFile(target, ".agent-manager/agent-routing.json", routing)
  writeFile(target, "src/plugins/agent-router/routing.json", routing)
  const companionLinks = `${JSON.stringify({ version: 1, categories: {} }, null, 2)}\n`
  writeFile(target, ".agent-manager/companion-links.json", companionLinks)
  writeFile(target, "export/categories/local-note.txt", "keep local export\n")

  applySharedSync({ sourceRoot: source, targetRoot: target, components: ["pipelineCore"] })
  assert.match(fs.readFileSync(path.join(target, "src/agents/pipeline-orchestrator.md"), "utf8"), /New pipeline body/)
  assert.equal(fs.readFileSync(path.join(target, "src/agents/ontology-orchestrator.md"), "utf8"), "local ontology agent\n")
  assert.equal(fs.readFileSync(path.join(target, ".agent-manager/agent-routing.json"), "utf8"), routing)
  assert.equal(fs.readFileSync(path.join(target, "src/plugins/agent-router/routing.json"), "utf8"), routing)
  assert.equal(fs.readFileSync(path.join(target, ".agent-manager/companion-links.json"), "utf8"), companionLinks)
  assert.equal(fs.readFileSync(path.join(target, "export/categories/local-note.txt"), "utf8"), "keep local export\n")
})

test("apply removes files an earlier sync installed and the source no longer ships, never locally modified ones", () => {
  const source = createRepo(makeTempRoot())
  writePipelineSource(source)
  writeFile(source, "src/tools/_pipeline_old.js", "export const old = true\n")
  const target = createRepo(makeTempRoot())
  applySharedSync({ sourceRoot: source, targetRoot: target, components: ["pipelineCore"] })
  assert.ok(fs.existsSync(path.join(target, "src/tools/_pipeline_old.js")))

  fs.rmSync(path.join(source, "src/tools/_pipeline_old.js"))
  assert.deepEqual(compareSharedSync({ sourceRoot: source, targetRoot: target, components: ["pipelineCore"] }).obsoleteInTarget, ["src/tools/_pipeline_old.js"])
  writeFile(target, "src/tools/_pipeline_old.js", "edited locally\n")
  assert.throws(() => applySharedSync({ sourceRoot: source, targetRoot: target, components: ["pipelineCore"] }), /locally modified/)
  assert.equal(fs.readFileSync(path.join(target, "src/tools/_pipeline_old.js"), "utf8"), "edited locally\n")

  const result = applySharedSync({ sourceRoot: source, targetRoot: target, components: ["pipelineCore"], force: true })
  assert.deepEqual(result.removed, ["src/tools/_pipeline_old.js"])
  assert.equal(fs.existsSync(path.join(target, "src/tools/_pipeline_old.js")), false)
  const state = JSON.parse(fs.readFileSync(path.join(target, ".agent-manager/shared-sync-state.json"), "utf8"))
  assert.equal("src/tools/_pipeline_old.js" in state.files, false, "removed files leave the state")
  assert.ok(fs.existsSync(path.join(target, "src/tools/_pipeline_core.js")), "shipped files stay")
})

test("a first sync removes files the source deleted in its history and explicit-pattern leftovers", () => {
  const source = createRepo(makeTempRoot())
  writePipelineSource(source)
  writeFile(source, "src/tools/_pipeline_gone.js", "export const gone = true\n")
  gitCommitAll(source)
  fs.rmSync(path.join(source, "src/tools/_pipeline_gone.js"))
  execFileSync("git", ["-C", source, "commit", "-qam", "remove helper"])

  const target = createRepo(makeTempRoot())
  writeFile(target, "src/tools/_pipeline_gone.js", "export const gone = true\n")
  writeFile(target, "src/agents/pipeline-retired_role.md", "---\ndescription: retired\n---\n\nOld role.\n")
  writeFile(target, "src/tools/local_tool.ts", "export default 1\n")
  gitCommitAll(target)

  const comparison = compareSharedSync({ sourceRoot: source, targetRoot: target, components: ["pipelineCore"] })
  assert.deepEqual(comparison.obsoleteInTarget, ["src/agents/pipeline-retired_role.md", "src/tools/_pipeline_gone.js"])
  const result = applySharedSync({ sourceRoot: source, targetRoot: target, components: ["pipelineCore"] })
  assert.deepEqual(result.removed, ["src/agents/pipeline-retired_role.md", "src/tools/_pipeline_gone.js"])
  assert.ok(fs.existsSync(path.join(target, "src/tools/local_tool.ts")), "a file the source never had is not ours")
})

function writeAlignmentSource(root: string): void {
  writeFile(root, ".agent-manager/categories/pipeline.json", "{ \"id\": \"pipeline\" }\n")
  writeFile(root, ".agent-manager/categories/flow.json", "{ \"id\": \"flow\" }\n")
  writeFile(root, ".agent-manager/agent-routing.json", "{ \"version\": 2, \"archetypes\": {} }\n")
  writeFile(root, ".agent-manager/companion-links.json", `${JSON.stringify({ version: 1, categories: {
    pipeline: { plugins: ["plugins/agent-router"], commands: [], skills: [], tools: [] },
    flow: { plugins: ["plugins/flow-guard"], commands: [], skills: [], tools: [] },
    ontology: { plugins: ["plugins/source-ontology"], commands: [], skills: [], tools: [] }
  } }, null, 2)}\n`)
  writeFile(root, ".agent-manager/categories/wiki.json", "{ \"id\": \"wiki\", \"skills\": 2 }\n")
  writeFile(root, "manage-agents/package.json", `${JSON.stringify({ name: "manage-agents", scripts: { test: "new test" } }, null, 2)}\n`)
  writeFile(root, "src/opencode.json", `${JSON.stringify({ plugins: ["./plugins/a", "./plugins/b"] }, null, 4)}\n`)
}

test("apply aligns archetype configuration, package scripts and the blueprint, and removes retired stamped bundles", () => {
  const source = createRepo(makeTempRoot())
  writePipelineSource(source)
  writeAlignmentSource(source)
  const target = createRepo(makeTempRoot())
  writeFile(target, ".agent-manager/categories/flow.json", "{ \"id\": \"flow\", \"local\": true }\n")
  writeFile(target, ".agent-manager/companion-links.json", `${JSON.stringify({ version: 1, categories: {
    pipeline: { plugins: ["plugins/pipeline-guard"], commands: [], skills: [], tools: ["tools/pipeline_verify.ts"] },
    docs: { plugins: ["plugins/doc-tools"], commands: [], skills: [], tools: [] },
    ontology: { plugins: ["plugins/twin-ontology"], commands: [], skills: [], tools: [] }
  } }, null, 2)}\n`)
  writeFile(target, ".agent-manager/categories/wiki.json", "{ \"id\": \"wiki\", \"skills\": 0 }\n")
  writeFile(target, ".agent-manager/categories/ontology.json", "{ \"id\": \"ontology\" }\n")
  writeFile(target, "manage-agents/package.json", `${JSON.stringify({ name: "manage-agents", scripts: { test: "old test", local: "keep" }, dependencies: { yaml: "1" } }, null, 4)}\n`)
  writeFile(target, "src/opencode.json", `${JSON.stringify({ theme: "local", plugins: ["./plugins/a", "./plugins/local"] }, null, 4)}\n`)
  writeFile(target, ".agent-manager/pipeline-profiles.json", "{}\n")
  writeFile(target, "export/categories/go-pipeline/agents/go-pipeline-executor.md", "stamped\n")
  writeFile(target, "export/categories/docs/README.md", "keep\n")
  gitCommitAll(target)

  const preview = compareSharedSync({ sourceRoot: source, targetRoot: target })
  assert.ok(preview.alignment.includes("delete export/categories/go-pipeline/ (1 files, retired stamped pipeline bundle)"))
  applySharedSync({ sourceRoot: source, targetRoot: target })

  const read = (relative: string) => fs.readFileSync(path.join(target, ...relative.split("/")), "utf8")
  assert.equal(read(".agent-manager/categories/pipeline.json"), "{ \"id\": \"pipeline\" }\n", "a missing archetype manifest is seeded")
  assert.equal(read(".agent-manager/categories/flow.json"), "{ \"id\": \"flow\" }\n", "an existing one follows the source")
  assert.equal(read(".agent-manager/categories/wiki.json"), "{ \"id\": \"wiki\", \"skills\": 2 }\n", "every category the source has, not only the archetypes")
  assert.equal(read(".agent-manager/categories/ontology.json"), "{ \"id\": \"ontology\" }\n", "the target's own categories stay")
  assert.equal(read(".agent-manager/agent-routing.json"), "{ \"version\": 2, \"archetypes\": {} }\n")
  const links = JSON.parse(read(".agent-manager/companion-links.json"))
  assert.deepEqual(links.categories.pipeline.plugins, ["plugins/agent-router"], "archetype links follow the source")
  assert.deepEqual(links.categories.flow.plugins, ["plugins/flow-guard"])
  assert.deepEqual(links.categories.docs.plugins, ["plugins/doc-tools"], "categories the source lacks stay")
  assert.deepEqual(links.categories.ontology.plugins, ["plugins/twin-ontology"], "overlay categories stay local")
  const pkg = read("manage-agents/package.json")
  assert.deepEqual(JSON.parse(pkg), { name: "manage-agents", scripts: { test: "new test", local: "keep" }, dependencies: { yaml: "1" } })
  assert.match(pkg, /^\{\n {4}"name"/, "the target's indentation is kept")
  assert.deepEqual(JSON.parse(read("src/opencode.json")), { theme: "local", plugins: ["./plugins/a", "./plugins/local", "./plugins/b"] })
  assert.equal(fs.existsSync(path.join(target, ".agent-manager/pipeline-profiles.json")), false)
  assert.equal(fs.existsSync(path.join(target, "export/categories/go-pipeline")), false, "the emptied bundle directory is pruned")
  assert.equal(read("export/categories/docs/README.md"), "keep\n")
  assert.deepEqual(compareSharedSync({ sourceRoot: source, targetRoot: target }).alignment, [], "a second sync has nothing to align")
})

test("a release bundle carries retired files and alignment sources", () => {
  const source = createRepo(makeTempRoot())
  writePipelineSource(source)
  writeAlignmentSource(source)
  writeFile(source, "src/tools/_pipeline_gone.js", "export const gone = true\n")
  gitCommitAll(source)
  fs.rmSync(path.join(source, "src/tools/_pipeline_gone.js"))
  execFileSync("git", ["-C", source, "commit", "-qam", "remove helper"])
  const bundle = path.join(makeTempRoot(), "release")
  const index = releaseSharedSync({ sourceRoot: source, outputDir: bundle })
  assert.deepEqual(index.retired, [{ component: "pipelineCore", path: "src/tools/_pipeline_gone.js" }])
  assert.ok(index.alignment.some((entry: any) => entry.path === ".agent-manager/agent-routing.json"))

  const target = createRepo(makeTempRoot())
  writeFile(target, "src/tools/_pipeline_gone.js", "export const gone = true\n")
  gitCommitAll(target)
  const result = applySharedSync({ sourceRoot: bundle, targetRoot: target })
  assert.deepEqual(result.removed, ["src/tools/_pipeline_gone.js"])
  assert.ok(fs.existsSync(path.join(target, ".agent-manager/agent-routing.json")))

  fs.writeFileSync(path.join(bundle, "files", ".agent-manager", "agent-routing.json"), "tampered\n")
  assert.throws(() => compareSharedSync({ sourceRoot: bundle, targetRoot: target }), /hash mismatch/)
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
