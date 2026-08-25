const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })
const segments = (text: string) => Array.from(segmenter.segment(text), part => part.segment)
const MAX_TERMINAL_TEXT_LENGTH = 100_000

/** Remove terminal escapes and non-printing controls from workspace-controlled text. */
export function terminalSafeText(value: unknown): string {
  let text = typeof value === "string" ? value : String(value ?? "")
  // CSI, OSC (BEL or ST terminated), and the remaining C0/C1 controls.
  text = text
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "")
  if (text.length > MAX_TERMINAL_TEXT_LENGTH) {
    const half = Math.floor(MAX_TERMINAL_TEXT_LENGTH / 2)
    text = text.slice(0, half) + text.slice(-half)
  }
  return text
}

// @opentui/core 0.5.7 exposes stringWidth only from an internal runtime module,
// not its public package entrypoint. Keep this conservative local cell counter.
export function displayWidth(text: string): number {
  let width = 0
  for (const grapheme of segments(terminalSafeText(text))) {
    if (grapheme.includes("\u200d") || /[\u{1f300}-\u{1faff}]/u.test(grapheme)) {
      width += 2
      continue
    }
    for (const codePoint of grapheme) {
      const code = codePoint.codePointAt(0)!
      if ((code >= 0x300 && code <= 0x36f) || (code >= 0xfe00 && code <= 0xfe0f)) continue
      width += code >= 0x1100 && (
        code <= 0x115f || code === 0x2329 || code === 0x232a ||
        (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) ||
        (code >= 0xf900 && code <= 0xfaff)
      ) ? 2 : 1
    }
  }
  return width
}

/** Truncate by terminal cells without splitting graphemes (including ZWJ emoji). */
export function middleEllipsis(text: string, maxCells: number): string {
  const budget = Math.max(0, Math.floor(maxCells))
  if (budget === 0) return ""
  const safeText = terminalSafeText(text)
  const parts = segments(safeText)
  const widths = parts.map(part => displayWidth(part))
  const total = widths.reduce((sum, width) => sum + width, 0)
  if (total <= budget) return safeText
  if (budget === 1) return "…"
  const available = budget - 1
  let left = 0
  let right = parts.length - 1
  let prefixCells = 0
  let suffixCells = 0

  // Keep the first grapheme whenever the ellipsis leaves room for it.
  if (widths[left] > available) return "…"
  prefixCells = widths[left++]

  // Grow each contiguous side in cell-width order. On a tie, grow the
  // suffix first so paths and filenames retain a useful ending. Widths were
  // computed once above, so this remains O(n) and never reverses text.
  while (left <= right) {
    const prefixWidth = widths[left]
    const suffixWidth = widths[right]
    const preferSuffix = suffixCells <= prefixCells
    const first = preferSuffix ? "suffix" : "prefix"
    const second = preferSuffix ? "prefix" : "suffix"
    let added = false

    for (const side of [first, second]) {
      if (side === "prefix" && prefixCells + suffixCells + prefixWidth <= available) {
        prefixCells += prefixWidth
        left++
        added = true
        break
      }
      if (side === "suffix" && prefixCells + suffixCells + suffixWidth <= available) {
        suffixCells += suffixWidth
        right--
        added = true
        break
      }
    }
    if (!added) break
  }

  return parts.slice(0, left).join("") + "…" + parts.slice(right + 1).join("")
}
