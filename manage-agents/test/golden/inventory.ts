import { execFileSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const IGNORED = new Set([".resource-export-manifest.json", "opencode.json.bak"])

export interface Inventory {
  structure: {
    files: string[]
    ids: { agents: string[]; commands: string[]; skills: string[]; plugins: string[] }
    config: { keys: string[]; plugins: string[]; mcpServers: string[] }
  }
  hashes: Record<string, string>
}

function walk(root: string, dir = root, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || IGNORED.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(root, full, out)
    else out.push(path.relative(root, full).split(path.sep).join("/"))
  }
  return out
}

export function inventory(root: string): Inventory {
  const files = walk(root).sort()
  const under = (prefix: string, suffix: string) =>
    files.filter(f => f.startsWith(prefix) && f.endsWith(suffix)).map(f => f.slice(prefix.length, -suffix.length))
  const config = JSON.parse(fs.readFileSync(path.join(root, "opencode.json"), "utf8"))
  const hashes: Record<string, string> = {}
  for (const file of files) hashes[file] = crypto.createHash("sha256").update(fs.readFileSync(path.join(root, file))).digest("hex")
  return {
    structure: {
      files,
      ids: {
        agents: under("agents/", ".md"),
        commands: under("commands/", ".md"),
        skills: under("skills/", "/SKILL.md"),
        plugins: [...new Set(files.filter(f => f.startsWith("plugins/")).map(f => f.split("/")[1]))].sort(),
      },
      config: {
        keys: Object.keys(config).sort(),
        plugins: [...(config.plugins ?? [])].map(String).sort(),
        mcpServers: Object.keys(config.mcp?.servers ?? {}).sort(),
      },
    },
    hashes,
  }
}

/** Runs the real CLI export into a throwaway HOME/XDG_CONFIG_HOME and returns the OpenCode config dir. */
export function exportToTemp(repoRoot: string): { configDir: string; cleanup: () => void } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "manage-agents-golden-"))
  const home = path.join(base, "home")
  const xdg = path.join(base, "xdg")
  fs.mkdirSync(home)
  fs.mkdirSync(xdg)
  execFileSync(process.execPath, [path.join(repoRoot, "manage-agents", "manage-agents.mjs"), "--no-auto-commit", "export", "--all", "--yes"], {
    cwd: repoRoot,
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: xdg },
    stdio: "pipe",
  })
  return { configDir: path.join(xdg, "opencode"), cleanup: () => fs.rmSync(base, { recursive: true, force: true }) }
}

export const SNAPSHOT = fileURLToPath(new URL("./export-before.json", import.meta.url))
export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url))

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, dir] = process.argv.slice(2)
  if (command !== "capture") {
    console.error("usage: node --import tsx test/golden/inventory.ts capture [<opencode-config-dir>]")
    process.exit(2)
  }
  const exported = dir ? null : exportToTemp(REPO_ROOT)
  try {
    fs.writeFileSync(SNAPSHOT, `${JSON.stringify(inventory(dir ?? exported!.configDir), null, 2)}\n`)
    console.log(`wrote ${path.relative(process.cwd(), SNAPSHOT)}`)
  } finally {
    exported?.cleanup()
  }
}
