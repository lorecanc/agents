import assert from "node:assert/strict"
import test from "node:test"
import { displayWidth, middleEllipsis, terminalSafeText } from "./terminalText.js"

test("middle ellipsis is cell bounded and grapheme safe", () => {
  for (const [text, budget] of [["abcdef", 0], ["abcdef", 1], ["abcdef", 2], ["a界b", 4], ["a\u0301bc", 2], ["👩‍💻 works", 5], ["你好世界", 5], ["👨‍👩‍👧‍👦 family", 6]] as const) {
    const result = middleEllipsis(text, budget)
    assert.ok(displayWidth(result) <= budget)
  }
  assert.equal(middleEllipsis("abcdef", 0), "")
  assert.equal(middleEllipsis("abcdef", 1), "…")
  assert.equal(middleEllipsis("abcdef", 2), "a…")
  assert.equal(middleEllipsis("a\u0301bc", 2), "á…")
  assert.equal(middleEllipsis("👩‍💻 works", 3), "👩‍💻…")
  assert.equal(middleEllipsis("👩‍💻abc", 3), "👩‍💻…")
  assert.equal(displayWidth(middleEllipsis("你好世界", 5)) <= 5, true)
})

test("terminal text removes terminal controls", () => {
  assert.equal(terminalSafeText("normal\x1b[31m red\x1b[0m\x1b]0;title\x07\nline\ttab\x01"), "normal redlinetab")
  assert.equal(middleEllipsis("normal\x1b[31m text", 20), "normal text")
  assert.ok(middleEllipsis("x".repeat(1_000_000), 10).length <= 10)
})

test("terminal text safely normalizes dynamic values and labels", () => {
  assert.equal(terminalSafeText(null), "")
  assert.equal(terminalSafeText(false), "false")
  assert.equal(terminalSafeText(42), "42")
  assert.equal(terminalSafeText({ label: "agent" }), "[object Object]")
  assert.equal(middleEllipsis("agent\x1b[31m-name", 20), "agent-name")
})

test("display width is terminal-cell aware", () => {
  assert.equal(displayWidth("a界"), 3)
  assert.equal(displayWidth("a\u0301"), 1)
  assert.equal(displayWidth("👩‍💻"), 2)
  assert.equal(displayWidth("👨‍👩‍👧‍👦"), 2)
})
