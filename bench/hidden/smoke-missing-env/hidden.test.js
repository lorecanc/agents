import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { once } from "node:events"
import http from "node:http"
import { test } from "node:test"

test("startup refuses a missing DATABASE_URL", () => {
  const env = { ...process.env, PORT: "0" }
  delete env.DATABASE_URL
  const run = spawnSync(process.execPath, ["src/main.js"], { env, encoding: "utf8", timeout: 2000 })
  assert.ifError(run.error)
  assert.ok(Number.isInteger(run.status) && run.status !== 0)
  assert.match(run.stderr + run.stdout, /DATABASE_URL/)
})

test("the running fixture serves the health response and preserves unknown routes", { timeout: 5000 }, async (t) => {
  // This fixture only checks that DATABASE_URL is present. Supply a test-only value
  // after the model run. Observe the port chosen by the OS without changing the handler.
  process.env.DATABASE_URL = "postgres://fixture.invalid/bench"
  process.env.PORT = "0"
  let server
  const listen = http.Server.prototype.listen
  t.mock.method(http.Server.prototype, "listen", function (...args) {
    server = this
    return listen.apply(this, args)
  })
  t.after(() => {
    server?.closeAllConnections()
    server?.close()
  })
  await import("../src/main.js")
  assert.ok(server, "expected the fixture HTTP server to start")
  if (!server.listening) await once(server, "listening", { signal: t.signal })
  const url = `http://127.0.0.1:${server.address().port}`
  const health = await fetch(`${url}/health`, { signal: t.signal })
  assert.equal(health.status, 200)
  assert.deepEqual(await health.json(), { status: "ok" })
  const missing = await fetch(`${url}/missing-route`, { signal: t.signal })
  assert.equal(missing.status, 404)
})
