import { Plugin } from "@opencode/plugin"

import { greet } from "../../tools/minimal-pack/greet.js"

export default Plugin.define({
  id: "minimal-greeter",
  setup: async (ctx, options = {}) => {
    const greeting = typeof options.greeting === "string" ? options.greeting : "hello"
    const dispose = ctx.tool.hook("execute.before", async () => {
      greet(greeting)
    })
    return () => dispose?.()
  },
})
