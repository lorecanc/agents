import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { DEFAULT_COMPANION_LINKS } from "./companionLinks.js"

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
