import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { inventory } from "../test/golden/inventory.js"
import { changeTarget, installChange } from "../src/utils/installer.js"
import { addSource, type SourceRegistry } from "../src/utils/sources.js"
import { apply, destination, rewriteImport, type MigrationMap } from "./migrate-to-packs.js"

test("destination keeps native paths and namespaces everything else", () => {
  assert.equal(destination("agents/flow-build.md", "flow"), "agents/flow-build.md")
  assert.equal(destination("tools/pptx/thumbnail.py", "office-tools"), "tools/office-tools/pptx/thumbnail.py")
  assert.equal(destination("requirements.txt", "office-tools"), "resources/office-tools/requirements.txt")
  assert.equal(destination("AGENTS.md", "common"), "AGENTS.md")
})

test("rewriteImport follows both files to their new places, keeping .js specifiers for .ts files", () => {
  const moved = new Map([["tools/_tool.ts", "tools/toolkit/_tool.ts"], ["tools/doc_view.ts", "tools/office-tools/doc_view.ts"], ["plugins/doc-tools/index.ts", "plugins/doc-tools/index.ts"]])
  assert.deepEqual(rewriteImport("plugins/doc-tools/index.ts", "plugins/doc-tools/index.ts", "../../tools/_tool.js", moved), { spec: "../../tools/toolkit/_tool.js", target: "tools/_tool.ts" })
  assert.deepEqual(rewriteImport("tools/doc_view.ts", "tools/office-tools/doc_view.ts", "./_tool.js", moved), { spec: "../toolkit/_tool.js", target: "tools/_tool.ts" })
  assert.deepEqual(rewriteImport("tools/doc_view.ts", "tools/office-tools/doc_view.ts", "./unknown.js", moved), { spec: "./unknown.js" })
})

const MAP = fileURLToPath(new URL("./migration-map.json", import.meta.url))

test("the reviewed map migrates the real catalog into valid packs that install what the legacy export installed", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "manage-agents-migration-"))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const map = JSON.parse(fs.readFileSync(MAP, "utf8")) as MigrationMap
  const result = apply(map, path.join(base, "packs"))
  for (const [pack, { validation }] of Object.entries(result.packs)) {
    assert.deepEqual(validation.issues.filter(issue => issue.level === "error"), [], pack)
  }

  const env = { ...process.env, XDG_CONFIG_HOME: path.join(base, "config"), XDG_CACHE_HOME: path.join(base, "cache") }
  const registry: SourceRegistry = { schemaVersion: 1, sources: [], prefer: {} }
  addSource(registry, "catalog", path.join(base, "packs"), { trusted: true })
  const target = path.join(base, "target")
  const roots = Object.keys(JSON.parse(fs.readFileSync(MAP, "utf8")).categories).concat("general")
  const installed = await changeTarget(target, "install", registry, installChange(registry, roots, env), { env, confirm: async () => true })
  assert.equal(installed.status, "applied", JSON.stringify(installed.plan?.conflicts ?? installed.change?.problems))

  const before = JSON.parse(fs.readFileSync(new URL("../test/golden/export-before.json", import.meta.url), "utf8")).structure
  const after = inventory(target).structure
  const swapRouter = (ids: string[]) => ids.map(id => id === "agent-router" ? "manage-agents-router" : id).sort()
  assert.deepEqual(after.ids.agents, before.ids.agents)
  assert.deepEqual(after.ids.skills, before.ids.skills)
  assert.deepEqual(after.ids.plugins, swapRouter(before.ids.plugins))
  assert.deepEqual(after.ids.commands, [...before.ids.commands, "ports-plan"].sort(), "ports-plan was in src/commands but no category shipped it")
  assert.deepEqual(after.config.mcpServers, ["codebase-memory-mcp"], "the legacy export did not install MCP servers")

  const router = /^(?:plugins\/agent-router\/|tools\/_agent_router\.js$)/
  const expected = before.files.filter((file: string) => file !== "opencode.json" && !router.test(file)).map((file: string) => destination(file, map.files[file] ?? "?")).sort()
  assert.deepEqual(expected.filter((file: string) => !after.files.includes(file)), [], "every file of the legacy export is installed at its namespaced path")
  const extra = after.files.filter((file: string) => !expected.includes(file))
  assert.deepEqual(extra.filter((file: string) => !/^(?:opencode\.json$|plugins\/manage-agents-router\/|instructions\/common\.md$|commands\/ports-plan\.md$|resources\/[^/]+\/(?:requirements\.txt|THIRD_PARTY_NOTICES\.md)$|\.manage-agents\/)/.test(file)), [])
  assert.deepEqual(after.config.keys, ["$schema", "instructions", "mcp", "plugins"])
  assert.deepEqual(after.config.plugins, swapRouter(before.config.plugins.map((entry: string) => entry.replace("./plugins/", ""))).map(id => `./plugins/${id}`))
})
