<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import type { RootSummary } from '../api.ts'
import { sectionRoots } from '../changes-flow.ts'
import type { Selection } from '../context.ts'
import RootChangesSection from '../components/RootChangesSection.vue'
import { restoreFocusIfLost } from '../keyboard/lost-focus.ts'
import { LOADING_SCAN, NO_CHANGES_YET, VIEW_TITLES } from '../vocabulary.ts'

const props = defineProps<{
  scope?: string
  roots: readonly RootSummary[]
  scanLoaded: boolean
  revisions: ReadonlyMap<string, string>
  focus?: { root: string; itemId: string }
}>()

const emit = defineEmits<{
  changed: []
  edit: [selection: Selection, itemId: string]
  'item-focused': []
}>()

const SECTION_SELECTOR = '[data-root-changes]'

const container = ref<HTMLElement | null>(null)
const heldRoots = shallowRef<ReadonlySet<string>>(new Set())

const listedRoots = computed(() => new Set(sectionRoots(props.roots, props.scope)))
const shownRoots = computed(() =>
  props.roots.filter((root) => {
    if (props.scope !== undefined && root.id !== props.scope) return false
    return listedRoots.value.has(root.id) || heldRoots.value.has(root.id)
  }),
)
const shownRootIds = computed(() => shownRoots.value.map((root) => root.id))

function hold(root: string, held: boolean): void {
  if (heldRoots.value.has(root) === held) return
  const next = new Set(heldRoots.value)
  if (held) next.add(root)
  else next.delete(root)
  heldRoots.value = next
}

function focusItemOf(root: string): string | undefined {
  return props.focus?.root === root ? props.focus.itemId : undefined
}

function focusedSectionRoot(): string | undefined {
  const focused = document.activeElement
  const section = focused instanceof HTMLElement ? focused.closest<HTMLElement>(SECTION_SELECTOR) : null
  return section?.dataset.rootChanges
}

watch(shownRootIds, (next, previous) => {
  const focusedRoot = focusedSectionRoot()
  if (focusedRoot === undefined || next.includes(focusedRoot) || !previous.includes(focusedRoot)) return
  void restoreFocusIfLost(document, () => container.value?.focus())
})
</script>

<template>
  <section ref="container" class="changes" :aria-label="VIEW_TITLES.changes" tabindex="-1">
    <p v-if="!scanLoaded" class="changes__message muted">{{ LOADING_SCAN }}</p>
    <p v-else-if="shownRoots.length === 0" class="changes__message muted" data-testid="changes-empty">{{ NO_CHANGES_YET }}</p>
    <RootChangesSection
      v-for="root in shownRoots"
      :key="root.id"
      :root="root"
      :revision="revisions.get(root.id) ?? ''"
      :focus-item="focusItemOf(root.id)"
      @changed="emit('changed')"
      @edit="(selection: Selection, itemId: string) => emit('edit', selection, itemId)"
      @item-focused="emit('item-focused')"
      @hold="(held: boolean) => hold(root.id, held)"
    />
  </section>
</template>

<style scoped>
.changes {
  min-height: 100%;
}

.changes:focus-visible {
  outline-offset: -2px;
}

.changes__message {
  margin: 0;
  padding: 16px;
  overflow-wrap: anywhere;
}
</style>
