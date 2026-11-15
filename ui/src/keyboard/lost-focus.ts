import { nextTick } from 'vue'

export type FocusOwner = { activeElement: unknown; body: unknown }

export function hasLostFocus(owner: FocusOwner): boolean {
  return owner.activeElement === null || owner.activeElement === owner.body
}

export async function restoreFocusIfLost(owner: FocusOwner, restore: () => void): Promise<void> {
  await nextTick()
  if (hasLostFocus(owner)) restore()
}
