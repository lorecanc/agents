export type LayoutMode = "normal" | "compact" | "too-small"

export interface AppLayout {
  mode: LayoutMode
  listRows: number
  showInspector: boolean
  statusRows: number
  budgetRows: number
}

export interface ListColumnBudget {
  widths: number[]
  gutters: number[]
  total: number
}

/** Allocate concrete cell widths; gutters are explicit and never consume a column. */
export function calculateListColumnBudget(contentWidth: number, mode: LayoutMode = "normal"): ListColumnBudget {
  const width = Math.max(0, Math.floor(contentWidth))
  const ratios = mode === "compact" || mode === "too-small" ? [0.12, 0.43, 0.45] : [0.12, 0.30, 0.17, 0.14, 0.27]
  const gutters = ratios.slice(0, -1).map(() => 1)
  const available = Math.max(0, width - gutters.reduce((a, b) => a + b, 0))
  const selectionWidth = Math.min(5, available)
  const remaining = available - selectionWidth
  const otherRatioTotal = ratios.slice(1).reduce((a, b) => a + b, 0)
  const widths = [selectionWidth, ...ratios.slice(1).map(ratio => Math.floor(remaining * ratio / otherRatioTotal))]
  let remainder = available - widths.reduce((a, b) => a + b, 0)
  for (let i = 0; remainder > 0; i = (i + 1) % widths.length, remainder--) widths[i]++
  return { widths, gutters, total: widths.reduce((a, b) => a + b, 0) + gutters.reduce((a, b) => a + b, 0) }
}

/** Calculate the fixed terminal budget used by the main screen. */
export function calculateLayout(terminalWidth: number, terminalHeight: number, hasStatus: boolean): AppLayout {
  const width = Math.max(0, Math.floor(terminalWidth))
  const height = Math.max(0, Math.floor(terminalHeight))
  const statusRows = hasStatus ? 1 : 0
  // Outer padding, header, main gap, list header/filter/footer, borders and
  // the breathing room needed by the compact layout and the two-line guide.
  const fixedRows = 17 + statusRows
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
