import assert from "node:assert/strict"
import { test } from "node:test"
import { average } from "../src/stats.js"

test("average of an empty list is 0, not NaN", () => {
  assert.equal(average([]), 0)
})

test("average still works for non-empty lists", () => {
  assert.equal(average([2, 4]), 3)
  assert.equal(average([5]), 5)
})
