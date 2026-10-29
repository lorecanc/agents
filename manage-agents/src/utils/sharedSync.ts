import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { refreshStampedPipelinesFromSource } from "./pipelineProfiles.js"
import { syncBashProfiles } from "./bashProfiles.js"

export const SHARED_SYNC_MANIFEST_PATH = ".agent-manager/shared-sync.json"
export const SHARED_SYNC_STATE_PATH = ".agent-manager/shared-sync-state.json"
export const SHARED_SYNC_RELEASE_INDEX = "release-index.json"

export type SharedComponentId = "agentManager" | "pipelineCore"
export type SharedSyncMode = 0o644 | 0o755

export interface SharedSyncComponentManifest {
  version: string
  description?: string
  requiresAgentManager?: string
  include: string[]
  exclude: string[]
}

export interface SharedSyncManifest {
  schemaVersion: 1
  components: Record<SharedComponentId, SharedSyncComponentManifest>
  localOverlay: { neverOverwrite: string[] }
}

export interface SharedSyncFileEntry {
  component: SharedComponentId
  path: string
  sha256: string
  size: number
  mode: SharedSyncMode
}

export interface SharedSyncComparison {
  identical: string[]
  modified: string[]
  missingInTarget: string[]
  protectedByOverlay: string[]
  dirtyTargetFiles: string[]
}

export interface SharedSyncOperation {
  action: "write" | "preserve"
  path: string
  component?: SharedComponentId
}

export interface SharedSyncApplyResult extends SharedSyncComparison {
  dryRun: boolean
  updated: string[]
  operations: SharedSyncOperation[]
  sourceCommit: string | null
}

interface SharedSyncReleaseIndex {
  schemaVersion: 1
  kind: "shared-sync-release"
  createdAt: string
  sourceCommit: string | null
  components: Partial<Record<SharedComponentId, SharedSyncComponentManifest>>
  manifest: { path: string; sha256: string; size: number; mode: SharedSyncMode }
  entries: SharedSyncFileEntry[]
  contentDigest: string
}

interface SharedSyncState {
  schemaVersion: 1
  installedComponents: Partial<Record<SharedComponentId, string>>
  sourceCommit: string | null
  syncedAt: string
  files: Record<string, string>
}

const COMPONENTS: SharedComponentId[] = ["agentManager", "pipelineCore"]
const COMPONENT_ALIASES: Record<string, SharedComponentId | "all"> = {
  all: "all",
  "agent-manager": "agentManager",
  agentManager: "agentManager",
  manager: "agentManager",
  "pipeline-core": "pipelineCore",
  pipelineCore: "pipelineCore",
  pipeline: "pipelineCore"
}

function failManifest(message: string): never {
  throw new Error(`Invalid shared sync manifest: ${message}`)
}

function componentPathAllowed(component: SharedComponentId, value: string): boolean {
  if (component === "agentManager") {
    return value === "manage-agents.sh" || value.startsWith("manage-agents/") || value.startsWith(".agent-manager/")
  }
  return ["src/agents/pipeline-", "src/commands/pipeline-", "src/plugins/", "src/tools/", "src/docs/"]
    .some(prefix => value.startsWith(prefix))
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function isSafeGlob(pattern: unknown): pattern is string {
  return typeof pattern === "string" && pattern.length > 0 && !pattern.startsWith("/") &&
    !path.posix.isAbsolute(pattern) && !path.win32.isAbsolute(pattern) && !pattern.includes("\\") &&
    !pattern.includes("\0") && !pattern.split("/").includes("..")
}

function validateGlobList(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value)) failManifest(`${label} must be an array of safe relative glob patterns`)
  for (const pattern of value) if (!isSafeGlob(pattern)) failManifest(`${label} contains an unsafe glob pattern`)
}

interface Semver {
  major: number
  minor: number
  patch: number
  prerelease: string[]
}

function parseSemver(version: string): Semver | null {
  const match = version.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/)
  if (!match) return null
  const prerelease = match[4]?.split(".") ?? []
  if (prerelease.some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease }
}

function compareIdentifiers(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left), rightNumeric = /^\d+$/.test(right)
  if (leftNumeric && rightNumeric) {
    if (left.length !== right.length) return left.length < right.length ? -1 : 1
    return left === right ? 0 : left < right ? -1 : 1
  }
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
  return left === right ? 0 : left < right ? -1 : 1
}

function compareSemver(left: Semver, right: Semver): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0
    return left.prerelease.length === 0 ? 1 : -1
  }
  for (let index = 0; index < Math.min(left.prerelease.length, right.prerelease.length); index++) {
    const compared = compareIdentifiers(left.prerelease[index], right.prerelease[index])
    if (compared !== 0) return compared
  }
  return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length < right.prerelease.length ? -1 : 1
}

function semverString(version: Semver): string {
  return `${version.major}.${version.minor}.${version.patch}`
}

export function satisfiesSemverRange(version: string, range: string): boolean {
  const candidate = parseSemver(version)
  if (!candidate || typeof range !== "string" || !range.trim()) return false
  const comparators = range.trim().split(/\s+/)
  for (const comparator of comparators) {
    const match = comparator.match(/^(>=|<=|>|<|=|\^|~)?(.+)$/)
    if (!match) return false
    const operator = match[1] || "="
    const expected = parseSemver(match[2])
    if (!expected) return false
    const compared = compareSemver(candidate, expected)
    if (operator === ">=" && compared < 0 || operator === "<=" && compared > 0 ||
      operator === ">" && compared <= 0 || operator === "<" && compared >= 0 ||
      operator === "=" && compared !== 0) return false
    if (operator === "~") {
      if (compared < 0 || candidate.major !== expected.major || candidate.minor !== expected.minor) return false
    }
    if (operator === "^") {
      let upper: Semver
      if (expected.major > 0) upper = { major: expected.major + 1, minor: 0, patch: 0, prerelease: [] }
      else if (expected.minor > 0) upper = { major: 0, minor: expected.minor + 1, patch: 0, prerelease: [] }
      else upper = { major: 0, minor: 0, patch: expected.patch + 1, prerelease: [] }
      if (compared < 0 || compareSemver(candidate, upper) >= 0) return false
    }
  }
  return true
}

