import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import React from "react"
import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"
import { App } from "./App.js"
import { fetchModels, loadModelCatalog, getModelVariants } from "./utils/models.js"
import { analyzeAgentName, renameAgent, auditSecurityPermissions, updateAgentParams, sanitizeFilename, KNOWN_MODEL_VARIANTS } from "./utils/agents.js"
import {
  DEFAULT_TRANSLATION_CONFIG,
  loadTranslationConfig,
  normalizeTranslationConfig,
  parseKeyValueMappings,
  saveTranslationConfig,
  translationConfigPath,
  validateMarketplaceName,
  type TranslationConfig,
  type TranslationTarget
} from "./utils/translationConfig.js"
import { AUTO_COMMIT_MESSAGES, isRepositoryLocalPath, repositoryTransaction, parseAutoCommitArgs } from "./utils/repositoryTransaction.js"
import { loadUiConfig } from "./utils/uiConfig.js"
import { hasErrors, MANIFEST_FILE, PACK_NAME_RE, validatePack, type PackValidation } from "./utils/packs.js"
import { packDir, packsDir, readManifest } from "./utils/catalog.js"
import { addSource, discoverAllPacks, findSource, loadSources, pullSource, removeSource, saveSources, sourceRevision } from "./utils/sources.js"
import { describeExecutable, parsePackRequest, resolvePacks } from "./utils/resolver.js"
import { buildLock, confirmationsNeeded, defaultTarget, diffLocks, readLock } from "./utils/lock.js"
import { changeTarget, installChange, reconcileChange, restoreBackup, targetStatus, uninstallChange, updateChange, type ChangeResult } from "./utils/installer.js"
import { loadOverrideSettings, loadRoutingSettings, saveOverrideSettings, saveRoutingSettings, scopeOf, setOverride, setRoutes, unsetOverride, unsetRoutes } from "./utils/userSettings.js"
import YAML from "yaml"
import { isPathInsideWorkspace, realpathThroughExistingAncestor } from "./utils/pathValidation.js"
import { terminalSafeText } from "./utils/terminalText.js"
import { describeChangeResult, formatLockChange } from "./utils/changeReport.js"
import { claudeNextSteps } from "./utils/claudeNextSteps.js"
import { registerPlugin, validatePlugin } from "./utils/claudePluginCli.js"
import type { BridgeResult } from "./utils/bridge.js"
import type { CodexBridgeResult } from "./utils/codexBridge.js"

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

