import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { randomBytes } from "node:crypto"
import YAML from "yaml"
import { isPathInsideWorkspace, isWorkspaceRelativePath } from "./pathValidation.js"

function isValidFrontmatter(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length > 0
}

const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/

/**
 * Extract YAML frontmatter from agent file content, tolerating CRLF line endings.
 * Returns yamlText=null (and body=content) when no frontmatter block is present.
 */
export function extractFrontmatter(content: string): { yamlText: string | null; body: string } {
  const match = content.match(FRONTMATTER_RE)
  if (!match) return { yamlText: null, body: content }
  return { yamlText: match[1], body: content.substring(match[0].length) }
}

export interface AgentInfo {
  filename: string
  currentPath: string
  targetPath: string
  category: string
  description: string
  model: string
  rawContent: string
  frontmatter: Record<string, any>
  body: string
  allowedSubagents: string[]
}

export type AgentList = AgentInfo[] & { warnings?: string[] }

export interface NamingAnalysis {
  isValid: boolean
  family?: string
  category?: string
  role?: string
  errors: string[]
  suggestedName?: string
}

export interface PermissionSummary {
  bash: "allow" | "deny" | "ask" | "custom"
  edit: "allow" | "deny" | "ask" | "custom"
  read: "allow" | "deny" | "ask"
  taskCount: number
  riskLevel: "HIGH" | "MEDIUM" | "LOW"
}

export interface SafetyPreset {
  key: "readonly_scout" | "safe_builder" | "unrestricted_dev"
  name: string
  description: string
  permissions: Record<string, any>
}

export const SAFETY_PRESETS: SafetyPreset[] = [
  {
    key: "readonly_scout",
    name: "Read-Only Scout 🛡️",
    description: "Read, grep, glob & LSP allowed. Edit, write & bash denied.",
    permissions: {
      read: "allow",
      grep: "allow",
      glob: "allow",
      lsp: "allow",
      edit: "deny",
      write: "deny",
      bash: "deny"
    }
  },
  {
    key: "safe_builder",
    name: "Safe Builder 🛠️",
    description: "File modifications allowed (edit/write). Bash denied for security.",
    permissions: {
      read: "allow",
      grep: "allow",
      glob: "allow",
      lsp: "allow",
      edit: { "*": "allow" },
      write: { "*": "allow" },
      bash: "deny"
    }
  },
  {
    key: "unrestricted_dev",
    name: "Unrestricted Dev ⚡",
    description: "Full access: edit, write & bash execution allowed.",
    permissions: {
      read: "allow",
      grep: "allow",
      glob: "allow",
      lsp: "allow",
      edit: { "*": "allow" },
      write: { "*": "allow" },
      bash: { "*": "allow" }
    }
  }
]

export function getAgentPermissionSummary(agent: AgentInfo): PermissionSummary {
  const perm = agent.frontmatter.permission || {}

  let bashState: "allow" | "deny" | "ask" | "custom" = "deny"
  if (perm.bash === "allow" || perm.bash === true) bashState = "allow"
  else if (perm.bash === "deny" || perm.bash === false) bashState = "deny"
  else if (perm.bash === "ask") bashState = "ask"
  else if (perm.bash && typeof perm.bash === "object") bashState = "allow"

  let editState: "allow" | "deny" | "ask" | "custom" = "deny"
  if (perm.edit === "allow" || perm.edit === true) editState = "allow"
  else if (perm.edit === "deny" || perm.edit === false) editState = "deny"
  else if (perm.edit === "ask") editState = "ask"
  else if (perm.edit && typeof perm.edit === "object") editState = "allow"

  let readState: "allow" | "deny" | "ask" = "allow"
  if (perm.read === "deny" || perm.read === false) readState = "deny"
  else if (perm.read === "ask") readState = "ask"

  const taskCount = agent.allowedSubagents ? agent.allowedSubagents.length : 0

  let riskLevel: "HIGH" | "MEDIUM" | "LOW" = "LOW"
  if (bashState === "allow") riskLevel = "HIGH"
  else if (editState === "allow") riskLevel = "MEDIUM"

  return { bash: bashState, edit: editState, read: readState, taskCount, riskLevel }
}

export function applySafetyPreset(agents: AgentInfo[], presetKey: "readonly_scout" | "safe_builder" | "unrestricted_dev") {
  const preset = SAFETY_PRESETS.find(p => p.key === presetKey)
  if (!preset) return

  for (const agent of agents) {
    const existingPerm = agent.frontmatter.permission || {}
    const updatedFrontmatter = {
      ...agent.frontmatter,
      permission: {
        ...existingPerm,
        ...preset.permissions
      }
    }
    saveAgentFile(agent.currentPath, updatedFrontmatter, agent.body)
    agent.frontmatter = updatedFrontmatter
  }
}

