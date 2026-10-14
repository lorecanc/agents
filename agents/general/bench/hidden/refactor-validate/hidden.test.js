import assert from "node:assert/strict"
import { test } from "node:test"
import { average, max, sum } from "../src/stats.js"

test("behavior is unchanged after the refactor", () => {
  assert.equal(sum([1, 2, 3]), 6)
  assert.equal(sum([]), 0)
  assert.equal(max([1, 9, 3]), 9)
  assert.equal(average([2, 4]), 3)
  assert.ok(Number.isNaN(average([])), "average([]) must keep its current behavior in a pure refactor")
})

test("every function still rejects invalid input with a TypeError", () => {
  for (const fn of [sum, average, max]) {
    assert.throws(() => fn("x"), TypeError)
    assert.throws(() => fn(null), TypeError)
    assert.throws(() => fn([1, "a"]), TypeError)
  }
})
