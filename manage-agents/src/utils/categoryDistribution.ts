import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

export type CategoryResource = { kind: "file"; source: string; target: string; primary?: boolean; dependency?: string }
export type CategoryGenerated = { kind: "config"; id: "opencode-local-codebase-memory-v1"; target: string }
export type CategoryManifest = {
  schemaVersion: 1
  id: string
  title: string
  description: string
  output: string
  resources: CategoryResource[]
  generated: CategoryGenerated[]
}
export type CategoryDistributionResult = { status: "current" | "stale"; missing: string[]; changed: string[]; extra: string[]; manifestHash: string }
export type CategoryDistributionOptions = { rename?: typeof fs.renameSync; onLockAcquired?: () => void }

const GENERATED = "opencode-local-codebase-memory-v1"
const RESERVED_TARGETS = new Set(["license", "readme.md", "category.json", "provenance.json", "opencode.json"])
const RESOURCE_KINDS = new Set(["file"])
const ROOT_LICENSE = `MIT License

Copyright (c) 2026 Lorenzo Cancellara

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Third-party software and services retain their own licenses and terms. This
license covers project-owned code, prompts, agents, skills, commands, and
documentation only.
`
const GENERATED_OPENCODE = JSON.stringify({ mcp: { "codebase-memory-mcp": { type: "local", command: ["codebase-memory-mcp"], enabled: true } } }, null, 2) + "\n"

