import fs from "node:fs"
import path from "node:path"
import { traceRelativeToolDependencies } from "./agents.js"
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
      plugins: [
        "plugins/agent-router",
        "plugins/dev-tools",
        "plugins/doc-tools",
        "plugins/pipeline-guard",
        "plugins/pipeline-tools",
        "plugins/slide-tools"
      ],
      commands: [
        "commands/pipeline-bug.md",
        "commands/pipeline-feature.md",
        "commands/pipeline-init.md",
        "commands/pipeline-ops.md",
        "commands/pipeline-refactor.md",
        "commands/pipeline-research.md"
      ],
      skills: ["skills/code-review-antipatterns"],
      tools: [
        "tools/dev_env.ts",
        "tools/dev_serve.ts",
        "tools/dev_smoke.ts",
        "tools/dev_verify.ts",
        "tools/pipeline_commit.ts",
        "tools/pipeline_state.ts"
      ]
    },
    slides: {
      plugins: ["plugins/slide-tools"],
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
      plugins: ["plugins/doc-tools"],
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
    },
    wiki: {
      plugins: [],
      tools: [],
      commands: ["commands/wiki.md"],
      skills: ["skills/wiki-conventions", "skills/wiki-navigate", "skills/wiki-templates"]
    }
  }
}

export function getCompanionLinksConfigPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".agent-manager", "companion-links.json")
}

export function resolveCompanionCategoryKey(_config: CompanionLinksConfig, categoryOrDomain: string): string {
  return categoryOrDomain.trim().toLocaleLowerCase("und")
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
  const savedPath = saveCompanionLinks(workspaceRoot, config)
  syncCategoryManifestResources(workspaceRoot, key, updated)
  return savedPath
}

function safeSourceStat(sourceRoot: string, relative: string): fs.Stats | undefined {
  const normalized = relative.replace(/\\/g, "/")
  const parts = normalized.split("/")
  if (!normalized || path.posix.isAbsolute(normalized) || parts.some(part => !part || part === "." || part === "..")) return undefined

  let current = sourceRoot
  let stat: fs.Stats | undefined
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part)
    try {
      stat = fs.lstatSync(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    }
    if (stat.isSymbolicLink() || index < parts.length - 1 && !stat.isDirectory()) return undefined
  }
  return stat
}

function sourceFilesUnder(sourceRoot: string, relative: string): string[] {
  const files: string[] = []
  relative = relative.replace(/\\/g, "/")
  const visit = (candidate: string) => {
    const stat = safeSourceStat(sourceRoot, candidate)
    if (stat?.isFile()) {
      files.push(candidate)
      return
    }
    if (!stat || !stat.isDirectory()) return
    const directory = path.join(sourceRoot, ...candidate.split("/"))
    for (const name of fs.readdirSync(directory).sort((a, b) => a.localeCompare(b, "und"))) {
      visit(`${candidate}/${name}`)
    }
  }
  visit(relative)
  return files
}

const MIXED_TEXT_EXTENSIONS = new Set([
  ".cjs", ".css", ".html", ".js", ".json", ".markdown", ".md", ".mjs", ".py", ".sh", ".svg", ".toml", ".ts", ".tsx", ".txt", ".xml", ".xsd", ".yaml", ".yml"
])
const TEXT_EXTENSIONS = new Set([
  ".cjs", ".css", ".html", ".js", ".json", ".markdown", ".md", ".mjs", ".py", ".sh", ".svg", ".toml", ".ts", ".tsx", ".txt", ".xml", ".xsd", ".yaml", ".yml"
])

function inferredResourcePolicy(
  sourceRoot: string,
  relative: string,
  kind: "file" | "directory"
): { policy: "text" | "binary" | "mixed"; extensions?: string[] } {
  const files = kind === "file" ? [relative] : sourceFilesUnder(sourceRoot, relative)
  const decoded = files.map(file => {
    const bytes = fs.readFileSync(path.join(sourceRoot, ...file.split("/")))
    const extension = path.extname(file).toLowerCase()
    try {
      if (!TEXT_EXTENSIONS.has(extension) || bytes.includes(0)) return { extension, text: false }
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      return { extension, text: true }
    } catch {
      return { extension, text: false }
    }
  })
  if (decoded.every(file => file.text)) return { policy: "text" }
  if (kind === "file") return { policy: "binary" }

  const binaryExtensions = new Set(decoded.filter(file => !file.text).map(file => file.extension))
  const extensions = [...new Set(decoded
    .filter(file => file.text && MIXED_TEXT_EXTENSIONS.has(file.extension) && !binaryExtensions.has(file.extension))
    .map(file => file.extension))].sort((a, b) => a.localeCompare(b, "und"))
  return extensions.length ? { policy: "mixed", extensions } : { policy: "binary" }
}