export function validateSharedSyncManifest(manifest: unknown): asserts manifest is SharedSyncManifest {
  if (!isRecord(manifest)) failManifest("root must be an object")
  if (manifest.schemaVersion !== 1) failManifest("schemaVersion must be 1")
  if (!isRecord(manifest.components)) failManifest("components must be an object")
  for (const id of COMPONENTS) {
    const component = manifest.components[id]
    if (!isRecord(component)) failManifest(`components.${id} must be an object`)
    if (typeof component.version !== "string" || !parseSemver(component.version)) failManifest(`components.${id}.version must be valid semver`)
    validateGlobList(component.include, `components.${id}.include`)
    validateGlobList(component.exclude, `components.${id}.exclude`)
    if (component.include.some((pattern: string) => !componentPathAllowed(id, pattern))) {
      failManifest(`components.${id}.include contains a path outside its allowed component prefixes`)
    }
    if (component.exclude.some((pattern: string) => !componentPathAllowed(id, pattern))) {
      failManifest(`components.${id}.exclude contains a path outside its allowed component prefixes`)
    }
    if (component.description !== undefined && typeof component.description !== "string") failManifest(`components.${id}.description must be a string`)
  }
  const pipeline = manifest.components.pipelineCore
  if (typeof pipeline.requiresAgentManager !== "string" || !isValidSemverRange(pipeline.requiresAgentManager)) {
    failManifest("components.pipelineCore.requiresAgentManager must be a valid semver range")
  }
  if (!isRecord(manifest.localOverlay)) failManifest("localOverlay must be an object")
  validateGlobList(manifest.localOverlay.neverOverwrite, "localOverlay.neverOverwrite")
}

function isValidSemverRange(range: string): boolean {
  const parts = range.trim().split(/\s+/)
  return parts.length > 0 && parts.every(part => {
    const match = part.match(/^(>=|<=|>|<|=|\^|~)?(.+)$/)
    return Boolean(match && parseSemver(match[2]))
  })
}

function lstatRegular(file: string, label: string): fs.Stats {
  const stat = fs.lstatSync(file)
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Refusing non-regular ${label}: ${file}`)
  return stat
}

function assertSafeRelativeFilePath(value: string): void {
  if (!isSafeGlob(value) || value.includes("*") || value.includes("?")) throw new Error(`Unsafe shared sync path: ${value}`)
}

function ensureNoSymlinkPath(root: string, relative: string): void {
  assertSafeRelativeFilePath(relative)
  let current = path.resolve(root)
  const rootStat = fs.lstatSync(current)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error(`Refusing unsafe repository root: ${root}`)
  for (const part of relative.split("/")) {
    current = path.join(current, part)
    const stat = fs.lstatSync(current, { throwIfNoEntry: false })
    if (stat?.isSymbolicLink()) throw new Error(`Refusing shared sync path through a symlink: ${relative}`)
  }
}

export function loadSharedSyncManifest(repoRoot: string): SharedSyncManifest {
  const file = path.join(repoRoot, ...SHARED_SYNC_MANIFEST_PATH.split("/"))
  ensureNoSymlinkPath(repoRoot, SHARED_SYNC_MANIFEST_PATH)
  const stat = fs.lstatSync(file, { throwIfNoEntry: false })
  if (!stat) throw new Error(`Shared sync manifest not found: ${file}`)
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Refusing to read shared sync manifest through a non-regular file: ${file}`)
  const manifest: unknown = JSON.parse(fs.readFileSync(file, "utf8"))
  validateSharedSyncManifest(manifest)
  return manifest
}

function globToRegExp(pattern: string): RegExp {
  let source = ""
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]
    if (character === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") { source += "(?:.*/)?"; index += 2 }
      else { source += ".*"; index++ }
    } else if (character === "*") source += "[^/]*"
    else if (character === "?") source += "[^/]"
    else source += character.replace(/[\\^$+.()|[\]{}]/g, "\\$&")
  }
  return new RegExp(`^${source}$`)
}

function matchesAny(value: string, patterns: string[]): boolean {
  return patterns.some(pattern => globToRegExp(pattern).test(value))
}

function isGlobExcluded(relative: string, patterns: string[]): boolean {
  return matchesAny(relative, patterns) || matchesAny(`${relative}/`, patterns)
}

function isAlwaysExcluded(relative: string): boolean {
  const parts = relative.split("/")
  return parts.includes(".git") || parts.includes("node_modules") || relative === ".DS_Store" ||
    path.posix.basename(relative) === ".DS_Store" || relative === "manage-agents/dist" || relative.startsWith("manage-agents/dist/")
}

function entryAllowedByManifest(entry: SharedSyncFileEntry, manifest: SharedSyncManifest): boolean {
  const component = manifest.components[entry.component]
  return Boolean(component && componentPathAllowed(entry.component, entry.path) && !isAlwaysExcluded(entry.path) &&
    matchesAny(entry.path, component.include) && !isGlobExcluded(entry.path, [...component.exclude, ...manifest.localOverlay.neverOverwrite]))
}

function walkFiles(root: string, excluded: (relative: string) => boolean): string[] {
  const rootStat = fs.lstatSync(root)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error(`Refusing to scan non-directory repository root: ${root}`)
  const found: string[] = []
  const visit = (directory: string, prefix: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => compareStrings(a.name, b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (isAlwaysExcluded(relative) || excluded(relative)) continue
      const absolute = path.join(directory, entry.name)
      const stat = fs.lstatSync(absolute)
      if (stat.isSymbolicLink()) throw new Error(`Refusing to collect symlink: ${relative}`)
      if (stat.isDirectory()) visit(absolute, relative)
      else if (stat.isFile()) found.push(relative)
    }
  }
  visit(root, "")
  return found
}

function fileMetadata(component: SharedComponentId, relative: string, absolute: string): SharedSyncFileEntry {
  const stat = lstatRegular(absolute, "shared sync file")
  const bytes = fs.readFileSync(absolute)
  return {
    component,
    path: relative,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
    mode: stat.mode & 0o111 ? 0o755 : 0o644
  }
}

export function collectComponentFiles(repoRoot: string, manifest: SharedSyncManifest, componentId: SharedComponentId): SharedSyncFileEntry[] {
  validateSharedSyncManifest(manifest)
  if (!COMPONENTS.includes(componentId)) throw new Error(`Unknown shared component '${componentId}'.`)
  const component = manifest.components[componentId]
  const excluded = [...component.exclude, ...manifest.localOverlay.neverOverwrite]
  const files = walkFiles(repoRoot, relative => isGlobExcluded(relative, excluded))
  return files
    .filter(relative => matchesAny(relative, component.include))
    .sort(compareStrings)
    .map(relative => fileMetadata(componentId, relative, path.join(repoRoot, ...relative.split("/"))))
}

