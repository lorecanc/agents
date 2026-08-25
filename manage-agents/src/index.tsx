import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import React from "react"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import readline from "node:readline"
import { App } from "./App.js"
import { fetchModels } from "./utils/models.js"
import { exportAgents, getExportDestination, analyzeAgentName, renameAgent, auditSecurityPermissions, importAgents, updateAgentParams, sanitizeFilename } from "./utils/agents.js"
import {
  DEFAULT_TRANSLATION_CONFIG,
  loadTranslationConfig,
  normalizeTranslationConfig,
  saveTranslationConfig,
  type TranslationConfig,
  type TranslationTarget
} from "./utils/translationConfig.js"
import { AUTO_COMMIT_MESSAGES, isRepositoryLocalPath, repositoryTransaction } from "./utils/repositoryTransaction.js"
import { buildCategoryDistribution, buildAllCategoryDistributions, recoverBuildAllCategoryDistributions, checkCategoryDistribution, loadCategoryManifest, packageCategoryDistributions, parseCategoryArgs } from "./utils/categoryDistribution.js"

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
  const agentsDir = path.join(workspaceRoot, "general", "agents")
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

  repositoryTransaction(workspaceRoot, [targetPath], AUTO_COMMIT_MESSAGES.create, () => fs.writeFileSync(targetPath, frontmatter, "utf-8"))

  console.log("\n------------------------------------------")
  console.log(`🎉 Agent successfully created!`)
  console.log(`  File:     general/agents/${filename}`)
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
  --output, -o <path>     Output directory (default: bridges/<target>/<name>)
  --name, -n <name>       Plugin name (default: decent-pipeline)
  --prefix, -p <prefix>   Prefix to strip (default: <category>-)
  --source-dir, -s <dir>  Agent source directory (default: config or general)
  --config <path>         Reusable translation config (default: .agent-manager/translation-config.json)
  --wizard, -w            Configure model mappings and save them before bridging
  --help, -h              Show this help
`)
      process.exit(0)
    }
  }

  const loaded = loadTranslationConfig(workspaceRoot, configFile || undefined, { persistMigration: false })
  const config = wizard
    ? await runTranslationWizard(workspaceRoot, loaded, configFile || undefined, false)
    : loaded
  if (!targetSpecified) target = config.target
  pluginName = pluginName || config.pluginName || DEFAULT_TRANSLATION_CONFIG.pluginName
  prefix = prefix || (category ? `${category}-` : config.prefix)
  sourceDir = sourceDir || config.sourceDir || "general"
  if (!category) category = prefix.replace(/-$/, "")
  if (!prefix) prefix = `${category}-`
  if (!category) {
    console.error("Error: --category is required (or set prefix in the bridge wizard).")
    process.exit(1)
  }

  const safePluginName = sanitizeFilename(pluginName)
  const bridgeFolder = target === "codex" ? "codex" : "claude-code"
  const outputDir = output || path.join(workspaceRoot, "bridges", bridgeFolder, safePluginName)

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

  let result: { files: string[]; warnings: string[]; pluginDir: string; preview?: Array<{ agent: string; role: string; tier: string; model: string; source: string }> }
  let orchestratorName = "orchestrator"
  if (target === "codex") {
    const { bridgeToCodex } = await import("./utils/codexBridge.js")
    const bridgeConfigPath = configFile || path.join(workspaceRoot, ".agent-manager", "translation-config.json")
    const bridgePlan = { localPaths: [bridgeConfigPath].filter(file => isRepositoryLocalPath(workspaceRoot, file)).concat(isRepositoryLocalPath(workspaceRoot, outputDir) ? [outputDir] : []), externalPaths: [bridgeConfigPath, outputDir].filter(file => !isRepositoryLocalPath(workspaceRoot, file)) }
    const codexResult = repositoryTransaction(workspaceRoot, bridgePlan, AUTO_COMMIT_MESSAGES.bridge, () => {
      if (wizard) saveTranslationConfig(workspaceRoot, config, configFile || undefined)
      return bridgeToCodex(categoryAgents, safePluginName, prefix, outputDir, workspaceRoot, { ...config, sourceDir })
    })
    result = codexResult
    orchestratorName = codexResult.plugin.orchestratorName || orchestratorName
  } else {
    const { bridgeToClaudeCode } = await import("./utils/bridge.js")
    const bridgeConfigPath = configFile || path.join(workspaceRoot, ".agent-manager", "translation-config.json")
    const bridgePlan = { localPaths: [bridgeConfigPath].filter(file => isRepositoryLocalPath(workspaceRoot, file)).concat(isRepositoryLocalPath(workspaceRoot, outputDir) ? [outputDir] : []), externalPaths: [bridgeConfigPath, outputDir].filter(file => !isRepositoryLocalPath(workspaceRoot, file)) }
    const claudeResult = repositoryTransaction(workspaceRoot, bridgePlan, AUTO_COMMIT_MESSAGES.bridge, () => {
      if (wizard) saveTranslationConfig(workspaceRoot, config, configFile || undefined)
      return bridgeToClaudeCode(categoryAgents, safePluginName, prefix, outputDir, workspaceRoot, { ...config, sourceDir })
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

  if (target === "claude") {
    console.log(`\n   Validate and run locally:`)
    console.log(`     claude plugin validate ${outputDir} --strict`)
    console.log(`     claude --plugin-dir ${outputDir} --agent ${orchestratorName}\n`)
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

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--all" || args[i] === "-a") {
      exportAll = true
    } else if ((args[i] === "--category" || args[i] === "-c") && args[i + 1]) {
      category = args[++i]
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(`
Usage: manage-agents export [options]

