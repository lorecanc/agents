import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test, { type TestContext } from "node:test"
import { bridgePack, prepareBridgeWorkspace } from "./bridgeWorkspace.js"
import { DEFAULT_TRANSLATION_CONFIG, type TranslationConfig } from "./translationConfig.js"

const manifest = (name: string, requires: Record<string, string> = {}) =>
  JSON.stringify({ contract: "1.0", name, version: "1.0.0", description: "x", requires })

const agent = (description: string, mode = "subagent") => `---\ndescription: ${description}\nmode: ${mode}\n---\n\n${description}.\n`

/** A catalog where `app` requires `lib` and `extra`, and `lib` requires `base`. */
const CATALOG: Record<string, string> = {
  "packs/base/opencode-pack.json": manifest("base"),
  "packs/base/opencode.json": JSON.stringify({ mcp: { servers: { shared: { type: "local", command: ["base-mcp"] } } }, lsp: { md: { command: ["marksman"], extensions: [".md"] } } }),
  "packs/base/skills/base-writing/SKILL.md": "---\nname: base-writing\ndescription: Writing rules\n---\n\nWrite well.\n",
  "packs/base/AGENTS.md": "# base\n",
  "packs/lib/opencode-pack.json": manifest("lib", { base: "^1.0.0" }),
  "packs/lib/opencode.jsonc": `{\n  // later packs win\n  "mcp": { "servers": { "shared": { "type": "local", "command": ["lib-mcp"] }, "lib-only": { "type": "local", "command": ["lib-only"] } } },\n}\n`,
  "packs/lib/agents/lib-helper.md": agent("Library helper"),
  "packs/lib/tools/lib/lib_tool.ts": "export default {}\n",
  "packs/lib/tools/lib/lib_tool.test.mjs": "\n",
  "packs/lib/tools/lib/__pycache__/cache.pyc": "\n",
  "packs/lib/README.md": "# lib\n",
  "packs/extra/opencode-pack.json": manifest("extra"),
  "packs/extra/commands/extra-run.md": "---\ndescription: Run extra\n---\nRun $ARGUMENTS.\n",
  "packs/app/opencode-pack.json": manifest("app", { lib: "^1.0.0", extra: "^1.0.0" }),
  "packs/app/agents/app-orchestrator.md": agent("App orchestrator", "primary"),
  "packs/app/agents/app-worker.md": agent("App worker"),
  "packs/app/plugins/app-guard/index.ts": "export default {}\n",
  "packs/unrelated/opencode-pack.json": manifest("unrelated"),
  "packs/unrelated/agents/unrelated-agent.md": agent("Unrelated")
}

function writeCatalog(t: TestContext, files: Record<string, string> = CATALOG): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-workspace-catalog-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const [relative, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true })
    fs.writeFileSync(path.join(root, relative), content)
  }
  return root
}

function tempDir(t: TestContext, prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function listFiles(root: string): string[] {
  return (fs.readdirSync(root, { recursive: true }) as string[])
    .filter(relative => fs.statSync(path.join(root, relative)).isFile())
    .map(relative => relative.split(path.sep).join("/"))
    .sort()
}

const config: TranslationConfig = { ...DEFAULT_TRANSLATION_CONFIG, claude: { ...DEFAULT_TRANSLATION_CONFIG.claude, autoValidate: false, autoRegister: false } }

test("prepareBridgeWorkspace merges the pack closure into one installable tree", (t) => {
  const catalog = writeCatalog(t)
  const workspace = prepareBridgeWorkspace(catalog, "app")
  t.after(workspace.cleanup)

  assert.deepEqual(listFiles(workspace.root), [
    "agents/app-orchestrator.md",
    "agents/app-worker.md",
    "agents/lib-helper.md",
    "commands/extra-run.md",
    "opencode.json",
    "plugins/app-guard/index.ts",
    "skills/base-writing/SKILL.md",
    "tools/lib/lib_tool.ts"
  ])
})

test("prepareBridgeWorkspace merges MCP and LSP declarations with later packs winning", (t) => {
  const catalog = writeCatalog(t)
  const workspace = prepareBridgeWorkspace(catalog, "app")
  t.after(workspace.cleanup)

  const merged = JSON.parse(fs.readFileSync(path.join(workspace.root, "opencode.json"), "utf8"))
  assert.deepEqual(merged, {
    mcp: { servers: { shared: { type: "local", command: ["lib-mcp"] }, "lib-only": { type: "local", command: ["lib-only"] } } },
    lsp: { md: { command: ["marksman"], extensions: [".md"] } }
  })
})

test("prepareBridgeWorkspace returns only the requested pack's agents, parsed from the temp tree", (t) => {
  const catalog = writeCatalog(t)
  const workspace = prepareBridgeWorkspace(catalog, "app")
  t.after(workspace.cleanup)

  assert.deepEqual(workspace.agents.map(agent => agent.filename), ["app-orchestrator.md", "app-worker.md"])
  for (const agent of workspace.agents) {
    assert.equal(agent.category, "app")
    assert.ok(agent.currentPath.startsWith(`${workspace.root}${path.sep}`), agent.currentPath)
  }
  assert.equal(workspace.agents[0].frontmatter.mode, "primary")
})

test("prepareBridgeWorkspace cleanup removes the temp tree", (t) => {
  const catalog = writeCatalog(t)
  const workspace = prepareBridgeWorkspace(catalog, "app")
  workspace.cleanup()
  assert.equal(fs.existsSync(workspace.root), false)
})

test("prepareBridgeWorkspace rejects a missing requirement and files provided by two packs", (t) => {
  const missing = writeCatalog(t, { ...CATALOG, "packs/app/opencode-pack.json": manifest("app", { ghost: "^1.0.0" }) })
  assert.throws(() => prepareBridgeWorkspace(missing, "app"), /ghost/)
  assert.throws(() => prepareBridgeWorkspace(missing, "nope"), /nope/)

  const clash = writeCatalog(t, { ...CATALOG, "packs/extra/skills/base-writing/SKILL.md": "---\ndescription: Clash\n---\n" })
  assert.throws(() => prepareBridgeWorkspace(clash, "app"), /Packs '(base|extra)' and '(base|extra)' both provide 'skills\/base-writing\/SKILL\.md'/)
})

test("bridgePack mirrors the Claude plugin into an output directory outside the catalog", (t) => {
  const catalog = writeCatalog(t)
  const outputDir = path.join(tempDir(t, "bridge-workspace-out-"), "app-plugin")
  fs.mkdirSync(path.join(outputDir, "agents"), { recursive: true })
  fs.writeFileSync(path.join(outputDir, "agents", "stale.md"), "stale\n")
  fs.writeFileSync(path.join(outputDir, "notes.txt"), "stale\n")

  const result = bridgePack({ workspaceRoot: catalog, pack: "app", target: "claude", outputDir, config, pluginName: "app-plugin", prefix: "app-" })

  assert.equal(result.pluginDir, outputDir)
  assert.equal(result.orchestratorName, "orchestrator")
  assert.deepEqual([...result.files].sort(), listFiles(outputDir))
  assert.deepEqual(fs.readdirSync(path.join(outputDir, "agents")).sort(), ["orchestrator.md", "worker.md"])
  assert.equal(fs.existsSync(path.join(outputDir, "notes.txt")), false)
  assert.ok(fs.existsSync(path.join(outputDir, "skills", "extra-run", "SKILL.md")), "commands of required packs become skills")
  assert.ok(fs.existsSync(path.join(outputDir, "skills", "base-writing", "SKILL.md")), "skills of required packs are copied")
  const readme = fs.readFileSync(path.join(outputDir, "README.md"), "utf8")
  assert.match(readme, /plugins\/app-guard/)
  assert.match(readme, /tools\/lib\/lib_tool\.ts/)
  assert.match(readme, /claude plugin validate '\.\/app-plugin' --strict/)
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(outputDir, ".mcp.json"), "utf8")).mcpServers), ["shared", "lib-only"])
})

