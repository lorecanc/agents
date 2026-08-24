import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { test } from "node:test"
import { CATEGORY_DESTINATIONS, publicationMetadata, publishCategory, validateDestination } from "./categoryPublication.js"

const repo = path.resolve(process.cwd(), "..")
const sourceSha = "0123456789abcdef0123456789abcdef01234567"

function packageFixture(category: "wiki" | "docs" | "slides" = "wiki"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "category-package-fixture-"))
  const source = path.join(repo, "agents/categories", category), entries: any[] = []
  for (const name of fs.readdirSync(source, { recursive: true }).map(String).filter(n => fs.statSync(path.join(source, n)).isFile()).sort()) {
    const bytes = fs.readFileSync(path.join(source, name)); fs.mkdirSync(path.dirname(path.join(root, category, name)), { recursive: true }); fs.copyFileSync(path.join(source, name), path.join(root, category, name)); entries.push({ path: `${category}/${name}`, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), size: bytes.length })
  }
  const digest = (items: any[]) => crypto.createHash("sha256").update(items.slice().sort((a, b) => a.path.localeCompare(b.path)).map(e => `${e.path}\0${e.sha256}\0${e.size}`).join("\n")).digest("hex")
  const categoryMarker = JSON.parse(fs.readFileSync(path.join(source, "CATEGORY.json"), "utf8")); const tree = entries.map(e => ({ ...e, path: e.path.slice(category.length + 1) }))
   fs.writeFileSync(path.join(root, "CATEGORY-PACKAGE.json"), JSON.stringify({ schema: 1, kind: "category-package", packageVersion: "1.0.0", sourceSha, categories: [{ id: category, version: categoryMarker.distributionVersion, manifestHash: categoryMarker.manifestHash, root: category, treeHash: digest(tree) }], entries, contentDigest: digest(entries) }, null, 2))
  return root
}

function fakeRun(calls: string[], token?: string) {
  return async (command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
    calls.push(`${command} ${args.join(" ")}`)
    if (command === "git" && args[0] === "clone") {
      fs.mkdirSync(path.join(args[args.length - 1], ".github"), { recursive: true })
      fs.writeFileSync(path.join(args[args.length - 1], ".github", "keep.yml"), "keep")
    }
    if (token && command === "git" && args[0] === "clone") return { stdout: "", stderr: `failed with ${token}`, status: 1 }
    return { stdout: "", stderr: "", status: 0 }
  }
}

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

test("publication uses the fixed repositories and deterministic branch metadata", () => {
  assert.deepEqual(CATEGORY_DESTINATIONS, { wiki: "lorecanc/agents-wiki", docs: "lorecanc/agents-docs", slides: "lorecanc/agents-slides" })
  assert.deepEqual(publicationMetadata("docs", "2.0.0", "abcdef1234567890").branch, "automation/category-2.0.0-abcdef12")
})

test("destination validation accepts bootstrap and owned markers but rejects unmanaged files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "category-publication-"))
   validateDestination(root, "wiki", undefined, true)
  fs.writeFileSync(path.join(root, "unmanaged.txt"), "x")
  assert.throws(() => validateDestination(root, "wiki"), /unmanaged|bootstrap/i)
  fs.rmSync(path.join(root, "unmanaged.txt"))
  fs.writeFileSync(path.join(root, "CATEGORY.json"), JSON.stringify({ category: "wiki" }))
   assert.doesNotThrow(() => validateDestination(root, "wiki", undefined, true))
})

test("publisher dry-run validates the real package and performs no remote work", async () => {
  const calls: string[] = []; let fetches = 0
  const result = await publishCategory({ packageRoot: packageFixture(), canonicalRoot: repo, category: "wiki", sourceSha, confirmRemote: false, dryRun: true, run: fakeRun(calls), fetchImpl: async () => { fetches++; return response(500, {}) } })
  assert.equal(result.repository, CATEGORY_DESTINATIONS.wiki); assert.equal(calls.length, 0); assert.equal(fetches, 0)
})

