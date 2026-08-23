import fs from "fs"
import { opencodePath } from "./_paths.js"

export function getPythonPath() {
  const venvPython = opencodePath("..", "venv", "bin", "python3")
  if (fs.existsSync(venvPython)) return venvPython
  return "python3"
}
