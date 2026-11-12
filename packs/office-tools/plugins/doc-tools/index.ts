import { Plugin } from "@opencode/plugin"

import { toV2Tool, type ToolDef } from "../../tools/toolkit/_tool.js"
import docCompileTheme from "../../tools/office-tools/doc_compile_theme.js"
import docConvert from "../../tools/office-tools/doc_convert.js"
import docCreate from "../../tools/office-tools/doc_create.js"
import docList from "../../tools/office-tools/doc_list.js"
import docModify from "../../tools/office-tools/doc_modify.js"
import docRestore from "../../tools/office-tools/doc_restore.js"
import docView from "../../tools/office-tools/doc_view.js"

const NAMESPACE = "doc"

const definitions: Array<[string, ToolDef]> = [
  ["compile_theme", docCompileTheme],
  ["convert", docConvert],
  ["create", docCreate],
  ["list", docList],
  ["modify", docModify],
  ["restore", docRestore],
  ["view", docView],
]

export default Plugin.define({
  id: "doc-tools",
  async setup(ctx) {
    const directory = ctx.location.directory
    const tools = definitions.map(([name, def]) =>
      toV2Tool(def, {
        name,
        namespace: NAMESPACE,
        permission: `${NAMESPACE}_${name}`,
        directory,
        worktree: directory,
      }),
    )
    await ctx.tool.transform((editor) => {
      for (const t of tools) editor.add(t)
    })
  },
})
