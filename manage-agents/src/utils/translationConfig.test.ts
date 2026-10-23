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
  normalizeTranslationConfig,
  parseCodexExactMappings,
  parseKeyValueMappings,
  resolveMarketplaceName,
  resolveModelTarget,
  resolveRole,
  saveTranslationConfig,
  unusedModelMapKeys,
  validateClaudeModelName,
  validateMarketplaceName,
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

test("claude marketplace emission and automation defaults are enabled when absent", () => {
  assert.equal(DEFAULT_TRANSLATION_CONFIG.claude.emitMarketplace, true)
  assert.equal(DEFAULT_TRANSLATION_CONFIG.claude.emitCommands, true)
  assert.equal(DEFAULT_TRANSLATION_CONFIG.claude.emitSkills, true)
  assert.equal(DEFAULT_TRANSLATION_CONFIG.claude.autoValidate, true)
  assert.equal(DEFAULT_TRANSLATION_CONFIG.claude.autoRegister, true)
  assert.equal(DEFAULT_TRANSLATION_CONFIG.claude.marketplaceName, undefined)

  const legacy = structuredClone(DEFAULT_TRANSLATION_CONFIG) as any
  for (const key of ["emitMarketplace", "emitCommands", "emitSkills", "autoValidate", "autoRegister"]) delete legacy.claude[key]
  const normalized = normalizeTranslationConfig(legacy)
  assert.equal(normalized.claude.emitMarketplace, true)
  assert.equal(normalized.claude.emitCommands, true)
  assert.equal(normalized.claude.emitSkills, true)
  assert.equal(normalized.claude.autoValidate, true)
  assert.equal(normalized.claude.autoRegister, true)
  assert.equal(normalized.claude.marketplaceName, undefined)
})

test("a v2 config without claude marketplace fields loads unchanged with defaults applied", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "translation-config-"))
  try {
    const filePath = path.join(workspace, "config.json")
    const written = {
      version: 2,
      target: "claude",
      pluginName: "legacy-plugin",
      prefix: "copilot-pipeline-",
      sourceDir: "general",
      inference: false,
      defaultTier: "execution",
      tiers: DEFAULT_TRANSLATION_CONFIG.tiers,
      roles: DEFAULT_TRANSLATION_CONFIG.roles,
      claude: { overrides: {}, modelMap: {} },
      codex: { overrides: {}, emitSkills: false }
    }
    fs.writeFileSync(filePath, JSON.stringify(written))
    const loaded = loadTranslationConfig(workspace, filePath)
    assert.equal(loaded.version, 2)
    assert.equal(loaded.pluginName, "legacy-plugin")
    assert.equal(loaded.inference, false)
    assert.equal(loaded.codex.emitSkills, false)
    assert.equal(loaded.claude.emitMarketplace, true)
    assert.equal(loaded.claude.emitCommands, true)
    assert.equal(loaded.claude.emitSkills, true)
    assert.equal(loaded.claude.autoValidate, true)
    assert.equal(loaded.claude.autoRegister, true)
    assert.equal(loaded.claude.marketplaceName, undefined)
    assert.equal(JSON.parse(fs.readFileSync(filePath, "utf8")).version, 2)
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test("resolveMarketplaceName prefers the configured name and derives a plugin-local default", () => {
  assert.equal(resolveMarketplaceName("decent-pipeline"), "decent-pipeline-local")
  assert.equal(resolveMarketplaceName("decent-pipeline", "acme-tools"), "acme-tools")
  assert.equal(resolveMarketplaceName("decent-pipeline", ""), "decent-pipeline-local")
  assert.equal(resolveMarketplaceName("decent-pipeline", "   "), "decent-pipeline-local")
})

test("validateMarketplaceName accepts safe names and rejects invalid or reserved ones", () => {
  for (const name of ["acme", "Acme.Tools", "acme_tools-1", "0plug", "claudetools"]) {
    assert.doesNotThrow(() => validateMarketplaceName(name))
  }
  for (const name of ["", " ", "acme tools", "..", "-acme", ".acme", "_acme", "acme/tools"]) {
    assert.throws(() => validateMarketplaceName(name), /Invalid marketplace name/)
  }
  for (const name of ["claude", "CLAUDE", "claude-code", "Claude-Code", "claude-local", "anthropic-tools", "Anthropics-Tools"]) {
    assert.throws(() => validateMarketplaceName(name), /reserved/)
  }
})

test("validateTranslationConfig validates claude.marketplaceName when present", () => {
  assert.doesNotThrow(() => validateTranslationConfig(structuredClone(DEFAULT_TRANSLATION_CONFIG)))
  const valid = structuredClone(DEFAULT_TRANSLATION_CONFIG)
  valid.claude.marketplaceName = "acme-tools"
  assert.doesNotThrow(() => validateTranslationConfig(valid))
  const invalid = structuredClone(DEFAULT_TRANSLATION_CONFIG)
  invalid.claude.marketplaceName = "claude-local"
  assert.throws(() => validateTranslationConfig(invalid), /marketplace name/)
})

test("validateTranslationConfig rejects non-boolean claude automation flags", () => {
  const invalid = structuredClone(DEFAULT_TRANSLATION_CONFIG) as any
  invalid.claude.autoRegister = "false"
  assert.throws(() => validateTranslationConfig(invalid), /claude\.autoRegister must be a boolean/)

  for (const key of ["emitMarketplace", "emitCommands", "emitSkills", "autoValidate", "autoRegister"]) {
    const flagged = structuredClone(DEFAULT_TRANSLATION_CONFIG) as any
    flagged.claude[key] = 1
    assert.throws(() => validateTranslationConfig(flagged), new RegExp(`claude\\.${key} must be a boolean`))
  }
})

test("modelMap round-trips through save and load and materializes when absent", () => {
  assert.deepEqual(DEFAULT_TRANSLATION_CONFIG.claude.modelMap, {})
  assert.deepEqual(DEFAULT_TRANSLATION_CONFIG.codex.modelMap, {})
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "translation-config-"))
  const config = {
    ...structuredClone(DEFAULT_TRANSLATION_CONFIG),
    claude: { overrides: {}, modelMap: { "provider/opus": "haiku", "*": "sonnet" } },
    codex: { overrides: {}, emitSkills: true, emitReadme: true, modelMap: { "gpt-5": "gpt-5.6-luna" } }
  }
  saveTranslationConfig(workspace, config)
  const loaded = loadTranslationConfig(workspace)
  assert.deepEqual(loaded.claude.modelMap, config.claude.modelMap)
  assert.deepEqual(loaded.codex.modelMap, config.codex.modelMap)

  const legacy = structuredClone(DEFAULT_TRANSLATION_CONFIG) as any
  delete legacy.claude.modelMap
  delete legacy.codex.modelMap
  const legacyPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "translation-config-")), "config.json")
  fs.writeFileSync(legacyPath, JSON.stringify(legacy))
  const materialized = loadTranslationConfig(path.dirname(legacyPath), legacyPath)
  assert.deepEqual(materialized.claude.modelMap, {})
  assert.deepEqual(materialized.codex.modelMap, {})
})

