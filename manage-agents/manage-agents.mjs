#!/usr/bin/env node
import { existsSync, readdirSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { spawnSync } from "node:child_process"
import { constants as osConstants } from "node:os"

if (!process.versions.bun) {
  const requiredNode = [26, 1, 0]
  const versionMatch = process.versions.node.match(/^((?:0|[1-9]\d*))\.((?:0|[1-9]\d*))\.((?:0|[1-9]\d*))(?:-(?:(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/)
  const actualNode = versionMatch ? versionMatch.slice(1).map(Number) : [0, 0, 0]
  const isSupported = actualNode[0] > requiredNode[0] ||
    (actualNode[0] === requiredNode[0] && (actualNode[1] > requiredNode[1] ||
      (actualNode[1] === requiredNode[1] && actualNode[2] >= requiredNode[2])))

  if (!isSupported) {
    console.error(`manage-agents requires Node.js >= 26.1.0 (found ${process.versions.node}). OpenTUI uses FFI; install Bun, or upgrade Node to >= 26.1.0.`)
    process.exit(1)
  }

  if (!process.execArgv.includes("--experimental-ffi")) {
    const result = spawnSync(process.execPath, ["--experimental-ffi", ...process.argv.slice(1)], { stdio: "inherit" })
    if (result.error) {
      console.error(`Failed to re-exec with --experimental-ffi: ${result.error.message}`)
      process.exit(1)
    }
    if (result.signal) {
      process.exit(128 + (osConstants.signals[result.signal] ?? 1))
    }
    process.exit(result.status ?? 1)
  }
}

const scriptDir = dirname(fileURLToPath(import.meta.url))
const distPath = join(scriptDir, "dist", "index.js")
const srcDir = join(scriptDir, "src")

function newestSourceMtime(directory) {
  return readdirSync(directory, { withFileTypes: true }).reduce((latest, entry) => {
    const entryPath = join(directory, entry.name)
    if (entry.isDirectory()) return Math.max(latest, newestSourceMtime(entryPath))
    return Math.max(latest, statSync(entryPath).mtimeMs)
  }, 0)
}

if (!existsSync(distPath) || statSync(distPath).mtimeMs < newestSourceMtime(srcDir)) {
  const result = spawnSync(process.versions.bun ? "bun run build" : "npm run build", { cwd: scriptDir, shell: true, stdio: "inherit" })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

await import(pathToFileURL(distPath).href)
