export type ViewTransform = { x: number; y: number; k: number }
export type ViewSize = { width: number; height: number }
export type ViewPoint = { x: number; y: number }

export const FIT_PADDING = 24
const MIN_FIT_SCALE = 0.5
const MAX_FIT_SCALE = 1

function axisRatio(available: number, content: number): number {
  return content > 0 ? available / content : Infinity
}

function axisOffset(viewport: number, content: number, scale: number, anchor: number | undefined): number {
  const scaled = content * scale
  if (scaled <= viewport - 2 * FIT_PADDING) return (viewport - scaled) / 2
  return anchor === undefined ? FIT_PADDING : viewport / 2 - anchor * scale
}

export function fitTransform(content: ViewSize, viewport: ViewSize, anchor?: ViewPoint): ViewTransform {
  if (viewport.width <= 0 || viewport.height <= 0) return { x: FIT_PADDING, y: FIT_PADDING, k: MAX_FIT_SCALE }
  const ratio = Math.min(
    axisRatio(viewport.width - 2 * FIT_PADDING, content.width),
    axisRatio(viewport.height - 2 * FIT_PADDING, content.height),
  )
  const k = Math.max(MIN_FIT_SCALE, Math.min(MAX_FIT_SCALE, ratio))
  return {
    x: axisOffset(viewport.width, content.width, k, anchor?.x),
    y: axisOffset(viewport.height, content.height, k, anchor?.y),
    k,
  }
}
