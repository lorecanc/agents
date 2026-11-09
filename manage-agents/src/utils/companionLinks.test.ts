import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { DEFAULT_COMPANION_LINKS, discoverAvailableCategoryCompanionItems, getCategoryCompanionLinks, updateCategoryCompanionLinks } from "./companionLinks.js"
import { buildCategoryDistribution, loadCategoryManifest, validateCategoryManifest } from "./categoryDistribution.js"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")

test("default companion links ship V2 plugin directories, not plugin files", () => {
  assert.deepEqual(DEFAULT_COMPANION_LINKS.categories.pipeline.plugins, [
    "plugins/agent-router",
    "plugins/dev-tools",
    "plugins/doc-tools",
    "plugins/pipeline-guard",
    "plugins/pipeline-tools",
    "plugins/slide-tools"
  ])
  assert.equal(JSON.stringify(DEFAULT_COMPANION_LINKS).includes("pipeline-guard" + ".js"), false)
})

test("repository companion links reference the four V2 plugin directories and shipped pipeline files", () => {
  const config = JSON.parse(fs.readFileSync(path.join(repoRoot, ".agent-manager", "companion-links.json"), "utf8"))
  const pipeline = config.categories.pipeline
  for (const plugin of ["plugins/pipeline-guard", "plugins/pipeline-tools", "plugins/doc-tools", "plugins/slide-tools"]) {
    assert.ok(pipeline.plugins.includes(plugin), `${plugin} should be linked`)
  }
  assert.ok(pipeline.tools.includes("tools/dev_env.ts"))
  assert.ok(pipeline.commands.includes("commands/pipeline-init.md"))
  assert.deepEqual(config.categories.wiki.commands, ["commands/wiki.md"])
  assert.ok(fs.existsSync(path.join(repoRoot, "src", "tools", "dev_env.ts")))
  assert.ok(fs.existsSync(path.join(repoRoot, "src", "commands", "pipeline-init.md")))
})

test("no .agent-manager manifest references the deleted legacy plugin file", () => {
  const root = path.join(repoRoot, ".agent-manager")
  const offenders: string[] = []
  const legacy = "pipeline-guard" + ".js"
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(absolute)
      else if (entry.isFile() && fs.readFileSync(absolute, "utf8").includes(legacy)) offenders.push(path.relative(repoRoot, absolute))
    }
  }
  visit(root)
  assert.deepEqual(offenders, [])
})

test("discoverAvailableCategoryCompanionItems lists index.ts and index.js plugin directories and ignores single-file plugins", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "companion-links-plugins-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  for (const [directory, entry] of [["ts-plugin", "index.ts"], ["js-plugin", "index.js"]]) {
    const plugin = path.join(root, "src", "plugins", directory)
    fs.mkdirSync(plugin, { recursive: true })
    fs.writeFileSync(path.join(plugin, entry), "export default 1\n")
  }
  fs.mkdirSync(path.join(root, "src", "plugins"), { recursive: true })
  fs.writeFileSync(path.join(root, "src", "plugins", "legacy.js"), "export default 1\n")

  const plugins = discoverAvailableCategoryCompanionItems(root, "src")
    .filter(item => item.group === "plugin")
    .map(item => item.relativePath)
  assert.ok(plugins.includes("plugins/ts-plugin"))
  assert.ok(plugins.includes("plugins/js-plugin"))
  assert.equal(plugins.includes("plugins/legacy.js"), false)
})

