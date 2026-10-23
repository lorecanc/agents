import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import React from "react"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import readline from "node:readline"
import { App } from "./App.js"
import { fetchModels, loadModelCatalog, getModelVariants } from "./utils/models.js"
import { exportAgents, getExportDestination, analyzeAgentName, renameAgent, auditSecurityPermissions, importAgents, previewImport, updateAgentParams, sanitizeFilename, KNOWN_MODEL_VARIANTS, resolveSourceSubdir, resolveCategoriesSubdir } from "./utils/agents.js"
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
import { loadPipelineProfiles, applyPipelineProfile, syncPipelineProfile, deleteStampedPipeline, resolveProfileRoleSpec, PIPELINE_ROLES, loadStampedPipelineAgents, refreshStampedPipelinesFromSource, checkPipelineBundles } from "./utils/pipelineProfiles.js"
import { getCompanionLinksConfigPath } from "./utils/companionLinks.js"
import { BASH_PROFILES_FILE, checkBashProfiles, syncBashProfiles } from "./utils/bashProfiles.js"
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

/** Shorten the user's home directory prefix to `~` for display. */
function shortenHome(p: string): string {
  const home = os.homedir()
  if (!home || home === path.sep) return p
  return p === home ? "~" : p.startsWith(home + path.sep) ? "~" + p.slice(home.length) : p
}

