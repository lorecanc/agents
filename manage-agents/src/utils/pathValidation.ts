import fs from "node:fs"
import path from "node:path"

export function isWorkspaceRelativePath(value: string): boolean {
  return !path.isAbsolute(value) && !value.split(/[\\/]/).includes("..")
}

export function isPathInsideWorkspace(workspaceRoot: string, candidate: string): boolean {
  const root = path.resolve(workspaceRoot)
  const resolved = path.resolve(root, candidate)
  return resolved === root || resolved.startsWith(`${root}${path.sep}`)
}

/**
 * Resolve a target to a realpath even when the leaf does not exist yet:
 * walk up to the nearest existing ancestor, resolve it through any symlinks,
 * then rejoin the not-yet-existing tail components.
 */
export function realpathThroughExistingAncestor(target: string): string {
  let existingAncestor = path.resolve(target)
  const remaining: string[] = []
  while (!fs.existsSync(existingAncestor)) {
    remaining.unshift(path.basename(existingAncestor))
    existingAncestor = path.dirname(existingAncestor)
  }
  return path.join(fs.realpathSync(existingAncestor), ...remaining)
}

/**
 * Throw unless resolvedCandidate stays inside the real workspace root.
 * `originalPath` is echoed verbatim in the error for actionable messages.
 */
export function assertInsideRealWorkspace(workspaceRoot: string, resolvedCandidate: string, originalPath: string): void {
  const relative = path.relative(fs.realpathSync(workspaceRoot), resolvedCandidate)
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Invalid plugin output path outside workspace: ${originalPath}`)
  }
}