test("claude modelMap rejects unknown models with the valid-values message", () => {
  const invalid = structuredClone(DEFAULT_TRANSLATION_CONFIG)
  invalid.claude.modelMap = { "provider/glm-4.6": "iq" }
  assert.throws(() => validateTranslationConfig(invalid), (error: any) => {
    const message = String(error.message)
    assert.match(message, /fable/)
    assert.match(message, /sonnet/)
    assert.match(message, /opus/)
    assert.match(message, /haiku/)
    assert.match(message, /inherit/)
    assert.match(message, /claude-\*/)
    assert.match(message, /iq/)
    assert.match(message, /claude\.modelMap\["provider\/glm-4\.6"\]/)
    return true
  })
  assert.throws(() => validateClaudeModelName("gpt-5"), /claude-\*/)
})

test("claude modelMap accepts aliases and full IDs while codex rejects empty values", () => {
  for (const alias of ["fable", "sonnet", "opus", "haiku", "inherit", "claude-opus-5-5"]) {
    assert.doesNotThrow(() => validateClaudeModelName(alias))
  }
  const config = structuredClone(DEFAULT_TRANSLATION_CONFIG)
  config.claude.modelMap = { "provider/opus": "claude-opus-5-5" }
  assert.doesNotThrow(() => validateTranslationConfig(config))
  config.codex.modelMap = { "gpt-5": "" }
  assert.throws(() => validateTranslationConfig(config), /codex\.modelMap\["gpt-5"\]/)
  config.codex.modelMap = { "gpt-5": "gpt-5.6-luna" }
  assert.doesNotThrow(() => validateTranslationConfig(config))
})