function targetCovers(resources: unknown[], relative: string): boolean {
  return resources.some(resource => {
    if (!resource || typeof resource !== "object" || Array.isArray(resource)) return false
    const entry = resource as Record<string, unknown>
    const target = typeof entry.target === "string" ? entry.target : ""
    return target === relative || entry.kind === "directory" && relative.startsWith(`${target}/`)
  })
}

function isTargetCovered(resources: unknown[], relative: string, sourceRoot: string): boolean {
  if (targetCovers(resources, relative)) return true
  if (!safeSourceStat(sourceRoot, relative)?.isDirectory()) return false
  const files = sourceFilesUnder(sourceRoot, relative)
  return files.length > 0 && files.every(file => targetCovers(resources, file))
}

export function syncCategoryManifestResources(
  workspaceRoot: string,
  category: string,
  links?: CompanionCategoryLinks
): void {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(category)) return

  const managerDirectory = path.resolve(workspaceRoot, ".agent-manager")
  const categoriesDirectory = path.resolve(managerDirectory, "categories")
  const manifestPath = path.resolve(categoriesDirectory, `${category}.json`)
  const relativeManifestPath = path.relative(categoriesDirectory, manifestPath)
  if (!relativeManifestPath || relativeManifestPath === ".." || relativeManifestPath.startsWith(`..${path.sep}`) || path.isAbsolute(relativeManifestPath)) return

  try {
    rejectSymlink(managerDirectory)
    rejectSymlink(categoriesDirectory)
    rejectSymlink(manifestPath)
  } catch {
    return
  }
  if (!fs.existsSync(manifestPath)) return

  let manifest: unknown
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"))
  } catch {
    return
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return

  const categoryManifest = manifest as Record<string, unknown>
  if (categoryManifest.schemaVersion !== 2 || !Array.isArray(categoryManifest.resources)) return

  const existingResources = categoryManifest.resources
  const originalResources = JSON.stringify(existingResources)
  let sourcePrefix = fs.existsSync(path.join(workspaceRoot, "src")) ? "src" : ""
  if (!sourcePrefix) {
    for (const resource of existingResources) {
      if (!resource || typeof resource !== "object" || Array.isArray(resource)) continue
      const source = (resource as Record<string, unknown>).source
      if (typeof source !== "string") continue
      const normalizedSource = source.replace(/\\/g, "/")
      const separator = normalizedSource.indexOf("/")
      if (separator > 0) {
        sourcePrefix = normalizedSource.slice(0, separator)
        break
      }
    }
  }
  if (!sourcePrefix) sourcePrefix = "src"
  if (!isWorkspaceRelativePath(sourcePrefix) || sourcePrefix === "." || sourcePrefix.includes("/") || sourcePrefix.includes("\\")) sourcePrefix = "src"

  const effectiveLinks = normalizeCategoryLinks(links ?? getCategoryCompanionLinks(workspaceRoot, category))

  const nonPluginResources = existingResources.filter(resource => {
    if (!resource || typeof resource !== "object" || Array.isArray(resource)) return true
    const target = (resource as Record<string, unknown>).target
    return typeof target !== "string" || target !== "plugins" && !target.startsWith("plugins/")
  })
  const pluginResources = effectiveLinks.plugins.map(pluginRel => {
    const existing = existingResources.find(resource =>
      resource && typeof resource === "object" && !Array.isArray(resource) &&
      (resource as Record<string, unknown>).target === pluginRel
    )
    return existing ?? { kind: "directory", source: `${sourcePrefix}/${pluginRel}`, target: pluginRel, policy: "runtime" }
  })

  let resources = [...nonPluginResources, ...pluginResources]
  const sourceRoot = path.join(workspaceRoot, sourcePrefix)
  let sourceRootStat: fs.Stats | undefined
  try {
    sourceRootStat = fs.lstatSync(sourceRoot)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  if (sourceRootStat && sourceRootStat.isDirectory() && !sourceRootStat.isSymbolicLink()) {
    for (const group of ["commands", "skills", "tools"] as const) {
      for (const relative of effectiveLinks[group]) {
        if (isTargetCovered(resources, relative, sourceRoot)) continue
        const stat = safeSourceStat(sourceRoot, relative)
        if (!stat || !stat.isDirectory() && !stat.isFile()) continue
        const source = `${sourcePrefix}/${relative}`
        const kind = stat.isDirectory() ? "directory" : "file"
        if (kind === "directory") {
          const sourcePrefixForChildren = `${source}/`
          resources = resources.filter(resource => {
            if (!resource || typeof resource !== "object" || Array.isArray(resource)) return true
            const entry = resource as Record<string, unknown>
            const target = typeof entry.target === "string" ? entry.target : ""
            const childSource = typeof entry.source === "string" ? entry.source : ""
            return !target.startsWith(`${relative}/`) && !childSource.startsWith(sourcePrefixForChildren)
          })
        }
        const existingSource = resources.find(resource =>
          resource && typeof resource === "object" && !Array.isArray(resource) &&
          (resource as Record<string, unknown>).source === source
        )
        if (existingSource && typeof existingSource === "object" && !Array.isArray(existingSource)) {
          (existingSource as Record<string, unknown>).target = relative
          continue
        }
        resources.push({
          kind,
          source,
          target: relative,
          ...inferredResourcePolicy(sourceRoot, relative, kind)
        })
      }
    }

    const seedFiles = new Set<string>()
    for (const resource of resources) {
      if (!resource || typeof resource !== "object" || Array.isArray(resource)) continue
      const entry = resource as Record<string, unknown>
      const target = typeof entry.target === "string" ? entry.target : ""
      if (!/^(?:plugins|tools)\/.+/.test(target)) continue
      if (entry.kind === "file") {
        if (safeSourceStat(sourceRoot, target)?.isFile()) seedFiles.add(target)
      } else if (entry.kind === "directory") {
        for (const file of sourceFilesUnder(sourceRoot, target)) seedFiles.add(file)
      }
    }
    for (const relative of [...traceRelativeToolDependencies(sourceRoot, seedFiles)].sort((a, b) => a.localeCompare(b, "und"))) {
      if (isTargetCovered(resources, relative, sourceRoot)) continue
      if (!safeSourceStat(sourceRoot, relative)?.isFile()) continue
      const source = `${sourcePrefix}/${relative}`
      const existingSource = resources.find(resource =>
        resource && typeof resource === "object" && !Array.isArray(resource) &&
        (resource as Record<string, unknown>).source === source
      )
      if (existingSource && typeof existingSource === "object" && !Array.isArray(existingSource)) {
        (existingSource as Record<string, unknown>).target = relative
      } else {
        resources.push({ kind: "file", source, target: relative, ...inferredResourcePolicy(sourceRoot, relative, "file") })
      }
    }
  }

  resources = [...resources.filter(resource => {
    if (!resource || typeof resource !== "object" || Array.isArray(resource)) return true
    return (resource as Record<string, unknown>).dependency === undefined
  }), ...resources.filter(resource => {
    if (!resource || typeof resource !== "object" || Array.isArray(resource)) return false
    return (resource as Record<string, unknown>).dependency !== undefined
  })]
  if (JSON.stringify(resources) === originalResources) return

  categoryManifest.resources = resources
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8")
}

export function syncCategoryManifestTransitiveDependencies(workspaceRoot: string, category: string): void {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(category)) return

  const managerDirectory = path.resolve(workspaceRoot, ".agent-manager")
  const categoriesDirectory = path.resolve(managerDirectory, "categories")
  const manifestPath = path.resolve(categoriesDirectory, `${category}.json`)
  const relativeManifestPath = path.relative(categoriesDirectory, manifestPath)
  if (!relativeManifestPath || relativeManifestPath === ".." || relativeManifestPath.startsWith(`..${path.sep}`) || path.isAbsolute(relativeManifestPath)) return

  try {
    rejectSymlink(managerDirectory)
    rejectSymlink(categoriesDirectory)
    rejectSymlink(manifestPath)
  } catch {
    return
  }

  let manifestStat: fs.Stats
  try {
    manifestStat = fs.lstatSync(manifestPath)
  } catch {
    return
  }
  if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) return

  let manifest: unknown
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"))
  } catch {
    return
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return

  const categoryManifest = manifest as Record<string, unknown>
  if (categoryManifest.schemaVersion !== 2 || !Array.isArray(categoryManifest.resources)) return
  const resources = categoryManifest.resources as unknown[]
  let sourcePrefix = "src"
  const toolResources = resources.filter(resource => {
    if (!resource || typeof resource !== "object" || Array.isArray(resource)) return false
    const target = (resource as Record<string, unknown>).target
    return typeof target === "string" && /^(?:plugins|tools)(?:\/|$)/.test(target)
  })
  for (const resource of [...toolResources, ...resources]) {
    if (!resource || typeof resource !== "object" || Array.isArray(resource)) continue
    const source = (resource as Record<string, unknown>).source
    if (typeof source !== "string") continue
    const normalizedSource = source.replace(/\\/g, "/")
    const separator = normalizedSource.indexOf("/")
    if (separator <= 0) continue
    const candidate = normalizedSource.slice(0, separator)
    if (isWorkspaceRelativePath(candidate) && !candidate.includes("/") && !candidate.includes("\\")) {
      sourcePrefix = candidate
      break
    }
  }

  const sourceRoot = path.join(workspaceRoot, sourcePrefix)
  let sourceRootStat: fs.Stats
  try {
    sourceRootStat = fs.lstatSync(sourceRoot)
  } catch {
    return
  }
  if (!sourceRootStat.isDirectory() || sourceRootStat.isSymbolicLink()) return

  const seedFiles = new Set<string>()
  for (const resource of resources) {
    if (!resource || typeof resource !== "object" || Array.isArray(resource)) continue
    const entry = resource as Record<string, unknown>
    const source = typeof entry.source === "string" ? entry.source.replace(/\\/g, "/") : ""
    const target = typeof entry.target === "string" ? entry.target : ""
    if (!/^(?:plugins|tools)(?:\/|$)/.test(target) || !source.startsWith(`${sourcePrefix}/`)) continue
    const relative = source.slice(sourcePrefix.length + 1)
    if (!/^(?:plugins|tools)(?:\/|$)/.test(relative)) continue
    if (entry.kind === "file") {
      if (safeSourceStat(sourceRoot, relative)?.isFile()) seedFiles.add(relative)
    } else if (entry.kind === "directory") {
      for (const file of sourceFilesUnder(sourceRoot, relative)) seedFiles.add(file)
    }
  }

  const originalResources = JSON.stringify(resources)
  const additions: unknown[] = []
  for (const relative of [...traceRelativeToolDependencies(sourceRoot, seedFiles)].sort((a, b) => a.localeCompare(b, "und"))) {
    if (isTargetCovered([...resources, ...additions], relative, sourceRoot)) continue
    if (!safeSourceStat(sourceRoot, relative)?.isFile()) continue
    additions.push({
      kind: "file",
      source: `${sourcePrefix}/${relative}`,
      target: relative,
      ...inferredResourcePolicy(sourceRoot, relative, "file")
    })
  }
  if (!additions.length) return

  const updatedResources = [
    ...resources.filter(resource => !resource || typeof resource !== "object" || Array.isArray(resource) || (resource as Record<string, unknown>).dependency === undefined),
    ...additions,
    ...resources.filter(resource => resource && typeof resource === "object" && !Array.isArray(resource) && (resource as Record<string, unknown>).dependency !== undefined)
  ]
  if (JSON.stringify(updatedResources) === originalResources) return

  categoryManifest.resources = updatedResources
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8")
}

function resolveSourceRoot(workspaceRoot: string): string {
  return fs.existsSync(path.join(workspaceRoot, "src"))
    ? path.join(workspaceRoot, "src")
    : path.join(workspaceRoot, "general")
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
    const relativePath = `plugins/${entry.name}`
    if (entry.isDirectory()) {
      if (!fs.existsSync(path.join(pluginDir, entry.name, "index.ts")) && !fs.existsSync(path.join(pluginDir, entry.name, "index.js"))) continue
      items.push(selectableItem("plugin", relativePath, entry.name, linked.plugin))
    }
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
