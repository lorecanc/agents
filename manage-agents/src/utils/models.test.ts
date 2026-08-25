import assert from "node:assert/strict"
import test from "node:test"
import { loadModelCatalog, parseModelCatalog, isVerifiedModel, suggestModels } from "./models.js"

test("model catalog parser is strict, trimmed, deduplicated, and preserves slashes", () => {
  assert.deepEqual(parseModelCatalog(" provider/model/a \nprovider/model/a\nmalformed\nprovider/ two\nprovider/model-b "), ["provider/model/a", "provider/model-b"])
  assert.deepEqual(parseModelCatalog("garbage\nnot-a-model"), [])
})

test("catalog loading selects refresh command and fails closed", () => {
  let command = ""
  assert.deepEqual(loadModelCatalog(c => { command = c; return "p/model" }, true), { status: "verified", models: ["p/model"] })
  assert.equal(command, "opencode models --refresh")
  assert.equal(loadModelCatalog(() => "").status, "unavailable")
  assert.equal(loadModelCatalog(() => { throw new Error("offline") }).status, "unavailable")
})

test("membership is exact and suggestions are catalog members with provider priority", () => {
  const catalog = { status: "verified" as const, models: ["p/model-new", "p/model-old", "q/model-new"] }
  assert.equal(isVerifiedModel("p/model-new", catalog), true)
  assert.equal(isVerifiedModel("P/model-new", catalog), false)
  const suggestions = suggestModels("p/model-old", catalog)
  assert.ok(suggestions.every(model => catalog.models.includes(model)))
  assert.equal(suggestions[0], "p/model-new")
  assert.deepEqual(suggestModels("unknown/unrelated", { status: "verified", models: ["p/other"] }), [])
})
