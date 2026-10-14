import assert from "node:assert/strict"
import { test } from "node:test"
import { median } from "../src/stats.js"

test("median of an odd-length list", () => {
  assert.equal(median([3, 1, 2]), 2)
})

test("median of an even-length list is the mean of the middle two", () => {
  assert.equal(median([1, 2, 3, 4]), 2.5)
})

test("median of an empty list is 0", () => {
  assert.equal(median([]), 0)
})

test("median does not mutate its input and validates it", () => {
  const input = [3, 1, 2]
  median(input)
  assert.deepEqual(input, [3, 1, 2])
  assert.throws(() => median("x"), TypeError)
})
