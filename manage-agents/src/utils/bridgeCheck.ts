import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { findAgentFiles } from "./agents.js"
import { bridgeToClaudeCode } from "./bridge.js"
import { bridgeToCodex } from "./codexBridge.js"
import type { TranslationConfig } from "./translationConfig.js"

/** Relative POSIX path -> file bytes. */
export type TreeSnapshot = Record<string, string | Uint8Array>

export interface TreeDiff {
  /** Paths present in `expected`, absent from `actual`. */
  missing: string[]
  /** Paths present in both whose bytes differ. */
  changed: string[]
  /** Paths present in `actual`, absent from `expected`. */
  extra: string[]
}

export interface BridgeCheckOptions {
  workspaceRoot: string
  target: "claude" | "codex"
  category: string
  config: TranslationConfig
  /** Committed bridge output; must live inside `workspaceRoot`. */
  committedDir: string
}

export interface BridgeCheckResult extends TreeDiff {
  clean: boolean
}

function bytesOf(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? Buffer.from(value, "utf-8") : value
}

function bytesEqual(left: string | Uint8Array, right: string | Uint8Array): boolean {
  const a = bytesOf(left)
  const b = bytesOf(right)
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/** Compare two in-memory snapshots byte-exact; all lists are sorted. */
export function compareTrees(expected: TreeSnapshot, actual: TreeSnapshot): TreeDiff {
  const expectedPaths = Object.keys(expected)
  const actualPaths = Object.keys(actual)
  const expectedSet = new Set(expectedPaths)
  const actualSet = new Set(actualPaths)
  return {
    missing: expectedPaths.filter(file => !actualSet.has(file)).sort(),
    changed: expectedPaths.filter(file => actualSet.has(file) && !bytesEqual(expected[file], actual[file])).sort(),
    extra: actualPaths.filter(file => !expectedSet.has(file)).sort()
  }
}

/** Read a directory as relative POSIX path -> bytes; a missing root is an empty tree. */
function readTree(root: string): TreeSnapshot {
  const tree: TreeSnapshot = {}
  if (!fs.existsSync(root)) return tree
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(fullPath)
      } else if (entry.isFile()) {
        tree[path.relative(root, fullPath).split(path.sep).join("/")] = fs.readFileSync(fullPath)
      }
    }
  }
  walk(root)
  return tree
}

function copyIfPresent(source: string, destination: string): void {
  if (!fs.existsSync(source)) return
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.cpSync(source, destination, { recursive: true })
}

/**
 * Mirror the workspace inputs the bridge reads into the temp root: agent
 * sources and `opencode.json` live under `config.sourceDir`, companion links
 * and the plugin icon are fixed locations. The committed output is never
 * copied: it is compared against the freshly generated tree instead.
 */
function mirrorWorkspaceInputs(workspaceRoot: string, tempRoot: string, config: TranslationConfig): void {
  const copied = new Set<string>()
  const mirror = (relativePath: string) => {
    if (!relativePath || copied.has(relativePath)) return
    copied.add(relativePath)
    copyIfPresent(path.join(workspaceRoot, relativePath), path.join(tempRoot, relativePath))
  }
  mirror(config.sourceDir)
  // Legacy source root: companion resolution falls back to it when `src/` is absent.
  mirror("general")
  mirror(path.join("manage-agents", "assets"))
  mirror(".agent-manager")
}

/** Regenerate the bridge in a temp workspace and compare it with the committed output. */
export function checkBridge(options: BridgeCheckOptions): BridgeCheckResult {
  const { workspaceRoot, target, category, config, committedDir } = options
  const relativeCommitted = path.relative(workspaceRoot, committedDir)
  if (!relativeCommitted || relativeCommitted.startsWith("..") || path.isAbsolute(relativeCommitted)) {
    throw new Error(`Bridge output must live inside the workspace: ${committedDir}`)
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-check-"))
  try {
    mirrorWorkspaceInputs(workspaceRoot, tempRoot, config)
    const agents = findAgentFiles(tempRoot, config.sourceDir).filter(agent => agent.category === category)
    if (agents.length === 0) {
      throw new Error(`No agents found for category '${category}' under ${path.join(workspaceRoot, config.sourceDir)}`)
    }

    const expectedDir = path.join(tempRoot, relativeCommitted)
    if (target === "codex") {
      bridgeToCodex(agents, config.pluginName, config.prefix, expectedDir, tempRoot, config)
    } else {
      bridgeToClaudeCode(agents, config.pluginName, config.prefix, expectedDir, tempRoot, config, { category })
    }

    const diff = compareTrees(readTree(expectedDir), readTree(committedDir))
    return {
      ...diff,
      clean: diff.missing.length === 0 && diff.changed.length === 0 && diff.extra.length === 0
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}
