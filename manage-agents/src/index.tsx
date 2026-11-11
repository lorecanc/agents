import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import React from "react"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import readline from "node:readline"
import { App } from "./App.js"
import { fetchModels, loadModelCatalog, getModelVariants } from "./utils/models.js"
import { exportAgents, getExportDestination, analyzeAgentName, renameAgent, auditSecurityPermissions, importAgents, previewImport, updateAgentParams, sanitizeFilename, KNOWN_MODEL_VARIANTS, resolveSourceSubdir, resolveCategoriesSubdir, checkPipelineResources, findAgentFiles } from "./utils/agents.js"
import {
  DEFAULT_TRANSLATION_CONFIG,
  loadTranslationConfig,
  normalizeTranslationConfig,
  parseKeyValueMappings,
  saveTranslationConfig,
  validateMarketplaceName,
  type TranslationConfig,
  type TranslationTarget
} from "./utils/translationConfig.js"
import { AUTO_COMMIT_MESSAGES, isRepositoryLocalPath, repositoryTransaction, parseAutoCommitArgs } from "./utils/repositoryTransaction.js"
import { buildCategoryDistribution, buildAllCategoryDistributions, recoverBuildAllCategoryDistributions, checkCategoryDistribution, loadCategoryManifest, packageCategoryDistributions, parseCategoryArgs } from "./utils/categoryDistribution.js"
import { loadUiConfig } from "./utils/uiConfig.js"
import { loadExtension } from "./utils/extensions.js"
import { hasErrors, PACK_NAME_RE, validatePack, type PackValidation } from "./utils/packs.js"
import { addSource, discoverAllPacks, findSource, loadSources, pullSource, removeSource, saveSources, sourceRevision } from "./utils/sources.js"
import { describeExecutable, parsePackRequest, resolvePacks } from "./utils/resolver.js"
import { buildLock, confirmationsNeeded, defaultTarget, diffLocks, readLock, type LockChange } from "./utils/lock.js"
import { changeTarget, installChange, reconcileChange, restoreBackup, targetStatus, uninstallChange, updateChange, type ChangeResult } from "./utils/installer.js"
import { loadOverrideSettings, loadRoutingSettings, saveOverrideSettings, saveRoutingSettings, scopeOf, setOverride, setRoutes, unsetOverride, unsetRoutes } from "./utils/userSettings.js"
import YAML from "yaml"
import { realpathThroughExistingAncestor } from "./utils/pathValidation.js"
import { terminalSafeText } from "./utils/terminalText.js"
import { agentRoutingConfigPath, agentRoutingOutputPath, archetypeBundles, buildAgentRouting, checkAgentRouting, describeAgentRouting, isRoutableArchetype, rebuildArchetypeBundles, ROUTABLE_ARCHETYPES, setArchetypeConfig } from "./utils/agentRouting.js"
import { BASH_PROFILES_FILE, checkBashProfiles, syncBashProfiles } from "./utils/bashProfiles.js"
import { claudeNextSteps } from "./utils/claudeNextSteps.js"
import { registerPlugin, validatePlugin } from "./utils/claudePluginCli.js"
import type { BridgeResult } from "./utils/bridge.js"
import type { CodexBridgeResult } from "./utils/codexBridge.js"
import {
  applySharedSync,
  compareSharedSync,
  loadSharedSyncManifest,
  parseSharedSyncArgs,
  releaseSharedSync,
  SHARED_SYNC_MANIFEST_PATH,
  SHARED_SYNC_RELEASE_INDEX,
  SHARED_SYNC_STATE_PATH,
  type SharedComponentId,
  type SharedSyncComparison
} from "./utils/sharedSync.js"

function repositoryMutation<T>(workspaceRoot: string, plan: string[] | { localPaths: string[]; externalPaths?: string[] }, message: string, mutation: () => T): T {
  const result = repositoryTransaction(workspaceRoot, plan, message, mutation)
  if (result.warning) console.error(`AUTO-COMMIT WARNING: ${result.warning.message}\n${result.warning.recovery}`)
  return result.value
}

function askQuestion(query: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  })
  return new Promise((resolve) =>
    rl.question(query, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  )
}

export function askConfirmation(
  query: string,
  defaultYes = true,
  io: { stdin: typeof process.stdin; stdout: typeof process.stdout } = process
): Promise<boolean> {
  const { stdin, stdout } = io
  if (stdin.isTTY && typeof stdin.setRawMode === "function") {
    return new Promise((resolve) => {
      stdout.write(query)
      stdin.setRawMode(true)

      const onKey = (data: Buffer) => {
        for (const key of data.toString("utf8")) {
          if (key !== "\u0003" && key !== "\u0004" && key !== "\r" && key !== "\n" && key !== "y" && key !== "Y" && key !== "n" && key !== "N") continue

          stdin.removeListener("data", onKey)
          stdin.setRawMode(false)
          stdin.pause()

          if (key === "\u0003" || key === "\u0004") {
            stdout.write("\n")
            resolve(false)
          } else if (key === "\r" || key === "\n") {
            stdout.write("\n")
            resolve(defaultYes)
          } else {
            stdout.write(`${key}\n`)
            resolve(key.toLowerCase() === "y")
          }
          return
        }
      }

      stdin.on("data", onKey)
      stdin.resume()
    })
  }

  return askQuestion(query).then((answer) => {
    const normalizedAnswer = answer.toLowerCase()
    const isYes = normalizedAnswer === "y" || normalizedAnswer === "yes"
    return defaultYes ? answer === "" || isYes : isYes
  })
}

/** Shorten the user's home directory prefix to `~` for display. */
function shortenHome(p: string): string {
  const home = os.homedir()
  if (!home || home === path.sep) return p
  return p === home ? "~" : p.startsWith(home + path.sep) ? "~" + p.slice(home.length) : p
}

async function runCreate(agentNameArg: string | undefined, workspaceRoot: string) {
  console.log(`\n✨ Create New Agent (Naming Convention: [family-]category-role_with_underscores)`)
  console.log("------------------------------------------")

  const familyInput = await askQuestion("1. 🏷  Family (Optional, e.g. go, mistral, hybrid - press enter to skip): ")
  let categoryInput = ""
  while (!categoryInput) {
    categoryInput = await askQuestion("2. 📁 Category (Required, e.g. pipeline, wiki, slides, docs, general): ")
  }

  let roleInput = ""
  while (!roleInput) {
    roleInput = await askQuestion("3. 🛠  Role (Required, e.g. code_reviewer, orchestrator, html_writer): ")
  }

  const cleanFamily = familyInput.trim().toLowerCase()
  const cleanCategory = categoryInput.trim().toLowerCase()
  const cleanRole = roleInput.trim().toLowerCase().replace(/\s+/g, "_").replace(/-/g, "_")

  const filename = cleanFamily
    ? `${cleanFamily}-${cleanCategory}-${cleanRole}.md`
    : `${cleanCategory}-${cleanRole}.md`

  const safeFilename = sanitizeFilename(filename)
  const agentsDir = path.join(workspaceRoot, resolveSourceSubdir(workspaceRoot), "agents")
  const targetPath = path.join(agentsDir, safeFilename)
  if (!path.resolve(targetPath).startsWith(path.resolve(agentsDir) + path.sep)) {
    throw new Error(`Invalid agent path: ${safeFilename}`)
  }

  if (fs.existsSync(targetPath)) {
    console.error(`\nError: Agent file already exists at ${targetPath}`)
    process.exit(1)
  }

  const description = await askQuestion("\n📝 Enter agent description: ")

  // Fetch models for selection list
  let models: string[] = []
  models = fetchModels()
  if (models.length === 0) throw new Error("Model catalog unavailable; cannot create an agent without a verified model")

  console.log("\n🤖 Select an LLM model:")
  models.forEach((model, idx) => {
    console.log(`  [${idx + 1}] ${model}`)
  })

  let modelIndex = 0
  while (true) {
    const answer = await askQuestion(`Enter number (1-${models.length}) [1]: `)
    if (answer === "") {
      modelIndex = 0
      break
    }
    const idx = parseInt(answer, 10) - 1
    if (idx >= 0 && idx < models.length) {
      modelIndex = idx
      break
    }
    console.log("Invalid selection. Please try again.")
  }

  const selectedModel = models[modelIndex]

  // Write file
  const frontmatter = `---
category: ${cleanCategory}
description: ${description}
model: ${selectedModel}
---

# ${filename.replace(/\.md$/, "")}

Write agent instructions and prompts here.
`

  if (!fs.existsSync(agentsDir)) {
    fs.mkdirSync(agentsDir, { recursive: true })
  }

  repositoryMutation(workspaceRoot, [targetPath], AUTO_COMMIT_MESSAGES.create, () => fs.writeFileSync(targetPath, frontmatter, "utf-8"))

  console.log("\n------------------------------------------")
  console.log(`🎉 Agent successfully created!`)
  console.log(`  File:     ${resolveSourceSubdir(workspaceRoot)}/agents/${filename}`)
  console.log(`  Family:   ${cleanFamily || "(none)"}`)
  console.log(`  Category: ${cleanCategory}`)
  console.log(`  Role:     ${cleanRole}`)
  console.log(`  Model:    ${selectedModel}`)
}

async function askWithDefault(question: string, fallback: string): Promise<string> {
  const answer = await askQuestion(`${question} [${fallback}]: `)
  return answer || fallback
}

async function runTranslationWizard(
  workspaceRoot: string,
  current: TranslationConfig,
  configPath?: string,
  persist = true
): Promise<TranslationConfig> {
  console.log("\n🧭 Translation bridge configuration wizard")
  console.log("   This writes only a bridge config layer; source agents are not changed.\n")

  const targetAnswer = (await askWithDefault("Target (claude/codex)", "claude")).toLowerCase()
  if (targetAnswer !== "claude" && targetAnswer !== "codex") {
    throw new Error("Target must be 'claude' or 'codex'.")
  }
  const pluginName = await askWithDefault("Plugin name", current.pluginName)
  const prefix = await askWithDefault("Source prefix to strip", current.prefix)
  const sourceDir = await askWithDefault("Source directory", current.sourceDir)

  const next = normalizeTranslationConfig({ ...current, target: targetAnswer as TranslationTarget, pluginName, prefix, sourceDir })
  const planningClaude = await askWithDefault("Claude planning tier model", next.tiers.planning.claude.model)
  const executionClaude = await askWithDefault("Claude execution tier model", next.tiers.execution.claude.model)
  const planningCodex = await askWithDefault("Codex planning tier model", next.tiers.planning.codex.model)
  const executionCodex = await askWithDefault("Codex execution tier model", next.tiers.execution.codex.model)
  next.tiers = {
    ...next.tiers,
    planning: { ...next.tiers.planning, claude: { ...next.tiers.planning.claude, model: planningClaude }, codex: { ...next.tiers.planning.codex, model: planningCodex } },
    execution: { ...next.tiers.execution, claude: { ...next.tiers.execution.claude, model: executionClaude }, codex: { ...next.tiers.execution.codex, model: executionCodex } }
  }

  const savedPath = persist
    ? saveTranslationConfig(workspaceRoot, next, configPath)
    : configPath || path.join(workspaceRoot, ".agent-manager", "translation-config.json")
  console.log(`\n✅ Configuration saved to ${savedPath}`)
  console.log(`   Selected target: ${targetAnswer}`)
  return next
}

const BRIDGE_CHECK_HELP = `
Usage: manage-agents bridge check [options]

Regenerate every committed bridge in a temporary workspace and compare it
byte-exact with the files committed under export/bridges/.

Options:
  --category, -c <name>   Only check bridges of this category
  --target, -t <name>     Only check claude or codex (default: both)
  --help, -h              Show this help
`

