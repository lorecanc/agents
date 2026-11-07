import { test } from "node:test"
import assert from "node:assert/strict"

import { searchUsersQuery } from "../src/users.js"

const EVIL = "x' OR '1'='1"

test("hidden: the search term is passed as a parameter, never inside the SQL text", () => {
  const q = searchUsersQuery(EVIL)
  assert.equal(typeof q, "object")
  assert.equal(typeof q.text, "string")
  assert.ok(Array.isArray(q.values), "values is an array")
  assert.ok(!q.text.includes(EVIL), "the raw term must not appear in the SQL text")
  assert.ok(!q.text.includes("'1'='1"), "no injected SQL")
  assert.match(q.text, /\$1/, "uses a positional placeholder")
  assert.ok(q.values.some((v) => typeof v === "string" && v.includes(EVIL)), "the term travels in values")
  assert.match(q.text, /\busers\b/i)
  assert.match(q.text, /ILIKE|LOWER\s*\(/i, "case-insensitive match")
})
