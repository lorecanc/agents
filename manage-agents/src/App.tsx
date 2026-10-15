import React, { useState, useEffect, useMemo } from "react"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import {
  findAgentFiles,
  AgentInfo,
  organizeAgents,
  updateAgentsModel,
  repairAgentModels,
  updateAgentsColor,
  forkCategory,
  parseForkReplacements,
  exportAgents,
  getExportDestination,
  analyzeAgentName,
  renameAgent,
  getAgentPermissionSummary,
  SAFETY_PRESETS,
  AGENT_EFFORT_VARIANTS,
  applySafetyPreset,
  updateAgentParams,
  updateAgentDelegations,
  discoverAgentResources,
  updateAgentResourcesAndMcp,
  AgentResourceCatalog,
  AgentResourceChanges,
  AgentResourceItem,
  AgentMcpResourceItem,
  previewImport,
  importAgents,
  AgentDiffResult,
  analyzePermissionOrder,
  fixPermissionOrder,
  type TuningField,
  inspectTuningTargets,
  buildTuningUpdateParams,
  sanitizeFilename,
  getCategoryPrefixes,
  getGlobalOpenCodeConfigPath,
  resolveSourceSubdir,
  resolveCategoriesSubdir
} from "./utils/agents.js"
import { loadModelCatalog, suggestModels, collectInvalidModelGroups, modelDisplayValue, getModelVariants, type ModelCatalog } from "./utils/models.js"
import { discoverAvailableCategoryCompanionItems, getCompanionLinksConfigPath, type SelectableCompanionItem, updateCategoryCompanionLinks } from "./utils/companionLinks.js"
import { applyPipelineProfile, loadPipelineProfiles, syncPipelineProfile, loadStampedPipelineAgents, deleteStampedPipeline } from "./utils/pipelineProfiles.js"
import { bridgeToClaudeCode } from "./utils/bridge.js"
import { bridgeToCodex } from "./utils/codexBridge.js"
import { buildInferenceIndex, loadTranslationConfig, resolveModelTarget, resolveRole, saveTranslationConfig, type TranslationConfig } from "./utils/translationConfig.js"
import { AUTO_COMMIT_MESSAGES, autoCommitEnabled, repositoryTransaction, type TransactionWarning } from "./utils/repositoryTransaction.js"
import { adjustListShare, calculateLayout, calculateListColumnBudget, calculatePanelWidths, resetListShare } from "./utils/layout.js"
import { loadUiConfig, saveUiConfig } from "./utils/uiConfig.js"
import { displayWidth, middleEllipsis, terminalSafeText } from "./utils/terminalText.js"

interface AppProps {
  workspaceRoot: string
  listShare?: number
  uiConfigWarning?: string
  configReadOnly?: boolean
  uiConfigRevision?: string
}

type ViewMode =
  | "main"
  | "model-selector"
  | "repair-selector"
  | "repair-confirm"
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
  | "resource-manager"
  | "parameter-tuning"
  | "import-diff"
  | "layout"
  | "delete-confirm"

interface ActiveItem {
  type: "file" | "folder"
  id: string // filePath for file, category name for folder
  label: string
  category: string
  agent?: AgentInfo
}

interface ResourceManagerRow {
  section: "agent" | "companion"
  kind?: AgentResourceItem["kind"]
  item: AgentResourceItem | AgentMcpResourceItem | SelectableCompanionItem
}