export function updateAgentParams(
  agents: AgentInfo[],
  params: { steps?: number; temperature?: number; mode?: string; hidden?: boolean }
) {
  for (const agent of agents) {
    const updatedFrontmatter = { ...agent.frontmatter }
    if (params.steps !== undefined) updatedFrontmatter.steps = params.steps
    if (params.temperature !== undefined) updatedFrontmatter.temperature = params.temperature
    if (params.mode !== undefined) updatedFrontmatter.mode = params.mode
    if (params.hidden !== undefined) updatedFrontmatter.hidden = params.hidden

    saveAgentFile(agent.currentPath, updatedFrontmatter, agent.body)
    agent.frontmatter = updatedFrontmatter
  }
}

export interface PermissionOrderAnalysis {
  hasOrderError: boolean
  erroneousCategories: string[]
}

/**
 * Checks if wildcard '*' is placed FIRST in permission map objects.
 * OpenCode permission evaluation order: LAST matching rule wins.
 * Therefore, wildcard '*' MUST be the FIRST key in the object dictionary!
 */
export function analyzePermissionOrder(agent: AgentInfo): PermissionOrderAnalysis {
  const perm = agent.frontmatter.permission
  if (!perm || typeof perm !== "object") return { hasOrderError: false, erroneousCategories: [] }

  const erroneousCategories: string[] = []

  for (const [categoryKey, val] of Object.entries(perm)) {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const keys = Object.keys(val)
      if (keys.includes("*") && keys[0] !== "*") {
        erroneousCategories.push(categoryKey)
      }
    }
  }

  return {
    hasOrderError: erroneousCategories.length > 0,
    erroneousCategories
  }
}

/**
 * Reorders permission dictionaries so that wildcard '*' is placed FIRST.
 */
export function fixPermissionOrder(agent: AgentInfo): boolean {
  const perm = agent.frontmatter.permission
  if (!perm || typeof perm !== "object") return false

  let modified = false
  const updatedPerm: Record<string, any> = { ...perm }

  for (const [catKey, val] of Object.entries(perm)) {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const keys = Object.keys(val)
      if (keys.includes("*") && keys[0] !== "*") {
        // Reorder object so '*' comes first
        const reorderedObj: Record<string, any> = {}
        reorderedObj["*"] = val["*"]
        for (const k of keys) {
          if (k !== "*") {
            reorderedObj[k] = val[k]
          }
        }
        updatedPerm[catKey] = reorderedObj
        modified = true
      }
    }
  }

  if (modified) {
    const updatedFrontmatter = { ...agent.frontmatter, permission: updatedPerm }
    saveAgentFile(agent.currentPath, updatedFrontmatter, agent.body)
    agent.frontmatter = updatedFrontmatter
  }

  return modified
}

export function updateAgentDelegations(
  agent: AgentInfo,
  allowedSubagentNames: string[]
) {
  const existingPerm = agent.frontmatter.permission || {}
  
  // OpenCode rule: wildcard '*' MUST be first!
  const taskObj: Record<string, string> = { "*": "deny" }

  allowedSubagentNames.forEach(name => {
    taskObj[name] = "allow"
  })

  const updatedFrontmatter = {
    ...agent.frontmatter,
    permission: {
      ...existingPerm,
      task: taskObj
    }
  }

  saveAgentFile(agent.currentPath, updatedFrontmatter, agent.body)
  agent.frontmatter = updatedFrontmatter
  agent.allowedSubagents = allowedSubagentNames
}

export interface AgentDiffResult {
  filename: string
  localPath: string
  exportPath: string
  existsInExport: boolean
  hasDifferences: boolean
  localContent: string
  exportContent: string
}

export function compareAgentWithExport(agent: AgentInfo): AgentDiffResult {
  const exportDir = getExportDestination()
  const exportPath = path.join(exportDir, agent.filename)

  if (!fs.existsSync(exportPath)) {
    return {
      filename: agent.filename,
      localPath: agent.currentPath,
      exportPath,
      existsInExport: false,
      hasDifferences: true,
      localContent: agent.rawContent,
      exportContent: ""
    }
  }

  const exportContent = fs.readFileSync(exportPath, "utf-8")
  const hasDifferences = agent.rawContent !== exportContent

  return {
    filename: agent.filename,
    localPath: agent.currentPath,
    exportPath,
    existsInExport: true,
    hasDifferences,
    localContent: agent.rawContent,
    exportContent
  }
}

