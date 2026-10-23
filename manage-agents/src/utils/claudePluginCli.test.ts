import assert from "node:assert/strict"
import test from "node:test"
import { registerPlugin, validatePlugin, type CliRunner } from "./claudePluginCli.js"

function runnerReturning(result: { status: number | null; stdout?: string; stderr?: string; error?: NodeJS.ErrnoException }): CliRunner {
  return () => ({ stdout: "", stderr: "", ...result })
}

test("validatePlugin maps exit codes", () => {
  const pass = validatePlugin("/some/plugin", runnerReturning({ status: 0 }))
  assert.equal(pass.kind, "pass")

  const fail = validatePlugin("/some/plugin", runnerReturning({ status: 1, stderr: "validation exploded" }))
  assert.equal(fail.kind, "fail")
  assert.ok(fail.detail?.includes("validation exploded"), `expected stderr in detail, got ${JSON.stringify(fail)}`)

  const error = validatePlugin("/some/plugin", runnerReturning({ status: 2, stderr: "cli crashed" }))
  assert.equal(error.kind, "error")
  assert.ok(error.detail?.includes("cli crashed"), `expected stderr in detail, got ${JSON.stringify(error)}`)

  const enoent = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" })
  const skipped = validatePlugin("/some/plugin", runnerReturning({ status: null, error: enoent }))
  assert.equal(skipped.kind, "skipped")
})

test("registerPlugin runs the two-step sequence", () => {
  const calls: Array<{ file: string; args: string[] }> = []
  const runner: CliRunner = (file, args) => {
    calls.push({ file, args: [...args] })
    return { status: 0, stdout: "", stderr: "" }
  }

  const outcome = registerPlugin("/some/plugin", "decent-pipeline", "decent-pipeline-local", runner)

  assert.equal(outcome.kind, "pass")
  assert.equal(calls.length, 2, `expected exactly two calls, got ${JSON.stringify(calls)}`)
  assert.ok(calls.every(call => call.file === "claude"), `expected every call on the claude binary, got ${JSON.stringify(calls)}`)
  assert.deepEqual(calls[0].args, ["plugin", "marketplace", "add", "/some/plugin"])
  assert.deepEqual(calls[1].args, ["plugin", "install", "decent-pipeline@decent-pipeline-local"])
  assert.equal(calls.some(call => call.args.includes("--json")), false)
  assert.equal(calls.some(call => call.args.join(" ").includes("enable")), false)
})

test("registerPlugin stops on the first failure", () => {
  const calls: string[][] = []
  const runner: CliRunner = (_file, args) => {
    calls.push([...args])
    return { status: 1, stdout: "", stderr: "marketplace add failed" }
  }

  const outcome = registerPlugin("/some/plugin", "decent-pipeline", "decent-pipeline-local", runner)

  assert.equal(outcome.kind, "fail")
  assert.equal(calls.length, 1, `expected the second call to be skipped, got ${JSON.stringify(calls)}`)
})

test("registerPlugin skips when claude is missing", () => {
  const calls: string[][] = []
  const enoent = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" })
  const runner: CliRunner = (_file, args) => {
    calls.push([...args])
    return { status: null, stdout: "", stderr: "", error: enoent }
  }

  const outcome = registerPlugin("/some/plugin", "decent-pipeline", "decent-pipeline-local", runner)

  assert.equal(outcome.kind, "skipped")
  assert.equal(calls.length, 1, `expected the second call to be skipped, got ${JSON.stringify(calls)}`)
})

test("registerPlugin treats idempotent reruns as pass", () => {
  let call = 0
  const runner: CliRunner = () => {
    call += 1
    if (call === 1) {
      return { status: 0, stdout: "Marketplace 'decent-pipeline-local' already on disk", stderr: "" }
    }
    return { status: 0, stdout: "", stderr: "" }
  }

  const outcome = registerPlugin("/some/plugin", "decent-pipeline", "decent-pipeline-local", runner)

  assert.equal(outcome.kind, "pass")
  assert.match(outcome.message, /^Registered decent-pipeline@decent-pipeline-local \(marketplace was already on disk\)/)
  assert.doesNotMatch(outcome.message, /was already registered/, "a marketplace-only rerun is not an already-registered plugin")

  let installCall = 0
  const installRunner: CliRunner = () => {
    installCall += 1
    if (installCall === 1) return { status: 0, stdout: "", stderr: "" }
    return { status: 0, stdout: "Plugin 'decent-pipeline' already installed", stderr: "" }
  }

  const rerun = registerPlugin("/some/plugin", "decent-pipeline", "decent-pipeline-local", installRunner)

  assert.equal(rerun.kind, "pass")
  assert.match(rerun.message, /^decent-pipeline@decent-pipeline-local was already registered/)
})
