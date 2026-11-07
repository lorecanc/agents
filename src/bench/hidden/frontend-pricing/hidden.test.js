import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8")
const pricing = html.slice(html.indexOf('id="pricing"'))

test("hidden: pricing is no longer a layout table", () => {
  assert.ok(!/<table/i.test(pricing), "use semantic markup, not a table, for the plan cards")
})

test("hidden: each plan has a heading, a feature list and a real call to action", () => {
  for (const plan of ["Free", "Pro", "Team"]) assert.match(pricing, new RegExp(`<h[2-4][^>]*>[^<]*${plan}`), `${plan} has a heading`)
  assert.ok((pricing.match(/<ul/gi) || []).length >= 3, "a feature list per plan")
  assert.ok((pricing.match(/<(a|button)\b/gi) || []).length >= 3, "a call to action per plan")
})

test("hidden: the recommended plan is marked for everyone, not only visually", () => {
  assert.match(pricing, /(recommended|most popular|popular|best value)/i)
})