export function importAgents(workspaceRoot: string, selectedFilenames?: string[]): { imported: string[]; backupPath: string | null } {
  const exportDir = getExportDestination()
  if (!fs.existsSync(exportDir)) {
    throw new Error(`OpenCode agents directory not found at: ${exportDir}`)
  }

  const backupsPath = createBackup(workspaceRoot)

  const files = fs.readdirSync(exportDir).filter(f => f.endsWith(".md"))
  const toImport = selectedFilenames && selectedFilenames.length > 0
    ? files.filter(f => selectedFilenames.includes(f))
    : files

  const imported: string[] = []

  for (const filename of toImport) {
    const src = path.join(exportDir, filename)
    const dest = path.join(workspaceRoot, "general", "agents", filename)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(src, dest)
    imported.push(filename)
  }

  return { imported, backupPath: backupsPath }
}

export function auditSecurityPermissions(agents: AgentInfo[]) {
  const highRisk: { agent: AgentInfo; reason: string }[] = []
  const mediumRisk: { agent: AgentInfo; reason: string }[] = []
  const orderErrors: { agent: AgentInfo; categories: string[] }[] = []
  const lowRisk: AgentInfo[] = []

  for (const agent of agents) {
    const summary = getAgentPermissionSummary(agent)
    const orderAnalysis = analyzePermissionOrder(agent)

    if (orderAnalysis.hasOrderError) {
      orderErrors.push({ agent, categories: orderAnalysis.erroneousCategories })
    }

    if (summary.riskLevel === "HIGH") {
      highRisk.push({ agent, reason: "BASH execution allowed ('bash: allow')" })
    } else if (summary.riskLevel === "MEDIUM") {
      mediumRisk.push({ agent, reason: "File edit allowed ('edit: allow')" })
    } else {
      lowRisk.push(agent)
    }
  }

  return { highRisk, mediumRisk, orderErrors, lowRisk }
}

/**
 * Computes recurring prefixes across filenames to identify known categories or family-category pairs.
 * E.g., 'copilot-pipeline', 'go-pipeline', 'slides', 'docs', 'wiki'.
 */
export function getKnownPrefixes(filenames: string[]): string[] {
  const prefixCounts: Record<string, number> = {}
  const uniqueFilenames = Array.from(new Set(filenames.map(f => f.replace(/\.md$/, ""))))

  uniqueFilenames.forEach(name => {
    const parts = name.split("-")
    for (let i = 1; i < parts.length && i <= 2; i++) {
      const prefix = parts.slice(0, i).join("-")
      prefixCounts[prefix] = (prefixCounts[prefix] || 0) + 1
    }
  })

  // Prefixes appearing in >= 2 files are recurring categories/families
  return Object.keys(prefixCounts)
    .filter(prefix => prefixCounts[prefix] > 1)
    .sort((a, b) => b.length - a.length)
}

/**
 * Analyzes an agent filename against the naming convention:
 * [{family}-]{category}-{role_with_underscores}.md
 * 
 * Optionally accepts allFilenames to intelligently detect recurring category/family prefixes
 * (e.g. 'slides-html-writer' -> category='slides', role='html_writer').
 */
export function analyzeAgentName(filename: string, allFilenames?: string[]): NamingAnalysis {
  const cleanName = filename.replace(/\.md$/, "")
  const errors: string[] = []

  let family: string | undefined
  let category: string
  let rawRole: string

  // If allFilenames is supplied, find matching recurring prefix
  let matchedPrefix: string | undefined
  if (allFilenames && allFilenames.length > 0) {
    const knownPrefixes = getKnownPrefixes(allFilenames)
    matchedPrefix = knownPrefixes.find(p => cleanName === p || cleanName.startsWith(p + "-"))
  }

  if (matchedPrefix && cleanName !== matchedPrefix) {
    const prefixParts = matchedPrefix.split("-")
    if (prefixParts.length === 2) {
      family = prefixParts[0]
      category = prefixParts[1]
    } else {
      category = prefixParts[0]
    }
    rawRole = cleanName.substring(matchedPrefix.length + 1)
  } else {
    // Fallback: split by hyphens
    const parts = cleanName.split("-")
    if (parts.length < 2) {
      errors.push("Missing category separator (must be at least {category}-{role})")
      const rolePart = cleanName.replace(/[\s-]/g, "_")
      return {
        isValid: false,
        role: rolePart,
        errors,
        suggestedName: `general-${rolePart}.md`
      }
    }

    if (parts.length >= 3) {
      family = parts[0]
      category = parts[1]
      rawRole = parts.slice(2).join("-")
    } else {
      category = parts[0]
      rawRole = parts.slice(1).join("-")
    }
  }

  const suggestedRole = rawRole.replace(/[\s-]/g, "_")

  if (rawRole.includes("-") || rawRole.includes(" ")) {
    errors.push("Multi-word role uses hyphens/spaces instead of underscores ('_' required for role)")
  }

  const isValid = errors.length === 0
  const suggestedFilename = family
    ? `${family}-${category}-${suggestedRole}.md`
    : `${category}-${suggestedRole}.md`

  return {
    isValid,
    family,
    category,
    role: rawRole,
    errors,
    suggestedName: isValid ? filename : suggestedFilename
  }
}