Export agent files to ~/.config/opencode/agents/ with full overwrite.
A single disaster-recovery backup is kept at ~/.config/opencode/agents_backup/.

Options:
  --all, -a               Export all agents
  --category, -c <name>   Export only agents from a specific category
  --help, -h              Show this help
`)
      process.exit(0)
    }
  }

  const allAgents = findAgentFiles(workspaceRoot, loadTranslationConfig(workspaceRoot, undefined, { persistMigration: false }).sourceDir)
  let agentsToExport = allAgents

  if (category) {
    agentsToExport = allAgents.filter(a => a.category === category)
    if (agentsToExport.length === 0) {
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
  console.log(`   Backup location:  ~/.config/opencode/agents_backup/`)
  console.log(`   ------------------------------------------\n`)

  const answer = await askQuestion("⚠  Proceed with export? (Y/n): ")
  if (answer.toLowerCase() !== "y" && answer !== "") {
    console.log("\n❌ Export cancelled.")
    process.exit(0)
  }

  const result = exportAgents(agentsToExport)

  console.log(`\n✅ Export complete!`)
  console.log(`   Exported ${result.exported.length} agents to:`)
  console.log(`   ${shortenHome(result.destinationPath)}`)
  console.log(`\n   Backup at:`)
  console.log(`   ${shortenHome(result.backupPath)}\n`)

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
    const results = repositoryTransaction(workspaceRoot, plannedPaths, AUTO_COMMIT_MESSAGES.rename, () => {
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

  console.log(`\n🔁 Two-Way Sync: Import / Pull from OpenCode`)
  console.log(`   Source: ~/.config/opencode/agents/`)
  console.log(`   Destination: general/agents/`)
  console.log(`   Mode: ${isDryRun ? "DRY RUN" : "EXECUTE"}\n`)

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
    const res = repositoryTransaction(workspaceRoot, [path.join(workspaceRoot, "general", "agents")], AUTO_COMMIT_MESSAGES.import, () => importAgents(workspaceRoot))
    console.log(`\n✅ Successfully imported ${res.imported.length} agents!`)
    console.log(`   ${res.backupPath ? `Backup saved to: ${shortenHome(res.backupPath)}` : "No backup needed"}\n`)
  } catch (e: any) {
    console.error(`Error during import: ${e.message || e}`)
  }
}

async function runTuneCLI(workspaceRoot: string) {
  const { findAgentFiles } = await import("./utils/agents.js")
  const args = process.argv.slice(3)

  let steps: number | undefined
  let temp: number | undefined
  let category = ""

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--steps" && args[i + 1]) steps = parseInt(args[++i], 10)
    else if (args[i] === "--temp" && args[i + 1]) temp = parseFloat(args[++i])
    else if ((args[i] === "--category" || args[i] === "-c") && args[i + 1]) category = args[++i]
  }

  const agents = findAgentFiles(workspaceRoot, loadTranslationConfig(workspaceRoot, undefined, { persistMigration: false }).sourceDir)
  const targetAgents = category ? agents.filter(a => a.category === category) : agents

  console.log(`\n🎯 Parameter Tuning CLI`)
  console.log(`   Target agents: ${targetAgents.length}${category ? ` (category: ${category})` : " (all)"}`)
  console.log(`   Steps:       ${steps !== undefined ? steps : "unchanged"}`)
  console.log(`   Temperature: ${temp !== undefined ? temp : "unchanged"}\n`)

  repositoryTransaction(workspaceRoot, targetAgents.map(a => a.currentPath), AUTO_COMMIT_MESSAGES.tune, () => updateAgentParams(targetAgents, { steps, temperature: temp }))
  console.log(`✅ Successfully updated parameters for ${targetAgents.length} agents!\n`)
}

async function runCategory(workspaceRoot: string) {
  const repoRoot = path.basename(workspaceRoot) === "agents" ? path.dirname(workspaceRoot) : workspaceRoot
  const args = process.argv.slice(3)
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: manage-agents category list|explain|status|build|check|package <id> [options]")
    return
  }
  const parsed = parseCategoryArgs(args)
  if (parsed.action === "recover") { recoverBuildAllCategoryDistributions(repoRoot); console.log("Recovered category build journal."); return }
  if (parsed.action === "list") { const dir = path.join(workspaceRoot, ".agent-manager", "categories"); console.log(fs.existsSync(dir) ? fs.readdirSync(dir).filter(file => file.endsWith(".json")).map(file => file.slice(0, -5)).sort().join("\n") : ""); return }
  const ids = parsed.ids?.length ? parsed.ids : parsed.id ? [parsed.id] : fs.readdirSync(path.join(workspaceRoot, ".agent-manager", "categories")).filter(file => file.endsWith(".json")).map(file => file.slice(0, -5)).sort()
  if (parsed.action === "explain") { const result = ids.map(id => loadCategoryManifest(repoRoot, id)); console.log(parsed.json ? JSON.stringify(result) : result.map(value => JSON.stringify(value, null, 2)).join("\n")); return }
  if (parsed.action === "package") { const result = packageCategoryDistributions(repoRoot, parsed.ids || ids, parsed.output || "", parsed.dryRun); console.log(parsed.json ? JSON.stringify(result) : `${parsed.dryRun ? "Would package" : "Packaged"} ${result.categories.join(", ")} to ${parsed.output}`); return }
  const results = parsed.action === "build" && !parsed.id
    ? buildAllCategoryDistributions(repoRoot)
    : ids.map(id => parsed.action === "check" || parsed.action === "status" ? checkCategoryDistribution(repoRoot, id) : repositoryTransaction(repoRoot, [path.join("agents", "categories", id)], `chore(agent-manager): build ${id} category`, () => buildCategoryDistribution(repoRoot, id)))
  if (parsed.json) console.log(JSON.stringify(results)); else results.forEach((result, index) => console.log(result.status === "current" ? `Category ${ids[index]} is current.` : `Category ${ids[index]} is stale.\nMissing: ${result.missing.join(", ") || "none"}\nChanged: ${result.changed.join(", ") || "none"}\nExtra: ${result.extra.join(", ") || "none"}`))
  if ((parsed.action === "check" || parsed.action === "status") && results.some(result => result.status !== "current")) process.exitCode = 1
}
function runTopicExport(workspaceRoot: string) {
  console.error("Warning: topic-export is deprecated; use category build/check wiki.")
  const legacy = process.argv.slice(3); const check = legacy.includes("--check")
  process.argv = [...process.argv.slice(0, 3), check ? "check" : "build", "wiki", ...legacy.filter(arg => arg !== "wiki" && arg !== "--check")]
  runCategory(workspaceRoot)
}

async function run() {
  if (process.argv.includes("--no-auto-commit")) {
    process.env.AGENT_MANAGER_AUTO_COMMIT = "0"
    process.argv = process.argv.filter(arg => arg !== "--no-auto-commit")
  }
  const workingDirectory = path.resolve(process.cwd())
  const workspaceCandidates = [
    workingDirectory,
    path.join(workingDirectory, "agents"),
    path.resolve(workingDirectory, "..", "agents")
  ]
  const workspaceRoot = workspaceCandidates.find((candidate) =>
    fs.existsSync(path.join(candidate, "general", "agents"))
  ) || workingDirectory

  // Intercept CLI commands
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

  if (process.argv[2] === "topic-export") {
    runTopicExport(workspaceRoot)
    return
  }

  if (process.argv[2] === "category") {
    await runCategory(workspaceRoot)
    return
  }

  // Otherwise, run TUI
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    screenMode: "alternate-screen"
  })

  const root = createRoot(renderer)
  root.render(<App workspaceRoot={workspaceRoot} />)
}

run().catch((e) => {
  console.error("Renderer initialization failed:", e)
  process.exit(1)
})