test("modelMap is layered below overrides and above roles and inference", () => {
  const classified = (filename: string, model: string) => ({ ...agent(filename), model, frontmatter: { model } }) as any
  const mapped = classified("planner.md", "provider/opus")
  const config = {
    ...structuredClone(DEFAULT_TRANSLATION_CONFIG),
    roles: { planner: "planning" },
    claude: { overrides: {}, modelMap: { "provider/opus": "haiku" } }
  }
  assert.deepEqual(resolveModelTarget(mapped, buildInferenceIndex([mapped], config), config, "claude"), {
    role: "planner", tier: "planning", model: { model: "haiku" }, source: "model-map"
  })

  const overridden = {
    ...config,
    claude: { overrides: { planner: { model: "custom" } }, modelMap: config.claude.modelMap }
  }
  assert.equal(resolveModelTarget(mapped, buildInferenceIndex([mapped], overridden), overridden, "claude").source, "override")

  const noRole = classified("illustrator.md", "provider/opus")
  const inferenceConfig = {
    ...structuredClone(DEFAULT_TRANSLATION_CONFIG),
    roles: { planner: "planning" },
    claude: { overrides: {}, modelMap: {} }
  }
  assert.equal(resolveModelTarget(noRole, buildInferenceIndex([mapped, noRole], inferenceConfig), inferenceConfig, "claude").source, "inferred")
  const inferred = {
    ...inferenceConfig,
    claude: { overrides: {}, modelMap: { "provider/opus": "fable" } }
  }
  const mappedResult = resolveModelTarget(noRole, buildInferenceIndex([mapped, noRole], inferred), inferred, "claude")
  assert.equal(mappedResult.source, "model-map")
  assert.equal(mappedResult.model.model, "fable")
})

test("modelMap prefers specific keys over the catch-all and full IDs over bare IDs", () => {
  const source = (model: string) => ({ ...agent("executor.md"), model, frontmatter: { model } }) as any
  const config = (modelMap: Record<string, string>) => ({
    ...structuredClone(DEFAULT_TRANSLATION_CONFIG),
    roles: { executor: "execution" },
    claude: { overrides: {}, modelMap }
  })
  const providerAgent = source("provider/opus")
  const specific = config({ "provider/opus": "haiku", "*": "sonnet" })
  assert.equal(resolveModelTarget(providerAgent, buildInferenceIndex([providerAgent], specific), specific, "claude").model.model, "haiku")
  const catchAll = config({ "*": "sonnet" })
  assert.equal(resolveModelTarget(providerAgent, buildInferenceIndex([providerAgent], catchAll), catchAll, "claude").model.model, "sonnet")
  const fullWins = config({ "provider/opus": "fable", "opus": "haiku" })
  assert.equal(resolveModelTarget(providerAgent, buildInferenceIndex([providerAgent], fullWins), fullWins, "claude").model.model, "fable")
  const bareOnly = config({ "opus": "haiku" })
  assert.equal(resolveModelTarget(providerAgent, buildInferenceIndex([providerAgent], bareOnly), bareOnly, "claude").model.model, "haiku")
})

test("modelMap matches after trimming and lowercasing the source model", () => {
  const source = (model: string) => ({ ...agent("executor.md"), model, frontmatter: { model } }) as any
  const noisy = source("  Provider/OPUS  ")
  const config = {
    ...structuredClone(DEFAULT_TRANSLATION_CONFIG),
    roles: { executor: "execution" },
    claude: { overrides: {}, modelMap: { "provider/opus": "haiku" } }
  }
  const result = resolveModelTarget(noisy, buildInferenceIndex([noisy], config), config, "claude")
  assert.equal(result.source, "model-map")
  assert.equal(result.model.model, "haiku")
})

test("modelMap on the inactive target does not affect the active target", () => {
  const source = (model: string) => ({ ...agent("planner.md"), model, frontmatter: { model } }) as any
  const mapped = source("provider/opus")
  const config = {
    ...structuredClone(DEFAULT_TRANSLATION_CONFIG),
    roles: { planner: "planning" },
    claude: { overrides: {}, modelMap: { "provider/opus": "haiku" } },
    codex: { overrides: {}, emitSkills: true, emitReadme: true, modelMap: { "provider/opus": "gpt-inactive" } }
  }
  const claude = resolveModelTarget(mapped, buildInferenceIndex([mapped], config), config, "claude")
  assert.equal(claude.source, "model-map")
  assert.equal(claude.model.model, "haiku")
  const codex = resolveModelTarget(mapped, buildInferenceIndex([mapped], config), config, "codex")
  assert.equal(codex.model.model, "gpt-inactive")
  const claudeWithoutMap = { ...config, claude: { overrides: {}, modelMap: {} } }
  assert.equal(resolveModelTarget(mapped, buildInferenceIndex([mapped], claudeWithoutMap), claudeWithoutMap, "claude").source, "role")
})

test("unusedModelMapKeys reports dead keys and never the catch-all", () => {
  const sources = [
    { ...agent("planner.md"), model: "provider/opus", frontmatter: { model: "provider/opus" } },
    { ...agent("executor.md"), model: "glm-4.6", frontmatter: { model: "glm-4.6" } }
  ] as any[]
  const config = structuredClone(DEFAULT_TRANSLATION_CONFIG)
  config.claude.modelMap = { "provider/opus": "haiku", "opus": "sonnet", "glm-4.6": "sonnet", "*": "sonnet", "dead-key": "haiku" }
  assert.deepEqual(unusedModelMapKeys(sources, config, "claude"), ["dead-key"])
  config.codex.modelMap = { "*": "gpt-5.6-luna" }
  assert.deepEqual(unusedModelMapKeys(sources, config, "codex"), [])
})

