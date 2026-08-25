export type LayoutMode = "normal" | "compact" | "too-small"

export interface AppLayout {
  mode: LayoutMode
  listRows: number
  showInspector: boolean
  statusRows: number
  budgetRows: number
}

/** Calculate the fixed terminal budget used by the main screen. */
export function calculateLayout(terminalWidth: number, terminalHeight: number, hasStatus: boolean): AppLayout {
  const width = Math.max(0, Math.floor(terminalWidth))
  const height = Math.max(0, Math.floor(terminalHeight))
  const statusRows = hasStatus ? 1 : 0
  // Outer padding, header, main gap, list header/filter/footer, borders and
  // the breathing room needed by the compact layout and the two-line guide.
  const fixedRows = 16 + statusRows
  const minimumListRows = 1
  const tooSmall = width < 40 || height < fixedRows + minimumListRows
  const mode: LayoutMode = tooSmall ? "too-small" : width < 100 || height < 18 ? "compact" : "normal"
  const listRows = tooSmall ? 0 : Math.max(0, height - fixedRows)
  const budgetRows = Math.min(height, fixedRows + listRows)

  return {
    mode,
    listRows,
    showInspector: mode === "normal",
    statusRows,
    budgetRows
  }
}