function selectedComponents(components?: SharedComponentId[]): SharedComponentId[] {
  if (!components) return [...COMPONENTS]
  const selected = [...new Set(components)]
  if (selected.some(component => !COMPONENTS.includes(component))) throw new Error("Unknown shared sync component selected.")
  return selected.sort((a, b) => COMPONENTS.indexOf(a) - COMPONENTS.indexOf(b))
}

function readJsonFile(file: string): any {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false })
  if (!stat) return null
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Refusing to read non-regular JSON file: ${file}`)
  return JSON.parse(fs.readFileSync(file, "utf8"))
}

function canonicalEntries(entries: SharedSyncFileEntry[]): SharedSyncFileEntry[] {
  return [...entries]
    .sort((a, b) => compareStrings(a.component, b.component) || compareStrings(a.path, b.path))
    .map(entry => ({ component: entry.component, path: entry.path, sha256: entry.sha256, size: entry.size, mode: entry.mode }))
}

function digestEntries(entries: SharedSyncFileEntry[]): string {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalEntries(entries))).digest("hex")
}

function sourceCommitFor(root: string): string | null {
  const result = spawnSync("git", ["-C", root, "rev-parse", "--verify", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
  return result.status === 0 ? result.stdout.trim() || null : null
}

function safeBundleEntry(entry: any): entry is SharedSyncFileEntry {
  return isRecord(entry) && COMPONENTS.includes(entry.component) && typeof entry.path === "string" &&
    isSafeGlob(entry.path) && !entry.path.includes("*") && !entry.path.includes("?") &&
    componentPathAllowed(entry.component, entry.path) && !isAlwaysExcluded(entry.path) &&
    typeof entry.sha256 === "string" && /^[a-f0-9]{64}$/.test(entry.sha256) &&
    Number.isInteger(entry.size) && entry.size >= 0 && (entry.mode === 0o644 || entry.mode === 0o755)
}

function isReleaseBundle(root: string): boolean {
  return fs.existsSync(path.join(root, SHARED_SYNC_RELEASE_INDEX))
}

function verifyReleaseBundle(root: string): SharedSyncReleaseIndex {
  const rootStat = fs.lstatSync(root, { throwIfNoEntry: false })
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error(`Invalid shared sync release directory: ${root}`)
  const indexFile = path.join(root, SHARED_SYNC_RELEASE_INDEX)
  const index = readJsonFile(indexFile) as SharedSyncReleaseIndex | null
  if (!index || index.schemaVersion !== 1 || index.kind !== "shared-sync-release" || !Array.isArray(index.entries)) {
    throw new Error(`Invalid shared sync release index: ${indexFile}`)
  }
  if (index.entries.some(entry => !safeBundleEntry(entry))) throw new Error("Shared sync release contains an unsafe entry.")
  const entries = canonicalEntries(index.entries)
  if (digestEntries(entries) !== index.contentDigest) throw new Error("Shared sync release contentDigest mismatch.")
  const filesRoot = path.join(root, "files")
  const filesStat = fs.lstatSync(filesRoot, { throwIfNoEntry: false })
  if (!filesStat || filesStat.isSymbolicLink() || !filesStat.isDirectory()) throw new Error("Shared sync release is missing a regular files/ directory.")
  for (const entry of entries) {
    const file = path.join(filesRoot, ...entry.path.split("/"))
    ensureNoSymlinkPath(filesRoot, entry.path)
    const stat = lstatRegular(file, "release file")
    const bytes = fs.readFileSync(file)
    const actualHash = crypto.createHash("sha256").update(bytes).digest("hex")
    if (actualHash !== entry.sha256 || bytes.length !== entry.size) throw new Error(`Shared sync release hash mismatch: ${entry.path}`)
    if ((stat.mode & 0o111 ? 0o755 : 0o644) !== entry.mode) throw new Error(`Shared sync release mode mismatch: ${entry.path}`)
  }
  if (!isRecord(index.manifest) || index.manifest.path !== SHARED_SYNC_MANIFEST_PATH || !/^[a-f0-9]{64}$/.test(index.manifest.sha256) ||
    !Number.isInteger(index.manifest.size) || index.manifest.size < 0 || index.manifest.mode !== 0o644) {
    throw new Error("Shared sync release manifest metadata is invalid.")
  }
  const manifestFile = path.join(filesRoot, ...index.manifest.path.split("/"))
  ensureNoSymlinkPath(filesRoot, index.manifest.path)
  const manifestStat = lstatRegular(manifestFile, "release manifest")
  const manifestBytes = fs.readFileSync(manifestFile)
  if (crypto.createHash("sha256").update(manifestBytes).digest("hex") !== index.manifest.sha256 || manifestBytes.length !== index.manifest.size ||
    (manifestStat.mode & 0o111 ? 0o755 : 0o644) !== index.manifest.mode) throw new Error(`Shared sync release hash mismatch: ${index.manifest.path}`)
  return index
}

interface SourceFile {
  entry: SharedSyncFileEntry
  bytes: Buffer
}

interface ResolvedSource {
  isBundle: boolean
  manifest: SharedSyncManifest
  index?: SharedSyncReleaseIndex
  files: SourceFile[]
  sourceCommit: string | null
  components: Partial<Record<SharedComponentId, SharedSyncComponentManifest>>
}

function loadBundleManifest(root: string): SharedSyncManifest {
  ensureNoSymlinkPath(path.join(root, "files"), SHARED_SYNC_MANIFEST_PATH)
  const file = path.join(root, "files", ...SHARED_SYNC_MANIFEST_PATH.split("/"))
  const parsed = readJsonFile(file)
  validateSharedSyncManifest(parsed)
  return parsed
}

function resolveSource(sourceRoot: string, components?: SharedComponentId[], verifyBundle = true): ResolvedSource {
  const selected = selectedComponents(components)
  if (isReleaseBundle(sourceRoot)) {
    const index = verifyBundle ? verifyReleaseBundle(sourceRoot) : readJsonFile(path.join(sourceRoot, SHARED_SYNC_RELEASE_INDEX)) as SharedSyncReleaseIndex
    const unavailable = selected.filter(component => !index.components?.[component])
    if (unavailable.length > 0) throw new Error(`Shared sync release does not contain component(s): ${unavailable.join(", ")}.`)
    const manifest = loadBundleManifest(sourceRoot)
    for (const id of selected) {
      if (JSON.stringify(index.components?.[id]) !== JSON.stringify(manifest.components[id])) {
        throw new Error(`Shared sync release metadata does not match its manifest for ${id}.`)
      }
    }
    for (const entry of index.entries) {
      if (!entryAllowedByManifest(entry, manifest)) {
        throw new Error(`Shared sync release entry is not allowed by its manifest: ${entry.path}`)
      }
    }
    const available = index.entries.filter(entry => selected.includes(entry.component))
    const files = available.map(entry => {
      ensureNoSymlinkPath(path.join(sourceRoot, "files"), entry.path)
      return { entry, bytes: fs.readFileSync(path.join(sourceRoot, "files", ...entry.path.split("/"))) }
    })
    const componentMetadata: Partial<Record<SharedComponentId, SharedSyncComponentManifest>> = {}
    for (const id of selected) {
      const indexed = index.components?.[id]
      if (indexed) componentMetadata[id] = indexed
      else if (manifest.components[id]) componentMetadata[id] = manifest.components[id]
    }
    return { isBundle: true, manifest, index, files, sourceCommit: index.sourceCommit ?? null, components: componentMetadata }
  }
  const manifest = loadSharedSyncManifest(sourceRoot)
  const files: SourceFile[] = []
  for (const component of selected) {
    for (const entry of collectComponentFiles(sourceRoot, manifest, component)) {
      ensureNoSymlinkPath(sourceRoot, entry.path)
      files.push({ entry, bytes: fs.readFileSync(path.join(sourceRoot, ...entry.path.split("/"))) })
    }
  }
  return {
    isBundle: false,
    manifest,
    files,
    sourceCommit: sourceCommitFor(sourceRoot),
    components: Object.fromEntries(selected.map(id => [id, manifest.components[id]]))
  }
}

function loadTargetManifest(targetRoot: string): SharedSyncManifest | null {
  const rootStat = fs.lstatSync(targetRoot, { throwIfNoEntry: false })
  if (!rootStat) return null
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error(`Refusing unsafe target repository root: ${targetRoot}`)
  ensureNoSymlinkPath(targetRoot, SHARED_SYNC_MANIFEST_PATH)
  const file = path.join(targetRoot, ...SHARED_SYNC_MANIFEST_PATH.split("/"))
  const parsed = readJsonFile(file)
  if (parsed === null) return null
  validateSharedSyncManifest(parsed)
  return parsed
}

function loadSyncState(targetRoot: string): SharedSyncState | null {
  const rootStat = fs.lstatSync(targetRoot, { throwIfNoEntry: false })
  if (!rootStat) return null
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error(`Refusing unsafe target repository root: ${targetRoot}`)
  ensureNoSymlinkPath(targetRoot, SHARED_SYNC_STATE_PATH)
  const file = path.join(targetRoot, ...SHARED_SYNC_STATE_PATH.split("/"))
  const parsed = readJsonFile(file)
  if (parsed === null) return null
  if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !isRecord(parsed.files)) throw new Error(`Invalid shared sync state file: ${file}`)
  return parsed as SharedSyncState
}

function stateVersion(state: SharedSyncState | null, component: SharedComponentId): string | undefined {
  const value: any = state?.installedComponents?.[component]
  if (typeof value === "string") return value
  if (isRecord(value) && typeof value.version === "string") return value.version
  const legacy: any = (state as any)?.components?.[component]
  if (typeof legacy === "string") return legacy
  if (isRecord(legacy) && typeof legacy.version === "string") return legacy.version
  return undefined
}

function effectiveManagerVersion(targetManifest: SharedSyncManifest | null, state: SharedSyncState | null): string | undefined {
  return stateVersion(state, "agentManager") ?? targetManifest?.components.agentManager.version
}

function ensureCompatible(
  source: ResolvedSource,
  selected: SharedComponentId[],
  targetManifest: SharedSyncManifest | null,
  state: SharedSyncState | null
): void {
  if (!selected.includes("pipelineCore")) return
  const pipeline = source.components.pipelineCore ?? source.manifest.components.pipelineCore
  const managerVersion = selected.includes("agentManager")
    ? (source.components.agentManager ?? source.manifest.components.agentManager).version
    : effectiveManagerVersion(targetManifest, state)
  if (!managerVersion || !satisfiesSemverRange(managerVersion, pipeline.requiresAgentManager || "")) {
    throw new Error(`Cannot apply pipelineCore: it requires agentManager ${pipeline.requiresAgentManager || "(unspecified)"}, but the effective agentManager version is ${managerVersion ?? "not installed"}. Apply a compatible agentManager release first.`)
  }
}

function overlays(source: SharedSyncManifest, target: SharedSyncManifest | null): string[] {
  return [...new Set([...source.localOverlay.neverOverwrite, ...(target?.localOverlay.neverOverwrite ?? [])])]
}

function assertTargetAllowsEntries(entries: SharedSyncFileEntry[], targetManifest: SharedSyncManifest | null): void {
  if (!targetManifest) return
  for (const entry of entries) {
    if (!entryAllowedByManifest(entry, targetManifest)) {
      throw new Error(`Shared sync entry is not allowed by the target manifest: ${entry.path}`)
    }
  }
}

function readTargetFile(targetRoot: string, relative: string): { bytes: Buffer; mode: SharedSyncMode } | null {
  const absolute = path.join(targetRoot, ...relative.split("/"))
  const rootStat = fs.lstatSync(targetRoot, { throwIfNoEntry: false })
  if (!rootStat) return null
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error(`Refusing unsafe target repository root: ${targetRoot}`)
  ensureNoSymlinkPath(targetRoot, relative)
  const stat = fs.lstatSync(absolute, { throwIfNoEntry: false })
  if (!stat) return null
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Refusing to inspect non-regular shared target file: ${relative}`)
  return { bytes: fs.readFileSync(absolute), mode: stat.mode & 0o111 ? 0o755 : 0o644 }
}

