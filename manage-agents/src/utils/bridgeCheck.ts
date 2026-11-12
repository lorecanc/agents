import fs from "node:fs"
import path from "node:path"
import { withGeneratedPackBridge, type BridgeTarget } from "./bridgeWorkspace.js"
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
  pack: string
  target: BridgeTarget
  /** Also supplies the plugin name and agent prefix. */
  config: TranslationConfig
  /** Committed bridge output, normally `bridges/<claude-code|codex>/<plugin>` in the catalog. */
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

/** Regenerate the bridge of `pack` and compare it with the committed output, without touching it. */
export function checkPackBridge(options: BridgeCheckOptions): BridgeCheckResult {
  const { committedDir, ...bridge } = options
  const diff = withGeneratedPackBridge({ ...bridge, outputDir: committedDir, pluginName: bridge.config.pluginName, prefix: bridge.config.prefix },
    generatedDir => compareTrees(readTree(generatedDir), readTree(committedDir)))
  return { ...diff, clean: diff.missing.length === 0 && diff.changed.length === 0 && diff.extra.length === 0 }
}
