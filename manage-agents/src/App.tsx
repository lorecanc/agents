import React, { useState, useEffect, useMemo } from "react"
import path from "node:path"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import {
  findAgentFiles,
  AgentInfo,
  organizeAgents,
  updateAgentsModel,
  updateAgentsColor,
  forkCategory,
  exportAgents,
  getExportDestination,
  analyzeAgentName,
  renameAgent,
  getAgentPermissionSummary,
  SAFETY_PRESETS,
  applySafetyPreset,
  updateAgentParams,
  updateAgentDelegations,
  compareAgentWithExport,
  importAgents,
  AgentDiffResult,
  analyzePermissionOrder,
  fixPermissionOrder
  , sanitizeFilename,
  getCategoryPrefixes
} from "./utils/agents.js"
import { fetchModels } from "./utils/models.js"
import { bridgeToClaudeCode } from "./utils/bridge.js"
import { bridgeToCodex } from "./utils/codexBridge.js"
import { buildInferenceIndex, loadTranslationConfig, resolveModelTarget, resolveRole, saveTranslationConfig, type TranslationConfig } from "./utils/translationConfig.js"
import { AUTO_COMMIT_MESSAGES, repositoryTransaction } from "./utils/repositoryTransaction.js"

interface AppProps {
  workspaceRoot: string
}

type ViewMode =
  | "main"
  | "model-selector"
  | "tier-selector"
  | "organization-confirm"
   | "action-result"
  | "fork-prompt"
  | "bridge-prompt"
  | "export-confirm"
  | "color-selector"
  | "rename-prompt"
  | "permission-preset"
  | "delegation-manager"
  | "parameter-tuning"
  | "import-diff"
type ViewStyle = "list" | "tree"

interface ActiveItem {
  type: "file" | "folder"
  id: string // filePath for file, category name for folder
  label: string
  category: string
  agent?: AgentInfo
}

const CATEGORY_DESCRIPTIONS: Record<string, string> = {
  wiki: "Codebase analysis and automatic project wiki page generation & updating.",
  "go-pipeline": "Go pipeline agents for code review, planning, testing, and executor loops.",
  "copilot-pipeline": "Copilot pipeline agents for devtools debugging, Swift specialist tasks, and executor review loops.",
  slides: "PowerPoint slides templating, layout design, composition analysis, and page writer.",
  docs: "HTML documentation structure planning, layout design, and generation.",
  storybook: "Storybook components format and documentation builder.",
  general: "General orchestrators, bash executors, loop verifiers, and multi-purpose agents."
}

const COLOR_PALETTE: { group: string; emoji: string; colors: { name: string; value: string; hex: string }[] }[] = [
  { group: "Theme Colors", emoji: "🎨", colors: [
    { name: "primary", value: "primary", hex: "#3498DB" },
    { name: "secondary", value: "secondary", hex: "#95A5A6" },
    { name: "accent", value: "accent", hex: "#9B59B6" },
    { name: "success", value: "success", hex: "#2ECC71" },
    { name: "warning", value: "warning", hex: "#F1C40F" },
    { name: "error", value: "error", hex: "#E74C3C" },
    { name: "info", value: "info", hex: "#00B8D4" },
  ]},
  { group: "Reds", emoji: "🔴", colors: [
    { name: "Coral", value: "#FF6B6B", hex: "#FF6B6B" },
    { name: "Alizarin", value: "#E74C3C", hex: "#E74C3C" },
    { name: "Pomegranate", value: "#C0392B", hex: "#C0392B" },
    { name: "Crimson", value: "#DC143C", hex: "#DC143C" },
  ]},
  { group: "Oranges", emoji: "🟠", colors: [
    { name: "Tangerine", value: "#FF8C42", hex: "#FF8C42" },
    { name: "Carrot", value: "#E67E22", hex: "#E67E22" },
    { name: "Pumpkin", value: "#D35400", hex: "#D35400" },
    { name: "Burnt Orange", value: "#FF6B35", hex: "#FF6B35" },
  ]},
  { group: "Yellows", emoji: "🟡", colors: [
    { name: "Sunflower", value: "#F1C40F", hex: "#F1C40F" },
    { name: "Saffron", value: "#FFC312", hex: "#FFC312" },
    { name: "Mustard", value: "#F9CA24", hex: "#F9CA24" },
    { name: "Gold", value: "#FFD700", hex: "#FFD700" },
  ]},
  { group: "Greens", emoji: "🟢", colors: [
    { name: "Emerald", value: "#2ECC71", hex: "#2ECC71" },
    { name: "Nephritis", value: "#27AE60", hex: "#27AE60" },
    { name: "Mint", value: "#00B894", hex: "#00B894" },
    { name: "Forest", value: "#1B9C5A", hex: "#1B9C5A" },
  ]},
  { group: "Blues", emoji: "🔵", colors: [
    { name: "Peter River", value: "#3498DB", hex: "#3498DB" },
    { name: "Belize", value: "#2980B9", hex: "#2980B9" },
    { name: "Electron", value: "#0984E3", hex: "#0984E3" },
    { name: "Navy", value: "#2C3E87", hex: "#2C3E87" },
  ]},
  { group: "Purples", emoji: "🟣", colors: [
    { name: "Amethyst", value: "#9B59B6", hex: "#9B59B6" },
    { name: "Wisteria", value: "#8E44AD", hex: "#8E44AD" },
    { name: "Purple Heart", value: "#6C5CE7", hex: "#6C5CE7" },
    { name: "Indigo", value: "#5352ED", hex: "#5352ED" },
  ]},
  { group: "Pinks", emoji: "🩷", colors: [
    { name: "Pink", value: "#E84393", hex: "#E84393" },
    { name: "Fuchsia", value: "#FD79A8", hex: "#FD79A8" },
    { name: "Rose", value: "#F78FB3", hex: "#F78FB3" },
    { name: "Hot Pink", value: "#FF1493", hex: "#FF1493" },
  ]},
  { group: "Neutrals", emoji: "⚪", colors: [
    { name: "Silver", value: "#BDC3C7", hex: "#BDC3C7" },
    { name: "Concrete", value: "#95A5A6", hex: "#95A5A6" },
    { name: "Asbestos", value: "#7F8C8D", hex: "#7F8C8D" },
    { name: "Slate", value: "#546E7A", hex: "#546E7A" },
  ]},
]

interface ColorTreeItem {
  type: "group" | "color"
  id: string
  label: string
  group: string
  hex: string
  value: string
}