function gitChangedFiles(root: string): Set<string> {
  const result = spawnSync("git", ["-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=all"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
  if (result.status !== 0) return new Set()
  const changed = new Set<string>()
  const records = result.stdout.split("\0")
  for (let index = 0; index < records.length; index++) {
    const record = records[index]
    if (!record) continue
    const relative = record.slice(3).replace(/\\/g, "/")
    if (relative) changed.add(relative)
    if (/^[RC]/.test(record) && records[index + 1]) changed.add(records[++index].replace(/\\/g, "/"))
  }
  return changed
}

function componentsForSource(sourceRoot: string, requested?: SharedComponentId[]): SharedComponentId[] {
  if (requested !== undefined || !isReleaseBundle(sourceRoot)) return selectedComponents(requested)
  const index = readJsonFile(path.join(sourceRoot, SHARED_SYNC_RELEASE_INDEX)) as SharedSyncReleaseIndex | null
  if (!index?.components) return []
  return COMPONENTS.filter(component => Boolean(index.components[component]))
}

function targetDirtyFiles(targetRoot: string, paths: Set<string>, state: SharedSyncState | null): string[] {
  const status = gitChangedFiles(targetRoot)
  const dirty = new Set<string>()
  for (const relative of paths) {
    if (status.has(relative)) dirty.add(relative)
    const expected = state?.files?.[relative]
    if (typeof expected === "string") {
      const actual = readTargetFile(targetRoot, relative)
      const hash = actual && crypto.createHash("sha256").update(actual.bytes).digest("hex")
      if (!actual || hash !== expected) dirty.add(relative)
    }
  }
  return [...dirty].sort(compareStrings)
}

function comparisonFor(source: ResolvedSource, targetRoot: string, components?: SharedComponentId[]): SharedSyncComparison {
  const selected = selectedComponents(components)
  const targetManifest = loadTargetManifest(targetRoot)
  const state = loadSyncState(targetRoot)
  assertTargetAllowsEntries(source.files.map(file => file.entry), targetManifest)
  ensureCompatible(source, selected, targetManifest, state)
  const overlayPatterns = overlays(source.manifest, targetManifest)
  const result: SharedSyncComparison = { identical: [], modified: [], missingInTarget: [], protectedByOverlay: [], dirtyTargetFiles: [] }
  const targetFiles = new Map<string, { bytes: Buffer; mode: SharedSyncMode } | null>()
  const relevantPaths = new Set<string>()
  for (const sourceFile of source.files) {
    const { entry, bytes } = sourceFile
    relevantPaths.add(entry.path)
    if (matchesAny(entry.path, overlayPatterns)) {
      result.protectedByOverlay.push(entry.path)
      continue
    }
    let targetFile = targetFiles.get(entry.path)
    if (targetFile === undefined && !targetFiles.has(entry.path)) {
      targetFile = readTargetFile(targetRoot, entry.path)
      targetFiles.set(entry.path, targetFile)
    }
    if (!targetFile) result.missingInTarget.push(entry.path)
    else if (targetFile.mode === entry.mode && targetFile.bytes.equals(bytes)) result.identical.push(entry.path)
    else result.modified.push(entry.path)
  }
  if (targetManifest) {
    for (const component of selected) {
      for (const entry of collectComponentFiles(targetRoot, targetManifest, component)) relevantPaths.add(entry.path)
    }
  }
  for (const relative of Object.keys(state?.files ?? {})) relevantPaths.add(relative)
  result.dirtyTargetFiles = targetDirtyFiles(targetRoot, relevantPaths, state)
  for (const key of ["identical", "modified", "missingInTarget", "protectedByOverlay"] as const) result[key].sort(compareStrings)
  return result
}

export function compareSharedSync(options: { sourceRoot: string; targetRoot: string; components?: SharedComponentId[] }): SharedSyncComparison {
  const selected = componentsForSource(options.sourceRoot, options.components)
  const source = resolveSource(options.sourceRoot, selected)
  return comparisonFor(source, options.targetRoot, selected)
}

function copyEntryToDirectory(sourceRoot: string, relative: string, destinationRoot: string, bytes: Buffer, mode: SharedSyncMode): void {
  const destination = path.join(destinationRoot, ...relative.split("/"))
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.writeFileSync(destination, bytes, { mode })
  fs.chmodSync(destination, mode)
}

function randomSibling(parent: string, base: string): string {
  return path.join(parent, `.${base}.${process.pid}.${crypto.randomBytes(6).toString("hex")}`)
}

function ensureNoDestinationSymlinkAncestors(destination: string): void {
  const absolute = path.resolve(destination)
  const root = path.parse(absolute).root
  let current = root
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    const stat = fs.lstatSync(current, { throwIfNoEntry: false })
    if (!stat || !stat.isSymbolicLink()) continue
    const target = path.resolve(path.dirname(current), fs.readlinkSync(current))
    const systemAliasTarget = current === "/var" ? "/private/var" : current === "/tmp" ? "/private/tmp" : null
    if (target !== systemAliasTarget) throw new Error(`Refusing shared sync output path through a symlink: ${destination}`)
  }
}

function realpathWithMissingComponents(target: string): string {
  let current = path.resolve(target)
  const missing: string[] = []
  while (true) {
    let stat: fs.Stats | undefined
    try {
      stat = fs.lstatSync(current)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error
    }
    if (stat) return path.join(fs.realpathSync(current), ...missing.reverse())
    const parent = path.dirname(current)
    if (parent === current) return current
    missing.push(path.basename(current))
    current = parent
  }
}

function assertSafeReleaseDestination(sourceRoot: string, outputDir: string, manifest: SharedSyncManifest): void {
  ensureNoDestinationSymlinkAncestors(outputDir)
  const protectedTrees = ["src", "manage-agents", ".agent-manager", "export", "wiki", ".git", "node_modules"]
  const protectedPatterns = [
    ...Object.values(manifest.components).flatMap(component => component.include),
    ...manifest.localOverlay.neverOverwrite
  ]
  const overlapsPath = (left: string, right: string) => left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
  const overlapsPattern = (relative: string, pattern: string) => {
    const prefix = pattern.split(/[*?]/, 1)[0].replace(/\/+$/, "")
    return matchesAny(relative, [pattern]) || matchesAny(`${relative}/`, [pattern]) ||
      (prefix !== "" && (prefix === relative || prefix.startsWith(`${relative}/`) || relative.startsWith(`${prefix}/`)))
  }
  const assertPathsDoNotOverlap = (sourcePath: string, outputPath: string) => {
    const sourceRelative = path.relative(outputPath, sourcePath)
    if (sourceRelative === "" || (!sourceRelative.startsWith(`..${path.sep}`) && sourceRelative !== ".." && !path.isAbsolute(sourceRelative))) {
      throw new Error("Shared sync output directory cannot replace its source repository.")
    }
    const outputRelativeNative = path.relative(sourcePath, outputPath)
    const outputInsideSource = outputRelativeNative !== ".." && !outputRelativeNative.startsWith(`..${path.sep}`) && !outputRelativeNative.startsWith("..") && !path.isAbsolute(outputRelativeNative)
    if (!outputInsideSource) return
    const outputRelative = outputRelativeNative.split(path.sep).join("/")
    if (protectedTrees.some(tree => overlapsPath(outputRelative, tree)) || protectedPatterns.some(pattern => overlapsPattern(outputRelative, pattern))) {
      throw new Error("Shared sync output directory overlaps protected repository paths.")
    }
  }

  const lexicalSource = path.resolve(sourceRoot)
  const lexicalOutput = path.resolve(outputDir)
  assertPathsDoNotOverlap(lexicalSource, lexicalOutput)
  assertPathsDoNotOverlap(fs.realpathSync(lexicalSource), realpathWithMissingComponents(lexicalOutput))
}

function assertReleaseFilesMatchIndex(root: string, index: SharedSyncReleaseIndex): void {
  const filesRoot = path.join(root, "files")
  const actual = new Set<string>()
  const visit = (directory: string, prefix: string) => {
    for (const entry of fs.readdirSync(directory).sort(compareStrings)) {
      const relative = prefix ? `${prefix}/${entry}` : entry
      const absolute = path.join(directory, entry)
      const stat = fs.lstatSync(absolute)
      if (stat.isDirectory() && !stat.isSymbolicLink()) visit(absolute, relative)
      else actual.add(relative)
    }
  }
  visit(filesRoot, "")
  const expected = new Set([index.manifest.path, ...index.entries.map(entry => entry.path)])
  if (actual.size !== expected.size || [...actual].some(file => !expected.has(file))) {
    throw new Error("Shared sync release contains files outside its manifest and entries.")
  }
}

export function releaseSharedSync(options: { sourceRoot: string; outputDir: string; components?: SharedComponentId[] }): SharedSyncReleaseIndex {
  const selected = selectedComponents(options.components)
  const source = resolveSource(options.sourceRoot, selected)
  if (source.isBundle) throw new Error("A shared sync release can only be created from a repository root.")
  const outputDir = path.resolve(options.outputDir)
  const sourceRoot = path.resolve(options.sourceRoot)
  const parent = path.dirname(outputDir)
  const base = path.basename(outputDir)
  assertSafeReleaseDestination(sourceRoot, outputDir, source.manifest)
  fs.mkdirSync(parent, { recursive: true })
  assertSafeReleaseDestination(sourceRoot, outputDir, source.manifest)
  const temporary = randomSibling(parent, `${base}.tmp`)
  const backup = randomSibling(parent, `${base}.backup`)
  let movedExisting = false
  try {
    fs.mkdirSync(temporary)
    for (const file of source.files) copyEntryToDirectory(options.sourceRoot, file.entry.path, path.join(temporary, "files"), file.bytes, file.entry.mode)
    const manifestBytes = fs.readFileSync(path.join(options.sourceRoot, ...SHARED_SYNC_MANIFEST_PATH.split("/")))
    copyEntryToDirectory(options.sourceRoot, SHARED_SYNC_MANIFEST_PATH, path.join(temporary, "files"), manifestBytes, 0o644)
    const entries = canonicalEntries(source.files.map(file => file.entry))
    const index: SharedSyncReleaseIndex = {
      schemaVersion: 1,
      kind: "shared-sync-release",
      createdAt: new Date().toISOString(),
      sourceCommit: source.sourceCommit,
      components: Object.fromEntries(selected.map(id => [id, source.manifest.components[id]])),
      manifest: {
        path: SHARED_SYNC_MANIFEST_PATH,
        sha256: crypto.createHash("sha256").update(manifestBytes).digest("hex"),
        size: manifestBytes.length,
        mode: 0o644
      },
      entries,
      contentDigest: digestEntries(entries)
    }
    fs.writeFileSync(path.join(temporary, SHARED_SYNC_RELEASE_INDEX), `${JSON.stringify(index, null, 2)}\n`, "utf8")
    const existing = fs.lstatSync(outputDir, { throwIfNoEntry: false })
    if (existing) {
      if (existing.isSymbolicLink() || !existing.isDirectory()) throw new Error(`Refusing to replace non-directory release output: ${outputDir}`)
      const topLevel = fs.readdirSync(outputDir)
      if (topLevel.length !== 2 || !topLevel.includes(SHARED_SYNC_RELEASE_INDEX) || !topLevel.includes("files")) {
        throw new Error(`Refusing to overwrite existing non-release directory: ${outputDir}`)
      }
      const existingIndex = readJsonFile(path.join(outputDir, SHARED_SYNC_RELEASE_INDEX))
      if (!isRecord(existingIndex) || !isRecord(existingIndex.components) ||
        Object.keys(existingIndex.components).some(component => !COMPONENTS.includes(component as SharedComponentId))) {
        throw new Error(`Refusing to overwrite existing non-release directory: ${outputDir}`)
      }
      const existingComponents = COMPONENTS.filter(component => Object.prototype.hasOwnProperty.call(existingIndex.components, component))
      const resolvedExisting = resolveSource(outputDir, existingComponents)
      if (!resolvedExisting.index || resolvedExisting.index.entries.some(entry => !existingComponents.includes(entry.component))) {
        throw new Error(`Refusing to overwrite existing non-release directory: ${outputDir}`)
      }
      assertReleaseFilesMatchIndex(outputDir, resolvedExisting.index)
      fs.renameSync(outputDir, backup)
      movedExisting = true
    }
    fs.renameSync(temporary, outputDir)
    if (movedExisting) fs.rmSync(backup, { recursive: true, force: true })
    return index
  } catch (error) {
    if (fs.existsSync(outputDir) && movedExisting) fs.rmSync(outputDir, { recursive: true, force: true })
    if (movedExisting && fs.existsSync(backup)) {
      fs.renameSync(backup, outputDir)
      movedExisting = false
    }
    throw error
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { recursive: true, force: true })
    if (!movedExisting && fs.existsSync(backup)) fs.rmSync(backup, { recursive: true, force: true })
  }
}

