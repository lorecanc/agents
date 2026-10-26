import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { findAgentFiles } from "./agents.js"
import { bridgeToClaudeCode } from "./bridge.js"
import { checkBridge, compareTrees } from "./bridgeCheck.js"
import { DEFAULT_TRANSLATION_CONFIG, type TranslationConfig } from "./translationConfig.js"

/**
 * Expected `bridgeCheck` module API (specification for the implementer).
 *
 * ```ts
 * export type TreeSnapshot = Record<string, string | Uint8Array> // relative POSIX path -> bytes
 *
 * export interface TreeDiff {
 *   missing: string[] // paths present in `expected`, absent from `actual`
 *   changed: string[] // paths present in both whose bytes differ (byte-exact, no normalization)
 *   extra: string[]   // paths present in `actual`, absent from `expected`
 * }
 *
 * export interface BridgeCheckOptions {
 *   workspaceRoot: string
 *   target: "claude" | "codex"
 *   category: string
 *   config: TranslationConfig
 *   committedDir: string // committed bridge output; lives inside `workspaceRoot`
 * }
 *
 * export interface BridgeCheckResult extends TreeDiff { clean: boolean }
 *
 * export function compareTrees(expected: TreeSnapshot, actual: TreeSnapshot): TreeDiff
 * export function checkBridge(options: BridgeCheckOptions): BridgeCheckResult
 * ```
 *
 * Rules:
 * - `compareTrees` is pure, works on in-memory snapshots (relative POSIX paths), and returns
 *   all three lists sorted.
 * - `checkBridge` discovers the agents of `category` under `workspaceRoot` (using
 *   `config.sourceDir`), regenerates the expected bridge in a fresh
 *   `fs.mkdtempSync(path.join(os.tmpdir(), "bridge-check-"))` root, and compares it byte-exact
 *   with `committedDir`. The temp root mirrors the workspace inputs the bridge reads
 *   (agent sources, `opencode.json`, companion links, assets), and the expected tree is
 *   written at `path.relative(workspaceRoot, committedDir)` inside that temp root so
 *   path-embedding artifacts such as the generated `README.md` stay comparable.
 * - `clean` is true only when all three lists are empty.
 */

const AGENT_FILES: Record<string, string> = {
  "pipeline-orchestrator.md": [
    "---",
    "description: Pipeline orchestrator",
    "mode: primary",
    "model: github-copilot/claude-opus-5",
    "permission:",
    "  read: allow",
    "  task:",
    '    "*": deny',
    '    "pipeline-planner": allow',
    "---",
    "",
    "Orchestrate the pipeline work.",
    ""
  ].join("\n"),
  "pipeline-planner.md": [
    "---",
    "description: Pipeline planner",
    "mode: subagent",
    "model: github-copilot/gpt-5.6-luna-max",
    "permission:",
    "  read: allow",
    "  task:",
    '    "*": deny',
    "---",
    "",
    "Plan the pipeline work.",
    ""
  ].join("\n")
}

function claudeConfig(): TranslationConfig {
  return {
    ...DEFAULT_TRANSLATION_CONFIG,
    target: "claude",
    pluginName: "decent-pipeline",
    prefix: "pipeline-",
    sourceDir: "src",
    claude: {
      ...DEFAULT_TRANSLATION_CONFIG.claude,
      autoValidate: false,
      autoRegister: false
    }
  }
}

/** Create a throwaway workspace holding the two source agents of the `pipeline` category. */
function writeWorkspace(prefix: string): string {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const agentsDir = path.join(workspace, "src", "agents")
  fs.mkdirSync(agentsDir, { recursive: true })
  for (const [filename, content] of Object.entries(AGENT_FILES)) {
    fs.writeFileSync(path.join(agentsDir, filename), content)
  }
  return workspace
}

function bridgeOutputDir(workspace: string): string {
  return path.join(workspace, "export", "bridges", "claude-code", "decent-pipeline")
}