test("unusedModelMapKeys returns no keys when the target has no modelMap", () => {
  const legacy = structuredClone(DEFAULT_TRANSLATION_CONFIG) as any
  delete legacy.claude.modelMap
  delete legacy.codex.modelMap
  const sources = [{ ...agent("planner.md"), model: "provider/opus", frontmatter: { model: "provider/opus" } }] as any[]
  assert.deepEqual(unusedModelMapKeys(sources, legacy, "claude"), [])
  assert.deepEqual(unusedModelMapKeys(sources, legacy, "codex"), [])
})

test("v1 modelMap migration still warns and yields an empty v2 map", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "translation-config-"))
  const filePath = path.join(workspace, "config.json")
  fs.writeFileSync(filePath, JSON.stringify({
    version: 1, target: "claude", pluginName: "old", prefix: "old-", sourceDir: "general",
    claude: { primaryModel: "old-opus", defaultSubagentModel: "old-sonnet", modelMap: { "old-*": "x" } },
    codex: { modelMapping: { primary: { model: "old-sol" }, default: { model: "old-luna" } } }
  }))
  const originalError = console.error
  const warnings: string[] = []
  console.error = (...args: unknown[]) => { warnings.push(args.join(" ")) }
  let loaded
  try {
    loaded = loadTranslationConfig(workspace, filePath)
  } finally {
    console.error = originalError
  }
  assert.deepEqual(loaded!.claude.modelMap, {})
  assert.ok(warnings.some(warning =>
    /discarded claude\.modelMap key "old-\*"/.test(warning) &&
    /v1 keys are wildcard patterns/.test(warning) &&
    /exact source-model ids plus the "\*" catch-all/.test(warning)))
})

test("inherited object keys never resolve as roles, overrides or model-map entries", () => {
  const source = (filename: string, model: string) => ({ ...agent(filename), model, frontmatter: { model } }) as any
  const config = {
    ...structuredClone(DEFAULT_TRANSLATION_CONFIG),
    roles: { constructor: "planning", tostring: "execution" },
    claude: { overrides: {}, modelMap: {} }
  }
  const constructorAgent = source("constructor.md", "constructor")
  const constructorResult = resolveModelTarget(constructorAgent, buildInferenceIndex([constructorAgent], config), config, "claude")
  assert.equal(constructorResult.source, "role")
  assert.equal(constructorResult.tier, "planning")
  assert.equal(constructorResult.model.model, "opus")

  const toStringAgent = source("toString.md", "toString")
  const toStringResult = resolveModelTarget(toStringAgent, buildInferenceIndex([toStringAgent], config), config, "claude")
  assert.equal(toStringResult.source, "role")
  assert.equal(toStringResult.tier, "execution")
  assert.equal(toStringResult.model.model, "sonnet")
})

test("an explicit constructor modelMap key resolves while the inherited property does not", () => {
  const source = { ...agent("executor.md"), model: "constructor", frontmatter: { model: "constructor" } } as any
  const baseline = { ...structuredClone(DEFAULT_TRANSLATION_CONFIG), roles: { executor: "execution" } }
  const explicit = { ...baseline, claude: { overrides: {}, modelMap: { constructor: "haiku" } } }
  const mapped = resolveModelTarget(source, buildInferenceIndex([source], explicit), explicit, "claude")
  assert.equal(mapped.source, "model-map")
  assert.equal(mapped.model.model, "haiku")

  const inheritedOnly = { ...baseline, claude: { overrides: {}, modelMap: {} } }
  const fallback = resolveModelTarget(source, buildInferenceIndex([source], inheritedOnly), inheritedOnly, "claude")
  assert.equal(fallback.source, "role")
  assert.equal(fallback.model.model, "sonnet")
})

test("symlinked translation config paths are rejected by load and save", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "translation-config-"))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "translation-config-outside-"))
  const target = path.join(outside, "target.json")
  const link = path.join(workspace, "translation-config.json")
  const original = JSON.stringify({ version: 2, pluginName: "untouched" })
  fs.writeFileSync(target, original)
  try {
    fs.symlinkSync(target, link)
  } catch {
    t.skip("symlinks are not supported in this environment")
    fs.rmSync(workspace, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
    return
  }
  try {
    assert.throws(() => loadTranslationConfig(workspace, link), /must not be a symlink/)
    assert.throws(() => saveTranslationConfig(workspace, DEFAULT_TRANSLATION_CONFIG, link), /must not be a symlink/)
    assert.equal(fs.readFileSync(target, "utf8"), original)
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  }
})