function atomicWrite(file: string, bytes: Buffer | string, mode: SharedSyncMode): void {
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(5).toString("hex")}`
  let descriptor: number | undefined
  try {
    descriptor = fs.openSync(temporary, "wx", mode)
    fs.writeFileSync(descriptor, bytes)
    fs.fchmodSync(descriptor, mode)
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.renameSync(temporary, file)
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    fs.rmSync(temporary, { force: true })
  }
}

function writeTargetFile(targetRoot: string, relative: string, bytes: Buffer | string, mode: SharedSyncMode): void {
  ensureNoSymlinkPath(targetRoot, relative)
  const file = path.join(targetRoot, ...relative.split("/"))
  fs.mkdirSync(path.dirname(file), { recursive: true })
  ensureNoSymlinkPath(targetRoot, relative)
  atomicWrite(file, bytes, mode)
}

function missingParentDirectories(root: string, relativePaths: Iterable<string>): string[] {
  const missing = new Set<string>()
  for (const relative of relativePaths) {
    let current = path.resolve(root)
    const rootStat = fs.lstatSync(current, { throwIfNoEntry: false })
    if (!rootStat) missing.add(current)
    else if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error(`Refusing unsafe target repository root: ${root}`)
    for (const part of relative.split("/").slice(0, -1)) {
      current = path.join(current, part)
      const stat = fs.lstatSync(current, { throwIfNoEntry: false })
      if (!stat) missing.add(current)
      else if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Refusing unsafe target directory: ${current}`)
    }
  }
  return [...missing].sort((a, b) => b.length - a.length)
}