async function runBridgeCheck(workspaceRoot: string) {
  const args = process.argv.slice(4)
  let category = ""
  let targetFilter: TranslationTarget | "" = ""

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--category" || args[i] === "-c") && args[i + 1]) {
      category = args[++i]
    } else if ((args[i] === "--target" || args[i] === "-t") && args[i + 1]) {
      const requested = args[++i].toLowerCase()
      if (requested !== "claude" && requested !== "codex") throw new Error("--target must be claude or codex")
      targetFilter = requested
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(BRIDGE_CHECK_HELP)
      process.exit(0)
    } else {
      throw new Error(`Unknown option for 'bridge check': ${args[i]}`)
    }
  }

  // Check-only runs must never migrate or persist the translation config.
  const config = loadTranslationConfig(workspaceRoot, undefined, { persistMigration: false })
  const bridgesRoot = path.join(workspaceRoot, fs.existsSync(path.join(workspaceRoot, "export")) ? path.join("export", "bridges") : "bridges")
  const folders: Array<{ target: "claude" | "codex"; folder: string }> = [
    { target: "claude" as const, folder: "claude-code" },
    { target: "codex" as const, folder: "codex" }
  ].filter(entry => !targetFilter || entry.target === targetFilter)

  // Without --category, every committed bridge directory is checked and its
  // category comes from the configured prefix.
  const derivedCategory = (config.prefix || "").replace(/-$/, "")
  const checks: Array<{ label: string; target: "claude" | "codex"; category: string; committedDir: string }> = []
  for (const { target, folder } of folders) {
    const folderPath = path.join(bridgesRoot, folder)
    if (category) {
      const pluginName = sanitizeFilename(config.pluginName || DEFAULT_TRANSLATION_CONFIG.pluginName)
      checks.push({ label: `${folder}/${pluginName}`, target, category, committedDir: path.join(folderPath, pluginName) })
      continue
    }
    if (!fs.existsSync(folderPath)) continue
    for (const entry of fs.readdirSync(folderPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const relative = path.relative(workspaceRoot, path.join(folderPath, entry.name))
      if (!derivedCategory) {
        throw new Error(`Cannot map bridge '${relative}' to a category: set 'prefix' in .agent-manager/translation-config.json or pass --category`)
      }
      checks.push({ label: `${folder}/${entry.name}`, target, category: derivedCategory, committedDir: path.join(folderPath, entry.name) })
    }
  }
  if (checks.length === 0) throw new Error(`No bridges found under ${bridgesRoot}`)

  const { checkBridge } = await import("./utils/bridgeCheck.js")
  let drifted = false
  for (const check of checks) {
    const result = checkBridge({ workspaceRoot, target: check.target, category: check.category, config, committedDir: check.committedDir })
    if (result.clean) {
      console.log(`Bridge ${check.label} (category ${check.category}): current.`)
      continue
    }
    drifted = true
    console.log(`Bridge ${check.label} (category ${check.category}): drift.`)
    for (const file of result.missing) console.log(`  missing ${file} (not emitted by a fresh regeneration)`)
    for (const file of result.changed) console.log(`  changed ${file} (content differs from a fresh regeneration)`)
    for (const file of result.extra) console.log(`  extra   ${file} (stale file no longer generated)`)
    console.log(`  Regenerate with: node manage-agents/manage-agents.mjs bridge --category ${check.category} --target ${check.target}`)
  }
  if (drifted) process.exitCode = 1
}

async function runBridge(workspaceRoot: string) {
  if (process.argv[3] === "check") {
    await runBridgeCheck(workspaceRoot)
    return
  }

  const { findAgentFiles } = await import("./utils/agents.js")

  // Parse CLI args. The wizard persists reusable mappings in a translation
  // layer so subsequent non-interactive runs use the same defaults.
  const args = process.argv.slice(3)
  let category = ""
  let output = ""
  let pluginName = ""
  let prefix = ""
  let sourceDir = ""
  let target: TranslationTarget = "claude"
  let targetSpecified = false
  let configFile = ""
  let wizard = false
  let modelMappings: Record<string, string> = {}
  let modelFlagsGiven = false
  let autoValidate: boolean | undefined
  let autoRegister: boolean | undefined
  let marketplaceName = ""
  let marketFlagsGiven = false

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--category" || args[i] === "-c") && args[i + 1]) {
      category = args[++i]
    } else if ((args[i] === "--output" || args[i] === "-o") && args[i + 1]) {
      output = args[++i]
    } else if ((args[i] === "--name" || args[i] === "-n") && args[i + 1]) {
      pluginName = args[++i]
    } else if ((args[i] === "--prefix" || args[i] === "-p") && args[i + 1]) {
      prefix = args[++i]
    } else if ((args[i] === "--source-dir" || args[i] === "-s") && args[i + 1]) {
      sourceDir = args[++i]
    } else if ((args[i] === "--target" || args[i] === "-t") && args[i + 1]) {
      const requested = args[++i].toLowerCase()
      if (requested !== "claude" && requested !== "codex") throw new Error("--target must be claude or codex")
      target = requested
      targetSpecified = true
    } else if (args[i] === "--model" && args[i + 1]) {
      modelMappings = { ...modelMappings, ...parseKeyValueMappings(args[++i]) }
      modelFlagsGiven = true
    } else if (args[i] === "--map-all" && args[i + 1]) {
      modelMappings = { ...modelMappings, "*": args[++i] }
      modelFlagsGiven = true
    } else if (args[i] === "--no-validate") {
      autoValidate = false
      marketFlagsGiven = true
    } else if (args[i] === "--no-register") {
      autoRegister = false
      marketFlagsGiven = true
    } else if (args[i] === "--marketplace-name" && args[i + 1]) {
      marketplaceName = args[++i]
      validateMarketplaceName(marketplaceName)
      marketFlagsGiven = true
    } else if (args[i] === "--config" && args[i + 1]) {
      configFile = args[++i]
    } else if (args[i] === "--wizard" || args[i] === "-w") {
      wizard = true
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(`
Usage: manage-agents bridge [options]
       manage-agents bridge check [options]

Subcommands:
  check                   Verify committed bridges match a fresh regeneration

Options:
  --category, -c <name>   Category to bridge (e.g. pipeline)
  --target, -t <name>     Translation target: claude (default) or codex
  --output, -o <path>     Output directory (default: export/bridges/<target>/<name>, or bridges/<target>/<name> without export/)
  --name, -n <name>       Plugin name (default: decent-pipeline)
  --prefix, -p <prefix>   Prefix to strip (default: <category>-)
  --source-dir, -s <dir>  Agent source directory (default: config or general)
  --config <path>         Reusable translation config (default: .agent-manager/translation-config.json)
  --model <src=target>    Map a source model to a target model; repeatable and accepts comma lists
                          (e.g. --model "zai-glm-5-3=opus" --model "deepseek-*=sonnet")
  --map-all <target>      Shorthand for --model "*=<target>": use one model for every source
  --no-validate           Skip 'claude plugin validate' after a claude bridge
  --no-register           Skip installing the generated plugin into Claude Code
  --marketplace-name <n>  Marketplace used when registering (default: <plugin>-local)
  --wizard, -w            Configure model mappings and save them before bridging
  --help, -h              Show this help

Model mappings use source=target syntax; the source may be a "*" catch-all (e.g. "*=sonnet")
and mappings merge with the loaded config for the selected target. Provided mappings are
persisted to the translation config, so later runs replay them without flags. The claude
automation flags are persisted the same way.
`)
      process.exit(0)
    }
  }

  const loaded = loadTranslationConfig(workspaceRoot, configFile || undefined, { persistMigration: false })
  const config = wizard
    ? await runTranslationWizard(workspaceRoot, loaded, configFile || undefined, false)
    : loaded
  if (!targetSpecified) target = config.target
  if (modelFlagsGiven) config[target].modelMap = { ...(config[target].modelMap || {}), ...modelMappings }
  // Claude automation flags persist on the claude layer so later runs replay them.
  if (marketFlagsGiven) {
    config.claude = {
      ...config.claude,
      ...(autoValidate !== undefined ? { autoValidate } : {}),
      ...(autoRegister !== undefined ? { autoRegister } : {}),
      ...(marketplaceName ? { marketplaceName } : {})
    }
  }
  pluginName = pluginName || config.pluginName || DEFAULT_TRANSLATION_CONFIG.pluginName
  prefix = prefix || (category ? `${category}-` : config.prefix)
  sourceDir = sourceDir || config.sourceDir || resolveSourceSubdir(workspaceRoot)
  if (!category) category = prefix.replace(/-$/, "")
  if (!prefix) prefix = `${category}-`
  if (!category) {
    console.error("Error: --category is required (or set prefix in the bridge wizard).")
    process.exit(1)
  }

  const safePluginName = sanitizeFilename(pluginName)
  const bridgeFolder = target === "codex" ? "codex" : "claude-code"
  const outputDir = output || path.join(workspaceRoot, fs.existsSync(path.join(workspaceRoot, "export")) ? path.join("export", "bridges") : "bridges", bridgeFolder, safePluginName)

  console.log(`\n🔄 Bridging category '${category}' to ${target} layer '${pluginName}'...`)
  console.log(`   Prefix to strip: '${prefix}'`)
  console.log(`   Output directory: ${outputDir}\n`)

  const allAgents = findAgentFiles(workspaceRoot, sourceDir)
  if (allAgents.warnings) allAgents.warnings.forEach(warning => console.log(`   ⚠ ${warning}`))
  const categoryAgents = allAgents.filter(a => a.category === category)

  if (categoryAgents.length === 0) {
    console.error(`Error: No agents found for category '${category}'.`)
    console.error(`Available categories: ${[...new Set(allAgents.map(a => a.category))].join(", ")}`)
    process.exit(1)
  }

  console.log(`   Found ${categoryAgents.length} agents to convert.\n`)

  let result: BridgeResult | CodexBridgeResult
  if (target === "codex") {
    const { bridgeToCodex } = await import("./utils/codexBridge.js")
    const bridgeConfigPath = configFile || path.join(workspaceRoot, ".agent-manager", "translation-config.json")
    const bridgePlan = { localPaths: [bridgeConfigPath].filter(file => isRepositoryLocalPath(workspaceRoot, file)).concat(isRepositoryLocalPath(workspaceRoot, outputDir) ? [outputDir] : []), externalPaths: [bridgeConfigPath, outputDir].filter(file => !isRepositoryLocalPath(workspaceRoot, file)) }
    const codexResult = repositoryMutation(workspaceRoot, bridgePlan, AUTO_COMMIT_MESSAGES.bridge, () => {
      if (wizard || modelFlagsGiven) saveTranslationConfig(workspaceRoot, config, configFile || undefined)
      return bridgeToCodex(categoryAgents, safePluginName, prefix, outputDir, workspaceRoot, { ...config, sourceDir })
    })
    result = codexResult
  } else {
    const { bridgeToClaudeCode } = await import("./utils/bridge.js")
    const bridgeConfigPath = configFile || path.join(workspaceRoot, ".agent-manager", "translation-config.json")
    const bridgePlan = { localPaths: [bridgeConfigPath].filter(file => isRepositoryLocalPath(workspaceRoot, file)).concat(isRepositoryLocalPath(workspaceRoot, outputDir) ? [outputDir] : []), externalPaths: [bridgeConfigPath, outputDir].filter(file => !isRepositoryLocalPath(workspaceRoot, file)) }
    const claudeResult = repositoryMutation(workspaceRoot, bridgePlan, AUTO_COMMIT_MESSAGES.bridge, () => {
      if (wizard || modelFlagsGiven || marketFlagsGiven) saveTranslationConfig(workspaceRoot, config, configFile || undefined)
      return bridgeToClaudeCode(categoryAgents, safePluginName, prefix, outputDir, workspaceRoot, { ...config, sourceDir }, { category })
    })
    result = claudeResult
  }

  console.log(`✅ ${target} layer generated successfully!\n`)
  console.log(`   Files created:`)
  result.files.forEach(f => console.log(`     * ${f}`))
  if (result.preview?.length) {
    console.log(`\n   Preview (agent → role → tier → model → source):`)
    result.preview.forEach(p => console.log(`     ${p.agent} → ${p.role} → ${p.tier} → ${p.model} → ${p.source}`))
  }

  if (result.warnings.length > 0) {
    console.log(`\n   ⚠ Warnings:`)
    result.warnings.forEach(w => console.log(`     * ${w}`))
  }

  if (target === "claude" && "pluginName" in result) {
    console.log(`\n   Validate and run locally:`)
    claudeNextSteps(result.pluginName, result.orchestratorName, result.pluginDir).forEach(line => console.log(line))
    console.log()
    // Validation and registration run after the transaction: they spawn the
    // claude CLI and write user-level Claude config.
    let registrationSkipped = false
    if (config.claude.autoValidate !== false) {
      const validation = validatePlugin(result.pluginDir)
      console.log(`   Validation: ${validation.kind}`)
      console.log(`     ${validation.message}`)
      if (validation.detail) console.log(`     ${validation.detail}`)
      if (validation.kind === "fail") {
        registrationSkipped = true
        console.log(`     ⚠ Registration skipped: validation failed.`)
      } else if (validation.kind === "error") {
        registrationSkipped = true
        console.log(`     ⚠ Registration skipped: validation could not decide (unexpected CLI error).`)
      }
    }
    if (!registrationSkipped && config.claude.autoRegister !== false) {
      if (result.marketplaceName === null) {
        console.log(`     ⚠ Registration skipped: no marketplace manifest is emitted (claude.emitMarketplace is off).`)
      } else {
        const registration = registerPlugin(result.pluginDir, result.pluginName, result.marketplaceName)
        console.log(`   Registration: ${registration.kind}`)
        console.log(`     ${registration.message}`)
        if (registration.detail) console.log(`     ${registration.detail}`)
      }
    }
    console.log()
  } else {
    console.log(`\n   Codex project-scoped agents:`)
    console.log(`     cd ${outputDir} && codex`)
    console.log(`   Plugin manifest:`)
    console.log(`     ${path.join(outputDir, ".codex-plugin", "plugin.json")}\n`)
  }
}

