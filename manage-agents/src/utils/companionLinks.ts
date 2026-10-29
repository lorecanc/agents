import fs from "node:fs"
import path from "node:path"
import { isWorkspaceRelativePath } from "./pathValidation.js"

export interface CompanionCategoryLinks {
  plugins: string[]
  commands: string[]
  skills: string[]
  tools: string[]
}

export interface CompanionLinksConfig {
  version: 1
  categories: Record<string, CompanionCategoryLinks>
}

export type CompanionResourceGroup = "plugin" | "command" | "skill" | "tool"

export interface SelectableCompanionItem {
  id: string
  group: CompanionResourceGroup
  relativePath: string
  label: string
  linked: boolean
}

const GROUPS = ["plugins", "commands", "skills", "tools"] as const
type CompanionLinksGroup = typeof GROUPS[number]

export const DEFAULT_COMPANION_LINKS: CompanionLinksConfig = {
  version: 1,
  categories: {
    pipeline: {
      plugins: ["plugins/pipeline-guard.js"],
      commands: [
        "commands/pipeline-bug.md",
        "commands/pipeline-feature.md",
        "commands/pipeline-ops.md",
        "commands/pipeline-refactor.md",
        "commands/pipeline-research.md"
      ],
      skills: ["skills/code-review-antipatterns"],
      tools: [
        "tools/pipeline_commit.ts",
        "tools/pipeline_serve.ts",
        "tools/pipeline_smoke.ts",
        "tools/pipeline_state.ts",
        "tools/pipeline_verify.ts"
      ]
    },
    slides: {
      plugins: [],
      commands: ["commands/new-slides.md", "commands/fix-slide.md", "commands/polish-slides.md"],
      skills: [
        "skills/pptx",
        "skills/slides-composition",
        "skills/slides-design",
        "skills/slides-html",
        "skills/slides-template-html",
        "skills/slides-theming"
      ],
      tools: [
        "tools/pptx",
        "tools/slide_analyze_template.ts",
        "tools/slide_assemble_pptx.ts",
        "tools/slide_build_pptx.ts",
        "tools/slide_compile_composition.ts",
        "tools/slide_compile_theme.ts",
        "tools/slide_create_thumbnails.ts",
        "tools/slide_download_image.ts",
        "tools/slide_generate_image.ts",
        "tools/slide_screenshot.ts"
      ]
    },
    docs: {
      plugins: [],
      commands: ["commands/new-doc.md", "commands/edit-doc.md", "commands/convert-doc.md"],
      skills: ["skills/docx", "skills/docs-design", "skills/docs-html"],
      tools: [
        "tools/docx",
        "tools/doc_compile_theme.ts",
        "tools/doc_convert.ts",
        "tools/doc_create.ts",
        "tools/doc_list.ts",
        "tools/doc_modify.ts",
        "tools/doc_restore.ts",
        "tools/doc_view.ts"
      ]
    },
    ontology: {
      plugins: [],
      commands: [],
      skills: [
        "skills/ontology-ontogpt-author-template",
        "skills/ontology-ontogpt-extract",
        "skills/ontology-ontogpt-select-template",
        "skills/ontology-ontogpt-troubleshoot"
      ],
      tools: [
        "tools/ontology",
        "tools/ontology_arq.ts",
        "tools/ontology_elk.ts",
        "tools/ontology_infer.ts",
        "tools/ontology_iri.ts",
        "tools/ontology_jena.ts",
        "tools/ontology_jena.version.ts",
        "tools/ontology_juuid.ts",
        "tools/ontology_kgcl.ts",
        "tools/ontology_langtag.ts",
        "tools/ontology_linkml.ts",
        "tools/ontology_logmap_llm.ts",
        "tools/ontology_logmap.ts",
        "tools/ontology_nquads.ts",
        "tools/ontology_ntriples.ts",
        "tools/ontology_ontogenix.ts",
        "tools/ontology_ontogpt.ts",
        "tools/ontology_oops.ts",
        "tools/ontology_pyshacl.ts",
        "tools/ontology_qparse.ts",
        "tools/ontology_rdfcat.ts",
        "tools/ontology_rdfcompare.ts",
        "tools/ontology_rdfcopy.ts",
        "tools/ontology_rdfdiff.ts",
        "tools/ontology_rdfparse.ts",
        "tools/ontology_rdfpatch.ts",
        "tools/ontology_rdfxml.ts",
        "tools/ontology_riot.ts",
        "tools/ontology_robot.ts",
        "tools/ontology_rset.ts",
        "tools/ontology_rsparql.ts",
        "tools/ontology_rupdate.ts",
        "tools/ontology_schemagen.ts",
        "tools/ontology_shacl.ts",
        "tools/ontology_shex.ts",
        "tools/ontology_sparql.ts",
        "tools/ontology_tdb1.xloader.ts",
        "tools/ontology_tdb2.tdbbackup.ts",
        "tools/ontology_tdb2.tdbcompact.ts",
        "tools/ontology_tdb2.tdbdump.ts",
        "tools/ontology_tdb2.tdbloader.ts",
        "tools/ontology_tdb2.tdbquery.ts",
        "tools/ontology_tdb2.tdbstats.ts",
        "tools/ontology_tdb2.tdbupdate.ts",
        "tools/ontology_tdb2.xloader.ts",
        "tools/ontology_tdbbackup.ts",
        "tools/ontology_tdbdump.ts",
        "tools/ontology_tdbloader.ts",
        "tools/ontology_tdbloader2.ts",
        "tools/ontology_tdbquery.ts",
        "tools/ontology_tdbstats.ts",
        "tools/ontology_tdbupdate.ts",
        "tools/ontology_trig.ts",
        "tools/ontology_turtle.ts",
        "tools/ontology_uparse.ts",
        "tools/ontology_update.ts",
        "tools/ontology_utf8.ts",
        "tools/ontology_widoco.ts",
        "tools/ontology_wwwdec.ts",
        "tools/ontology_wwwenc.ts"
      ]
    }
  }
}