function componentManifestForUpdate(
  source: ResolvedSource,
  id: SharedComponentId
): SharedSyncComponentManifest {
  return source.components[id] ?? source.manifest.components[id]
}

function mergedTargetManifest(source: ResolvedSource, target: SharedSyncManifest | null, selected: SharedComponentId[]): SharedSyncManifest {
  const result = structuredClone(target ?? source.manifest) as SharedSyncManifest
  for (const id of selected) result.components[id] = structuredClone(componentManifestForUpdate(source, id))
  result.localOverlay.neverOverwrite = overlays(source.manifest, target).sort(compareStrings)
  return result
}

function createState(source: ResolvedSource, old: SharedSyncState | null, files: SourceFile[], selected: SharedComponentId[]): SharedSyncState {
  const installedComponents = { ...(old?.installedComponents ?? {}) }
  for (const id of selected) installedComponents[id] = componentManifestForUpdate(source, id).version
  const hashes = { ...(old?.files ?? {}) }
  for (const { entry } of files) hashes[entry.path] = entry.sha256
  return {
    schemaVersion: 1,
    installedComponents,
    sourceCommit: source.sourceCommit,
    syncedAt: new Date().toISOString(),
    files: hashes
  }
}

interface StampedPipelineSnapshot {
  files: Map<string, { bytes: Buffer; mode: SharedSyncMode }>
  directories: Set<string>
}

