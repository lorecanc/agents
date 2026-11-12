import assert from "node:assert/strict"
import { test } from "node:test"
import { safeProjectSegment } from "./_safeName.js"

test("safeProjectSegment accepts plain names and trims surrounding whitespace", () => {
  assert.equal(safeProjectSegment("my_deck"), "my_deck")
  assert.equal(safeProjectSegment("  quarterly_report  "), "quarterly_report")
})

test("safeProjectSegment rejects traversal, separators, and absolute paths", () => {
  for (const bad of ["../escape", "..", "a/../../b", "a/b", "a\\b", "/abs", "C:\\abs", "C:abs", "", "   "]) {
    assert.throws(() => safeProjectSegment(bad), /Invalid projectName/)
  }
})

test("safeProjectSegment enforces the 128-character boundary", () => {
  assert.equal(safeProjectSegment("a".repeat(128)), "a".repeat(128))
  assert.throws(() => safeProjectSegment("a".repeat(129)), /exceeds 128 characters/)
})

test("safeProjectSegment surfaces the caller-provided label in errors", () => {
  assert.throws(() => safeProjectSegment("../escape", "outputFilename"), /Invalid outputFilename/)
})
