import { ref, watch, type Ref } from 'vue'
import { rovingAction, type RovingItem } from './roving-list.ts'

type RovingHandlers = { expand(id: string): void; collapse(id: string): void; activate(id: string): void }

function survivingId(previous: readonly RovingItem[], next: readonly RovingItem[], activeId: string | undefined): string | undefined {
  if (next.length === 0) return undefined
  if (activeId !== undefined && next.some((item) => item.id === activeId)) return activeId
  const previousIndex = previous.findIndex((item) => item.id === activeId)
  for (let index = previousIndex - 1; index >= 0; index -= 1) {
    const candidate = previous[index]!.id
    if (next.some((item) => item.id === candidate)) return candidate
  }
  return next[0]!.id
}

export function useRovingList(items: Ref<readonly RovingItem[]>, handlers: RovingHandlers) {
  const activeId = ref<string | undefined>(items.value[0]?.id)

  watch(items, (next, previous) => {
    activeId.value = survivingId(previous, next, activeId.value)
  })

  function tabIndexOf(id: string): 0 | -1 {
    return id === activeId.value ? 0 : -1
  }

  function focusActive(): void {
    const id = activeId.value
    if (id === undefined) return
    const element = document.querySelector<HTMLElement>(`[data-roving-id="${CSS.escape(id)}"]`)
    element?.focus()
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const action = rovingAction(items.value, activeId.value, event.key)
    if (!action) return
    event.preventDefault()
    if (action.kind === 'move') {
      activeId.value = action.id
      focusActive()
    } else if (action.kind === 'expand') handlers.expand(action.id)
    else if (action.kind === 'collapse') handlers.collapse(action.id)
    else handlers.activate(action.id)
  }

  return { activeId, tabIndexOf, onKeydown, focusActive }
}
