<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, useId } from 'vue'
import { CLOSE, KEYBOARD_SHORTCUTS, SHORTCUT_ACTION_HEADING, SHORTCUT_KEY_HEADING, SHORTCUT_KEY_SEPARATOR, SHORTCUT_ROWS } from '../vocabulary.ts'

const emit = defineEmits<{ close: [] }>()

const elementId = useId()
const titleId = `${elementId}-title`
const dialog = ref<HTMLDialogElement | null>(null)

function keysOf(keys: string): string[] {
  return keys.split(SHORTCUT_KEY_SEPARATOR)
}

onMounted(() => dialog.value?.showModal())
onBeforeUnmount(() => dialog.value?.close())
</script>

<template>
  <dialog ref="dialog" class="shortcuts" :aria-labelledby="titleId" @cancel.prevent="emit('close')">
    <div class="shortcuts__body">
      <h2 :id="titleId" class="shortcuts__title">{{ KEYBOARD_SHORTCUTS }}</h2>
      <table class="shortcuts__table" :aria-labelledby="titleId">
        <thead>
          <tr>
            <th scope="col">{{ SHORTCUT_KEY_HEADING }}</th>
            <th scope="col">{{ SHORTCUT_ACTION_HEADING }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in SHORTCUT_ROWS" :key="row.keys">
            <td class="shortcuts__keys">
              <template v-for="(key, position) in keysOf(row.keys)" :key="key"
                ><span v-if="position > 0">{{ SHORTCUT_KEY_SEPARATOR }}</span><kbd class="shortcuts__key">{{ key }}</kbd></template
              >
            </td>
            <td>{{ row.action }}</td>
          </tr>
        </tbody>
      </table>
      <div class="shortcuts__buttons">
        <button type="button" class="button shortcuts__close" autofocus @click="emit('close')">{{ CLOSE }}</button>
      </div>
    </div>
  </dialog>
</template>

<style scoped>
.shortcuts {
  width: min(520px, calc(100vw - 32px));
  padding: 0;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  background: var(--surface-raised);
  color: var(--text);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.18);
}

.shortcuts::backdrop {
  background: rgba(15, 18, 22, 0.45);
}

.shortcuts__body {
  display: grid;
  gap: 12px;
  padding: 18px 20px 16px;
}

.shortcuts__title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.shortcuts__table {
  width: 100%;
  border-collapse: collapse;
}

.shortcuts__table th {
  padding: 4px 12px 6px 0;
  border-bottom: 1px solid var(--border-strong);
  color: var(--text-muted);
  font-weight: 600;
  text-align: left;
}

.shortcuts__table td {
  padding: 6px 12px 6px 0;
  border-bottom: 1px solid var(--border);
  vertical-align: baseline;
}

.shortcuts__keys {
  white-space: nowrap;
}

.shortcuts__key {
  display: inline-block;
  min-width: 24px;
  padding: 0 6px;
  border: 1px solid var(--border-strong);
  border-radius: 3px;
  background: var(--surface-panel);
  font: 13px/22px var(--font-mono);
  text-align: center;
}

.shortcuts__buttons {
  display: flex;
  justify-content: flex-end;
}

.shortcuts__close {
  height: 32px;
}
</style>