async function runCreate(workspaceRoot: string) {
  console.log(`\n✨ Create New Agent (Naming Convention: [family-]pack-role_with_underscores)`)
  console.log("------------------------------------------")

  const singlePack = fs.existsSync(path.join(workspaceRoot, MANIFEST_FILE))
  const packs = singlePack ? [] : fs.readdirSync(packsDir(workspaceRoot)).filter(name => packDir(workspaceRoot, name)).sort()
  const familyInput = await askQuestion("1. 🏷  Family (Optional, e.g. go, mistral, hybrid - press enter to skip): ")
  let categoryInput = singlePack ? String(readManifest(workspaceRoot).name) : ""
  while (!singlePack && !packs.includes(categoryInput)) {
    categoryInput = (await askQuestion(`2. 📦 Pack (${packs.join(", ")}): `)).trim()
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
  const agentsDir = path.join(packDir(workspaceRoot, cleanCategory) ?? workspaceRoot, "agents")
  const targetPath = path.join(agentsDir, safeFilename)
  if (targetPath === agentsDir || !isPathInsideWorkspace(agentsDir, targetPath)) {
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
description: ${JSON.stringify(description)}
mode: subagent
model: ${selectedModel}
---

# ${filename.replace(/\.md$/, "")}

Write agent instructions and prompts here.
`

  if (!fs.existsSync(agentsDir)) {
    fs.mkdirSync(agentsDir, { recursive: true })
  }
  // The agents/ directory must really be the pack's: a link would place the new agent outside it.
  if (fs.lstatSync(agentsDir).isSymbolicLink() || !isPathInsideWorkspace(fs.realpathSync(workspaceRoot), fs.realpathSync(agentsDir))) {
    throw new Error(`${agentsDir} must be a directory of the workspace, not a link`)
  }

  repositoryMutation(workspaceRoot, [targetPath], AUTO_COMMIT_MESSAGES.create, () => fs.writeFileSync(targetPath, frontmatter, { encoding: "utf-8", flag: "wx" }))

  console.log("\n------------------------------------------")
  console.log(`🎉 Agent successfully created!`)
  console.log(`  File:     ${path.relative(workspaceRoot, targetPath)}`)
  console.log(`  Family:   ${cleanFamily || "(none)"}`)
  console.log(`  Pack:     ${cleanCategory}`)
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

  const next = normalizeTranslationConfig({ ...current, target: targetAnswer as TranslationTarget, pluginName, prefix })
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
    : configPath || translationConfigPath(workspaceRoot)
  console.log(`\n✅ Configuration saved to ${savedPath}`)
  console.log(`   Selected target: ${targetAnswer}`)
  return next
}

const BRIDGE_CHECK_HELP = `
Usage: manage-agents bridge check [options]

Regenerate every committed bridge (bridges/claude-code/<plugin>, bridges/codex/<plugin>) from the packs and compare it
byte-exact with the committed files.

Options:
  --pack <name>           Pack the bridges translate (default: the configured prefix without its trailing "-")
  --target, -t <name>     Only check claude or codex (default: both)
  --help, -h              Show this help
`

async function runBridgeCheck(workspaceRoot: string) {
  const args = process.argv.slice(4)
  let pack = ""
  let targetFilter: TranslationTarget | "" = ""

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--pack" && args[i + 1]) {
      pack = args[++i]
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
  pack = pack || (config.prefix || "").replace(/-$/, "")
  if (!pack) throw new Error(`Cannot tell which pack the bridges translate: set 'prefix' in ${path.relative(workspaceRoot, translationConfigPath(workspaceRoot))} or pass --pack`)
  const pluginName = sanitizeFilename(config.pluginName || DEFAULT_TRANSLATION_CONFIG.pluginName)
  const checks = [
    { target: "claude" as const, folder: "claude-code" },
    { target: "codex" as const, folder: "codex" }
  ].filter(entry => !targetFilter || entry.target === targetFilter)
    .map(entry => ({ ...entry, committedDir: path.join(workspaceRoot, "bridges", entry.folder, pluginName) }))
    .filter(entry => targetFilter || fs.existsSync(entry.committedDir))
  if (checks.length === 0) throw new Error(`No committed bridge named ${pluginName} under ${path.join(workspaceRoot, "bridges")}`)

  const { checkPackBridge } = await import("./utils/bridgeCheck.js")
  let drifted = false
  for (const check of checks) {
    const label = `${check.folder}/${pluginName}`
    const result = checkPackBridge({ workspaceRoot, pack, target: check.target, config, committedDir: check.committedDir })
    if (result.clean) {
      console.log(`Bridge ${label} (pack ${pack}): current.`)
      continue
    }
    drifted = true
    console.log(`Bridge ${label} (pack ${pack}): drift.`)
    for (const file of result.missing) console.log(`  missing ${file} (not emitted by a fresh regeneration)`)
    for (const file of result.changed) console.log(`  changed ${file} (content differs from a fresh regeneration)`)
    for (const file of result.extra) console.log(`  extra   ${file} (stale file no longer generated)`)
    console.log(`  Regenerate with: manage-agents bridge --pack ${pack} --target ${check.target}`)
  }
  if (drifted) process.exitCode = 1
}

async function runBridge(workspaceRoot: string) {
  if (process.argv[3] === "check") {
    await runBridgeCheck(workspaceRoot)
    return
  }

  // Parse CLI args. The wizard persists reusable mappings in a translation
  // layer so subsequent non-interactive runs use the same defaults.
  const args = process.argv.slice(3)
  let pack = ""
  let output = ""
  let pluginName = ""
  let prefix = ""
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
    if (args[i] === "--pack" && args[i + 1]) {
      pack = args[++i]
    } else if ((args[i] === "--output" || args[i] === "-o") && args[i + 1]) {
      output = args[++i]
    } else if ((args[i] === "--name" || args[i] === "-n") && args[i + 1]) {
      pluginName = args[++i]
    } else if ((args[i] === "--prefix" || args[i] === "-p") && args[i + 1]) {
      prefix = args[++i]
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

Translate a pack of the workspace, with the packs it requires, into a Claude Code plugin or a Codex layer.

Subcommands:
  check                   Verify committed bridges match a fresh regeneration

Options:
  --pack <name>           Pack to bridge (default: the configured prefix without its trailing "-")
  --target, -t <name>     Translation target: claude (default) or codex
  --output, -o <path>     Output directory (default: bridges/<claude-code|codex>/<name> in the workspace)
  --name, -n <name>       Plugin name (default: decent-pipeline)
  --prefix, -p <prefix>   Prefix to strip from agent names (default: <pack>-)
  --config <path>         Reusable translation config (default: bridges/translation-config.json)
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
    } else {
      throw new Error(`Unknown option for 'bridge': ${args[i]}`)
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
  prefix = prefix || (pack ? `${pack}-` : config.prefix)
  if (!pack) pack = prefix.replace(/-$/, "")
  if (!prefix) prefix = `${pack}-`
  if (!pack) {
    console.error("Error: --pack is required (or set prefix in the bridge wizard).")
    process.exit(1)
  }

  const safePluginName = sanitizeFilename(pluginName)
  const outputDir = path.resolve(output || path.join(workspaceRoot, "bridges", target === "codex" ? "codex" : "claude-code", safePluginName))

  console.log(`\n🔄 Bridging pack '${pack}' to ${target} layer '${pluginName}'...`)
  console.log(`   Prefix to strip: '${prefix}'`)
  console.log(`   Output directory: ${outputDir}\n`)

  const { bridgePack } = await import("./utils/bridgeWorkspace.js")
  const bridgeConfigPath = configFile || translationConfigPath(workspaceRoot)
  const bridgePlan = { localPaths: [bridgeConfigPath].filter(file => isRepositoryLocalPath(workspaceRoot, file)).concat(isRepositoryLocalPath(workspaceRoot, outputDir) ? [outputDir] : []), externalPaths: [bridgeConfigPath, outputDir].filter(file => !isRepositoryLocalPath(workspaceRoot, file)) }
  const result: BridgeResult | CodexBridgeResult = repositoryMutation(workspaceRoot, bridgePlan, AUTO_COMMIT_MESSAGES.bridge, () => {
    if (wizard || modelFlagsGiven || marketFlagsGiven) saveTranslationConfig(workspaceRoot, config, configFile || undefined)
    return bridgePack({ workspaceRoot, pack, target, outputDir, config, pluginName: safePluginName, prefix })
  })

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

async function runLint(workspaceRoot: string) {
  const { findAgentFiles } = await import("./utils/agents.js")
  const agents = findAgentFiles(workspaceRoot)
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

  const agents = findAgentFiles(workspaceRoot)
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
  const agents = findAgentFiles(workspaceRoot)
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

async function runTuneCLI(workspaceRoot: string) {
  const { findAgentFiles } = await import("./utils/agents.js")
  const args = process.argv.slice(3)

  const usage = () => {
    console.log("Usage: manage-agents tune [options]")
    console.log("  --steps <number>                  Set max execution steps")
    console.log("  --temp <0.0-1.0>                  Set temperature")
    console.log(`  --variant <name> / --effort <name> Set model variant (known: ${KNOWN_MODEL_VARIANTS.join("|")}; model-exposed variants from opencode models --verbose are supported)`)
    console.log("  --clear-variant / --clear-effort  Remove variant from agent frontmatter (revert to model default)")
    console.log("  --pack <pack> / --all             Target the agents of one pack, or all agents")
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
    else if ((args[i] === "--pack" || args[i] === "--category" || args[i] === "-c") && args[i + 1]) category = args[++i]
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

  const agents = findAgentFiles(workspaceRoot)
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

// Pack content may be hostile: escape C1 controls, which JSON.stringify leaves raw and some terminals interpret.
const printJson = (value: unknown) => console.log(JSON.stringify(value, null, 2).replace(/[\u007f-\u009f]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`))

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
  for (const line of describeChangeResult(target, result)) console.log(line)
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

/** The pack catalog (a directory with packs/<name>/opencode-pack.json) or single pack the agent commands and the TUI edit. */
export function findWorkspace(start: string): string | null {
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    const packs = path.join(dir, "packs")
    if (fs.existsSync(packs) && fs.readdirSync(packs).some(name => fs.existsSync(path.join(packs, name, "opencode-pack.json")))) return dir
    if (fs.existsSync(path.join(dir, "opencode-pack.json"))) return dir
    if (path.dirname(dir) === dir) return null
  }
}

