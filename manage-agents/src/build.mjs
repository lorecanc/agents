import { existsSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

// Builds dist/index.js and, when the repository ships manage-agents/ext/index.ts, dist/extensions.js
// (see "Repository-local extensions" in the README). Runs from any working directory.
const managerRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const options = { bundle: true, platform: "node", format: "esm", external: ["@opentui/core", "yaml"], absWorkingDir: managerRoot, logLevel: "info" }

await build({ ...options, entryPoints: ["src/index.tsx"], outfile: "dist/index.js" })
if (existsSync(join(managerRoot, "ext", "index.ts"))) await build({ ...options, entryPoints: ["ext/index.ts"], outfile: "dist/extensions.js" })
else rmSync(join(managerRoot, "dist", "extensions.js"), { force: true })