export function App({ workspaceRoot }: AppProps) {
  const mutate = <T,>(paths: string[], operation: keyof typeof AUTO_COMMIT_MESSAGES, fn: () => T): T =>
    repositoryTransaction(workspaceRoot, paths, AUTO_COMMIT_MESSAGES[operation], fn)
  // Data State
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [models, setModels] = useState<string[]>([])
  const [selectedAgentPaths, setSelectedAgentPaths] = useState<Set<string>>(new Set())

  // View Settings
  const [viewStyle, setViewStyle] = useState<ViewStyle>("list")
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(
    new Set(["wiki", "go-pipeline", "copilot-pipeline", "general"])
  )
  const [searchQuery, setSearchQuery] = useState("")
  const [isSearching, setIsSearching] = useState(false)

  // Navigation State
  const [focusedIndex, setFocusedIndex] = useState(0)
  const [scrollOffset, setScrollOffset] = useState(0)

  // Modal / Action State
  const [viewMode, setViewMode] = useState<ViewMode>("main")
  const [focusedModelIndex, setFocusedModelIndex] = useState(0)
  const [modelScrollOffset, setModelScrollOffset] = useState(0)
  const [focusedTierIndex, setFocusedTierIndex] = useState(0)
  const [tierScrollOffset, setTierScrollOffset] = useState(0)

  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set())

  const [actionResultTitle, setActionResultTitle] = useState("")
  const [actionResultLines, setActionResultLines] = useState<string[]>([])
  const [actionResultScrollOffset, setActionResultScrollOffset] = useState(0)

  // Fork Category State
  const [forkSourceCategory, setForkSourceCategory] = useState("")
  const [forkFindQuery, setForkFindQuery] = useState("")
  const [forkReplaceQuery, setForkReplaceQuery] = useState("")
  const [forkFocusedField, setForkFocusedField] = useState<"find" | "replace">("find")

  // Bridge State
  const [bridgePluginName, setBridgePluginName] = useState("")
  const [bridgePipelinePrefix, setBridgePipelinePrefix] = useState("")
  const [bridgeSourceDir, setBridgeSourceDir] = useState("general")
  const [bridgeTarget, setBridgeTarget] = useState<"claude" | "codex">("claude")
  const [bridgeFocusedField, setBridgeFocusedField] = useState<"name" | "prefix" | "sourceDir">("name")
  const [translationConfig, setTranslationConfig] = useState<TranslationConfig | null>(() => {
    try {
      return loadTranslationConfig(workspaceRoot, undefined, { persistMigration: false })
    } catch {
      return null
    }
  })

  // Color Selector State
  const [focusedColorIndex, setFocusedColorIndex] = useState(0)
  const [colorScrollOffset, setColorScrollOffset] = useState(0)
  const [expandedColorGroups, setExpandedColorGroups] = useState<Set<string>>(
    new Set(COLOR_PALETTE.map(g => g.group))
  )

  // Rename Assistant State
  const [renameTargetAgent, setRenameTargetAgent] = useState<AgentInfo | null>(null)
  const [renameFamily, setRenameFamily] = useState("")
  const [renameCategory, setRenameCategory] = useState("")
  const [renameRole, setRenameRole] = useState("")
  const [renameFocusedField, setRenameFocusedField] = useState<"family" | "category" | "role">("family")

  // Permission Preset State
  const [focusedPresetIndex, setFocusedPresetIndex] = useState(0)

  // Delegation Manager State
  const [delegationTargetAgent, setDelegationTargetAgent] = useState<AgentInfo | null>(null)
  const [selectedDelegations, setSelectedDelegations] = useState<Set<string>>(new Set())
  const [focusedDelegationIndex, setFocusedDelegationIndex] = useState(0)
  const [delegationScrollOffset, setDelegationScrollOffset] = useState(0)

  // Parameter Tuning State
  const [tuningSteps, setTuningSteps] = useState("50")
  const [tuningTemp, setTuningTemp] = useState("0.2")
  const [tuningMode, setTuningMode] = useState<"subagent" | "primary">("subagent")
  const [tuningHidden, setTuningHidden] = useState(false)
  const [tuningFocusedField, setTuningFocusedField] = useState<"steps" | "temp" | "mode" | "hidden">("steps")
  const [tuningTargetPaths, setTuningTargetPaths] = useState<string[]>([])

  // Import Diff State
  const [importDiffs, setImportDiffs] = useState<AgentDiffResult[]>([])
  const [focusedDiffIndex, setFocusedDiffIndex] = useState(0)
  const [importDiffScrollOffset, setImportDiffScrollOffset] = useState(0)

  // Inspector Tab State
  const [inspectorTab, setInspectorTab] = useState<"overview" | "naming" | "security" | "delegations">("overview")
  const [graphScrollOffset, setGraphScrollOffset] = useState(0)

  // Terminal Dimensions & Viewport Heights
  const { height: termHeight = 24 } = useTerminalDimensions() || {}
  const maxVisibleItems = Math.max(3, termHeight - 22)
  const maxVisibleModels = Math.max(3, Math.floor(termHeight * 0.7) - 9)
  // The tier modal uses the same 90% height / 5% top inset as the bridge modal.
  // Reserve one content row for the focused tier description.
  const maxVisibleTiers = Math.max(1, Math.floor(termHeight * 0.9) - 9)
  const maxVisibleColors = Math.max(3, Math.floor(termHeight * 0.7) - 9)
  const maxVisibleActionResultLines = Math.max(3, Math.floor(termHeight * 0.7) - 8)
  const maxVisibleImportDiffs = Math.max(3, Math.floor(termHeight * 0.8) - 14)

  const allAgentFilenames = useMemo(() => agents.map(a => a.filename), [agents])
  const bridgePrefixSuggestions = useMemo(() => [
    { prefix: "", count: agents.length },
    ...getCategoryPrefixes(allAgentFilenames)
  ], [allAgentFilenames, agents.length])
  const filteredBridgePrefixSuggestions = useMemo(() => {
    const query = bridgePipelinePrefix.toLowerCase()
    return bridgePrefixSuggestions.filter(({ prefix }) => !query || prefix.toLowerCase().includes(query))
  }, [bridgePipelinePrefix, bridgePrefixSuggestions])
   const [bridgeSuggestionIndex, setBridgeSuggestionIndex] = useState(0)
   const [bridgeSuggestionScrollOffset, setBridgeSuggestionScrollOffset] = useState(0)
  const bridgeSourceValidation = useMemo(() => {
    const validPath = Boolean(bridgeSourceDir) && !bridgeSourceDir.startsWith("/") && !bridgeSourceDir.split(/[\\/]/).includes("..")
    if (!validPath) return { valid: false, count: 0 }
    try {
      return { valid: true, count: findAgentFiles(workspaceRoot, bridgeSourceDir).length }
    } catch {
      return { valid: false, count: 0 }
    }
  }, [bridgeSourceDir, workspaceRoot])
  useEffect(() => {
    setBridgeSuggestionIndex(index => Math.min(index, Math.max(0, filteredBridgePrefixSuggestions.length - 1)))
    setBridgeSuggestionScrollOffset(offset => Math.min(offset, Math.max(0, filteredBridgePrefixSuggestions.length - 5)))
  }, [filteredBridgePrefixSuggestions.length])

  // Load agents and models on startup
  useEffect(() => {
    refreshData()
    try {
      const modelList = fetchModels()
      setModels(modelList)
    } catch (e) {
      // Ignore
    }
  }, [])

  useEffect(() => {
    if (viewMode === "action-result") setActionResultScrollOffset(0)
  }, [viewMode, actionResultLines])

  useEffect(() => {
    setGraphScrollOffset(0)
  }, [focusedIndex])

  useEffect(() => {
    if (viewMode === "bridge-prompt") {
      setBridgeSuggestionIndex(0)
      setBridgeSuggestionScrollOffset(0)
    }
  }, [viewMode])

  useEffect(() => {
    const maxOffset = Math.max(0, actionResultLines.length - maxVisibleActionResultLines)
    setActionResultScrollOffset((offset) => Math.min(offset, maxOffset))
  }, [actionResultLines.length, maxVisibleActionResultLines])

  useEffect(() => {
    const maxOffset = Math.max(0, importDiffs.length - maxVisibleImportDiffs)
    setImportDiffScrollOffset((offset) => Math.min(offset, maxOffset))
  }, [importDiffs.length, maxVisibleImportDiffs])

  const refreshData = () => {
    try {
       const list = findAgentFiles(workspaceRoot, translationConfig?.sourceDir || "general")
      setAgents(list)
    } catch (e) {
      setActionResultTitle("Error Refreshing Agents")
      setActionResultLines([`An error occurred:`, `  ${(e as any)?.message || e}`])
      setViewMode("action-result")
    }
  }

  const inferenceIndex = useMemo(
    () => translationConfig ? buildInferenceIndex(agents, translationConfig) : null,
    [agents, translationConfig]
  )
  const resolvedAgents = useMemo(() => {
    if (!translationConfig || !inferenceIndex) return new Map<string, ReturnType<typeof resolveModelTarget>>()
    return new Map(agents.map(agent => [agent.currentPath, resolveModelTarget(agent, inferenceIndex, translationConfig, "claude")]))
  }, [agents, inferenceIndex, translationConfig])

  const generateBridge = () => {
    if (!bridgePluginName) return
    try {
      const bridgeConfig = loadTranslationConfig(workspaceRoot, undefined, { persistMigration: false })
      const sourceAgents = findAgentFiles(workspaceRoot, bridgeSourceDir)
      const selectedAgents = selectedAgentPaths.size > 0
        ? agents.filter((a) => selectedAgentPaths.has(a.currentPath))
        : sourceAgents.filter((a) => a.category === (activeItems[focusedIndex]?.category || ""))
      const safePluginName = sanitizeFilename(bridgePluginName)
      const bridgeFolder = bridgeTarget === "codex" ? "codex" : "claude-code"
      const outputDir = `${workspaceRoot}/bridges/${bridgeFolder}/${safePluginName}`
      const result = mutate([path.join(workspaceRoot, ".agent-manager", "translation-config.json"), outputDir], "bridge", () => {
        saveTranslationConfig(workspaceRoot, { ...bridgeConfig, pluginName: bridgePluginName, prefix: bridgePipelinePrefix, sourceDir: bridgeSourceDir })
        return bridgeTarget === "codex"
          ? bridgeToCodex(selectedAgents, bridgePluginName, bridgePipelinePrefix, outputDir, workspaceRoot, { ...bridgeConfig, pluginName: bridgePluginName, prefix: bridgePipelinePrefix, sourceDir: bridgeSourceDir })
          : bridgeToClaudeCode(selectedAgents, bridgePluginName, bridgePipelinePrefix, outputDir, workspaceRoot, { ...bridgeConfig, pluginName: bridgePluginName, prefix: bridgePipelinePrefix, sourceDir: bridgeSourceDir })
      })
      setSelectedAgentPaths(new Set())
      setActionResultTitle(`Bridge to ${bridgeTarget === "codex" ? "Codex" : "Claude Code"} Complete`)
      const lines = [`${bridgeTarget === "codex" ? "Translation layer" : "Plugin"} '${safePluginName}' generated successfully!`, `Output directory:`, `  ${result.pluginDir}`, ``, `Generated ${result.files.length} files:`, ...result.files.map((f) => `  * ${f}`)]
      if (result.warnings.length > 0) lines.push(``, `⚠ Warnings:`, ...result.warnings.map((w) => `  * ${w}`))
      if (result.preview?.length) {
        const counts = result.preview.reduce<Record<string, number>>((acc, item) => { acc[item.source] = (acc[item.source] || 0) + 1; return acc }, {})
        lines.push(``, `Preview summary: ${Object.entries(counts).map(([source, count]) => `${count} by ${source}`).join(", ")}`, ...result.preview.map(item => `  ${item.agent} → ${item.role} → ${item.tier} → ${item.model} → ${item.source}`))
      }
      lines.push(``, ...(bridgeTarget === "codex" ? [`Codex project-scoped agents:`, `  cd ${result.pluginDir} && codex`, ``, `Plugin manifest:`, `  ${result.pluginDir}/.codex-plugin/plugin.json`] : [`Validate and run locally:`, `  claude plugin validate ${result.pluginDir} --strict`, `  claude --plugin-dir ${result.pluginDir} --agent orchestrator`]))
      setActionResultLines(lines)
      setViewMode("action-result")
    } catch (error: any) {
      setActionResultTitle("Error During Bridge")
      setActionResultLines([`An error occurred:`, `  ${error.message || error}`])
      setViewMode("action-result")
    }
  }

  // Automatically expand all providers on startup or models change
  useEffect(() => {
    const provs = new Set<string>()
    models.forEach(model => {
      const parts = model.split("/")
      const provider = parts.length > 1 ? parts[0] : "other"
      provs.add(provider)
    })
    setExpandedProviders(provs)
  }, [models])

  // Build color tree items
  const colorTreeItems = useMemo<ColorTreeItem[]>(() => {
    const items: ColorTreeItem[] = []
    COLOR_PALETTE.forEach(group => {
      const isExpanded = expandedColorGroups.has(group.group)
      items.push({
        type: "group",
        id: group.group,
        label: `${isExpanded ? "▼" : "▶"} ${group.emoji} ${group.group.toUpperCase()} (${group.colors.length})`,
        group: group.group,
        hex: "",
        value: ""
      })
      if (isExpanded) {
        group.colors.forEach(color => {
          items.push({
            type: "color",
            id: color.value,
            label: `  ${color.name}`,
            group: group.group,
            hex: color.hex,
            value: color.value
          })
        })
      }
    })
    return items
  }, [expandedColorGroups])

  // Clamp color index on layout tree size updates
  useEffect(() => {
    if (focusedColorIndex >= colorTreeItems.length) {
      const nextIndex = Math.max(0, colorTreeItems.length - 1)
      setFocusedColorIndex(nextIndex)
      updateColorScroll(nextIndex)
    }
  }, [colorTreeItems.length])

  // Filter and build active list items in real-time
  const activeItems = useMemo<ActiveItem[]>(() => {
    const filtered = agents.filter((a) =>
      a.filename.toLowerCase().includes(searchQuery.toLowerCase())
    )

    const items: ActiveItem[] = []

    if (viewStyle === "list") {
      filtered.forEach((a) => {
        items.push({
          type: "file",
          id: a.currentPath,
          label: a.filename,
          category: a.category,
          agent: a
        })
      })
    } else {
      // Tree View
      // Get unique categories dynamically from the parsed agents
      const categoriesSet = new Set<string>()
      agents.forEach((a) => categoriesSet.add(a.category))
      const categoriesList = Array.from(categoriesSet).sort((a, b) => {
        if (a === "general") return 1
        if (b === "general") return -1
        return a.localeCompare(b)
      })
      categoriesList.forEach((cat) => {
        const catAgents = filtered.filter((a) => a.category === cat)
        if (catAgents.length === 0) return

        const isExpanded = expandedCategories.has(cat)
        items.push({
          type: "folder",
          id: cat,
          label: `${isExpanded ? "▼" : "▶"} 📁 ${cat.toUpperCase()} (${catAgents.length})`,
          category: cat
        })

        if (isExpanded) {
          catAgents.forEach((a) => {
            items.push({
              type: "file",
              id: a.currentPath,
              label: `  ${a.filename}`,
              category: cat,
              agent: a
            })
          })
        }
      })
    }

    return items
  }, [agents, searchQuery, viewStyle, expandedCategories])

  const delegationItems = useMemo(
    () => delegationTargetAgent
      ? agents.filter((a) => a.filename.replace(/\.md$/, "") !== delegationTargetAgent.filename.replace(/\.md$/, ""))
      : [],
    [agents, delegationTargetAgent]
  )

  // Clamp focusedIndex and scrollOffset when list size changes
  useEffect(() => {
    setFocusedIndex(0)
    setScrollOffset(0)
  }, [searchQuery])

  useEffect(() => {
    if (focusedIndex < 0 || focusedIndex >= activeItems.length) {
      const nextIndex = Math.max(0, activeItems.length - 1)
      setFocusedIndex(nextIndex)
      updateScroll(nextIndex)
    }
  }, [activeItems.length])

  interface ModelTreeItem {
    type: "provider" | "model"
    id: string // provider name or full model name
    label: string
    provider: string
  }

  // Group models by provider and build tree items
  const modelTreeItems = useMemo<ModelTreeItem[]>(() => {
    const providers: Record<string, string[]> = {}
    models.forEach(model => {
      const parts = model.split("/")
      const provider = parts.length > 1 ? parts[0] : "other"
      if (!providers[provider]) {
        providers[provider] = []
      }
      providers[provider].push(model)
    })

    const items: ModelTreeItem[] = []
    Object.keys(providers).forEach(prov => {
      const isExpanded = expandedProviders.has(prov)
      items.push({
        type: "provider",
        id: prov,
        label: `${isExpanded ? "▼" : "▶"} 📁 ${prov.toUpperCase()} (${providers[prov].length})`,
        provider: prov
      })

      if (isExpanded) {
        providers[prov].forEach(model => {
          items.push({
            type: "model",
            id: model,
            label: `  ${model.split("/").slice(1).join("/")}`,
            provider: prov
          })
        })
      }
    })
    return items
  }, [models, expandedProviders])

  // Clamp model index on layout tree size updates
  useEffect(() => {
    if (focusedModelIndex >= modelTreeItems.length) {
      const nextIndex = Math.max(0, modelTreeItems.length - 1)
      setFocusedModelIndex(nextIndex)
      updateModelScroll(nextIndex)
    }
  }, [modelTreeItems.length])

  // Keyboard navigation and actions
  useKeyboard((e) => {
    const key = e.name.toLowerCase()
    const rawChar = /^[\x20-\x7E]$/.test(e.sequence)
      ? e.sequence
      : e.shift
        ? e.name.toUpperCase()
        : e.name
    const isUppercaseF = e.sequence === "F" || (key === "f" && !!e.shift)

    // 1. Intercept search input mode
    if (isSearching) {
      if (key === "escape") {
        setSearchQuery("")
        setIsSearching(false)
      } else if (key === "enter" || key === "return") {
        setIsSearching(false)
      } else if (key === "backspace") {
        setSearchQuery((q) => q.slice(0, -1))
      } else if (/^[\x20-\x7E]$/.test(rawChar)) {
        setSearchQuery((q) => q + rawChar)
      }
      return
    }

    // 2. Main view mode
    if (viewMode === "main") {
      if ((key === "up" || key === "k") && (inspectorTab === "security" || inspectorTab === "delegations") && currentItem?.agent) {
        setGraphScrollOffset((offset) => Math.max(0, offset - 1))
      } else if ((key === "down" || key === "j") && (inspectorTab === "security" || inspectorTab === "delegations") && currentItem?.agent) {
        const itemCount = inspectorTab === "security"
          ? Object.keys(currentItem.agent.frontmatter.permission || {}).filter((key) => key !== "task").length
          : (currentItem.agent.allowedSubagents || []).length
        setGraphScrollOffset((offset) => Math.min(Math.max(0, itemCount - Math.max(1, maxVisibleItems - 2)), offset + 1))
      } else if (key === "up" || key === "k") {
        if (activeItems.length === 0) return
        setFocusedIndex((prev) => {
          const next = prev > 0 ? prev - 1 : activeItems.length - 1
          return next
        })
        updateScroll(focusedIndex > 0 ? focusedIndex - 1 : activeItems.length - 1)
      } else if (key === "down" || key === "j") {
        if (activeItems.length === 0) return
        setFocusedIndex((prev) => {
          const next = prev < activeItems.length - 1 ? prev + 1 : 0
          return next
        })
        updateScroll(focusedIndex < activeItems.length - 1 ? focusedIndex + 1 : 0)
      } else if (key === "left" || key === "h") {
        if (activeItems.length > 0) {
          const item = activeItems[focusedIndex]
          if (item.type === "folder" && expandedCategories.has(item.id)) {
            setExpandedCategories((prev) => {
              const next = new Set(prev)
              next.delete(item.id)
              return next
            })
          }
        }
      } else if (key === "right" || key === "l") {
        if (activeItems.length > 0) {
          const item = activeItems[focusedIndex]
          if (item.type === "folder" && !expandedCategories.has(item.id)) {
            setExpandedCategories((prev) => {
              const next = new Set(prev)
              next.add(item.id)
              return next
            })
          }
        }
      } else if (key === "space") {
        if (activeItems.length > 0) {
          const item = activeItems[focusedIndex]
          if (item.type === "file" && item.agent) {
            const path = item.agent.currentPath
            setSelectedAgentPaths((prev) => {
              const next = new Set(prev)
              if (next.has(path)) {
                next.delete(path)
              } else {
                next.add(path)
              }
              return next
            })
          }
        }
      } else if (key === "a") {
        if (activeItems.length > 0) {
          const item = activeItems[focusedIndex]
          if (viewStyle === "tree") {
            const folderCategory = item.category
            const folderAgents = agents.filter((a) => a.category === folderCategory)
            const folderAgentPaths = folderAgents.map((a) => a.currentPath)

            setSelectedAgentPaths((prev) => {
              const next = new Set(prev)
              const allSelected = folderAgentPaths.every((path) => next.has(path))
              if (allSelected) {
                folderAgentPaths.forEach((path) => next.delete(path))
              } else {
                folderAgentPaths.forEach((path) => next.add(path))
              }
              return next
            })
          } else {
            setSelectedAgentPaths((prev) => {
              const next = new Set<string>()
              const files = activeItems.filter((i) => i.type === "file")
              const allSelected = files.every((i) => prev.has(i.id))
              if (!allSelected) {
                files.forEach((i) => next.add(i.id))
              }
              return next
            })
          }
        }
      } else if (key === "s") {
        if (activeItems.length > 0) {
          const item = activeItems[focusedIndex]
          if (item.type === "file" && item.agent) {
            const targetModel = item.agent.model
            const targetCategory = item.category

            const matchingAgents = agents.filter((a) => {
              const modelMatch = a.model === targetModel
              const categoryMatch = viewStyle === "tree" ? a.category === targetCategory : true
              return modelMatch && categoryMatch
            })

            const matchingAgentPaths = matchingAgents.map((a) => a.currentPath)

            setSelectedAgentPaths((prev) => {
              const next = new Set(prev)
              const allSelected = matchingAgentPaths.every((path) => next.has(path))
              if (allSelected) {
                matchingAgentPaths.forEach((path) => next.delete(path))
              } else {
                matchingAgentPaths.forEach((path) => next.add(path))
              }
              return next
            })
          }
        }
      } else if (key === "tab") {
        setViewStyle((style) => (style === "list" ? "tree" : "list"))
        setFocusedIndex(0)
        setScrollOffset(0)
      } else if (key === "/") {
        setIsSearching(true)
      } else if (key === "m") {
        if (activeItems.length === 0 || !activeItems[focusedIndex]?.agent) {
          setActionResultTitle("No Agent Focused")
          setActionResultLines([
            "Please select at least one agent (using SPACE)",
            "before trying to change the model."
          ])
          setViewMode("action-result")
        } else {
          setFocusedModelIndex(0)
          setModelScrollOffset(0)
          setViewMode("model-selector")
        }
      } else if (key === "t" && e.shift) {
        if (activeItems.length === 0 || !activeItems[focusedIndex]?.agent) {
          setActionResultTitle("No Agent Focused")
          setActionResultLines(["Please focus an agent (or select agents using SPACE)", "before assigning a tier."])
          setViewMode("action-result")
        } else {
          setFocusedTierIndex(0)
          setTierScrollOffset(0)
          setViewMode("tier-selector")
        }
      } else if (key === "o") {
        setViewMode("organization-confirm")
      } else if (key === "f" && !isUppercaseF) {
        if (activeItems.length > 0) {
          const item = activeItems[focusedIndex]
          setForkSourceCategory(item.category || "")
          setForkFindQuery("")
          setForkReplaceQuery("")
          setForkFocusedField("find")
          setViewMode("fork-prompt")
        }
      } else if (key === "b" && rawChar !== "B") {
        if (activeItems.length > 0) {
          const item = activeItems[focusedIndex]
          const cat = item.category || ""
          setBridgeTarget("claude")
             setBridgePluginName(translationConfig?.pluginName || "decent-pipeline")
             setBridgePipelinePrefix(translationConfig?.prefix || "")
            setBridgeSourceDir(translationConfig?.sourceDir || "general")
          setBridgeFocusedField("name")
          setViewMode("bridge-prompt")
        }
      } else if (key === "b" && rawChar === "B") {
        if (activeItems.length > 0) {
          const item = activeItems[focusedIndex]
          const cat = item.category || ""
          setBridgeTarget("codex")
            setBridgePluginName(translationConfig?.pluginName || "decent-pipeline")
             setBridgePipelinePrefix(translationConfig?.prefix || "")
            setBridgeSourceDir(translationConfig?.sourceDir || "general")
          setBridgeFocusedField("name")
          setViewMode("bridge-prompt")
        }
      } else if (key === "e") {
        setViewMode("export-confirm")
      } else if (key === "c") {
        if (activeItems.length === 0 || !activeItems[focusedIndex]?.agent) {
          setActionResultTitle("No Agent Focused")
          setActionResultLines([
            "Please select at least one agent (using SPACE)",
            "before trying to change the color."
          ])
          setViewMode("action-result")
        } else {
          setFocusedColorIndex(0)
          setColorScrollOffset(0)
          setViewMode("color-selector")
        }
      } else if (key === "r") {
        if (activeItems.length > 0) {
          const item = activeItems[focusedIndex]
          if (item.type === "file" && item.agent) {
            const analysis = analyzeAgentName(item.agent.filename, allAgentFilenames)
            setRenameTargetAgent(item.agent)
            setRenameFamily(analysis.family || "")
            setRenameCategory(analysis.category || "")
            setRenameRole((analysis.role || "").replace(/[\s-]/g, "_"))
            setRenameFocusedField("role")
            setViewMode("rename-prompt")
          }
        }
      } else if (key === "p") {
        if (activeItems.length > 0 && activeItems[focusedIndex]?.agent) {
          setFocusedPresetIndex(0)
          setViewMode("permission-preset")
        }
      } else if (key === "g") {
        if (activeItems.length > 0 && activeItems[focusedIndex]?.agent) {
          const target = activeItems[focusedIndex].agent!
          setDelegationTargetAgent(target)
          setSelectedDelegations(new Set(target.allowedSubagents || []))
          setFocusedDelegationIndex(0)
          setDelegationScrollOffset(0)
          setViewMode("delegation-manager")
        }
      } else if (key === "t") {
        if (activeItems.length > 0 && activeItems[focusedIndex]?.agent) {
          const target = activeItems[focusedIndex].agent!
          const targetAgents = selectedAgentPaths.size > 0
            ? agents.filter((a) => selectedAgentPaths.has(a.currentPath))
            : [target]
          setTuningTargetPaths(targetAgents.map((a) => a.currentPath))
          const defaults = targetAgents[0]
          setTuningSteps(String(defaults.frontmatter.steps || 50))
          setTuningTemp(String(defaults.frontmatter.temperature || 0.2))
          setTuningMode((target.frontmatter.mode as any) || "subagent")
          setTuningHidden(Boolean(target.frontmatter.hidden))
          setTuningFocusedField("steps")
          setViewMode("parameter-tuning")
        }
      } else if (key === "i") {
        try {
          const diffs = agents.map(a => compareAgentWithExport(a))
           setImportDiffs(diffs)
           setFocusedDiffIndex(0)
           setImportDiffScrollOffset(0)
           setViewMode("import-diff")
        } catch (error: any) {
          setActionResultTitle("Error Loading Import Diff")
          setActionResultLines([`An error occurred:`, `  ${error.message || error}`])
          setViewMode("action-result")
        }
      } else if (key === "1") {
        setInspectorTab("overview")
      } else if (key === "2") {
        setInspectorTab("naming")
      } else if (key === "3") {
        setInspectorTab("security")
        setGraphScrollOffset(0)
      } else if (key === "4") {
        setInspectorTab("delegations")
        setGraphScrollOffset(0)
      } else if (key === "pageup" && (inspectorTab === "security" || inspectorTab === "delegations")) {
        const graphPageSize = Math.max(1, maxVisibleItems - 2)
        setGraphScrollOffset((offset) => {
          const graphTotal = inspectorTab === "security"
            ? Object.entries(activeItems[focusedIndex]?.agent?.frontmatter.permission || {}).filter(([key]) => key !== "task").length
            : activeItems[focusedIndex]?.agent?.allowedSubagents?.length || 0
          return Math.max(0, Math.min(Math.max(0, graphTotal - graphPageSize), offset - graphPageSize))
        })
      } else if (key === "pagedown" && (inspectorTab === "security" || inspectorTab === "delegations")) {
        const graphPageSize = Math.max(1, maxVisibleItems - 2)
        setGraphScrollOffset((offset) => {
          const graphTotal = inspectorTab === "security"
            ? Object.entries(activeItems[focusedIndex]?.agent?.frontmatter.permission || {}).filter(([key]) => key !== "task").length
            : activeItems[focusedIndex]?.agent?.allowedSubagents?.length || 0
          return Math.min(Math.max(0, graphTotal - graphPageSize), offset + graphPageSize)
        })
      } else if (isUppercaseF && inspectorTab === "security" && activeItems[focusedIndex]?.agent) {
        const ag = activeItems[focusedIndex].agent!
        try {
          const fixed = mutate([ag.currentPath], "tune", () => fixPermissionOrder(ag))
          if (fixed) {
            refreshData()
            setActionResultTitle("Permission Order Fixed")
            setActionResultLines([
              `Successfully reordered permissions for:`,
              `  ${ag.filename}`,
              `Placed wildcard "*": "deny" FIRST to comply with OpenCode spec.`
            ])
          } else {
            setActionResultTitle("Nothing to Fix")
            setActionResultLines([`Permission order is already correct for ${ag.filename}.`])
          }
        } catch (error: any) {
          setActionResultTitle("Error Fixing Permission Order")
          setActionResultLines([`An error occurred:`, `  ${error.message || error}`])
        }
        setViewMode("action-result")
      }
    } else if (viewMode === "model-selector") {
      // 3. Model selector mode
      if (key === "up" || key === "k") {
        if (modelTreeItems.length === 0) return
        const next = focusedModelIndex > 0 ? focusedModelIndex - 1 : modelTreeItems.length - 1
        setFocusedModelIndex(next)
        setModelScrollOffset((offset) => {
          if (next < offset) return next
          if (next >= offset + maxVisibleModels) return next - maxVisibleModels + 1
          return offset
        })
      } else if (key === "down" || key === "j") {
        if (modelTreeItems.length === 0) return
        const next = focusedModelIndex < modelTreeItems.length - 1 ? focusedModelIndex + 1 : 0
        setFocusedModelIndex(next)
        setModelScrollOffset((offset) => {
          if (next < offset) return next
          if (next >= offset + maxVisibleModels) return next - maxVisibleModels + 1
          return offset
        })
      } else if (key === "pageup" || key === "pagedown") {
        const delta = key === "pageup" ? -maxVisibleModels : maxVisibleModels
        const next = Math.max(0, Math.min(Math.max(0, modelTreeItems.length - 1), focusedModelIndex + delta))
        setFocusedModelIndex(next)
        setModelScrollOffset(Math.max(0, Math.min(Math.max(0, modelTreeItems.length - maxVisibleModels), next)))
      } else if (key === "left" || key === "h") {
        if (modelTreeItems.length > 0) {
          const item = modelTreeItems[focusedModelIndex]
          if (item.type === "provider" && expandedProviders.has(item.id)) {
            setExpandedProviders((prev) => {
              const next = new Set(prev)
              next.delete(item.id)
              return next
            })
          }
        }
      } else if (key === "right" || key === "l") {
        if (modelTreeItems.length > 0) {
          const item = modelTreeItems[focusedModelIndex]
          if (item.type === "provider" && !expandedProviders.has(item.id)) {
            setExpandedProviders((prev) => {
              const next = new Set(prev)
              next.add(item.id)
              return next
            })
          }
        }
      } else if (key === "enter" || key === "return") {
        if (modelTreeItems.length > 0) {
          const item = modelTreeItems[focusedModelIndex]
          if (item.type === "provider") {
            setExpandedProviders((prev) => {
              const next = new Set(prev)
              if (next.has(item.id)) {
                next.delete(item.id)
              } else {
                next.add(item.id)
              }
              return next
            })
          } else {
            const selectedModel = item.id
            try {
              const selectedAgents = selectedAgentPaths.size > 0
                ? agents.filter((a) => selectedAgentPaths.has(a.currentPath))
                : (activeItems[focusedIndex]?.agent ? [activeItems[focusedIndex].agent!] : [])
              mutate(selectedAgents.map(a => a.currentPath), "tune", () => updateAgentsModel(selectedAgents, selectedModel))
              refreshData()
              setSelectedAgentPaths(new Set())
              setActionResultTitle("Model Updated Successfully")
              setActionResultLines([`Successfully set model:`, `  ${selectedModel}`, `on ${selectedAgents.length} agents.`])
            } catch (error: any) {
              setActionResultTitle("Error Updating Model")
              setActionResultLines([`An error occurred:`, `  ${error.message || error}`])
            }
            setViewMode("action-result")
          }
        }
      } else if (key === "escape") {
        setViewMode("main")
      }
    } else if (viewMode === "tier-selector") {
      const tiers = translationConfig ? Object.keys(translationConfig.tiers) : []
      const targetAgents = selectedAgentPaths.size > 0
        ? agents.filter(a => selectedAgentPaths.has(a.currentPath))
        : (activeItems[focusedIndex]?.agent ? [activeItems[focusedIndex].agent!] : [])
      if (key === "up" || key === "k" || key === "down" || key === "j") {
        if (tiers.length === 0) return
        const direction = key === "up" || key === "k" ? -1 : 1
        const next = (focusedTierIndex + direction + tiers.length) % tiers.length
        setFocusedTierIndex(next)
        setTierScrollOffset(Math.max(0, Math.min(Math.max(0, tiers.length - maxVisibleTiers), next)))
      } else if (key === "pageup" || key === "pagedown") {
        const delta = key === "pageup" ? -maxVisibleTiers : maxVisibleTiers
        const next = Math.max(0, Math.min(Math.max(0, tiers.length - 1), focusedTierIndex + delta))
        setFocusedTierIndex(next)
        setTierScrollOffset(Math.max(0, Math.min(Math.max(0, tiers.length - maxVisibleTiers), next)))
      } else if (key === "enter" || key === "return") {
        const chosenTier = tiers[focusedTierIndex]
        if (!chosenTier || !translationConfig) return
        try {
          const roles: Set<string> = new Set(targetAgents.map(agent => resolveRole(agent, translationConfig)))
          const impacted = agents.filter(agent => !targetAgents.some(target => target.currentPath === agent.currentPath) && roles.has(resolveRole(agent, translationConfig)))
          const nextConfig = { ...translationConfig, roles: { ...translationConfig.roles } }
          roles.forEach(role => { nextConfig.roles[role] = chosenTier })
           mutate([path.join(workspaceRoot, ".agent-manager", "translation-config.json")], "config", () => saveTranslationConfig(workspaceRoot, nextConfig))
           setTranslationConfig(loadTranslationConfig(workspaceRoot, undefined, { persistMigration: false }))
          refreshData()
          setSelectedAgentPaths(new Set())
          setActionResultTitle("Tier Assigned Successfully")
          setActionResultLines([
            `Tier: ${chosenTier}`,
            `Roles modified: ${Array.from(roles).join(", ") || "none"}`,
            ...(impacted.length ? [`⚠ Shared-role impact on non-selected agents:`, ...impacted.map(agent => `  ${agent.filename}`)] : ["No non-selected agents share these roles."])
          ])
        } catch (error: any) {
          setActionResultTitle("Error Assigning Tier")
          setActionResultLines(["An error occurred:", `  ${error.message || error}`])
        }
        setViewMode("action-result")
      } else if (key === "escape") {
        setViewMode("main")
      }
    } else if (viewMode === "organization-confirm") {
      // 4. Auto-organize confirm mode
      if (key === "y" || key === "enter" || key === "return") {
        try {
            const { copied, skipped, backupsPath } = mutate(agents.flatMap(a => [a.currentPath, a.targetPath]), "organize", () => organizeAgents(workspaceRoot, agents))
          refreshData()
          setActionResultTitle("Reorganization Complete")
          setActionResultLines([
            `Local backup created at:`,
            `  ${backupsPath}`,
            ``,
            `Copied ${copied.length} files to category directories:`
           ].concat(copied.map((line) => `  * ${line}`), skipped.length > 0 ? [``, `Skipped ${skipped.length} files:`, ...skipped.map((line) => `  * ${line}`)] : []))
        } catch (error: any) {
          setActionResultTitle("Error During Reorganization")
          setActionResultLines([`An error occurred:`, `  ${error.message || error}`])
        }
        setViewMode("action-result")
      } else if (key === "n" || key === "escape") {
        setViewMode("main")
      }
    } else if (viewMode === "fork-prompt") {
      // 5. Fork category prompt mode
      if (key === "escape") {
        setViewMode("main")
      } else if (key === "tab" || key === "up" || key === "down") {
        setForkFocusedField((prev) => (prev === "find" ? "replace" : "find"))
      } else if (key === "backspace") {
        if (forkFocusedField === "find") {
          setForkFindQuery((prev) => prev.slice(0, -1))
        } else {
          setForkReplaceQuery((prev) => prev.slice(0, -1))
        }
      } else if (key === "enter" || key === "return") {
        if (!forkFindQuery) return
        try {
          const selectedPaths: string[] | undefined = selectedAgentPaths.size > 0 ? Array.from(selectedAgentPaths) : undefined
           const result = mutate([path.join(workspaceRoot, "general", "agents")], "fork", () => forkCategory(workspaceRoot, forkSourceCategory, forkFindQuery, forkReplaceQuery, selectedPaths))
          refreshData()
          setSelectedAgentPaths(new Set())
          setActionResultTitle("Fork Category Complete")
          setActionResultLines([
            `Category '${forkSourceCategory}' successfully forked!`,
            result.backupsPath ? `Local backup created at:` : `No backup needed`,
            ...(result.backupsPath ? [`  ${result.backupsPath}`] : []),
            ``,
            `Forked ${result.copied.length} files under general/agents/:`
          ].concat(result.copied.map((line) => `  * ${line}`), result.skipped.length > 0 ? [``, `Skipped ${result.skipped.length} files:`, ...result.skipped.map((line) => `  * ${line}`)] : []))
          setViewMode("action-result")
        } catch (error: any) {
          setActionResultTitle("Error During Fork")
          setActionResultLines([`An error occurred:`, `  ${error.message || error}`])
          setViewMode("action-result")
        }
      } else if (/^[\x20-\x7E]$/.test(rawChar)) {
        if (forkFocusedField === "find") {
          setForkFindQuery((prev) => prev + rawChar)
        } else {
          setForkReplaceQuery((prev) => prev + rawChar)
        }
      }
    } else if (viewMode === "bridge-prompt") {
      // 6. Bridge to Claude Code prompt mode
      if (key === "escape") {
        setViewMode("main")
      } else if (key === "tab") {
        if (bridgeFocusedField === "prefix" && filteredBridgePrefixSuggestions.length > 0) {
          setBridgePipelinePrefix(filteredBridgePrefixSuggestions[bridgeSuggestionIndex].prefix)
        }
        setBridgeFocusedField((prev) => prev === "name" ? "prefix" : prev === "prefix" ? "sourceDir" : "name")
      } else if (key === "up" || key === "down") {
        if (bridgeFocusedField === "prefix" && filteredBridgePrefixSuggestions.length > 0) {
            setBridgeSuggestionIndex(index => {
             const delta = key === "down" ? 1 : -1
             const length = filteredBridgePrefixSuggestions.length
             const next = (index + delta + length) % length
             setBridgeSuggestionScrollOffset(offset => next < offset ? next : next >= offset + 5 ? next - 4 : offset)
             return next
           })
        } else {
          setBridgeFocusedField((prev) => prev === "name" ? "prefix" : prev === "prefix" ? "sourceDir" : "name")
        }
      }
    } else if (viewMode === "export-confirm") {
      // 7. Export confirmation mode
      if (key === "y" || key === "enter" || key === "return") {
        try {
          const result = exportAgents(agents, selectedAgentPaths.size > 0 ? selectedAgentPaths : undefined)
          setSelectedAgentPaths(new Set())
          setActionResultTitle("Export Complete")
          const lines = [
            `Successfully exported ${result.exported.length} agents to:`,
            `  ${result.destinationPath.replace(/\/Users\/[^\/]+/, "~")}`,
            ``,
            `Disaster-recovery backup at:`,
            `  ${result.backupPath.replace(/\/Users\/[^\/]+/, "~")}`
          ]
          if (result.skipped.length > 0) {
            lines.push(``, `⚠ Skipped ${result.skipped.length} files:`,
              ...result.skipped.map((s) => `  * ${s}`))
          }
          setActionResultLines(lines)
        } catch (error: any) {
          setActionResultTitle("Error During Export")
          setActionResultLines([`An error occurred:`, `  ${error.message || error}`])
        }
        setViewMode("action-result")
      } else if (key === "n" || key === "escape") {
        setViewMode("main")
      }
    } else if (viewMode === "color-selector") {
      // 8. Color selector mode
      if (key === "up" || key === "k") {
        if (colorTreeItems.length === 0) return
        const next = focusedColorIndex > 0 ? focusedColorIndex - 1 : colorTreeItems.length - 1
        setFocusedColorIndex(next)
        setColorScrollOffset((offset) => next < offset ? next : next >= offset + maxVisibleColors ? next - maxVisibleColors + 1 : offset)
      } else if (key === "down" || key === "j") {
        if (colorTreeItems.length === 0) return
        const next = focusedColorIndex < colorTreeItems.length - 1 ? focusedColorIndex + 1 : 0
        setFocusedColorIndex(next)
        setColorScrollOffset((offset) => next < offset ? next : next >= offset + maxVisibleColors ? next - maxVisibleColors + 1 : offset)
      } else if (key === "left" || key === "h") {
        if (colorTreeItems.length > 0) {
          const item = colorTreeItems[focusedColorIndex]
          if (item.type === "group" && expandedColorGroups.has(item.id)) {
            setExpandedColorGroups((prev) => {
              const next = new Set(prev)
              next.delete(item.id)
              return next
            })
          }
        }
      } else if (key === "right" || key === "l") {
        if (colorTreeItems.length > 0) {
          const item = colorTreeItems[focusedColorIndex]
          if (item.type === "group" && !expandedColorGroups.has(item.id)) {
            setExpandedColorGroups((prev) => {
              const next = new Set(prev)
              next.add(item.id)
              return next
            })
          }
        }
      } else if (key === "enter" || key === "return") {
        if (colorTreeItems.length > 0) {
          const item = colorTreeItems[focusedColorIndex]
          if (item.type === "group") {
            setExpandedColorGroups((prev) => {
              const next = new Set(prev)
              if (next.has(item.id)) {
                next.delete(item.id)
              } else {
                next.add(item.id)
              }
              return next
            })
          } else {
            const selectedColor = item.value
            try {
              const selectedAgents = selectedAgentPaths.size > 0
                ? agents.filter((a) => selectedAgentPaths.has(a.currentPath))
                : (activeItems[focusedIndex]?.agent ? [activeItems[focusedIndex].agent!] : [])
              mutate(selectedAgents.map(a => a.currentPath), "tune", () => updateAgentsColor(selectedAgents, selectedColor))
              refreshData()
              setSelectedAgentPaths(new Set())
              setActionResultTitle("Color Updated Successfully")
              setActionResultLines([`Successfully set color:`, `  ${selectedColor} (${item.label.trim()})`, `on ${selectedAgents.length} agents.`])
            } catch (error: any) {
              setActionResultTitle("Error Updating Color")
              setActionResultLines([`An error occurred:`, `  ${error.message || error}`])
            }
            setViewMode("action-result")
          }
        }
      } else if (key === "escape") {
        setViewMode("main")
      }
    } else if (viewMode === "permission-preset") {
      // 10. Permission preset mode
      if (key === "up" || key === "k") {
        setFocusedPresetIndex((prev) => (prev > 0 ? prev - 1 : SAFETY_PRESETS.length - 1))
      } else if (key === "down" || key === "j") {
        setFocusedPresetIndex((prev) => (prev < SAFETY_PRESETS.length - 1 ? prev + 1 : 0))
      } else if (key === "enter" || key === "return") {
        const preset = SAFETY_PRESETS[focusedPresetIndex]
        const targetAgents = selectedAgentPaths.size > 0
          ? agents.filter((a) => selectedAgentPaths.has(a.currentPath))
          : (activeItems[focusedIndex]?.agent ? [activeItems[focusedIndex].agent!] : [])
        try {
           mutate(targetAgents.map(a => a.currentPath), "tune", () => applySafetyPreset(targetAgents, preset.key))
          refreshData()
          setSelectedAgentPaths(new Set())
          setActionResultTitle("Safety Preset Applied")
          setActionResultLines([`Successfully applied preset '${preset.name}'`, `to ${targetAgents.length} agents.`])
        } catch (error: any) {
          setActionResultTitle("Error Applying Safety Preset")
          setActionResultLines([`An error occurred:`, `  ${error.message || error}`])
        }
        setViewMode("action-result")
      } else if (key === "escape") {
        setViewMode("main")
      }
    } else if (viewMode === "delegation-manager") {
      // 11. Delegation manager mode
      if (key === "up" || key === "k") {
        if (delegationItems.length === 0) return
        const next = focusedDelegationIndex > 0 ? focusedDelegationIndex - 1 : delegationItems.length - 1
        setFocusedDelegationIndex(next)
         updateDelegationScroll(next)
       } else if (key === "pageup" || key === "pagedown") {
         if (delegationItems.length === 0) return
         const pageSize = Math.max(1, maxVisibleItems)
         const maxOffset = Math.max(0, delegationItems.length - pageSize)
         setDelegationScrollOffset((offset) => {
           const nextOffset = key === "pageup" ? offset - pageSize : offset + pageSize
           const clampedOffset = Math.max(0, Math.min(maxOffset, nextOffset))
           setFocusedDelegationIndex(Math.min(delegationItems.length - 1, clampedOffset))
           return clampedOffset
         })
      } else if (key === "down" || key === "j") {
        if (delegationItems.length === 0) return
        const next = focusedDelegationIndex < delegationItems.length - 1 ? focusedDelegationIndex + 1 : 0
        setFocusedDelegationIndex(next)
        updateDelegationScroll(next)
      } else if (key === "space") {
        const targetSubagent = delegationItems[focusedDelegationIndex]
        if (targetSubagent) {
          const subName = targetSubagent.filename.replace(/\.md$/, "")
          setSelectedDelegations((prev) => {
            const next = new Set(prev)
            if (next.has(subName)) next.delete(subName)
            else next.add(subName)
            return next
          })
        }
      } else if (key === "enter" || key === "return") {
        if (delegationTargetAgent) {
          const allowedNames: string[] = Array.from(selectedDelegations)
          try {
             mutate([delegationTargetAgent.currentPath], "tune", () => updateAgentDelegations(delegationTargetAgent, allowedNames))
            refreshData()
            setActionResultTitle("Delegation Graph Updated")
            setActionResultLines([`Updated subagent delegation permissions for:`, `  ${delegationTargetAgent.filename}`, ``, `Allowed subagents (${allowedNames.length}):`, ...allowedNames.map((name) => `  * ${name}`)])
          } catch (error: any) {
            setActionResultTitle("Error Updating Delegations")
            setActionResultLines([`An error occurred:`, `  ${error.message || error}`])
          }
          setViewMode("action-result")
        }
      } else if (key === "escape") {
        setViewMode("main")
      }
    } else if (viewMode === "parameter-tuning") {
      // 12. Parameter tuning mode
      if (key === "escape") {
        setViewMode("main")
      } else if (key === "tab" || key === "down") {
        setTuningFocusedField((prev) =>
          prev === "steps" ? "temp" : prev === "temp" ? "mode" : prev === "mode" ? "hidden" : "steps"
        )
      } else if (key === "up" || key === "k") {
        setTuningFocusedField((prev) =>
          prev === "hidden" ? "mode" : prev === "mode" ? "temp" : prev === "temp" ? "steps" : "hidden"
        )
      } else if (key === "space") {
        if (tuningFocusedField === "mode") {
          setTuningMode((prev) => (prev === "primary" ? "subagent" : "primary"))
        } else if (tuningFocusedField === "hidden") {
          setTuningHidden((prev) => !prev)
        }
      } else if (key === "backspace") {
        if (tuningFocusedField === "steps") {
          setTuningSteps((prev) => prev.slice(0, -1))
        } else if (tuningFocusedField === "temp") {
          setTuningTemp((prev) => prev.slice(0, -1))
        }
      } else if (key === "enter" || key === "return") {
        const targetAgents = tuningTargetPaths.length > 0
          ? agents.filter((a) => tuningTargetPaths.includes(a.currentPath))
          : []
        
        if (targetAgents.length === 0) return

        const stepsNum = tuningSteps ? parseInt(tuningSteps, 10) : undefined
        const tempNum = tuningTemp ? parseFloat(tuningTemp) : undefined
        if ((stepsNum !== undefined && (!Number.isFinite(stepsNum) || stepsNum < 0)) ||
            (tempNum !== undefined && (!Number.isFinite(tempNum) || tempNum < 0 || tempNum > 1))) {
          setActionResultTitle("Invalid Parameters")
          setActionResultLines(["Steps must be a non-negative number and temperature must be between 0 and 1."])
          setViewMode("action-result")
          return
        }

        try {
          mutate(targetAgents.map(a => a.currentPath), "tune", () => updateAgentParams(targetAgents, {
          steps: stepsNum,
          temperature: tempNum,
          mode: tuningMode,
          hidden: tuningHidden
          }))
          refreshData()
          setSelectedAgentPaths(new Set())
          setActionResultTitle("Parameters Updated Successfully")
          setActionResultLines([
          `Successfully tuned parameters for ${targetAgents.length} agents:`,
          `  * Steps:  ${tuningSteps || "unchanged"}`,
          `  * Temp:   ${tuningTemp || "unchanged"}`,
          `  * Mode:   ${tuningMode}`,
          `  * Hidden: ${tuningHidden}`
          ])
        } catch (error: any) {
          setActionResultTitle("Error Updating Parameters")
          setActionResultLines([`An error occurred:`, `  ${error.message || error}`])
        }
        setViewMode("action-result")
      } else if (/^[\x20-\x7E]$/.test(rawChar) && rawChar !== " ") {
        if (tuningFocusedField === "steps" && /[0-9]/.test(rawChar)) {
          setTuningSteps((prev) => prev + rawChar)
        } else if (tuningFocusedField === "temp" && /[0-9]/.test(rawChar)) {
          setTuningTemp((prev) => prev + rawChar)
        } else if (tuningFocusedField === "temp" && rawChar === "." && !tuningTemp.includes(".")) {
          setTuningTemp((prev) => prev + rawChar)
        }
      }
    } else if (viewMode === "rename-prompt") {
      // 13. Rename agent prompt mode
      if (key === "escape") {
        setViewMode("main")
      } else if (key === "tab" || key === "down") {
        setRenameFocusedField((prev) =>
          prev === "family" ? "category" : prev === "category" ? "role" : "family"
        )
      } else if (key === "up") {
        setRenameFocusedField((prev) =>
          prev === "family" ? "role" : prev === "role" ? "category" : "family"
        )
      } else if (key === "backspace") {
        if (renameFocusedField === "family") {
          setRenameFamily((prev) => prev.slice(0, -1))
        } else if (renameFocusedField === "category") {
          setRenameCategory((prev) => prev.slice(0, -1))
        } else {
          setRenameRole((prev) => prev.slice(0, -1))
        }
      } else if (key === "enter" || key === "return") {
        const role = renameRole.trim().replace(/\s+/g, "_").replace(/-/g, "_")
        const cat = renameCategory.trim()
        const fam = renameFamily.trim()
        if (!renameTargetAgent || !cat || !role) return
        const newFilename = fam ? `${fam}-${cat}-${role}.md` : `${cat}-${role}.md`
        try {
           const destination = path.join(path.dirname(renameTargetAgent.currentPath), sanitizeFilename(newFilename))
           const result = mutate([renameTargetAgent.currentPath, destination, ...agents.map(a => a.currentPath)], "rename", () => renameAgent(workspaceRoot, renameTargetAgent.currentPath, newFilename, agents))
          refreshData()
          setSelectedAgentPaths(new Set())
          setActionResultTitle("Rename Complete")
           setActionResultLines([
             `Successfully renamed agent:`,
            `  ${renameTargetAgent.filename} → ${newFilename}`,
            ...result.updatedReferences.map((reference) => `  ${reference}`)
             , ...(result.skipped.length > 0 ? [`Skipped files:`, ...result.skipped.map((file) => `  ${file}`)] : []),
             ...(result.error ? [``, `⚠ ${result.error}`] : [])
          ])
          setViewMode("action-result")
        } catch (error: any) {
          setActionResultTitle("Error During Rename")
          setActionResultLines([`An error occurred:`, `  ${error.message || error}`])
          setViewMode("action-result")
        }
      } else if (/^[\x20-\x7E]$/.test(rawChar)) {
        if (renameFocusedField === "family") {
          setRenameFamily((prev) => prev + rawChar)
        } else if (renameFocusedField === "category") {
          setRenameCategory((prev) => prev + rawChar)
        } else {
          setRenameRole((prev) => prev + rawChar)
        }
      }
    } else if (viewMode === "import-diff") {
      // 14. Import diff mode
      if (importDiffs.length > 0 && (key === "up" || key === "k")) {
         setFocusedDiffIndex((prev) => {
           const next = prev > 0 ? prev - 1 : importDiffs.length - 1
           setImportDiffScrollOffset((offset) => {
             if (next < offset) return next
             if (next >= offset + maxVisibleImportDiffs) return next - maxVisibleImportDiffs + 1
             return offset
           })
           return next
         })
      } else if (importDiffs.length > 0 && (key === "down" || key === "j")) {
         setFocusedDiffIndex((prev) => {
           const next = prev < importDiffs.length - 1 ? prev + 1 : 0
           setImportDiffScrollOffset((offset) => {
             if (next < offset) return next
             if (next >= offset + maxVisibleImportDiffs) return next - maxVisibleImportDiffs + 1
             return offset
           })
           return next
         })
      } else if (key === "pageup") {
         if (importDiffs.length > 0) {
           const next = Math.max(0, focusedDiffIndex - maxVisibleImportDiffs)
           setFocusedDiffIndex(next)
           setImportDiffScrollOffset(Math.min(next, Math.max(0, importDiffs.length - maxVisibleImportDiffs)))
         }
      } else if (key === "pagedown") {
         if (importDiffs.length > 0) {
           const next = Math.min(importDiffs.length - 1, focusedDiffIndex + maxVisibleImportDiffs)
           setFocusedDiffIndex(next)
           setImportDiffScrollOffset(Math.min(
             Math.max(0, importDiffs.length - maxVisibleImportDiffs),
             next
           ))
         }
      } else if (key === "enter" || key === "return") {
        try {
           const result = mutate([path.join(workspaceRoot, "general", "agents")], "import", () => importAgents(workspaceRoot))
          refreshData()
          setActionResultTitle("Import Complete")
          setActionResultLines([
            `Successfully imported ${result.imported.length} agents:`,
            ...result.imported.map((filename) => `  * ${filename}`),
            ``,
            result.backupPath ? `Backup created at:` : `No backup needed`,
            ...(result.backupPath ? [`  ${result.backupPath}`] : [])
          ])
        } catch (error: any) {
          setActionResultTitle("Error During Import")
          setActionResultLines([`An error occurred:`, `  ${error.message || error}`])
        }
        setViewMode("action-result")
      } else if (key === "escape") {
        setViewMode("main")
      }
    } else if (viewMode === "action-result") {
      // 10. Action result dialog
      const maxOffset = Math.max(0, actionResultLines.length - maxVisibleActionResultLines)
      if (key === "up" || key === "k") {
        setActionResultScrollOffset((offset) => Math.max(0, offset - 1))
      } else if (key === "down" || key === "j") {
        setActionResultScrollOffset((offset) => Math.min(maxOffset, offset + 1))
      } else if (key === "pageup") {
        setActionResultScrollOffset((offset) => Math.max(0, offset - maxVisibleActionResultLines))
      } else if (key === "pagedown") {
        setActionResultScrollOffset((offset) => Math.min(maxOffset, offset + maxVisibleActionResultLines))
      } else if (key === "escape" || key === "enter" || key === "return") {
        setViewMode("main")
      }
    } else {
      if (key === "escape") setViewMode("main")
    }
  })

  const updateScroll = (index: number) => {
    setScrollOffset((offset) => {
      if (index < offset) return Math.max(0, index)
      if (index >= offset + maxVisibleItems) return Math.max(0, index - maxVisibleItems + 1)
      return Math.max(0, offset)
    })
  }

  const updateDelegationScroll = (index: number) => {
    setDelegationScrollOffset((offset) => {
      if (index < offset) return index
      if (index >= offset + maxVisibleItems) return index - maxVisibleItems + 1
      return offset
    })
  }

  const updateModelScroll = (index: number) => {
    setModelScrollOffset((offset) => {
      if (index < offset) return index
      if (index >= offset + maxVisibleModels) return index - maxVisibleModels + 1
      return offset
    })
  }

  const updateColorScroll = (index: number) => {
    setColorScrollOffset((offset) => {
      if (index < offset) return index
      if (index >= offset + maxVisibleColors) return index - maxVisibleColors + 1
      return offset
    })
  }

  // Get active item
  const currentItem = activeItems[focusedIndex]

  // Render viewport lists
  const visibleItems = activeItems.slice(scrollOffset, scrollOffset + maxVisibleItems)
  const visibleModels = modelTreeItems.slice(modelScrollOffset, modelScrollOffset + maxVisibleModels)
  const visibleColors = colorTreeItems.slice(colorScrollOffset, colorScrollOffset + maxVisibleColors)
  const visibleDelegationItems = delegationItems.slice(delegationScrollOffset, delegationScrollOffset + maxVisibleItems)
  const visibleImportDiffs = importDiffs.slice(importDiffScrollOffset, importDiffScrollOffset + maxVisibleImportDiffs)
  const importDiffMaxOffset = Math.max(0, importDiffs.length - maxVisibleImportDiffs)
  const actionResultMaxOffset = Math.max(0, actionResultLines.length - maxVisibleActionResultLines)
  const visibleActionResultLines = actionResultLines.slice(
    actionResultScrollOffset,
    actionResultScrollOffset + maxVisibleActionResultLines
  )

  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      backgroundColor="#1e1e1e"
      padding={1}
    >
      {/* Header Banner */}
      <box
        width="100%"
        height={3}
        borderStyle="single"
        borderColor="#2B5581"
        justifyContent="space-between"
        alignItems="center"
        paddingLeft={2}
        paddingRight={2}
      >
        <text style={{ textColor: "#9ECBFF" }} b>
          {"★ OPENCODE AGENT MANAGER"}
        </text>
        <text style={{ textColor: "gray" }}>
          {`Style: ${viewStyle.toUpperCase()} | Terminal: ${termHeight} lines | Workspace: ${workspaceRoot.replace(/\/Users\/[^\/]+/, "~")}`}
        </text>
      </box>

      {/* Main Panel */}
      <box width="100%" flexGrow={1} flexDirection="row" marginTop={1}>
        {/* Left Side: Agents List (Wider to prevent filename cut-offs) */}
        <box
          width="68%"
          height="100%"
          borderStyle="round"
          borderColor="#444444"
          title={` Agents List (${viewStyle === "list" ? "Flat" : "Tree"}) `}
          titleColor="#9ECBFF"
          flexDirection="column"
          padding={1}
        >
           {/* Table Header */}
          {viewStyle === "list" ? (
            <box width="100%" flexDirection="row" borderStyle="single" border={["bottom"]} borderColor="#333333">
              <text style={{ textColor: "gray" }} width="8%">Sel</text>
               <text style={{ textColor: "gray" }} width="34%">Agent Name</text>
               <text style={{ textColor: "gray" }} width="16%">Category</text>
               <text style={{ textColor: "gray" }} width="14%">Tier</text>
              <text style={{ textColor: "gray" }} width="24%">Model</text>
            </box>
          ) : (
            <box width="100%" flexDirection="row" borderStyle="single" border={["bottom"]} borderColor="#333333">
              <text style={{ textColor: "gray" }} width="8%">Sel</text>
               <text style={{ textColor: "gray" }} width="50%">Agent Name</text>
               <text style={{ textColor: "gray" }} width="14%">Tier</text>
              <text style={{ textColor: "gray" }} width="24%">Model</text>
            </box>
          )}

          {/* List items */}
          <box width="100%" flexDirection="column" marginTop={1} flexGrow={1}>
            {activeItems.length === 0 ? (
              <text style={{ textColor: "yellow" }}>
                {searchQuery ? `No agents match search: "${searchQuery}"` : "No agent markdown files found."}
              </text>
            ) : (
              visibleItems.map((item, index) => {
                const globalIndex = scrollOffset + index
                const isFocused = globalIndex === focusedIndex

                const rowBg = isFocused ? "#2B5581" : "transparent"
                const itemColor = isFocused ? "#FFFFFF" : item.type === "folder" ? "yellow" : "#9ECBFF"

                if (viewStyle === "list") {
                  const agent = item.agent!
                  const isSelected = selectedAgentPaths.has(agent.currentPath)
                  const analysis = analyzeAgentName(agent.filename, allAgentFilenames)
                  const lintBadge = analysis.isValid ? "✓" : "⚠"
                  const lintColor = analysis.isValid ? "green" : "yellow"

                  return (
                    <box
                      key={item.id}
                      width="100%"
                      flexDirection="row"
                      backgroundColor={rowBg}
                      paddingLeft={1}
                      paddingRight={1}
                      height={1}
                    >
                      <text style={{ textColor: isSelected ? "green" : "gray" }} width="8%">
                        {isSelected ? " [x]" : " [ ]"}
                      </text>
                      <text style={{ textColor: lintColor }} width="4%">
                        {lintBadge}
                      </text>
                       <text style={{ textColor: itemColor }} width="34%" u={isFocused}>
                         {agent.filename}
                       </text>
                       <text style={{ textColor: "gray" }} width="16%">
                         {agent.category}
                       </text>
                       <text style={{ textColor: "magenta" }} width="14%">{resolvedAgents.get(agent.currentPath)?.tier || "-"}</text>
                      <text style={{ textColor: isFocused ? "#E1E4E8" : "#9ECBFF" }} width="24%">
                        {agent.model ? agent.model.split("/").pop() : "None"}
                      </text>
                    </box>
                  )
                } else {
                  // Tree layout row
                  const isSelected = item.agent ? selectedAgentPaths.has(item.id) : false
                  const prefix = item.type === "file" ? (isSelected ? "  [x]" : "  [ ]") : ""
                  const modelText = item.agent && item.agent.model ? item.agent.model.split("/").pop() : ""
                  const analysis = item.agent ? analyzeAgentName(item.agent.filename, allAgentFilenames) : null

                  return (
                    <box
                      key={`${item.type}-${item.id}`}
                      width="100%"
                      flexDirection="row"
                      backgroundColor={rowBg}
                      paddingLeft={1}
                      paddingRight={1}
                      height={1}
                    >
                      {item.type === "file" ? (
                        <text style={{ textColor: isSelected ? "green" : "gray" }} width="8%">
                          {prefix}
                        </text>
                      ) : (
                        <text width="8%">{" "}</text>
                      )}
                      {item.type === "file" && analysis ? (
                        <text style={{ textColor: analysis.isValid ? "green" : "yellow" }} width="4%">
                          {analysis.isValid ? "✓" : "⚠"}
                        </text>
                      ) : item.type === "file" ? (
                        <text width="4%">{" "}</text>
                      ) : null}
                       <text style={{ textColor: itemColor }} width={item.type === "file" ? "50%" : "54%"} u={isFocused && item.type === "file"}>
                         {item.type === "file" ? item.label : ` ${item.label}`}
                       </text>
                       {item.type === "file" && <text style={{ textColor: "magenta" }} width="14%">{resolvedAgents.get(item.agent!.currentPath)?.tier || "-"}</text>}
                      <text style={{ textColor: isFocused ? "#E1E4E8" : "#9ECBFF" }} width="24%">
                        {item.type === "file" ? modelText : ""}
                      </text>
                    </box>
                  )
                }
              })
            )}
          </box>

          {/* Real-time search filter display */}
          <box width="100%" padding={1} borderStyle="single" border={["top"]} borderColor="#333333" flexDirection="row" alignItems="center">
            <text style={{ textColor: isSearching ? "yellow" : "gray" }}>
              {isSearching ? "🔍 Filter typing: " : "🔍 Filter (Press /): "}
            </text>
            <text style={{ textColor: searchQuery ? "cyan" : "gray" }} b>
              {searchQuery ? `${searchQuery}_` : isSearching ? "type here..._" : "none"}
            </text>
          </box>

          {/* List Footer / Counter */}
          <box width="100%" justifyContent="space-between" paddingTop={1} borderStyle="single" border={["top"]} borderColor="#333333">
            <text style={{ textColor: "gray" }}>
              {`Total: ${agents.length} | Shown: ${activeItems.length} | Selected: ${selectedAgentPaths.size}`}
            </text>
            <text style={{ textColor: "gray" }}>
              {viewStyle === "tree"
                ? "[TAB] Toggle View | [/] Search | ◀/▶ Collapse/Expand"
                : "[TAB] Toggle View | [/] Search"}
            </text>
          </box>
        </box>

        {/* Right Side: Details & Actions (Tabbed Inspector) */}
        <box
          width="32%"
          height="100%"
          borderStyle="round"
          borderColor="#444444"
          title=" Inspector "
          titleColor="#9ECBFF"
          flexDirection="column"
          padding={1}
          marginLeft={1}
        >
          {/* Tab Navigation Bar */}
          <box flexDirection="row" width="100%" borderStyle="single" border={["bottom"]} borderColor="#333333" paddingBottom={1} marginBottom={1}>
            <text style={{ textColor: inspectorTab === "overview" ? "cyan" : "gray" }} u={inspectorTab === "overview"}>
              1.Info
            </text>
            <text style={{ textColor: "gray" }}>|</text>
            <text style={{ textColor: inspectorTab === "naming" ? "yellow" : "gray" }} u={inspectorTab === "naming"}>
              2.Name
            </text>
            <text style={{ textColor: "gray" }}>|</text>
            <text style={{ textColor: inspectorTab === "security" ? "red" : "gray" }} u={inspectorTab === "security"}>
              3.Sec
            </text>
            <text style={{ textColor: "gray" }}>|</text>
            <text style={{ textColor: inspectorTab === "delegations" ? "green" : "gray" }} u={inspectorTab === "delegations"}>
              4.Graph
            </text>
          </box>

          {currentItem ? (
            <box flexDirection="column" flexGrow={1} height={14}>
              {currentItem.type === "file" && currentItem.agent ? (
                <box flexDirection="column" flexGrow={1}>
                  <text style={{ textColor: "#9ECBFF" }} b>
                    {currentItem.agent.filename}
                  </text>

                  {/* TAB 1: OVERVIEW */}
                  {inspectorTab === "overview" && (
                    <box flexDirection="column" marginTop={1} flexGrow={1}>
                      <box flexDirection="row">
                        <text style={{ textColor: "gray" }} width="35%">Category:</text>
                        <text style={{ textColor: "yellow" }} width="65%">
                          {currentItem.agent.category}
                        </text>
                      </box>

                      <box flexDirection="row" marginTop={1}>
                        <text style={{ textColor: "gray" }} width="35%">Model:</text>
                        <text style={{ textColor: "cyan" }} width="65%">
                          {currentItem.agent.model || "Not specified"}
                        </text>
                      </box>

                      <box flexDirection="row" marginTop={1}>
                        <text style={{ textColor: "gray" }} width="35%">Color:</text>
                        <box flexDirection="row" width="65%">
                          {(() => {
                            const rawCol = currentItem.agent.frontmatter.color
                            if (!rawCol) return <text style={{ textColor: "gray" }}>Not set</text>
                            
                            // Find matching color hex from palette or raw hex
                            let hexColor = rawCol.startsWith("#") ? rawCol : "#9ECBFF"
                            COLOR_PALETTE.forEach(group => {
                              group.colors.forEach(c => {
                                if (c.value === rawCol) hexColor = c.hex
                              })
                            })

                            return (
                              <box flexDirection="row">
                                <box width={2} height={1} backgroundColor={hexColor} marginRight={1}>
                                  <text>{" "}</text>
                                </box>
                                <text style={{ textColor: "white" }}>{rawCol}</text>
                              </box>
                            )
                          })()}
                        </box>
                      </box>

                      <box flexDirection="row" marginTop={1}>
                        <text style={{ textColor: "gray" }} width="35%">Steps/Temp:</text>
                        <text style={{ textColor: "white" }}>
                          {`${currentItem.agent.frontmatter.steps || 50} steps / ${currentItem.agent.frontmatter.temperature ?? 0.2}°`}
                        </text>
                      </box>

                      <box flexDirection="column" marginTop={1} flexGrow={1}>
                        <text style={{ textColor: "gray" }}>Description:</text>
                        <box borderStyle="single" borderColor="#333333" padding={1} marginTop={1} flexGrow={1}>
                          <text style={{ textColor: "white" }}>
                            {currentItem.agent.description || "No description provided."}
                          </text>
                        </box>
                      </box>
                    </box>
                  )}

                  {/* TAB 2: NAMING CONVENTION */}
                  {inspectorTab === "naming" && (
                    <box flexDirection="column" marginTop={1} flexGrow={1}>
                      {(() => {
                        const analysis = analyzeAgentName(currentItem.agent.filename, allAgentFilenames)
                        return (
                          <box flexDirection="column" borderStyle="single" borderColor="#333333" padding={1} flexGrow={1}>
                            <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
                              <text style={{ textColor: "white" }} b>Naming Status:</text>
                              <text style={{ textColor: analysis.isValid ? "green" : "yellow" }} b>
                                {analysis.isValid ? "✓ Valid" : "⚠ Non-Compliant"}
                              </text>
                            </box>
                            <box flexDirection="row" marginTop={1}>
                              <text style={{ textColor: "gray" }} width="35%">Family:</text>
                              <text style={{ textColor: "cyan" }}>{analysis.family || "(none)"}</text>
                            </box>
                            <box flexDirection="row">
                              <text style={{ textColor: "gray" }} width="35%">Category:</text>
                              <text style={{ textColor: "yellow" }}>{analysis.category || "(none)"}</text>
                            </box>
                            <box flexDirection="row">
                              <text style={{ textColor: "gray" }} width="35%">Role:</text>
                              <text style={{ textColor: "white" }}>{analysis.role || "(none)"}</text>
                            </box>
                            {!analysis.isValid && analysis.suggestedName && (
                              <box flexDirection="column" marginTop={1}>
                                <text style={{ textColor: "gray" }}>Suggested Name:</text>
                                <text style={{ textColor: "green" }}>{analysis.suggestedName}</text>
                              </box>
                            )}
                          </box>
                        )
                      })()}
                    </box>
                  )}

                  {/* TAB 3: SECURITY MATRIX & PERMISSION DETAILS */}
                  {inspectorTab === "security" && (
                    <box flexDirection="column" marginTop={1} flexGrow={1}>
                      {(() => {
                        const permSummary = getAgentPermissionSummary(currentItem.agent)
                         const orderCheck = analyzePermissionOrder(currentItem.agent)
                         const perm = currentItem.agent.frontmatter.permission || {}
                         const permissionEntries = Object.entries(perm).filter(([key]) => key !== "task")
                         const permissionPageSize = Math.max(1, maxVisibleItems - 2)

                        return (
                          <box flexDirection="column" borderStyle="single" borderColor="#333333" padding={1} flexGrow={1} overflow="hidden">
                            <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
                              <text style={{ textColor: "white" }} b>Security Matrix:</text>
                              <text style={{ textColor: permSummary.riskLevel === "HIGH" ? "red" : permSummary.riskLevel === "MEDIUM" ? "yellow" : "green" }} b>
                                {`${permSummary.riskLevel} RISK`}
                              </text>
                            </box>

                            {/* Order Error Alert */}
                            {orderCheck.hasOrderError && (
                              <box flexDirection="column" marginTop={1} backgroundColor="#5A1818" padding={1}>
                                <text style={{ textColor: "red" }} b>⚠ PERMISSION ORDER ERROR!</text>
                                <text style={{ textColor: "white" }}>Wildcard "*": "deny" MUST be first.</text>
                                 <text style={{ textColor: "yellow" }} b>[Press Shift+F to Auto-Fix Order]</text>
                              </box>
                            )}

                            {/* Permission Details */}
                            <box flexDirection="column" marginTop={1}>
                              <text style={{ textColor: "yellow" }} b>Frontmatter Permissions:</text>
                              {permissionEntries.slice(graphScrollOffset, graphScrollOffset + permissionPageSize).map(([key, val]) => {
                                let valStr = typeof val === "object" ? JSON.stringify(val) : String(val)
                                const isDanger = key === "bash" && (val === "allow" || val === true || valStr.includes("allow"))
                                return (
                                  <box key={key} flexDirection="row" justifyContent="space-between">
                                    <text style={{ textColor: "gray" }}>{`${key}:`}</text>
                                    <text style={{ textColor: isDanger ? "red" : "cyan" }}>{valStr}</text>
                                  </box>
                                )
                              })}
                              {permissionEntries.length > permissionPageSize && <text style={{ textColor: "gray" }} flexShrink={0}>
                                {`▲ ${graphScrollOffset + 1}-${Math.min(graphScrollOffset + permissionPageSize, permissionEntries.length)}/${permissionEntries.length} ▼`}
                              </text>}
                            </box>
                          </box>
                        )
                      })()}
                    </box>
                  )}

                  {/* TAB 4: DELEGATIONS GRAPH (SCROLLABLE) */}
                  {inspectorTab === "delegations" && (
                    <box flexDirection="column" marginTop={1} flexGrow={1}>
                      {(() => {
                        const allowed = currentItem.agent.allowedSubagents || []
                        return (
                          <box flexDirection="column" flexGrow={1}>
                            <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
                              <text style={{ textColor: "gray" }}>Authorized Subagents:</text>
                              <text style={{ textColor: "yellow" }}>{`${allowed.length} total`}</text>
                            </box>

                            <box borderStyle="single" borderColor="#333333" padding={1} marginTop={1} flexGrow={1} overflow="hidden">
                              {allowed.length > 0 ? (
                                allowed.slice(graphScrollOffset, graphScrollOffset + Math.max(1, maxVisibleItems - 2)).map((subName) => {
                                  const exists = agents.some((a) => a.filename.replace(/\.md$/, "") === subName)
                                  return (
                                    <box key={subName} flexDirection="row" justifyContent="space-between">
                                      <text style={{ textColor: exists ? "cyan" : "red" }}>
                                        {exists ? `├─ @${subName}` : `├─ ❌ @${subName} (Dead Ref)`}
                                      </text>
                                    </box>
                                  )
                                })
                              ) : (
                                <text style={{ textColor: "gray" }}>No subagents authorized.</text>
                              )}
                              {allowed.length > Math.max(1, maxVisibleItems - 2) && <text style={{ textColor: "gray" }} flexShrink={0}>
                                {`▲ ${graphScrollOffset + 1}-${Math.min(graphScrollOffset + Math.max(1, maxVisibleItems - 2), allowed.length)}/${allowed.length} ▼`}
                              </text>}
                            </box>
                          </box>
                        )
                      })()}
                    </box>
                  )}
                </box>
              ) : (
                           <box flexDirection="column" flexGrow={1} overflow="hidden">
                  <text style={{ textColor: "yellow" }} b>
                    {`📁 Category: ${currentItem.category.toUpperCase()}`}
                  </text>
                  <text style={{ textColor: "white" }} marginTop={1}>
                    {`Directory: /categories/${currentItem.category}/agents/`}
                  </text>
                  <text style={{ textColor: "gray" }} marginTop={2}>
                    Purpose Summary:
                  </text>
                  <box borderStyle="single" borderColor="#333333" padding={1} marginTop={1} flexGrow={1}>
                    <text style={{ textColor: "white" }}>
                      {CATEGORY_DESCRIPTIONS[currentItem.category] || "Specific compilation pipeline folder."}
                    </text>
                  </box>
                </box>
              )}
            </box>
          ) : (
            <box flexGrow={1} justifyContent="center" alignItems="center">
              <text style={{ textColor: "yellow" }}>Select an item to inspect details</text>
            </box>
          )}

          {/* Action Guide */}
          <box
            flexDirection="column"
            borderStyle="single"
            borderColor="#2B5581"
            paddingLeft={1}
            paddingRight={1}
            marginTop={1}
          >
            <text style={{ textColor: "white" }} b>KEYBOARD COMMANDS:</text>
            <text style={{ textColor: "#E1E4E8" }}>[SPACE] Select/Unselect</text>
            <text style={{ textColor: "#E1E4E8" }}>[A]     Select All Scope</text>
            <text style={{ textColor: "#E1E4E8" }}>[M]     Change Model</text>
            <text style={{ textColor: "#E1E4E8" }}>[C]     Change Color</text>
            <text style={{ textColor: "#E1E4E8" }}>[P]     Safety Presets</text>
            <text style={{ textColor: "#E1E4E8" }}>[G]     Delegation Graph</text>
            <text style={{ textColor: "#E1E4E8" }}>[T]     Tune Parameters</text>
            <text style={{ textColor: "#E1E4E8" }}>[I]     Import OpenCode</text>
            <text style={{ textColor: "#E1E4E8" }}>[R]     Rename Agent</text>
            <text style={{ textColor: "#E1E4E8" }}>[E]     Export OpenCode</text>
            <text style={{ textColor: "#E1E4E8" }}>[F]     Fork Category</text>
            <text style={{ textColor: "#E1E4E8" }}>[TAB]   Flat/Tree View</text>
          </box>
        </box>
      </box>

      {/* Modal - Permission Presets */}
      {viewMode === "permission-preset" && (
        <box
          style={{
            position: "absolute",
            left: "15%",
            top: "15%",
            width: "70%",
            height: "70%"
          }}
          borderStyle="double"
          borderColor="#E74C3C"
          backgroundColor="#1e1e1e"
          title=" Apply Safety Preset "
          titleColor="#E74C3C"
          padding={1}
          flexDirection="column"
          justifyContent="space-between"
        >
          <box flexDirection="column">
            <text style={{ textColor: "white" }} paddingBottom={1}>
              Select safety preset to apply to {selectedAgentPaths.size > 0 ? selectedAgentPaths.size : 1} agents:
            </text>
            <box flexDirection="column" marginTop={1}>
              {SAFETY_PRESETS.map((preset, idx) => {
                const isFocused = idx === focusedPresetIndex
                return (
                  <box
                    key={preset.key}
                    backgroundColor={isFocused ? "#2B5581" : "transparent"}
                    padding={1}
                    flexDirection="column"
                    marginTop={idx > 0 ? 1 : 0}
                  >
                    <text style={{ textColor: isFocused ? "#FFFFFF" : "yellow" }} b>
                      {isFocused ? `► ${preset.name}` : `  ${preset.name}`}
                    </text>
                    <text style={{ textColor: "#E1E4E8" }}>
                      {`   ${preset.description}`}
                    </text>
                  </box>
                )
              })}
            </box>
          </box>

          <box justifyContent="space-between" borderStyle="single" border={["top"]} borderColor="#333333" paddingTop={1} flexShrink={0}>
            <text style={{ textColor: "gray" }}>[↑/↓] Select Preset | [ENTER] Apply to Selected</text>
            <text style={{ textColor: "red" }} b>[ESC] Cancel</text>
          </box>
        </box>
      )}

      {/* Modal - Subagent Delegation Manager */}
      {viewMode === "delegation-manager" && delegationTargetAgent && (
        <box
          style={{
            position: "absolute",
            left: "12%",
            top: "12%",
            width: "76%",
            height: "76%"
          }}
          borderStyle="double"
          borderColor="#3498DB"
          backgroundColor="#1e1e1e"
          title={` Delegation Manager: ${delegationTargetAgent.filename} `}
          titleColor="#3498DB"
          padding={1}
          flexDirection="column"
          justifyContent="space-between"
        >
          <box flexDirection="column" flexGrow={1} overflow="hidden">
            <text style={{ textColor: "white" }} flexShrink={0}>
              Toggle subagents authorized for invocation via permission.task:
            </text>

            <box flexDirection="column" marginTop={1} flexGrow={1} overflow="hidden">
              {visibleDelegationItems.map((ag) => {
                const idx = delegationItems.indexOf(ag)
                const subName = ag.filename.replace(/\.md$/, "")
                const isSelected = selectedDelegations.has(subName)
                const isFocused = idx === focusedDelegationIndex

                return (
                  <box
                    key={ag.currentPath}
                    backgroundColor={isFocused ? "#2B5581" : "transparent"}
                    paddingLeft={1}
                    height={1}
                    flexDirection="row"
                  >
                    <text style={{ textColor: isSelected ? "green" : "gray" }} width="8%">
                      {isSelected ? "[x]" : "[ ]"}
                    </text>
                    <text style={{ textColor: isFocused ? "#FFFFFF" : "#9ECBFF" }} width="50%">
                      {ag.filename}
                    </text>
                    <text style={{ textColor: "yellow" }} width="20%">
                      {ag.category}
                    </text>
                    <text style={{ textColor: "gray" }} width="22%">
                      {ag.model.split("/").pop()}
                    </text>
                  </box>
                )
              })}
            </box>
          </box>

           <box justifyContent="space-between" borderStyle="single" border={["top"]} borderColor="#333333" paddingTop={1} flexShrink={0}>
            {delegationItems.length > maxVisibleItems && <text style={{ textColor: "gray" }} flexShrink={0}>
              {`▲ ${delegationScrollOffset + 1}-${Math.min(delegationScrollOffset + maxVisibleItems, delegationItems.length)}/${delegationItems.length} ▼`}
            </text>}
            <text style={{ textColor: "gray" }}>[↑/↓] Navigate | [SPACE] Toggle | [ENTER] Save</text>
            <text style={{ textColor: "red" }} b>[ESC] Cancel</text>
          </box>
        </box>
      )}

      {/* Modal - Parameter Tuning */}
      {viewMode === "parameter-tuning" && (
        <box
          style={{
            position: "absolute",
            left: "15%",
            top: "15%",
            width: "70%",
            height: "70%"
          }}
          borderStyle="double"
          borderColor="#F1C40F"
          backgroundColor="#1e1e1e"
           title={` Tune Agent Parameters (${tuningTargetPaths.length} agents) `}
          titleColor="#F1C40F"
          padding={1}
          flexDirection="column"
          justifyContent="space-between"
        >
          <box flexDirection="column" gap={1}>
            <text style={{ textColor: "white" }}>
              Regulate execution limits, temperature, mode, and visibility:
            </text>

            {/* Steps field */}
            <box
              flexDirection="row"
              borderStyle="single"
              borderColor={tuningFocusedField === "steps" ? "#F1C40F" : "#333333"}
              paddingLeft={1}
              paddingRight={1}
              marginTop={1}
            >
              <text style={{ textColor: tuningFocusedField === "steps" ? "#F1C40F" : "gray" }} b>
                {tuningFocusedField === "steps" ? "► 1. Max Agentic Steps (e.g. 50):" : "  1. Max Agentic Steps:"}
              </text>
              <text style={{ textColor: "white" }}>{tuningSteps || "50"}</text>
            </box>

            {/* Temp field */}
            <box
              flexDirection={bridgeFocusedField === "name" ? "column" : "row"}
              borderStyle="single"
              borderColor={tuningFocusedField === "temp" ? "#F1C40F" : "#333333"}
              paddingLeft={1}
              paddingRight={1}
            >
              <text style={{ textColor: tuningFocusedField === "temp" ? "#F1C40F" : "gray" }} b>
                {tuningFocusedField === "temp" ? "► 2. Temperature (e.g. 0.1 - 0.7):" : "  2. Temperature:"}
              </text>
              <text style={{ textColor: "white" }}>{tuningTemp || "0.2"}</text>
            </box>

            {/* Mode field */}
            <box
              flexDirection={bridgeFocusedField === "name" ? "column" : "row"}
              borderStyle="single"
              borderColor={tuningFocusedField === "mode" ? "#F1C40F" : "#333333"}
              paddingLeft={1}
              paddingRight={1}
            >
              <text style={{ textColor: tuningFocusedField === "mode" ? "#F1C40F" : "gray" }} b>
                {tuningFocusedField === "mode" ? "► 3. Mode (Press SPACE to toggle):" : "  3. Mode:"}
              </text>
              <text style={{ textColor: "yellow" }}>{tuningMode.toUpperCase()} (primary: Tab switch | subagent: @ mention)</text>
            </box>

            {/* Hidden field */}
            <box
              flexDirection="column"
              borderStyle="single"
              borderColor={tuningFocusedField === "hidden" ? "#F1C40F" : "#333333"}
              paddingLeft={1}
              paddingRight={1}
            >
              <text style={{ textColor: tuningFocusedField === "hidden" ? "#F1C40F" : "gray" }} b>
                {tuningFocusedField === "hidden" ? "► 4. Hidden Status (Press SPACE to toggle):" : "  4. Hidden Status:"}
              </text>
              <text style={{ textColor: tuningHidden ? "red" : "green" }}>{tuningHidden ? "TRUE (Hidden in UI)" : "FALSE (Visible in UI)"}</text>
            </box>
          </box>

          <box justifyContent="space-between" borderStyle="single" border={["top"]} borderColor="#333333" paddingTop={1}>
            <text style={{ textColor: "gray" }}>[TAB/↑/↓] Switch Fields | [SPACE] Toggle Mode/Hidden | [ENTER] Save Params</text>
            <text style={{ textColor: "red" }} b>[ESC] Cancel</text>
          </box>
        </box>
      )}

      {/* Modal - Import & Diff Viewer */}
      {viewMode === "import-diff" && (
        <box
          style={{
            position: "absolute",
            left: "10%",
            top: "10%",
            width: "80%",
            height: "80%"
          }}
          borderStyle="double"
          borderColor="#2ECC71"
          backgroundColor="#1e1e1e"
          title=" Two-Way Sync: Import & Diff Viewer "
          titleColor="#2ECC71"
          padding={1}
          flexDirection="column"
          justifyContent="space-between"
        >
          <box flexDirection="column" flexGrow={1} overflow="hidden">
            <text style={{ textColor: "white" }} flexShrink={0}>
              Compare repository files with ~/.config/opencode/agents/:
            </text>

            <box flexDirection="column" marginTop={1} flexGrow={1} overflow="hidden">
              {visibleImportDiffs.map((diff, index) => {
                const idx = importDiffScrollOffset + index
                const isFocused = idx === focusedDiffIndex
                const statusColor = !diff.existsInExport
                  ? "gray"
                  : diff.hasDifferences
                  ? "yellow"
                  : "green"

                const statusText = !diff.existsInExport
                  ? "Not in OpenCode"
                  : diff.hasDifferences
                  ? "⚠ MODIFIED in OpenCode"
                  : "✓ Identical"

                return (
                  <box
                    key={diff.filename}
                    backgroundColor={isFocused ? "#2B5581" : "transparent"}
                    paddingLeft={1}
                    height={1}
                    flexDirection="row"
                  >
                    <text style={{ textColor: statusColor }} width="28%">
                      {statusText}
                    </text>
                    <text style={{ textColor: isFocused ? "#FFFFFF" : "#9ECBFF" }} width="72%">
                      {diff.filename}
                    </text>
                  </box>
                )
              })}
              {importDiffs.length > 0 && <text style={{ textColor: "gray" }} flexShrink={0}>
                {`▲ ${importDiffScrollOffset + 1}-${Math.min(importDiffScrollOffset + visibleImportDiffs.length, importDiffs.length)}/${importDiffs.length} ▼`}
              </text>}
            </box>

            {importDiffs[focusedDiffIndex] && (
              <box flexDirection="column" marginTop={1} borderStyle="single" borderColor="#333333" padding={1} height={6} flexShrink={0} overflow="hidden">
                <text style={{ textColor: "yellow" }} b>Selected File Status:</text>
                <text style={{ textColor: "white" }}>
                  File: {importDiffs[focusedDiffIndex].filename}
                </text>
                <text style={{ textColor: importDiffs[focusedDiffIndex].hasDifferences ? "yellow" : "green" }}>
                  {importDiffs[focusedDiffIndex].hasDifferences ? "Changes detected between repo and OpenCode." : "File matches OpenCode export exactly."}
                </text>
              </box>
            )}
          </box>

          <box justifyContent="space-between" borderStyle="single" border={["top"]} borderColor="#333333" paddingTop={1}>
            <text style={{ textColor: "gray" }}>[↑/↓] Navigate Diff | [ENTER] Pull / Import All from OpenCode</text>
            <text style={{ textColor: "red" }} b>[ESC] Cancel</text>
          </box>
        </box>
      )}

      {/* Modal - Rename Assistant */}
      {viewMode === "rename-prompt" && renameTargetAgent && (
        <box
          style={{
            position: "absolute",
            left: "15%",
            top: "15%",
            width: "70%",
            height: "70%"
          }}
          borderStyle="double"
          borderColor="#9B59B6"
          backgroundColor="#1e1e1e"
          title=" Rename Agent (Naming Convention) "
          titleColor="#9B59B6"
          padding={1}
          flexDirection="column"
          justifyContent="space-between"
        >
          <box flexDirection="column" gap={1}>
            <box flexDirection="row">
              <text style={{ textColor: "white" }} b>CURRENT FILE: </text>
              <text style={{ textColor: "yellow" }} b>{renameTargetAgent.filename}</text>
            </box>
            <text style={{ textColor: "gray" }}>
              Convention: [family-]category-role_with_underscores.md
            </text>

            {/* Family Field */}
            <box
              flexDirection="column"
              borderStyle="single"
              borderColor={renameFocusedField === "family" ? "#9B59B6" : "#333333"}
              paddingLeft={1}
              paddingRight={1}
              marginTop={1}
            >
              <text style={{ textColor: renameFocusedField === "family" ? "#9B59B6" : "gray" }} b>
                {renameFocusedField === "family" ? "► 1. Family (Optional):" : "  1. Family (Optional):"}
              </text>
              <text style={{ textColor: "white" }}>
                {renameFamily || "[ e.g. copilot, go, kimi or leave empty ]"}
              </text>
            </box>

            {/* Category Field */}
            <box
              flexDirection="column"
              borderStyle="single"
              borderColor={renameFocusedField === "category" ? "#9B59B6" : "#333333"}
              paddingLeft={1}
              paddingRight={1}
            >
              <text style={{ textColor: renameFocusedField === "category" ? "#9B59B6" : "gray" }} b>
                {renameFocusedField === "category" ? "► 2. Category (Required):" : "  2. Category (Required):"}
              </text>
              <text style={{ textColor: "white" }}>
                {renameCategory || "[ e.g. pipeline, wiki, slides, docs, general ]"}
              </text>
            </box>

            {/* Role Field */}
            <box
              flexDirection="column"
              borderStyle="single"
              borderColor={renameFocusedField === "role" ? "#9B59B6" : "#333333"}
              paddingLeft={1}
              paddingRight={1}
            >
              <text style={{ textColor: renameFocusedField === "role" ? "#9B59B6" : "gray" }} b>
                {renameFocusedField === "role" ? "► 3. Role (Required, '_' for multi-word):" : "  3. Role (Required, '_' for multi-word):"}
              </text>
              <text style={{ textColor: "white" }}>
                {renameRole || "[ e.g. code_reviewer, orchestrator, html_writer ]"}
              </text>
            </box>

            {/* Live Preview */}
            <box flexDirection="column" marginTop={1} borderStyle="single" borderColor="#2B5581" padding={1}>
              <text style={{ textColor: "gray" }}>Live Preview Filename:</text>
              <text style={{ textColor: "green" }} b>
                {(() => {
                  const cleanRole = (renameRole || "role").trim().replace(/\s+/g, "_").replace(/-/g, "_")
                  const cleanCategory = (renameCategory || "category").trim()
                  const cleanFamily = renameFamily.trim()
                  return cleanFamily
                    ? `${cleanFamily}-${cleanCategory}-${cleanRole}.md`
                    : `${cleanCategory}-${cleanRole}.md`
                })()}
              </text>
            </box>
          </box>

          <box justifyContent="space-between" borderStyle="single" border={["top"]} borderColor="#333333" paddingTop={1}>
            <text style={{ textColor: "gray" }}>
              [TAB/↑/↓] Switch Fields | [ENTER] Confirm Rename
            </text>
            <text style={{ textColor: "red" }} b>
              [ESC] Cancel
            </text>
          </box>
        </box>
      )}

      {/* Modal - Model Selection */}
      {viewMode === "model-selector" && (
        <box
          style={{
            position: "absolute",
            left: "15%",
            top: "15%",
            width: "70%",
            height: "70%"
          }}
          borderStyle="double"
          borderColor="#00AAFF"
          backgroundColor="#1e1e1e"
          title=" Select LLM Model "
          titleColor="#00AAFF"
          padding={1}
          flexDirection="column"
          overflow="hidden"
        >
          <text style={{ textColor: "white" }} paddingBottom={1} flexShrink={0}>
            Choose model to apply to {selectedAgentPaths.size} selected agents:
          </text>

          <box flexGrow={1} flexDirection="column" marginTop={1} overflow="hidden">
            {visibleModels.map((item, index) => {
              const globalIndex = modelScrollOffset + index
              const isFocused = globalIndex === focusedModelIndex
              const rowBg = isFocused ? "#00AAFF" : "transparent"
              
              const textColor = isFocused
                ? "#FFFFFF"
                : item.type === "provider"
                ? "yellow"
                : "#E1E4E8"

              return (
                <box
                  key={`${item.type}-${item.id}`}
                  backgroundColor={rowBg}
                  paddingLeft={2}
                  height={1}
                  width="100%"
                >
                  <text style={{ textColor }}>
                    {isFocused && item.type === "model" ? `> ${item.label.trim()}` : item.label}
                  </text>
                </box>
              )
            })}
          </box>

          <box flexDirection="column" borderStyle="single" border={["top"]} borderColor="#333333" paddingTop={1}>
            <text style={{ textColor: "gray" }}>
              Total: {modelTreeItems.length} | Scroll: {focusedModelIndex + 1}/{modelTreeItems.length}
            </text>
            <text style={{ textColor: "gray" }}>
              [ENTER/RETURN] Confirm | [ESC] Cancel
            </text>
          </box>
        </box>
      )}

      {/* Modal - Color Selection */}
      {viewMode === "tier-selector" && translationConfig && (() => {
        const tiers = Object.keys(translationConfig.tiers)
        const targets = selectedAgentPaths.size > 0 ? agents.filter(a => selectedAgentPaths.has(a.currentPath)) : (activeItems[focusedIndex]?.agent ? [activeItems[focusedIndex].agent!] : [])
        const states = targets.map(a => resolvedAgents.get(a.currentPath)).filter((state): state is ReturnType<typeof resolveModelTarget> => Boolean(state))
        const current = new Set(states.map(s => `${s!.tier} (${s!.source})`))
        return <box style={{ position: "absolute", left: "15%", top: "5%", width: "70%", height: "90%" }} borderStyle="double" borderColor="magenta" backgroundColor="#1e1e1e" title=" Assign Tier " titleColor="magenta" padding={1} flexDirection="column" overflow="hidden">
          <text style={{ textColor: "yellow" }} flexShrink={0}>Role-based assignment: basename, not an individual file.</text>
          <text style={{ textColor: "white" }} flexShrink={0}>Current: {current.size > 1 ? `multiple tiers - ${Array.from(current).join(", ")}` : Array.from(current)[0] || "unknown"}</text>
          <box flexGrow={1} flexDirection="column" overflow="hidden">
            {tiers.slice(tierScrollOffset, tierScrollOffset + maxVisibleTiers).map((tier, index) => {
              const tierIndex = tierScrollOffset + index
              const isFocused = tierIndex === focusedTierIndex
              const tierConfig = translationConfig.tiers[tier]
              return (
                <box key={tier} flexDirection="column" flexShrink={0}>
                  <box height={1} backgroundColor={isFocused ? "magenta" : "transparent"}>
                    <text style={{ textColor: isFocused ? "white" : "cyan" }}>
                      {tier} - Claude: {tierConfig.claude.model} | Codex: {tierConfig.codex.model}
                    </text>
                  </box>
                  {isFocused && tierConfig.description && <text style={{ textColor: "gray" }}>{tierConfig.description}</text>}
                </box>
              )
            })}
          </box>
          <text style={{ textColor: "gray" }} flexShrink={0}>[UP/DOWN/j/k] Select | [ENTER] Assign | [ESC] Cancel</text>
        </box>
      })()}

      {/* Modal - Color Selection */}
      {viewMode === "color-selector" && (
        <box
          style={{
            position: "absolute",
            left: "15%",
            top: "15%",
            width: "70%",
            height: "70%"
          }}
          borderStyle="double"
          borderColor="#E84393"
          backgroundColor="#1e1e1e"
          title=" Select Agent Color "
          titleColor="#E84393"
          padding={1}
          flexDirection="column"
        >
          <text style={{ textColor: "white" }} paddingBottom={1}>
            Choose color to apply to {selectedAgentPaths.size} selected agents:
          </text>

          <box flexGrow={1} flexDirection="column" marginTop={1}>
            {visibleColors.map((item, index) => {
              const globalIndex = colorScrollOffset + index
              const isFocused = globalIndex === focusedColorIndex

              if (item.type === "group") {
                const rowBg = isFocused ? "#444444" : "transparent"
                return (
                  <box
                    key={`group-${item.id}`}
                    backgroundColor={rowBg}
                    paddingLeft={2}
                    height={1}
                    width="100%"
                  >
                    <text style={{ textColor: isFocused ? "#FFFFFF" : "yellow" }}>
                      {item.label}
                    </text>
                  </box>
                )
              }

              // Color item — show colored swatch preview
              const rowBg = isFocused ? item.hex : "transparent"
              const textCol = isFocused ? "#FFFFFF" : "#E1E4E8"

              return (
                <box
                  key={`color-${item.id}`}
                  backgroundColor={rowBg}
                  paddingLeft={2}
                  height={1}
                  width="100%"
                  flexDirection="row"
                >
                  <box width={3} height={1} backgroundColor={item.hex}>
                    <text>{" "}</text>
                  </box>
                  <text style={{ textColor: textCol }}>
                    {isFocused ? ` > ${item.label.trim()}` : `   ${item.label.trim()}`}
                  </text>
                  <text style={{ textColor: "gray" }}>
                    {`  ${item.value}`}
                  </text>
                </box>
              )
            })}
          </box>

          <box justifyContent="space-between" borderStyle="single" border={["top"]} borderColor="#333333" paddingTop={1}>
            <text style={{ textColor: "gray" }}>
              Total: {colorTreeItems.length} | Scroll: {focusedColorIndex + 1}/{colorTreeItems.length}
            </text>
            <text style={{ textColor: "gray" }}>
              [ENTER/RETURN] Confirm | [ESC] Cancel
            </text>
          </box>
        </box>
      )}

      {/* Modal - Reorganization Confirmation */}
      {viewMode === "organization-confirm" && (
        <box
          style={{
            position: "absolute",
            left: "12%",
            top: "20%",
            width: "76%",
            height: "60%"
          }}
          borderStyle="double"
          borderColor="yellow"
          backgroundColor="#1e1e1e"
          title=" Reorganization Confirmation "
          titleColor="yellow"
          padding={1}
          flexDirection="column"
          justifyContent="space-between"
        >
          <box flexDirection="column">
            <text style={{ textColor: "white" }} b>
              AUTO-ORGANIZATION ACTION DETAILS:
            </text>
            <text style={{ textColor: "#E1E4E8" }} marginTop={1}>
              1. A copy of the general/ directory will be saved to backups/
            </text>
            <text style={{ textColor: "#E1E4E8" }}>
              2. Agent files currently in general/agents/ will be categorized by prefix:
            </text>
            <text style={{ textColor: "cyan" }}>
              {"* Copied to subfolder: categories/<category>/agents/"}
            </text>
            <text style={{ textColor: "#E1E4E8" }} marginTop={1}>
              3. The target files' frontmatter will be updated with category metadata.
            </text>
            <text style={{ textColor: "yellow" }} b marginTop={1}>
              Note: Files are copied, not moved. The originals in general/agents remain untouched.
            </text>
          </box>

          <box justifyContent="center" gap={4}>
            <text style={{ textColor: "green" }} b>
              Press [Y] or [ENTER/RETURN] to confirm
            </text>
            <text style={{ textColor: "red" }} b>
              Press [N] or [ESC] to cancel
            </text>
          </box>
        </box>
      )}

      {/* Modal - Fork Category Prompt */}
      {viewMode === "fork-prompt" && (
        <box
          style={{
            position: "absolute",
            left: "15%",
            top: "20%",
            width: "70%",
            height: "55%"
          }}
          borderStyle="double"
          borderColor="cyan"
          backgroundColor="#1e1e1e"
          title=" Fork Category Folder "
          titleColor="cyan"
          padding={1}
          flexDirection="column"
          justifyContent="space-between"
        >
          <box flexDirection="column" gap={1}>
            <box flexDirection="row">
              <text style={{ textColor: "white" }} b>FORK CATEGORY: </text>
              <text style={{ textColor: "yellow" }} b>{forkSourceCategory.toUpperCase()}</text>
            </box>
            <text style={{ textColor: "gray" }} marginTop={1}>
              Copy agents in this category and perform search-and-replace on filenames and content.
            </text>

            {/* Find field */}
            <box
              flexDirection="column"
              borderStyle="single"
              borderColor={forkFocusedField === "find" ? "cyan" : "#333333"}
              paddingLeft={1}
              paddingRight={1}
              marginTop={1}
            >
              <text style={{ textColor: forkFocusedField === "find" ? "cyan" : "gray" }} b>
                {forkFocusedField === "find" ? "► Find String Pattern:" : "  Find String Pattern:"}
              </text>
              <text style={{ textColor: "white" }}>
                {forkFindQuery || "[ Type pattern to search, e.g. copilot- ]"}
              </text>
            </box>

            {/* Replace field */}
            <box
              flexDirection="column"
              borderStyle="single"
              borderColor={forkFocusedField === "replace" ? "cyan" : "#333333"}
              paddingLeft={1}
              paddingRight={1}
              marginTop={1}
            >
              <text style={{ textColor: forkFocusedField === "replace" ? "cyan" : "gray" }} b>
                {forkFocusedField === "replace" ? "► Replace With String:" : "  Replace With String:"}
              </text>
              <text style={{ textColor: "white" }}>
                {forkReplaceQuery || "[ Type replacement string, e.g. go- ]"}
              </text>
            </box>
          </box>

          <box justifyContent="space-between" borderStyle="single" border={["top"]} borderColor="#333333" paddingTop={1}>
            <text style={{ textColor: "gray" }}>
              [TAB] Switch Fields | [ENTER] Execute Fork
            </text>
            <text style={{ textColor: "red" }} b>
              [ESC] Cancel
            </text>
          </box>
        </box>
      )}

      {/* Modal - Bridge to Claude Code */}
      {viewMode === "bridge-prompt" && (
        <box
          style={{
             position: "absolute",
             left: "15%",
             top: "5%",
             width: "70%",
             height: "90%"
          }}
          borderStyle="double"
          borderColor={bridgeTarget === "codex" ? "#00AAFF" : "#FF6B35"}
          backgroundColor="#1e1e1e"
          title={` Bridge to ${bridgeTarget === "codex" ? "Codex" : "Claude Code"} `}
          titleColor={bridgeTarget === "codex" ? "#00AAFF" : "#FF6B35"}
          padding={1}
          flexDirection="column"
          justifyContent="space-between"
          overflow="hidden"
        >
          <box flexDirection="column" gap={0} flexShrink={1} overflow="hidden">
            <box flexDirection="row" flexShrink={0}>
              <text style={{ textColor: "white" }} b>BRIDGE TO {bridgeTarget === "codex" ? "CODEX" : "CLAUDE CODE"} </text>
              <text style={{ textColor: bridgeTarget === "codex" ? "#00AAFF" : "#FF6B35" }} b>
                OpenCode → {bridgeTarget === "codex" ? "Codex Translation Layer" : "Claude Code Plugin"}
              </text>
            </box>
            <text style={{ textColor: "gray" }} marginTop={1} flexShrink={0}>
              {bridgeTarget === "codex"
                ? "Generate a Codex plugin manifest and project-scoped agents with configurable Sol/Luna mapping."
                : "Convert agents to a Claude Code plugin with deterministic field mapping."}
            </text>

            {/* Plugin Name field */}
            <box
              flexDirection="column"
              borderStyle="single"
              borderColor={bridgeFocusedField === "name" ? (bridgeTarget === "codex" ? "#00AAFF" : "#FF6B35") : "#333333"}
              paddingLeft={1}
              paddingRight={1}
              marginTop={1}
              flexShrink={0}
            >
              <text width={bridgeFocusedField === "name" ? undefined : "30%"} flexShrink={0} style={{ textColor: bridgeFocusedField === "name" ? (bridgeTarget === "codex" ? "#00AAFF" : "#FF6B35") : "gray" }} b>
                {bridgeFocusedField === "name" ? "► Plugin Name:" : "  Plugin Name:"}
              </text>
          <input width={bridgeFocusedField === "name" ? undefined : "70%"} value={bridgePluginName} placeholder="e.g. decent-pipeline" focused={bridgeFocusedField === "name"} onInput={setBridgePluginName} onSubmit={generateBridge} />
              {bridgeFocusedField === "name" && <text flexShrink={0} style={{ textColor: "gray" }}>Output plugin or translation-layer name.</text>}
            </box>

            {/* Prefix to Strip field */}
            <box
              flexDirection={bridgeFocusedField === "prefix" ? "column" : "row"}
              borderStyle="single"
              borderColor={bridgeFocusedField === "prefix" ? (bridgeTarget === "codex" ? "#00AAFF" : "#FF6B35") : "#333333"}
              paddingLeft={1}
              paddingRight={1}
              marginTop={1}
              flexShrink={0}
            >
              <text width="30%" flexShrink={0} style={{ textColor: bridgeFocusedField === "prefix" ? (bridgeTarget === "codex" ? "#00AAFF" : "#FF6B35") : "gray" }} b>
                {bridgeFocusedField === "prefix" ? "► Prefix to Strip:" : "  Prefix to Strip:"}
              </text>
              <input width="70%" value={bridgePipelinePrefix} placeholder="empty = include all" focused={bridgeFocusedField === "prefix"} onInput={(value) => { setBridgePipelinePrefix(value); setBridgeSuggestionIndex(0); setBridgeSuggestionScrollOffset(0) }} onSubmit={generateBridge} />
              {bridgeFocusedField === "prefix" && <text flexShrink={0} style={{ textColor: "gray" }}>Includes matching agents and removes this prefix from generated names.</text>}
                {bridgeFocusedField === "prefix" && <box borderStyle="single" borderColor="#444444" width="100%" flexDirection="column" paddingLeft={1} paddingRight={1} flexShrink={0} overflow="hidden">
                <text flexShrink={0} style={{ textColor: "gray" }}>Suggestions (↑/↓, TAB selects):</text>
                {filteredBridgePrefixSuggestions.slice(bridgeSuggestionScrollOffset, bridgeSuggestionScrollOffset + 5).map(({ prefix, count }, index) => {
                  const globalIndex = bridgeSuggestionScrollOffset + index
                  return (
                  <text key={prefix || "all"} flexShrink={0} style={{ textColor: globalIndex === bridgeSuggestionIndex ? "yellow" : "gray" }}>
                    {globalIndex === bridgeSuggestionIndex ? "► " : "  "}{prefix || "(empty)"}  ({count} agents)
                  </text>
                  )
                })}
               </box>}
            </box>

            {/* Source directory field */}
            <box
              flexDirection={bridgeFocusedField === "sourceDir" ? "column" : "row"}
              borderStyle="single"
              borderColor={bridgeFocusedField === "sourceDir" ? (bridgeTarget === "codex" ? "#00AAFF" : "#FF6B35") : "#333333"}
              paddingLeft={1}
              paddingRight={1}
              marginTop={1}
              flexShrink={0}
            >
              <text width="30%" flexShrink={0} style={{ textColor: bridgeFocusedField === "sourceDir" ? (bridgeTarget === "codex" ? "#00AAFF" : "#FF6B35") : "gray" }} b>
                {bridgeFocusedField === "sourceDir" ? "► Source Directory:" : "  Source Directory:"}
              </text>
              <input width="50%" value={bridgeSourceDir} placeholder="e.g. general" focused={bridgeFocusedField === "sourceDir"} onInput={setBridgeSourceDir} onSubmit={generateBridge} />
              <text width="20%" flexShrink={0} style={{ textColor: bridgeSourceValidation.valid ? "green" : "red" }}>
                {bridgeSourceValidation.valid ? `✓ ${bridgeSourceValidation.count} agents found` : "✗ invalid path"}
              </text>
              {bridgeFocusedField === "sourceDir" && <text flexShrink={0} style={{ textColor: "gray" }}>Workspace-relative folder containing agent files.</text>}
            </box>

            {/* Info */}
            <box marginTop={1} flexDirection="column">
              <text flexShrink={0} style={{ textColor: "gray" }}>
                {`Source: ${selectedAgentPaths.size > 0 ? `${selectedAgentPaths.size} selected agents` : `all agents in focused category`}`}
              </text>
              <text flexShrink={0} style={{ textColor: "gray" }}>
                {`Output: bridges/${bridgeTarget === "codex" ? "codex" : "claude-code"}/${bridgePluginName || "..."}/`}
              </text>
            </box>
          </box>

          <box flexDirection="column" borderStyle="single" border={["top"]} borderColor="#333333" paddingTop={1} flexShrink={0} overflow="hidden">
            <text flexShrink={0} style={{ textColor: "gray" }}>
             Target: {bridgeTarget === "codex" ? "Codex" : "Claude Code"} | main b/B
            </text>
            <text flexShrink={0} style={{ textColor: "red" }} b>
               Field: {bridgeFocusedField} | TAB next | ENTER generate | ESC
            </text>
          </box>
        </box>
      )}

      {/* Modal - Export Confirmation */}
      {viewMode === "export-confirm" && (
        <box
          style={{
            position: "absolute",
            left: "12%",
            top: "20%",
            width: "76%",
            height: "60%"
          }}
          borderStyle="double"
          borderColor="#00CC66"
          backgroundColor="#1e1e1e"
          title=" Export to OpenCode "
          titleColor="#00CC66"
          padding={1}
          flexDirection="column"
          justifyContent="space-between"
        >
          <box flexDirection="column">
            <text style={{ textColor: "white" }} b>
              EXPORT AGENTS TO OPENCODE CONFIG:
            </text>
            <text style={{ textColor: "#E1E4E8" }} marginTop={1}>
              {selectedAgentPaths.size > 0
                ? `1. ${selectedAgentPaths.size} selected agents will be exported.`
                : `1. All ${agents.length} agents will be exported.`}
            </text>
            <text style={{ textColor: "#E1E4E8" }}>
              {`2. Destination: ${getExportDestination().replace(/\/Users\/[^\/]+/, "~")}`}
            </text>
            <text style={{ textColor: "cyan" }}>
              {"3. Files are FULLY OVERWRITTEN (including model field)."}
            </text>
            <text style={{ textColor: "yellow" }} b marginTop={1}>
              {"⚠ Disaster-recovery backup:"}
            </text>
            <text style={{ textColor: "#E1E4E8" }}>
              {"  A single backup of the destination folder will be created at"}
            </text>
            <text style={{ textColor: "#E1E4E8" }}>
              {"  ~/.config/opencode/agents_backup/ (overwritten each export)."}
            </text>
          </box>

          <box justifyContent="center" gap={4}>
            <text style={{ textColor: "green" }} b>
              Press [Y] or [ENTER/RETURN] to confirm
            </text>
            <text style={{ textColor: "red" }} b>
              Press [N] or [ESC] to cancel
            </text>
          </box>
        </box>
      )}

      {/* Modal - Action Result */}
      {viewMode === "action-result" && (
        <box
          style={{
            position: "absolute",
            left: "12%",
            top: "15%",
            width: "76%",
            height: "70%"
          }}
          borderStyle="double"
          borderColor="green"
          backgroundColor="#1e1e1e"
          title={` ${actionResultTitle} `}
          titleColor="green"
          padding={1}
          flexDirection="column"
          overflow="hidden"
        >
          <box flexGrow={1} flexDirection="column" overflow="hidden" flexShrink={1}>
            {visibleActionResultLines.map((line, idx) => (
              <text key={actionResultScrollOffset + idx} style={{ textColor: "white" }} flexShrink={0}>{line}</text>
            ))}
          </box>

          <box justifyContent="center" borderStyle="single" border={["top"]} borderColor="#333333" paddingTop={1} marginTop={1} flexShrink={0} overflow="hidden">
            <text style={{ textColor: "yellow" }} flexShrink={0}>
              {actionResultMaxOffset > 0 ? `▲ ${actionResultScrollOffset + 1}-${Math.min(actionResultLines.length, actionResultScrollOffset + maxVisibleActionResultLines)}/${actionResultLines.length} ▼  ` : ""}
            </text>
            <text style={{ textColor: "green" }} b flexShrink={0}>
              Press [ENTER/RETURN] or [ESC] to continue
            </text>
          </box>
        </box>
      )}
    </box>
  )
}
