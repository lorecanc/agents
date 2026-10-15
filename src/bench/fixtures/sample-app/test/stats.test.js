import assert from "node:assert/strict"
import { test } from "node:test"
import { average, max, sum } from "../src/stats.js"

test("sum adds numbers", () => {
  assert.equal(sum([1, 2, 3]), 6)
  assert.equal(sum([]), 0)
})

test("average of a non-empty list", () => {
  assert.equal(average([2, 4]), 3)
})

test("max returns the largest value", () => {
  assert.equal(max([1, 9, 3]), 9)
})

test("invalid input throws TypeError", () => {
  assert.throws(() => sum("x"), TypeError)
  assert.throws(() => average([1, "a"]), TypeError)
  assert.throws(() => max(null), TypeError)
})
