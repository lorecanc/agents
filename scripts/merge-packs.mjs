// Builds .tree/: every pack merged into one directory with the layout OpenCode gets when the packs are installed.
// Catalog tests and the bench run from there, because packs import each other's files through that layout.
// The real installer is manage-agents; this script copies files only (no config merge, no routing).
//
//   node scripts/merge-packs.mjs [--out .tree]

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const PACKS = path.join(ROOT, "packs")
const SKIPPED_ROOT_FILES = /^(?:opencode-pack\.json|opencode\.jsonc?|AGENTS\.md|(?:README|LICENSE|LICENCE|CHANGELOG)(?:\.(?:md|txt|rst))?)$/i

export function mergePacks(out = path.join(ROOT, ".tree")) {
  fs.rmSync(out, { recursive: true, force: true })
  const owners = new Map()
  for (const pack of fs.readdirSync(PACKS).sort()) {
    const dir = path.join(PACKS, pack)
    if (!fs.existsSync(path.join(dir, "opencode-pack.json"))) continue
    const visit = (current) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name)
        const rel = path.relative(dir, full).split(path.sep).join("/")
        if (entry.name === "node_modules" || entry.name === "__pycache__" || entry.name === ".DS_Store") continue
        if (entry.isDirectory()) { visit(full); continue }
        if (!rel.includes("/") && SKIPPED_ROOT_FILES.test(rel)) continue
        if (owners.has(rel)) throw new Error(`${rel} is in both ${owners.get(rel)} and ${pack}`)
        owners.set(rel, pack)
        const target = path.join(out, rel)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.copyFileSync(full, target)
        fs.chmodSync(target, fs.statSync(full).mode & 0o777)
      }
    }
    visit(dir)
  }
  return owners.size
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf("--out")
  const out = index === -1 ? undefined : path.resolve(process.argv[index + 1])
  console.log(`merged ${mergePacks(out)} files into ${path.relative(process.cwd(), out ?? path.join(ROOT, ".tree")) || "."}`)
}
