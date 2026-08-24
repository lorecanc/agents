import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import crypto from "node:crypto"
import { spawn } from "node:child_process"
import { validateCategoryPackage, checkCategoryDistribution, loadCategoryManifest, type CategoryPackageMarker } from "./categoryDistribution.js"

export const CATEGORY_DESTINATIONS = { wiki: "lorecanc/agents-wiki", docs: "lorecanc/agents-docs", slides: "lorecanc/agents-slides" } as const
export type CategoryId = keyof typeof CATEGORY_DESTINATIONS
export type CommandRunner = (command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }) => Promise<{ stdout: string; stderr: string; status: number }>
export type PublicationOptions = { packageRoot: string; canonicalRoot: string; category: CategoryId; sourceSha: string; confirmRemote: boolean; bootstrap?: boolean; dryRun?: boolean; token?: string; run?: CommandRunner; fetchImpl?: typeof fetch }

const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const sha = /^[0-9a-f]{40}$/i
const safeId = /^[a-z0-9][a-z0-9-]*$/
const redact = (message: string, token?: string) => token ? message.replaceAll(token, "[REDACTED]") : message
const defaultRun: CommandRunner = (command, args, options = {}) => new Promise((resolve, reject) => { const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] }); let stdout = "", stderr = ""; child.stdout.on("data", b => { stdout += b }); child.stderr.on("data", b => { stderr += b }); child.on("error", reject); child.on("close", status => resolve({ stdout, stderr, status: status ?? 1 })) })

export function publicationMetadata(category: CategoryId, version: string, sourceSha: string) {
  if (!semver.test(version) || !/^[0-9a-f]{7,64}$/i.test(sourceSha)) throw new Error("Invalid publication version or source SHA")
  return { repository: CATEGORY_DESTINATIONS[category], branch: `automation/category-${version}-${sourceSha.slice(0, 8)}`, title: `Publish ${category} category ${version}`, category, version, sourceSha }
}

function walk(root: string): string[] { const result: string[] = []; const visit = (current: string) => { const stat = fs.lstatSync(current); if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error(`Destination contains an unsafe entry: ${path.relative(root, current)}`); if (stat.isDirectory()) { for (const name of fs.readdirSync(current).sort()) if (name !== ".git") visit(path.join(current, name)) } else result.push(path.relative(root, current).split(path.sep).join("/")) }; visit(root); return result }
function marker(root: string, strict = true): any | undefined { const file = path.join(root, "CATEGORY.json"); if (!fs.existsSync(file)) return undefined; const value = JSON.parse(fs.readFileSync(file, "utf8")); if (!value || !safeId.test(value.category) || (strict && (value.schemaVersion !== 2 || typeof value.generatorVersion !== "string" || !semver.test(value.distributionVersion) || !/^[0-9a-f]{64}$/.test(value.manifestHash) || !Array.isArray(value.entries)))) throw new Error("Destination marker is not a valid managed category marker"); return value }
function versionParts(value: string): [number, number, number, string[]] { const match = value.match(/^(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?/)!; return [+match[1], +match[2], +match[3], match[4]?.split(".") || []] }
function newerVersion(incoming: string, current: string): boolean { const a = versionParts(incoming), b = versionParts(current); for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]; if (!a[3].length && b[3].length) return true; if (a[3].length !== b[3].length) return a[3].length > b[3].length; for (let i = 0; i < a[3].length; i++) { const x = a[3][i], y = b[3][i]; if (x === y) continue; const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y); if (xn && yn) return +x > +y; if (xn !== yn) return !xn; return x > y } return false }
export function validateDestination(root: string, category: CategoryId, incomingVersion?: string, bootstrap = false): void { const current = marker(root, incomingVersion !== undefined); const files = walk(root); if (!current) { if (!bootstrap || files.some(file => file !== ".github" && !file.startsWith(".github/"))) throw new Error("Destination is unmanaged; bootstrap CATEGORY.json first"); return } if (current.category !== category) throw new Error("Destination category does not match"); if (incomingVersion && !(semver.test(incomingVersion) && newerVersion(incomingVersion, current.distributionVersion))) throw new Error("Incoming category version must be strictly greater") }

