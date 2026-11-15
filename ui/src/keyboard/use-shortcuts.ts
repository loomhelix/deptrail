import { onMounted, onUnmounted } from 'vue'
import { shortcutFor, type KeyTarget, type ShortcutCommand } from './shortcuts.ts'

const MENU_OR_DIALOG = '[role="menu"], [role="dialog"], [role="alertdialog"], dialog'

export type ShortcutHandler = () => boolean | void

function targetOf(event: KeyboardEvent): KeyTarget {
  const element = event.target instanceof HTMLElement ? event.target : undefined
  return {
    tagName: element?.tagName ?? '',
    isContentEditable: element?.isContentEditable ?? false,
    isInMenuOrDialog: element !== undefined && element.closest(MENU_OR_DIALOG) !== null,
    inputType: element instanceof HTMLInputElement ? element.type : undefined,
  }
}

export function useShortcuts(handlers: Partial<Record<ShortcutCommand, ShortcutHandler>>): void {
  function onKeydown(event: KeyboardEvent): void {
    const command = shortcutFor(event, targetOf(event))
    const handler = command === undefined ? undefined : handlers[command]
    if (!handler) return
    if (handler() !== false) event.preventDefault()
  }

  onMounted(() => window.addEventListener('keydown', onKeydown))
  onUnmounted(() => window.removeEventListener('keydown', onKeydown))
}
