import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {
  DEFAULT_AUTHOR_NAME,
  DEFAULT_TRANSLATION_CONFIG,
  authorName,
  buildInferenceIndex,
  loadTranslationConfig,
  normalizeAgentName,
  parseCodexExactMappings,
  parseKeyValueMappings,
  resolveModelTarget,
  resolveRole,
  saveTranslationConfig,
  validateTranslationConfig
} from "./translationConfig.js"

const agent = (filename: string): any => ({ filename })

test("translation defaults define the planning and execution roles", () => {
  assert.equal(DEFAULT_TRANSLATION_CONFIG.tiers.planning.claude.model, "opus")
  assert.deepEqual(DEFAULT_TRANSLATION_CONFIG.tiers.planning.codex, { model: "gpt-5.6-sol", reasoningEffort: "high" })
  assert.equal(DEFAULT_TRANSLATION_CONFIG.tiers.execution.claude.model, "sonnet")
  assert.deepEqual(DEFAULT_TRANSLATION_CONFIG.tiers.execution.codex, { model: "gpt-5.6-luna", reasoningEffort: "max" })
})

test("authorName falls back to the default and honors AGENT_AUTHOR_NAME", () => {
  assert.equal(DEFAULT_AUTHOR_NAME, "Lorenzo Cancellara")
  assert.equal(authorName({}), DEFAULT_AUTHOR_NAME)
  assert.equal(authorName({ AGENT_AUTHOR_NAME: "Ada Lovelace" }), "Ada Lovelace")
  assert.equal(authorName({ AGENT_AUTHOR_NAME: "  Grace Hopper  " }), "Grace Hopper")
  assert.equal(authorName({ AGENT_AUTHOR_NAME: "   " }), DEFAULT_AUTHOR_NAME)
})

test("authorName rejects unsafe or oversized AGENT_AUTHOR_NAME overrides", () => {
  assert.equal(authorName({ AGENT_AUTHOR_NAME: "José García-López" }), "José García-López")
  assert.equal(authorName({ AGENT_AUTHOR_NAME: "O'Brien Jr." }), "O'Brien Jr.")
  assert.equal(authorName({ AGENT_AUTHOR_NAME: "Anne-Marie St. Clair" }), "Anne-Marie St. Clair")
  assert.equal(authorName({ AGENT_AUTHOR_NAME: "A".repeat(100) }), "A".repeat(100))
  assert.equal(authorName({ AGENT_AUTHOR_NAME: "Ada <script>" }), DEFAULT_AUTHOR_NAME)
  assert.equal(authorName({ AGENT_AUTHOR_NAME: "../../etc/passwd" }), DEFAULT_AUTHOR_NAME)
  assert.equal(authorName({ AGENT_AUTHOR_NAME: "ACME & Co" }), DEFAULT_AUTHOR_NAME)
  assert.equal(authorName({ AGENT_AUTHOR_NAME: "A".repeat(101) }), DEFAULT_AUTHOR_NAME)

  const originalError = console.error
  const warnings: string[] = []
  console.error = (...args: unknown[]) => { warnings.push(args.join(" ")) }
  try {
    assert.equal(authorName({ AGENT_AUTHOR_NAME: "Ada <script>" }), DEFAULT_AUTHOR_NAME)
  } finally {
    console.error = originalError
  }
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /AGENT_AUTHOR_NAME/)
})

test("agent names normalize extensions, prefixes and case", () => {
  assert.equal(normalizeAgentName("copilot-pipeline-PlAnNeR.md", "copilot-pipeline-"), "planner")
  assert.equal(normalizeAgentName("planner", "copilot-pipeline-"), "planner")
  assert.equal(normalizeAgentName("other.md", "copilot-pipeline-"), "other")
})

test("resolveRole and resolveModelTarget apply role and override precedence", () => {
  assert.equal(resolveRole(agent("copilot-pipeline-planner.md"), DEFAULT_TRANSLATION_CONFIG), "planner")
  assert.equal(resolveRole(agent("planner.md"), DEFAULT_TRANSLATION_CONFIG), "planner")
  const config = { ...DEFAULT_TRANSLATION_CONFIG, roles: { ...DEFAULT_TRANSLATION_CONFIG.roles, illustrator: "execution" }, claude: { overrides: { planner: { model: "custom" } } } }
  assert.deepEqual(resolveModelTarget(agent("illustrator.md"), buildInferenceIndex([agent("illustrator.md")], config), config, "claude"), {
    role: "illustrator", tier: "execution", model: { model: "sonnet" }, source: "role"
  })
  assert.deepEqual(resolveModelTarget(agent("planner.md"), buildInferenceIndex([agent("planner.md")], config), config, "claude"), {
    role: "planner", tier: "planning", model: { model: "custom" }, source: "override"
  })
})

