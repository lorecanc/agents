import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

// Builds dist/index.js from any working directory.
const managerRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
await build({ bundle: true, platform: "node", format: "esm", external: ["@opentui/core", "yaml"], absWorkingDir: managerRoot, logLevel: "info", entryPoints: ["src/index.tsx"], outfile: "dist/index.js" })
