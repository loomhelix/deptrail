<script setup lang="ts">
import { computed, useId } from 'vue'
import type { RootSummary } from '../api.ts'
import { useMenuButton } from '../keyboard/use-menu-button.ts'
import { rootLabel } from '../labels.ts'
import { ALL_ROOTS, HEALTH_SEPARATOR, rootHealthLinks, rootStatusMark, rootSwitcherName, scopeLabel } from '../vocabulary.ts'
import AppIcon from './AppIcon.vue'

const props = defineProps<{ roots: RootSummary[]; scope?: string }>()

const emit = defineEmits<{ choose: [root: string | undefined] }>()

type SwitcherItem = { key: string; root: string | undefined; label: string; detail: string; mark: string | undefined }

const MARK_TONES: Readonly<Record<string, string>> = {
  scanning: 'badge--info',
  failed: 'badge--danger',
  approximate: 'badge--warn',
}

const elementId = useId()
const buttonId = `${elementId}-button`
const menuId = `${elementId}-menu`

function rootDetail(root: RootSummary): string {
  return [root.manager, ...rootHealthLinks(root).map((link) => link.text)].join(HEALTH_SEPARATOR)
}

const items = computed<SwitcherItem[]>(() => [
  { key: 'all-roots', root: undefined, label: ALL_ROOTS, detail: '', mark: undefined },
  ...props.roots.map((root) => ({
    key: `root-${root.id}`,
    root: root.id,
    label: rootLabel(root.id),
    detail: rootDetail(root),
    mark: rootStatusMark(root),
  })),
])

const {
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
} = useMenuButton({
  labels: () => items.value.map((item) => item.label),
  onChoose: (index) => {
    const item = items.value[index]
    if (item !== undefined) emit('choose', item.root)
  },
})

function isChecked(item: SwitcherItem): boolean {
  return item.root === props.scope
}

function itemPartId(index: number, part: 'name' | 'mark' | 'detail'): string {
  return `${elementId}-item-${index}-${part}`
}

function describedBy(item: SwitcherItem, index: number): string | undefined {
  const parts = [item.mark === undefined ? undefined : itemPartId(index, 'mark'), item.detail === '' ? undefined : itemPartId(index, 'detail')]
  const ids = parts.filter((id) => id !== undefined)
  return ids.length === 0 ? undefined : ids.join(' ')
}

function focusButton(): void {
  button.value?.focus()
}

defineExpose({ focusButton, dismiss })
</script>

<template>
  <div ref="container" class="switcher" @focusout="onFocusOut">
    <button
      :id="buttonId"
      ref="button"
      type="button"
      class="switcher__button"
      aria-haspopup="menu"
      :aria-expanded="isOpen"
      :aria-controls="isOpen ? menuId : undefined"
      :aria-label="rootSwitcherName(scope)"
      @mousedown="onButtonMousedown"
      @click="onButtonClick"
      @keydown="onButtonKeydown"
      @keyup="onButtonKeyup"
    >
      <span class="switcher__current" :class="{ mono: scope !== undefined }">{{ scopeLabel(scope) }}</span>
      <AppIcon class="switcher__caret" name="chevron-down" />
    </button>
    <div v-if="isOpen" :id="menuId" ref="menu" role="menu" class="switcher__menu" :aria-labelledby="buttonId" @keydown="onMenuKeydown" @mousedown.prevent>
      <div
        v-for="(item, index) in items"
        :key="item.key"
        role="menuitemradio"
        tabindex="-1"
        data-menu-item
        class="switcher__item"
        :aria-checked="isChecked(item)"
        :aria-labelledby="itemPartId(index, 'name')"
        :aria-describedby="describedBy(item, index)"
        @click="choose(index)"
      >
        <span class="switcher__check" aria-hidden="true"><AppIcon v-if="isChecked(item)" name="check" /></span>
        <span :id="itemPartId(index, 'name')" class="switcher__name" :class="{ mono: item.root !== undefined }">{{ item.label }}</span>
        <span v-if="item.mark" :id="itemPartId(index, 'mark')" class="badge switcher__mark" :class="MARK_TONES[item.mark]">{{ item.mark }}</span>
        <span v-if="item.detail" :id="itemPartId(index, 'detail')" class="switcher__detail">{{ item.detail }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.switcher {
  position: relative;
  flex: none;
}

.switcher__button {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: 260px;
  height: 32px;
  padding: 0 10px 0 12px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  background: var(--surface-raised);
  cursor: pointer;
}

.switcher__button:hover {
  background: var(--surface-hover);
}

.switcher__current {
  min-width: 0;
  overflow: hidden;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.switcher__caret {
  margin-left: 4px;
  color: var(--text-muted);
}

.switcher__menu {
  position: absolute;
  z-index: 20;
  top: calc(100% + 4px);
  left: 0;
  min-width: 280px;
  max-width: min(440px, calc(100vw - 32px));
  max-height: min(70vh, 560px);
  overflow-y: auto;
  padding: 4px 0;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: var(--surface-raised);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.16);
}

.switcher__item {
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr) auto;
  align-items: baseline;
  gap: 2px 8px;
  padding: 6px 14px 6px 10px;
  cursor: pointer;
}

.switcher__item:hover {
  background: var(--surface-hover);
}

.switcher__item:focus {
  outline: none;
  background: var(--surface-selected);
}

.switcher__item:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.switcher__check {
  color: var(--accent);
  font-weight: 600;
}

.switcher__name {
  min-width: 0;
  overflow-wrap: anywhere;
  font-weight: 600;
}

.switcher__mark {
  justify-self: end;
}

.switcher__detail {
  grid-column: 2 / -1;
  color: var(--text-muted);
  font-size: 13px;
}
</style>