test("model inference is unique, provider-aware, and opt-outable", () => {
  const classified = (filename: string, model: string, role: string) => ({ ...agent(filename), model, frontmatter: { model }, role }) as any
  const planning = classified("planner.md", "provider/opus", "planner")
  const execution = classified("executor.md", "provider/sonnet", "executor")
  const unknown = classified("illustrator.md", "provider/opus", "illustrator")
  const config = { ...DEFAULT_TRANSLATION_CONFIG, roles: { planner: "planning", executor: "execution" } }
  const inferred = resolveModelTarget(unknown, buildInferenceIndex([planning, execution, unknown], config), config, "claude")
  assert.equal(inferred.tier, "planning")
  assert.equal(inferred.source, "inferred")
  assert.equal(inferred.inferredFrom, "provider/opus")

  const ambiguous = classified("reviewer.md", "provider/opus", "reviewer")
  const alternate = classified("critic.md", "provider/opus", "critic")
  const ambiguousConfig = {
    ...config,
    tiers: { ...config.tiers, other: config.tiers.execution },
    roles: { planner: "planning", executor: "execution", critic: "execution", bare: "other" }
  }
  const ambiguousBare = classified("bare.md", "other/opus", "bare")
  const abstained = resolveModelTarget(ambiguous, buildInferenceIndex([planning, alternate, ambiguousBare], ambiguousConfig), ambiguousConfig, "claude")
  assert.equal(abstained.source, "default")
  assert.equal(abstained.model.model, ambiguousConfig.tiers[ambiguousConfig.defaultTier].claude.model)
  const noInferenceConfig = { ...config, inference: false }
  const noInference = resolveModelTarget(unknown, buildInferenceIndex([planning, execution, unknown], noInferenceConfig), noInferenceConfig, "claude")
  assert.equal(noInference.source, "default")
  const noModel = agent("plain.md")
  assert.doesNotThrow(() => resolveModelTarget(noModel, buildInferenceIndex([planning, noModel], config), config, "claude"))

  const byFull = classified("full.md", "provider/sonnet", "full")
  const byBare = classified("bare.md", "other/sonnet", "bare")
  const fullConfig = { ...DEFAULT_TRANSLATION_CONFIG, roles: { full: "planning", bare: "execution" } }
  assert.equal(resolveModelTarget(byFull, buildInferenceIndex([byFull, byBare], fullConfig), fullConfig, "claude").tier, "planning")
})

test("per-agent overrides win over roles for both translation targets", () => {
  const source = agent("illustrator.md")
  const config = {
    ...DEFAULT_TRANSLATION_CONFIG,
    roles: { illustrator: "execution" },
    claude: { overrides: { illustrator: { model: "claude-custom" } } },
    codex: { overrides: { illustrator: { model: "codex-custom", reasoningEffort: "low" } } }
  }
  assert.deepEqual(resolveModelTarget(source, buildInferenceIndex([source], config), config, "claude"), {
    role: "illustrator", tier: "execution", model: { model: "claude-custom" }, source: "override"
  })
  assert.deepEqual(resolveModelTarget(source, buildInferenceIndex([source], config), config, "codex"), {
    role: "illustrator", tier: "execution", model: { model: "codex-custom", reasoningEffort: "low" }, source: "override"
  })
})

test("wizard mapping parsers remain supported", () => {
  assert.deepEqual(parseKeyValueMappings("gpt-5.6-luna*=sonnet, claude-opus*=opus"), {
    "gpt-5.6-luna*": "sonnet", "claude-opus*": "opus"
  })
  assert.deepEqual(parseCodexExactMappings("gpt-5.4=gpt-5.6-luna:max"), {
    "gpt-5.4": { model: "gpt-5.6-luna", reasoningEffort: "max" }
  })
})

test("v1 config migrates, warns, and is persisted", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "translation-config-"))
  const filePath = path.join(workspace, "config.json")
  fs.writeFileSync(filePath, JSON.stringify({
    version: 1, target: "codex", pluginName: "old", prefix: "old-", sourceDir: "general",
    claude: { primaryModel: "old-opus", defaultSubagentModel: "old-sonnet", modelMap: { "old-*": "x" } },
    codex: { modelMapping: { primary: { model: "old-sol" }, default: { model: "old-luna" }, exact: { old: { model: "x" } } }, emitSkills: false, emitReadme: false, emitMcp: true }
  }))
  const loaded = loadTranslationConfig(workspace, filePath)
  assert.equal(loaded.version, 2)
  assert.equal(loaded.tiers.planning.claude.model, "old-opus")
  assert.equal(loaded.tiers.execution.claude.model, "old-sonnet")
  assert.equal(loaded.tiers.planning.codex.model, "old-sol")
  assert.equal(loaded.tiers.execution.codex.model, "old-luna")
  assert.equal(JSON.parse(fs.readFileSync(filePath, "utf8")).version, 2)
})

test("validation rejects invalid role assignments and source directories", () => {
  const duplicate = structuredClone(DEFAULT_TRANSLATION_CONFIG)
  duplicate.roles.illustrator = "missing-tier"
  assert.throws(() => validateTranslationConfig(duplicate), /role "illustrator".*tier "missing-tier"/)
  const missing = { ...structuredClone(DEFAULT_TRANSLATION_CONFIG), defaultTier: "missing" }
  assert.throws(() => validateTranslationConfig(missing), /defaultTier "missing" does not exist/)
  const incomplete = structuredClone(DEFAULT_TRANSLATION_CONFIG)
  delete (incomplete.tiers.planning.claude as any).model
  assert.throws(() => validateTranslationConfig(incomplete), /tier "planning" is missing claude.model/)
  assert.throws(() => validateTranslationConfig({ ...structuredClone(DEFAULT_TRANSLATION_CONFIG), sourceDir: "../outside" }), /sourceDir/)
  assert.throws(() => validateTranslationConfig({ ...structuredClone(DEFAULT_TRANSLATION_CONFIG), sourceDir: "/tmp/outside" }), /sourceDir/)
})

test("loading v2 is idempotent", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "translation-config-"))
  const filePath = saveTranslationConfig(workspace, DEFAULT_TRANSLATION_CONFIG)
  const before = fs.readFileSync(filePath, "utf8")
  const loaded = loadTranslationConfig(workspace)
  assert.deepEqual(loaded, DEFAULT_TRANSLATION_CONFIG)
  assert.equal(fs.readFileSync(filePath, "utf8"), before)
})