const COMMANDS = ["pack", "source", "resolve", "install", "uninstall", "update", "reconcile", "status", "restore", "models", "override", "create", "lint", "fix-names", "audit", "tune", "bridge"]
const WORKSPACE_COMMANDS: Record<string, (workspaceRoot: string) => Promise<void>> = {
  create: workspaceRoot => runCreate(workspaceRoot),
  lint: runLint,
  "fix-names": runFixNames,
  audit: runAudit,
  tune: runTuneCLI,
  bridge: runBridge,
}

async function run() {
  const autoCommit = parseAutoCommitArgs(process.argv.slice(2))
  process.env.AGENT_MANAGER_AUTO_COMMIT = autoCommit.enabled ? "1" : "0"
  process.argv = [...process.argv.slice(0, 2), ...autoCommit.argv]
  const workspaceFlag = process.argv.indexOf("--workspace")
  const explicitWorkspace = workspaceFlag === -1 ? process.env.MANAGE_AGENTS_WORKSPACE : process.argv[workspaceFlag + 1]
  if (workspaceFlag !== -1) process.argv.splice(workspaceFlag, 2)
  const command = process.argv[2]

  if (command === "--help" || command === "-h") {
    console.log("Usage: manage-agents [<command>] [options] [--workspace <catalog-or-pack-dir>]")
    console.log(`Commands: ${COMMANDS.join(", ")}. Without a command the TUI opens on the workspace.`)
    console.log("The workspace (for create, lint, fix-names, audit, tune, bridge and the TUI) is --workspace, $MANAGE_AGENTS_WORKSPACE, or the nearest pack catalog or pack above the current directory.")
    return
  }
  if (command === "pack") return runPackCLI()
  if (command === "source") return runSourceCLI()
  if (command === "resolve") return runResolveCLI()
  if (command === "models" || command === "override") return runSettingsCLI(command)
  if (command === "install" || command === "uninstall" || command === "update" || command === "reconcile" || command === "status" || command === "restore") return runTargetCLI(command)
  if (command && !command.startsWith("-") && !WORKSPACE_COMMANDS[command]) return cliError(`unknown command ${terminalSafeText(command)}; run manage-agents --help`)

  const workspaceRoot = explicitWorkspace ? path.resolve(explicitWorkspace) : findWorkspace(process.cwd())
  if (!workspaceRoot || findWorkspace(workspaceRoot) !== workspaceRoot) {
    return cliError(`no pack catalog or pack found${explicitWorkspace ? ` at ${terminalSafeText(explicitWorkspace)}` : " above the current directory"}; pass --workspace <dir> (a directory with packs/<name>/opencode-pack.json, or a pack)`, 1)
  }
  if (command) return WORKSPACE_COMMANDS[command](workspaceRoot)

  const uiConfig = loadUiConfig()
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
