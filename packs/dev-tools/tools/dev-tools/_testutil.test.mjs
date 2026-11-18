// Temp-directory helper for the pipeline tests: everything created through mkTmp (and sibling
// directories such as "<dir>-wt" that git worktree tests create next to it) is removed when the
// test process exits.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const created = new Set()

function isSafeTmpRoot(root, cwd) {
  const relative = path.relative(cwd, root)
  const insideCwd = relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  return !insideCwd && !root.split(path.sep).includes(".git")
}

process.once("exit", () => {
  for (const dir of created) {
    try {
      const base = path.basename(dir)
      for (const name of fs.readdirSync(path.dirname(dir))) {
        if (name === base || name.startsWith(`${base}-`)) fs.rmSync(path.join(path.dirname(dir), name), { recursive: true, force: true })
      }
    } catch {
      /* best effort */
    }
  }
})

export function mkTmp(prefix) {
  const cwd = fs.realpathSync.native(process.cwd())
  let tmpRoot = fs.realpathSync.native(os.tmpdir())
  if (!isSafeTmpRoot(tmpRoot, cwd)) {
    if (process.platform === "win32") throw new Error("No safe system temporary directory is available")
    tmpRoot = fs.realpathSync.native("/tmp")
    fs.accessSync(tmpRoot, fs.constants.W_OK | fs.constants.X_OK)
    if (!isSafeTmpRoot(tmpRoot, cwd)) throw new Error("No safe system temporary directory is available")
  }

  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpRoot, prefix)))
  created.add(dir)
  return dir
}