async function runExport(workspaceRoot: string) {
  const { findAgentFiles } = await import("./utils/agents.js")

  // Parse CLI args
  const args = process.argv.slice(3)
  let exportAll = false
  let assumeYes = false
  let category = ""
  let stackDirectory: string | undefined

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--all" || args[i] === "-a") {
      exportAll = true
    } else if (args[i] === "--yes" || args[i] === "-y") {
      assumeYes = true
    } else if ((args[i] === "--category" || args[i] === "-c") && args[i + 1]) {
      category = args[++i]
    } else if ((args[i] === "--stack" || args[i] === "-s") && args[i + 1]) {
      stackDirectory = args[++i]
    } else if (args[i].startsWith("--stack=")) {
      stackDirectory = args[i].slice("--stack=".length)
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(`
Usage: manage-agents export [options]

OpenCode config directory: $XDG_CONFIG_HOME/opencode/ (default: ~/.config/opencode/).
Export agent files to its agents/ directory with full overwrite.
A single disaster-recovery backup is kept at agents_backup/ in that directory.
Companion resources in tools/, commands/, skills/, and plugins/ matching each exported
agent's domain are installed under the same subpath in that directory.
When ontology plugins (tools/ontology/*-plugin) are exported, production
dependencies are automatically provisioned via npm ci --omit=dev, plugin
paths are idempotently merged into opencode.json (backing up opencode.json.bak),
and ontology-stack.json is written when a valid ontology-stack directory is
detected or passed with --stack.

Options:
  --all, -a               Export all agents
  --yes, -y                  Skip confirmation prompt
  --category, -c <name>   Export only agents from a specific category
                          (agent routing is rebuilt first: see manage-agents routing show)
  --stack, -s <path>      Optional ontology-stack directory to persist in ontology-stack.json
  --help, -h              Show this help
`)
      process.exit(0)
    }
  }

  try {
    repositoryMutation(workspaceRoot, [agentRoutingOutputPath(workspaceRoot)], AUTO_COMMIT_MESSAGES.routing, () => buildAgentRouting(workspaceRoot))
  } catch (error: any) {
    console.error(`Agent routing not rebuilt: ${error?.message || error}`)
  }

  const sourceSubdir = resolveSourceSubdir(workspaceRoot)
  const resourceSourceRoot = path.join(workspaceRoot, sourceSubdir)
  const allAgents = findAgentFiles(workspaceRoot, sourceSubdir)
  const agentsToExport = category ? allAgents.filter(agent => agent.category === category) : allAgents
  if (category && agentsToExport.length === 0) {
    console.error(`Error: No agents found for category '${category}'.`)
    console.error(`Available categories: ${[...new Set(allAgents.map(a => a.category))].join(", ")}`)
    process.exit(1)
  }

  const destination = shortenHome(getExportDestination())

  console.log(`\n📦 Export to OpenCode`)
  console.log(`   ------------------------------------------`)
  console.log(`   Agents to export: ${agentsToExport.length}${category ? ` (category: ${category})` : " (all)"}`)
  console.log(`   Destination:      ${destination}`)
  console.log(`   Overwrite mode:   FULL (including model field)`)
  console.log(`   Backup location:  ${shortenHome(path.join(path.dirname(getExportDestination()), "agents_backup"))}`)
  console.log(`   ------------------------------------------\n`)

  if (!assumeYes && !(await askConfirmation("⚠  Proceed with export? (Y/n): ", true))) {
    console.log("\n❌ Export cancelled.")
    process.exit(0)
  }

  const result = exportAgents(agentsToExport, undefined, resourceSourceRoot, { stackDirectory, completeExport: !category })

  if (result.pluginProvisioning?.ontologyStackWarning) {
    console.warn(`   ⚠  ${result.pluginProvisioning.ontologyStackWarning}`)
  }
  if (result.experimentalTodoWarning) {
    console.warn(`   ⚠  ${result.experimentalTodoWarning}`)
  }
  for (const warning of result.extensionWarnings ?? []) console.warn(`   ⚠  ${warning}`)

  console.log(`\n✅ Export complete!`)
  console.log(`   Exported ${result.exported.length} agents to:`)
  console.log(`   ${shortenHome(result.destinationPath)}`)
  if (result.backupPath) {
    console.log(`\n   Backup at:`)
    console.log(`   ${shortenHome(result.backupPath)}\n`)
  } else {
    console.log(`\n   Backup: not created (no existing files replaced)\n`)
  }

  if (!result.experimentalTodoWarning) {
    console.log(`   ✔  experimental.todo enabled in ${shortenHome(path.join(path.dirname(result.destinationPath), "opencode.json"))}`)
  }

  if (result.domainResources.length > 0) {
    console.log(`   Companion resources installed:`)
    result.domainResources.forEach(resource => console.log(`     ${shortenHome(resource)}`))
    console.log(`   Resource backup: ${result.domainBackupPath ? shortenHome(result.domainBackupPath) : "not needed (no existing files replaced)"}`)
  }

  if (result.pluginProvisioning) {
    const prov = result.pluginProvisioning
    if (prov.installed.length > 0 || prov.skipped.length > 0) {
      console.log(`\n   Ontology plugins provisioned (${prov.installed.length} installed, ${prov.skipped.length} already aligned):`)
      prov.installed.forEach(p => console.log(`     ✔ ${p} (npm ci --omit=dev)`))
      prov.skipped.forEach(p => console.log(`     • ${p} (node_modules aligned)`))
    }
    if (prov.opencodeConfigPath) {
      console.log(`   Registered plugins in: ${shortenHome(prov.opencodeConfigPath)}`)
      if (prov.opencodeConfigBackupPath) {
        console.log(`   Config backup at:      ${shortenHome(prov.opencodeConfigBackupPath)}`)
      }
    }
    if (prov.ontologyStackConfigPath && prov.ontologyStackDirectory) {
      console.log(`   Ontology stack config: ${shortenHome(prov.ontologyStackConfigPath)} -> ${shortenHome(prov.ontologyStackDirectory)}`)
    }
    if (prov.failed.length > 0) {
      console.log(`\n   ⚠ Plugin dependency provisioning warnings:`)
      prov.failed.forEach(f => console.log(`     * ${f.plugin}: ${f.error}`))
    }
    if (prov.registeredPlugins.length > 0) {
      console.log("   ℹ  If OpenCode is already running, run `opencode service restart` (or restart OpenCode) to reload ontology tools and plugins.")
    }
  }

  if (result.skipped.length > 0) {
    console.log(`   ⚠ Skipped ${result.skipped.length} files:`)
    result.skipped.forEach(s => console.log(`     * ${s}`))
    console.log()
  }
}

async function runLint(workspaceRoot: string) {
  const { findAgentFiles } = await import("./utils/agents.js")
  const agents = findAgentFiles(workspaceRoot, loadTranslationConfig(workspaceRoot, undefined, { persistMigration: false }).sourceDir)
  const allFilenames = agents.map(a => a.filename)

  console.log(`\n🔍 Naming Convention Lint Report`)
  console.log(`   Rule: [{family}-]{category}-{role_with_underscores}.md`)
  console.log(`   ------------------------------------------`)

  let validCount = 0
  let invalidCount = 0

  for (const agent of agents) {
    const analysis = analyzeAgentName(agent.filename, allFilenames)
    if (analysis.isValid) {
      validCount++
    } else {
      invalidCount++
      console.log(`\n  ❌ ${agent.filename}`)
      analysis.errors.forEach(e => console.log(`     * Error: ${e}`))
      if (analysis.suggestedName) {
        console.log(`     👉 Suggested: ${analysis.suggestedName}`)
      }
    }
  }

  console.log(`\n   ------------------------------------------`)
  console.log(`   Total agents: ${agents.length}`)
  console.log(`   ✅ Compliant:     ${validCount}`)
  console.log(`   ⚠ Non-Compliant: ${invalidCount}\n`)
}

async function runFixNames(workspaceRoot: string) {
  const { findAgentFiles } = await import("./utils/agents.js")
  const args = process.argv.slice(3)
  const isDryRun = args.includes("--dry-run")

  const agents = findAgentFiles(workspaceRoot, loadTranslationConfig(workspaceRoot, undefined, { persistMigration: false }).sourceDir)
  const allFilenames = agents.map(a => a.filename)
  const nonCompliant = agents.map(a => ({ agent: a, analysis: analyzeAgentName(a.filename, allFilenames) })).filter(item => !item.analysis.isValid)

  if (nonCompliant.length === 0) {
    console.log("\n✨ All agents already comply with the naming convention!")
    return
  }

  console.log(`\n🛠  Fixing Agent Names (Naming Convention Refactoring)`)
  console.log(`   Mode: ${isDryRun ? "DRY RUN (no changes will be written)" : "EXECUTE"}`)
  console.log(`   Found ${nonCompliant.length} non-compliant agents.\n`)

  nonCompliant.forEach(({ agent, analysis }) => {
    console.log(`   * ${agent.filename}  ->  ${analysis.suggestedName}`)
  })

  if (isDryRun) {
    console.log("\n💡 Dry run complete. Run without --dry-run to apply changes.\n")
    return
  }

  const answer = await askQuestion("\n⚠  Proceed with refactoring? (Y/n): ")
  if (answer.toLowerCase() !== "y" && answer !== "") {
    console.log("\n❌ Operation cancelled.")
    return
  }

  const plans = nonCompliant.filter(item => item.analysis.suggestedName).map(({ agent, analysis }) => ({
    agent,
    destination: path.join(path.dirname(agent.currentPath), analysis.suggestedName!)
  }))
  const plannedPaths = [...agents.map(agent => agent.currentPath), ...plans.map(plan => plan.destination)]
  let successCount = 0
  let totalRefs = 0
  try {
    const results = repositoryMutation(workspaceRoot, plannedPaths, AUTO_COMMIT_MESSAGES.rename, () => {
      const renamed = []
      for (const plan of plans) {
        const result = renameAgent(workspaceRoot, plan.agent.currentPath, path.basename(plan.destination), agents)
        if (!result.success) throw new Error(result.error || `Failed to rename ${plan.agent.filename}`)
        renamed.push(result)
      }
      return renamed
    })
    successCount = results.length
    totalRefs = results.reduce((count, result) => count + result.updatedReferences.length, 0)
  } catch (e: any) {
    console.error(`Failed to rename agents: ${e.message || e}`)
    return
  }

  console.log(`\n✅ Batch refactoring complete!`)
  console.log(`   Successfully renamed ${successCount}/${nonCompliant.length} agents.`)
  console.log(`   Updated cross-references in ${totalRefs} places.\n`)
}

