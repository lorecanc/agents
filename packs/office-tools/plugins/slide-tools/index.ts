import { Plugin } from "@opencode/plugin"

import { toV2Tool, type ToolDef } from "../../tools/toolkit/_tool.js"
import slideAnalyzeTemplate from "../../tools/office-tools/slide_analyze_template.js"
import slideAssemblePptx from "../../tools/office-tools/slide_assemble_pptx.js"
import slideBuildPptx from "../../tools/office-tools/slide_build_pptx.js"
import slideCompileComposition from "../../tools/office-tools/slide_compile_composition.js"
import slideCompileTheme from "../../tools/office-tools/slide_compile_theme.js"
import slideCreateThumbnails from "../../tools/office-tools/slide_create_thumbnails.js"
import slideDownloadImage from "../../tools/office-tools/slide_download_image.js"
import slideGenerateImage from "../../tools/office-tools/slide_generate_image.js"
import slideScreenshot from "../../tools/office-tools/slide_screenshot.js"

const NAMESPACE = "slide"

const definitions: Array<[string, ToolDef]> = [
  ["analyze_template", slideAnalyzeTemplate],
  ["assemble_pptx", slideAssemblePptx],
  ["build_pptx", slideBuildPptx],
  ["compile_composition", slideCompileComposition],
  ["compile_theme", slideCompileTheme],
  ["create_thumbnails", slideCreateThumbnails],
  ["download_image", slideDownloadImage],
  ["generate_image", slideGenerateImage],
  ["screenshot", slideScreenshot],
]

export default Plugin.define({
  id: "slide-tools",
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
