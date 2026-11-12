import { Plugin } from "@opencode/plugin"

import { toV2Tool, type ToolDef } from "../../tools/toolkit/_tool.js"
import devEnv from "../../tools/dev-tools/dev_env.js"
import devServe from "../../tools/dev-tools/dev_serve.js"
import devSmoke from "../../tools/dev-tools/dev_smoke.js"
import devVerify from "../../tools/dev-tools/dev_verify.js"

const NAMESPACE = "dev"

const definitions: Array<[string, ToolDef]> = [
  ["env", devEnv],
  ["verify", devVerify],
  ["smoke", devSmoke],
  ["serve", devServe],
]

export default Plugin.define({
  id: "dev-tools",
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