function profileFilesToSnapshot(targetRoot: string): StampedPipelineSnapshot {
  const categoryRoot = path.join(targetRoot, "export", "categories")
  const snapshot: StampedPipelineSnapshot = { files: new Map(), directories: new Set() }
  const stat = fs.lstatSync(categoryRoot, { throwIfNoEntry: false })
  if (!stat) return snapshot
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Refusing to refresh stamped pipelines through a non-directory: ${categoryRoot}`)
  for (const category of fs.readdirSync(categoryRoot, { withFileTypes: true })) {
    if (!category.isDirectory() || !category.name.endsWith("-pipeline")) continue
    const categoryPath = path.join(categoryRoot, category.name)
    const visit = (directory: string, relativeDirectory: string) => {
      snapshot.directories.add(relativeDirectory)
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const relative = `${relativeDirectory}/${entry.name}`
        const full = path.join(directory, entry.name)
        const stat = fs.lstatSync(full)
        if (stat.isSymbolicLink()) throw new Error(`Refusing stamped pipeline symlink: ${relative}`)
        if (stat.isDirectory()) visit(full, relative)
        else if (stat.isFile()) snapshot.files.set(relative, { bytes: fs.readFileSync(full), mode: stat.mode & 0o111 ? 0o755 : 0o644 })
      }
    }
    visit(categoryPath, `export/categories/${category.name}`)
  }
  return snapshot
}

function rollbackProfileFiles(targetRoot: string, snapshot: StampedPipelineSnapshot): void {
  const categoryRoot = path.join(targetRoot, "export", "categories")
  const stat = fs.lstatSync(categoryRoot, { throwIfNoEntry: false })
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return
  const currentDirectories: string[] = []
  for (const category of fs.readdirSync(categoryRoot, { withFileTypes: true })) {
    if (!category.isDirectory() || !category.name.endsWith("-pipeline")) continue
    const categoryPath = path.join(categoryRoot, category.name)
    const visit = (directory: string, relativeDirectory: string) => {
      currentDirectories.push(relativeDirectory)
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const relative = `${relativeDirectory}/${entry.name}`
        const full = path.join(directory, entry.name)
        const entryStat = fs.lstatSync(full)
        if (entryStat.isSymbolicLink()) throw new Error(`Refusing stamped pipeline symlink during rollback: ${relative}`)
        if (entryStat.isDirectory()) visit(full, relative)
        else if (entryStat.isFile() && !snapshot.files.has(relative)) fs.rmSync(full, { force: true })
      }
    }
    visit(categoryPath, `export/categories/${category.name}`)
  }
  for (const relative of currentDirectories.sort((a, b) => b.length - a.length)) {
    if (!snapshot.directories.has(relative)) {
      try { fs.rmdirSync(path.join(targetRoot, ...relative.split("/"))) } catch {}
    }
  }
  for (const [relative, file] of snapshot.files) writeTargetFile(targetRoot, relative, file.bytes, file.mode)
}

export function applySharedSync(options: {
  sourceRoot: string
  targetRoot: string
  components?: SharedComponentId[]
  dryRun?: boolean
  force?: boolean
  refreshPipelines?: boolean
}): SharedSyncApplyResult {
  const selected = componentsForSource(options.sourceRoot, options.components)
  const source = resolveSource(options.sourceRoot, selected, true)
  const targetManifest = loadTargetManifest(options.targetRoot)
  const state = loadSyncState(options.targetRoot)
  assertTargetAllowsEntries(source.files.map(file => file.entry), targetManifest)
  ensureCompatible(source, selected, targetManifest, state)
  const overlayPatterns = overlays(source.manifest, targetManifest)
  const protectedPaths = new Set<string>()
  const updateFiles: SourceFile[] = []
  const operations: SharedSyncOperation[] = []
  for (const sourceFile of source.files) {
    const relative = sourceFile.entry.path
    if (matchesAny(relative, overlayPatterns)) {
      protectedPaths.add(relative)
      operations.push({ action: "preserve", path: relative, component: sourceFile.entry.component })
      continue
    }
    const current = readTargetFile(options.targetRoot, relative)
    if (!current || current.mode !== sourceFile.entry.mode || !current.bytes.equals(sourceFile.bytes)) {
      updateFiles.push(sourceFile)
      operations.push({ action: "write", path: relative, component: sourceFile.entry.component })
    }
  }
  const nextManifest = mergedTargetManifest(source, targetManifest, selected)
  const manifestRelative = SHARED_SYNC_MANIFEST_PATH
  const manifestBytes = Buffer.from(`${JSON.stringify(nextManifest, null, 2)}\n`)
  const manifestCurrent = readTargetFile(options.targetRoot, manifestRelative)
  const manifestNeedsUpdate = !manifestCurrent || !manifestCurrent.bytes.equals(manifestBytes)
  const relevantPaths = new Set(source.files.map(file => file.entry.path))
  if (targetManifest) {
    for (const component of selected) for (const entry of collectComponentFiles(options.targetRoot, targetManifest, component)) relevantPaths.add(entry.path)
  }
  for (const relative of Object.keys(state?.files ?? {})) relevantPaths.add(relative)
  if (manifestNeedsUpdate && manifestCurrent) relevantPaths.add(manifestRelative)
  const dirtyTargetFiles = targetDirtyFiles(options.targetRoot, relevantPaths, state)
  const dirtyUpdates = dirtyTargetFiles.filter(file => updateFiles.some(entry => entry.entry.path === file) || (manifestNeedsUpdate && file === manifestRelative))
  if (dirtyUpdates.length > 0 && !options.force) {
    throw new Error(`Refusing to overwrite locally modified shared files: ${dirtyUpdates.join(", ")}. Commit or revert them, or pass --force.`)
  }

  if (manifestNeedsUpdate) operations.push({ action: "write", path: manifestRelative })
  const nextState = createState(source, state, source.files.filter(file => selected.includes(file.entry.component) && !protectedPaths.has(file.entry.path)), selected)
  const stateRelative = SHARED_SYNC_STATE_PATH
  const stateBytes = Buffer.from(`${JSON.stringify(nextState, null, 2)}\n`)
  operations.push({ action: "write", path: stateRelative })
  if (options.dryRun) {
    const comparison = comparisonFor(source, options.targetRoot, selected)
    return { ...comparison, dryRun: true, updated: updateFiles.map(file => file.entry.path).sort(), operations, sourceCommit: source.sourceCommit }
  }

  const filesToBackup = new Set([...updateFiles.map(file => file.entry.path), manifestRelative, stateRelative])
  const createdDirectories = missingParentDirectories(options.targetRoot, filesToBackup)
  const profileSnapshot: StampedPipelineSnapshot = selected.includes("pipelineCore") && options.refreshPipelines !== false
    ? profileFilesToSnapshot(options.targetRoot)
    : { files: new Map(), directories: new Set() }
  const transactionDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "shared-sync-transaction-"))
  const transactionBackups = new Map<string, { backupPath: string; mode: SharedSyncMode } | null>()
  try {
    for (const relative of filesToBackup) {
      const current = readTargetFile(options.targetRoot, relative)
      if (!current) transactionBackups.set(relative, null)
      else {
        const backupPath = path.join(transactionDirectory, ...relative.split("/"))
        fs.mkdirSync(path.dirname(backupPath), { recursive: true })
        fs.writeFileSync(backupPath, current.bytes, { mode: current.mode })
        fs.chmodSync(backupPath, current.mode)
        transactionBackups.set(relative, { backupPath, mode: current.mode })
      }
    }
    fs.mkdirSync(options.targetRoot, { recursive: true })
    for (const file of updateFiles) writeTargetFile(options.targetRoot, file.entry.path, file.bytes, file.entry.mode)
    writeTargetFile(options.targetRoot, manifestRelative, manifestBytes, 0o644)
    writeTargetFile(options.targetRoot, stateRelative, stateBytes, 0o644)
    if (selected.includes("pipelineCore") && options.refreshPipelines !== false) {
      refreshStampedPipelinesFromSource(options.targetRoot)
      if (fs.existsSync(path.join(options.targetRoot, ".agent-manager", "bash-profiles.json"))) syncBashProfiles(options.targetRoot)
    }
  } catch (error) {
    try {
      for (const [relative, backup] of [...transactionBackups].reverse()) {
        if (backup) writeTargetFile(options.targetRoot, relative, fs.readFileSync(backup.backupPath), backup.mode)
        else fs.rmSync(path.join(options.targetRoot, ...relative.split("/")), { force: true })
      }
      if (selected.includes("pipelineCore") && options.refreshPipelines !== false) rollbackProfileFiles(options.targetRoot, profileSnapshot)
      for (const directory of createdDirectories) {
        try { fs.rmdirSync(directory) } catch {}
      }
    } catch (rollbackError) {
      throw new Error(`Shared sync failed and rollback was incomplete: ${String(rollbackError)}`, { cause: error })
    }
    throw error
  } finally {
    fs.rmSync(transactionDirectory, { recursive: true, force: true })
  }
  const comparison = comparisonFor(source, options.targetRoot, selected)
  return {
    ...comparison,
    dryRun: false,
    updated: updateFiles.map(file => file.entry.path).sort(),
    operations,
    sourceCommit: source.sourceCommit
  }
}

export type SharedSyncCommand = "status" | "diff" | "release" | "export" | "apply" | "import"

export interface SharedSyncArgs {
  command: SharedSyncCommand
  target?: string
  from?: string
  out?: string
  components?: SharedComponentId[]
  dryRun?: boolean
  force?: boolean
  refreshPipelines?: boolean
  check?: boolean
  json?: boolean
  help?: boolean
}

export function parseSharedSyncArgs(args: string[]): SharedSyncArgs {
  let command: SharedSyncCommand = "status"
  let commandSeen = false
  const result: SharedSyncArgs = { command, components: undefined }
  const selected: SharedComponentId[] = []
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (argument === "--help" || argument === "-h") { result.help = true; continue }
    if (argument.startsWith("--")) {
      if (argument === "--dry-run") result.dryRun = true
      else if (argument === "--force") result.force = true
      else if (argument === "--no-refresh") result.refreshPipelines = false
      else if (argument === "--check") result.check = true
      else if (argument === "--json") result.json = true
      else if (["--target", "--from", "--out", "--output", "--component"].includes(argument)) {
        const value = args[++index]
        if (!value || value.startsWith("--")) throw new Error(`Expected a value after ${argument}.`)
        if (argument === "--target") result.target = value
        else if (argument === "--from") result.from = value
        else if (argument === "--out" || argument === "--output") result.out = value
        else {
          const alias = COMPONENT_ALIASES[value]
          if (!alias) throw new Error(`Unknown shared sync component '${value}'.`)
          if (alias === "all") selected.length = 0
          else selected.push(alias)
        }
      } else throw new Error(`Unknown shared sync option '${argument}'.`)
      continue
    }
    if (!commandSeen && ["status", "diff", "release", "export", "apply", "import"].includes(argument)) {
      command = argument as SharedSyncCommand
      commandSeen = true
      result.command = command
    } else throw new Error(`Unexpected shared sync argument '${argument}'.`)
  }
  if (selected.length > 0) result.components = [...new Set(selected)]
  result.command = command
  return result
}
