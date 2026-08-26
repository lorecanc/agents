import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"

export interface UiConfig { listShare: number }
export const DEFAULT_UI_CONFIG: UiConfig = { listShare: 2 / 3 }
const MIN_LIST_SHARE = 0.60
const MAX_LIST_SHARE = 0.75
const MAX_CONFIG_BYTES = 64 * 1024
export const MISSING_UI_CONFIG_REVISION = "missing"

export interface UiConfigWriterDeps { renameSync?: typeof fs.renameSync; fstatSync?: typeof fs.fstatSync; beforeRename?: () => void }
export interface UiConfigLoadResult {
  config: UiConfig
  warning?: string
  configPath: string
  source: "environment" | "workspace" | "default"
  readOnly: boolean
  revision: string
}

function validListShare(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= MIN_LIST_SHARE && value <= MAX_LIST_SHARE
}
function sameFile(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === 0 || left.ino === 0 || (left.dev === right.dev && left.ino === right.ino)
}
function hash(bytes: Buffer): string { return crypto.createHash("sha256").update(bytes).digest("hex") }

/** Read a bounded regular file through its descriptor and return its exact bytes. */
function readConfigBytes(configPath: string): { bytes: Buffer; stat?: fs.Stats; revision: string } {
  let pathStat: fs.Stats
  try { pathStat = fs.lstatSync(configPath) } catch (error: any) {
    if (error?.code === "ENOENT") return { bytes: Buffer.alloc(0), revision: MISSING_UI_CONFIG_REVISION }
    throw error
  }
  if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.size > MAX_CONFIG_BYTES) throw new Error("ui-config.json must be a real regular file")
  const noFollow = (fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW
  let flags = fs.constants.O_RDONLY
  if (typeof noFollow === "number") flags |= noFollow
  let fd: number | undefined
  try {
    fd = fs.openSync(configPath, flags)
    const descriptorStat = fs.fstatSync(fd)
    if (!descriptorStat.isFile() || descriptorStat.size > MAX_CONFIG_BYTES || !sameFile(pathStat, descriptorStat)) throw new Error("unsafe config file")
    const bytes = Buffer.alloc(MAX_CONFIG_BYTES + 1)
    let offset = 0
    while (offset < bytes.length) { const count = fs.readSync(fd, bytes, offset, bytes.length - offset, null); if (!count) break; offset += count }
    if (offset > MAX_CONFIG_BYTES) throw new Error("config is oversized")
    return { bytes: bytes.subarray(0, offset), stat: descriptorStat, revision: hash(bytes.subarray(0, offset)) }
  } finally { if (fd !== undefined) try { fs.closeSync(fd) } catch { /* best effort */ } }
}

/** Load the optional, read-only UI configuration for the TUI. */
export function loadUiConfig(workspaceRoot: string): UiConfigLoadResult {
  const configuredPath = process.env.AGENT_MANAGER_UI_CONFIG
  const configPath = configuredPath || path.join(workspaceRoot, ".agent-manager", "ui-config.json")
  const source = configuredPath ? "environment" : "workspace"
  let current: { bytes: Buffer; stat?: fs.Stats; revision: string }
  try { current = readConfigBytes(configPath) } catch (error: any) {
    return { config: DEFAULT_UI_CONFIG, warning: error?.message?.includes("regular file") ? "UI config is not a valid regular file; using defaults." : "UI config could not be read; using defaults.", configPath, source: configuredPath ? source : "default", readOnly: !!configuredPath, revision: MISSING_UI_CONFIG_REVISION }
  }
  if (!current.stat) return { config: DEFAULT_UI_CONFIG, configPath, source: configuredPath ? source : "default", readOnly: !!configuredPath, revision: MISSING_UI_CONFIG_REVISION }
  try {
    const parsed: any = JSON.parse(current.bytes.toString("utf8"))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.version !== 1 || !validListShare(parsed.listShare)) throw new Error("invalid")
    return { config: { listShare: parsed.listShare }, configPath, source, readOnly: !!configuredPath, revision: current.revision }
  } catch {
    return { config: DEFAULT_UI_CONFIG, warning: "UI config is invalid; using defaults.", configPath, source: configuredPath ? source : "default", readOnly: !!configuredPath, revision: current.revision }
  }
}

function writeAll(fd: number, bytes: Buffer): void { let offset = 0; while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset) }