async function runAudit(workspaceRoot: string) {
  const { findAgentFiles } = await import("./utils/agents.js")
  const agents = findAgentFiles(workspaceRoot, loadTranslationConfig(workspaceRoot, undefined, { persistMigration: false }).sourceDir)
  const audit = auditSecurityPermissions(agents)

  console.log(`\n🛡️  Security & Permission Audit Report`)
  console.log(`   ------------------------------------------`)

  if (audit.orderErrors.length > 0) {
    console.log(`\n  ⚠️ PERMISSION ORDER ERRORS (${audit.orderErrors.length} agents):`)
    console.log(`     (OpenCode spec requires wildcard "*": "deny" to be placed FIRST!)`)
    audit.orderErrors.forEach(({ agent, categories }) => {
      console.log(`     * ${agent.filename}  [categories: ${categories.join(", ")}]`)
    })
  }

  if (audit.highRisk.length > 0) {
    console.log(`\n  🔴 HIGH RISK (${audit.highRisk.length} agents):`)
    audit.highRisk.forEach(({ agent, reason }) => {
      console.log(`     * ${agent.filename}  (${reason})`)
    })
  }

  if (audit.mediumRisk.length > 0) {
    console.log(`\n  🟠 MEDIUM RISK (${audit.mediumRisk.length} agents):`)
    audit.mediumRisk.forEach(({ agent, reason }) => {
      console.log(`     * ${agent.filename}  (${reason})`)
    })
  }

  console.log(`\n  🟢 LOW RISK: ${audit.lowRisk.length} agents (Read-only / restricted access)`)
  console.log(`   ------------------------------------------\n`)
}

async function runImportCLI(workspaceRoot: string) {
  const args = process.argv.slice(3)
  const isDryRun = args.includes("--dry-run")

  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: manage-agents import [--dry-run]")
    console.log("Import modified/new agents from OpenCode ($XDG_CONFIG_HOME/opencode/agents/) and modified companion resources (tools/, commands/, skills/, plugins/) into general/, skipping unchanged files.")
    return
  }

  console.log(`\n🔁 Two-Way Sync: Import / Pull from OpenCode`)
  console.log(`   Source: ~/.config/opencode/agents/`)
  console.log(`   Destination: general/agents/`)
  console.log(`   Mode: ${isDryRun ? "DRY RUN" : "EXECUTE"}\n`)

  const preview = previewImport(workspaceRoot)
  const changedAgents = preview.agents.filter(agent => agent.existsInExport && agent.hasDifferences)
  const changedResources = preview.companionResources.filter(resource => resource.existsInExport && resource.hasDifferences)

  if (changedAgents.length === 0 && changedResources.length === 0) {
    console.log("No changes to import (all exported files match local general/). Everything is already in sync.\n")
    return
  }

  console.log(`Preview: ${changedAgents.length} agent(s), ${changedResources.length} companion resource(s) will be imported.`)
  for (const agent of changedAgents) {
    console.log(`   ${agent.existsLocally ? "modified" : "new"} agent: ${path.relative(workspaceRoot, agent.localPath)}`)
  }
  for (const resource of changedResources) {
    console.log(`   ${resource.existsLocally ? "modified" : "new"} resource: ${path.relative(workspaceRoot, resource.localPath)}`)
  }
  console.log("")

  if (isDryRun) {
    console.log("💡 Dry run complete. Run without --dry-run to apply changes.\n")
    return
  }

  const answer = await askQuestion("⚠  Proceed with import/pull from OpenCode? (Y/n): ")
  if (answer.toLowerCase() !== "y" && answer !== "") {
    console.log("\n❌ Import cancelled.")
    return
  }

  try {
    const allowedPaths = [...changedAgents.map(agent => agent.localPath), ...changedResources.map(resource => resource.localPath)]
    const res = repositoryMutation(workspaceRoot, allowedPaths, AUTO_COMMIT_MESSAGES.import, () => importAgents(workspaceRoot))
    console.log(`\n✅ Successfully imported ${res.imported.length} agents and ${res.importedResources.length} companion resources!`)
    if (res.imported.length > 0) console.log(`   Agents: ${res.imported.join(", ")}`)
    if (res.importedResources.length > 0) console.log(`   Companion resources: ${res.importedResources.join(", ")}`)
    console.log(`   Backup: ${res.backupPath ? shortenHome(res.backupPath) : "not needed"}\n`)
  } catch (e: any) {
    console.error(`Error during import: ${e.message || e}`)
  }
}

async function runTuneCLI(workspaceRoot: string) {
  const { findAgentFiles } = await import("./utils/agents.js")
  const args = process.argv.slice(3)

  const usage = () => {
    console.log("Usage: manage-agents tune [options]")
    console.log("  --steps <number>                  Set max execution steps")
    console.log("  --temp <0.0-1.0>                  Set temperature")
    console.log(`  --variant <name> / --effort <name> Set model variant (known: ${KNOWN_MODEL_VARIANTS.join("|")}; model-exposed variants from opencode models --verbose are supported)`)
    console.log("  --clear-variant / --clear-effort  Remove variant from agent frontmatter (revert to model default)")
    console.log("  --category <cat> / --all          Target a specific category or all agents")
  }

  if (args.includes("--help") || args.includes("-h")) {
    usage()
    return
  }

  let steps: number | undefined
  let temp: number | undefined
  let variant: string | null | undefined
  let variantProvided = false
  let clearVariant = false
  let category = ""
  let allCategories = false

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--steps" && args[i + 1]) steps = parseInt(args[++i], 10)
    else if (args[i] === "--temp" && args[i + 1]) temp = parseFloat(args[++i])
    else if ((args[i] === "--category" || args[i] === "-c") && args[i + 1]) category = args[++i]
    else if (args[i] === "--all") allCategories = true
    else if (args[i] === "--clear-variant" || args[i] === "--clear-effort") clearVariant = true
    else if (args[i] === "--variant" || args[i] === "--effort") {
      const value = args[i + 1]
      if (value === undefined || value.trim() === "" || value.startsWith("-")) {
        console.error(`Error: ${args[i]} requires a non-empty variant name.\n`)
        usage()
        process.exitCode = 1
        return
      }
      variant = value
      variantProvided = true
      i++
    }
  }

  if (variantProvided && clearVariant) {
    console.error("Error: --variant/--effort cannot be used with --clear-variant/--clear-effort.\n")
    usage()
    process.exitCode = 1
    return
  }

  if (steps === undefined && temp === undefined && !variantProvided && !clearVariant) {
    console.error("Error: Specify at least one of --steps, --temp, --variant, or --clear-variant.\n")
    usage()
    process.exitCode = 1
    return
  }

  if (clearVariant) variant = null

  const agents = findAgentFiles(workspaceRoot, loadTranslationConfig(workspaceRoot, undefined, { persistMigration: false }).sourceDir)
  const targetAgents = !allCategories && category ? agents.filter(a => a.category === category) : agents

  console.log(`\n🎯 Parameter Tuning CLI`)
  console.log(`   Target agents: ${targetAgents.length}${!allCategories && category ? ` (category: ${category})` : " (all)"}`)
  console.log(`   Steps:       ${steps !== undefined ? steps : "unchanged"}`)
  console.log(`   Temperature: ${temp !== undefined ? temp : "unchanged"}`)
  console.log(`   Variant:     ${variant === undefined ? "unchanged" : variant === null ? "cleared" : variant}\n`)

  const catalog = variant !== undefined && variant !== null ? loadModelCatalog() : undefined
  const allowedVariants = catalog
    ? [...new Set([...KNOWN_MODEL_VARIANTS, ...targetAgents.flatMap(agent => getModelVariants(catalog, agent.model) || [])])]
    : undefined
  repositoryMutation(workspaceRoot, targetAgents.map(a => a.currentPath), AUTO_COMMIT_MESSAGES.tune, () => updateAgentParams(targetAgents, { steps, temperature: temp, variant, allowedVariants }))
  console.log(`✅ Successfully updated parameters for ${targetAgents.length} agents!\n`)
}

async function runPipelineCLI(workspaceRoot: string) {
  const [action] = process.argv.slice(3)
  if (!action || action === "--help" || action === "-h") {
    console.log("Usage: manage-agents pipeline sync-bash [--dry-run]\nModel configurations for the pipeline archetype: manage-agents routing (see ARCHETIPI.md).")
    return
  }
  if (action !== "sync-bash") throw new Error(`Unknown pipeline action '${action}'. Pipeline profiles were removed: use \`manage-agents routing\` for models.`)

  const dryRun = process.argv.slice(4).includes("--dry-run")
  const run = () => syncBashProfiles(workspaceRoot, { dryRun })
  const result = dryRun ? run() : repositoryMutation(workspaceRoot, [path.join(workspaceRoot, resolveSourceSubdir(workspaceRoot), "agents")], AUTO_COMMIT_MESSAGES.pipeline, run)
  console.log(`${dryRun ? "Would rewrite" : "Rewrote"} ${result.changed.length} bash block(s) from ${BASH_PROFILES_FILE}; ${result.unchanged.length} already match; ${result.skipped.length} agent(s) without a bash profile left untouched.`)
  result.changed.forEach(file => console.log(`  ${dryRun ? "~" : "*"} ${file}`))
  if (result.changed.length > 0) console.log("Run `category build --all` to rebuild the pipeline category.")
}

// Model configurations for archetypes (see ARCHETIPI.md): when a primary of the archetype (flow-build
// or flow-plan) runs on a provider or model, which models the subagents it calls use. The TUI edits them with M on the archetype
// folder; this CLI is the scriptable twin. Stored in .agent-manager/agent-routing.json, resolved into
// <source>/plugins/agent-router/routing.json for the runtime plugin.
function runRoutingCLI(workspaceRoot: string) {
  const [action, ...rest] = process.argv.slice(3)
  const usage = `Usage: manage-agents routing show|build|check
       manage-agents routing set <archetype> <provider|provider/model> [<role>=<provider/model#variant|inherit> ...]
       manage-agents routing unset <archetype> <provider|provider/model>
Archetypes: ${ROUTABLE_ARCHETYPES.join(", ")}. The trigger is the model of the calling primary (build or plan); missing roles inherit it. Stored in ${path.relative(workspaceRoot, agentRoutingConfigPath(workspaceRoot))}.`
  if (!action || action === "--help" || action === "-h") { console.log(usage); return }
  const output = agentRoutingOutputPath(workspaceRoot)
  const build = () => {
    const result = repositoryMutation(workspaceRoot, [output], AUTO_COMMIT_MESSAGES.routing, () => buildAgentRouting(workspaceRoot))
    for (const warning of result.warnings) console.warn(`warning: ${warning}`)
    const relative = path.relative(workspaceRoot, result.path)
    console.log(!result.configured ? "No model configurations: nothing to build." : result.changed ? `Wrote ${relative}. Run \`category build --all\` and \`export\` to ship it.` : `${relative} is current.`)
  }
  const simple: Record<string, () => void> = {
    show: () => console.log(describeAgentRouting(workspaceRoot).join("\n")),
    build,
    check: () => {
      const { problems, warnings } = checkAgentRouting(workspaceRoot)
      for (const warning of warnings) console.warn(`warning: ${warning}`)
      if (problems.length) { console.log(problems.join("\n")); process.exitCode = 1 } else console.log("Agent routing is current.")
    },
  }
  if (simple[action]) { simple[action](); return }
  if (action !== "set" && action !== "unset") throw new Error(`Unknown routing action '${action}'\n${usage}`)
  const [archetype, trigger, ...assignments] = rest
  if (!archetype || !trigger || (action === "unset" && assignments.length)) throw new Error(usage)
  const roles: Record<string, string> = {}
  for (const assignment of assignments) {
    const [role, model] = assignment.split("=", 2)
    if (!role || !model) throw new Error(`Expected <role>=<model>, got '${assignment}'\n${usage}`)
    roles[role] = model
  }
  repositoryMutation(workspaceRoot, [agentRoutingConfigPath(workspaceRoot), output, ...archetypeBundles(workspaceRoot).map(bundle => bundle.output)], AUTO_COMMIT_MESSAGES.routing, () => {
    setArchetypeConfig(workspaceRoot, archetype, trigger, action === "unset" ? null : roles)
    rebuildArchetypeBundles(workspaceRoot)
  })
  console.log(`${action === "set" ? "Saved" : "Removed"} configuration ${archetype} / ${trigger}.`)
  console.log(describeAgentRouting(workspaceRoot).join("\n"))
}

