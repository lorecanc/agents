import fs from "node:fs"
import path from "node:path"

export interface UiConfig {
  listShare: number
}

export const DEFAULT_UI_CONFIG: UiConfig = { listShare: 2 / 3 }
const MIN_LIST_SHARE = 0.60
const MAX_LIST_SHARE = 0.75
const MAX_CONFIG_BYTES = 64 * 1024

function validListShare(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= MIN_LIST_SHARE && value <= MAX_LIST_SHARE
}

function sameFile(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === 0 || left.ino === 0 || (left.dev === right.dev && left.ino === right.ino)
}

/** Load the optional, read-only UI configuration for the TUI. */
export function loadUiConfig(workspaceRoot: string): { config: UiConfig; warning?: string } {
  const configuredPath = process.env.AGENT_MANAGER_UI_CONFIG
  const configPath = configuredPath || path.join(workspaceRoot, ".agent-manager", "ui-config.json")

  let stat: fs.Stats
  try {
    stat = fs.lstatSync(configPath)
  } catch (error: any) {
    if (error?.code === "ENOENT") return { config: DEFAULT_UI_CONFIG }
    return { config: DEFAULT_UI_CONFIG, warning: "UI config could not be read; using defaults." }
  }

  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONFIG_BYTES) {
    return { config: DEFAULT_UI_CONFIG, warning: "UI config is not a valid regular file; using defaults." }
  }

  let fd: number | undefined
  try {
    const noFollow = (fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW
    let flags = fs.constants.O_RDONLY
    if (typeof noFollow === "number") flags |= noFollow
    try {
      fd = fs.openSync(configPath, flags)
    } catch (error: any) {
      // Some platforms expose O_NOFOLLOW but do not support it. Recheck the
      // path before the conservative read-only fallback and verify the fd.
      if (typeof noFollow !== "number" || !["EINVAL", "ENOTSUP", "EOPNOTSUPP"].includes(error?.code)) throw error
      const beforeFallback = fs.lstatSync(configPath)
      if (!beforeFallback.isFile() || beforeFallback.isSymbolicLink()) throw new Error("unsafe config path")
      fd = fs.openSync(configPath, fs.constants.O_RDONLY)
    }

    const descriptorStat = fs.fstatSync(fd)
    if (!descriptorStat.isFile() || descriptorStat.size > MAX_CONFIG_BYTES || !sameFile(stat, descriptorStat)) throw new Error("unsafe config file")

    const buffer = Buffer.allocUnsafe(MAX_CONFIG_BYTES + 1)
    let offset = 0
    while (offset < buffer.length) {
      const count = fs.readSync(fd, buffer, offset, buffer.length - offset, null)
      if (count === 0) break
      offset += count
    }
    if (offset > MAX_CONFIG_BYTES) throw new Error("config is oversized")

    const parsed: unknown = JSON.parse(buffer.subarray(0, offset).toString("utf8"))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || (parsed as any).version !== 1 || !validListShare((parsed as any).listShare)) {
      return { config: DEFAULT_UI_CONFIG, warning: "UI config is invalid; using defaults." }
    }
    return { config: { listShare: (parsed as any).listShare } }
  } catch {
    return { config: DEFAULT_UI_CONFIG, warning: "UI config could not be parsed; using defaults." }
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd) } catch { /* best effort */ }
    }
  }
}