/**
 * Renames an agent file and updates all cross-references in permission.task blocks across all agent files.
 */
export function renameAgent(
  workspaceRoot: string,
  oldPath: string,
  newFilename: string,
  agents: AgentInfo[]
): { success: boolean; updatedReferences: string[]; skipped: string[]; newPath: string; error?: string; backupPath?: string | null } {
  if (!newFilename.endsWith(".md")) {
    newFilename += ".md"
  }
  newFilename = sanitizeFilename(newFilename)
  const backupPath = createBackup(workspaceRoot)

  const oldFilename = path.basename(oldPath)
  const oldNameNoExt = oldFilename.replace(/\.md$/, "")
  const newNameNoExt = newFilename.replace(/\.md$/, "")

  const dir = path.dirname(oldPath)
  const newPath = path.join(dir, newFilename)
  const resolvedDir = path.resolve(dir)
  if (!path.resolve(newPath).startsWith(resolvedDir + path.sep)) {
    throw new Error(`Invalid target path outside the agent directory: ${newFilename}`)
  }

  if (fs.existsSync(newPath) && oldPath !== newPath) {
    throw new Error(`Target file already exists: ${newPath}`)
  }

  // Prepare all reference updates before mutating the filesystem.
  const updatedReferences: string[] = []
  const skipped: string[] = []
  const pendingWrites: { filePath: string; frontmatter: Record<string, any>; body: string }[] = []

  for (const agent of agents) {
    const filePath = agent.currentPath === oldPath ? newPath : agent.currentPath
    const readPath = agent.currentPath === oldPath ? oldPath : agent.currentPath
    if (!fs.existsSync(readPath)) continue

    const content = fs.readFileSync(readPath, "utf-8")
    if (!content.includes(oldNameNoExt)) continue

    const { yamlText, body } = extractFrontmatter(content)
    if (yamlText === null) {
      skipped.push(path.basename(filePath))
      continue
    }

    let frontmatter: Record<string, any>
    try {
      const parsed = YAML.parse(yamlText)
      if (!isValidFrontmatter(parsed)) {
        skipped.push(path.basename(filePath))
        continue
      }
      frontmatter = parsed
    } catch (e) {
      skipped.push(path.basename(filePath))
      continue
    }

    let modified = false
    const taskPerm = frontmatter.permission?.task
    if (taskPerm && typeof taskPerm === "object" && !Array.isArray(taskPerm)) {
      if (oldNameNoExt in taskPerm) {
        const value = taskPerm[oldNameNoExt]
        delete taskPerm[oldNameNoExt]
        taskPerm[newNameNoExt] = value
        modified = true
      }
    }

    // Also check raw body references if old name appears as subagent call
    let newBody = body
    const referenceRegex = new RegExp("@" + escapeRegExp(oldNameNoExt) + "(?![A-Za-z0-9_-])", "g")
    if (referenceRegex.test(body)) {
      referenceRegex.lastIndex = 0
      newBody = body.replace(referenceRegex, `@${newNameNoExt}`)
      if (newBody !== body) {
        modified = true
      }
    }

    if (modified) {
      pendingWrites.push({ filePath, frontmatter, body: newBody })
      updatedReferences.push(path.basename(filePath))
    }
  }

  // Rename is the last structural mutation; reference writes follow it.
  fs.renameSync(oldPath, newPath)
  try {
    for (const write of pendingWrites) {
      saveAgentFile(write.filePath, write.frontmatter, write.body)
    }
  } catch (e: any) {
    return {
      success: false,
      updatedReferences: [],
      skipped,
      newPath,
      backupPath,
      error: `Agent renamed, but reference updates were only partially flushed. Backup: ${backupPath || "none"}. ${e?.message || e}`
    }
  }

  return { success: true, updatedReferences, skipped, newPath, backupPath }
}

