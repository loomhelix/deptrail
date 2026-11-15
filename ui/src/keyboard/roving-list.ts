export type RovingItem = { id: string; parentId?: string; expandable: boolean; expanded: boolean }
export type RovingAction = { kind: 'move' | 'expand' | 'collapse' | 'activate'; id: string }

function moveTo(items: readonly RovingItem[], index: number, currentIndex: number): RovingAction | undefined {
  const target = items[index]
  if (!target || index === currentIndex) return undefined
  return { kind: 'move', id: target.id }
}

export function rovingAction(items: readonly RovingItem[], activeId: string | undefined, key: string): RovingAction | undefined {
  if (items.length === 0) return undefined
  const index = items.findIndex((item) => item.id === activeId)
  const current = items[index]

  if (!current) {
    return key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End' || key === 'ArrowRight' || key === 'ArrowLeft'
      ? moveTo(items, key === 'End' ? items.length - 1 : 0, -1)
      : undefined
  }

  switch (key) {
    case 'ArrowDown':
      return moveTo(items, index + 1, index)
    case 'ArrowUp':
      return moveTo(items, index - 1, index)
    case 'Home':
      return moveTo(items, 0, index)
    case 'End':
      return moveTo(items, items.length - 1, index)
    case 'ArrowRight': {
      if (current.expandable && !current.expanded) return { kind: 'expand', id: current.id }
      const next = items[index + 1]
      return next && next.parentId === current.id ? { kind: 'move', id: next.id } : undefined
    }
    case 'ArrowLeft': {
      if (current.expandable && current.expanded) return { kind: 'collapse', id: current.id }
      const parent = current.parentId === undefined ? undefined : items.find((item) => item.id === current.parentId)
      return parent ? { kind: 'move', id: parent.id } : undefined
    }
    case 'Enter':
    case ' ':
      return { kind: 'activate', id: current.id }
    default:
      return undefined
  }
}