test("DEFAULT_COMPANION_LINKS includes wiki and updateCategoryCompanionLinks syncs schemaVersion 2 category manifest plugins", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "companion-links-manifest-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const wikiLinks = getCategoryCompanionLinks(root, "wiki")
  const expectedWikiSkills = ["skills/wiki-conventions", "skills/wiki-navigate", "skills/wiki-templates"]

  const categories = path.join(root, ".agent-manager", "categories")
  fs.mkdirSync(categories, { recursive: true })
  fs.writeFileSync(path.join(categories, "docs.json"), JSON.stringify({
    schemaVersion: 2,
    distributionVersion: "2.0.0",
    id: "docs",
    title: "Documentation",
    description: "Documentation tools",
    output: "export/categories/docs",
    resources: [{ kind: "directory", source: "src/plugins/doc-tools", target: "plugins/doc-tools", policy: "text" }],
    generated: []
  }))
  fs.mkdirSync(path.join(root, "src", "plugins", "doc-tools"), { recursive: true })
  fs.mkdirSync(path.join(root, "src", "plugins", "slide-tools"), { recursive: true })
  fs.writeFileSync(path.join(root, "src", "plugins", "doc-tools", "index.ts"), "export default 1\n")
  fs.writeFileSync(path.join(root, "src", "plugins", "slide-tools", "index.ts"), "export default 1\n")

  updateCategoryCompanionLinks(root, "docs", {
    plugins: ["plugins/doc-tools", "plugins/slide-tools"],
    tools: [],
    commands: [],
    skills: []
  })

  const manifest = loadCategoryManifest(root, "docs")
  const slideTools = manifest.resources.find(resource => resource.target === "plugins/slide-tools")
  assert.equal(slideTools?.policy, "runtime")
  assert.doesNotThrow(() => validateCategoryManifest(manifest, root))
  const manifestHasSlideTools = slideTools?.kind === "directory" && slideTools.source === "src/plugins/slide-tools"
  assert.deepEqual({
    wikiCommands: wikiLinks.commands,
    wikiSkillsIncluded: expectedWikiSkills.map(skill => wikiLinks.skills.includes(skill)),
    manifestHasSlideTools
  }, {
    wikiCommands: ["commands/wiki.md"],
    wikiSkillsIncluded: [true, true, true],
    manifestHasSlideTools: true
  })
})

test("updateCategoryCompanionLinks syncs linked resources and transitive tool dependencies", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "companion-links-resources-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const categories = path.join(root, ".agent-manager", "categories")
  const source = path.join(root, "src")
  fs.mkdirSync(categories, { recursive: true })
  fs.mkdirSync(path.join(source, "plugins", "doc-tools"), { recursive: true })
  fs.mkdirSync(path.join(source, "skills", "docs-design"), { recursive: true })
  fs.mkdirSync(path.join(source, "tools"), { recursive: true })
  fs.writeFileSync(path.join(source, "plugins", "doc-tools", "index.ts"), "export {}\n")
  fs.writeFileSync(path.join(source, "skills", "docs-design", "SKILL.md"), "# Docs design\n")
  fs.writeFileSync(path.join(source, "tools", "doc_create.ts"), 'import "./_python.js"\nopencodePath("_doc_theme.template.css")\n')
  fs.writeFileSync(path.join(source, "tools", "_python.js"), 'import "./_paths.js"\n')
  fs.writeFileSync(path.join(source, "tools", "_paths.js"), "export {}\n")
  fs.writeFileSync(path.join(source, "tools", "_doc_theme.template.css"), "body {}\n")

  fs.writeFileSync(path.join(categories, "docs.json"), JSON.stringify({
    schemaVersion: 2,
    distributionVersion: "2.0.0",
    id: "docs",
    title: "Documentation",
    description: "Documentation tools",
    output: "export/categories/docs",
    resources: [
      { kind: "directory", source: "src/plugins/doc-tools", target: "plugins/doc-tools", policy: "text" },
      { kind: "file", source: "src/tools/doc_create.ts", target: "tools/doc_create.ts", policy: "runtime" }
    ],
    generated: []
  }))
  fs.writeFileSync(path.join(categories, "wiki.json"), JSON.stringify({
    schemaVersion: 2,
    resources: [{ kind: "file", source: "src/skills/wiki-conventions/SKILL.md", target: "skills/wiki-conventions/SKILL.md", policy: "text" }]
  }))
  fs.mkdirSync(path.join(source, "skills", "wiki-conventions"), { recursive: true })
  fs.writeFileSync(path.join(source, "skills", "wiki-conventions", "SKILL.md"), "# Wiki conventions\n")

  updateCategoryCompanionLinks(root, "docs", {
    plugins: ["plugins/doc-tools"],
    commands: [],
    skills: ["skills/docs-design"],
    tools: ["tools/doc_create.ts"]
  })
  updateCategoryCompanionLinks(root, "wiki", {
    plugins: [],
    commands: [],
    skills: ["skills/wiki-conventions"],
    tools: []
  })

  const manifest = loadCategoryManifest(root, "docs")
  const resourcesByTarget = new Map(manifest.resources.map(resource => [resource.target, resource]))
  assert.equal(resourcesByTarget.get("plugins/doc-tools")?.policy, "text")
  assert.equal(resourcesByTarget.get("tools/doc_create.ts")?.policy, "runtime")
  for (const target of ["skills/docs-design", "tools/_python.js", "tools/_paths.js", "tools/_doc_theme.template.css"]) {
    assert.equal(resourcesByTarget.get(target)?.policy, "text", `${target} should be included as text`)
  }
  const wikiResources = JSON.parse(fs.readFileSync(path.join(categories, "wiki.json"), "utf8")).resources
  assert.deepEqual(wikiResources.map((resource: { target: string }) => resource.target), ["skills/wiki-conventions/SKILL.md"])
})