const SHARED_SYNC_COMPONENTS: SharedComponentId[] = ["agentManager", "pipelineCore"]
const SHARED_SYNC_HELP = `
Usage: manage-agents sync <status|release|apply> [options]
       manage-agents shared-sync <status|release|apply> [options]

Commands:
  status, diff  Compare shared files and report compatibility and local changes
  release       Create a versioned release bundle with SHA-256 hashes
  apply, import Apply shared files to a target repository (no automatic commit). Apply also brings the
                target to parity: it deletes files the source no longer ships (recorded by an earlier
                sync, deleted in the source history, or matching an explicit pattern such as
                src/agents/pipeline-*.md), seeds missing archetype manifests and model configurations,
                aligns the archetype companion links and the manager's package scripts, and removes
                the retired stamped *-pipeline bundles. Locally modified files are refused without --force.

Usage examples:
  manage-agents sync status --target <repo-or-dir> [--from <source-or-bundle>] [--component all|agent-manager|pipeline-core] [--json] [--check]
  manage-agents sync release --out <dir> [--component all|agent-manager|pipeline-core] [--json]
  manage-agents sync apply --target <repo> [--from <source-or-bundle>] [--component all|agent-manager|pipeline-core] [--dry-run] [--force] [--no-refresh] [--json]

Options:
  --help, -h       Show this help
`