export function sanitizeFilename(name: string): string {
  if (!name || name.startsWith(".") || name.includes("..") || name.includes("\0") || /[\\/]/.test(name) || !/^[a-zA-Z0-9._-]+$/.test(name)) {
    throw new Error(`Invalid filename '${name}'. Use only letters, numbers, '.', '_' and '-'.`)
  }
  return name
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// Ignore directories that are not related to agents
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".opencode",
  "agent-manager",
  "backups",
  "dist",
  "build"
])

/**
 * Dynamically desumes categories from a list of agent filenames.
 * If a prefix (split by '-') appears in more than 1 file, it is considered a category.
 * Longest prefix matches are preferred. Fallback is "general".
 */
export function computeCategories(filenames: string[]): Record<string, string> {
  const prefixCounts = countCategoryPrefixes(filenames)

  // Filter prefixes that appear in > 1 file
  const validPrefixes = Object.keys(prefixCounts)
    .filter(prefix => prefixCounts[prefix] > 1)
    .sort((a, b) => b.length - a.length) // longest first

  const mapping: Record<string, string> = {}
  filenames.forEach(filename => {
    const nameWithoutExt = filename.replace(/\.md$/, "")
    const match = validPrefixes.find(prefix =>
      nameWithoutExt === prefix || nameWithoutExt.startsWith(prefix + "-")
    )
    mapping[filename] = match || "general"
  })

  return mapping
}

/** Return the category prefixes recognised by computeCategories and their counts. */
export function getCategoryPrefixes(filenames: string[]): Array<{ prefix: string; count: number }> {
  return Object.entries(countCategoryPrefixes(filenames))
    .filter(([, count]) => count > 1)
    .sort(([a], [b]) => b.length - a.length)
    .map(([prefix, count]) => ({ prefix: `${prefix}-`, count }))
}

function countCategoryPrefixes(filenames: string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  Array.from(new Set(filenames)).forEach(filename => {
    const parts = filename.replace(/\.md$/, "").split("-")
    for (let i = 1; i < parts.length; i++) {
      const prefix = parts.slice(0, i).join("-")
      counts[prefix] = (counts[prefix] || 0) + 1
    }
  })
  return counts
}

/**
 * Recursively find all agent markdown files in the workspace (under any folder named 'agents').
 */
export function findAgentFiles(workspaceRoot: string, sourceDir: string = "general"): AgentList {
  if (!isWorkspaceRelativePath(sourceDir)) {
    throw new Error(`sourceDir must stay inside workspace; received '${sourceDir}'`)
  }
  const resolvedRoot = path.resolve(workspaceRoot)
  const sourceRoot = path.resolve(resolvedRoot, sourceDir)
  if (!isPathInsideWorkspace(workspaceRoot, sourceDir)) {
    throw new Error(`sourceDir must stay inside workspace; received '${sourceDir}'`)
  }
  if (!fs.existsSync(sourceRoot) || !fs.statSync(sourceRoot).isDirectory()) {
    throw new Error(`Agent source directory does not exist: ${sourceRoot} (sourceDir='${sourceDir}')`)
  }
  const agents: AgentInfo[] = []

  function walk(dir: string) {
    const basename = path.basename(dir)
    if (IGNORED_DIRS.has(basename)) {
      return
    }

    let stats: fs.Stats
    try {
      stats = fs.statSync(dir)
    } catch {
      return
    }

    if (stats.isDirectory()) {
      const files = fs.readdirSync(dir)
      const isAgentsDir = basename === "agents"

      for (const file of files) {
        const fullPath = path.join(dir, file)
        if (isAgentsDir && file.endsWith(".md")) {
          try {
            const agent = parseAgentFile(fullPath, workspaceRoot)
            if (agent) {
              agents.push(agent)
            }
          } catch (e) {
            console.error(`Error parsing agent file ${file}:`, e)
          }
        } else {
          walk(fullPath)
        }
      }
    }
  }

  walk(sourceRoot)
  if (agents.length === 0) (agents as AgentList).warnings = [`No agents found under sourceDir '${sourceDir}' (${sourceRoot})`]

  // Compute categories dynamically based on filename prefix frequency analysis
  const filenames = agents.map(a => a.filename)
  const categoryMap = computeCategories(filenames)

  agents.forEach(agent => {
    agent.category = categoryMap[agent.filename]
    agent.targetPath = path.join(workspaceRoot, "categories", agent.category, "agents", agent.filename)
  })

  return agents
}

