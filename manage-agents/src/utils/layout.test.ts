import test from "node:test"
import assert from "node:assert/strict"
import { calculateLayout, calculateListColumnBudget } from "./layout.js"

test("calculates bounded layouts across terminal sizes and status states", () => {
  const cases = [
    [80, 8, false, "too-small", 0, false],
    [39, 30, true, "too-small", 0, false],
    [40, 12, false, "too-small", 0, false],
    [40, 18, false, "compact", 1, false],
    [80, 20, false, "compact", 3, false],
    [80, 24, false, "compact", 7, false],
    [80, 24, true, "compact", 6, false],
    [120, 20, true, "normal", 2, true],
    [120, 60, false, "normal", 43, true]
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
  assert.equal(calculateLayout(80, 24, false).listRows, 7)
  assert.equal(calculateLayout(80, 24, true).listRows, 6)
  assert.equal(calculateLayout(40, 12, false).mode, "too-small")
  assert.equal(calculateLayout(40, 12, true).mode, "too-small")
  assert.equal(calculateLayout(40, 17, true).mode, "too-small")
  assert.equal(calculateLayout(40, 19, true).listRows, 1)
  assert.equal(calculateLayout(100, 18, false).mode, "normal")
})

test("list column budgets account for explicit gutters", () => {
  for (const mode of ["normal", "compact"] as const) {
    const budget = calculateListColumnBudget(80, mode)
    assert.equal(budget.widths.length, mode === "normal" ? 5 : 3)
    assert.equal(budget.total, 80)
    assert.ok(budget.widths.every(width => width >= 0))
    assert.equal(budget.total, budget.widths.reduce((a, b) => a + b, 0) + budget.gutters.reduce((a, b) => a + b, 0))
    assert.ok(budget.widths[0] >= 5)
  }
  assert.ok(calculateListColumnBudget(10, "compact").total <= 10)
})