function fail(message: string): never { throw new Error(`Invalid category distribution: ${message}`) }
function hash(value: Buffer | string): string { return crypto.createHash("sha256").update(value).digest("hex") }
function normalized(value: Buffer | string): Buffer {
  const decoded = typeof value === "string" ? value : new TextDecoder("utf-8", { fatal: true }).decode(value)
  return Buffer.from(decoded.replace(/\r\n?/g, "\n").replace(/\n*$/, "\n"), "utf8")
}
function safeRelative(value: string, label: string): void {
  if (!value || path.isAbsolute(value) || value.split(/[\\/]/).some(part => !part || part === "." || part === "..")) fail(`${label} is unsafe: ${value}`)
}
function strictKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${label} has unknown field ${key}`)
}
/** Check every existing component, including the component that will be created later. */
function assertNoSymlinkComponents(root: string, candidate: string): void {
  const absoluteRoot = path.resolve(root), absolute = path.resolve(candidate)
  if (absolute !== absoluteRoot && !absolute.startsWith(absoluteRoot + path.sep)) fail(`path escapes repository: ${candidate}`)
  let current = absoluteRoot
  const parts = path.relative(absoluteRoot, absolute).split(path.sep).filter(Boolean)
  for (const part of parts) {
    current = path.join(current, part)
    try { if (fs.lstatSync(current).isSymbolicLink()) fail(`symlink is not allowed: ${path.relative(absoluteRoot, current)}`) }
    catch (error: any) { if (error.code !== "ENOENT") throw error; break }
  }
}
function assertNoSymlinkTree(root: string, candidate: string): void {
  assertNoSymlinkComponents(root, candidate)
  if (!fs.existsSync(candidate)) return
  const stat = fs.lstatSync(candidate)
  if (stat.isSymbolicLink()) fail(`symlink is not allowed: ${path.relative(root, candidate)}`)
  if (stat.isDirectory()) for (const name of fs.readdirSync(candidate)) assertNoSymlinkTree(root, path.join(candidate, name))
}
function sourcePath(workspaceRoot: string, source: string): string {
  safeRelative(source, "source")
  const resolved = path.resolve(workspaceRoot, source)
  assertNoSymlinkComponents(workspaceRoot, resolved)
  return resolved
}
function targetCollision(targets: string[]): void {
  const reserved = new Set(["license", "readme.md", "category.json", "provenance.json"])
  const folded = new Map<string, string>()
  for (const target of targets) {
    const key = target.toLocaleLowerCase("en-US")
    if (reserved.has(key) || key.split("/").some(part => reserved.has(part))) fail(`target is reserved for generator-owned metadata: ${target}`)
    if (folded.has(key)) fail(`duplicate/case-folded target ${target}`)
    folded.set(key, target)
  }
  for (const a of targets) for (const b of targets) { const aa = a.toLocaleLowerCase("en-US"), bb = b.toLocaleLowerCase("en-US"); if (a !== b && (aa.startsWith(`${bb}/`) || bb.startsWith(`${aa}/`))) fail("file-directory target collision") }
}

export function validateCategoryManifest(manifest: unknown, workspaceRoot: string): asserts manifest is CategoryManifest {
  if (!manifest || typeof manifest !== "object") fail("manifest must be an object")
  const value = manifest as Record<string, unknown>
  strictKeys(value, ["schemaVersion", "id", "title", "description", "output", "resources", "generated"], "manifest")
  if (value.schemaVersion !== 1 || typeof value.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(value.id) || typeof value.title !== "string" || typeof value.description !== "string" || typeof value.output !== "string" || !Array.isArray(value.resources) || !Array.isArray(value.generated)) fail("schema, identity, or collection fields are invalid")
  safeRelative(value.output as string, "output")
  if (value.output !== `categories/${value.id}`) fail("output must be categories/<id>")
  const targets: string[] = [], sources = new Set<string>()
  for (const raw of value.resources as unknown[]) {
    if (!raw || typeof raw !== "object") fail("resource must be an object")
    const entry = raw as Record<string, unknown>
    strictKeys(entry, ["kind", "source", "target", "primary", "dependency"], "resource")
    if (!RESOURCE_KINDS.has(entry.kind as string) || typeof entry.source !== "string" || typeof entry.target !== "string") fail("resource fields are invalid")
    safeRelative(entry.source, "source"); safeRelative(entry.target, "target")
    if (RESERVED_TARGETS.has(entry.target.toLocaleLowerCase("en-US"))) fail(`target is reserved by the generator: ${entry.target}`)
    if (sources.has(entry.source)) fail(`duplicate source ${entry.source}`); sources.add(entry.source); targets.push(entry.target)
    if (entry.primary !== undefined && typeof entry.primary !== "boolean") fail("primary must be boolean")
    if (entry.dependency !== undefined && (typeof entry.dependency !== "string" || !sources.has(entry.dependency))) fail("dependency must refer to an earlier resource")
    const file = sourcePath(workspaceRoot, entry.source)
    if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) fail(`source is not a file: ${entry.source}`)
    if (entry.source === "categories" || entry.source.startsWith("categories/") || entry.source === "wiki-generator" || entry.source.startsWith("wiki-generator/") || entry.source.includes("/generated/")) fail(`generated source is not allowed: ${entry.source}`)
  }
  for (const raw of value.generated as unknown[]) {
    if (!raw || typeof raw !== "object") fail("generated entry must be an object")
    const entry = raw as Record<string, unknown>
    strictKeys(entry, ["kind", "id", "target"], "generated entry")
    if (entry.kind !== "config" || entry.id !== GENERATED || typeof entry.target !== "string") fail("unknown generated entry")
    safeRelative(entry.target, "target"); targets.push(entry.target)
  }
  targetCollision(targets)
  assertNoSymlinkComponents(workspaceRoot, path.resolve(workspaceRoot, value.output as string))
}
export function loadCategoryManifest(repoRoot: string, id: string): CategoryManifest {
  safeRelative(id, "category")
  const file = path.join(repoRoot, "agents", ".agent-manager", "categories", `${id}.json`)
  if (!fs.existsSync(file)) fail(`manifest not found: ${file}`)
  let parsed: unknown
  try { parsed = JSON.parse(normalized(fs.readFileSync(file)).toString("utf8")) } catch (error: any) { fail(`manifest is not valid UTF-8 JSON: ${error.message}`) }
  validateCategoryManifest(parsed, path.join(repoRoot, "agents")); return parsed
}
function manifestHash(manifest: CategoryManifest): string { return hash(JSON.stringify(manifest) + "\n") }
function expected(workspaceRoot: string, manifest: CategoryManifest): Map<string, Buffer> {
  const result = new Map<string, Buffer>([["LICENSE", normalized(ROOT_LICENSE)]])
  for (const resource of manifest.resources) result.set(resource.target, normalized(fs.readFileSync(sourcePath(workspaceRoot, resource.source))))
  for (const generated of manifest.generated) result.set(generated.target, Buffer.from(GENERATED_OPENCODE))
  return result
}
function generatedReadme(manifest: CategoryManifest): Buffer { return normalized(`# ${manifest.title}\n\n${manifest.description}\n\nThis directory is a generated category distribution and is never canonical. Edit sources under agents/general/ and regenerate with manage-agents category build ${manifest.id}. The Wiki pilot is the first complete, publishable distribution; other category directories are legacy browsing mirrors until they have manifests. Components are selected by the manifest and dependencies, not by filename.\n\nFiles use UTF-8, LF endings, and one final newline. See CATEGORY.json, LICENSE, and PROVENANCE.json.\n`) }
function categoryLock(manifest: CategoryManifest): Buffer { return normalized(JSON.stringify({ schemaVersion: 1, category: manifest.id, manifestHash: manifestHash(manifest), resources: manifest.resources.map(r => ({ kind: r.kind, source: r.source, target: r.target })) }, null, 2)) }
function provenance(manifest: CategoryManifest, contents: Map<string, Buffer>): Buffer {
  const entries = [...contents].sort(([a], [b]) => a.localeCompare(b)).map(([target, bytes]) => ({ target, ...(target === "LICENSE" ? { generated: "repository-license-v1" } : manifest.resources.find(r => r.target === target) ? { source: manifest.resources.find(r => r.target === target)!.source } : { generated: manifest.generated.find(g => g.target === target)?.id || "category-metadata-v1" }), hash: hash(bytes) }))
  return normalized(JSON.stringify({ schemaVersion: 1, category: manifest.id, manifestHash: manifestHash(manifest), entries }, null, 2))
}
function filesUnder(dir: string): string[] { if (!fs.existsSync(dir)) return []; const out: string[] = []; const visit = (current: string) => { for (const name of fs.readdirSync(current)) { const file = path.join(current, name); const stat = fs.lstatSync(file); if (stat.isSymbolicLink()) fail(`symlink is not allowed in output: ${name}`); stat.isDirectory() ? visit(file) : out.push(path.relative(dir, file).split(path.sep).join("/")) } }; visit(dir); return out.sort() }
function paths(workspaceRoot: string, manifest: CategoryManifest) { const output = path.resolve(workspaceRoot, manifest.output); const categories = path.join(workspaceRoot, "categories"); return { output, categories, lock: path.join(workspaceRoot, ".agent-manager", `category-${manifest.id}.lock`) } }
function contentsFor(workspaceRoot: string, manifest: CategoryManifest) { const contents = expected(workspaceRoot, manifest); contents.set("README.md", generatedReadme(manifest)); contents.set("CATEGORY.json", categoryLock(manifest)); contents.set("PROVENANCE.json", provenance(manifest, new Map([...contents]))); return contents }

