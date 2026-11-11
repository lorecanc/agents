import assert from "node:assert/strict"
import test from "node:test"
import { decideSubagentModel, modelOf, validateRouting } from "./router.js"

const routing = validateRouting({
  version: 2,
  archetypes: {
    flow: {
      callers: ["flow-build", "flow-plan"],
      pinned: ["flow-eye"],
      routes: {
        mistral: { "flow-explore": "mistral/small#high", "flow-review": "inherit", "flow-eye": "mistral/x" },
        "mistral/big": { "flow-explore": "mistral/medium" },
      },
    },
  },
})
const call = (overrides) => decideSubagentModel(routing, { callerAgent: "flow-build", callerModel: { providerID: "mistral", id: "large" }, targetAgent: "flow-explore", ...overrides })

test("routes by caller provider, exact model first", () => {
  assert.deepEqual(call({}), { model: "mistral/small#high" })
  assert.deepEqual(call({ callerModel: { providerID: "mistral", id: "big" } }), { model: "mistral/medium" })
  assert.deepEqual(call({ callerAgent: "flow-plan" }), { model: "mistral/small#high" })
})

test("leaves the call alone: explicit model, pinned, inherit, unknown caller or provider, same model", () => {
  assert.equal(call({ requestedModel: "a/b" }), null)
  assert.equal(call({ targetAgent: "flow-eye" }), null)
  assert.equal(call({ targetAgent: "flow-review" }), null)
  assert.equal(call({ callerAgent: "other" }), null)
  assert.equal(call({ callerModel: { providerID: "openai", id: "x" } }), null)
  assert.equal(call({ callerModel: "mistral/small#high" }), null)
  assert.equal(decideSubagentModel(null, { callerAgent: "flow-build" }), null)
})

test("validation rejects malformed routing", () => {
  assert.throws(() => validateRouting({ version: 1, archetypes: {} }), /unsupported version/)
  assert.throws(() => validateRouting({ version: 2, archetypes: { a: { callers: [], pinned: [], routes: { "bad key": {} } } } }), /invalid trigger/)
  assert.throws(() => validateRouting({ version: 2, archetypes: { a: { callers: ["x"], pinned: [], routes: { p: { y: "nope" } } } } }), /not "inherit"/)
  assert.deepEqual(modelOf({ providerID: "p", id: "m", variant: "high" }), { provider: "p", model: "m", full: "p/m#high" })
})
