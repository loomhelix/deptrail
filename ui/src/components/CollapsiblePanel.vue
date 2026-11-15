<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { IconName } from '../icons.ts'
import { hidePanelName, showPanelName } from '../vocabulary.ts'
import AppIcon from './AppIcon.vue'

const props = defineProps<{
  side: 'left' | 'right'
  landmark: 'nav' | 'aside'
  landmarkLabel: string
  focusable?: boolean
  label: string
  shortcut: string
  collapsed: boolean
}>()

const emit = defineEmits<{ 'update:collapsed': [collapsed: boolean] }>()

const TOGGLE_ICONS: Readonly<Record<'left' | 'right', { hide: IconName; show: IconName }>> = {
  left: { hide: 'chevrons-left', show: 'chevrons-right' },
  right: { hide: 'chevrons-right', show: 'chevrons-left' },
}

const BOTTOM_BAR_QUERY = '(max-width: 820px)'
const BOTTOM_BAR_ICONS: { hide: IconName; show: IconName } = { hide: 'chevron-down', show: 'chevron-up' }

const bottomBar = ref(typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(BOTTOM_BAR_QUERY).matches)
let bottomBarQuery: MediaQueryList | undefined

function syncBottomBar(): void {
  bottomBar.value = bottomBarQuery?.matches ?? false
}

onMounted(() => {
  bottomBarQuery = window.matchMedia(BOTTOM_BAR_QUERY)
  syncBottomBar()
  bottomBarQuery.addEventListener('change', syncBottomBar)
})

onBeforeUnmount(() => bottomBarQuery?.removeEventListener('change', syncBottomBar))

const container = ref<HTMLElement | null>(null)
const showButton = ref<HTMLButtonElement | null>(null)
const hideButton = ref<HTMLButtonElement | null>(null)

const showName = computed(() => showPanelName(props.label, props.shortcut))
const hideName = computed(() => hidePanelName(props.label, props.shortcut))
const toggleIcons = computed(() => (props.side === 'right' && bottomBar.value ? BOTTOM_BAR_ICONS : TOGGLE_ICONS[props.side]))

function hasFocusInside(): boolean {
  const focused = document.activeElement
  return focused !== null && (container.value?.contains(focused) ?? false)
}

function focusLandmark(): void {
  container.value?.focus()
}

defineExpose({ focusLandmark })

watch(
  () => props.collapsed,
  (collapsed) => {
    const shouldFocusToggle = collapsed || hasFocusInside()
    void nextTick(() => {
      if (!shouldFocusToggle) return
      if (collapsed) showButton.value?.focus()
      else hideButton.value?.focus()
    })
  },
)
</script>

<template>
  <component
    :is="landmark"
    ref="container"
    class="collapsible"
    :class="[`collapsible--${side}`, { 'collapsible--collapsed': collapsed }]"
    :aria-label="landmarkLabel"
    :tabindex="focusable ? -1 : undefined"
  >
    <div v-show="collapsed" class="collapsible__strip">
      <button
        ref="showButton"
        type="button"
        class="collapsible__toggle"
        :aria-label="showName"
        :title="showName"
        @click="emit('update:collapsed', false)"
      >
        <AppIcon :name="toggleIcons.show" :size="18" />
      </button>
    </div>
    <div v-show="!collapsed" class="collapsible__header">
      <slot name="header" />
      <button
        ref="hideButton"
        type="button"
        class="collapsible__toggle"
        :aria-label="hideName"
        :title="hideName"
        @click="emit('update:collapsed', true)"
      >
        <AppIcon :name="toggleIcons.hide" :size="18" />
      </button>
    </div>
    <div v-show="!collapsed" class="collapsible__body">
      <slot />
    </div>
  </component>
</template>

<style scoped>
.collapsible {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: var(--surface-panel);
}

.collapsible:focus-visible {
  outline-offset: -2px;
}

.collapsible__strip {
  display: flex;
  flex: 1;
  justify-content: center;
  padding-top: 8px;
}

.collapsible__header {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 48px;
  padding: 8px 8px 8px 14px;
  border-bottom: 1px solid var(--border);
}

.collapsible--right .collapsible__header {
  padding-left: 16px;
}

.collapsible--left .collapsible__strip,
.collapsible--left .collapsible__header {
  border-right: 1px solid var(--border);
}

.collapsible--right .collapsible__strip,
.collapsible--right .collapsible__header {
  border-left: 1px solid var(--border);
}

.collapsible__body {
  display: grid;
  flex: 1;
  grid-template-rows: minmax(0, 1fr);
  grid-template-columns: minmax(0, 1fr);
  min-height: 0;
}

.collapsible__toggle {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--radius);
  background: none;
  color: var(--text-muted);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
}

.collapsible__toggle:hover {
  border-color: var(--border-strong);
  background: var(--surface-hover);
  color: var(--text);
}
</style>
