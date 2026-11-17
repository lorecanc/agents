import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { checkPacks } from "./check-packs.mjs"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "check-packs-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function write(root, file, contents) {
  const target = path.join(root, "packs", file)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, contents)
}

function manifest(name, requires = {}) {
  return JSON.stringify({ contract: "1.0", name, version: "1.0.0", requires }, null, 2)
}

function agent(frontmatter, body = "") {
  return `---\n${frontmatter}\n---\n${body}`
}

function baseFixture(t) {
  const root = fixture(t)
  write(root, "shared/opencode-pack.json", manifest("shared"))
  write(root, "shared/agents/helper.md", agent("mode: subagent\nhidden: false\npermissions: []"))
  write(root, "shared/skills/shared-skill/SKILL.md", "# Shared skill\n")
  write(root, "integration/opencode-pack.json", manifest("integration"))
  write(root, "integration/opencode.json", JSON.stringify({ mcp: { servers: { "chrome-devtools": { type: "remote", url: "https://example.test" } } } }))
  write(root, "app/opencode-pack.json", manifest("app", { shared: "^1.0.0", integration: "^1.0.0" }))
  write(root, "app/skills/app-skill/SKILL.md", "# App skill\n")
  write(root, "app/agents/runner.md", agent([
    "mode: primary",
    "permissions:",
    "  - action: subagent",
    "    resource: helper",
    "    effect: allow",
    "  - action: skill",
    "    resource: shared-skill",
    "    effect: allow",
  ].join("\n"), "Load the `app-skill` skill."))
  write(root, "app/commands/run.md", agent("agent: helper"))
  return root
}

test("valid multi-pack fixture resolves direct agents and skills", (t) => {
  const root = baseFixture(t)
  const result = checkPacks({ root })
  assert.deepEqual(result, { ok: true, errors: [] })
})

test("command agent references must resolve locally or through direct requires", (t) => {
  const root = fixture(t)
  write(root, "app/opencode-pack.json", manifest("app"))
  write(root, "other/opencode-pack.json", manifest("other"))
  write(root, "other/agents/helper.md", agent("permissions: []"))
  write(root, "app/commands/missing.md", agent("agent: does-not-exist"))
  write(root, "app/commands/indirect.md", agent("agent: helper"))
  write(root, "app/commands/invalid-type.md", agent("agent: []"))

  const result = checkPacks({ root })
  assert.equal(result.errors.filter((item) => item.rule === "command-agent-resolution").length, 3)
})

test("hidden subagents and unresolved allowed subagents are rejected", (t) => {
  const root = fixture(t)
  write(root, "app/opencode-pack.json", manifest("app"))
  write(root, "app/agents/hidden.md", agent("mode: subagent\nhidden: true\npermissions: []"))
  write(root, "app/agents/runner.md", agent([
    "permissions:",
    "  - action: subagent",
    "    resource: missing-agent",
    "    effect: allow",
    "  - action: subagent",
    "    resource: hidden",
    "    effect: allow",
  ].join("\n")))

  const result = checkPacks({ root })
  assert.equal(result.errors.filter((item) => item.rule === "subagent-visibility-and-resolution").length, 3)
})

test("skill permissions and short IDs in Skills tables require direct visibility", (t) => {
  const root = fixture(t)
  write(root, "app/opencode-pack.json", manifest("app"))
  write(root, "integrations/opencode-pack.json", manifest("integrations"))
  write(root, "integrations/skills/integration-skill/SKILL.md", "# Integration skill\n")
  write(root, "integrations/skills/chrome-devtools-troubleshooting/SKILL.md", "# Troubleshooting\n")
  write(root, "app/agents/runner.md", agent([
    "permissions:",
    "  - action: skill",
    "    resource: integration-skill",
    "    effect: allow",
  ].join("\n"), "## Skills\n| `troubleshooting` | Troubleshooting tools |"))

  const result = checkPacks({ root })
  assert.equal(result.errors.filter((item) => item.rule === "skill-resolution").length, 2)
})