test("bridgePack leaves unchanged files untouched on regeneration", (t) => {
  const catalog = writeCatalog(t)
  const outputDir = path.join(catalog, "bridges", "claude-code", "app-plugin")
  const options = { workspaceRoot: catalog, pack: "app", target: "claude", outputDir, config, pluginName: "app-plugin", prefix: "app-" } as const
  bridgePack(options)
  const agentPath = path.join(outputDir, "agents", "worker.md")
  const past = new Date(Date.now() - 60_000)
  fs.utimesSync(agentPath, past, past)

  bridgePack(options)

  assert.equal(fs.statSync(agentPath).mtimeMs, past.getTime())
  assert.match(fs.readFileSync(path.join(outputDir, "README.md"), "utf8"), /'\.\/bridges\/claude-code\/app-plugin'/)
})

test("bridgePack reports Codex files at the final output directory", (t) => {
  const catalog = writeCatalog(t)
  const outputDir = path.join(tempDir(t, "bridge-workspace-codex-"), "codex")

  const result = bridgePack({ workspaceRoot: catalog, pack: "app", target: "codex", outputDir, config, pluginName: "app-plugin", prefix: "app-" })

  assert.equal(result.pluginDir, outputDir)
  assert.deepEqual(result.files.map(file => path.relative(outputDir, file).split(path.sep).join("/")).sort(), listFiles(outputDir))
  assert.ok(fs.existsSync(path.join(outputDir, ".codex", "agents", "orchestrator.toml")))
})

test("bridgePack refuses output directories that contain the catalog or sit inside a pack", (t) => {
  const catalog = writeCatalog(t)
  const options = { workspaceRoot: catalog, pack: "app", target: "claude", config, pluginName: "app-plugin", prefix: "app-" } as const
  assert.throws(() => bridgePack({ ...options, outputDir: catalog }), /must not contain the catalog/)
  assert.throws(() => bridgePack({ ...options, outputDir: path.dirname(catalog) }), /must not contain the catalog/)
  assert.throws(() => bridgePack({ ...options, outputDir: path.join(catalog, "packs", "app", "out") }), /inside a pack/)
  assert.ok(fs.existsSync(path.join(catalog, "packs", "app", "agents", "app-worker.md")))
})

test("bridgePack refuses an output inside the catalog reached through a symlink", { skip: process.platform === "win32" }, (t) => {
  const catalog = writeCatalog(t)
  const outside = tempDir(t, "bridge-link-target-")
  fs.symlinkSync(outside, path.join(catalog, "bridges"))

  assert.throws(() => bridgePack({ workspaceRoot: catalog, pack: "app", target: "claude", config, pluginName: "app-plugin", prefix: "app-", outputDir: path.join(catalog, "bridges", "claude-code", "app-plugin") }), /goes through the symlink/)
  assert.deepEqual(fs.readdirSync(outside), [])
})