/**
 * Parse an agent markdown file to extract frontmatter and content.
 */
export function parseAgentFile(filePath: string, workspaceRoot: string): AgentInfo | null {
  if (!fs.existsSync(filePath)) return null

  const content = fs.readFileSync(filePath, "utf-8")
  const filename = path.basename(filePath)

  let frontmatter: Record<string, any> = {}
  let body = content

  const { yamlText, body: contentBody } = extractFrontmatter(content)
  if (yamlText !== null) {
    body = contentBody
    try {
      const parsed = YAML.parse(yamlText)
      if (isValidFrontmatter(parsed)) {
        frontmatter = parsed
      }
    } catch (e) {
      console.error(`YAML parsing error in ${filePath}:`, e)
    }
  }

  // Temporary category assignment; updated dynamically in findAgentFiles
  const category = detectCategory(filename)
  const targetPath = path.join(workspaceRoot, "categories", category, "agents", filename)

  // Parse permission.task to extract allowed subagents list
  const allowedSubagents: string[] = []
  const taskPerm = frontmatter.permission?.task
  if (taskPerm && typeof taskPerm === "object" && !Array.isArray(taskPerm)) {
    for (const [name, value] of Object.entries(taskPerm)) {
      if (name !== "*" && (value === "allow" || value === true)) {
        allowedSubagents.push(name)
      }
    }
  }

  return {
    filename,
    currentPath: filePath,
    targetPath,
    category,
    description: frontmatter.description || "",
    model: frontmatter.model || "",
    rawContent: content,
    frontmatter,
    body,
    allowedSubagents
  }
}

/**
 * Detect category from agent filename prefix (fallback/backwards compatibility).
 */
export function detectCategory(filename: string, allFilenames?: string[]): string {
  if (allFilenames) {
    const map = computeCategories(allFilenames)
    return map[filename] || "general"
  }
  const parts = filename.replace(/\.md$/, "").split("-")
  if (parts.length > 1) {
    return parts[0]
  }
  return "general"
}

/**
 * Write updated frontmatter and body back to an agent file.
 */
export function normalizeAgentBody(body: string): string {
  return body.replace(/^(?:[ \t]*\r?\n)+/, "")
}