function readSharedSyncJson(file: string): any {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false })
  if (!stat) return null
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Refusing to read non-regular shared sync JSON file: ${file}`)
  return JSON.parse(fs.readFileSync(file, "utf8"))
}

function sharedSyncVersions(root: string, allowReleaseBundle = false): Partial<Record<SharedComponentId, string>> {
  let components: any
  const indexFile = path.join(root, SHARED_SYNC_RELEASE_INDEX)
  if (allowReleaseBundle && fs.existsSync(indexFile)) {
    components = readSharedSyncJson(indexFile)?.components
  } else {
    const manifestFile = path.join(root, ...SHARED_SYNC_MANIFEST_PATH.split("/"))
    if (fs.existsSync(manifestFile)) components = loadSharedSyncManifest(root).components
  }
  return Object.fromEntries(SHARED_SYNC_COMPONENTS.flatMap(component =>
    typeof components?.[component]?.version === "string" ? [[component, components[component].version]] : []
  ))
}

function sharedSyncTargetVersions(root: string): Partial<Record<SharedComponentId, string>> {
  const versions = sharedSyncVersions(root)
  const state = readSharedSyncJson(path.join(root, ...SHARED_SYNC_STATE_PATH.split("/")))
  for (const component of SHARED_SYNC_COMPONENTS) {
    const installed = state?.installedComponents?.[component]
    const version = typeof installed === "string" ? installed : installed?.version
    if (typeof version === "string") versions[component] = version
  }
  return versions
}

function sharedSyncComponents(args: ReturnType<typeof parseSharedSyncArgs>, sourceVersions: Partial<Record<SharedComponentId, string>>): SharedComponentId[] {
  return args.components ?? SHARED_SYNC_COMPONENTS.filter(component => sourceVersions[component] !== undefined)
}

function emptySharedSyncComparison(): SharedSyncComparison {
  return { identical: [], modified: [], missingInTarget: [], protectedByOverlay: [], dirtyTargetFiles: [], obsoleteInTarget: [], alignment: [] }
}

function sharedSyncCounts(comparison: SharedSyncComparison) {
  return {
    identical: comparison.identical.length,
    modified: comparison.modified.length,
    missingInTarget: comparison.missingInTarget.length,
    obsoleteInTarget: comparison.obsoleteInTarget.length,
    alignment: comparison.alignment.length
  }
}

async function runSharedSyncCLI(workspaceRoot: string) {
  try {
    const args = parseSharedSyncArgs(process.argv.slice(3))
    if (args.help) {
      console.log(SHARED_SYNC_HELP)
      return
    }

    if (args.command === "status" || args.command === "diff") {
      if (!args.target) throw new Error("sync status requires --target <repo-or-dir>.")
      const sourceRoot = path.resolve(args.from || workspaceRoot)
      const targetRoot = path.resolve(args.target)
      let comparison = emptySharedSyncComparison()
      let incompatible = false
      let comparisonComplete = true
      let compatibilityMessage: string | null = null
      try {
        comparison = compareSharedSync({ sourceRoot, targetRoot, components: args.components })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!message.startsWith("Cannot apply pipelineCore:")) throw error
        incompatible = true
        comparisonComplete = false
        compatibilityMessage = message
        const sourceVersions = sharedSyncVersions(sourceRoot, true)
        const comparable = sharedSyncComponents(args, sourceVersions).filter(component => component !== "pipelineCore")
        comparison = compareSharedSync({ sourceRoot, targetRoot, components: comparable })
      }

      const sourceVersions = sharedSyncVersions(sourceRoot, true)
      const targetVersions = sharedSyncTargetVersions(targetRoot)
      const components = sharedSyncComponents(args, sourceVersions)
      const compatibility = components.includes("pipelineCore") ? (incompatible ? "incompatible" : "compatible") : "not-applicable"
      const counts = sharedSyncCounts(comparison)
      const outOfSync = counts.modified > 0 || counts.missingInTarget > 0 || counts.obsoleteInTarget > 0 || counts.alignment > 0
      const report = {
        command: args.command,
        source: sourceRoot,
        target: targetRoot,
        components,
        versions: { source: sourceVersions, target: targetVersions },
        compatibility,
        compatibilityMessage,
        comparisonComplete,
        uncomparedComponents: comparisonComplete ? [] : components.filter(component => component === "pipelineCore"),
        counts,
        modified: comparison.modified,
        missingInTarget: comparison.missingInTarget,
        obsoleteInTarget: comparison.obsoleteInTarget,
        alignment: comparison.alignment,
        identical: comparison.identical,
        dirtyTargetFiles: comparison.dirtyTargetFiles,
        protectedByOverlay: comparison.protectedByOverlay,
        outOfSync
      }
      if (args.json) console.log(JSON.stringify(report, null, 2))
      else {
        console.log(`Sincronizzazione condivisa: ${sourceRoot} → ${targetRoot}`)
        console.log(`Componenti: ${components.join(", ") || "nessuno"}`)
        for (const component of components) {
          console.log(`  ${component}: fonte ${sourceVersions[component] ?? "n/d"}; destinazione ${targetVersions[component] ?? "non installato"}`)
        }
        console.log(`Compatibilità: ${compatibility}${compatibilityMessage ? ` — ${compatibilityMessage}` : ""}`)
        console.log(`File: ${counts.identical} identici, ${counts.modified} modificati, ${counts.missingInTarget} mancanti${comparisonComplete ? "" : " (confronto parziale)"}`)
        if (comparison.modified.length) console.log(`Modificati:\n${comparison.modified.map(file => `  - ${file}`).join("\n")}`)
        if (comparison.missingInTarget.length) console.log(`Mancanti:\n${comparison.missingInTarget.map(file => `  - ${file}`).join("\n")}`)
        if (comparison.obsoleteInTarget.length) console.log(`Obsoleti (apply li elimina):\n${comparison.obsoleteInTarget.map(file => `  - ${file}`).join("\n")}`)
        if (comparison.alignment.length) console.log(`Allineamento della repository:\n${comparison.alignment.map(line => `  - ${line}`).join("\n")}`)
        if (comparison.dirtyTargetFiles.length) console.log(`File locali modificati nella destinazione:\n${comparison.dirtyTargetFiles.map(file => `  - ${file}`).join("\n")}`)
        if (comparison.protectedByOverlay.length) console.log(`Protetti dal local overlay: ${comparison.protectedByOverlay.length}`)
      }
      if (args.check && (incompatible || comparison.dirtyTargetFiles.length > 0 || outOfSync)) process.exitCode = 1
      return
    }

    if (args.command === "release" || args.command === "export") {
      if (!args.out) throw new Error("sync release requires --out <dir>.")
      const outputDir = path.resolve(args.out)
      const release = releaseSharedSync({ sourceRoot: workspaceRoot, outputDir, components: args.components })
      const components = Object.fromEntries(Object.entries(release.components).map(([id, component]) => [
        id,
        { version: component?.version, fileCount: release.entries.filter(entry => entry.component === id).length }
      ]))
      const report = { outputDir, components, fileCount: release.entries.length, contentDigest: release.contentDigest, sourceCommit: release.sourceCommit }
      if (args.json) console.log(JSON.stringify(report, null, 2))
      else {
        console.log(`Release condivisa creata: ${outputDir}`)
        for (const [component, detail] of Object.entries(components)) {
          console.log(`  ${component} ${detail.version}: ${detail.fileCount} file`)
        }
        console.log(`Totale: ${release.entries.length} file`)
        console.log(`SHA-256 contentDigest: ${release.contentDigest}`)
      }
      return
    }

    if (args.command === "apply" || args.command === "import") {
      if (!args.target) throw new Error("sync apply requires --target <repo>.")
      const sourceRoot = path.resolve(args.from || workspaceRoot)
      const targetRoot = path.resolve(args.target)
      const before = compareSharedSync({ sourceRoot, targetRoot, components: args.components })
      const result = applySharedSync({
        sourceRoot,
        targetRoot,
        components: args.components,
        dryRun: args.dryRun,
        force: args.force,
        refreshPipelines: args.refreshPipelines
      })
      const sourceVersions = sharedSyncVersions(sourceRoot, true)
      const components = sharedSyncComponents(args, sourceVersions)
      const added = result.updated.filter(file => before.missingInTarget.includes(file)).length
      const updated = result.updated.length - added
      const refreshRequested = components.includes("pipelineCore") && args.refreshPipelines !== false
      const bashProfilesRefreshed = refreshRequested && !result.dryRun && fs.existsSync(path.join(targetRoot, ".agent-manager", "bash-profiles.json"))
      const report = {
        dryRun: result.dryRun,
        source: sourceRoot,
        target: targetRoot,
        appliedComponents: components,
        versions: Object.fromEntries(components.map(component => [component, sourceVersions[component]])),
        added,
        updated,
        filesToWrite: result.updated,
        filesToRemove: result.removed,
        refreshed: { bashProfiles: bashProfilesRefreshed },
        noAutomaticGitCommit: true
      }
      if (args.json) console.log(JSON.stringify(report, null, 2))
      else {
        console.log(`${result.dryRun ? "Anteprima sincronizzazione" : "Sincronizzazione applicata"}: ${sourceRoot} → ${targetRoot}`)
        for (const component of components) console.log(`  ${component} ${sourceVersions[component] ?? "versione n/d"}`)
        console.log(`File: ${added} da aggiungere, ${updated} da aggiornare (${result.updated.length} scritture previste/eseguite), ${result.removed.length} da eliminare`)
        if (before.obsoleteInTarget.length) console.log(`Obsoleti ${result.dryRun ? "da eliminare" : "eliminati"}:\n${before.obsoleteInTarget.map(file => `  - ${file}`).join("\n")}`)
        if (before.alignment.length) console.log(`Allineamento della repository${result.dryRun ? " previsto" : ""}:\n${before.alignment.map(line => `  - ${line}`).join("\n")}`)
        console.log(`Refresh profili Bash: ${bashProfilesRefreshed ? "eseguito" : !refreshRequested ? "non richiesto" : result.dryRun ? "non eseguito (dry-run)" : "non presente"}`)
        console.log("Nessun commit Git automatico creato: controlla `git diff` e `git status` nella destinazione.")
        if (!result.dryRun) {
          console.log("Poi, nella destinazione:")
          console.log("  npm --prefix manage-agents ci && npm --prefix manage-agents run validate   # rigenera categorie e routing.json e verifica")
          console.log("  node manage-agents/manage-agents.mjs --no-auto-commit category build --all   # categorie e routing.json")
          console.log("  node manage-agents/manage-agents.mjs --no-auto-commit bridge --category pipeline --target claude   # e --target codex")
          console.log("  node manage-agents/manage-agents.mjs export --all --yes                    # installa in OpenCode")
          console.log("  TUI, tasto o: riordina export/categories/general se lo usi")
        }
      }
      return
    }

    throw new Error(`Unknown shared sync command '${args.command}'.`)
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

async function runCategory(workspaceRoot: string) {
  const rootCategoryConfigDir = path.join(workspaceRoot, ".agent-manager", "categories")
  const hasRootCategoryConfig = fs.existsSync(rootCategoryConfigDir)
  const repoRoot = !hasRootCategoryConfig && path.basename(workspaceRoot) === "agents" ? path.dirname(workspaceRoot) : workspaceRoot
  const categoryConfigDir = hasRootCategoryConfig ? rootCategoryConfigDir : path.join(workspaceRoot, "agents", ".agent-manager", "categories")
  const args = process.argv.slice(3)
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: manage-agents category list|explain|status|build|check|package <id> [options]")
    return
  }
  const parsed = parseCategoryArgs(args)
  if (parsed.action === "recover") { recoverBuildAllCategoryDistributions(repoRoot); console.log("Recovered category build journal."); return }
  if (parsed.action === "list") { console.log(fs.existsSync(categoryConfigDir) ? fs.readdirSync(categoryConfigDir).filter(file => file.endsWith(".json")).map(file => file.slice(0, -5)).sort().join("\n") : ""); return }
  const ids = parsed.ids?.length ? parsed.ids : parsed.id ? [parsed.id] : fs.existsSync(categoryConfigDir) ? fs.readdirSync(categoryConfigDir).filter(file => file.endsWith(".json")).map(file => file.slice(0, -5)).sort() : []
  if (parsed.action === "explain") { const result = ids.map(id => loadCategoryManifest(repoRoot, id)); console.log(parsed.json ? JSON.stringify(result) : result.map(value => JSON.stringify(value, null, 2)).join("\n")); return }
  if (parsed.action === "package") { const result = packageCategoryDistributions(repoRoot, parsed.ids || ids, parsed.output || "", parsed.dryRun); console.log(parsed.json ? JSON.stringify(result) : `${parsed.dryRun ? "Would package" : "Packaged"} ${result.categories.join(", ")} to ${parsed.output}`); return }
  const all = !parsed.id
  // routing.json lives in the canonical plugin directory, so it is rebuilt before the manifests copy it.
  const routingInScope = all || ids.some(isRoutableArchetype)
  if (routingInScope && parsed.action === "build") repositoryMutation(repoRoot, [agentRoutingOutputPath(repoRoot)], AUTO_COMMIT_MESSAGES.routing, () => buildAgentRouting(repoRoot))
  const routingCheck = routingInScope && (parsed.action === "check" || parsed.action === "status") ? checkAgentRouting(repoRoot) : { problems: [], warnings: [] }
  const results = parsed.action === "build" && all
    ? buildAllCategoryDistributions(repoRoot)
    : ids.map(id => parsed.action === "check" || parsed.action === "status" ? checkCategoryDistribution(repoRoot, id) : repositoryMutation(repoRoot, [path.join(repoRoot, resolveCategoriesSubdir(repoRoot), id)], `chore(agent-manager): build ${id} category`, () => buildCategoryDistribution(repoRoot, id)))
  const pipelineInScope = all || ids.includes("pipeline")
  // The bash allowlists of the canonical pipeline agents come from .agent-manager/bash-profiles.json.
  const bashDrifts = pipelineInScope ? checkBashProfiles(repoRoot) : []
  // The built pipeline bundle must ship every tool its agents permit and every helper those tools import.
  const pipelineBundleSubdir = path.join(resolveCategoriesSubdir(repoRoot), "pipeline")
  const pipelineProblems = pipelineInScope && fs.existsSync(path.join(repoRoot, pipelineBundleSubdir, "agents"))
    ? checkPipelineResources(path.join(repoRoot, pipelineBundleSubdir), findAgentFiles(repoRoot, pipelineBundleSubdir))
    : []
  if (parsed.json) console.log(JSON.stringify(bashDrifts.length || pipelineProblems.length || routingCheck.problems.length ? { categories: results, ...(bashDrifts.length ? { bashDrifts } : {}), ...(pipelineProblems.length ? { pipelineProblems } : {}), ...(routingCheck.problems.length ? { routing: routingCheck } : {}) } : results))
  else {
    results.forEach((result, index) => console.log(result.status === "current" ? `Category ${ids[index]} is current.` : `Category ${ids[index]} is stale.\nMissing: ${result.missing.join(", ") || "none"}\nChanged: ${result.changed.join(", ") || "none"}\nExtra: ${result.extra.join(", ") || "none"}`))
    for (const problem of routingCheck.problems) console.log(`Agent routing: ${problem}`)
    for (const warning of routingCheck.warnings) console.log(`Agent routing warning: ${warning}`)
    if (pipelineProblems.length) console.log(`Pipeline bundle is incomplete:\n${pipelineProblems.map(problem => `  - [${problem.kind}] ${problem.detail}`).join("\n")}`)
    for (const drift of bashDrifts) console.log(`Bash allowlist drift in ${drift.file} (role ${drift.role}, ${drift.problem}); fix with \`pipeline sync-bash\` then \`category build --all\`:\n${drift.diff.map(line => `    ${line}`).join("\n")}`)
  }
  const failed = bashDrifts.length > 0 || pipelineProblems.length > 0 || routingCheck.problems.length > 0
  if ((parsed.action === "check" || parsed.action === "status") && (results.some(result => result.status !== "current") || failed)) process.exitCode = 1
  if (parsed.action === "build" && failed) process.exitCode = 1
}
// Pack content may be hostile: escape C1 controls, which JSON.stringify leaves raw and some terminals interpret.
const printJson = (value: unknown) => console.log(JSON.stringify(value, null, 2).replace(/[\u007f-\u009f]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`))

/** Splits CLI arguments; returns an error message for unknown options or missing option values. */
function parseCliArgs(args: string[], valued: string[], booleans: string[]): { positional: string[]; values: Record<string, string>; flags: Set<string> } | string {
  const positional: string[] = []
  const values: Record<string, string> = {}
  const flags = new Set<string>()
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg.startsWith("--")) positional.push(arg)
    else if (valued.includes(arg)) {
      if (args[i + 1] === undefined || args[i + 1].startsWith("--")) return `${arg} needs a value`
      values[arg] = args[++i]
    } else if (booleans.includes(arg)) flags.add(arg)
    else return `unknown option ${terminalSafeText(arg)}`
  }
  return { positional, values, flags }
}

function cliError(message: string, code = 2) {
  console.error(`Error: ${message.split("\n").map(terminalSafeText).join("\n")}`)
  process.exitCode = code
}

function printPackValidation(validation: PackValidation) {
  const { manifest, ids, unresolved, issues } = validation
  const safe = terminalSafeText
  console.log(manifest ? `Pack ${safe(manifest.name)} ${safe(manifest.version)} (contract ${safe(manifest.contract)}): ${safe(validation.root)}` : `Pack at ${safe(validation.root)}`)
  const counts = Object.entries(ids).filter(([, list]) => list.length).map(([kind, list]) => `${list.length} ${kind}`)
  if (counts.length) console.log(`  Contents: ${counts.join(", ")}`)
  const surface = describeExecutable(validation)
  if (surface.length) console.log(`  Executable surface:\n${surface.map(item => `    - ${safe(item)}`).join("\n")}`)
  if (unresolved.length) console.log(`  Unresolved (must come from a required pack):\n${unresolved.map(ref => `    - ${safe(ref.from)}: ${ref.kind} ${safe(ref.target)}`).join("\n")}`)
  for (const issue of issues) console.log(`  ${issue.level === "error" ? "ERROR" : "warning"} [${issue.code}]${issue.path ? ` ${safe(issue.path)}` : ""}: ${safe(issue.message)}`)
  const errors = issues.filter(issue => issue.level === "error").length
  console.log(errors ? `  ${errors} error(s): the pack does not satisfy the contract.` : "  The pack satisfies the contract.")
}

function runPackCLI() {
  const [action, ...rest] = process.argv.slice(3)
  if ((action !== "validate" && action !== "list") || rest.includes("--help") || rest.includes("-h")) {
    console.log("Usage: manage-agents pack validate <pack-dir>... [--json] [--git]")
    console.log("       manage-agents pack list [--json]")
    console.log("validate checks directories against the OpenCode pack contract (manage-agents/contract/CONTRACT.md); --git applies the rules for git sources. list shows the packs offered by the registered sources.")
    if (action !== "validate" && action !== "list" && action !== "--help" && action !== "-h") process.exitCode = 2
    return
  }
  const parsed = parseCliArgs(rest, [], action === "validate" ? ["--json", "--git"] : ["--json"])
  if (typeof parsed === "string") return cliError(parsed)
  if (action === "list") {
    const { candidates, problems } = discoverAllPacks(loadSources())
    if (parsed.flags.has("--json")) return printJson({ packs: candidates.map(({ manifest, ...candidate }) => ({ ...candidate, name: manifest.name, version: manifest.version, description: manifest.description, requires: manifest.requires })), problems })
    if (!candidates.length && !problems.length) console.log("No packs. Register a source with `manage-agents source add <name> <dir|git-url>`.")
    for (const candidate of candidates) console.log(`${terminalSafeText(candidate.source)}/${terminalSafeText(candidate.manifest.name)}@${terminalSafeText(candidate.manifest.version)}  ${terminalSafeText(candidate.relativeDir)}  ${terminalSafeText(candidate.manifest.description)}`)
    for (const problem of problems) console.log(`warning: ${terminalSafeText(problem)}`)
    return
  }
  if (!parsed.positional.length) return cliError("pack validate needs at least one pack directory.")
  const results = parsed.positional.map(dir => validatePack(dir, { sourceKind: parsed.flags.has("--git") ? "git" : "local" }))
  if (parsed.flags.has("--json")) printJson(results.length === 1 ? results[0] : results)
  else results.forEach(printPackValidation)
  if (results.some(hasErrors)) process.exitCode = 1
}

const SOURCE_USAGE = `Usage: manage-agents source <command>
  list [--json]                                   registered sources
  add <name> <dir|git-url> [--ref <ref>] [--trust]  register a local directory or a git repository (https:, ssh:, git@host:path)
  remove <name>
  pull [<name>...]                                clone or fetch git sources into the cache (default: all)
  trust <name> | untrust <name>                   allow installing executable content from the source without asking
  prefer <pack> <source> | prefer <pack> --clear  which source to use when several offer the same pack
Sources live in $XDG_CONFIG_HOME/manage-agents/sources.json; git checkouts in $XDG_CACHE_HOME/manage-agents/sources/.`

function runSourceCLI() {
  const [action, ...rest] = process.argv.slice(3)
  if (!action || action === "--help" || action === "-h" || rest.includes("--help")) {
    console.log(SOURCE_USAGE)
    if (!action) process.exitCode = 2
    return
  }
  const parsed = parseCliArgs(rest, action === "add" ? ["--ref"] : [], action === "add" ? ["--trust"] : action === "list" ? ["--json"] : action === "prefer" ? ["--clear"] : [])
  if (typeof parsed === "string") return cliError(parsed)
  const [first, second] = parsed.positional
  try {
    const registry = loadSources()
    const safe = terminalSafeText
    if (action === "list") {
      if (parsed.flags.has("--json")) return printJson(registry)
      if (!registry.sources.length) console.log("No sources. Add one with `manage-agents source add <name> <dir|git-url>`.")
      for (const source of registry.sources) {
        const location = source.kind === "local" ? source.path : `${source.url}${source.ref ? `#${source.ref}` : ""} (${sourceRevision(source)?.slice(0, 12) ?? "not pulled"})`
        console.log(`${safe(source.name)}  ${source.kind}  ${source.trusted ? "trusted" : "untrusted"}  ${safe(location)}`)
      }
      for (const [pack, source] of Object.entries(registry.prefer)) console.log(`prefer ${safe(pack)} from ${safe(source)}`)
      return
    }
    if (action === "add") {
      if (!first || !second || parsed.positional.length > 2) return cliError("usage: source add <name> <dir|git-url> [--ref <ref>] [--trust]")
      const source = addSource(registry, first, second, { ref: parsed.values["--ref"], trusted: parsed.flags.has("--trust") })
      saveSources(registry)
      console.log(`Added ${source.kind} source ${safe(source.name)}${source.trusted ? " (trusted)" : ""}.${source.kind === "git" ? ` Fetch it with \`manage-agents source pull ${source.name}\`.` : ""}`)
      return
    }
    if (action === "remove") {
      if (!first || parsed.positional.length > 1) return cliError("usage: source remove <name>")
      removeSource(registry, first)
      saveSources(registry)
      console.log(`Removed source ${safe(first)}. Its cached checkout, if any, stays in the cache directory.`)
      return
    }
    if (action === "pull") {
      const sources = parsed.positional.length ? parsed.positional.map(name => findSource(registry, name)) : registry.sources.filter(source => source.kind === "git")
      for (const source of sources) {
        const commit = pullSource(source)
        console.log(commit ? `${safe(source.name)}: ${commit.slice(0, 12)}` : `${safe(source.name)}: local source, nothing to pull`)
      }
      return
    }
    if (action === "trust" || action === "untrust") {
      if (!first || parsed.positional.length > 1) return cliError(`usage: source ${action} <name>`)
      findSource(registry, first).trusted = action === "trust"
      saveSources(registry)
      console.log(`Source ${safe(first)} is now ${action === "trust" ? "trusted" : "untrusted"}.`)
      return
    }
    if (action === "prefer") {
      if (!first || !PACK_NAME_RE.test(first) || (parsed.flags.has("--clear") ? second !== undefined : !second)) return cliError("usage: source prefer <pack> <source> | source prefer <pack> --clear")
      if (parsed.flags.has("--clear")) delete registry.prefer[first]
      else registry.prefer[first] = findSource(registry, second).name
      saveSources(registry)
      console.log(parsed.flags.has("--clear") ? `Cleared the source preference for ${safe(first)}.` : `Pack ${safe(first)} now comes from ${safe(second)}.`)
      return
    }
    cliError(`unknown source command ${safe(action)}\n${SOURCE_USAGE}`)
  } catch (error) {
    cliError(error instanceof Error ? error.message : String(error), 1)
  }
}

const formatLockChange = (change: LockChange) => `  ${change.kind} ${terminalSafeText(change.name)}${change.from ? ` ${terminalSafeText(change.from)}` : ""}${change.to ? ` -> ${terminalSafeText(change.to)}` : ""}`

function runResolveCLI() {
  const args = process.argv.slice(3)
  if (!args.length || args.includes("--help") || args.includes("-h")) {
    console.log("Usage: manage-agents resolve <[source/]pack[@range]>... [--target <opencode-config-dir>] [--json]")
    console.log("Resolves packs and their dependencies across the registered sources and prints the result, the changes against the target's lock and the executable surface. Writes nothing.")
    if (!args.length) process.exitCode = 2
    return
  }
  const parsed = parseCliArgs(args, ["--target"], ["--json"])
  if (typeof parsed === "string") return cliError(parsed)
  try {
    const requests = parsed.positional.map(parsePackRequest)
    const registry = loadSources()
    const { candidates, problems: discoveryProblems } = discoverAllPacks(registry)
    const resolution = resolvePacks(requests, candidates, { prefer: registry.prefer, revisionOf: name => sourceRevision(findSource(registry, name)) })
    const target = path.resolve(parsed.values["--target"] ?? defaultTarget())
    const lock = resolution.problems.length ? null : buildLock(resolution)
    const previousLock = readLock(target)
    const diff = lock ? diffLocks(previousLock, lock) : { changes: [], executable: [] }
    const confirmations = lock ? confirmationsNeeded(lock, previousLock) : []
    const warnings = [...discoveryProblems, ...resolution.warnings]
    if (parsed.flags.has("--json")) printJson({ target, packs: resolution.packs.map(({ validation, ...pack }) => pack), ...(lock ? { lock } : {}), changes: diff.changes, executableChanges: diff.executable, confirmations, problems: resolution.problems, warnings })
    else {
      const safe = terminalSafeText
      console.log(`Resolution for ${safe(target)}:`)
      for (const pack of resolution.packs) {
        console.log(`  ${safe(pack.name)}@${safe(pack.version)} from ${safe(pack.source)}${pack.revision ? `@${pack.revision.slice(0, 12)}` : ""}${pack.root ? "" : `  (required by ${pack.requiredBy.map(safe).join(", ")})`}${pack.trusted ? "" : "  [untrusted]"}`)
        for (const item of pack.executable) console.log(`      runs: ${safe(item)}`)
      }
      if (diff.changes.length) console.log(`Changes against the lock:\n${diff.changes.map(formatLockChange).join("\n")}`)
      for (const reason of confirmations) console.log(`needs confirmation: ${safe(reason)}`)
      for (const warning of warnings) console.log(`warning: ${safe(warning)}`)
      for (const problem of resolution.problems) console.log(`ERROR: ${safe(problem)}`)
      console.log(resolution.problems.length ? "Resolution failed." : "Resolution succeeded. Nothing was written.")
    }
    if (resolution.problems.length) process.exitCode = 1
  } catch (error) {
    cliError(error instanceof Error ? error.message : String(error), 1)
  }
}

const TARGET_USAGE = `Usage: manage-agents <command> [--target <opencode-config-dir>]
  install <[source/]pack[@range]>... [--adopt] [--yes] [--dry-run] [--json]
                     add root packs; packs already installed keep their locked version
  uninstall <pack>... [--dry-run] [--json]
                     remove root packs; dependencies still required stay
  update [<pack>...] [--adopt] [--yes] [--dry-run] [--json]
                     pull the git sources of the named packs (all packs when none is named) and re-resolve within the ranges
  reconcile [--adopt] [--dry-run] [--json]
                     rebuild the target from its desired state and lock (repairs missing or deleted files)
  status [--json]    read-only drift report; exit 1 when something differs
  restore <backup-id>
                     put back what --adopt replaced; the restored content becomes unmanaged
--adopt backs up and replaces files and config entries that are not managed or were changed locally.
--yes accepts executable content that needs confirmation (required without a terminal).
Default target: $XDG_CONFIG_HOME/opencode (~/.config/opencode). State lives in <target>/.manage-agents/.`

async function confirmInTerminal(reasons: string[], yes: boolean): Promise<boolean> {
  for (const reason of reasons) console.log(`needs confirmation: ${terminalSafeText(reason)}`)
  if (yes) return true
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("Error: this change needs confirmation; review the lines above and rerun with --yes.")
    return false
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const answer = await new Promise<string>(resolve => rl.question("Proceed? [y/N] ", resolve))
  rl.close()
  return /^y(es)?$/i.test(answer.trim())
}

function printChangeResult(command: string, target: string, result: ChangeResult, json: boolean) {
  const plan = result.plan
  const problems = [...(result.change?.problems ?? []), ...(plan?.conflicts ?? [])]
  const warnings = [...(result.change?.warnings ?? []), ...(plan?.warnings ?? [])]
  if (json) {
    printJson({
      command, target, status: result.status, recovered: result.recovered, changes: result.changes, confirmations: result.confirmations, problems, warnings,
      writes: plan?.writes.map(({ rel, kind }) => ({ path: rel, kind })) ?? [], deletes: plan?.deletes ?? [], released: plan?.released ?? [],
      configChanged: plan ? plan.configText !== null : false, backupId: result.backupId,
    })
    return
  }
  const safe = terminalSafeText
  if (result.recovered) console.log("Rolled back an interrupted transaction first.")
  if (result.changes.length) console.log(`Packs:\n${result.changes.map(formatLockChange).join("\n")}`)
  if (plan && !problems.length) {
    const count = (kind: string) => plan.writes.filter(write => write.kind === kind).length
    console.log(`Files: ${count("create")} new, ${count("update")} updated, ${count("adopt")} adopted, ${plan.deletes.length} removed${plan.configText !== null ? `; ${plan.configFile} updated` : ""}.`)
    if (result.status === "dry-run") {
      for (const write of plan.writes) console.log(`  ${write.kind} ${safe(write.rel)}`)
      for (const rel of plan.deletes) console.log(`  remove ${safe(rel)}`)
    }
  }
  for (const warning of warnings) console.log(`warning: ${safe(warning)}`)
  for (const problem of problems) console.log(`ERROR: ${safe(problem)}`)
  const outcome: Record<ChangeResult["status"], string> = {
    applied: `Done: ${safe(target)} is up to date.${result.backupId ? ` Replaced content was saved; undo with \`manage-agents restore ${result.backupId}\`.` : ""}`,
    unchanged: `Nothing to do: ${safe(target)} is already up to date.`,
    "dry-run": "Dry run: nothing was written.",
    failed: "Nothing was written.",
    declined: "Not confirmed: nothing was written.",
  }
  console.log(outcome[result.status])
  if (result.status === "failed" || result.status === "declined") process.exitCode = 1
}

async function runTargetCLI(command: "install" | "uninstall" | "update" | "reconcile" | "status" | "restore") {
  const args = process.argv.slice(3)
  if (args.includes("--help") || args.includes("-h")) return console.log(TARGET_USAGE)
  const booleans = { install: ["--adopt", "--yes", "--dry-run", "--json"], update: ["--adopt", "--yes", "--dry-run", "--json"], reconcile: ["--adopt", "--dry-run", "--json"], uninstall: ["--dry-run", "--json"], status: ["--json"], restore: [] }[command]
  const parsed = parseCliArgs(args, ["--target"], booleans)
  if (typeof parsed === "string") return cliError(`${parsed}\n${TARGET_USAGE}`)
  const names = parsed.positional
  if ((command === "install" || command === "uninstall" || command === "restore") && !names.length) return cliError(`${command} needs at least one argument\n${TARGET_USAGE}`)
  if ((command === "reconcile" || command === "status") && names.length) return cliError(`${command} takes no pack names\n${TARGET_USAGE}`)
  try {
    const target = realpathThroughExistingAncestor(path.resolve(parsed.values["--target"] ?? defaultTarget()))
    const registry = loadSources()
    const json = parsed.flags.has("--json")
    if (command === "status") {
      const status = targetStatus(target, registry)
      if (json) printJson({ target, roots: status.desired.roots, packs: Object.fromEntries(Object.entries(status.lock?.packs ?? {}).map(([name, pack]) => [name, { source: pack.source, version: pack.version, revision: pack.revision }])), drift: status.drift })
      else {
        console.log(`Target ${terminalSafeText(target)}`)
        console.log(status.lock && Object.keys(status.lock.packs).length ? `Packs:\n${Object.entries(status.lock.packs).map(([name, pack]) => `  ${terminalSafeText(name)}@${terminalSafeText(pack.version)} from ${terminalSafeText(pack.source)}${pack.revision ? `@${pack.revision.slice(0, 12)}` : ""}${status.desired.roots.some(root => parsePackRequest(root).name === name) ? "" : " (dependency)"}`).join("\n")}` : "No packs installed.")
        for (const line of status.drift) console.log(`drift: ${terminalSafeText(line)}`)
        if (!status.drift.length) console.log("In sync.")
      }
      if (status.drift.length) process.exitCode = 1
      return
    }
    if (command === "restore") {
      const restored = await restoreBackup(target, names[0])
      console.log(`Restored ${restored.files.length} file(s) and ${restored.config.length} config entr${restored.config.length === 1 ? "y" : "ies"}; they are no longer managed. \`manage-agents status\` shows what now differs from the packs.`)
      return
    }
    const options = { adopt: parsed.flags.has("--adopt"), dryRun: parsed.flags.has("--dry-run"), confirm: (reasons: string[]) => confirmInTerminal(reasons, parsed.flags.has("--yes")) }
    const compute = command === "install" ? installChange(registry, names)
      : command === "uninstall" ? uninstallChange(names)
        : command === "update" ? updateChange(registry, names)
          : reconcileChange
    const result = await changeTarget(target, command, registry, compute, options)
    printChangeResult(command, target, result, json)
  } catch (error) {
    cliError(error instanceof Error ? error.message : String(error), 1)
  }
}

