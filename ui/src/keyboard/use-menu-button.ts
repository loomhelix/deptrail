import { nextTick, ref } from 'vue'
import { menuButtonResponse, menuKeyAction, type MenuButtonEvent } from './menu-keys.ts'

type MenuButtonOptions = {
  labels: () => readonly string[]
  isDisabled?: (index: number) => boolean
  keepsOpen?: (index: number) => boolean
  onChoose: (index: number) => void
}

const MENU_ITEM_SELECTOR = '[data-menu-item]'

export function useMenuButton(options: MenuButtonOptions) {
  const isOpen = ref(false)
  const activeIndex = ref(0)
  const container = ref<HTMLElement | null>(null)
  const button = ref<HTMLButtonElement | null>(null)
  const menu = ref<HTMLElement | null>(null)
  let choseWithSpace = false

  function focusItem(index: number): void {
    activeIndex.value = index
    menu.value?.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR)[index]?.focus()
  }

  async function openAt(index: number): Promise<void> {
    isOpen.value = true
    await nextTick()
    focusItem(index)
  }

  function close(): void {
    isOpen.value = false
  }

  function closeAndFocusButton(): void {
    isOpen.value = false
    button.value?.focus()
  }

  function choose(index: number): boolean {
    if (options.isDisabled?.(index) === true) return false
    if (options.keepsOpen?.(index) === true) {
      focusItem(index)
      options.onChoose(index)
      return false
    }
    closeAndFocusButton()
    options.onChoose(index)
    return true
  }

  function dismiss(): boolean {
    if (!isOpen.value) return false
    close()
    return true
  }

  function respond(event: Event, buttonEvent: MenuButtonEvent): void {
    const response = menuButtonResponse(buttonEvent, { isOpen: isOpen.value, choseWithSpace })
    if (response.preventDefault) event.preventDefault()
    if (response.menu === 'close') closeAndFocusButton()
    else if (response.menu === 'open') void openAt(0)
  }

  function onButtonMousedown(event: MouseEvent): void {
    respond(event, { type: 'mousedown' })
  }

  function onButtonClick(event: MouseEvent): void {
    respond(event, { type: 'click' })
  }

  function onButtonKeyup(event: KeyboardEvent): void {
    respond(event, { type: 'keyup', key: event.key })
    choseWithSpace = false
  }

  function onButtonKeydown(event: KeyboardEvent): void {
    choseWithSpace = false
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    void openAt(event.key === 'ArrowDown' ? 0 : Math.max(0, options.labels().length - 1))
  }

  function onMenuKeydown(event: KeyboardEvent): void {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const action = menuKeyAction(options.labels(), activeIndex.value, event.key)
    if (action === undefined) return
    if (action.kind === 'leave') {
      close()
      return
    }
    event.preventDefault()
    if (action.kind === 'move') focusItem(action.index)
    else if (action.kind === 'close') closeAndFocusButton()
    else choseWithSpace = choose(action.index) && event.key === ' '
  }

  function onFocusOut(event: FocusEvent): void {
    const next = event.relatedTarget
    if (next instanceof Node && container.value?.contains(next)) return
    close()
  }

  return {
    isOpen,
    container,
    button,
    menu,
    choose,
    dismiss,
    onButtonMousedown,
    onButtonClick,
    onButtonKeydown,
    onButtonKeyup,
    onMenuKeydown,
    onFocusOut,
  }
}
