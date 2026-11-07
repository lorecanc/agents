import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8")

test("the page links the stylesheet and has a pricing section", () => {
  assert.match(html, /<link[^>]+styles\.css/)
  assert.match(html, /id="pricing"/)
})
