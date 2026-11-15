<script setup lang="ts">
import { rootNoteId, type RootNote } from '../issues-model.ts'

defineProps<{
  notes: readonly RootNote[]
  idPrefix: string
}>()
</script>

<template>
  <ul v-if="notes.length > 0" class="root-notes" data-testid="root-notes">
    <li v-for="note in notes" :id="rootNoteId(idPrefix, note.rootId)" :key="note.rootId" class="root-notes__line">{{ note.text }}</li>
  </ul>
</template>

<style scoped>
.root-notes {
  margin: 0;
  padding: 8px 14px;
  list-style: none;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}

.root-notes__line {
  color: var(--text-muted);
  overflow-wrap: anywhere;
}
</style>