export function getCompanionLinksConfigPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".agent-manager", "companion-links.json")
}

export function resolveCompanionCategoryKey(config: CompanionLinksConfig, categoryOrDomain: string): string {
  const key = categoryOrDomain.trim().toLocaleLowerCase("und")
  if (key === "pipeline" || key === "hybrid" || key === "hybrid-pipeline" || key.endsWith("-pipeline")) {
    if (config.categories[key]) return key
    if (config.categories[`${key}-pipeline`]) return `${key}-pipeline`
    if (config.categories.pipeline) return "pipeline"
  }
  if (config.categories[key]) return key
  const pipelineKey = `${key}-pipeline`
  if (config.categories[pipelineKey]) return pipelineKey
  const domainKey = key.endsWith("-pipeline") ? key.slice(0, -"-pipeline".length) : ""
  if (domainKey && config.categories[domainKey]) return domainKey
  return key
}

function emptyLinks(): CompanionCategoryLinks {
  return { plugins: [], commands: [], skills: [], tools: [] }
}

function normalizePaths(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const paths = value.flatMap(item => {
    if (typeof item !== "string") return []
    const normalized = item.trim().replace(/\\/g, "/")
    if (!normalized || path.posix.isAbsolute(normalized) || path.win32.isAbsolute(item.trim()) || !isWorkspaceRelativePath(normalized)) return []
    return [normalized]
  })
  return [...new Set(paths)].sort((a, b) => a.localeCompare(b, "und"))
}

function normalizeCategoryLinks(value: unknown): CompanionCategoryLinks {
  const category = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
  return {
    plugins: normalizePaths(category.plugins),
    commands: normalizePaths(category.commands),
    skills: normalizePaths(category.skills),
    tools: normalizePaths(category.tools)
  }
}

function cloneDefaults(): CompanionLinksConfig {
  return JSON.parse(JSON.stringify(DEFAULT_COMPANION_LINKS)) as CompanionLinksConfig
}