const SETTINGS_USAGE = `Usage (user settings applied at reconcile; never written into packs):
  models show [--json]
  models set <pack> <trigger> <agent>=<provider/model[#variant]|inherit>...
                     when a caller of archetype <pack> runs on <trigger> (a provider, or provider/model), route its subagents
  models unset <pack> <trigger> [<agent>...]
  models pin <pack>/<agent> <provider/model[#variant]>
                     give a subagent a fixed model: routing skips it (writes the override "model")
  models unpin <pack>/<agent>
                     drop any fixed model, including the pack's own, so the subagent follows routing
  override show [--json]
  override set <pack>/<id> <field>=<value>... [--command]
                     patch frontmatter of an installed agent (or command with --command); value is YAML, null removes the field
  override unset <pack>/<id> [<field>...] [--command]
Common options: --target <opencode-config-dir> (default $XDG_CONFIG_HOME/opencode), --global (applies to every target;
default: only this target), --no-reconcile, --yes. Settings live in $XDG_CONFIG_HOME/manage-agents/{routing,overrides}.json.`

function splitPackId(spec: string): [string, string] {
  const slash = spec.indexOf("/")
  if (slash <= 0 || slash === spec.length - 1) throw new Error(`"${spec}" must be <pack>/<id>`)
  return [spec.slice(0, slash), spec.slice(slash + 1)]
}

