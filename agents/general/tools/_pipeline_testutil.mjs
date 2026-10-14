// Temp-directory helper for the pipeline tests: everything created through mkTmp (and sibling
// directories such as "<dir>-wt" that git worktree tests create next to it) is removed when the
// test process exits.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const created = new Set()

process.once("exit", () => {
  const root = os.tmpdir()
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
  void root
})

export function mkTmp(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  created.add(dir)
  return dir
}