/** Safely persist the workspace-local UI configuration. Portable Node cannot defeat an active same-user path attacker. */
export function saveUiConfig(workspaceRoot: string, listShare: number, expectedRevisionOrDeps?: string | UiConfigWriterDeps, suppliedDeps: UiConfigWriterDeps = {}): string {
  const expectedRevision = typeof expectedRevisionOrDeps === "string" ? expectedRevisionOrDeps : undefined
  const deps = typeof expectedRevisionOrDeps === "string" || expectedRevisionOrDeps === undefined ? suppliedDeps : expectedRevisionOrDeps
  if (process.env.AGENT_MANAGER_UI_CONFIG) throw new Error("UI config is read-only when AGENT_MANAGER_UI_CONFIG is set")
  if (!validListShare(listShare)) throw new Error("listShare must be a finite number between 0.60 and 0.75")
  const realWorkspace = fs.realpathSync(workspaceRoot)
  const managerDir = path.join(realWorkspace, ".agent-manager")
  try { fs.mkdirSync(managerDir, { mode: 0o700 }) } catch (error: any) { if (error?.code !== "EEXIST") throw error }
  const managerStat = fs.lstatSync(managerDir)
  if (!managerStat.isDirectory() || managerStat.isSymbolicLink()) throw new Error(".agent-manager must be a real directory")
  const parentBefore = fs.statSync(managerDir)
  const target = path.join(managerDir, "ui-config.json")
  const lockPath = path.join(managerDir, "ui-config.lock")
  let lockFd: number | undefined
  let lockIdentity: fs.Stats | undefined
  let lockCreated = false
  const lockToken = crypto.randomBytes(32)
  let temporary: string | undefined
  let ownsTemporary = false
  try {
    try {
      lockFd = fs.openSync(lockPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600)
      lockCreated = true
      writeAll(lockFd, lockToken); fs.fsyncSync(lockFd)
      try { lockIdentity = (deps.fstatSync || fs.fstatSync)(lockFd) }
      catch (error) { try { fs.closeSync(lockFd) } catch { /* best effort */ }; lockFd = undefined; throw error }
    }
    catch (error: any) { if (error?.code === "EEXIST") throw new Error("configuration is busy; another instance holds the UI config lock"); throw error }
    const lockPathStat = fs.lstatSync(lockPath)
    if (lockPathStat.isSymbolicLink() || !lockPathStat.isFile() || !sameFile(lockIdentity!, lockPathStat)) throw new Error("configuration lock changed")
    const current = readConfigBytes(target)
    if (expectedRevision !== undefined && current.revision !== expectedRevision) throw new Error("configuration changed; reload and retry")
    const targetMode = current.stat ? current.stat.mode & 0o777 : 0o600
    temporary = path.join(managerDir, `.ui-config.json.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    let fd: number | undefined
    try {
      fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600); ownsTemporary = true
      const bytes = Buffer.from(JSON.stringify({ version: 1, listShare }) + "\n")
      writeAll(fd, bytes); fs.fchmodSync(fd, targetMode); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined
      const parentAfter = fs.statSync(managerDir)
      if (parentBefore.dev !== parentAfter.dev || parentBefore.ino !== parentAfter.ino) throw new Error("configuration directory changed")
      deps.beforeRename?.()
      try {
        const stat = fs.lstatSync(target)
        if (!stat.isFile() || stat.isSymbolicLink() || (current.stat ? current.stat.dev !== stat.dev || current.stat.ino !== stat.ino : true)) throw new Error("configuration target changed")
      } catch (error: any) {
        if (error?.code === "ENOENT" && current.stat) throw new Error("configuration target changed")
        if (error?.code !== "ENOENT") throw error
      }
      ;(deps.renameSync || fs.renameSync)(temporary, target); ownsTemporary = false
      try { const dirfd = fs.openSync(managerDir, "r"); try { fs.fsyncSync(dirfd) } finally { fs.closeSync(dirfd) } } catch { /* best effort */ }
      return hash(bytes)
    } finally { if (fd !== undefined) try { fs.closeSync(fd) } catch { /* best effort */ } }
  } finally {
    if (temporary && ownsTemporary) try { const stat = fs.lstatSync(temporary); if (stat.isFile() && !stat.isSymbolicLink()) fs.unlinkSync(temporary) } catch { /* owned temp only */ }
    if (lockCreated) {
      if (lockFd !== undefined) try { fs.closeSync(lockFd) } catch { /* best effort */ }
      try {
        const stat = fs.lstatSync(lockPath)
        let owned = !!lockIdentity && stat.isFile() && !stat.isSymbolicLink() && sameFile(lockIdentity, stat)
        if (!lockIdentity && lockCreated && stat.isFile() && !stat.isSymbolicLink() && stat.size === lockToken.length) {
          const fd = fs.openSync(lockPath, fs.constants.O_RDONLY | ((fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW || 0))
          try { const bytes = Buffer.alloc(lockToken.length); owned = fs.readSync(fd, bytes, 0, bytes.length, 0) === bytes.length && bytes.equals(lockToken) } finally { fs.closeSync(fd) }
        }
        if (owned) fs.unlinkSync(lockPath)
      } catch { /* preserve foreign/replaced lock */ }
    }
  }
}
