const DOT_ROOT_SEGMENT = '~'

export function encodeRootSegment(id: string): string {
  if (id === '.') return DOT_ROOT_SEGMENT
  if (id === DOT_ROOT_SEGMENT) return '%7E'
  return encodeURIComponent(id)
}

export function decodeRootSegment(rawSegment: string): string {
  if (rawSegment === DOT_ROOT_SEGMENT) return '.'
  return decodeURIComponent(rawSegment)
}
