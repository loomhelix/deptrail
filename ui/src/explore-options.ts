import type { NodeId } from '../../src/model.ts'
import type { UiContext } from './context.ts'

export type GraphScope = 'package' | 'whole-root'
export type GraphOptions = { scope: GraphScope; nodeLimit: number; wholeRootDown: number }
export type ExploreFilterChange = Partial<Pick<UiContext, 'duplicatesOnly' | 'up' | 'down'>>
export type DownDepthChange = { filters: ExploreFilterChange } | { graph: Partial<GraphOptions> }

export const GRAPH_SCOPES: readonly GraphScope[] = ['package', 'whole-root']
export const DEFAULT_GRAPH_OPTIONS: GraphOptions = { scope: 'package', nodeLimit: 300, wholeRootDown: 6 }

const WHOLE_NUMBER = /^\d+$/

export function parseCount(raw: string, minimum: number): number | undefined {
  const trimmed = raw.trim()
  if (!WHOLE_NUMBER.test(trimmed)) return undefined
  const count = Number(trimmed)
  return count >= minimum ? count : undefined
}

export function shownDownDepth(options: GraphOptions, down: number): number {
  return options.scope === 'whole-root' ? options.wholeRootDown : down
}

export function downDepthChange(options: GraphOptions, down: number): DownDepthChange {
  return options.scope === 'whole-root' ? { graph: { wholeRootDown: down } } : { filters: { down } }
}

export function graphScopeFor(options: GraphOptions, anchor: NodeId | undefined): GraphScope {
  return anchor === undefined ? 'whole-root' : options.scope
}
