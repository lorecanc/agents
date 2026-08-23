import path from "node:path"

export function isWorkspaceRelativePath(value: string): boolean {
  return !path.isAbsolute(value) && !value.split(/[\\/]/).includes("..")
}

export function isPathInsideWorkspace(workspaceRoot: string, candidate: string): boolean {
  const root = path.resolve(workspaceRoot)
  const resolved = path.resolve(root, candidate)
  return resolved === root || resolved.startsWith(`${root}${path.sep}`)
}
