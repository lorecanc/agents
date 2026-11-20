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
  assert.throws(() => median([4, "5"]), TypeError)
})

test("median generalizes across orders, lengths, ties and offsets", () => {
  for (const offset of [-11.5, 0, 1024]) {
    for (let length = 1; length <= 16; length++) {
      const sorted = Array.from({ length }, (_, i) => offset + Math.floor(i / 3) ** 2)
      const middle = (sorted[Math.floor((length - 1) / 2)] + sorted[Math.floor(length / 2)]) / 2
      const input = Object.freeze([...sorted.filter((_, i) => i % 2), ...sorted.filter((_, i) => i % 2 === 0).reverse()])
      assert.equal(median(input), middle)
    }
  }
})
