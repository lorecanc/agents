import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test, { type TestContext } from "node:test"
import { checkPackBridge, compareTrees } from "./bridgeCheck.js"
import { bridgePack, type BridgeTarget } from "./bridgeWorkspace.js"
import { DEFAULT_TRANSLATION_CONFIG, type TranslationConfig } from "./translationConfig.js"

const CATALOG: Record<string, string> = {
  "packs/shared/opencode-pack.json": JSON.stringify({ contract: "1.0", name: "shared", version: "1.0.0", description: "x" }),
  "packs/shared/skills/shared-style/SKILL.md": "---\ndescription: Style rules\n---\n\nKeep it short.\n",
  "packs/pipeline/opencode-pack.json": JSON.stringify({ contract: "1.0", name: "pipeline", version: "1.0.0", description: "x", requires: { shared: "^1.0.0" } }),
  "packs/pipeline/agents/pipeline-orchestrator.md": [
    "---",
    "description: Pipeline orchestrator",
    "mode: primary",
    "model: github-copilot/claude-opus-5",
    "---",
    "",
    "Orchestrate the pipeline work with @pipeline-planner.",
    ""
  ].join("\n"),
  "packs/pipeline/agents/pipeline-planner.md": "---\ndescription: Pipeline planner\nmode: subagent\n---\n\nPlan the pipeline work.\n",
  "packs/pipeline/commands/pipeline-bug.md": "---\ndescription: Fix a bug\n---\nFix $ARGUMENTS.\n"
}

const config: TranslationConfig = {
  ...DEFAULT_TRANSLATION_CONFIG,
  pluginName: "decent-pipeline",
  prefix: "pipeline-",
  claude: { ...DEFAULT_TRANSLATION_CONFIG.claude, autoValidate: false, autoRegister: false }
}

function writeCatalog(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-check-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const [relative, content] of Object.entries(CATALOG)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true })
    fs.writeFileSync(path.join(root, relative), content)
  }
  return root
}

/** Generate the bridge into its committed location, as the manager does. */
function commitBridge(workspaceRoot: string, target: BridgeTarget): string {
  const committedDir = path.join(workspaceRoot, "bridges", target === "codex" ? "codex" : "claude-code", config.pluginName)
  bridgePack({ workspaceRoot, pack: "pipeline", target, outputDir: committedDir, config, pluginName: config.pluginName, prefix: config.prefix })
  return committedDir
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

for (const target of ["claude", "codex"] as const) {
  test(`checkPackBridge passes on a freshly generated ${target} bridge`, (t) => {
    const workspaceRoot = writeCatalog(t)
    const committedDir = commitBridge(workspaceRoot, target)

    assert.deepEqual(checkPackBridge({ workspaceRoot, pack: "pipeline", target, config, committedDir }), { missing: [], changed: [], extra: [], clean: true })
  })
}

test("checkPackBridge reports drift without touching the committed output", (t) => {
  const workspaceRoot = writeCatalog(t)
  const committedDir = commitBridge(workspaceRoot, "claude")
  const staleAgent = path.join(committedDir, "agents", "orchestrator.md")
  fs.appendFileSync(staleAgent, "\nOutdated prose kept from a previous generation.\n")
  fs.writeFileSync(path.join(committedDir, "agents", "legacy.md"), "stale leftover\n")
  fs.rmSync(path.join(committedDir, "skills", "shared-style"), { recursive: true })

  const result = checkPackBridge({ workspaceRoot, pack: "pipeline", target: "claude", config, committedDir })

  assert.deepEqual(result, {
    missing: ["skills/shared-style/SKILL.md"],
    changed: ["agents/orchestrator.md"],
    extra: ["agents/legacy.md"],
    clean: false
  })
  assert.ok(fs.existsSync(path.join(committedDir, "agents", "legacy.md")))
})

test("checkPackBridge sees a change in a required pack", (t) => {
  const workspaceRoot = writeCatalog(t)
  const committedDir = commitBridge(workspaceRoot, "claude")
  fs.appendFileSync(path.join(workspaceRoot, "packs", "shared", "skills", "shared-style", "SKILL.md"), "Prefer verbs.\n")

  const result = checkPackBridge({ workspaceRoot, pack: "pipeline", target: "claude", config, committedDir })

  assert.deepEqual(result.changed, ["skills/shared-style/SKILL.md"])
})

test("checkPackBridge rejects an unknown or invalid pack name", (t) => {
  const workspaceRoot = writeCatalog(t)
  const committedDir = path.join(workspaceRoot, "bridges", "claude-code", "decent-pipeline")
  assert.throws(() => checkPackBridge({ workspaceRoot, pack: "../escape", target: "claude", config, committedDir }), /escape/)
  assert.throws(() => checkPackBridge({ workspaceRoot, pack: "missing", target: "claude", config, committedDir }), /missing/)
})