function parseAssignments(items: string[], parseValue: (raw: string) => unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const item of items) {
    const equals = item.indexOf("=")
    if (equals <= 0) throw new Error(`"${item}" must be <name>=<value>`)
    Object.defineProperty(out, item.slice(0, equals), { value: parseValue(item.slice(equals + 1)), enumerable: true, writable: true, configurable: true })
  }
  return out
}

async function runSettingsCLI(command: "models" | "override") {
  const [action, ...rest] = process.argv.slice(3)
  if (!action || action === "--help" || action === "-h" || rest.includes("--help")) {
    console.log(SETTINGS_USAGE)
    if (!action) process.exitCode = 2
    return
  }
  const parsed = parseCliArgs(rest, ["--target"], ["--global", "--no-reconcile", "--yes", "--json", ...(command === "override" ? ["--command"] : [])])
  if (typeof parsed === "string") return cliError(`${parsed}\n${SETTINGS_USAGE}`)
  try {
    const target = realpathThroughExistingAncestor(path.resolve(parsed.values["--target"] ?? defaultTarget()))
    const scopeTarget = parsed.flags.has("--global") ? null : target
    const scopeLabel = scopeTarget === null ? "every target" : terminalSafeText(target)
    const [first, ...others] = parsed.positional
    if (action === "show") {
      const settings = command === "models" ? loadRoutingSettings() : loadOverrideSettings()
      const view = { default: settings.default, target: settings.targets[target] ?? {} }
      const routingFile = path.join(target, "plugins", "manage-agents-router", "routing.json")
      const installed = command === "models" && fs.existsSync(routingFile) ? JSON.parse(fs.readFileSync(routingFile, "utf8")) : null
      if (parsed.flags.has("--json")) return printJson(command === "models" ? { ...view, installed } : view)
      console.log(`Settings for every target:\n${JSON.stringify(view.default, null, 2)}`)
      console.log(`Settings for ${terminalSafeText(target)} (win over the above):\n${JSON.stringify(view.target, null, 2)}`)
      if (command === "models") console.log(installed ? `Installed routing (packs' defaults + settings):\n${JSON.stringify(installed.archetypes, null, 2)}` : "No archetype pack is installed in this target.")
      return
    }
    let message: string
    if (command === "models") {
      if (action === "set" || action === "unset") {
        if (!first || !others.length && action === "set") return cliError(`usage: models ${action} <pack> <trigger> ...\n${SETTINGS_USAGE}`)
        const [trigger, ...assignments] = others
        const settings = loadRoutingSettings()
        const scope = scopeOf(settings, scopeTarget)
        if (action === "set") setRoutes(scope, first, trigger, parseAssignments(assignments, raw => raw) as Record<string, string>)
        else if (!unsetRoutes(scope, first, trigger ?? "", assignments)) return cliError(`no routing for ${first} ${trigger ?? ""} in ${scopeLabel}`, 1)
        saveRoutingSettings(settings)
        message = `Routing of ${terminalSafeText(first)} for ${terminalSafeText(trigger)} updated for ${scopeLabel}.`
      } else if (action === "pin" || action === "unpin") {
        if (!first || (action === "pin" ? others.length !== 1 : others.length)) return cliError(`usage: models ${action} <pack>/<agent>${action === "pin" ? " <provider/model[#variant]>" : ""}`)
        const [pack, agent] = splitPackId(first)
        const settings = loadOverrideSettings()
        setOverride(scopeOf(settings, scopeTarget), pack, "agents", agent, { model: action === "pin" ? others[0] : null })
        saveOverrideSettings(settings)
        message = action === "pin" ? `${terminalSafeText(first)} is pinned to ${terminalSafeText(others[0])} for ${scopeLabel}.` : `${terminalSafeText(first)} has no fixed model for ${scopeLabel}: it follows routing.`
      } else return cliError(`unknown models command ${terminalSafeText(action)}\n${SETTINGS_USAGE}`)
    } else {
      if (action !== "set" && action !== "unset") return cliError(`unknown override command ${terminalSafeText(action)}\n${SETTINGS_USAGE}`)
      if (!first || (action === "set" && !others.length)) return cliError(`usage: override ${action} <pack>/<id> ...\n${SETTINGS_USAGE}`)
      const [pack, id] = splitPackId(first)
      const kind = parsed.flags.has("--command") ? "commands" : "agents"
      const settings = loadOverrideSettings()
      const scope = scopeOf(settings, scopeTarget)
      if (action === "set") setOverride(scope, pack, kind, id, parseAssignments(others, raw => YAML.parse(raw)))
      else if (!unsetOverride(scope, pack, kind, id, others)) return cliError(`no override for ${first} in ${scopeLabel}`, 1)
      saveOverrideSettings(settings)
      message = `Override of ${terminalSafeText(first)} updated for ${scopeLabel}.`
    }
    console.log(message)
    if (parsed.flags.has("--no-reconcile")) return console.log("Not reconciled: run `manage-agents reconcile` to apply it.")
    if (!readLock(target)) return console.log(`Nothing is installed in ${terminalSafeText(target)}; the setting applies at the next install.`)
    const registry = loadSources()
    const result = await changeTarget(target, command, registry, reconcileChange, { confirm: (reasons: string[]) => confirmInTerminal(reasons, parsed.flags.has("--yes")) })
    printChangeResult("reconcile", target, result, false)
    if (scopeTarget === null) console.log("Other targets pick the change up at their next `manage-agents reconcile --target <dir>`.")
  } catch (error) {
    cliError(error instanceof Error ? error.message : String(error), 1)
  }
}

function runTopicExport(workspaceRoot: string) {
  console.error("Warning: topic-export is deprecated; use category build/check wiki.")
  const legacy = process.argv.slice(3); const check = legacy.includes("--check")
  process.argv = [...process.argv.slice(0, 3), check ? "check" : "build", "wiki", ...legacy.filter(arg => arg !== "wiki" && arg !== "--check")]
  runCategory(workspaceRoot)
}

async function run() {
  const autoCommit = parseAutoCommitArgs(process.argv.slice(2))
  process.env.AGENT_MANAGER_AUTO_COMMIT = autoCommit.enabled ? "1" : "0"
  process.argv = [...process.argv.slice(0, 2), ...autoCommit.argv]
  const workingDirectory = path.resolve(process.cwd())
  const workspaceCandidates = [
    workingDirectory,
    path.join(workingDirectory, "agents"),
    path.resolve(workingDirectory, "..")
  ]
  const workspaceRoot = workspaceCandidates.find((candidate) =>
    fs.existsSync(path.join(candidate, "src", "agents")) || fs.existsSync(path.join(candidate, "general", "agents"))
  ) || workingDirectory

  const extension = await loadExtension(process.env.MANAGE_AGENTS_EXTENSION || new URL("./extensions.js", import.meta.url))
  const extensionCommands = Object.keys(extension?.commands ?? {}).filter(name => !name.startsWith("-"))

  // Intercept CLI commands
  if (process.argv[2] === "--help" || process.argv[2] === "-h") {
    console.log("Usage: manage-agents <command> [options]")
    console.log(`Commands: ${["create", "bridge", "export", "lint", "fix-names", "audit", "import", "tune", "pipeline", "routing", "pack", "source", "resolve", "install", "uninstall", "update", "reconcile", "status", "restore", "models", "override", "category", "sync", ...extensionCommands].join(", ")}`)
    return
  }

  if (process.argv[2] === "sync" || process.argv[2] === "shared-sync") {
    await runSharedSyncCLI(workspaceRoot)
    return
  }

  if (process.argv[2] === "create") {
    const agentName = process.argv[3]
    await runCreate(agentName, workspaceRoot)
    return
  }

  if (process.argv[2] === "bridge") {
    await runBridge(workspaceRoot)
    return
  }

  if (process.argv[2] === "export") {
    await runExport(workspaceRoot)
    return
  }

  if (process.argv[2] === "lint") {
    await runLint(workspaceRoot)
    return
  }

  if (process.argv[2] === "fix-names") {
    await runFixNames(workspaceRoot)
    return
  }

  if (process.argv[2] === "audit") {
    await runAudit(workspaceRoot)
    return
  }

  if (process.argv[2] === "import") {
    await runImportCLI(workspaceRoot)
    return
  }

  if (process.argv[2] === "tune") {
    await runTuneCLI(workspaceRoot)
    return
  }

  if (process.argv[2] === "pipeline") {
    await runPipelineCLI(workspaceRoot)
    return
  }

  if (process.argv[2] === "routing") {
    runRoutingCLI(workspaceRoot)
    return
  }

  if (process.argv[2] === "topic-export") {
    runTopicExport(workspaceRoot)
    return
  }

  if (process.argv[2] === "pack") {
    runPackCLI()
    return
  }

  if (process.argv[2] === "source") {
    runSourceCLI()
    return
  }

  if (process.argv[2] === "resolve") {
    runResolveCLI()
    return
  }

  const targetCommand = process.argv[2]
  if (targetCommand === "models" || targetCommand === "override") {
    await runSettingsCLI(targetCommand)
    return
  }

  if (targetCommand === "install" || targetCommand === "uninstall" || targetCommand === "update" || targetCommand === "reconcile" || targetCommand === "status" || targetCommand === "restore") {
    await runTargetCLI(targetCommand)
    return
  }

  if (process.argv[2] === "category") {
    await runCategory(workspaceRoot)
    return
  }

  const extensionCommand = process.argv[2] ? extension?.commands?.[process.argv[2]] : undefined
  if (extensionCommand) {
    await extensionCommand({ argv: process.argv.slice(3), workspaceRoot })
    return
  }

  // Otherwise, run TUI
  const uiConfig = loadUiConfig(workspaceRoot)
  if (uiConfig.warning) console.error(`UI CONFIG WARNING: ${uiConfig.warning}`)
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    screenMode: "alternate-screen"
  })

  const root = createRoot(renderer)
  root.render(<App workspaceRoot={workspaceRoot} listShare={uiConfig.config.listShare} uiConfigWarning={uiConfig.warning} configReadOnly={uiConfig.readOnly} uiConfigRevision={uiConfig.revision} />)
}

const IS_CLI_ENTRYPOINT = /(?:^|[\\/])(?:manage-agents\.mjs|index\.(?:js|tsx))$/.test(process.argv[1] ?? "")
if (IS_CLI_ENTRYPOINT) {
  run().catch((error) => {
    console.error(`✗ Error: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
