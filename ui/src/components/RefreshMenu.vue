<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import type { EnrichmentStatus } from '../../../src/enrich/types.ts'
import { useMenuButton } from '../keyboard/use-menu-button.ts'
import { lastCheckText, RECHECK_REGISTRY, REFRESH, RELOAD_BRANCH, RESCAN_FILES } from '../vocabulary.ts'
import AppIcon from './AppIcon.vue'

const props = defineProps<{ status?: EnrichmentStatus; reloadsBranch?: boolean }>()

const emit = defineEmits<{ rescan: []; 'check-again': []; reload: [] }>()

type RefreshItem = { label: string; disabled: boolean; run: () => void }

const elementId = useId()
const buttonId = `${elementId}-button`
const menuId = `${elementId}-menu`
const lastCheckId = `${elementId}-last-check`
const openedAt = ref(Date.now())

const checksCanStartAgain = computed(() => props.status?.state === 'done')
const items = computed<RefreshItem[]>(() => [
  props.reloadsBranch
    ? { label: RELOAD_BRANCH, disabled: false, run: () => emit('reload') }
    : { label: RESCAN_FILES, disabled: false, run: () => emit('rescan') },
  { label: RECHECK_REGISTRY, disabled: !checksCanStartAgain.value, run: () => emit('check-again') },
])
const lastCheck = computed(() => (props.status === undefined ? '' : lastCheckText(props.status, openedAt.value)))

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
  isDisabled: (index) => items.value[index]?.disabled ?? true,
  onChoose: (index) => items.value[index]?.run(),
})

watch(isOpen, (open) => {
  if (open) openedAt.value = Date.now()
})

defineExpose({ dismiss })
</script>

<template>
  <div ref="container" class="refresh" @focusout="onFocusOut">
    <button
      :id="buttonId"
      ref="button"
      type="button"
      class="refresh__button"
      aria-haspopup="menu"
      :aria-expanded="isOpen"
      :aria-controls="isOpen ? menuId : undefined"
      @mousedown="onButtonMousedown"
      @click="onButtonClick"
      @keydown="onButtonKeydown"
      @keyup="onButtonKeyup"
    >
      {{ REFRESH }}<AppIcon class="refresh__caret" name="chevron-down" />
    </button>
    <div v-if="isOpen" class="refresh__popover" @mousedown.prevent>
      <div
        :id="menuId"
        ref="menu"
        role="menu"
        :aria-labelledby="buttonId"
        :aria-describedby="lastCheck ? lastCheckId : undefined"
        @keydown="onMenuKeydown"
      >
        <div
          v-for="(item, index) in items"
          :key="item.label"
          role="menuitem"
          tabindex="-1"
          data-menu-item
          class="refresh__item"
          :aria-disabled="item.disabled ? 'true' : undefined"
          @click="choose(index)"
        >
          {{ item.label }}
        </div>
      </div>
      <p v-if="lastCheck" :id="lastCheckId" class="refresh__last-check">{{ lastCheck }}</p>
    </div>
  </div>
</template>

<style scoped>
.refresh {
  position: relative;
  flex: none;
}

.refresh__button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 10px 0 12px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  background: var(--surface-raised);
  cursor: pointer;
  white-space: nowrap;
}

.refresh__button:hover {
  background: var(--surface-hover);
}

.refresh__caret {
  margin-left: 4px;
  color: var(--text-muted);
}

.refresh__popover {
  position: absolute;
  z-index: 20;
  top: calc(100% + 4px);
  right: 0;
  min-width: 280px;
  padding: 4px 0;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: var(--surface-raised);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.16);
}

.refresh__item {
  padding: 6px 14px;
  cursor: pointer;
  white-space: nowrap;
}

.refresh__item:hover {
  background: var(--surface-hover);
}

.refresh__item:focus {
  outline: none;
  background: var(--surface-selected);
}

.refresh__item:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.refresh__item[aria-disabled='true'] {
  color: var(--text-muted);
  cursor: default;
}

.refresh__item[aria-disabled='true']:hover {
  background: none;
}

.refresh__last-check {
  margin: 4px 0 0;
  padding: 6px 14px 4px;
  border-top: 1px solid var(--border);
  color: var(--text-muted);
  font-size: 13px;
}
</style>
