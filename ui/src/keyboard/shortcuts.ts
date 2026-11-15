export type ShortcutCommand =
  | 'search'
  | 'toggle-roots'
  | 'toggle-details'
  | 'view-issues'
  | 'view-changes'
  | 'view-explore'
  | 'view-compare'
  | 'help'
  | 'escape'

export type KeyInput = { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; defaultPrevented: boolean }
export type KeyTarget = { tagName: string; isContentEditable: boolean; isInMenuOrDialog: boolean; inputType?: string }

const TEXT_ENTRY_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

const SINGLE_KEY_COMMANDS: Readonly<Record<string, ShortcutCommand>> = {
  '/': 'search',
  '[': 'toggle-roots',
  ']': 'toggle-details',
  '1': 'view-issues',
  '2': 'view-changes',
  '3': 'view-explore',
  '4': 'view-compare',
  '?': 'help',
}

function isTextEntry(target: KeyTarget): boolean {
  return target.isContentEditable || TEXT_ENTRY_TAGS.has(target.tagName.toUpperCase())
}

export function shortcutFor(event: KeyInput, target: KeyTarget): ShortcutCommand | undefined {
  if (event.defaultPrevented || target.isInMenuOrDialog) return undefined
  if (event.key === 'Escape') return 'escape'
  if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') return 'search'
  if (event.metaKey || event.ctrlKey || event.altKey) return undefined
  if (isTextEntry(target)) return undefined
  return Object.hasOwn(SINGLE_KEY_COMMANDS, event.key) ? SINGLE_KEY_COMMANDS[event.key] : undefined
}
