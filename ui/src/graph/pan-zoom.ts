export type PanZoomTransform = { x: number; y: number; k: number }

const MIN_SCALE = 0.2
const MAX_SCALE = 3
const WHEEL_ZOOM_RATE = 0.002
const LINE_DELTA_PX = 16
const PAGE_DELTA_PX = 400
const DRAG_THRESHOLD_PX = 3

type DragState = { pointerId: number; startX: number; startY: number; lastX: number; lastY: number; panning: boolean }

function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
}

function wheelDeltaPx(event: WheelEvent): number {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return event.deltaY * LINE_DELTA_PX
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return event.deltaY * PAGE_DELTA_PX
  return event.deltaY
}

export function createPanZoom(svg: SVGSVGElement, onChange: (transform: PanZoomTransform) => void): () => void {
  let transform: PanZoomTransform = { x: 0, y: 0, k: 1 }
  let drag: DragState | null = null

  function update(next: PanZoomTransform): void {
    transform = next
    onChange(next)
  }

  function onWheel(event: WheelEvent): void {
    event.preventDefault()
    const k = clampScale(transform.k * Math.exp(-wheelDeltaPx(event) * WHEEL_ZOOM_RATE))
    if (k === transform.k) return
    const bounds = svg.getBoundingClientRect()
    const cursorX = event.clientX - bounds.left
    const cursorY = event.clientY - bounds.top
    const ratio = k / transform.k
    update({ x: cursorX - (cursorX - transform.x) * ratio, y: cursorY - (cursorY - transform.y) * ratio, k })
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return
    drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, lastX: event.clientX, lastY: event.clientY, panning: false }
  }

  function onPointerMove(event: PointerEvent): void {
    if (!drag || event.pointerId !== drag.pointerId) return
    if (!drag.panning) {
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < DRAG_THRESHOLD_PX) return
      drag.panning = true
      svg.setPointerCapture(event.pointerId)
    }
    update({ x: transform.x + event.clientX - drag.lastX, y: transform.y + event.clientY - drag.lastY, k: transform.k })
    drag.lastX = event.clientX
    drag.lastY = event.clientY
  }

  function endDrag(): void {
    if (drag && svg.hasPointerCapture(drag.pointerId)) svg.releasePointerCapture(drag.pointerId)
    drag = null
  }

  function onPointerEnd(event: PointerEvent): void {
    if (drag && event.pointerId === drag.pointerId) endDrag()
  }

  svg.addEventListener('wheel', onWheel, { passive: false })
  svg.addEventListener('pointerdown', onPointerDown)
  svg.addEventListener('pointermove', onPointerMove)
  svg.addEventListener('pointerup', onPointerEnd)
  svg.addEventListener('pointercancel', onPointerEnd)

  return () => {
    svg.removeEventListener('wheel', onWheel)
    svg.removeEventListener('pointerdown', onPointerDown)
    svg.removeEventListener('pointermove', onPointerMove)
    svg.removeEventListener('pointerup', onPointerEnd)
    svg.removeEventListener('pointercancel', onPointerEnd)
    endDrag()
  }
}
