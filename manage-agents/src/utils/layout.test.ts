import test from "node:test"
import assert from "node:assert/strict"
import { calculateLayout, calculateListColumnBudget, calculatePanelWidths } from "./layout.js"

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

test("panel widths honor the configured share and terminal budget", () => {
  for (const [share, expectedList] of [[2 / 3, 83], [0.60, 75], [0.75, 93]] as const) {
    const widths = calculatePanelWidths(128, "normal", share)
    assert.equal(widths.gutter, 1)
    assert.equal(widths.list, expectedList)
    assert.ok(widths.list + widths.inspector + widths.gutter <= 126)
    assert.ok(widths.list >= 52 && widths.inspector >= 28)
  }
  const wide = calculatePanelWidths(160, "normal", 2 / 3)
  assert.deepEqual(wide, { list: 104, inspector: 53, gutter: 1 })
  assert.deepEqual(calculatePanelWidths(80, "normal", 2 / 3), { list: 51, inspector: 26, gutter: 1 })
  assert.deepEqual(calculatePanelWidths(160, "normal", 0.60), { list: 94, inspector: 63, gutter: 1 })
  assert.deepEqual(calculatePanelWidths(160, "normal", 0.75), { list: 117, inspector: 40, gutter: 1 })
  assert.deepEqual(calculatePanelWidths(80, "compact", 2 / 3), { list: 78, inspector: 0, gutter: 0 })
})

test("column budgets consume exactly the content width at PTY sizes", () => {
  for (const terminalWidth of [80, 128, 160]) {
    const panel = calculatePanelWidths(terminalWidth, terminalWidth === 80 ? "compact" : "normal", 2 / 3)
    const contentWidth = Math.max(0, panel.list - 4)
    const budget = calculateListColumnBudget(contentWidth, panel.inspector ? "normal" : "compact")
    assert.equal(budget.total, contentWidth)
    assert.equal(budget.widths.length, panel.inspector ? 5 : 3)
    assert.equal(budget.widths.reduce((sum, width) => sum + width, 0) + budget.gutters.reduce((sum, width) => sum + width, 0), contentWidth)
    assert.ok(budget.widths.every(width => width >= 0))
  }
})