test("publisher rejects an internally consistent forged package before remote calls", async () => {
  const root = packageFixture(), forged = path.join(root, "wiki", "AGENTS.md"), calls: string[] = []
  fs.appendFileSync(forged, "forged")
  const marker = JSON.parse(fs.readFileSync(path.join(root, "CATEGORY-PACKAGE.json"), "utf8")), hash = (value: Buffer) => crypto.createHash("sha256").update(value).digest("hex")
  const entry = marker.entries.find((e: any) => e.path === "wiki/AGENTS.md"); entry.sha256 = hash(fs.readFileSync(forged)); entry.size = fs.statSync(forged).size
  marker.contentDigest = hash(Buffer.from(marker.entries.slice().sort((a: any, b: any) => a.path.localeCompare(b.path)).map((e: any) => `${e.path}\0${e.sha256}\0${e.size}`).join("\n"))); fs.writeFileSync(path.join(root, "CATEGORY-PACKAGE.json"), JSON.stringify(marker))
  await assert.rejects(publishCategory({ packageRoot: root, canonicalRoot: repo, category: "wiki", sourceSha, dryRun: true, confirmRemote: false, run: fakeRun(calls), fetchImpl: async () => response(500, {}) }), /canonical generated category/)
  assert.equal(calls.length, 0)
})

test("publisher creates a feature branch, pushes non-force, and confirms a duplicate PR", async () => {
  const calls: string[] = [], urls: string[] = []; let post = true
  const fetchImpl = async (url: string, init?: RequestInit) => { urls.push(url); if (url.endsWith("/pulls") && init?.method === "POST") { post = false; return response(422, { message: "already exists" }) }; if (url.includes("/pulls?")) return response(200, [{ head: { ref: new URL(url).searchParams.get("head")!.split(":")[1] }, base: { ref: "main" } }]); return response(200, { default_branch: "main", archived: false }) }
  const result = await publishCategory({ packageRoot: packageFixture(), canonicalRoot: repo, category: "wiki", sourceSha, confirmRemote: true, bootstrap: true, token: "raw-secret", run: fakeRun(calls), fetchImpl })
  assert.equal(result.repository, CATEGORY_DESTINATIONS.wiki); assert.equal(post, false); assert.ok(calls.some(c => c.includes("checkout -b automation/category-"))); assert.ok(calls.some(c => c.includes("push origin automation/category-") && !c.includes("--force"))); assert.equal(calls.some(c => c.includes("refs/heads/main")), false); assert.equal(calls.some(c => c.includes("create")), false); assert.equal(urls.length, 3)
})

test("publisher rejects malformed, unrelated, and unmatched duplicate PR responses", async () => {
  for (const body of [{ nope: true }, [{ head: { ref: "other" }, base: { ref: "main" } }], []]) {
    const fetchImpl = async (url: string, init?: RequestInit) => url.endsWith("/pulls") && init?.method === "POST" ? response(422, {}) : url.includes("/pulls?") ? response(200, body) : response(200, { default_branch: "main", archived: false })
    await assert.rejects(publishCategory({ packageRoot: packageFixture(), canonicalRoot: repo, category: "wiki", sourceSha, confirmRemote: true, bootstrap: true, token: "secret", run: fakeRun([]), fetchImpl }), /conflict|matched|confirmed/i)
  }
})

test("publisher never leaks raw or basic-auth token material", async () => {
  const raw = "raw-token-123", calls: string[] = []
  await assert.rejects(publishCategory({ packageRoot: packageFixture(), canonicalRoot: repo, category: "wiki", sourceSha, confirmRemote: true, token: raw, run: fakeRun(calls, raw), fetchImpl: async () => response(200, { default_branch: "main", archived: false }) }), error => { assert.doesNotMatch(String(error), new RegExp(raw)); assert.doesNotMatch(String(error), /cmF3LXRva2Vu/); return true })
  assert.equal(calls.some(c => c.includes(raw)), false)
})

test("publisher requires a token and preserves .github during bootstrap", async () => {
  await assert.rejects(publishCategory({ packageRoot: packageFixture(), canonicalRoot: repo, category: "wiki", sourceSha, confirmRemote: true, bootstrap: true }), /CATEGORY_PUBLISH_TOKEN/)
  const calls: string[] = []; await publishCategory({ packageRoot: packageFixture("docs"), canonicalRoot: repo, category: "docs", sourceSha, confirmRemote: true, bootstrap: true, token: "t", run: fakeRun(calls), fetchImpl: async (url: string, init?: RequestInit) => url.endsWith("/pulls") ? response(200, {}) : response(200, { default_branch: "main", archived: false }) })
})