export async function publishCategory(options: PublicationOptions): Promise<{ branch: string; repository: string; dryRun: boolean }> {
  const { packageRoot, canonicalRoot, category, sourceSha, confirmRemote, bootstrap = false, dryRun = false, token } = options
  if (!safeId.test(category) || !(category in CATEGORY_DESTINATIONS)) throw new Error("Invalid category")
  if (!sha.test(sourceSha)) throw new Error("sourceSha must be exactly 40 hexadecimal characters")
  if (!confirmRemote && !dryRun) throw new Error("--confirm-remote is required")
  const packageMarker: CategoryPackageMarker = validateCategoryPackage(packageRoot)
  if (packageMarker.sourceSha !== sourceSha) throw new Error("Package source SHA does not match publication source SHA")
  const selected = packageMarker.categories.find(item => item.id === category); if (!selected) throw new Error(`Package does not contain category ${category}`)
  if (checkCategoryDistribution(canonicalRoot, category).status !== "current") throw new Error("Canonical category is not current")
  const manifest = loadCategoryManifest(canonicalRoot, category), canonical = path.join(canonicalRoot, "agents/categories", category), canonicalFiles = walk(canonical).filter(file => !file.startsWith(".git/")).map(file => ({ path: `${category}/${file}`, sha256: crypto.createHash("sha256").update(fs.readFileSync(path.join(canonical, file))).digest("hex"), size: fs.statSync(path.join(canonical, file)).size })).sort((a, b) => a.path.localeCompare(b.path))
  if (selected.version !== manifest.distributionVersion || selected.manifestHash !== JSON.parse(fs.readFileSync(path.join(canonical, "CATEGORY.json"), "utf8")).manifestHash || JSON.stringify(canonicalFiles) !== JSON.stringify(packageMarker.entries.filter(e => e.path.startsWith(`${category}/`)).sort((a, b) => a.path.localeCompare(b.path)))) throw new Error("Package does not match canonical generated category")
  const metadata = publicationMetadata(category, selected.version, sourceSha)
  if (dryRun) return { branch: metadata.branch, repository: metadata.repository, dryRun: true }
  if (!token) throw new Error("CATEGORY_PUBLISH_TOKEN is required")
  const run = options.run || defaultRun, fetchImpl = options.fetchImpl || fetch
  const headers = { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` }
  const response = await fetchImpl(`https://api.github.com/repos/${metadata.repository}`, { headers })
  if (!response.ok) throw new Error(`Destination repository preflight failed (${response.status})`)
  const remote: any = await response.json(); if (remote.archived || !remote.default_branch) throw new Error("Destination repository is archived or has no default branch")
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "category-publication-"))
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_HTTP_EXTRAHEADER: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}` }; delete env.CATEGORY_PUBLISH_TOKEN
  try {
    const clone = await run("git", ["clone", "--branch", remote.default_branch, `https://github.com/${metadata.repository}.git`, temp], { env }); if (clone.status) throw new Error(redact(clone.stderr || "git clone failed", token))
    validateDestination(temp, category, selected.version, bootstrap)
    const target = path.join(temp, category); fs.mkdirSync(target, { recursive: true })
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true }); fs.mkdirSync(target, { recursive: true })
    for (const entry of packageMarker.entries.filter(entry => entry.path.startsWith(`${category}/`))) { const relative = entry.path.slice(category.length + 1), source = path.join(packageRoot, entry.path), destination = path.join(target, relative); fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.copyFileSync(source, destination) }
    const markerFile = path.join(temp, "CATEGORY.json"); fs.writeFileSync(markerFile, JSON.stringify({ schemaVersion: 2, category, generatorVersion: "2.0.0", distributionVersion: selected.version, manifestHash: selected.manifestHash, entries: packageMarker.entries.filter(e => e.path.startsWith(`${category}/`)).map(e => ({ path: e.path.slice(category.length + 1), sha256: e.sha256, size: e.size })) }, null, 2) + "\n")
    const branch = await run("git", ["checkout", "-b", metadata.branch], { cwd: temp, env }); if (branch.status) throw new Error(redact(branch.stderr, token))
    const add = await run("git", ["add", "--", category, "CATEGORY.json"], { cwd: temp, env }); if (add.status) throw new Error(redact(add.stderr, token))
    const commit = await run("git", ["commit", "-m", metadata.title], { cwd: temp, env }); if (commit.status) throw new Error(redact(commit.stderr || "Refusing empty publication", token))
    const push = await run("git", ["push", "origin", metadata.branch], { cwd: temp, env }); if (push.status) throw new Error(redact(push.stderr, token))
    const pull = await fetchImpl(`https://api.github.com/repos/${metadata.repository}/pulls`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ title: metadata.title, head: metadata.branch, base: remote.default_branch, body: `Generated from agents source ${sourceSha}.` }) })
    if (!pull.ok) {
      let body: any = {}; try { body = await pull.json() } catch {}
      if (pull.status !== 422) throw new Error(redact(`Pull request creation failed (${pull.status}): ${body.message || "malformed response"}`, token))
      const existing = await fetchImpl(`https://api.github.com/repos/${metadata.repository}/pulls?state=open&head=${encodeURIComponent(metadata.repository.split("/")[0] + ":" + metadata.branch)}&base=${encodeURIComponent(remote.default_branch)}`, { headers })
      const prs: any = await existing.json(); if (!existing.ok || !Array.isArray(prs) || !prs.some((pr: any) => pr.head?.ref === metadata.branch && pr.base?.ref === remote.default_branch)) throw new Error("Pull request conflict was not confirmed for the requested branch and base")
    }
    return { branch: metadata.branch, repository: metadata.repository, dryRun: false }
  } finally { fs.rmSync(temp, { recursive: true, force: true }) }
}
