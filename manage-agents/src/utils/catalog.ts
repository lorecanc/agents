import fs from "node:fs"
import path from "node:path"
import { MANIFEST_FILE, PACK_NAME_RE } from "./packs.js"

// A pack catalog is a local source laid out as packs/<name>/opencode-pack.json: what the TUI, the agent commands and
// the bridges edit and read. A single pack directory is a catalog of one.

export const packsDir = (workspaceRoot: string) => path.join(workspaceRoot, "packs")

/** Directory of a pack of the catalog, or null when there is none of that name (or it is a symlink). */
export function packDir(workspaceRoot: string, name: string): string | null {
  if (!PACK_NAME_RE.test(name)) return null
  if (fs.existsSync(path.join(workspaceRoot, MANIFEST_FILE))) {
    return readManifest(workspaceRoot).name === name ? workspaceRoot : null
  }
  const dir = path.join(packsDir(workspaceRoot), name)
  // A linked pack directory would bring content from outside the catalog into edits, installs and bridges.
  if (fs.lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink()) return null
  return fs.existsSync(path.join(dir, MANIFEST_FILE)) ? dir : null
}

export function readManifest(dir: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_FILE), "utf8"))
}

/** The pack and every pack it requires, transitively, dependencies first. */
export function resolvePackClosure(workspaceRoot: string, name: string): string[] {
  const ordered: string[] = []
  const visiting = new Set<string>()
  const visit = (pack: string, from: string | null) => {
    if (ordered.includes(pack)) return
    if (visiting.has(pack)) throw new Error(`dependency cycle through ${pack}`)
    const dir = packDir(workspaceRoot, pack)
    if (!dir) throw new Error(from ? `${from} requires ${pack}, which is not in the catalog` : `no pack ${pack} in the catalog`)
    visiting.add(pack)
    for (const dependency of Object.keys(readManifest(dir).requires ?? {}).sort()) visit(dependency, pack)
    visiting.delete(pack)
    ordered.push(pack)
  }
  visit(name, null)
  return ordered
}