const CATEGORY_DESCRIPTIONS: Record<string, string> = {
  wiki: "Codebase analysis and automatic project wiki page generation & updating.",
  pipeline: "Canonical base pipeline agents (orchestrator, planner, reasoner, executor, tester, reviewer, specialists).",
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

export function App({ workspaceRoot, listShare = 2 / 3, uiConfigWarning, configReadOnly = false, uiConfigRevision = "missing" }: AppProps) {
  const mutate = <T,>(paths: string[], operation: keyof typeof AUTO_COMMIT_MESSAGES, fn: () => T) =>
    repositoryTransaction(workspaceRoot, paths, AUTO_COMMIT_MESSAGES[operation], fn)
  // Data State
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [models, setModels] = useState<string[]>([])
  const [modelCatalog, setModelCatalog] = useState<ModelCatalog>({ status: "unavailable", models: [] })
  const [repairGroupKey, setRepairGroupKey] = useState<string | null>(null)
  const [repairMappings, setRepairMappings] = useState<Record<string, string>>({})
  const [selectedAgentPaths, setSelectedAgentPaths] = useState<Set<string>>(new Set())

  // View Settings
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(
    new Set(["wiki", "pipeline", "go-pipeline", "copilot-pipeline", "general"])
  )
  const [searchQuery, setSearchQuery] = useState("")
  const [isSearching, setIsSearching] = useState(false)

  // Navigation State
  const [focusedIndex, setFocusedIndex] = useState(0)
  const [scrollOffset, setScrollOffset] = useState(0)

  // Modal / Action State
  const [viewMode, setViewMode] = useState<ViewMode>("main")
  const [appliedShare, setAppliedShare] = useState(() => listShare)
  const [layoutDraft, setLayoutDraft] = useState(() => listShare)
  const [layoutSnapshot, setLayoutSnapshot] = useState(() => listShare)
  const [layoutError, setLayoutError] = useState("")
  const [layoutStatus, setLayoutStatus] = useState("")
  const [deleteTargetCategory, setDeleteTargetCategory] = useState<string | null>(null)
  const [deleteAlsoInstalled, setDeleteAlsoInstalled] = useState(false)
  const [uiConfigRevisionState, setUiConfigRevision] = useState(uiConfigRevision)
  const [focusedModelIndex, setFocusedModelIndex] = useState(0)
  const [modelScrollOffset, setModelScrollOffset] = useState(0)
  const [focusedTierIndex, setFocusedTierIndex] = useState(0)
  const [tierScrollOffset, setTierScrollOffset] = useState(0)

  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set())

  const [actionResultTitle, setRawActionResultTitle] = useState("")
  const [actionResultLines, setRawActionResultLines] = useState<string[]>([])
  // Action output may contain paths, command output, parser values, or errors.
  // Sanitize at the state boundary so every result view remains terminal-safe.
  const setActionResultTitle = (value: unknown) => setRawActionResultTitle(terminalSafeText(value))
  const setActionResultLines = (values: unknown[]) => {
    setRawActionResultLines(values.map(terminalSafeText))
  }
  const setMutationSuccess = (title: string, values: unknown[], warning?: TransactionWarning) => {
    const lines = values.map(terminalSafeText)
    setActionResultTitle(title)
    setActionResultLines(warning
      ? [`⚠ AUTO-COMMIT: ${warning.message}`, `  ${warning.recovery}`, "", ...lines]
      : lines)
  }
  const [actionResultScrollOffset, setActionResultScrollOffset] = useState(0)

  // Fork Category State
  const [forkSourceCategory, setForkSourceCategory] = useState("")
  const [forkFindQuery, setForkFindQuery] = useState("")
  const [forkReplaceQuery, setForkReplaceQuery] = useState("")
  const [forkFocusedField, setForkFocusedField] = useState<"find" | "replace" | "profile" | "target">("find")
  const [forkProfileName, setForkProfileName] = useState("")
  const [forkProfileTarget, setForkProfileTarget] = useState("")
  const [exportCategory, setExportCategory] = useState<string | null>(null)

  // Bridge State
  const [bridgePluginName, setBridgePluginName] = useState("")
  const [bridgePipelinePrefix, setBridgePipelinePrefix] = useState("")
  const [bridgeSourceDir, setBridgeSourceDir] = useState(() => resolveSourceSubdir(workspaceRoot))
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

  // Skills, tools, and MCP resource manager state
  const [resourceTargetAgent, setResourceTargetAgent] = useState<AgentInfo | null>(null)
  const [resourceCatalog, setResourceCatalog] = useState<AgentResourceCatalog | null>(null)
  const [resourceModalFocusIndex, setResourceModalFocusIndex] = useState(0)
  const [resourceModalScrollOffset, setResourceModalScrollOffset] = useState(0)
  const [draftSkillAll, setDraftSkillAll] = useState(false)
  const [draftAllowedSkills, setDraftAllowedSkills] = useState<Set<string>>(new Set())
  const [draftPermissions, setDraftPermissions] = useState<Record<string, boolean>>({})
  const [draftMcpEnabled, setDraftMcpEnabled] = useState<Record<string, boolean>>({})
  const [explicitResourcePermissions, setExplicitResourcePermissions] = useState<Set<string>>(new Set())
  const [resourceCategoryTarget, setResourceCategoryTarget] = useState<string | null>(null)
  const [resourceDraftCompanion, setResourceDraftCompanion] = useState<Record<string, boolean>>({})
  const [companionAvailableItems, setCompanionAvailableItems] = useState<SelectableCompanionItem[]>([])

  // Parameter Tuning State
  const [tuningSteps, setTuningSteps] = useState("50")
  const [tuningTemp, setTuningTemp] = useState("0.2")
  const [tuningVariant, setTuningVariant] = useState("")
  const [tuningDirtyFields, setTuningDirtyFields] = useState<Set<TuningField>>(new Set())
  const [tuningMode, setTuningMode] = useState<"subagent" | "primary">("subagent")
  const [tuningHidden, setTuningHidden] = useState(false)
  const [tuningFocusedField, setTuningFocusedField] = useState<"steps" | "temp" | "variant" | "mode" | "hidden">("steps")
  const [tuningTargetPaths, setTuningTargetPaths] = useState<string[]>([])
  const markTuningDirty = (field: TuningField) => setTuningDirtyFields(prev => {
    if (prev.has(field)) return prev
    const next = new Set(prev)
    next.add(field)
    return next
  })

  // Import Diff State
  const [importDiffs, setImportDiffs] = useState<AgentDiffResult[]>([])
  const [focusedDiffIndex, setFocusedDiffIndex] = useState(0)
  const [importDiffScrollOffset, setImportDiffScrollOffset] = useState(0)

  // Inspector Tab State
  const [inspectorTab, setInspectorTab] = useState<"overview" | "naming" | "security" | "delegations" | "resources">("overview")
  const [graphScrollOffset, setGraphScrollOffset] = useState(0)
  const [resourceScrollIndex, setResourceScrollIndex] = useState(0)

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
    try { refreshData() } catch (e) {
      setActionResultTitle("Error Refreshing Agents")
      setActionResultLines([`An error occurred:`, `  ${(e as any)?.message || e}`])
      setViewMode("action-result")
    }
    try {
       const catalog = loadModelCatalog(true)
       setModelCatalog(catalog)
       setModels(catalog.status === "verified" ? catalog.models : [])
    } catch (e) {
      // Ignore
    }
  }, [])

  const invalidModelGroups = useMemo(() => collectInvalidModelGroups(agents, modelCatalog), [agents, modelCatalog])

  // Terminal dimensions are also the source of truth for the main screen budget.
  const { width: termWidth = 80, height: termHeight = 24 } = useTerminalDimensions() || {}
  const statusMessages = [
    uiConfigWarning ? `⚠ ${terminalSafeText(uiConfigWarning)}` : "",
    modelCatalog.status === "unavailable" ? "⚠ Model catalog unavailable — press M, then Y to retry." : "",
    modelCatalog.status === "verified" && invalidModelGroups.length > 0 ? `⚠ ${invalidModelGroups.length} invalid model group(s) — [V] Repair; [M] Choose a model.` : "",
    layoutStatus
  ].filter(Boolean)
  const statusMessage = statusMessages.join(" | ")
  const layout = calculateLayout(termWidth, termHeight, statusMessages.length > 0)
  // Keep the table's integer cell widths independent from percentage rounding.
  const panelWidths = calculatePanelWidths(termWidth, layout.mode, appliedShare)
  const listPanelWidth = panelWidths.list
  const listContentWidth = Math.max(0, listPanelWidth - 4)
  const footerFirstWidth = Math.floor(listContentWidth / 2)
  const footerSecondWidth = Math.max(0, listContentWidth - footerFirstWidth)
  const listColumns = calculateListColumnBudget(listContentWidth, "compact")
  const columnWidth = (index: number) => listColumns.widths[index] || 0
  const gutter = (key: string) => <text key={key} width={listColumns.gutters[0] || 0}> </text>
  const headerTitle = "★ OPENCODE AGENT MANAGER"
  const displayWorkspace = workspaceRoot === os.homedir() || workspaceRoot.startsWith(`${os.homedir()}${path.sep}`)
    ? `~${workspaceRoot.slice(os.homedir().length)}`
    : workspaceRoot
  const fullCommitLabel = `Commit: ${autoCommitEnabled() ? "ON" : "OFF"}`
  const compactCommitLabel = `C:${autoCommitEnabled() ? "ON" : "OFF"}`
  const workspaceLabel = `Workspace: ${displayWorkspace}`
  const headerSeparator = " | "
  const statusMessageWidth = Math.max(1, termWidth - 2)
  const headerContentWidth = Math.max(0, termWidth - 2 - 2 - 4)
  const headerTitleWidth = Math.max(1, Math.min(displayWidth(headerTitle), headerContentWidth - (termWidth >= 40 ? displayWidth(compactCommitLabel) + 1 : 0)))
  const headerMetaWidth = Math.max(0, headerContentWidth - headerTitleWidth - 1)
  const commitLabel = headerMetaWidth >= displayWidth(fullCommitLabel) ? fullCommitLabel : compactCommitLabel
  const commitWidth = displayWidth(commitLabel)
  const separatorWidth = displayWidth(headerSeparator)
  const showCommit = termWidth >= 40 && headerMetaWidth >= commitWidth
  const workspaceWidth = showCommit ? Math.max(0, headerMetaWidth - commitWidth - separatorWidth) : 0
  const visibleWorkspaceWidth = Math.min(workspaceWidth, displayWidth(workspaceLabel))
  const visibleMetaWidth = showCommit ? commitWidth + (visibleWorkspaceWidth > 0 ? separatorWidth + visibleWorkspaceWidth : 0) : 0
  const headerGroupWidth = Math.min(headerContentWidth, headerTitleWidth + 1 + visibleMetaWidth)
  const maxVisibleItems = layout.listRows
  const maxVisibleModels = Math.max(0, Math.floor(termHeight * 0.7) - 10)
  const maxVisibleTiers = Math.max(0, Math.floor(termHeight * 0.9) - 9)
  const maxVisibleColors = Math.max(0, Math.floor(termHeight * 0.7) - 9)
  const maxVisibleActionResultLines = Math.max(0, Math.floor(termHeight * 0.7) - 8)
  const maxVisibleImportDiffs = Math.max(0, Math.floor(termHeight * 0.8) - 14)
  const modelModalInnerWidth = Math.max(1, Math.floor(termWidth * 0.7) - 6)
  const repairConfirmContentWidth = Math.max(1, Math.floor(termWidth * 0.76) - 6)

  const refreshModelCatalog = () => {
    const catalog = loadModelCatalog(undefined, true)
    setModelCatalog(catalog)
    setModels(catalog.status === "verified" ? catalog.models : [])
  }

  useEffect(() => {
    if (viewMode === "action-result") setActionResultScrollOffset(0)
  }, [viewMode, actionResultLines])

  useEffect(() => {
    setGraphScrollOffset(0)
  }, [focusedIndex])

  useEffect(() => {
    setResourceScrollIndex(0)
  }, [focusedIndex, inspectorTab])

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
    const list = findAgentFiles(workspaceRoot)
    const canonicalPaths = new Set(list.map(agent => agent.currentPath))
    const categoriesDir = path.join(workspaceRoot, resolveCategoriesSubdir(workspaceRoot))
    if (fs.existsSync(categoriesDir)) {
      for (const entry of fs.readdirSync(categoriesDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.endsWith("-pipeline")) continue
        const stamped = loadStampedPipelineAgents(workspaceRoot, entry.name)
        if (stamped) list.push(...stamped.agents.filter(agent => !canonicalPaths.has(agent.currentPath)))
      }
    }
    setAgents(list)
  }

  const openResourceManager = (agent: AgentInfo | null, categoryOverride?: string) => {
    const cat = categoryOverride || agent?.category || "general"
    try {
      const compItems = discoverAvailableCategoryCompanionItems(workspaceRoot, cat)
      setResourceCategoryTarget(cat)
      setCompanionAvailableItems(compItems)
      setResourceDraftCompanion(Object.fromEntries(compItems.map(item => [item.relativePath, item.linked])))
      setResourceTargetAgent(agent)
      if (agent) {
        const catalog = discoverAgentResources(workspaceRoot, agent, agents)
        setResourceCatalog(catalog)
        setDraftSkillAll(catalog.skills.find(item => item.kind === "skill-wildcard")?.allowed || false)
        setDraftAllowedSkills(new Set(catalog.skills.filter(item => item.kind === "skill" && item.allowed).map(item => item.name)))
        setDraftPermissions(Object.fromEntries([...catalog.tools, ...catalog.mcpServers].map(item => [item.permissionKey, item.allowed])))
        setExplicitResourcePermissions(new Set(catalog.tools
          .filter(item => item.kind === "tool" && item.familyKey && Object.prototype.hasOwnProperty.call(agent.frontmatter.permission || {}, item.permissionKey))
          .map(item => item.permissionKey)))
        setDraftMcpEnabled(Object.fromEntries(catalog.mcpServers.map(item => [item.serverKey, item.serverEnabled])))
      } else {
        setResourceCatalog({ skills: [], tools: [], mcpServers: [], companionFiles: [], opencodeRawContent: null })
        setDraftSkillAll(false)
        setDraftAllowedSkills(new Set())
        setDraftPermissions({})
        setDraftMcpEnabled({})
        setExplicitResourcePermissions(new Set())
      }
      setResourceModalFocusIndex(0)
      setResourceModalScrollOffset(0)
      setLayoutStatus("")
      setViewMode("resource-manager")
    } catch (error: any) {
      setLayoutStatus(terminalSafeText(error?.message || error))
    }
  }

  const setMutationRefreshFailure = (error: unknown, warning?: TransactionWarning) => {
    setActionResultTitle("Change completed, refresh failed")
    setActionResultLines([
      ...(warning ? [`⚠ AUTO-COMMIT: ${warning.message}`, `  ${warning.recovery}`, ""] : []),
      `An error occurred:`, `  ${(error as any)?.message || error}`
    ])
    setViewMode("action-result")
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
      const outputDir = path.join(workspaceRoot, fs.existsSync(path.join(workspaceRoot, "export")) ? path.join("export", "bridges") : "bridges", bridgeFolder, safePluginName)
       const tx = mutate([path.join(workspaceRoot, ".agent-manager", "translation-config.json"), outputDir], "bridge", () => {
        saveTranslationConfig(workspaceRoot, { ...bridgeConfig, pluginName: bridgePluginName, prefix: bridgePipelinePrefix, sourceDir: bridgeSourceDir })
        return bridgeTarget === "codex"
          ? bridgeToCodex(selectedAgents, bridgePluginName, bridgePipelinePrefix, outputDir, workspaceRoot, { ...bridgeConfig, pluginName: bridgePluginName, prefix: bridgePipelinePrefix, sourceDir: bridgeSourceDir })
          : bridgeToClaudeCode(selectedAgents, bridgePluginName, bridgePipelinePrefix, outputDir, workspaceRoot, { ...bridgeConfig, pluginName: bridgePluginName, prefix: bridgePipelinePrefix, sourceDir: bridgeSourceDir })
      })
       const result = tx.value
       setSelectedAgentPaths(new Set())
      setActionResultTitle(`Bridge to ${bridgeTarget === "codex" ? "Codex" : "Claude Code"} Complete`)
      const lines = [`${bridgeTarget === "codex" ? "Translation layer" : "Plugin"} '${safePluginName}' generated successfully!`, `Output directory:`, `  ${result.pluginDir}`, ``, `Generated ${result.files.length} files:`, ...result.files.map((f) => `  * ${f}`)]
      if (result.warnings.length > 0) lines.push(``, `⚠ Warnings:`, ...result.warnings.map((w) => `  * ${w}`))
      if (result.preview?.length) {
        const counts = result.preview.reduce<Record<string, number>>((acc, item) => { acc[item.source] = (acc[item.source] || 0) + 1; return acc }, {})
        lines.push(``, `Preview summary: ${Object.entries(counts).map(([source, count]) => `${count} by ${source}`).join(", ")}`, ...result.preview.map(item => `  ${item.agent} → ${item.role} → ${item.tier} → ${item.model} → ${item.source}`))
      }
      lines.push(``, ...(bridgeTarget === "codex" ? [`Codex project-scoped agents:`, `  cd ${result.pluginDir} && codex`, ``, `Plugin manifest:`, `  ${result.pluginDir}/.codex-plugin/plugin.json`] : [`Validate and run locally:`, `  claude plugin validate ${result.pluginDir} --strict`, `  claude --plugin-dir ${result.pluginDir} --agent orchestrator`]))
       try { refreshData() } catch (error) { setMutationRefreshFailure(error, tx.warning); setViewMode("action-result"); return }
       setMutationSuccess(`Bridge to ${bridgeTarget === "codex" ? "Codex" : "Claude Code"} Complete`, lines, tx.warning)
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

    return items
  }, [agents, searchQuery, expandedCategories])

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

  useEffect(() => {
    const maxOffset = Math.max(0, activeItems.length - maxVisibleItems)
    setScrollOffset(offset => Math.min(offset, maxOffset))
  }, [activeItems.length, maxVisibleItems])

  // A resize can make the focused row fall below the new viewport. Keep both
  // focus and offset valid whenever the available list height changes.
  useEffect(() => {
    setScrollOffset(offset => {
      const maxOffset = Math.max(0, activeItems.length - maxVisibleItems)
      if (maxVisibleItems <= 0) return 0
      if (focusedIndex < offset) return Math.max(0, focusedIndex)
      if (focusedIndex >= offset + maxVisibleItems) {
        return Math.min(maxOffset, focusedIndex - maxVisibleItems + 1)
      }
      return Math.min(offset, maxOffset)
    })
  }, [maxVisibleItems])

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
    if (viewMode === "repair-selector" && repairGroupKey !== null) {
      const group = invalidModelGroups[Number(repairGroupKey)]
      const suggestions = group ? suggestModels(group.value, modelCatalog) : []
      suggestions.forEach(model => items.push({ type: "model", id: model, label: `★ ${model}`, provider: "suggestions" }))
    }
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
  }, [models, expandedProviders, viewMode, repairGroupKey, invalidModelGroups, modelCatalog])

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
    const isUppercaseF = key === "f" && (e.sequence === "F" || !!e.shift)
    const isUppercaseL = key === "l" && (e.sequence === "L" || !!e.shift)

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

    // Layout modal owns these keys before they can affect the agent tree.
    if (viewMode === "layout") {
      if (key === "left" || key === "h" || key === "down") {
        const next = adjustListShare(layoutDraft, -0.01); setLayoutDraft(next); setAppliedShare(next)
      } else if (key === "right" || (key === "l" && !isUppercaseL) || key === "up") {
        const next = adjustListShare(layoutDraft, 0.01); setLayoutDraft(next); setAppliedShare(next)
      } else if (key === "home") {
        setLayoutDraft(0.60); setAppliedShare(0.60)
      } else if (key === "end") {
        setLayoutDraft(0.75); setAppliedShare(0.75)
      } else if (key === "r") {
        const next = resetListShare(); setLayoutDraft(next); setAppliedShare(next)
      } else if (key === "escape") {
        setLayoutDraft(layoutSnapshot); setAppliedShare(layoutSnapshot); setLayoutError(""); setViewMode("main")
      } else if (key === "enter" || key === "return") {
        if (configReadOnly) {
          setLayoutError("Read-only environment override: preview only; Enter does not save.")
        } else {
          try {
             const revision = saveUiConfig(workspaceRoot, layoutDraft, uiConfigRevisionState)
             setUiConfigRevision(revision)
            setLayoutSnapshot(layoutDraft); setAppliedShare(layoutDraft); setLayoutError(""); setLayoutStatus("Layout saved")
            setActionResultTitle("Layout saved")
            setActionResultLines(["List/inspector proportions saved."])
            setViewMode("main")
          } catch (error: any) {
            if (error?.message === "configuration changed; reload and retry") {
              const current = loadUiConfig(workspaceRoot)
              setUiConfigRevision(current.revision)
              setLayoutStatus("Configuration changed externally. Reloaded revision; press Enter again to overwrite with current preview, or Esc.")
            } else {
              setLayoutError(terminalSafeText(error?.message || error).slice(0, 160))
            }
          }
        }
      }
      return
    }

    // 2. Main view mode
    if (viewMode === "main") {
      if (key === "l" && isUppercaseL) {
        if (!isSearching) { setLayoutSnapshot(appliedShare); setLayoutDraft(appliedShare); setLayoutError(""); setLayoutStatus(""); setViewMode("layout") }
      } else if ((key === "up" || key === "k") && (inspectorTab === "security" || inspectorTab === "delegations") && currentItem?.agent) {
        setGraphScrollOffset((offset) => Math.max(0, offset - 1))
      } else if ((key === "up" || key === "k") && inspectorTab === "resources" && activeItems[focusedIndex]?.agent) {
        setResourceScrollIndex((offset) => Math.max(0, offset - 1))
      } else if ((key === "down" || key === "j") && (inspectorTab === "security" || inspectorTab === "delegations") && currentItem?.agent) {
        const itemCount = inspectorTab === "security"
          ? Object.keys(currentItem.agent.frontmatter.permission || {}).filter((key) => key !== "task").length
          : (currentItem.agent.allowedSubagents || []).length
        setGraphScrollOffset((offset) => Math.min(Math.max(0, itemCount - Math.max(1, maxVisibleItems - 2)), offset + 1))
      } else if ((key === "down" || key === "j") && inspectorTab === "resources" && activeItems[focusedIndex]?.agent) {
        setResourceScrollIndex((offset) => Math.min(Math.max(0, resourceInspectorLines.length - Math.max(1, layout.listRows - 5)), offset + 1))
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
        }
      } else if (key === "s") {
        if (activeItems.length > 0) {
          const item = activeItems[focusedIndex]
          if (item.type === "file" && item.agent) {
            const targetModel = item.agent.model
            const targetCategory = item.category

            const matchingAgents = agents.filter((a) => {
              const modelMatch = a.model === targetModel
              const categoryMatch = a.category === targetCategory
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
      } else if (key === "/") {
        setIsSearching(true)
      } else if (key === "m") {
        if (modelCatalog.status !== "verified") {
          setActionResultTitle("Model Catalog Unavailable")
          setActionResultLines(["Models are not present in the loaded catalog.", "No model writes or suggestions are available.", "Press Y to retry refreshing the model catalog."])
          setViewMode("action-result")
          return
        }
        if (activeItems.length === 0 || (!activeItems[focusedIndex]?.agent && selectedAgentPaths.size === 0)) {
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
      } else if (key === "v") {
        if (modelCatalog.status === "verified" && invalidModelGroups.length > 0) {
          setRepairMappings({})
          setRepairGroupKey("0")
          setFocusedModelIndex(0)
          setModelScrollOffset(0)
          setViewMode("repair-selector")
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
          setForkProfileName("")
          setForkProfileTarget("")
          setForkFocusedField("find")
          setViewMode("fork-prompt")
        }
      } else if (key === "b" && !e.shift) {
        if (activeItems.length > 0) {
          const item = activeItems[focusedIndex]
          const cat = item.category || ""
          setBridgeTarget("claude")
             setBridgePluginName(translationConfig?.pluginName || "decent-pipeline")
             setBridgePipelinePrefix(translationConfig?.prefix || "")
             setBridgeSourceDir(translationConfig?.sourceDir || resolveSourceSubdir(workspaceRoot))
          setBridgeFocusedField("name")
          setViewMode("bridge-prompt")
        }
      } else if (key === "b" && e.shift) {
        if (activeItems.length > 0) {
          const item = activeItems[focusedIndex]
          const cat = item.category || ""
          setBridgeTarget("codex")
            setBridgePluginName(translationConfig?.pluginName || "decent-pipeline")
             setBridgePipelinePrefix(translationConfig?.prefix || "")
             setBridgeSourceDir(translationConfig?.sourceDir || resolveSourceSubdir(workspaceRoot))
          setBridgeFocusedField("name")
          setViewMode("bridge-prompt")
        }
      } else if (key === "e") {
        const focused = activeItems[focusedIndex]
        setExportCategory(selectedAgentPaths.size === 0 && focused?.type === "folder" ? focused.category : null)
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
      } else if (key === "u") {
        const target = activeItems[focusedIndex]
        if (target?.type === "file" && target.agent) openResourceManager(target.agent)
        else if (target?.type === "folder") openResourceManager(null, target.category)
        else setLayoutStatus("Select an agent or category folder to manage resources.")
      } else if (key === "d" && !e.shift) {
        const item = activeItems[focusedIndex]
        if (!item || item.type !== "folder") {
          setLayoutStatus("Focus a stamped pipeline folder header (e.g. go-pipeline) and press D to delete it.")
        } else {
          const baseCategory = loadPipelineProfiles(workspaceRoot).baseCategory || "pipeline"
          const sourcePrefix = path.join(workspaceRoot, resolveSourceSubdir(workspaceRoot)) + path.sep
          if (item.category === "pipeline" || item.category === baseCategory || agents.some(a => a.category === item.category && a.currentPath.startsWith(sourcePrefix))) {
            setLayoutStatus(item.category === "pipeline" || item.category === baseCategory
              ? `Cannot delete '${item.category}': it is the canonical base pipeline in ${resolveSourceSubdir(workspaceRoot)}/agents/. Only stamped pipelines in ${resolveCategoriesSubdir(workspaceRoot)}/ can be deleted.`
              : `Cannot delete '${item.category}': categories in ${resolveSourceSubdir(workspaceRoot)}/agents/ cannot be deleted as a stamped pipeline.`)
          } else if (item.category.endsWith("-pipeline") && fs.existsSync(path.join(workspaceRoot, resolveCategoriesSubdir(workspaceRoot), item.category))) {
            setDeleteTargetCategory(item.category)
            setDeleteAlsoInstalled(false)
            setLayoutStatus("")
            setViewMode("delete-confirm")
          } else {
            setLayoutStatus(`Cannot delete '${item.category}': only stamped pipelines in ${resolveCategoriesSubdir(workspaceRoot)}/ can be deleted.`)
          }
        }
      } else if (key === "t") {
        if (activeItems.length > 0) {
          const focusedItem = activeItems[focusedIndex]
          const targetAgents = selectedAgentPaths.size > 0
            ? agents.filter(a => selectedAgentPaths.has(a.currentPath))
            : focusedItem?.type === "folder"
              ? agents.filter(a => a.category === focusedItem.category)
              : focusedItem?.agent ? [focusedItem.agent] : []
          if (targetAgents.length === 0) return
          const summary = inspectTuningTargets(targetAgents)
          setTuningTargetPaths(targetAgents.map((a) => a.currentPath))
          setTuningSteps(summary.steps.value)
          setTuningTemp(summary.temp.value)
          setTuningVariant(summary.variant.value)
          setTuningMode(summary.mode.value)
          setTuningHidden(summary.hidden.value)
          setTuningDirtyFields(new Set())
          setTuningFocusedField("steps")
          setViewMode("parameter-tuning")
        }
      } else if (key === "i") {
        try {
          const preview = previewImport(workspaceRoot)
          const companionDiffs: AgentDiffResult[] = preview.companionResources.map(resource => ({
            filename: resource.relativePath,
            localPath: resource.localPath,
            exportPath: resource.exportPath,
            existsLocally: resource.existsLocally,
            existsInExport: resource.existsInExport,
            hasDifferences: resource.hasDifferences,
            localContent: "",
            exportContent: ""
          }))
          const diffs = [...preview.agents, ...companionDiffs]
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
      } else if (key === "5") {
        setInspectorTab("resources")
        setResourceScrollIndex(0)
      } else if (key === "pageup" && inspectorTab === "resources") {
        setResourceScrollIndex(offset => Math.max(0, offset - resourceInspectorPageSize))
      } else if (key === "pagedown" && inspectorTab === "resources") {
        setResourceScrollIndex(offset => Math.min(Math.max(0, resourceInspectorLines.length - resourceInspectorPageSize), offset + resourceInspectorPageSize))
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
        if (!analyzePermissionOrder(ag).hasOrderError) return
        try {
          const tx = mutate([ag.currentPath], "tune", () => fixPermissionOrder(ag))
          const fixed = tx.value
          if (fixed) {
            try { refreshData() } catch (error) { setMutationRefreshFailure(error, tx.warning); return }
            setMutationSuccess("Permission Order Fixed", [
              `Successfully reordered permissions for:`,
              `  ${ag.filename}`,
              `Placed wildcard "*": "deny" FIRST to comply with OpenCode spec.`
            ])
          } else return
        } catch (error: any) {
          setActionResultTitle("Error Fixing Permission Order")
          setActionResultLines([`An error occurred:`, `  ${error.message || error}`])
        }
        setViewMode("action-result")
      }
    } else if (viewMode === "delete-confirm") {
      if (key === "tab" || key === "x" || key === "space") {
        setDeleteAlsoInstalled(prev => !prev)
      } else if (key === "n" || key === "escape") {
        setDeleteTargetCategory(null)
        setViewMode("main")
      } else if (key === "y" || key === "enter" || key === "return") {
        if (!deleteTargetCategory) return
        const category = deleteTargetCategory
        const deletedAgentPaths = agents.filter(agent => agent.category === category).map(agent => agent.currentPath)
        try {
          const tx = mutate([
            path.join(workspaceRoot, resolveCategoriesSubdir(workspaceRoot), category),
            getCompanionLinksConfigPath(workspaceRoot)
          ], "pipeline", () => deleteStampedPipeline(workspaceRoot, category, { alsoInstalled: deleteAlsoInstalled }))
          const result = tx.value
          setSelectedAgentPaths(previous => {
            const next = new Set(previous)
            deletedAgentPaths.forEach(agentPath => next.delete(agentPath))
            return next
          })
          setExpandedCategories(previous => {
            const next = new Set(previous)
            next.delete(category)
            return next
          })
          setDeleteTargetCategory(null)
          try { refreshData() } catch (error) { setMutationRefreshFailure(error, tx.warning); return }
          setMutationSuccess("Stamped Pipeline Deleted", [
            `Deleted category: ${result.deletedCategory}`,
            `Removed ${result.removedAgentsCount} stamped agent file(s) from:`,
            `  ${result.outputDir}`,
            "Removed its .agent-manager/companion-links.json category entry.",
            ...(deleteAlsoInstalled ? [
              `Removed ${result.removedInstalledAgents.length} installed agent(s).`,
              `Removed ${result.removedInstalledCommands.length} installed command(s).`
            ] : ["Installed agents and commands were left unchanged."])
          ], tx.warning)
          setViewMode("action-result")
        } catch (error: any) {
          setActionResultTitle("Error Deleting Stamped Pipeline")
          setActionResultLines([`An error occurred:`, `  ${error.message || error}`])
          setViewMode("action-result")
        }
      }
    } else if (viewMode === "model-selector" || viewMode === "repair-selector") {
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
              if (viewMode === "repair-selector") {
                const index = Number(repairGroupKey)
                setRepairMappings(previous => ({ ...previous, [String(index)]: selectedModel }))
                if (index + 1 < invalidModelGroups.length) {
                  setRepairGroupKey(String(index + 1))
                  setFocusedModelIndex(0)
                  setModelScrollOffset(0)
                  return
                }
                const mappings = invalidModelGroups.map((group, groupIndex) => ({
                  oldModel: group.value,
                  newModel: groupIndex === index ? selectedModel : repairMappings[String(groupIndex)],
                  agentPaths: group.agents.map(agent => agent.currentPath)
                }))
                if (mappings.some(mapping => !mapping.newModel)) throw new Error("Choose a replacement for every invalid model group")
                setRepairMappings(Object.fromEntries(mappings.map((mapping, i) => [String(i), mapping.newModel])))
                setViewMode("repair-confirm")
                return
              }
              const selectedAgents = selectedAgentPaths.size > 0
                ? agents.filter((a) => selectedAgentPaths.has(a.currentPath))
                : (activeItems[focusedIndex]?.agent ? [activeItems[focusedIndex].agent!] : [])
               if (!modelCatalog.models.includes(selectedModel)) throw new Error("Model is not present in refreshed catalog")
               const tx = mutate(selectedAgents.map(a => a.currentPath), "tune", () => updateAgentsModel(selectedAgents, selectedModel, modelCatalog.models))
               try { refreshData() } catch (error) { setMutationRefreshFailure(error, tx.warning); return }
               setSelectedAgentPaths(new Set())
                setMutationSuccess("Model Updated Successfully", [`Successfully set model:`, `  ${selectedModel}`, `on ${selectedAgents.length} agents.`], tx.warning)
            } catch (error: any) {
              setActionResultTitle("Error Updating Model")
              setActionResultLines([`An error occurred:`, `  ${error.message || error}`])
            }
            setViewMode("action-result")
          }
        }
      } else if (key === "escape") {
        setRepairGroupKey(null)
        setViewMode("main")
      } else if (key === "y") {
        refreshModelCatalog()
        setViewMode("main")
      }
    } else if (viewMode === "repair-confirm") {
      if (key === "escape" || key === "n") setViewMode("main")
      else if (key === "enter" || key === "return" || key === "y") {
        try {
          const mappings = invalidModelGroups.map((group, index) => ({ oldModel: group.value, newModel: repairMappings[String(index)], agentPaths: group.agents.map(agent => agent.currentPath) }))
           const tx = mutate(mappings.flatMap(mapping => mapping.agentPaths), "tune", () => repairAgentModels(agents, mappings, modelCatalog.status === "verified" ? modelCatalog.models : []))
           const result = tx.value
           try { refreshData() } catch (error) { setMutationRefreshFailure(error, tx.warning); return }
          setSelectedAgentPaths(new Set())
            setMutationSuccess("Grouped Model Repair Complete", [`Repaired ${result.groups} group(s); changed ${result.agentsChanged} agent(s).`, "Writes were validated against the loaded catalog."], tx.warning)
          setViewMode("action-result")
        } catch (error: any) {
          setActionResultTitle("Error During Grouped Repair")
          setActionResultLines(["No repository-wide atomicity is claimed.", error.message || String(error)])
          setViewMode("action-result")
        }
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
            const tx = mutate([path.join(workspaceRoot, ".agent-manager", "translation-config.json")], "config", () => saveTranslationConfig(workspaceRoot, nextConfig))
            setTranslationConfig(loadTranslationConfig(workspaceRoot, undefined, { persistMigration: false }))
            try { refreshData() } catch (error) { setMutationRefreshFailure(error, tx.warning); return }
          setSelectedAgentPaths(new Set())
            setMutationSuccess("Tier Assigned Successfully", [
            `Tier: ${chosenTier}`,
            `Roles modified: ${Array.from(roles).join(", ") || "none"}`,
            ...(impacted.length ? [`⚠ Shared-role impact on non-selected agents:`, ...impacted.map(agent => `  ${agent.filename}`)] : ["No non-selected agents share these roles."])
           ], tx.warning)
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
            const tx = mutate(agents.flatMap(a => [a.currentPath, a.targetPath]), "organize", () => organizeAgents(workspaceRoot, agents))
            const { copied, skipped, backupsPath } = tx.value
           try { refreshData() } catch (error) { setMutationRefreshFailure(error, tx.warning); return }
           setMutationSuccess("Reorganization Complete", [
            `Local backup created at:`,
            `  ${backupsPath}`,
            ``,
            `Copied ${copied.length} files to category directories:`
           ].concat(copied.map((line) => `  * ${line}`), skipped.length > 0 ? [``, `Skipped ${skipped.length} files (manifest-backed categories require category build):`, ...skipped.map((line) => `  * ${line}`)] : []), tx.warning)
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
        const profiles = Object.keys(loadPipelineProfiles(workspaceRoot).profiles)
        if (forkFocusedField === "profile" || key === "up" || key === "down") {
          const current = profiles.indexOf(forkProfileName)
          const next = (current + (key === "up" ? -1 : 1) + profiles.length + 1) % (profiles.length + 1)
          const profile = next === 0 ? "" : profiles[next - 1]
          setForkProfileName(profile)
          if (!forkProfileTarget || forkProfileTarget === `${forkProfileName}-pipeline`) setForkProfileTarget(profile ? `${profile}-pipeline` : "")
          setForkFocusedField("profile")
        } else {
          setForkFocusedField((prev) => prev === "find" ? "replace" : prev === "replace" ? "target" : prev === "target" ? "profile" : "find")
        }
      } else if (key === "backspace") {
        if (forkFocusedField === "find") {
          setForkFindQuery((prev) => prev.slice(0, -1))
        } else if (forkFocusedField === "replace") {
          setForkReplaceQuery((prev) => prev.slice(0, -1))
        } else if (forkFocusedField === "target") {
          setForkProfileTarget(prev => prev.slice(0, -1))
        }
      } else if (key === "enter" || key === "return") {
        if (forkProfileName) {
          const target = forkProfileTarget.trim() || `${forkProfileName}-pipeline`
          try {
            const config = loadPipelineProfiles(workspaceRoot)
            const inPlace = target === forkSourceCategory
            const paths = [path.join(workspaceRoot, resolveSourceSubdir(workspaceRoot), "agents"), path.join(workspaceRoot, resolveCategoriesSubdir(workspaceRoot)), path.join(workspaceRoot, ".agent-manager", "companion-links.json")]
            const tx = mutate(paths, "fork", () => inPlace
              ? applyPipelineProfile(workspaceRoot, forkProfileName, target)
              : syncPipelineProfile(workspaceRoot, forkProfileName, target))
            const result = tx.value
            try { refreshData() } catch (error) { setMutationRefreshFailure(error, tx.warning); return }
            setMutationSuccess(`Pipeline Profile ${inPlace ? "Applied" : "Synced"}`, [
              `Profile: ${forkProfileName} — ${config.profiles[forkProfileName]?.description || ""}`,
              `Target category: ${(result as { targetCategory: string }).targetCategory}`,
              `Updated ${"updated" in result ? result.updated.length : result.synced.length} agents.`,
              ...("backupsPath" in result && result.backupsPath ? [`Backup: ${result.backupsPath}`] : [])
            ], tx.warning)
            setViewMode("action-result")
          } catch (error: any) {
            setActionResultTitle("Error Applying Pipeline Profile")
            setActionResultLines([`An error occurred:`, `  ${error.message || error}`])
            setViewMode("action-result")
          }
          return
        }
        if (!forkFindQuery) return
        try {
          const selectedPaths: string[] | undefined = selectedAgentPaths.size > 0 ? Array.from(selectedAgentPaths) : undefined
          const replacements = parseForkReplacements(forkReplaceQuery)
          const replacementCount = typeof replacements === "string" ? 1 : replacements.length
            const tx = mutate([path.join(workspaceRoot, resolveSourceSubdir(workspaceRoot), "agents")], "fork", () => forkCategory(workspaceRoot, forkSourceCategory, forkFindQuery, replacements, selectedPaths))
            const result = tx.value
                try { refreshData() } catch (error) { setMutationRefreshFailure(error, tx.warning); return }
          setSelectedAgentPaths(new Set())
           setMutationSuccess("Fork Category Complete", [
            `Category '${forkSourceCategory}' successfully forked!`,
            result.backupsPath ? `Local backup created at:` : `No backup needed`,
            ...(result.backupsPath ? [`  ${result.backupsPath}`] : []),
            ``,
             `Summary: ${result.copied.length} copied, ${result.skipped.length} skipped across ${replacementCount} replacement${replacementCount === 1 ? "" : "s"}`,
             `Forked ${result.copied.length} files under general/agents/:`
            ].concat(result.copied.map((line) => `  * ${line}`), result.skipped.length > 0 ? [``, `Skipped ${result.skipped.length} files:`, ...result.skipped.map((line) => `  * ${line}`)] : []), tx.warning)
          setViewMode("action-result")
        } catch (error: any) {
          setActionResultTitle("Error During Fork")
          setActionResultLines([`An error occurred:`, `  ${error.message || error}`])
          setViewMode("action-result")
        }
      } else if (/^[\x20-\x7E]$/.test(rawChar)) {
        if (forkFocusedField === "find") {
          setForkFindQuery((prev) => prev + rawChar)
        } else if (forkFocusedField === "replace") {
          setForkReplaceQuery((prev) => prev + rawChar)
        } else if (forkFocusedField === "target") {
          setForkProfileTarget(prev => prev + rawChar)
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
          const exportPaths = selectedAgentPaths.size > 0
            ? selectedAgentPaths
            : exportCategory ? new Set(agents.filter(agent => agent.category === exportCategory).map(agent => agent.currentPath)) : undefined
          const exportAgentsList = exportPaths
            ? agents.filter(agent => exportPaths.has(agent.currentPath))
            : exportCategory ? agents.filter(agent => agent.category === exportCategory) : agents
          const categoriesRoot = path.join(workspaceRoot, resolveCategoriesSubdir(workspaceRoot))
          const firstExportPath = exportAgentsList[0]?.currentPath
          const relativeToCategories = firstExportPath ? path.relative(categoriesRoot, firstExportPath) : ""
          const stampedCategory = relativeToCategories && !relativeToCategories.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeToCategories)
            ? relativeToCategories.split(path.sep)[0]
            : ""
          const resourceSourceRoot = stampedCategory ? path.join(categoriesRoot, stampedCategory) : path.join(workspaceRoot, resolveSourceSubdir(workspaceRoot))
          const result = exportAgents(exportAgentsList, undefined, resourceSourceRoot)
          setSelectedAgentPaths(new Set())
          setActionResultTitle("Export Complete")
          const lines = [
            `Successfully exported ${result.exported.length} agents to:`,
            `  ${result.destinationPath.replace(/\/Users\/[^\/]+/, "~")}`,
            ``,
            `Disaster-recovery backup at:`,
            `  ${result.backupPath.replace(/\/Users\/[^\/]+/, "~")}`
          ]
          if (result.domainResources.length > 0) {
            lines.push(
              ``,
              `Companion resources installed:`,
              ...result.domainResources.map(resource => `  ${resource.replace(/\/Users\/[^\/]+/, "~")}`),
              `Resource backup: ${result.domainBackupPath ? result.domainBackupPath.replace(/\/Users\/[^\/]+/, "~") : "not needed"}`
            )
          }
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
               const tx = mutate(selectedAgents.map(a => a.currentPath), "tune", () => updateAgentsColor(selectedAgents, selectedColor))
                try { refreshData() } catch (error) { setMutationRefreshFailure(error, tx.warning); return }
              setSelectedAgentPaths(new Set())
                setMutationSuccess("Color Updated Successfully", [`Successfully set color:`, `  ${selectedColor} (${item.label.trim()})`, `on ${selectedAgents.length} agents.`], tx.warning)
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
           const tx = mutate(targetAgents.map(a => a.currentPath), "tune", () => applySafetyPreset(targetAgents, preset.key))
           try { refreshData() } catch (error) { setMutationRefreshFailure(error, tx.warning); return }
          setSelectedAgentPaths(new Set())
            setMutationSuccess("Safety Preset Applied", [`Successfully applied preset '${preset.name}'`, `to ${targetAgents.length} agents.`], tx.warning)
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
             const tx = mutate([delegationTargetAgent.currentPath], "tune", () => updateAgentDelegations(delegationTargetAgent, allowedNames))
             try { refreshData() } catch (error) { setMutationRefreshFailure(error, tx.warning); return }
             setMutationSuccess("Delegation Graph Updated", [`Updated subagent delegation permissions for:`, `  ${delegationTargetAgent.filename}`, ``, `Allowed subagents (${allowedNames.length}):`, ...allowedNames.map((name) => `  * ${name}`)], tx.warning)
          } catch (error: any) {
            setActionResultTitle("Error Updating Delegations")
            setActionResultLines([`An error occurred:`, `  ${error.message || error}`])
          }
          setViewMode("action-result")
        }
      } else if (key === "escape") {
        setViewMode("main")
      }
    } else if (viewMode === "resource-manager") {
      if (key === "escape") {
        setViewMode("main")
      } else if (key === "up" || key === "k" || key === "down" || key === "j") {
        if (resourceManagerRows.length === 0) return
        const direction = key === "up" || key === "k" ? -1 : 1
        const next = Math.max(0, Math.min(resourceManagerRows.length - 1, resourceModalFocusIndex + direction))
        setResourceModalFocusIndex(next)
        setResourceModalScrollOffset(offset => next < offset ? next : next >= offset + maxVisibleResourceRows ? next - maxVisibleResourceRows + 1 : offset)
      } else if (key === "pageup" || key === "pagedown") {
        if (resourceManagerRows.length === 0) return
        const delta = key === "pageup" ? -maxVisibleResourceRows : maxVisibleResourceRows
        const next = Math.max(0, Math.min(resourceManagerRows.length - 1, resourceModalFocusIndex + delta))
        setResourceModalFocusIndex(next)
        setResourceModalScrollOffset(Math.max(0, Math.min(Math.max(0, resourceManagerRows.length - maxVisibleResourceRows), next)))
        } else if (key === "space") {
        const row = resourceManagerRows[resourceModalFocusIndex]
        if (!row) return
        if (row.section === "companion") {
          const item = row.item as SelectableCompanionItem
          setResourceDraftCompanion(previous => ({ ...previous, [item.relativePath]: !previous[item.relativePath] }))
          return
        }
        if (!resourceCatalog) return
        const agentItem = row.item as AgentResourceItem | AgentMcpResourceItem
        if (row.kind === "skill-wildcard") {
          const nextAll = !draftSkillAll
          setDraftSkillAll(nextAll)
          setDraftAllowedSkills(nextAll
            ? new Set(resourceCatalog.skills.filter(item => item.kind === "skill").map(item => item.name))
            : new Set())
        } else if (row.kind === "skill") {
          const name = agentItem.name
          const next = new Set(draftAllowedSkills)
          if (next.has(name)) next.delete(name)
          else next.add(name)
          const skillNames = resourceCatalog.skills.filter(item => item.kind === "skill").map(item => item.name)
          if (!draftSkillAll && skillNames.length > 0 && skillNames.every(skill => next.has(skill))) {
            setDraftSkillAll(true)
          } else if (draftSkillAll && next.size === 0) {
            setDraftSkillAll(false)
          }
          setDraftAllowedSkills(next)
        } else if (row.kind === "tool-family") {
          const nextAllowed = !draftPermissions[agentItem.permissionKey]
          const keys = [agentItem.permissionKey, ...resourceCatalog.tools
            .filter(item => item.kind === "tool" && item.familyKey === agentItem.permissionKey && !explicitResourcePermissions.has(item.permissionKey))
            .map(item => item.permissionKey)]
          setDraftPermissions(previous => Object.fromEntries(Object.entries({ ...previous, ...Object.fromEntries(keys.map(key => [key, nextAllowed])) })))
          setExplicitResourcePermissions(previous => new Set([...previous, agentItem.permissionKey]))
        } else {
          setDraftPermissions(previous => ({ ...previous, [agentItem.permissionKey]: !previous[agentItem.permissionKey] }))
          setExplicitResourcePermissions(previous => new Set([...previous, agentItem.permissionKey]))
        }
      } else if (key === "x") {
        const row = resourceManagerRows[resourceModalFocusIndex]
        if (row?.kind === "mcp") {
          const item = row.item as AgentMcpResourceItem
          if (item.configuredInOpencode || item.recommendedInRepo) {
            setDraftMcpEnabled(previous => ({ ...previous, [item.serverKey]: !previous[item.serverKey] }))
          } else {
            setLayoutStatus("Server is not configured in ~/.config/opencode/opencode.json.")
          }
        }
      } else if (key === "enter" || key === "return") {
        if (!resourceCatalog) return
        const companionChanged = companionAvailableItems.some(item => Boolean(resourceDraftCompanion[item.relativePath]) !== item.linked)
        const nextLinks = {
          plugins: companionAvailableItems.filter(item => item.group === "plugin" && resourceDraftCompanion[item.relativePath]).map(item => item.relativePath),
          commands: companionAvailableItems.filter(item => item.group === "command" && resourceDraftCompanion[item.relativePath]).map(item => item.relativePath),
          skills: companionAvailableItems.filter(item => item.group === "skill" && resourceDraftCompanion[item.relativePath]).map(item => item.relativePath),
          tools: companionAvailableItems.filter(item => item.group === "tool" && resourceDraftCompanion[item.relativePath]).map(item => item.relativePath)
        }
        const initialWildcard = resourceCatalog.skills.find(item => item.kind === "skill-wildcard")?.allowed || false
        const initialAllowedSkills = new Set<string>(resourceCatalog.skills.filter(item => item.kind === "skill" && item.allowed).map(item => item.name))
        const allowedNames: string[] = Array.from(draftAllowedSkills)
        const skillsChanged = draftSkillAll !== initialWildcard || allowedNames.length !== initialAllowedSkills.size || allowedNames.some(name => !initialAllowedSkills.has(name))
        const permissions: Record<string, boolean> = Object.fromEntries([...resourceCatalog.tools, ...resourceCatalog.mcpServers]
          .filter(item => {
            const changed = draftPermissions[item.permissionKey] !== item.allowed
            const inheritedChildTool = item.kind === "tool" && Boolean(item.familyKey)
            return changed && (!inheritedChildTool || explicitResourcePermissions.has(item.permissionKey))
          })
          .map(item => [item.permissionKey, draftPermissions[item.permissionKey]]))
        const mcpEnabled: Record<string, boolean> = Object.fromEntries(resourceCatalog.mcpServers
          .filter(item => (item.configuredInOpencode || item.recommendedInRepo) && draftMcpEnabled[item.serverKey] !== item.serverEnabled)
          .map(item => [item.serverKey, draftMcpEnabled[item.serverKey]]))
        const changes: AgentResourceChanges = {
          ...(skillsChanged ? { skills: { all: draftSkillAll, allowedNames } } : {}),
          ...(Object.keys(permissions).length ? { permissions } : {}),
          ...(Object.keys(mcpEnabled).length ? { mcpEnabled } : {})
        }
        if (!companionChanged && !changes.skills && !changes.permissions && !changes.mcpEnabled) {
          setLayoutStatus("No changes to save.")
          setViewMode("main")
          return
        }
        const hasAgentChanges = Boolean(changes.skills || changes.permissions)
        const allowedPaths = [
          ...(companionChanged ? [getCompanionLinksConfigPath(workspaceRoot)] : []),
          ...(resourceTargetAgent && hasAgentChanges ? [path.relative(workspaceRoot, resourceTargetAgent.currentPath)] : [])
        ]
        if (allowedPaths.length === 0 && resourceTargetAgent) allowedPaths.push(path.relative(workspaceRoot, resourceTargetAgent.currentPath))
        try {
          const tx = mutate(allowedPaths, "tune", () => {
            if (companionChanged && resourceCategoryTarget) updateCategoryCompanionLinks(workspaceRoot, resourceCategoryTarget, nextLinks)
            const agentResult = resourceTargetAgent
              ? updateAgentResourcesAndMcp(workspaceRoot, resourceTargetAgent, resourceCatalog, changes)
              : { changedPaths: [] }
            return { changedPaths: [...(companionChanged ? [getCompanionLinksConfigPath(workspaceRoot)] : []), ...agentResult.changedPaths] }
          })
          setCompanionAvailableItems(discoverAvailableCategoryCompanionItems(workspaceRoot, resourceCategoryTarget || "general"))
          try { refreshData() } catch (error) { setMutationRefreshFailure(error, tx.warning); return }
          setMutationSuccess(companionChanged && !resourceTargetAgent ? "Category Companion Links Updated" : "Resources Updated", [
            ...(resourceTargetAgent ? [`Updated skills, custom tools, and MCP permissions for:`, `  ${resourceTargetAgent.filename}`] : []),
            ...(companionChanged ? [`Updated exported companion links for category: ${resourceCategoryTarget}`] : []),
            ...(tx.value.changedPaths.includes(resourceCatalog.opencodeConfigPath ?? getGlobalOpenCodeConfigPath())
              ? ["", "~/.config/opencode/opencode.json updated. Restart OpenCode for MCP server changes to take effect."]
              : [])
          ], tx.warning)
          setViewMode("action-result")
        } catch (error: any) {
          setActionResultTitle("Error Updating Agent Resources")
          setActionResultLines([`An error occurred:`, `  ${error.message || error}`])
          setViewMode("action-result")
        }
      }
    } else if (viewMode === "parameter-tuning") {
      // 12. Parameter tuning mode
      if (key === "escape") {
        setViewMode("main")
      } else if (key === "tab" && tuningFocusedField === "variant") {
        const index = tuningVariantChoices.indexOf(tuningVariant)
        setTuningVariant(tuningVariantChoices[(index + 1 + tuningVariantChoices.length) % tuningVariantChoices.length])
        markTuningDirty("variant")
      } else if (key === "tab" || key === "down") {
        setTuningFocusedField((prev) =>
          prev === "steps" ? "temp" : prev === "temp" ? "variant" : prev === "variant" ? "mode" : prev === "mode" ? "hidden" : "steps"
        )
      } else if (key === "up") {
        setTuningFocusedField((prev) =>
          prev === "hidden" ? "mode" : prev === "mode" ? "variant" : prev === "variant" ? "temp" : prev === "temp" ? "steps" : "hidden"
        )
      } else if (key === "space") {
        if (tuningFocusedField === "variant") {
          const choices = tuningVariantChoices
          const currentIndex = choices.indexOf(tuningVariant)
          setTuningVariant(choices[(currentIndex + 1 + choices.length) % choices.length])
          markTuningDirty("variant")
        } else if (tuningFocusedField === "mode") {
          setTuningMode((prev) => (prev === "primary" ? "subagent" : "primary"))
          markTuningDirty("mode")
        } else if (tuningFocusedField === "hidden") {
          setTuningHidden((prev) => !prev)
          markTuningDirty("hidden")
        }
      } else if (key === "backspace") {
        if (tuningFocusedField === "steps") {
          if (!tuningDirtyFields.has("steps") && tuningSummary.steps.mixed) setTuningSteps("")
          else setTuningSteps(prev => prev.slice(0, -1))
          markTuningDirty("steps")
        } else if (tuningFocusedField === "temp") {
          if (!tuningDirtyFields.has("temp") && tuningSummary.temp.mixed) setTuningTemp("")
          else setTuningTemp(prev => prev.slice(0, -1))
          markTuningDirty("temp")
        } else if (tuningFocusedField === "variant") {
          setTuningVariant((prev) => prev.slice(0, -1))
          markTuningDirty("variant")
        }
      } else if (key === "enter" || key === "return") {
        const targetAgents = tuningTargetPaths.length > 0
          ? agents.filter((a) => tuningTargetPaths.includes(a.currentPath))
          : []
        if (tuningDirtyFields.size === 0) {
          setViewMode("main")
          setLayoutStatus("No parameters modified — left all agents unchanged.")
          return
        }
        if (targetAgents.length === 0) return

        try {
          const params = buildTuningUpdateParams(
            { steps: tuningSteps, temp: tuningTemp, variant: tuningVariant, mode: tuningMode, hidden: tuningHidden },
            tuningDirtyFields,
            modelVariants && modelVariants.length > 0 ? modelVariants : undefined
          )
          const tx = mutate(targetAgents.map(a => a.currentPath), "tune", () => updateAgentParams(targetAgents, params))
          try { refreshData() } catch (error) { setMutationRefreshFailure(error, tx.warning); return }
          setSelectedAgentPaths(new Set())
          setMutationSuccess("Parameters Updated Successfully", [
           `Successfully tuned parameters for ${targetAgents.length} agents:`,
           `  * Steps:  ${tuningDirtyFields.has("steps") ? tuningSteps : "unchanged"}`,
           `  * Temp:   ${tuningDirtyFields.has("temp") ? tuningTemp : "unchanged"}`,
           `  * Variant (Effort): ${tuningDirtyFields.has("variant") ? (tuningVariant.trim() || "cleared (default)") : "unchanged"}`,
           `  * Mode:   ${tuningDirtyFields.has("mode") ? tuningMode : "unchanged"}`,
           `  * Hidden: ${tuningDirtyFields.has("hidden") ? tuningHidden : "unchanged"}`
          ], tx.warning)
        } catch (error: any) {
          setLayoutStatus(error.message || String(error))
          return
        }
        setViewMode("action-result")
      } else if (/^[\x20-\x7E]$/.test(rawChar) && rawChar !== " ") {
        if (tuningFocusedField === "steps" && /[0-9]/.test(rawChar)) {
          if (!tuningDirtyFields.has("steps") && tuningSummary.steps.mixed) setTuningSteps(rawChar)
          else setTuningSteps(prev => prev + rawChar)
          markTuningDirty("steps")
        } else if (tuningFocusedField === "temp" && /[0-9]/.test(rawChar)) {
          if (!tuningDirtyFields.has("temp") && tuningSummary.temp.mixed) setTuningTemp(rawChar)
          else setTuningTemp(prev => prev + rawChar)
          markTuningDirty("temp")
        } else if (tuningFocusedField === "temp" && rawChar === ".") {
          if (!tuningDirtyFields.has("temp") && tuningSummary.temp.mixed) setTuningTemp("0.")
          else setTuningTemp(prev => rawChar === "." && prev.includes(".") ? prev : prev + rawChar)
          markTuningDirty("temp")
        } else if (tuningFocusedField === "variant" && /^[a-zA-Z0-9_-]$/.test(rawChar)) {
          setTuningVariant((prev) => prev + rawChar)
          markTuningDirty("variant")
        }
      } else if (key === "left" || key === "right") {
        if (tuningFocusedField === "variant") {
          const choices = tuningVariantChoices
          const currentIndex = choices.indexOf(tuningVariant)
          const nextIndex = currentIndex < 0
            ? (key === "right" ? 0 : choices.length - 1)
            : (currentIndex + (key === "right" ? 1 : -1) + choices.length) % choices.length
          setTuningVariant(choices[nextIndex])
          markTuningDirty("variant")
        } else if (tuningFocusedField === "mode") {
          setTuningMode(prev => prev === "primary" ? "subagent" : "primary")
          markTuningDirty("mode")
        } else if (tuningFocusedField === "hidden") {
          setTuningHidden(prev => !prev)
          markTuningDirty("hidden")
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
            const tx = mutate([renameTargetAgent.currentPath, destination, ...agents.map(a => a.currentPath)], "rename", () => renameAgent(workspaceRoot, renameTargetAgent.currentPath, newFilename, agents))
            const result = tx.value
           try { refreshData() } catch (error) { setMutationRefreshFailure(error, tx.warning); return }
          setSelectedAgentPaths(new Set())
           setMutationSuccess("Rename Complete", [
             `Successfully renamed agent:`,
             `  ${middleEllipsis(renameTargetAgent.filename, Math.max(1, Math.floor(termWidth * 0.7) - 8))} → ${middleEllipsis(newFilename, Math.max(1, Math.floor(termWidth * 0.7) - 8))}`,
            ...result.updatedReferences.map((reference) => `  ${reference}`)
             , ...(result.skipped.length > 0 ? [`Skipped files:`, ...result.skipped.map((file) => `  ${file}`)] : []),
             ...(result.error ? [``, `⚠ ${result.error}`] : [])
           ], tx.warning)
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
            const tx = mutate([
              path.join(workspaceRoot, resolveSourceSubdir(workspaceRoot), "agents"),
              path.join(workspaceRoot, resolveSourceSubdir(workspaceRoot), "tools"),
              path.join(workspaceRoot, resolveSourceSubdir(workspaceRoot), "commands"),
              path.join(workspaceRoot, resolveSourceSubdir(workspaceRoot), "skills"),
              path.join(workspaceRoot, resolveSourceSubdir(workspaceRoot), "plugins")
            ], "import", () => importAgents(workspaceRoot))
            const result = tx.value
           try { refreshData() } catch (error) { setMutationRefreshFailure(error, tx.warning); return }
            setMutationSuccess("Import Complete", [
             `Successfully imported ${result.imported.length} agents:`,
             ...result.imported.map((filename) => `  * ${filename}`),
             `Successfully imported ${result.importedResources.length} companion resources:`,
             ...result.importedResources.map((filename) => `  * ${filename}`),
             ``,
            result.backupPath ? `Backup created at:` : `No backup needed`,
            ...(result.backupPath ? [`  ${result.backupPath}`] : [])
           ], tx.warning)
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
      } else if (key === "y" && actionResultTitle === "Model Catalog Unavailable") {
        refreshModelCatalog()
        setViewMode("main")
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
  const tuningAgents = viewMode === "parameter-tuning" && tuningTargetPaths.length > 0
    ? agents.filter(agent => tuningTargetPaths.includes(agent.currentPath))
    : selectedAgentPaths.size > 0
      ? agents.filter(agent => selectedAgentPaths.has(agent.currentPath))
      : currentItem?.type === "folder"
        ? agents.filter(agent => agent.category === currentItem.category)
        : currentItem?.agent ? [currentItem.agent] : []
  const tuningSummary = useMemo(() => inspectTuningTargets(tuningAgents), [tuningAgents])
  const tuningModels = Array.from(new Set<string>(tuningAgents.map(agent => agent.frontmatter.model)
    .filter((model): model is string => typeof model === "string" && model.trim().length > 0)))
  const modelVariants = tuningModels.length === 1
    ? getModelVariants(modelCatalog, tuningModels[0])
    : tuningModels.length > 1
      ? (() => {
          const variants = tuningModels.map(model => getModelVariants(modelCatalog, model))
          return variants.every((variant): variant is string[] => variant !== null)
            ? variants[0].filter(variant => variants.every(items => items.includes(variant)))
            : null
        })()
      : null
  const tuningVariantChoices = modelVariants !== null
    ? (modelVariants.length > 0 ? ["", ...modelVariants] : [""])
    : ["", ...AGENT_EFFORT_VARIANTS]
  if (tuningVariant && !tuningVariantChoices.includes(tuningVariant)) tuningVariantChoices.push(tuningVariant)

  const resourceInspector = useMemo(() => {
    if (inspectorTab !== "resources" || currentItem?.type !== "file" || !currentItem.agent) return { catalog: null, error: "" }
    try {
      return { catalog: discoverAgentResources(workspaceRoot, currentItem.agent, agents), error: "" }
    } catch (error: any) {
      return { catalog: null, error: terminalSafeText(error?.message || error) }
    }
  }, [inspectorTab, currentItem?.agent, agents, workspaceRoot])
  const resourceInspectorLines = useMemo(() => {
    const catalog = resourceInspector.catalog
    if (!catalog) return []
    return ["--- SKILLS ---", ...catalog.skills.map(item =>
      `* ${item.name} [${item.allowed ? "ALLOW" : "DENY"}]${item.exists ? "" : " [Dead Ref]"}`
    ), "--- CUSTOM TOOLS ---", ...catalog.tools.map(item =>
      `${item.kind === "tool-family" ? "*" : "  -"} ${item.name} [${item.allowed ? "ALLOW" : "DENY"}]`
    ), "--- MCP SERVERS ---", ...catalog.mcpServers.map(item =>
      `* ${item.name} [${item.allowed ? "ALLOW" : "DENY"}] ${item.configuredInOpencode
        ? `[MCP: ${item.serverEnabled ? "ON" : "OFF"}]`
        : item.recommendedInRepo
          ? "[Recommended in repo (x in u to enable)]"
          : "[Not in ~/.config/opencode/opencode.json]"}`
    ), `--- COMPANION FILES (${catalog.companionFiles.length}) ---`, ...(catalog.companionFiles.length ? catalog.companionFiles : ["(none)"])]
  }, [resourceInspector.catalog])
  const resourceManagerRows = useMemo<ResourceManagerRow[]>(() => [
    ...(resourceCatalog ? [
      ...resourceCatalog.skills.map(item => ({ section: "agent" as const, kind: item.kind, item })),
      ...resourceCatalog.tools.map(item => ({ section: "agent" as const, kind: item.kind, item })),
      ...resourceCatalog.mcpServers.map(item => ({ section: "agent" as const, kind: item.kind, item }))
    ] : []),
    ...companionAvailableItems.map(item => ({ section: "companion" as const, item }))
  ], [resourceCatalog, companionAvailableItems])
  const maxVisibleResourceRows = Math.max(1, layout.listRows - 7)
  const visibleResourceRows = resourceManagerRows.slice(resourceModalScrollOffset, resourceModalScrollOffset + maxVisibleResourceRows)
  const resourceInspectorPageSize = Math.max(1, layout.listRows - 5)

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

  if (layout.mode === "too-small") {
    return <box width="100%" height="100%" padding={1} overflow="hidden" backgroundColor="#1e1e1e"><text style={{ textColor: "yellow" }}>Terminal too small. Please increase terminal size.</text></box>
  }

  return (
     <box
       width="100%"
      height="100%"
      minHeight={0}
      overflow="hidden"
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
         justifyContent="center"
        alignItems="center"
         paddingLeft={2}
         paddingRight={2}
         flexDirection="row"
        >
          <box width={headerGroupWidth} height={1} flexShrink={0} flexDirection="row" overflow="hidden">
            <text width={headerTitleWidth} height={1} wrapMode="none" overflow="hidden" flexShrink={0} style={{ textColor: "#9ECBFF" }} b>
              {middleEllipsis(headerTitle, headerTitleWidth)}
            </text>
            <text width={1} height={1} wrapMode="none" overflow="hidden" flexShrink={0}> </text>
           <box width={visibleMetaWidth} height={1} flexShrink={0} flexDirection="row" overflow="hidden">
              {showCommit && <text width={commitWidth} height={1} wrapMode="none" overflow="hidden" flexShrink={0} style={{ textColor: autoCommitEnabled() ? "green" : "gray" }}>{commitLabel}</text>}
              {showCommit && visibleWorkspaceWidth > 0 && <text width={separatorWidth} height={1} wrapMode="none" overflow="hidden" flexShrink={0} style={{ textColor: "gray" }}>{headerSeparator}</text>}
              {showCommit && visibleWorkspaceWidth > 0 && <text width={visibleWorkspaceWidth} height={1} wrapMode="none" overflow="hidden" flexShrink={0} style={{ textColor: "gray" }}>{middleEllipsis(workspaceLabel, visibleWorkspaceWidth)}</text>}
           </box>
          </box>
       </box>

      {statusMessage && (
        <box height={1} flexShrink={0} overflow="hidden">
          <text width={statusMessageWidth} height={1} wrapMode="none" overflow="hidden" style={{ textColor: "yellow" }}>
            {middleEllipsis(statusMessage, statusMessageWidth)}
          </text>
        </box>
      )}
      {viewMode === "repair-confirm" && (
        <box style={{ position: "absolute", left: "12%", top: "15%", width: "76%", height: "65%" }} borderStyle="double" borderColor="yellow" backgroundColor="#1e1e1e" title=" Confirm Grouped Model Repair " padding={1} flexDirection="column">
          <text style={{ textColor: "yellow" }} b>Review mappings before writing:</text>
          {invalidModelGroups.map((group, index) => {
            const agentCount = `${group.agents.length} agents`
            const separatorWidth = displayWidth(` →  (${agentCount})`)
            const modelBudget = Math.max(1, Math.floor((repairConfirmContentWidth - separatorWidth) / 2))
            return <text key={index} width="100%" height={1} flexShrink={0} wrapMode="none" overflow="hidden" style={{ textColor: "white" }}>
              {`${middleEllipsis(JSON.stringify(group.value), modelBudget)} → ${middleEllipsis(repairMappings[String(index)] || "", modelBudget)} (${agentCount})`}
            </text>
          })}
          <text style={{ textColor: "gray" }} marginTop={1}>[Y/ENTER] Apply | [N/ESC] Cancel</text>
        </box>
      )}
      {viewMode === "delete-confirm" && deleteTargetCategory && (
        <box style={{ position: "absolute", left: "12%", top: "20%", width: "76%", height: "60%" }} borderStyle="double" borderColor="red" backgroundColor="#1e1e1e" title=" Delete Stamped Pipeline " padding={1} flexDirection="column" justifyContent="space-between" overflow="hidden">
          <box flexDirection="column" overflow="hidden">
            <text style={{ textColor: "yellow" }} b>{`Delete stamped pipeline '${deleteTargetCategory}'?`}</text>
            <text style={{ textColor: "white" }} marginTop={1}>{`Path: export/categories/${deleteTargetCategory}`}</text>
            <text style={{ textColor: "white" }} marginTop={1}>{`This will remove ${agents.filter(agent => agent.category === deleteTargetCategory).length} stamped agent file(s).`}</text>
            <text style={{ textColor: "gray" }}>The .agent-manager/companion-links.json category entry will also be cleaned up.</text>
            <text style={{ textColor: deleteAlsoInstalled ? "yellow" : "white" }} marginTop={2}>{`${deleteAlsoInstalled ? "[x]" : "[ ]"} Also remove installed agents & commands from ~/.config/opencode`}</text>
            <text style={{ textColor: "gray" }}>[TAB / X] Toggle</text>
          </box>
          <text style={{ textColor: "gray" }}>Press [Y/ENTER] to confirm | [TAB/X] Toggle installed cleanup | [N/ESC] Cancel</text>
        </box>
      )}
      {/* Main Panel */}
      <box width="100%" minHeight={0} flexGrow={1} flexDirection="row" marginTop={1} overflow="hidden">
        {/* Left Side: Agents List (Wider to prevent filename cut-offs) */}
         <box
            width={listPanelWidth}
            flexGrow={0}
           minHeight={0}
          borderStyle="round"
          borderColor="#444444"
          title=" Agents (Tree) "
           titleColor="#9ECBFF"
           flexDirection="column"
           padding={1}
           overflow="hidden"
        >
           {/* Table Header */}
              <box width={listColumns.total} flexDirection="row" borderStyle="single" border={["bottom"]} borderColor="#333333">
                 <text wrapMode="none" overflow="hidden" style={{ textColor: "gray" }} width={columnWidth(0)}>Sel/Lint</text>{gutter("th1")}
                <text wrapMode="none" overflow="hidden" style={{ textColor: "gray" }} width={columnWidth(1)}>Agent Name</text>{gutter("th2")}
                <text wrapMode="none" overflow="hidden" style={{ textColor: "gray" }} width={columnWidth(2)}>Tier / Model</text>
             </box>

          {/* List items */}
           <box width="100%" height={layout.listRows} minHeight={0} overflow="hidden" flexGrow={0} flexShrink={0} flexDirection="column" marginTop={1}>
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

                const isSelected = item.agent ? selectedAgentPaths.has(item.id) : false
                const modelText = item.agent ? modelDisplayValue(item.agent, true, modelCatalog) : ""
                const analysis = item.agent ? analyzeAgentName(item.agent.filename, allAgentFilenames) : null
                const lintBadge = analysis ? (analysis.isValid ? "✓" : "⚠") : ""
                const lintColor = analysis ? (analysis.isValid ? "green" : "yellow") : "yellow"

                   return (
                    <box
                      key={`${item.type}-${item.id}`}
                      width="100%"
                      flexDirection="row"
                      backgroundColor={rowBg}
                       height={1}
                    >
                       <text style={{ textColor: item.type === "file" ? (isSelected ? "green" : lintColor) : "yellow" }} width={columnWidth(0)} wrapMode="none" overflow="hidden">
                         {item.type === "file" ? `${isSelected ? "[x]" : "[ ]"} ${lintBadge}` : " "}
                       </text>
                       {gutter(`tree-${item.id}-1`)}
                       <text style={{ textColor: itemColor }} width={columnWidth(1)} wrapMode="none" overflow="hidden" u={isFocused && item.type === "file"}>
                          {middleEllipsis(item.type === "file" ? item.label : ` ${item.label}`, columnWidth(1))}
                       </text>
                       {gutter(`tree-${item.id}-2`)}
                        {item.type === "file" && <text style={{ textColor: "magenta" }} width={columnWidth(2)} wrapMode="none" overflow="hidden">{middleEllipsis(`${resolvedAgents.get(item.agent!.currentPath)?.tier || "-"} / ${modelText}`, columnWidth(2))}</text>}
                       {item.type !== "file" && <text width={columnWidth(2)}> </text>}
                     </box>
                   )
              })
            )}
          </box>

          {/* Real-time search filter display */}
           <box width="100%" height={3} flexShrink={0} padding={1} borderStyle="single" border={["top"]} borderColor="#333333" flexDirection="row" alignItems="center" overflow="hidden">
             <text wrapMode="none" overflow="hidden" flexShrink={0} style={{ textColor: isSearching ? "yellow" : "gray" }}>
              {isSearching ? "🔍 Filter typing: " : "🔍 Filter (Press /): "}
            </text>
             <text width="60%" wrapMode="none" overflow="hidden" flexShrink={0} style={{ textColor: searchQuery ? "cyan" : "gray" }} b>
               {middleEllipsis(searchQuery ? `${searchQuery}_` : isSearching ? "type here..._" : "none", 40)}
            </text>
          </box>

          {/* List Footer / Counter */}
           <box width="100%" height={2} flexShrink={0} justifyContent="space-between" paddingTop={1} borderStyle="single" border={["top"]} borderColor="#333333" overflow="hidden" flexDirection="row">
              <text width={footerFirstWidth} wrapMode="none" overflow="hidden" flexShrink={0} style={{ textColor: "gray" }}>
               {middleEllipsis(`Total: ${agents.length} | Shown: ${activeItems.length} | Selected: ${selectedAgentPaths.size}`, 36)}
             </text>
              <text width={footerSecondWidth} wrapMode="none" overflow="hidden" flexShrink={0} style={{ textColor: "gray" }}>
                {middleEllipsis("[/] Search | ◀/▶ Collapse/Expand", 36)}
            </text>
          </box>
        </box>

         {layout.showInspector && <>
         <text width={panelWidths.gutter}> </text>
        {/* Right Side: Details & Actions (Tabbed Inspector) */}
         <box
            width={panelWidths.inspector}
            flexGrow={0}
           minHeight={0}
          borderStyle="round"
          borderColor="#444444"
          title=" Inspector "
          titleColor="#9ECBFF"
          flexDirection="column"
          padding={1}
           overflow="hidden"
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
            <text style={{ textColor: "gray" }}>|</text>
            <text style={{ textColor: inspectorTab === "resources" ? "magenta" : "gray" }} u={inspectorTab === "resources"}>
              5.Res
            </text>
          </box>

          {currentItem ? (
             <box flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden">
              {currentItem.type === "file" && currentItem.agent ? (
                <box flexDirection="column" flexGrow={1}>
                  <text style={{ textColor: "#9ECBFF" }} b>
                     {middleEllipsis(currentItem.agent.filename, 30)}
                  </text>

                  {/* TAB 1: OVERVIEW */}
                  {inspectorTab === "overview" && (
                    <box flexDirection="column" marginTop={1} flexGrow={1}>
                      <box flexDirection="row">
                        <text style={{ textColor: "gray" }} width="35%">Category:</text>
                        <text style={{ textColor: "yellow" }} width="65%">
                           {middleEllipsis(currentItem.agent.category, 30)}
                        </text>
                      </box>

                      <box flexDirection="row" marginTop={1}>
                        <text style={{ textColor: "gray" }} width="35%">Model:</text>
                        <text style={{ textColor: "cyan" }} width="65%">
                          {middleEllipsis(modelDisplayValue(currentItem.agent, false, modelCatalog), 30)}
                        </text>
                      </box>

                      <box flexDirection="row" marginTop={1}>
                        <text style={{ textColor: "gray" }} width="35%">Color:</text>
                        <box flexDirection="row" width="65%">
                          {(() => {
                            const rawCol = currentItem.agent.frontmatter.color
                             if (!rawCol) return <text style={{ textColor: "gray" }}>Not set</text>
                             if (typeof rawCol !== "string") return <text style={{ textColor: "red" }}>{`Invalid: ${middleEllipsis(terminalSafeText(rawCol), 20)}`}</text>
                            
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
                                 <text style={{ textColor: "white" }}>{middleEllipsis(rawCol, 20)}</text>
                              </box>
                            )
                          })()}
                        </box>
                      </box>

                      <box flexDirection="row" marginTop={1}>
                        <text style={{ textColor: "gray" }} width="35%">Steps/Temp:</text>
                        <text style={{ textColor: "white" }}>
                           {middleEllipsis(`${currentItem.agent.frontmatter.steps || 50} steps / ${currentItem.agent.frontmatter.temperature ?? 0.2}°`, 30)}
                        </text>
                      </box>

                      <box flexDirection="row" marginTop={1}>
                        <text style={{ textColor: "gray" }} width="35%">Thinking / Effort:</text>
                        <text style={{ textColor: currentItem.agent.frontmatter.variant ? "cyan" : "gray" }} width="65%">
                          {middleEllipsis(`${String(currentItem.agent.frontmatter.variant ?? "default")}${currentItem.agent.frontmatter.reasoningEffort ?? currentItem.agent.frontmatter.options?.reasoningEffort ? ` (reasoningEffort: ${String(currentItem.agent.frontmatter.reasoningEffort ?? currentItem.agent.frontmatter.options?.reasoningEffort)})` : ""}`, 36)}
                        </text>
                      </box>

                      <box flexDirection="column" marginTop={1} flexGrow={1}>
                        <text style={{ textColor: "gray" }}>Description:</text>
                        <box borderStyle="single" borderColor="#333333" padding={1} marginTop={1} flexGrow={1}>
                          <text style={{ textColor: "white" }}>
                             {terminalSafeText(currentItem.agent.description || "No description provided.")}
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
                              <text style={{ textColor: "cyan" }}>{middleEllipsis(analysis.family || "(none)", 30)}</text>
                            </box>
                            <box flexDirection="row">
                              <text style={{ textColor: "gray" }} width="35%">Category:</text>
                              <text style={{ textColor: "yellow" }}>{middleEllipsis(analysis.category || "(none)", 30)}</text>
                            </box>
                            <box flexDirection="row">
                              <text style={{ textColor: "gray" }} width="35%">Role:</text>
                              <text style={{ textColor: "white" }}>{middleEllipsis(analysis.role || "(none)", 30)}</text>
                            </box>
                            {!analysis.isValid && analysis.suggestedName && (
                              <box flexDirection="column" marginTop={1}>
                                <text style={{ textColor: "gray" }}>Suggested Name:</text>
                                 <text style={{ textColor: "green" }}>{middleEllipsis(analysis.suggestedName, 40)}</text>
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
                              <text style={{ textColor: "yellow" }} b>[Press SHIFT+F to Fix order]</text>
                              </box>
                            )}

                            {/* Permission Details */}
                            <box flexDirection="column" marginTop={1}>
                              <text style={{ textColor: "yellow" }} b>Frontmatter Permissions:</text>
                              {permissionEntries.slice(graphScrollOffset, graphScrollOffset + permissionPageSize).map(([key, val]) => {
                                let valStr = typeof val === "object" ? JSON.stringify(val) : String(val)
                                 const safeKey = middleEllipsis(key, 30)
                                 const safeVal = middleEllipsis(valStr, 40)
                                 const isDanger = key === "bash" && (val === "allow" || val === true || valStr.includes("allow"))
                                return (
                                  <box key={key} flexDirection="row" justifyContent="space-between">
                                     <text style={{ textColor: "gray" }}>{`${safeKey}:`}</text>
                                     <text style={{ textColor: isDanger ? "red" : "cyan" }}>{safeVal}</text>
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
                                         {middleEllipsis(exists ? `├─ @${subName}` : `├─ ❌ @${subName} (Dead Ref)`, 40)}
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

                  {inspectorTab === "resources" && (
                    <box flexDirection="column" marginTop={1} flexGrow={1} minHeight={0} overflow="hidden">
                      {resourceInspector.error ? (
                        <text style={{ textColor: "red" }}>{resourceInspector.error}</text>
                      ) : (
                        <>
                          <box flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden">
                            {resourceInspectorLines.slice(resourceScrollIndex, resourceScrollIndex + resourceInspectorPageSize).map((line, index) => (
                              <text key={`${resourceScrollIndex}-${index}`} style={{ textColor: line.startsWith("---") ? "yellow" : line.includes("[DENY]") || line.includes("[Dead Ref]") ? "red" : "white" }} wrapMode="none" overflow="hidden">
                                {middleEllipsis(line, Math.max(1, panelWidths.inspector - 6))}
                              </text>
                            ))}
                          </box>
                          {resourceInspectorLines.length > resourceInspectorPageSize && <text style={{ textColor: "gray" }} flexShrink={0}>
                            {`▲ ${resourceScrollIndex + 1}-${Math.min(resourceScrollIndex + resourceInspectorPageSize, resourceInspectorLines.length)}/${resourceInspectorLines.length} ▼`}
                          </text>}
                          <text style={{ textColor: "cyan" }} flexShrink={0}>Press 'u' to edit Skills, Tools &amp; MCP</text>
                        </>
                      )}
                    </box>
                  )}
                </box>
              ) : (
                           <box flexDirection="column" flexGrow={1} overflow="hidden">
                  <text style={{ textColor: "yellow" }} b>
                     {middleEllipsis(`📁 Category: ${currentItem.category.toUpperCase()}`, 40)}
                  </text>
                  <text style={{ textColor: "white" }} marginTop={1}>
                     {middleEllipsis(`Directory: /categories/${currentItem.category}/agents/`, 50)}
                  </text>
                  <text style={{ textColor: "gray" }} marginTop={2}>
                    Purpose Summary:
                  </text>
                  <box borderStyle="single" borderColor="#333333" padding={1} marginTop={1} flexGrow={1}>
                    <text style={{ textColor: "white" }}>
                       {terminalSafeText(CATEGORY_DESCRIPTIONS[currentItem.category] || "Specific compilation pipeline folder.")}
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

         </box></>}
      </box>

        {(() => {
          const footerInnerWidth = Math.max(0, termWidth - 6)
          const compact = footerInnerWidth < 118
            const footerRows = viewMode !== "main" ? [[], [], []] : compact ? [
              [["SPACE", "Select"], ["A", "All"], ["S", "Match"], ["/", "Search"], ["1-5", "Tabs"], ["S+L", "Layout"], ["F", "Fork"], ["D", "Del pipe"]],
              [["M", "Mod"], ["C", "Col"], ["P", "Perm"], ["G", "Del"], ["T", "Tun"], ["S+T", "Tier"], ["I", "Imp"], ["O", "Org"]],
              [["B", "Claude"], ["S+B", "Codex"], ["R", "Rename"], ["E", "Export"], ["V", "Repair"], ["U", "Resources"]]
            ] : [
              [["SPACE", "Select"], ["A", "All"], ["S", "Same model"], ["/", "Search"], ["1-5", "Inspector"], ["SHIFT+L", "Layout"], ["O", "Organization"], ["D", "Delete pipeline"]],
              [["M", "Model"], ["C", "Color"], ["P", "Permissions"], ["G", "Delegations"], ["T", "Tune"], ["SHIFT+T", "Tier"], ["I", "Import"], ["V", "Repair models"]],
              [["B", "Claude bridge"], ["SHIFT+B", "Codex bridge"], ["R", "Rename"], ["E", "Export"], ["F", "Fork"], ["U", "Skills/Tools"]]
          ]
         return (
           <box height={5} flexShrink={0} overflow="hidden" flexDirection="column" borderStyle="single" borderColor="#2B5581" paddingLeft={1} paddingRight={1}>
             {footerRows.map((row, rowIndex) => (
               <box key={rowIndex} height={1} flexShrink={0} flexDirection="row" overflow="hidden">
                 {row.map(([shortcut, action], index) => (
                   <React.Fragment key={shortcut}>
                      {index > 0 && <text wrapMode="none" flexShrink={0} style={{ textColor: "#E1E4E8" }}>{compact ? " " : " | "}</text>}
                     <text wrapMode="none" flexShrink={0} style={{ textColor: "#E1E4E8" }}>{`[${shortcut}]`}</text>
                     <text wrapMode="none" flexShrink={0} style={{ textColor: "#E1E4E8" }}>{` ${action}`}</text>
                   </React.Fragment>
                 ))}
               </box>
             ))}
           </box>
         )
       })()}

       {viewMode === "layout" && (
         <box style={{ position: "absolute", left: "10%", top: "24%", width: "80%", height: "52%" }} borderStyle="double" borderColor="cyan" backgroundColor="#1e1e1e" title=" Layout " titleColor="cyan" padding={1} flexDirection="column" justifyContent="space-between" overflow="hidden">
           <box flexDirection="column" overflow="hidden">
             <text style={{ textColor: "white" }} b>Adjust the normal list / inspector split</text>
             <text style={{ textColor: "cyan" }} marginTop={1}>{`List ${Math.round(layoutDraft * 100)}%  /  Inspector ${Math.round((1 - layoutDraft) * 100)}%`}</text>
             <text style={{ textColor: "gray" }} marginTop={1} wrapMode="none" overflow="hidden">{`[${"=".repeat(Math.max(1, Math.round(layoutDraft * 30)))}|${"-".repeat(Math.max(1, 30 - Math.round(layoutDraft * 30)))}]`}</text>
             <text style={{ textColor: "gray" }} marginTop={1}>Preview applies to normal mode; the inspector may be hidden at this width.</text>
             {configReadOnly && <text style={{ textColor: "yellow" }} marginTop={1}>Environment override is read-only: preview only; Enter will not save.</text>}
             {layoutError && <text style={{ textColor: "red" }} marginTop={1} wrapMode="none" overflow="hidden">{layoutError}</text>}
           </box>
           <box borderStyle="single" border={['top']} borderColor="#333333" paddingTop={1}>
             <text style={{ textColor: "gray" }}>←/→ or h/l adjust | ↑/↓ also adjust | Home .60 | End .75 | R reset</text>
             <text style={{ textColor: "green" }}>[ENTER] Save | [ESC] Cancel</text>
           </box>
         </box>
       )}

       {/* Modal - Permission Presets */}
      {viewMode === "permission-preset" && (
        <box
          style={{
            position: "absolute",
           left: "8%",
           top: "8%",
           width: "84%",
           height: "84%"
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
           title={` Delegation Manager: ${middleEllipsis(delegationTargetAgent.filename, 45)} `}
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
                       {middleEllipsis(ag.filename, 35)}
                    </text>
                    <text style={{ textColor: "yellow" }} width="20%">
                       {middleEllipsis(ag.category, 15)}
                    </text>
                    <text style={{ textColor: "gray" }} width="22%">
                       {middleEllipsis(ag.model.split("/").pop() || "", 15)}
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

      {viewMode === "resource-manager" && resourceCatalog && (
        <box
          style={{ position: "absolute", left: "10%", top: "8%", width: "80%", height: "84%" }}
          borderStyle="double"
          borderColor="#9B59B6"
          backgroundColor="#1e1e1e"
          title={` Resource Manager: ${resourceTargetAgent ? middleEllipsis(resourceTargetAgent.filename, 38) : resourceCategoryTarget} `}
          titleColor="#9B59B6"
          padding={1}
          flexDirection="column"
          justifyContent="space-between"
          overflow="hidden"
        >
          <box flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden">
            <text style={{ textColor: "white" }} flexShrink={0}>Toggle agent permissions and category companion links exported with the category.</text>
            <box flexDirection="column" marginTop={1} flexGrow={1} minHeight={0} overflow="hidden">
              {resourceTargetAgent && <text style={{ textColor: "yellow" }}>--- AGENT RESOURCES ---</text>}
              {visibleResourceRows.map((row, index) => {
                const rowIndex = resourceModalScrollOffset + index
                const item = row.item
                const isFocused = rowIndex === resourceModalFocusIndex
                if (row.section === "companion") {
                  const companion = item as SelectableCompanionItem
                  const linked = Boolean(resourceDraftCompanion[companion.relativePath])
                  const companionStart = resourceManagerRows.findIndex(candidate => candidate.section === "companion")
                  return <React.Fragment key={`${companion.id}-${rowIndex}`}>
                    {rowIndex === companionStart && <text style={{ textColor: "yellow" }}>{`--- CATEGORY COMPANION LINKS (${resourceCategoryTarget}) [exported with category] ---`}</text>}
                    <box backgroundColor={isFocused ? "#2B5581" : "transparent"} height={1} flexShrink={0} flexDirection="row">
                      <text width={8} style={{ textColor: linked ? "green" : "gray" }}>{linked ? "[x]" : "[ ]"}</text>
                      <text width={12} style={{ textColor: "magenta" }}>{`[LINK-${companion.group.toUpperCase()}]`}</text>
                      <text flexGrow={1} wrapMode="none" overflow="hidden" style={{ textColor: isFocused ? "white" : "#E1E4E8" }} u={isFocused}>{middleEllipsis(companion.relativePath, Math.max(1, panelWidths.inspector + panelWidths.list - 42))}</text>
                    </box>
                  </React.Fragment>
                }
                const agentResource = item as AgentResourceItem | AgentMcpResourceItem
                const allowed = row.kind === "skill-wildcard"
                  ? draftSkillAll
                  : row.kind === "skill"
                    ? draftAllowedSkills.has(agentResource.name)
                    : draftPermissions[agentResource.permissionKey]
                const tag = row.kind === "skill-wildcard" || row.kind === "skill" ? "[SKILL]"
                  : row.kind === "tool-family" ? "[TOOL-GRP]"
                    : row.kind === "tool" ? "[TOOL]" : "[MCP]"
                const mcpItem = agentResource as AgentMcpResourceItem
                const status = row.kind === "mcp"
                  ? mcpItem.configuredInOpencode
                    ? ` [MCP: ${draftMcpEnabled[mcpItem.serverKey] ? "ON" : "OFF"}]`
                    : mcpItem.recommendedInRepo
                      ? ` [MCP: ${draftMcpEnabled[mcpItem.serverKey] ? "ON (install to global)" : "Recommended (x to install)"}]`
                      : " [Not in global opencode.json]"
                  : ""
                return (
                  <box key={`${item.id}-${rowIndex}`} backgroundColor={isFocused ? "#2B5581" : "transparent"} height={1} flexShrink={0} flexDirection="row">
                    <text width={8} style={{ textColor: allowed ? "green" : "gray" }}>{allowed ? "[x]" : "[ ]"}</text>
                    <text width={12} style={{ textColor: "magenta" }}>{tag}</text>
                    <text flexGrow={1} wrapMode="none" overflow="hidden" style={{ textColor: isFocused ? "white" : "#E1E4E8" }} u={isFocused}>
                      {middleEllipsis(item.name, Math.max(1, panelWidths.inspector + panelWidths.list - 42))}
                    </text>
                    <text style={{ textColor: row.kind === "mcp" && (mcpItem.configuredInOpencode || mcpItem.recommendedInRepo) && draftMcpEnabled[mcpItem.serverKey] ? "green" : "gray" }}>{status}</text>
                  </box>
                )
              })}
            </box>
          </box>
          <box flexDirection="column" flexShrink={0} borderStyle="single" border={['top']} borderColor="#333333" paddingTop={1} overflow="hidden">
            {resourceManagerRows.length > maxVisibleResourceRows && <text style={{ textColor: "gray" }} flexShrink={0}>
              {`▲ ${resourceModalScrollOffset + 1}-${Math.min(resourceModalScrollOffset + maxVisibleResourceRows, resourceManagerRows.length)}/${resourceManagerRows.length} ▼`}
            </text>}
            <text style={{ textColor: "gray" }} wrapMode="none" overflow="hidden">Navigate: ↑/↓ | Space: Toggle | x: Toggle MCP | Enter: Save | Esc: Cancel</text>
          </box>
        </box>
      )}

      {/* Modal - Parameter Tuning */}
      {viewMode === "parameter-tuning" && (
        <box
          style={{
            position: "absolute",
            left: "15%",
             top: layout.mode === "compact" ? "0%" : "15%",
            width: "70%",
             height: layout.mode === "compact" ? "100%" : "70%"
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
          <box flexDirection="column" gap={layout.mode === "compact" ? 0 : 1} overflow="hidden" flexShrink={0}>
            <text height={1} flexShrink={0} wrapMode="none" overflow="hidden" style={{ textColor: "white" }}>
              Regulate execution limits, temperature, thinking effort, mode, and visibility:
            </text>

            {/* Steps field */}
            <box
              flexDirection="row"
              height={3}
              flexShrink={0}
              borderStyle="single"
              borderColor={tuningFocusedField === "steps" ? "#F1C40F" : "#333333"}
              paddingLeft={1}
              paddingRight={1}
               marginTop={layout.mode === "compact" ? 0 : 1}
            >
              <text width="60%" wrapMode="none" overflow="hidden" flexShrink={0} style={{ textColor: tuningFocusedField === "steps" ? "#F1C40F" : "gray" }} b>
                {tuningFocusedField === "steps" ? "► 1. Max Agentic Steps (e.g. 50):" : "  1. Max Agentic Steps:"}
              </text>
              <text width="40%" height={1} wrapMode="none" overflow="hidden" flexShrink={0} style={{ textColor: "white" }}>{!tuningDirtyFields.has("steps") && tuningSummary.steps.mixed ? tuningSummary.steps.displayMixed : `${tuningSteps}${!tuningDirtyFields.has("steps") && tuningTargetPaths.length > 1 ? " (unchanged)" : ""}`}</text>
            </box>

            {/* Temp field */}
            <box
              flexDirection="row"
              borderStyle="single"
              borderColor={tuningFocusedField === "temp" ? "#F1C40F" : "#333333"}
              height={3}
              flexShrink={0}
              paddingLeft={1}
              paddingRight={1}
            >
              <text width="60%" wrapMode="none" overflow="hidden" flexShrink={0} style={{ textColor: tuningFocusedField === "temp" ? "#F1C40F" : "gray" }} b>
                {tuningFocusedField === "temp" ? "► 2. Temperature (e.g. 0.1 - 0.7):" : "  2. Temperature:"}
              </text>
              <text width="40%" height={1} wrapMode="none" overflow="hidden" flexShrink={0} style={{ textColor: "white" }}>{!tuningDirtyFields.has("temp") && tuningSummary.temp.mixed ? tuningSummary.temp.displayMixed : `${tuningTemp}${!tuningDirtyFields.has("temp") && tuningTargetPaths.length > 1 ? " (unchanged)" : ""}`}</text>
            </box>

            {/* Thinking / Effort field */}
            <box
              flexDirection="column"
              height={4}
              flexShrink={0}
              borderStyle="single"
              borderColor={tuningFocusedField === "variant" ? "#F1C40F" : "#333333"}
              paddingLeft={1}
              paddingRight={1}
            >
              <box flexDirection="row" height={1}>
                <text width="60%" wrapMode="none" overflow="hidden" flexShrink={0} style={{ textColor: tuningFocusedField === "variant" ? "#F1C40F" : "gray" }} b>
                  {tuningFocusedField === "variant" ? "► 3. Thinking / Effort (variant):" : "  3. Thinking / Effort:"}
                </text>
                <text width="40%" wrapMode="none" overflow="hidden" flexShrink={0} style={{ textColor: "cyan" }}>
                  {!tuningDirtyFields.has("variant") && tuningSummary.variant.mixed ? tuningSummary.variant.displayMixed : `${tuningVariant || "(default / unset)"}${!tuningDirtyFields.has("variant") && tuningTargetPaths.length > 1 ? " (unchanged)" : ""}`}
                </text>
              </box>
              {tuningFocusedField === "variant" && <text height={1} wrapMode="none" overflow="hidden" style={{ textColor: "gray" }}>{modelVariants !== null && modelVariants.length > 0
                ? `[Space/←/→: model variants (${modelVariants.join(" | ")}) | type custom | Backspace: clear]`
                : modelVariants !== null
                  ? "[Model exposes no preset variants in OpenCode | type custom | Backspace: clear]"
                  : `[Space/←/→: none/${AGENT_EFFORT_VARIANTS.join("/")} | type custom | Backspace: clear]`}</text>}
            </box>

            {/* Mode field */}
            <box
              flexDirection="row"
              borderStyle="single"
              borderColor={tuningFocusedField === "mode" ? "#F1C40F" : "#333333"}
              height={3}
              flexShrink={0}
              paddingLeft={1}
              paddingRight={1}
            >
              <text width="60%" wrapMode="none" overflow="hidden" flexShrink={0} style={{ textColor: tuningFocusedField === "mode" ? "#F1C40F" : "gray" }} b>
                {tuningFocusedField === "mode" ? "► 4. Mode (Press SPACE to toggle):" : "  4. Mode:"}
              </text>
              <text width="40%" height={1} wrapMode="none" overflow="hidden" flexShrink={0} style={{ textColor: "yellow" }}>{!tuningDirtyFields.has("mode") && tuningSummary.mode.mixed ? tuningSummary.mode.displayMixed : `${tuningMode.toUpperCase()}${!tuningDirtyFields.has("mode") && tuningTargetPaths.length > 1 ? " (unchanged)" : ""}`}</text>
            </box>

            {/* Hidden field */}
            <box
              flexDirection="row"
              borderStyle="single"
              borderColor={tuningFocusedField === "hidden" ? "#F1C40F" : "#333333"}
              height={3}
              flexShrink={0}
              paddingLeft={1}
              paddingRight={1}
            >
              <text width="60%" wrapMode="none" overflow="hidden" flexShrink={0} style={{ textColor: tuningFocusedField === "hidden" ? "#F1C40F" : "gray" }} b>
                {tuningFocusedField === "hidden" ? "► 5. Hidden Status (Press SPACE to toggle):" : "  5. Hidden Status:"}
              </text>
              <text width="40%" height={1} wrapMode="none" overflow="hidden" flexShrink={0} style={{ textColor: tuningHidden ? "red" : "green" }}>{!tuningDirtyFields.has("hidden") && tuningSummary.hidden.mixed ? tuningSummary.hidden.displayMixed : `${tuningHidden ? "TRUE" : "FALSE"}${!tuningDirtyFields.has("hidden") && tuningTargetPaths.length > 1 ? " (unchanged)" : ""}`}</text>
            </box>
          </box>

          <box height={2} flexShrink={0} justifyContent="space-between" borderStyle="single" border={["top"]} borderColor="#333333" paddingTop={1} overflow="hidden" flexDirection="row">
            <text width="78%" wrapMode="none" overflow="hidden" style={{ textColor: "gray" }}>{middleEllipsis("[TAB/↑/↓] Switch Fields | [SPACE] Variant/Toggle | [ENTER] Save", 58)}</text>
            <text width="22%" wrapMode="none" overflow="hidden" style={{ textColor: "red" }} b>[ESC] Cancel</text>
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
                  ? diff.existsLocally === false
                    ? "⚠ NEW in OpenCode (Import available)"
                    : "⚠ MODIFIED in OpenCode (Import available)"
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
                       {middleEllipsis(diff.filename, 45)}
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
                   File: {middleEllipsis(importDiffs[focusedDiffIndex].filename, 50)}
                </text>
                <text style={{ textColor: importDiffs[focusedDiffIndex].hasDifferences ? "yellow" : "green" }}>
                  {importDiffs[focusedDiffIndex].hasDifferences ? "Changes detected between repo and OpenCode." : "File matches OpenCode export exactly."}
                </text>
              </box>
            )}
            {importDiffs[focusedDiffIndex] && !importDiffs[focusedDiffIndex].filename.endsWith(".md") && (
              <box flexDirection="column" marginTop={1} borderStyle="single" borderColor="#333333" padding={1} height={5} flexShrink={0} overflow="hidden">
                <text style={{ textColor: "yellow" }} b>Companion Resource:</text>
                <text style={{ textColor: "white" }}>{middleEllipsis(importDiffs[focusedDiffIndex].filename, 60)}</text>
                <text style={{ textColor: importDiffs[focusedDiffIndex].hasDifferences ? "yellow" : "green" }}>
                  {importDiffs[focusedDiffIndex].hasDifferences ? "Resource differs from OpenCode export." : "Resource matches OpenCode export exactly."}
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
               <text style={{ textColor: "yellow" }} b>{middleEllipsis(renameTargetAgent.filename, Math.max(1, Math.floor(termWidth * 0.7) - 8))}</text>
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
      {viewMode === "model-selector" || viewMode === "repair-selector" ? (
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
           title={viewMode === "repair-selector" ? ` Repair Model Group ${Number(repairGroupKey) + 1}/${invalidModelGroups.length} ` : " Select LLM Model "}
          titleColor="#00AAFF"
          padding={1}
          flexDirection="column"
          overflow="hidden"
        >
          <text style={{ textColor: "white" }} paddingBottom={1} flexShrink={0}>
             {viewMode === "repair-selector"
                ? middleEllipsis(`Choose an exact replacement for explicit model ${JSON.stringify(invalidModelGroups[Number(repairGroupKey)]?.value)} (${invalidModelGroups[Number(repairGroupKey)]?.agents.length || 0} agents):`, modelModalInnerWidth)
               : `Choose model to apply to ${selectedAgentPaths.size > 0 ? selectedAgentPaths.size : 1} selected agents:`}
          </text>
          {viewMode === "repair-selector" && invalidModelGroups[Number(repairGroupKey)] && (
            <text style={{ textColor: "gray" }}>
               Suggestions: {middleEllipsis(suggestModels(invalidModelGroups[Number(repairGroupKey)].value, modelCatalog).join(", ") || "none (choose from catalog below)", modelModalInnerWidth)}
            </text>
          )}

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
                    {middleEllipsis(isFocused && item.type === "model" ? `> ${item.label.trim()}` : item.label, modelModalInnerWidth)}
                  </text>
                </box>
              )
            })}
          </box>

          <box flexDirection="column" borderStyle="single" border={["top"]} borderColor="#333333" paddingTop={1} flexShrink={0}>
              <text width="100%" height={1} flexShrink={0} wrapMode="none" overflow="hidden" style={{ textColor: "gray" }}>{middleEllipsis(`Total: ${modelTreeItems.length} · Position: ${focusedModelIndex + 1}/${modelTreeItems.length}`, modelModalInnerWidth)}</text>
              <text width="100%" height={1} flexShrink={0} wrapMode="none" overflow="hidden" style={{ textColor: "gray" }}>{middleEllipsis("ENTER select · ↑/↓ browse", modelModalInnerWidth)}</text>
              <text width="100%" height={1} flexShrink={0} wrapMode="none" overflow="hidden" style={{ textColor: "gray" }}>{middleEllipsis("suggestions then catalog · ESC cancel", modelModalInnerWidth)}</text>
          </box>
        </box>
      ) : null}

      {/* Modal - Color Selection */}
      {viewMode === "tier-selector" && translationConfig && (() => {
        const tiers = Object.keys(translationConfig.tiers)
        const targets = selectedAgentPaths.size > 0 ? agents.filter(a => selectedAgentPaths.has(a.currentPath)) : (activeItems[focusedIndex]?.agent ? [activeItems[focusedIndex].agent!] : [])
        const states = targets.map(a => resolvedAgents.get(a.currentPath)).filter((state): state is ReturnType<typeof resolveModelTarget> => Boolean(state))
        const current = new Set(states.map(s => `${s!.tier} (${s!.source})`))
        return <box style={{ position: "absolute", left: "15%", top: "5%", width: "70%", height: "90%" }} borderStyle="double" borderColor="magenta" backgroundColor="#1e1e1e" title=" Assign Tier " titleColor="magenta" padding={1} flexDirection="column" overflow="hidden">
          <text style={{ textColor: "yellow" }} flexShrink={0}>Role-based assignment: basename, not an individual file.</text>
          <text style={{ textColor: "white" }} flexShrink={0}>{middleEllipsis(`Current: ${current.size > 1 ? `multiple tiers - ${Array.from(current).join(", ")}` : Array.from(current)[0] || "unknown"}`, 70)}</text>
          <box flexGrow={1} flexDirection="column" overflow="hidden">
            {tiers.slice(tierScrollOffset, tierScrollOffset + maxVisibleTiers).map((tier, index) => {
              const tierIndex = tierScrollOffset + index
              const isFocused = tierIndex === focusedTierIndex
              const tierConfig = translationConfig.tiers[tier]
              return (
                <box key={tier} flexDirection="column" flexShrink={0}>
                  <box height={1} backgroundColor={isFocused ? "magenta" : "transparent"}>
                    <text style={{ textColor: isFocused ? "white" : "cyan" }}>
                       {middleEllipsis(`${tier} - Claude: ${tierConfig.claude.model} | Codex: ${tierConfig.codex.model}`, 70)}
                    </text>
                  </box>
                   {isFocused && tierConfig.description && <text style={{ textColor: "gray" }}>{terminalSafeText(tierConfig.description)}</text>}
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
              Copy agents and replace the find pattern in filenames and content. Plain text is one literal replacement; for multiple replacements, enter go-, kimi-, hybrid-, free-. Brackets are optional for backward compatibility.
            </text>

            <box flexDirection="column" borderStyle="single" borderColor={forkFocusedField === "profile" ? "cyan" : "#333333"} paddingLeft={1} paddingRight={1} marginTop={1}>
              <text style={{ textColor: forkFocusedField === "profile" ? "cyan" : "gray" }} b>Pipeline profile: {forkProfileName || "(keep current models)"}</text>
              <text style={{ textColor: "gray" }}>{forkProfileName ? loadPipelineProfiles(workspaceRoot).profiles[forkProfileName]?.description || "" : "Use Up/Down while focused to choose a declarative model profile."}</text>
            </box>
            {forkProfileName && <box flexDirection="column" borderStyle="single" borderColor={forkFocusedField === "target" ? "cyan" : "#333333"} paddingLeft={1} paddingRight={1} marginTop={1}>
              <text style={{ textColor: forkFocusedField === "target" ? "cyan" : "gray" }} b>Target category: {forkProfileTarget || `${forkProfileName}-pipeline`}</text>
              <text style={{ textColor: "gray" }}>Same as source applies in place; another category forks and syncs the profile.</text>
            </box>}

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
                {forkFocusedField === "replace" ? "► Replace With String(s):" : "  Replace With String(s):"}
              </text>
              <text style={{ textColor: "white" }}>
                {forkReplaceQuery || "[ e.g. go- or go-, kimi-, hybrid-, free- ]"}
              </text>
            </box>
          </box>

          <box justifyContent="space-between" borderStyle="single" border={["top"]} borderColor="#333333" paddingTop={1}>
            <text style={{ textColor: "gray" }}>
              [TAB] Fields | [↑/↓] Profile | [ENTER] Fork / Apply Profile
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
                     {globalIndex === bridgeSuggestionIndex ? "► " : "  "}{middleEllipsis(prefix || "(empty)", 30)}  ({count} agents)
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
                {`Output: ${fs.existsSync(path.join(workspaceRoot, "export")) ? "export/bridges" : "bridges"}/${bridgeTarget === "codex" ? "codex" : "claude-code"}/${bridgePluginName || "..."}/`}
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
                : exportCategory
                  ? `1. ${agents.filter(agent => agent.category === exportCategory).length} agents in focused category '${exportCategory}' will be exported.`
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
           title={` ${middleEllipsis(actionResultTitle, 50)} `}
          titleColor="green"
          padding={1}
          flexDirection="column"
          overflow="hidden"
        >
          <box flexGrow={1} flexDirection="column" overflow="hidden" flexShrink={1}>
             {visibleActionResultLines.map((line, idx) => (
                <text key={actionResultScrollOffset + idx} style={{ textColor: line.startsWith("⚠ AUTO-COMMIT:") ? "yellow" : "white" }} flexShrink={0}>{terminalSafeText(line)}</text>
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
