import { fileURLToPath } from "node:url"
import path from "path"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export const TOOLS_DIR = __dirname

export function opencodePath(...segments) {
  return path.join(TOOLS_DIR, ...segments)
}