function rejectSymlink(filePath: string): void {
  try {
    if (fs.lstatSync(filePath).isSymbolicLink()) throw new Error(`Companion links path must not be a symlink: ${filePath}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}

export function loadCompanionLinks(workspaceRoot: string): CompanionLinksConfig {
  const configPath = getCompanionLinksConfigPath(workspaceRoot)
  const directoryPath = path.dirname(configPath)
  rejectSymlink(directoryPath)
  rejectSymlink(configPath)

  const config = cloneDefaults()
  if (!fs.existsSync(configPath)) return config

  const raw = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>
  const categories = raw && typeof raw.categories === "object" && raw.categories !== null && !Array.isArray(raw.categories)
    ? raw.categories as Record<string, unknown>
    : {}
  for (const [category, links] of Object.entries(categories)) {
    const key = category.trim().toLocaleLowerCase("und")
    if (!key) continue
    config.categories[key] = normalizeCategoryLinks(links)
  }
  return config
}

export function saveCompanionLinks(workspaceRoot: string, config: CompanionLinksConfig): string {
  const configPath = getCompanionLinksConfigPath(workspaceRoot)
  const directoryPath = path.dirname(configPath)
  rejectSymlink(directoryPath)
  if (!fs.existsSync(directoryPath)) fs.mkdirSync(directoryPath, { recursive: true })
  rejectSymlink(directoryPath)
  rejectSymlink(configPath)

  const categories: Record<string, CompanionCategoryLinks> = {}
  for (const category of Object.keys(config.categories || {}).sort((a, b) => a.localeCompare(b, "und"))) {
    const key = category.trim().toLocaleLowerCase("und")
    if (key) categories[key] = normalizeCategoryLinks(config.categories[category])
  }
  const normalized: CompanionLinksConfig = { version: 1, categories }
  fs.writeFileSync(configPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf-8")
  return configPath
}

export function getCategoryCompanionLinks(workspaceRoot: string, categoryOrDomain: string): CompanionCategoryLinks {
  const config = loadCompanionLinks(workspaceRoot)
  const key = resolveCompanionCategoryKey(config, categoryOrDomain)
  return normalizeCategoryLinks(config.categories[key])
}

export function updateCategoryCompanionLinks(
  workspaceRoot: string,
  category: string,
  links: Partial<CompanionCategoryLinks>
): string {
  const config = loadCompanionLinks(workspaceRoot)
  const key = resolveCompanionCategoryKey(config, category)
  const current = normalizeCategoryLinks(config.categories[key])
  const updated = { ...current }
  for (const group of GROUPS) {
    if (links[group] !== undefined) updated[group] = normalizePaths(links[group])
  }
  config.categories[key] = updated
  return saveCompanionLinks(workspaceRoot, config)
}

function categoryDomain(category: string): string {
  const key = category.trim().toLocaleLowerCase("und")
  return key.endsWith("-pipeline") ? key.slice(0, -"-pipeline".length) : key
}

function resolveSourceRoot(workspaceRoot: string): string {
  return fs.existsSync(path.join(workspaceRoot, "src"))
    ? path.join(workspaceRoot, "src")
    : path.join(workspaceRoot, "general")
}

export function copyCategoryCompanionLinks(workspaceRoot: string, sourceCategory: string, targetCategory: string): string {
  const config = loadCompanionLinks(workspaceRoot)
  const sourceKey = resolveCompanionCategoryKey(config, sourceCategory)
  const targetKey = resolveCompanionCategoryKey(config, targetCategory)
  const source = normalizeCategoryLinks(config.categories[sourceKey])
  const sourceDomain = categoryDomain(sourceKey)
  const targetDomain = categoryDomain(targetKey)
  const sourceRoot = resolveSourceRoot(workspaceRoot)
  const commandsDirectory = path.join(sourceRoot, "commands")
  let targetCommands: string[] = []
  if (fs.existsSync(commandsDirectory) && fs.statSync(commandsDirectory).isDirectory()) {
    targetCommands = fs.readdirSync(commandsDirectory)
      .filter(name => name.startsWith(`${targetDomain}-`) && name.endsWith(".md") && fs.statSync(path.join(commandsDirectory, name)).isFile())
      .map(name => `commands/${name}`)
  }
  const commands = [...source.commands, ...targetCommands]
  config.categories[targetKey] = { ...source, commands: normalizePaths(commands) }
  return saveCompanionLinks(workspaceRoot, config)
}

function isExcludedFile(name: string): boolean {
  return /\.test\./i.test(name) || /_testutil\./i.test(name)
}

function selectableItem(group: CompanionResourceGroup, relativePath: string, label: string, linked: Set<string>): SelectableCompanionItem {
  return { id: `${group}:${relativePath}`, group, relativePath, label, linked: linked.has(relativePath) }
}

export function discoverAvailableCategoryCompanionItems(workspaceRoot: string, category: string): SelectableCompanionItem[] {
  const sourceRoot = resolveSourceRoot(workspaceRoot)
  const links = getCategoryCompanionLinks(workspaceRoot, category)
  const linked = {
    plugin: new Set(links.plugins),
    command: new Set(links.commands),
    skill: new Set(links.skills),
    tool: new Set(links.tools)
  }
  const items: SelectableCompanionItem[] = []
  const entries = (directory: string): fs.Dirent[] => {
    try { return fs.readdirSync(directory, { withFileTypes: true }) } catch { return [] }
  }
  const pluginDir = path.join(sourceRoot, "plugins")
  for (const entry of entries(pluginDir)) {
    if (!entry.isFile() || isExcludedFile(entry.name) || !/\.(js|ts|mjs)$/i.test(entry.name) || entry.name === "README.md") continue
    const relativePath = `plugins/${entry.name}`
    items.push(selectableItem("plugin", relativePath, path.basename(entry.name, path.extname(entry.name)), linked.plugin))
  }
  const commandDir = path.join(sourceRoot, "commands")
  for (const entry of entries(commandDir)) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue
    const relativePath = `commands/${entry.name}`
    items.push(selectableItem("command", relativePath, path.basename(entry.name, ".md"), linked.command))
  }
  const skillDir = path.join(sourceRoot, "skills")
  for (const entry of entries(skillDir)) {
    if (!entry.isDirectory() || !fs.existsSync(path.join(skillDir, entry.name, "SKILL.md"))) continue
    const relativePath = `skills/${entry.name}`
    items.push(selectableItem("skill", relativePath, entry.name, linked.skill))
  }
  const toolDir = path.join(sourceRoot, "tools")
  for (const entry of entries(toolDir)) {
    if (entry.isDirectory()) {
      const relativePath = `tools/${entry.name}`
      items.push(selectableItem("tool", relativePath, entry.name, linked.tool))
      continue
    }
    if (!entry.isFile() || entry.name.endsWith(".d.ts") || isExcludedFile(entry.name) || entry.name.startsWith("_") && entry.name.endsWith(".js") || !entry.name.endsWith(".ts")) continue
    const relativePath = `tools/${entry.name}`
    items.push(selectableItem("tool", relativePath, path.basename(entry.name, ".ts"), linked.tool))
  }
  return items.sort((a, b) => a.group.localeCompare(b.group, "und") || a.relativePath.localeCompare(b.relativePath, "und"))
}