/** Generate the bridge the way `manage-agents bridge` does, into the committed location. */
function generateBridge(workspace: string): string {
  const config = claudeConfig()
  const agents = findAgentFiles(workspace, "src").filter(agent => agent.category === "pipeline")
  assert.equal(agents.length, Object.keys(AGENT_FILES).length)
  const output = bridgeOutputDir(workspace)
  bridgeToClaudeCode(agents, config.pluginName, config.prefix, output, workspace, config, { category: "pipeline" })
  return output
}

/** Read a directory as a relative POSIX path -> bytes snapshot. */
function readTree(root: string): Record<string, Buffer> {
  const tree: Record<string, Buffer> = {}
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(fullPath)
      } else if (entry.isFile()) {
        tree[path.relative(root, fullPath).split(path.sep).join("/")] = fs.readFileSync(fullPath)
      }
    }
  }
  walk(root)
  return tree
}

test("compareTrees reports identical trees as clean", () => {
  const expected = {
    "README.md": "# decent-pipeline\n",
    "agents/orchestrator.md": "---\nname: orchestrator\n---\n\nOrchestrate.\n",
    ".claude-plugin/plugin.json": "{}\n"
  }
  assert.deepEqual(compareTrees(expected, { ...expected }), { missing: [], changed: [], extra: [] })
})

test("compareTrees flags changed, extra, and missing files", () => {
  const expected = {
    "README.md": "same bytes\n",
    "agents/orchestrator.md": "orchestrator\n",
    "agents/planner.md": "planner\n"
  }
  const actual = {
    "README.md": "same bytes\n",
    // One byte flipped: trailing 'r' -> 'R'.
    "agents/orchestrator.md": "orchestratoR\n",
    // Present only in the regenerated tree.
    "agents/extra.md": "extra\n"
    // "agents/planner.md" is present only in the expected tree.
  }
  assert.deepEqual(compareTrees(expected, actual), {
    missing: ["agents/planner.md"],
    changed: ["agents/orchestrator.md"],
    extra: ["agents/extra.md"]
  })
})

test("bridge regeneration is deterministic", (t) => {
  const first = writeWorkspace("bridge-check-deterministic-a-")
  const second = writeWorkspace("bridge-check-deterministic-b-")
  t.after(() => {
    fs.rmSync(first, { recursive: true, force: true })
    fs.rmSync(second, { recursive: true, force: true })
  })

  const firstTree = readTree(generateBridge(first))
  const secondTree = readTree(generateBridge(second))
  assert.ok(Object.keys(firstTree).length > 0)
  assert.deepEqual(compareTrees(firstTree, secondTree), { missing: [], changed: [], extra: [] })
})

test("checkBridge passes on a clean fixture", (t) => {
  const workspace = writeWorkspace("bridge-check-clean-")
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }))

  const committedDir = generateBridge(workspace)
  const result = checkBridge({
    workspaceRoot: workspace,
    target: "claude",
    category: "pipeline",
    config: claudeConfig(),
    committedDir
  })

  assert.deepEqual(result.missing, [])
  assert.deepEqual(result.changed, [])
  assert.deepEqual(result.extra, [])
  assert.equal(result.clean, true)
})

test("checkBridge reports drift on a stale fixture", (t) => {
  const workspace = writeWorkspace("bridge-check-stale-")
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }))

  const committedDir = generateBridge(workspace)
  // Simulate an outdated committed prompt (old prose) and a leftover generated file.
  const staleAgent = path.join(committedDir, "agents", "orchestrator.md")
  assert.ok(fs.existsSync(staleAgent))
  fs.appendFileSync(staleAgent, "\nOutdated prose kept from a previous generation.\n")
  fs.writeFileSync(path.join(committedDir, "agents", "legacy.md"), "stale leftover\n")

  const result = checkBridge({
    workspaceRoot: workspace,
    target: "claude",
    category: "pipeline",
    config: claudeConfig(),
    committedDir
  })

  assert.equal(result.clean, false)
  assert.deepEqual(result.missing, [])
  assert.deepEqual(result.changed, ["agents/orchestrator.md"])
  assert.deepEqual(result.extra, ["agents/legacy.md"])
})
