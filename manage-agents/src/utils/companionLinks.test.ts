import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { DEFAULT_COMPANION_LINKS, discoverAvailableCategoryCompanionItems, getCategoryCompanionLinks, updateCategoryCompanionLinks } from "./companionLinks.js"
import { loadCategoryManifest, validateCategoryManifest } from "./categoryDistribution.js"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")

test("default companion links ship V2 plugin directories, not plugin files", () => {
  assert.deepEqual(DEFAULT_COMPANION_LINKS.categories.pipeline.plugins, [
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
  assert.ok(pipeline.tools.includes("tools/pipeline_env.ts"))
  assert.ok(pipeline.commands.includes("commands/pipeline-init.md"))
  assert.deepEqual(config.categories.wiki.commands, ["commands/wiki.md"])
  assert.ok(fs.existsSync(path.join(repoRoot, "src", "tools", "pipeline_env.ts")))
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

test("updateCategoryCompanionLinks does not sync through a symlinked category manifest", (t) => {
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

test("updateCategoryCompanionLinks does not sync through a symlinked categories directory", (t) => {
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

test("updateCategoryCompanionLinks rejects a symlinked .agent-manager without modifying category manifests", (t) => {
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
