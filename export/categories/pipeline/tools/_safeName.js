import path from "path"

export function safeProjectSegment(value, label = "projectName") {
  const trimmed = typeof value === "string" ? value.trim() : ""
  if (!trimmed) throw new Error(`Invalid ${label}: must be a non-empty name`)
  if (trimmed.length > 128) throw new Error(`Invalid ${label}: exceeds 128 characters`)
  if (/[/\\]/.test(trimmed) || trimmed.split(/[\\/]/).includes("..") ||
      path.isAbsolute(trimmed) || /^[A-Za-z]:/.test(trimmed)) {
    throw new Error(`Invalid ${label}: path separators, "..", and absolute paths are not allowed`)
  }
  return trimmed
}