test("linked directories with binary files use a safe distribution policy", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "companion-links-binary-directory-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const categories = path.join(root, ".agent-manager", "categories")
  const source = path.join(root, "src")
  fs.mkdirSync(categories, { recursive: true })
  fs.mkdirSync(path.join(source, "tools", "assets"), { recursive: true })
  fs.writeFileSync(path.join(source, "tools", "assets", "readme.md"), "Asset notes\n")
  fs.writeFileSync(path.join(source, "tools", "assets", "image.bin"), Buffer.from([0, 255, 128, 1]))
  fs.writeFileSync(path.join(categories, "docs.json"), JSON.stringify({
    schemaVersion: 2,
    distributionVersion: "2.0.0",
    id: "docs",
    title: "Documentation",
    description: "Documentation tools",
    output: "export/categories/docs",
    resources: [],
    generated: []
  }))

  updateCategoryCompanionLinks(root, "docs", {
    plugins: [],
    commands: [],
    skills: [],
    tools: ["tools/assets"]
  })

  const manifest = loadCategoryManifest(root, "docs")
  const assets = manifest.resources.find(resource => resource.target === "tools/assets")
  assert.equal(assets?.policy, "mixed")
  assert.deepEqual(assets?.extensions, [".md"])
  assert.equal(buildCategoryDistribution(root, "docs").status, "current")
})

test("linked binary-extension files with valid UTF-8 bytes preserve their bytes", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "companion-links-binary-file-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const categories = path.join(root, ".agent-manager", "categories")
  const source = path.join(root, "src", "tools")
  const bytes = Buffer.from("first\r\nsecond\r\n", "utf8")
  fs.mkdirSync(categories, { recursive: true })
  fs.mkdirSync(source, { recursive: true })
  fs.writeFileSync(path.join(source, "payload.bin"), bytes)
  fs.writeFileSync(path.join(categories, "docs.json"), JSON.stringify({
    schemaVersion: 2,
    distributionVersion: "2.0.0",
    id: "docs",
    title: "Documentation",
    description: "Documentation tools",
    output: "export/categories/docs",
    resources: [],
    generated: []
  }))

  updateCategoryCompanionLinks(root, "docs", {
    plugins: [],
    commands: [],
    skills: [],
    tools: ["tools/payload.bin"]
  })

  const manifest = loadCategoryManifest(root, "docs")
  assert.equal(manifest.resources.find(resource => resource.target === "tools/payload.bin")?.policy, "binary")
  assert.equal(buildCategoryDistribution(root, "docs").status, "current")
  assert.deepEqual(fs.readFileSync(path.join(root, "export/categories/docs/tools/payload.bin")), bytes)
})

