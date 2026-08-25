import test from "node:test"
import assert from "node:assert/strict"
import { calculateLayout } from "./layout.js"

test("calculates bounded layouts across terminal sizes and status states", () => {
  const cases = [
    [80, 8, false, "too-small", 0, false],
    [39, 30, true, "too-small", 0, false],
    [40, 12, false, "too-small", 0, false],
    [40, 17, false, "compact", 1, false],
    [80, 20, false, "compact", 4, false],
    [80, 24, false, "compact", 8, false],
    [80, 24, true, "compact", 7, false],
    [120, 20, true, "normal", 3, true],
    [120, 60, false, "normal", 44, true]
  ] as const

  for (const [width, height, status, mode, rows, inspector] of cases) {
    const layout = calculateLayout(width, height, status)
    assert.equal(layout.mode, mode)
    assert.equal(layout.listRows, rows)
    assert.equal(layout.showInspector, inspector)
    assert.ok(layout.listRows >= 0)
    assert.ok(layout.budgetRows <= height)
  }
})

test("reserves exactly one row when the warning is visible and handles mode boundaries", () => {
  const withoutStatus = calculateLayout(120, 20, false)
  const withStatus = calculateLayout(120, 20, true)

  assert.equal(withoutStatus.statusRows, 0)
  assert.equal(withStatus.statusRows, 1)
  assert.equal(withStatus.listRows, withoutStatus.listRows - 1)
  assert.equal(calculateLayout(80, 24, false).listRows, 8)
  assert.equal(calculateLayout(80, 24, true).listRows, 7)
  assert.equal(calculateLayout(40, 12, false).mode, "too-small")
  assert.equal(calculateLayout(40, 12, true).mode, "too-small")
  assert.equal(calculateLayout(40, 17, true).mode, "too-small")
  assert.equal(calculateLayout(40, 18, true).listRows, 1)
  assert.equal(calculateLayout(100, 18, false).mode, "normal")
})
