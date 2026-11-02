import fs from "fs"
import path from "path"
import { opencodePath } from "./_paths.js"

export function resolvePythonPath({ platform = process.platform, exists = fs.existsSync, venvRoot = opencodePath("..", "venv") } = {}) {
  const venvPython = platform === "win32"
    ? path.join(venvRoot, "Scripts", "python.exe")
    : path.join(venvRoot, "bin", "python3")
  if (exists(venvPython)) return venvPython
  return "python3"
}

export function getPythonPath() {
  return resolvePythonPath()
}