test("linked directories replace partial child resources with full directory coverage", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "companion-links-partial-directory-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const categories = path.join(root, ".agent-manager", "categories")
  const source = path.join(root, "src", "tools", "assets")
  fs.mkdirSync(categories, { recursive: true })
  fs.mkdirSync(source, { recursive: true })
  fs.writeFileSync(path.join(source, "readme.md"), "Asset notes\n")
  fs.writeFileSync(path.join(source, "details.txt"), "More details\n")
  fs.writeFileSync(path.join(categories, "docs.json"), JSON.stringify({
    schemaVersion: 2,
    distributionVersion: "2.0.0",
    id: "docs",
    title: "Documentation",
    description: "Documentation tools",
    output: "export/categories/docs",
    resources: [
      { kind: "file", source: "src/tools/assets/readme.md", target: "tools/assets/readme.md", policy: "text" }
    ],
    generated: []
  }))

  updateCategoryCompanionLinks(root, "docs", {
    plugins: [],
    commands: [],
    skills: [],
    tools: ["tools/assets"]
  })

  const manifest = loadCategoryManifest(root, "docs")
  assert.deepEqual(manifest.resources.map(resource => [resource.kind, resource.target]), [["directory", "tools/assets"]])
  assert.doesNotThrow(() => validateCategoryManifest(manifest, root))
  assert.equal(buildCategoryDistribution(root, "docs").status, "current")
  assert.equal(fs.readFileSync(path.join(root, "export/categories/docs/tools/assets/readme.md"), "utf8"), "Asset notes\n")
  assert.equal(fs.readFileSync(path.join(root, "export/categories/docs/tools/assets/details.txt"), "utf8"), "More details\n")
})

test("linked tool dependencies reconcile an existing source mapped to another target", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "companion-links-target-reconcile-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const categories = path.join(root, ".agent-manager", "categories")
  const source = path.join(root, "src", "tools")
  fs.mkdirSync(categories, { recursive: true })
  fs.mkdirSync(source, { recursive: true })
  fs.writeFileSync(path.join(source, "main.ts"), 'import "./_helper.js"\nexport {}\n')
  fs.writeFileSync(path.join(source, "_helper.ts"), "export {}\n")
  fs.writeFileSync(path.join(categories, "docs.json"), JSON.stringify({
    schemaVersion: 2,
    distributionVersion: "2.0.0",
    id: "docs",
    title: "Documentation",
    description: "Documentation tools",
    output: "export/categories/docs",
    resources: [
      { kind: "file", source: "src/tools/main.ts", target: "tools/main.ts", policy: "text" },
      { kind: "file", source: "src/tools/_helper.ts", target: "tools/legacy_helper.ts", policy: "text" }
    ],
    generated: []
  }))

  updateCategoryCompanionLinks(root, "docs", {
    plugins: [],
    commands: [],
    skills: [],
    tools: ["tools/main.ts"]
  })

  const manifest = loadCategoryManifest(root, "docs")
  const helperResources = manifest.resources.filter(resource => resource.source === "src/tools/_helper.ts")
  assert.equal(helperResources.length, 1)
  assert.equal(helperResources[0].target, "tools/_helper.ts")
  assert.doesNotThrow(() => validateCategoryManifest(manifest, root))
})

