export type PanelState = { rootsCollapsed: boolean; detailsCollapsed: boolean }
export type PanelStateReader = { getItem(key: string): string | null }
export type PanelStateWriter = { setItem(key: string, value: string): void }

export const PANEL_STATE_KEY = 'deptrail.panels'

const DETAILS_COLLAPSED_BELOW_PX = 1100
const ROOTS_COLLAPSED_BELOW_PX = 820

function defaultPanelState(viewportWidth: number): PanelState {
  return {
    rootsCollapsed: viewportWidth < ROOTS_COLLAPSED_BELOW_PX,
    detailsCollapsed: viewportWidth < DETAILS_COLLAPSED_BELOW_PX,
  }
}

function storedText(storage: PanelStateReader | undefined): string | null {
  try {
    return storage?.getItem(PANEL_STATE_KEY) ?? null
  } catch {
    return null
  }
}

function parsedRecord(text: string | null): Record<string, unknown> {
  if (text === null) return {}
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

export function readPanelState(storage: PanelStateReader | undefined, viewportWidth: number): PanelState {
  const defaults = defaultPanelState(viewportWidth)
  const stored = parsedRecord(storedText(storage))
  return {
    rootsCollapsed: booleanOr(stored.rootsCollapsed, defaults.rootsCollapsed),
    detailsCollapsed: booleanOr(stored.detailsCollapsed, defaults.detailsCollapsed),
  }
}

export function writePanelState(storage: PanelStateWriter | undefined, state: PanelState): void {
  try {
    storage?.setItem(PANEL_STATE_KEY, JSON.stringify({ rootsCollapsed: state.rootsCollapsed, detailsCollapsed: state.detailsCollapsed }))
  } catch {
    return
  }
}