export function checkCategoryDistribution(repoRoot: string, id: string): CategoryDistributionResult {
  const manifest = loadCategoryManifest(repoRoot, id), workspaceRoot = path.join(repoRoot, "agents"), { output, categories } = paths(workspaceRoot, manifest)
  assertNoSymlinkComponents(repoRoot, workspaceRoot); assertNoSymlinkComponents(repoRoot, categories); assertNoSymlinkComponents(repoRoot, output); if (fs.existsSync(output)) assertNoSymlinkTree(repoRoot, output)
  const contents = contentsFor(workspaceRoot, manifest), missing: string[] = [], changed: string[] = []
  for (const [target, bytes] of contents) { const file = path.join(output, target); if (!fs.existsSync(file)) missing.push(target); else if (hash(fs.readFileSync(file)) !== hash(bytes)) changed.push(target) }
  const extra = filesUnder(output).filter(file => !contents.has(file))
  return { status: missing.length || changed.length || extra.length ? "stale" : "current", missing: missing.sort(), changed: changed.sort(), extra, manifestHash: manifestHash(manifest) }
}
type Identity = { dev: number; ino: number }
function same(a: Identity, b: Identity) { return a.dev === b.dev && a.ino === b.ino }
function withLock<T>(workspaceRoot: string, manifest: CategoryManifest, operation: () => T, callback?: () => void): T {
  const { categories, lock } = paths(workspaceRoot, manifest); assertNoSymlinkComponents(workspaceRoot, workspaceRoot); assertNoSymlinkComponents(workspaceRoot, categories); assertNoSymlinkComponents(workspaceRoot, path.dirname(lock)); fs.mkdirSync(path.dirname(lock), { recursive: true }); assertNoSymlinkComponents(workspaceRoot, path.dirname(lock))
  let fd: number | undefined, identity: Identity | undefined
  try { fd = fs.openSync(lock, "wx"); const stat = fs.fstatSync(fd); identity = { dev: stat.dev, ino: stat.ino }; fs.writeFileSync(fd, `agent-manager category ${manifest.id} lock\n`); callback?.(); return operation() }
  catch (error: any) { if (error.code === "EEXIST") throw new Error(`Another category ${manifest.id} build is already running.`); throw error }
  finally { if (fd !== undefined && identity) { fs.closeSync(fd); try { const stat = fs.lstatSync(lock); if (!stat.isSymbolicLink() && same(identity, { dev: stat.dev, ino: stat.ino })) fs.unlinkSync(lock); else console.error(`Category lock ownership could not be proven; leaving ${lock}.`) } catch {} } }
}
export function buildCategoryDistribution(repoRoot: string, id: string, options: CategoryDistributionOptions = {}): CategoryDistributionResult {
  const manifest = loadCategoryManifest(repoRoot, id), workspaceRoot = path.join(repoRoot, "agents")
  return withLock(workspaceRoot, manifest, () => { const { output, categories } = paths(workspaceRoot, manifest); assertNoSymlinkComponents(repoRoot, workspaceRoot); assertNoSymlinkComponents(repoRoot, categories); fs.mkdirSync(categories, { recursive: true }); assertNoSymlinkComponents(repoRoot, output); const parent = path.dirname(output); const marker = crypto.randomBytes(16).toString("hex"); const staging = fs.mkdtempSync(path.join(parent, `.category-${id}-`)); const backup = path.join(parent, `.category-${id}-backup-${marker}`); const rename = options.rename || fs.renameSync; const contents = contentsFor(workspaceRoot, manifest); assertNoSymlinkComponents(repoRoot, staging); try { for (const [target, bytes] of contents) { const file = path.join(staging, target); assertNoSymlinkComponents(repoRoot, file); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes) }; if (fs.existsSync(output)) { assertNoSymlinkTree(repoRoot, output); rename(output, backup) }; rename(staging, output); if (fs.existsSync(backup)) { const stat = fs.lstatSync(backup); if (!stat.isDirectory()) throw new Error("Backup ownership could not be proven"); fs.rmSync(backup, { recursive: true, force: true }) }; return checkCategoryDistribution(repoRoot, id) } catch (error) { if (fs.existsSync(backup) && !fs.existsSync(output)) rename(backup, output); throw error } finally { if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true }) } }, options.onLockAcquired)
}
export function parseCategoryArgs(args: string[]): { action: "list" | "build" | "check" | "explain"; id?: string } { const [action, id, ...rest] = args.filter(a => a !== "--no-auto-commit"); if (!action || !["list", "build", "check", "explain"].includes(action)) fail("usage: category list|build|check|explain <id>"); if (action === "list") { if (id || rest.length) fail("category list takes no category"); return { action } }; if (!id || rest.length || id === "--all") fail("a single category id is required (or use --all after support is added)"); safeRelative(id, "category"); return { action: action as any, id } }

// Compatibility aliases for callers of the pre-v1 module; the old file itself is removed.
export const validateTopicManifest = validateCategoryManifest
export const loadTopicManifest = (repoRoot: string) => loadCategoryManifest(repoRoot, "wiki")
export const checkTopicExport = (workspaceRoot: string) => checkCategoryDistribution(path.dirname(workspaceRoot), "wiki")
export const exportTopicBundle = (workspaceRoot: string, _manifest?: unknown, options?: CategoryDistributionOptions) => buildCategoryDistribution(path.dirname(workspaceRoot), "wiki", options)
