export type MenuKeyAction = { kind: 'move'; index: number } | { kind: 'choose'; index: number } | { kind: 'close' } | { kind: 'leave' }
export type MenuButtonEvent = { type: 'mousedown' } | { type: 'click' } | { type: 'keyup'; key: string }
export type MenuButtonState = { isOpen: boolean; choseWithSpace: boolean }
export type MenuButtonResponse = { preventDefault: boolean; menu?: 'open' | 'close' }

const SPACE = ' '

function isPrintableCharacter(key: string): boolean {
  return [...key].length === 1 && key.trim() !== ''
}

function nextStartingWith(labels: readonly string[], activeIndex: number, character: string): number | undefined {
  const typedPrefix = character.toLocaleLowerCase()
  for (let offset = 1; offset < labels.length; offset += 1) {
    const index = (activeIndex + offset) % labels.length
    if (labels[index]!.toLocaleLowerCase().startsWith(typedPrefix)) return index
  }
  return undefined
}

export function menuKeyAction(labels: readonly string[], activeIndex: number, key: string): MenuKeyAction | undefined {
  if (key === 'Escape') return { kind: 'close' }
  if (key === 'Tab') return { kind: 'leave' }
  const count = labels.length
  if (count === 0) return undefined
  switch (key) {
    case 'ArrowDown':
      return { kind: 'move', index: (activeIndex + 1) % count }
    case 'ArrowUp':
      return { kind: 'move', index: (activeIndex - 1 + count) % count }
    case 'Home':
      return { kind: 'move', index: 0 }
    case 'End':
      return { kind: 'move', index: count - 1 }
    case 'Enter':
    case SPACE:
      return { kind: 'choose', index: activeIndex }
  }
  if (!isPrintableCharacter(key)) return undefined
  const index = nextStartingWith(labels, activeIndex, key)
  return index === undefined ? undefined : { kind: 'move', index }
}

export function menuButtonResponse(event: MenuButtonEvent, state: MenuButtonState): MenuButtonResponse {
  switch (event.type) {
    case 'mousedown':
      return { preventDefault: state.isOpen }
    case 'click':
      return { preventDefault: false, menu: state.isOpen ? 'close' : 'open' }
    case 'keyup':
      return { preventDefault: event.key === SPACE && state.choseWithSpace }
  }
}