export function saveAgentFile(filePath: string, frontmatter: Record<string, any>, body: string) {
  if (!isValidFrontmatter(frontmatter)) {
    throw new Error(`Invalid frontmatter for agent file: ${filePath}`)
  }
  const yamlText = YAML.stringify(frontmatter).trim()
  const normalizedBody = normalizeAgentBody(body)
  const content = normalizedBody
    ? `---\n${yamlText}\n---\n\n${normalizedBody}`
    : `---\n${yamlText}\n---\n`
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${randomBytes(6).toString("hex")}.tmp`
  try {
    fs.writeFileSync(tempPath, content, "utf-8")
    fs.renameSync(tempPath, filePath)
  } catch (e) {
    try { fs.unlinkSync(tempPath) } catch {}
    throw e
  }
}

/**
 * Create a timestamped backup of the general/ directory under backups/.
 */
export function createBackup(workspaceRoot: string): string | null {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  const backupDir = path.join(workspaceRoot, "backups", `backup_${timestamp}`, "general")
  const generalDir = path.join(workspaceRoot, "general")

  if (fs.existsSync(generalDir)) {
    fs.mkdirSync(backupDir, { recursive: true })
    fs.cpSync(generalDir, backupDir, { recursive: true })
    return backupDir
  }
  return null
}

/**
 * True when the path points inside a `general/agents` directory
 * (separator-agnostic, so it works with POSIX and Windows paths).
 */
export function isInGeneralAgents(p: string): boolean {
  return /(^|[/\\])general[/\\]agents([/\\]|$)/.test(p)
}

/**
 * Reorganize agents by copying them to their corresponding category directory
 * and adding/updating the "category" key in the copy's frontmatter.
 */
export function organizeAgents(workspaceRoot: string, agents: AgentInfo[]): { copied: string[]; skipped: string[]; backupsPath: string | null } {
  const copied: string[] = []
  const skipped: string[] = []
  const protectedCategories = discoverManifestCategories(workspaceRoot)
  const eligible = agents.filter(agent => isInGeneralAgents(agent.currentPath) && agent.currentPath !== agent.targetPath && !protectedCategories.has(agent.category))
  for (const agent of agents) {
    if (isInGeneralAgents(agent.currentPath) && agent.currentPath !== agent.targetPath && protectedCategories.has(agent.category)) skipped.push(`${agent.filename} (category '${agent.category}' is manifest-backed; run category build ${agent.category})`)
  }
  // Do not create a backup when every requested destination is protected.
  const backupsPath = eligible.length > 0 ? createBackup(workspaceRoot) : null
  for (const agent of agents) {
    const isOriginal = isInGeneralAgents(agent.currentPath)
    const isAtTarget = agent.currentPath === agent.targetPath

    if (isOriginal && !isAtTarget && !protectedCategories.has(agent.category)) {
      const sourceContent = fs.readFileSync(agent.currentPath, "utf-8")
      const { yamlText } = extractFrontmatter(sourceContent)
      if (yamlText === null) {
        skipped.push(agent.filename)
        continue
      }
      try {
        if (!isValidFrontmatter(YAML.parse(yamlText))) {
          skipped.push(agent.filename)
          continue
        }
      } catch {
        skipped.push(agent.filename)
        continue
      }
      const targetDir = path.dirname(agent.targetPath)
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true })
      }

      fs.copyFileSync(agent.currentPath, agent.targetPath)

      const copyInfo = parseAgentFile(agent.targetPath, workspaceRoot)
      if (copyInfo && isValidFrontmatter(copyInfo.frontmatter)) {
        copyInfo.frontmatter.category = agent.category
        saveAgentFile(agent.targetPath, copyInfo.frontmatter, copyInfo.body)
      } else {
        skipped.push(agent.filename)
        continue
      }

      copied.push(`${agent.filename} -> categories/${agent.category}/agents/`)
    }
  }

  return { copied, skipped, backupsPath }
}

/** Return manifest-backed category IDs without following symlinks. */
export function discoverManifestCategories(workspaceRoot: string): Set<string> {
  const result = new Set<string>()
  const dir = path.join(workspaceRoot, ".agent-manager", "categories")
  try {
    const managerDir = path.join(workspaceRoot, ".agent-manager")
    let current = path.resolve(workspaceRoot)
    for (const part of path.relative(current, dir).split(path.sep).filter(Boolean)) {
      current = path.join(current, part)
      if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error(`Refusing organize: path component is a symlink: ${current}`)
    }
    if (fs.existsSync(managerDir) && fs.lstatSync(managerDir).isSymbolicLink()) throw new Error("Refusing organize: .agent-manager is a symlink")
    if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) throw new Error("Refusing organize: .agent-manager/categories is a symlink")
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".json")) continue
      const file = path.join(dir, name)
      const stat = fs.lstatSync(file)
      if (stat.isSymbolicLink()) throw new Error(`Refusing organize: category manifest is a symlink: ${name}`)
      if (!stat.isFile()) continue
      const id = name.slice(0, -5)
      if (/^[a-z0-9][a-z0-9-]*$/.test(id)) result.add(id)
    }
  } catch (error: any) { if (error.code !== "ENOENT") throw error }
  return result
}

/**
 * Batch update the model of multiple agents.
 */
export function updateAgentsModel(agents: AgentInfo[], model: string) {
  for (const agent of agents) {
    const updatedFrontmatter = { ...agent.frontmatter, model }
    saveAgentFile(agent.currentPath, updatedFrontmatter, agent.body)
    
    agent.model = model
    agent.frontmatter = updatedFrontmatter
  }
}

/**
 * Batch update the color of multiple agents.
 */
export function updateAgentsColor(agents: AgentInfo[], color: string) {
  for (const agent of agents) {
    const updatedFrontmatter = { ...agent.frontmatter, color }
    saveAgentFile(agent.currentPath, updatedFrontmatter, agent.body)
    agent.frontmatter = updatedFrontmatter
  }
}

export interface ForkResult {
  copied: string[]
  skipped: string[]
  backupsPath: string | null
}

/**
 * Fork a category by copying all its agents inside general/agents/,
 * substituting patterns in filename and file contents, and preserving target LLM models on overwrite.
 */
export function forkCategory(
  workspaceRoot: string,
  sourceCategory: string,
  findStr: string,
  replaceStr: string,
  selectedPaths?: string[]
): ForkResult {
  // Create backup first
  const backupsPath = createBackup(workspaceRoot)

  // Find all agents under general/agents/ belonging to sourceCategory
  const allAgents = findAgentFiles(workspaceRoot, "general")
  let sourceAgents = allAgents.filter(
    (agent) => agent.category === sourceCategory && isInGeneralAgents(agent.currentPath)
  )

  // If specific files are selected, only fork those selected files
  if (selectedPaths && selectedPaths.length > 0) {
    const selectedSet = new Set(selectedPaths)
    sourceAgents = sourceAgents.filter((agent) => selectedSet.has(agent.currentPath))
  }

  const copied: string[] = []
  const skipped: string[] = []

  for (const agent of sourceAgents) {
    const filename = agent.filename
    // Compute target filename by replacing findStr with replaceStr
    const newFilename = sanitizeFilename(filename.split(findStr).join(replaceStr))
    const targetPath = path.join(workspaceRoot, "general", "agents", newFilename)
    const targetDir = path.join(workspaceRoot, "general", "agents")
    if (!path.resolve(targetPath).startsWith(path.resolve(targetDir) + path.sep)) {
      throw new Error(`Invalid fork target path: ${newFilename}`)
    }
    if (path.resolve(targetPath) === path.resolve(agent.currentPath)) {
      skipped.push(filename)
      continue
    }

    let existingModel = ""
    if (fs.existsSync(targetPath)) {
      // If target file already exists, read its frontmatter to preserve the model
      const existingInfo = parseAgentFile(targetPath, workspaceRoot)
      if (existingInfo && existingInfo.frontmatter && existingInfo.frontmatter.model) {
        existingModel = existingInfo.frontmatter.model
      }
    }

    // Read source agent's raw content
    const sourceContent = fs.readFileSync(agent.currentPath, "utf-8")

    // Replace all instances of findStr with replaceStr in the raw content
    const updatedContent = sourceContent.split(findStr).join(replaceStr)

    // Parse the updated content to frontmatter and body
    let frontmatter: Record<string, any>
    const { yamlText, body } = extractFrontmatter(updatedContent)

    if (yamlText === null) {
      skipped.push(filename)
      continue
    }
    try {
      frontmatter = YAML.parse(yamlText)
      if (!isValidFrontmatter(frontmatter)) {
        skipped.push(filename)
        continue
      }
    } catch (e) {
      skipped.push(filename)
      continue
    }

    // Preserve the existing target model if overwritten, otherwise keep what was generated/copied
    if (existingModel) {
      frontmatter.model = existingModel
    }

    // Save the new file
    saveAgentFile(targetPath, frontmatter, body)
    copied.push(`${filename} -> ${newFilename}`)
  }

  return { copied, skipped, backupsPath }
}

export interface ExportResult {
  exported: string[]
  backupPath: string
  destinationPath: string
  skipped: string[]
}

/**
 * Get the opencode agents destination path (portable: uses os.homedir()).
 */
export function getExportDestination(env: NodeJS.ProcessEnv = process.env): string {
  const configHome = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  return path.join(configHome, "opencode", "agents")
}

/**
 * Export agents to ~/.config/opencode/agents/ with full overwrite.
 * Creates a single disaster-recovery backup of the destination folder
 * at ~/.config/opencode/agents_backup/ (overwritten each time).
 */
export function exportAgents(
  agents: AgentInfo[],
  selectedPaths?: Set<string>
): ExportResult {
  const destinationPath = getExportDestination()
  const backupPath = path.join(path.dirname(destinationPath), "agents_backup")

  // Determine which agents to export
  const toExport = selectedPaths && selectedPaths.size > 0
    ? agents.filter((a) => selectedPaths.has(a.currentPath))
    : agents

  // Create disaster-recovery backup of current destination (if it exists)
  if (fs.existsSync(destinationPath)) {
    const tempBackupPath = `${backupPath}.tmp-${Date.now()}`
    try {
      fs.cpSync(destinationPath, tempBackupPath, { recursive: true })
      if (fs.existsSync(backupPath)) {
        fs.rmSync(backupPath, { recursive: true, force: true })
      }
      fs.renameSync(tempBackupPath, backupPath)
    } catch (error) {
      if (fs.existsSync(tempBackupPath)) fs.rmSync(tempBackupPath, { recursive: true, force: true })
      throw error
    }
  }

  // Ensure destination directory exists
  if (!fs.existsSync(destinationPath)) {
    fs.mkdirSync(destinationPath, { recursive: true })
  }

  const exported: string[] = []
  const skipped: string[] = []

  for (const agent of toExport) {
    try {
      const targetFile = path.join(destinationPath, sanitizeFilename(agent.filename))
      fs.copyFileSync(agent.currentPath, targetFile)
      exported.push(agent.filename)
    } catch (error: any) {
      skipped.push(`${agent.filename}: ${error.message || error}`)
    }
  }

  return { exported, backupPath, destinationPath, skipped }
}
