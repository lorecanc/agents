import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type test from "node:test"
import { MANIFEST_FILE } from "../src/utils/packs.js"

export const BASE_MANIFEST = { contract: "1.0", name: "demo", version: "1.0.0", description: "demo pack" }

export function tempDir(t: test.TestContext, prefix = "manage-agents-test-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Writes files (and a manifest merged over BASE_MANIFEST unless null) into dir. */
export function writePack(dir: string, files: Record<string, string>, manifest: Record<string, unknown> | null = {}): string {
  fs.mkdirSync(dir, { recursive: true })
  if (manifest) fs.writeFileSync(path.join(dir, MANIFEST_FILE), JSON.stringify({ ...BASE_MANIFEST, ...manifest }))
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), content)
  }
  return dir
}

export const makePack = (t: test.TestContext, files: Record<string, string>, manifest: Record<string, unknown> | null = {}) =>
  writePack(tempDir(t, "manage-agents-pack-"), files, manifest)
