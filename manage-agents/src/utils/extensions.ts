import fs from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { AgentInfo, ExportOptions } from "./agents.js"
import { terminalSafeText } from "./terminalText.js"

/**
 * A repository can ship local behavior next to the shared manager without editing it: a bundle placed
 * beside dist/index.js (dist/extensions.js) that exports a ManagerExtension. When the file is absent
 * nothing happens, so a repository without extensions behaves exactly as before.
 */
export interface ExtensionCommandContext {
  /** Arguments after the command name. */
  argv: string[]
  workspaceRoot: string
}

export interface AfterExportContext {
  destinationPath: string
  exported: string[]
  agents: AgentInfo[]
  options: ExportOptions
}

export interface AfterExportOutcome {
  /** Opaque data copied to ExportResult.extras. */
  extras?: Record<string, unknown>
  /** Shown to the user next to the other export warnings. */
  warnings?: string[]
}

export interface ManagerExtension {
  /** CLI commands or flags (for example "update", "--version") owned by the extension. Built-in commands win. */
  commands?: Record<string, (context: ExtensionCommandContext) => Promise<void> | void>
  /** Runs at the end of every export; a thrown error becomes a warning and never fails the export. */
  afterExport?: (context: AfterExportContext) => AfterExportOutcome | void
}

let loaded: ManagerExtension | null = null

export function getExtension(): ManagerExtension | null {
  return loaded
}

export function setExtension(extension: ManagerExtension | null): void {
  loaded = extension
}

function isExtension(value: unknown): value is ManagerExtension {
  if (value === null || typeof value !== "object") return false
  const candidate = value as ManagerExtension
  if (candidate.commands !== undefined && (candidate.commands === null || typeof candidate.commands !== "object")) return false
  if (candidate.afterExport !== undefined && typeof candidate.afterExport !== "function") return false
  return true
}

/** Loads the optional extension bundle. A missing file is the normal case; a broken one is reported and ignored. */
export async function loadExtension(file: URL | string): Promise<ManagerExtension | null> {
  let filePath: string
  try {
    filePath = typeof file === "string" ? file : fileURLToPath(file)
  } catch {
    return null
  }
  if (!fs.existsSync(filePath)) return null
  try {
    const module = await import(pathToFileURL(filePath).href)
    const candidate = module.default ?? module.extension
    if (!isExtension(candidate)) throw new Error("it does not export a valid manager extension")
    loaded = candidate
    return candidate
  } catch (error) {
    console.error(`Warning: manager extension ${filePath} was not loaded: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

export function runAfterExport(
  hook: ManagerExtension["afterExport"] | undefined,
  context: AfterExportContext
): { extras?: Record<string, unknown>; warnings: string[] } {
  if (!hook) return { warnings: [] }
  try {
    const outcome = hook(context) as AfterExportOutcome | undefined
    return {
      ...(outcome?.extras ? { extras: outcome.extras } : {}),
      warnings: (outcome?.warnings ?? []).map(warning => terminalSafeText(warning))
    }
  } catch (error) {
    return { warnings: [terminalSafeText(`Extension afterExport failed: ${error instanceof Error ? error.message : String(error)}`)] }
  }
}
