<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, useId } from 'vue'
import type { DepKind } from '../../../src/model.ts'
import { addRecommendedToRoots } from '../add-recommended.ts'
import { createApi } from '../api.ts'
import { CHANGES_INDEX } from '../changes-index.ts'
import type { VulnerableRoot } from '../issues-model.ts'
import {
  ADD_FIXES,
  ADD_RECOMMENDED_INTRO,
  ADD_RECOMMENDED_ROOTS,
  ADD_RECOMMENDED_TITLE,
  addingFixesText,
  CANCEL,
  CLOSE,
  collectFailureTexts,
  collectResultText,
  REVIEW_CHANGES,
  vulnerableRootText,
  type RootCollectResult,
} from '../vocabulary.ts'

const props = defineProps<{
  roots: readonly VulnerableRoot[]
  kinds: DepKind[]
  changesHref: (root: string) => string
}>()

const emit = defineEmits<{ close: []; added: []; review: [root: string] }>()

type Phase = 'choosing' | 'adding' | 'done'

const elementId = useId()
const titleId = `${elementId}-title`
const api = createApi()
const changesIndex = inject(CHANGES_INDEX, null)
const dialog = ref<HTMLDialogElement | null>(null)
const closeButton = ref<HTMLButtonElement | null>(null)
const checkedRoots = shallowRef<ReadonlySet<string>>(new Set(props.roots.map((entry) => entry.root)))
const phase = ref<Phase>('choosing')
const addingRoot = ref<string | null>(null)
const results = shallowRef<RootCollectResult[]>([])
const controller = new AbortController()

const chosenRoots = computed(() => props.roots.map((entry) => entry.root).filter((root) => checkedRoots.value.has(root)))
const statusText = computed(() => {
  if (phase.value === 'done') return collectResultText(results.value)
  return phase.value === 'adding' && addingRoot.value !== null ? addingFixesText(addingRoot.value) : ''
})
const failureTexts = computed(() => (phase.value === 'done' ? collectFailureTexts(results.value) : []))
const reviewRoot = computed(() => {
  const withFixes = results.value.find((entry) => (entry.result?.added ?? 0) > 0)
  return (withFixes ?? results.value.find((entry) => entry.error === undefined))?.root
})

function setChecked(root: string, checked: boolean): void {
  const next = new Set(checkedRoots.value)
  if (checked) next.add(root)
  else next.delete(root)
  checkedRoots.value = next
}

async function addFixes(): Promise<void> {
  const roots = chosenRoots.value
  if (phase.value !== 'choosing' || roots.length === 0) return
  phase.value = 'adding'
  try {
    results.value = await addRecommendedToRoots(api, roots, props.kinds, {
      signal: controller.signal,
      onRoot: (root) => {
        addingRoot.value = root
      },
    })
  } catch {
    return
  }
  await changesIndex?.reload(...roots)
  emit('added')
  phase.value = 'done'
  await nextTick()
  closeButton.value?.focus()
}

function close(): void {
  const wasAdding = phase.value === 'adding'
  controller.abort()
  if (wasAdding) emit('added')
  emit('close')
}

function followReview(event: MouseEvent, root: string): void {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  event.preventDefault()
  emit('review', root)
}

onMounted(() => dialog.value?.showModal())
onBeforeUnmount(() => {
  controller.abort()
  dialog.value?.close()
})
</script>

<template>
  <dialog ref="dialog" class="add-fixes" :aria-labelledby="titleId" @cancel.prevent="close">
    <form class="add-fixes__form" @submit.prevent="addFixes">
      <h2 :id="titleId" class="add-fixes__title">{{ ADD_RECOMMENDED_TITLE }}</h2>
      <p class="add-fixes__intro">{{ ADD_RECOMMENDED_INTRO }}</p>
      <fieldset class="add-fixes__roots" :disabled="phase !== 'choosing'">
        <legend class="add-fixes__legend">{{ ADD_RECOMMENDED_ROOTS }}</legend>
        <label v-for="entry in roots" :key="entry.root" class="add-fixes__root">
          <input type="checkbox" :checked="checkedRoots.has(entry.root)" @change="setChecked(entry.root, ($event.target as HTMLInputElement).checked)" />
          <span>{{ vulnerableRootText(entry.root, entry.count) }}</span>
        </label>
      </fieldset>
      <p class="add-fixes__status" role="status">{{ statusText }}</p>
      <div v-if="failureTexts.length > 0" class="add-fixes__failures" role="alert">
        <p v-for="failure in failureTexts" :key="failure" class="add-fixes__failure">{{ failure }}</p>
      </div>
      <div class="add-fixes__buttons">
        <template v-if="phase === 'done'">
          <a v-if="reviewRoot !== undefined" class="add-fixes__review" :href="changesHref(reviewRoot)" @click="followReview($event, reviewRoot)">{{
            REVIEW_CHANGES
          }}</a>
          <button ref="closeButton" type="button" class="button button--primary" @click="close">{{ CLOSE }}</button>
        </template>
        <template v-else>
          <button type="button" class="button" @click="close">{{ CANCEL }}</button>
          <button
            type="submit"
            class="button button--primary"
            :disabled="phase === 'choosing' && chosenRoots.length === 0"
            :aria-disabled="phase === 'adding' ? 'true' : undefined"
          >
            {{ ADD_FIXES }}
          </button>
        </template>
      </div>
    </form>
  </dialog>
</template>

<style scoped>
.add-fixes {
  width: min(520px, calc(100vw - 32px));
  padding: 0;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  background: var(--surface-raised);
  color: var(--text);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.18);
}

.add-fixes::backdrop {
  background: rgba(15, 18, 22, 0.45);
}

.add-fixes__form {
  display: grid;
  gap: 12px;
  padding: 18px 20px 16px;
}

.add-fixes__form p {
  margin: 0;
}

.add-fixes__title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.add-fixes__roots {
  display: grid;
  gap: 6px;
  margin: 0;
  padding: 0;
  border: 0;
}

.add-fixes__legend {
  margin-bottom: 4px;
  padding: 0;
  font-weight: 600;
}

.add-fixes__root {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}

.add-fixes__root input {
  margin: 0;
  accent-color: var(--accent);
}

.add-fixes__roots:disabled .add-fixes__root {
  cursor: default;
}

.add-fixes__status {
  overflow-wrap: anywhere;
}

.add-fixes__failures {
  display: grid;
  gap: 4px;
  color: var(--danger);
  overflow-wrap: anywhere;
}

.add-fixes__buttons {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  margin-top: 4px;
}

.add-fixes__buttons .button {
  height: 32px;
}

.add-fixes__review {
  color: var(--accent);
}
</style>
