import assert from "node:assert/strict"
import test from "node:test"
import type { ChangeResult, PlannedWrite, ReconcilePlan } from "./installer.js"
import { describeChangeResult, formatLockChange } from "./changeReport.js"

function plan(overrides: Partial<ReconcilePlan> = {}): ReconcilePlan {
  return {
    target: "/home/user/.config/opencode",
    packs: ["demo"],
    writes: [],
    deletes: [],
    released: [],
    conflicts: [],
    warnings: [],
    adopted: { files: [], config: [] },
    configFile: "opencode.json",
    configText: null,
    expected: {},
    installed: { installedVersion: 1, files: {}, config: {} },
    ...overrides
  }
}

const write = (rel: string, kind: PlannedWrite["kind"]): PlannedWrite => ({ rel, from: `/source/${rel}`, hash: "h", mode: 0o644, kind })

function result(overrides: Partial<ChangeResult> = {}): ChangeResult {
  return { status: "applied", recovered: false, previousLock: null, change: null, changes: [], confirmations: [], plan: null, backupId: null, ...overrides }
}

test("an applied change lists the packs and file counts and tells how to undo it", () => {
  const lines = describeChangeResult("global", result({
    status: "applied",
    recovered: true,
    backupId: "20261111-120000",
    changes: [
      { name: "demo", kind: "upgrade", from: "local@1.0.0", to: "local@1.1.0" },
      { name: "extra", kind: "added", to: "local@2.0.0" }
    ],
    plan: plan({ writes: [write("agents/a.md", "create"), write("agents/b.md", "update"), write("skills/s/SKILL.md", "update"), write("tools/demo/t.ts", "adopt")], deletes: ["agents/old.md"], configText: "{}" })
  }))

  assert.deepEqual(lines, [
    "Rolled back an interrupted transaction first.",
    "Packs:",
    "  upgrade demo local@1.0.0 -> local@1.1.0",
    "  added extra -> local@2.0.0",
    "Files: 1 new, 2 updated, 1 adopted, 1 removed; opencode.json updated.",
    "Done: global is up to date. Replaced content was saved; undo with `manage-agents restore 20261111-120000`."
  ])
})

test("an applied change without a backup and an unchanged target say so in one line", () => {
  assert.deepEqual(describeChangeResult("project", result({ status: "applied", plan: plan() })), [
    "Files: 0 new, 0 updated, 0 adopted, 0 removed.",
    "Done: project is up to date."
  ])
  assert.deepEqual(describeChangeResult("project", result({ status: "unchanged" })), ["Nothing to do: project is already up to date."])
  assert.deepEqual(describeChangeResult("project", result({ status: "declined" })), ["Not confirmed: nothing was written."])
})

test("a dry run lists every planned write and removal and the warnings", () => {
  const lines = describeChangeResult("global", result({
    status: "dry-run",
    change: { desired: {} as any, lock: {} as any, problems: [], warnings: ["change warning"] },
    plan: plan({ writes: [write("agents/a.md", "create"), write("agents/b.md", "update")], deletes: ["agents/old.md", "skills/gone/SKILL.md"], warnings: ["plan warning"] })
  }))

  assert.deepEqual(lines, [
    "Files: 1 new, 1 updated, 0 adopted, 2 removed.",
    "  create agents/a.md",
    "  update agents/b.md",
    "  remove agents/old.md",
    "  remove skills/gone/SKILL.md",
    "warning: change warning",
    "warning: plan warning",
    "Dry run: nothing was written."
  ])
})

test("a failed change reports problems and conflicts instead of file counts", () => {
  const lines = describeChangeResult("global", result({
    status: "failed",
    change: { desired: {} as any, lock: {} as any, problems: ["demo requires ghost, which is not in any source"] },
    plan: plan({ writes: [write("agents/a.md", "create")], conflicts: ["agents/a.md is a directory"] })
  }))

  assert.deepEqual(lines, [
    "ERROR: demo requires ghost, which is not in any source",
    "ERROR: agents/a.md is a directory",
    "Nothing was written."
  ])
})

test("pack-controlled text is stripped of terminal escapes and control characters", () => {
  const evil = "\x1b]8;;https://evil.test\x07click\x1b]8;;\x07\x1b[31mred\x1b[0m\r\nnext\x9b"
  const lines = describeChangeResult(`tar${evil}get`, result({
    status: "dry-run",
    backupId: "x",
    changes: [{ name: `pack${evil}`, kind: "source", from: `a${evil}`, to: `b${evil}` }],
    change: { desired: {} as any, lock: {} as any, problems: [], warnings: [`warn${evil}`] },
    plan: plan({ writes: [write(`agents/${evil}.md`, "create")], deletes: [`skills/${evil}`] })
  }))
  const failed = describeChangeResult(`tar${evil}get`, result({ status: "applied", backupId: "id", change: { desired: {} as any, lock: {} as any, problems: [`bad${evil}`] } }))

  for (const line of [...lines, ...failed]) assert.doesNotMatch(line, /[\x00-\x1f\x7f-\x9f]/, JSON.stringify(line))
  assert.ok(lines.includes("  source packclickrednext aclickrednext -> bclickrednext"))
  assert.ok(lines.includes("  create agents/clickrednext.md"))
  assert.ok(lines.includes("  remove skills/clickrednext"))
  assert.ok(lines.includes("warning: warnclickrednext"))
  assert.ok(failed.includes("ERROR: badclickrednext"))
  assert.ok(failed.includes("Done: tarclickrednextget is up to date. Replaced content was saved; undo with `manage-agents restore id`."))
  assert.equal(formatLockChange({ name: "plain", kind: "removed", from: "local@1.0.0" }), "  removed plain local@1.0.0")
})