async function runCreate(agentNameArg: string | undefined, workspaceRoot: string) {
  console.log(`\n✨ Create New Agent (Naming Convention: [family-]category-role_with_underscores)`)
  console.log("------------------------------------------")

  const familyInput = await askQuestion("1. 🏷  Family (Optional, e.g. copilot, go, kimi - press enter to skip): ")
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

async function runBridge(workspaceRoot: string) {
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

Options:
  --category, -c <name>   Category to bridge (e.g. copilot-pipeline)
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
  let category = ""
  let profile = ""

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--all" || args[i] === "-a") {
      exportAll = true
    } else if ((args[i] === "--category" || args[i] === "-c") && args[i + 1]) {
      category = args[++i]
    } else if ((args[i] === "--profile" || args[i] === "-p") && args[i + 1]) {
      profile = args[++i]
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(`
Usage: manage-agents export [options]

OpenCode config directory: $XDG_CONFIG_HOME/opencode/ (default: ~/.config/opencode/).
Export agent files to its agents/ directory with full overwrite.
A single disaster-recovery backup is kept at agents_backup/ in that directory.
Companion resources in tools/, commands/, skills/, and plugins/ matching each exported
agent's domain are installed under the same subpath in that directory.

Options:
  --all, -a               Export all agents
  --category, -c <name>   Export only agents from a specific category
  --profile, -p <name>    Apply a pipeline profile before exporting
  --help, -h              Show this help
`)
      process.exit(0)
    }
  }

  try { refreshStampedPipelinesFromSource(workspaceRoot, category || undefined) } catch {}

  const sourceSubdir = resolveSourceSubdir(workspaceRoot)
  let agentsToExport: ReturnType<typeof findAgentFiles>
  let resourceSourceRoot = path.join(workspaceRoot, sourceSubdir)
  if (profile && category === "pipeline") {
    repositoryMutation(workspaceRoot, [path.join(workspaceRoot, sourceSubdir, "agents")], "pipeline", () =>
      applyPipelineProfile(workspaceRoot, profile, "pipeline")
    )
    agentsToExport = findAgentFiles(workspaceRoot, sourceSubdir).filter(agent => agent.category === "pipeline")
  } else if (profile) {
    const synced = repositoryMutation(workspaceRoot, [path.join(workspaceRoot, resolveCategoriesSubdir(workspaceRoot)), getCompanionLinksConfigPath(workspaceRoot)], "pipeline", () =>
      syncPipelineProfile(workspaceRoot, profile, category || undefined)
    )
    const stamped = loadStampedPipelineAgents(workspaceRoot, synced.targetCategory)
    if (!stamped) throw new Error(`No stamped agents found for category '${synced.targetCategory}'.`)
    agentsToExport = stamped.agents
    resourceSourceRoot = stamped.resourceRoot
  } else {
    const allAgents = findAgentFiles(workspaceRoot, sourceSubdir)
    agentsToExport = category ? allAgents.filter(agent => agent.category === category) : allAgents
    if (!category) {
      const categoriesRoot = path.join(workspaceRoot, resolveCategoriesSubdir(workspaceRoot))
      if (fs.existsSync(categoriesRoot)) {
        for (const entry of fs.readdirSync(categoriesRoot, { withFileTypes: true })) {
          if (!entry.isDirectory() || !entry.name.endsWith("-pipeline")) continue
          const stamped = loadStampedPipelineAgents(workspaceRoot, entry.name)
          if (stamped) agentsToExport.push(...stamped.agents)
        }
      }
    }
    if (category && agentsToExport.length === 0) {
      const stamped = loadStampedPipelineAgents(workspaceRoot, category)
      if (stamped) {
        agentsToExport = stamped.agents
        resourceSourceRoot = stamped.resourceRoot
      }
    }
    if (category && agentsToExport.length === 0) {
      console.error(`Error: No agents found for category '${category}'.`)
      console.error(`Available categories: ${[...new Set(allAgents.map(a => a.category))].join(", ")}`)
      process.exit(1)
    }
  }

  const destination = shortenHome(getExportDestination())

  console.log(`\n📦 Export to OpenCode`)
  console.log(`   ------------------------------------------`)
  console.log(`   Agents to export: ${agentsToExport.length}${category ? ` (category: ${category})` : " (all)"}`)
  console.log(`   Destination:      ${destination}`)
  console.log(`   Overwrite mode:   FULL (including model field)`)
  console.log(`   Backup location:  ${shortenHome(path.join(path.dirname(getExportDestination()), "agents_backup"))}`)
  console.log(`   ------------------------------------------\n`)

  const answer = await askQuestion("⚠  Proceed with export? (Y/n): ")
  if (answer.toLowerCase() !== "y" && answer !== "") {
    console.log("\n❌ Export cancelled.")
    process.exit(0)
  }

  const result = exportAgents(agentsToExport, undefined, resourceSourceRoot)

  console.log(`\n✅ Export complete!`)
  console.log(`   Exported ${result.exported.length} agents to:`)
  console.log(`   ${shortenHome(result.destinationPath)}`)
  console.log(`\n   Backup at:`)
  console.log(`   ${shortenHome(result.backupPath)}\n`)

  if (result.domainResources.length > 0) {
    console.log(`   Companion resources installed:`)
    result.domainResources.forEach(resource => console.log(`     ${shortenHome(resource)}`))
    console.log(`   Resource backup: ${result.domainBackupPath ? shortenHome(result.domainBackupPath) : "not needed (no existing files replaced)"}`)
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
  const [action, profileName, ...options] = process.argv.slice(3)
  if (!action || action === "--help" || action === "-h") {
    console.log("Usage: manage-agents pipeline list|show <profile>|apply <profile> [--category <cat>]|sync <profile> [--target <target-pipeline>]|sync --all|refresh [--target <target-pipeline>]|sync-bash [--dry-run]|delete <name> [--also-installed]")
    return
  }

  if (action === "sync-bash") {
    const dryRun = process.argv.slice(4).includes("--dry-run")
    const run = () => syncBashProfiles(workspaceRoot, { dryRun })
    const result = dryRun ? run() : repositoryMutation(workspaceRoot, [path.join(workspaceRoot, resolveSourceSubdir(workspaceRoot), "agents")], AUTO_COMMIT_MESSAGES.pipeline, run)
    console.log(`${dryRun ? "Would rewrite" : "Rewrote"} ${result.changed.length} bash block(s) from ${BASH_PROFILES_FILE}; ${result.unchanged.length} already match; ${result.skipped.length} agent(s) without a bash profile left untouched.`)
    result.changed.forEach(file => console.log(`  ${dryRun ? "~" : "*"} ${file}`))
    if (result.changed.length > 0) console.log("Run `category build --all` to refresh stamped pipelines.")
    return
  }

  if (action === "list") {
    const config = loadPipelineProfiles(workspaceRoot)
    console.log(`Base category: ${config.baseCategory}`)
    for (const [name, profile] of Object.entries(config.profiles)) console.log(`${name}: ${profile.description}`)
    return
  }

  const refreshAll = action === "refresh" || (action === "sync" && (profileName === "--all" || options.includes("--all")))
  if (refreshAll) {
    const refreshArgs = process.argv.slice(3)
    let target = ""
    for (let i = 0; i < refreshArgs.length; i++) {
      if ((refreshArgs[i] === "--target" || refreshArgs[i] === "-t") && refreshArgs[i + 1]) target = refreshArgs[++i]
    }
    const result = repositoryMutation(workspaceRoot, [path.join(workspaceRoot, resolveCategoriesSubdir(workspaceRoot)), getCompanionLinksConfigPath(workspaceRoot)], AUTO_COMMIT_MESSAGES.pipeline, () =>
      refreshStampedPipelinesFromSource(workspaceRoot, target || undefined)
    )
    console.log(`Refreshed ${result.refreshedCategories.length} stamped pipeline(s): ${result.updatedAgents.length} agent file(s), ${result.updatedCompanions.length} companion file(s) updated.`)
    return
  }

  if (action !== "show" && action !== "apply" && action !== "sync" && action !== "delete") throw new Error(`Unknown pipeline action '${action}'`)
  if (!profileName || profileName.startsWith("-")) throw new Error(`pipeline ${action} requires a profile name`)

  if (action === "delete") {
    const alsoInstalled = options.includes("--also-installed")
    const resolvedTarget = profileName === "pipeline" || profileName.endsWith("-pipeline") ? profileName : `${profileName}-pipeline`
    const result = repositoryMutation(workspaceRoot, [path.join(workspaceRoot, resolveCategoriesSubdir(workspaceRoot), resolvedTarget), getCompanionLinksConfigPath(workspaceRoot)], AUTO_COMMIT_MESSAGES.pipeline, () =>
      deleteStampedPipeline(workspaceRoot, profileName, { alsoInstalled })
    )
    console.log(`Deleted category '${result.deletedCategory}': removed ${result.removedAgentsCount} agents from ${result.outputDir}.`)
    if (alsoInstalled) {
      console.log(`Removed ${result.removedInstalledAgents.length} installed agents and ${result.removedInstalledCommands.length} installed commands.`)
    }
    return
  }

  const config = loadPipelineProfiles(workspaceRoot)
  const profile = config.profiles[profileName]
  if (!profile) throw new Error(`Unknown pipeline profile '${profileName}'`)

  if (action === "show") {
    console.log(`${profileName}: ${profile.description}`)
    for (const role of PIPELINE_ROLES) {
      const spec = resolveProfileRoleSpec(profile, role)
      console.log(`  ${role}: ${spec ? `${spec.model}${spec.variant ? `#${spec.variant}` : ""}` : "(not configured)"}`)
    }
    return
  }

  let category = ""
  for (let i = 0; i < options.length; i++) {
    if ((options[i] === "--category" && options[i + 1]) || (options[i] === "--target" && options[i + 1])) category = options[++i]
  }

  if (action === "apply") {
    const result = repositoryMutation(workspaceRoot, [path.join(workspaceRoot, resolveSourceSubdir(workspaceRoot), "agents"), path.join(workspaceRoot, resolveCategoriesSubdir(workspaceRoot))], "pipeline", () =>
      applyPipelineProfile(workspaceRoot, profileName, category || undefined)
    )
    console.log(`Applied profile '${profileName}' to category '${result.targetCategory}': updated ${result.updated.length} agent files.`)
    return
  }

  const result = repositoryMutation(workspaceRoot, [path.join(workspaceRoot, resolveSourceSubdir(workspaceRoot), "agents"), path.join(workspaceRoot, resolveCategoriesSubdir(workspaceRoot)), getCompanionLinksConfigPath(workspaceRoot)], "pipeline", () =>
    syncPipelineProfile(workspaceRoot, profileName, category || undefined)
  )
  console.log(`Synced profile '${profileName}' to category '${result.targetCategory}': ${result.synced.length} agents at ${result.outputDir}.`)
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
  // Stamped `*-pipeline` bundles have no category manifest: `build` refreshes
  // them from the canonical pipeline and `check` verifies their OpenCode
  // tools/plugin. `--all` covers every stamped bundle as well as the manifests.
  const isPipelineId = (id: string) => id === "pipeline" || id.endsWith("-pipeline")
  const pipelineIds = ids.filter(isPipelineId)
  const manifestIds = ids.filter(id => !isPipelineId(id))
  const all = !parsed.id
  const refreshPipelines = (category?: string) => repositoryMutation(repoRoot, [path.join(repoRoot, resolveCategoriesSubdir(repoRoot)), getCompanionLinksConfigPath(repoRoot)], AUTO_COMMIT_MESSAGES.pipeline, () =>
    refreshStampedPipelinesFromSource(repoRoot, category)
  )
  if (parsed.action === "build") {
    if (all) refreshPipelines()
    else for (const id of pipelineIds) if (id !== "pipeline") refreshPipelines(id)
  } else if (parsed.action === "check" || parsed.action === "status") {
    for (const id of pipelineIds) if (id !== "pipeline") refreshPipelines(id)
  }
  const results = parsed.action === "build" && all
    ? buildAllCategoryDistributions(repoRoot)
    : manifestIds.map(id => parsed.action === "check" || parsed.action === "status" ? checkCategoryDistribution(repoRoot, id) : repositoryMutation(repoRoot, [path.join(repoRoot, resolveCategoriesSubdir(repoRoot), id)], `chore(agent-manager): build ${id} category`, () => buildCategoryDistribution(repoRoot, id)))
  const resultIds = parsed.action === "build" && all ? ids : manifestIds
  const pipelineChecks = all || pipelineIds.length > 0 ? checkPipelineBundles(repoRoot, all ? undefined : pipelineIds) : []
  if (parsed.json) console.log(JSON.stringify(pipelineChecks.length ? { categories: results, pipelines: pipelineChecks } : results))
  else {
    results.forEach((result, index) => console.log(result.status === "current" ? `Category ${resultIds[index]} is current.` : `Category ${resultIds[index]} is stale.\nMissing: ${result.missing.join(", ") || "none"}\nChanged: ${result.changed.join(", ") || "none"}\nExtra: ${result.extra.join(", ") || "none"}`))
    for (const check of pipelineChecks) {
      if (check.orphan) console.log(`Pipeline ${check.category}: warning, companions without agents (not installable; refresh or delete it).`)
      else if (check.problems.length === 0) console.log(`Pipeline ${check.category} ships its OpenCode tools and plugin.`)
      else console.log(`Pipeline ${check.category} is incomplete:\n${check.problems.map(problem => `  - [${problem.kind}] ${problem.detail}`).join("\n")}`)
    }
  }
  const bashDrifts = all || pipelineIds.length > 0
    ? checkBashProfiles(repoRoot).filter(drift => all || pipelineIds.some(id => id === "pipeline" ? drift.file.startsWith(`${resolveSourceSubdir(repoRoot)}/`) : drift.file.includes(`/${id}/`)))
    : []
  if (!parsed.json) for (const drift of bashDrifts) console.log(`Bash allowlist drift in ${drift.file} (role ${drift.role}, ${drift.problem}); fix with \`pipeline sync-bash\` then \`category build --all\`:\n${drift.diff.map(line => `    ${line}`).join("\n")}`)
  else if (bashDrifts.length) console.log(JSON.stringify({ bashDrifts }))
  const pipelineFailed = pipelineChecks.some(check => check.problems.length > 0) || bashDrifts.length > 0
  if ((parsed.action === "check" || parsed.action === "status") && (results.some(result => result.status !== "current") || pipelineFailed)) process.exitCode = 1
  if (parsed.action === "build" && pipelineFailed) process.exitCode = 1
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

  // Intercept CLI commands
  if (process.argv[2] === "--help" || process.argv[2] === "-h") {
    console.log("Usage: manage-agents <command> [options]")
    console.log("Commands: create, bridge, export, lint, fix-names, audit, import, tune, pipeline, category")
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

  if (process.argv[2] === "topic-export") {
    runTopicExport(workspaceRoot)
    return
  }

  if (process.argv[2] === "category") {
    await runCategory(workspaceRoot)
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

run().catch((e) => {
  console.error("Renderer initialization failed:", e)
  process.exit(1)
})
