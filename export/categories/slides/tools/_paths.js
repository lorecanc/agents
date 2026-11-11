import { fileURLToPath } from "node:url"
import path from "path"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export const TOOLS_DIR = __dirname

/** The OpenCode config directory: the parent of the nearest `tools/`, so it holds for tools/x and tools/<pack>/x. */
export function configRootOf(dir) {
  for (let current = dir; ; current = path.dirname(current)) {
    if (path.basename(current) === "tools") return path.dirname(current)
    if (path.dirname(current) === current) return path.dirname(dir)
  }
}

export const CONFIG_DIR = configRootOf(TOOLS_DIR)

export function opencodePath(...segments) {
  return path.join(TOOLS_DIR, ...segments)
}

/** A path under the OpenCode config directory (venv/, node_modules/, office/, plugins/, ...). */
export function configPath(...segments) {
  return path.join(CONFIG_DIR, ...segments)
}