test("explicit load and table references to missing skills are rejected", (t) => {
  const root = fixture(t)
  write(root, "app/opencode-pack.json", manifest("app"))
  write(root, "app/agents/runner.md", agent("permissions: []", [
    "Load the `missing-skill` skill.",
    "",
    "## Available Skills",
    "| Task | Skill |",
    "|---|---|",
    "| Example | `missing-table-skill` |",
  ].join("\n")))

  const result = checkPacks({ root })
  assert.ok(result.errors.some((item) => item.rule === "skill-resolution" && item.message.includes("missing-skill")))
  assert.ok(result.errors.some((item) => item.rule === "skill-resolution" && item.message.includes("missing-table-skill")))
})

test("known orchestrator corruptions are flagged without rejecting legitimate names", (t) => {
  const root = fixture(t)
  write(root, "app/opencode-pack.json", manifest("app"))
  write(root, "app/agents/runner.md", agent("permissions: []", [
    "Legitimate names: slides-orchestrator and pipeline-orchestrator.",
    "slides-orchestrator-planner",
    "docs-orchestrator-html and wiki-orchestrator-indexer",
    '"slides-orchestrator": [',
    '"docs-orchestrator": {',
    "docs-orchestrator: {}, docs-orchestrator.description",
    "autodocs-orchestrator",
    "office/slides-orchestrator",
    "office/docs-orchestrator",
    "6 slides-orchestrator",
  ].join("\n")))
  write(root, "app/skills/app-skill/SKILL.md", ".slides-orchestrator\n")
  write(root, "app/commands/example.md", "office/slides-orchestrator\n")

  const result = checkPacks({ root })
  assert.equal(result.errors.filter((item) => item.rule === "orchestrator-corruption").length, 13)
})

test("calling a declared MCP denied by the final matching permission is rejected", (t) => {
  const root = fixture(t)
  write(root, "integration/opencode-pack.json", manifest("integration"))
  write(root, "integration/opencode.json", JSON.stringify({ mcp: { servers: { "chrome-devtools": { type: "remote", url: "https://example.test" } } } }))
  write(root, "app/opencode-pack.json", manifest("app", { integration: "^1.0.0" }))
  write(root, "app/agents/runner.md", agent([
    "permissions:",
    "  - action: \"*\"",
    "    resource: \"*\"",
    "    effect: deny",
    "  - action: phantom_*",
    "    resource: \"*\"",
    "    effect: allow",
  ].join("\n"), "Use the `chrome-devtools` MCP to inspect the page."))
  write(root, "app/agents/allowed.md", agent([
    "permissions:",
    "  - action: \"*\"",
    "    resource: \"*\"",
    "    effect: deny",
    "  - action: chrome-devtools_*",
    "    resource: \"*\"",
    "    effect: allow",
  ].join("\n"), "Via Chrome DevTools MCP, inspect the page."))
  write(root, "app/agents/unavailable.md", agent([
    "permissions:",
    "  - action: \"*\"",
    "    resource: \"*\"",
    "    effect: deny",
  ].join("\n"), "The chrome-devtools MCP is unavailable in this environment."))

  const result = checkPacks({ root })
  assert.ok(result.errors.some((item) => item.rule === "mcp-permission-alignment" && item.message.includes("chrome-devtools_probe")))
  assert.ok(result.errors.some((item) => item.rule === "mcp-permission-alignment" && item.message.includes("phantom_*")))
  assert.ok(!result.errors.some((item) => item.file.endsWith("allowed.md")))
  assert.ok(!result.errors.some((item) => item.file.endsWith("unavailable.md")))
})

test("repository packs satisfy the static validator", () => {
  const result = checkPacks({ root: repoRoot })
  assert.deepEqual(result, { ok: true, errors: [] }, JSON.stringify(result.errors, null, 2))
})