test("updateCategoryCompanionLinks does not sync a manifest outside categories for traversal categories", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "companion-links-traversal-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  fs.mkdirSync(path.join(root, ".agent-manager", "categories"), { recursive: true })
  const outsideManifestPath = path.join(root, "outside.json")
  const originalManifest = `${JSON.stringify({
    schemaVersion: 2,
    resources: [{ kind: "directory", source: "src/plugins/original", target: "plugins/original", policy: "runtime" }]
  }, null, 2)}\n`
  fs.writeFileSync(outsideManifestPath, originalManifest)

  updateCategoryCompanionLinks(root, "../../outside", { plugins: [] })

  assert.equal(fs.readFileSync(outsideManifestPath, "utf-8"), originalManifest)
})

test("updateCategoryCompanionLinks does not sync through a symlinked category manifest", { skip: process.platform === "win32" }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "companion-links-symlink-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const categoriesDirectory = path.join(root, ".agent-manager", "categories")
  fs.mkdirSync(categoriesDirectory, { recursive: true })
  const targetManifestPath = path.join(root, "target.json")
  const originalManifest = `${JSON.stringify({
    schemaVersion: 2,
    resources: [{ kind: "directory", source: "src/plugins/original", target: "plugins/original", policy: "runtime" }]
  }, null, 2)}\n`
  fs.writeFileSync(targetManifestPath, originalManifest)
  const manifestPath = path.join(categoriesDirectory, "docs.json")
  fs.symlinkSync(targetManifestPath, manifestPath)

  updateCategoryCompanionLinks(root, "docs", { plugins: [] })

  assert.equal(fs.readFileSync(targetManifestPath, "utf-8"), originalManifest)
  assert.equal(fs.lstatSync(manifestPath).isSymbolicLink(), true)
})

test("updateCategoryCompanionLinks does not sync through a symlinked categories directory", { skip: process.platform === "win32" }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "companion-links-symlink-categories-"))
  const outsideDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "companion-links-symlink-categories-outside-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  t.after(() => fs.rmSync(outsideDirectory, { recursive: true, force: true }))

  const managerDirectory = path.join(root, ".agent-manager")
  fs.mkdirSync(managerDirectory)
  const outsideManifestPath = path.join(outsideDirectory, "docs.json")
  const originalManifest = `${JSON.stringify({
    schemaVersion: 2,
    resources: [{ kind: "directory", source: "src/plugins/original", target: "plugins/original", policy: "runtime" }]
  }, null, 2)}\n`
  fs.writeFileSync(outsideManifestPath, originalManifest)
  const categoriesDirectory = path.join(managerDirectory, "categories")
  fs.symlinkSync(outsideDirectory, categoriesDirectory)

  updateCategoryCompanionLinks(root, "docs", { plugins: [] })

  assert.equal(fs.readFileSync(outsideManifestPath, "utf-8"), originalManifest)
  assert.equal(fs.lstatSync(categoriesDirectory).isSymbolicLink(), true)
})

test("updateCategoryCompanionLinks rejects a symlinked .agent-manager without modifying category manifests", { skip: process.platform === "win32" }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "companion-links-symlink-manager-"))
  const outsideManagerDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "companion-links-symlink-manager-outside-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  t.after(() => fs.rmSync(outsideManagerDirectory, { recursive: true, force: true }))

  const categoriesDirectory = path.join(outsideManagerDirectory, "categories")
  fs.mkdirSync(categoriesDirectory)
  const outsideManifestPath = path.join(categoriesDirectory, "docs.json")
  const originalManifest = `${JSON.stringify({
    schemaVersion: 2,
    resources: [{ kind: "directory", source: "src/plugins/original", target: "plugins/original", policy: "runtime" }]
  }, null, 2)}\n`
  fs.writeFileSync(outsideManifestPath, originalManifest)
  const managerDirectory = path.join(root, ".agent-manager")
  fs.symlinkSync(outsideManagerDirectory, managerDirectory)

  assert.throws(() => updateCategoryCompanionLinks(root, "docs", { plugins: [] }), /Companion links path must not be a symlink/)

  assert.equal(fs.readFileSync(outsideManifestPath, "utf-8"), originalManifest)
})
