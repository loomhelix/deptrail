<script setup lang="ts">
import { computed } from 'vue'
import type { Selection } from '../context.ts'
import { nodeIdLabel } from '../labels.ts'
import { CLEAR_SELECTION, SELECTED, selectionPillText } from '../vocabulary.ts'
import AppIcon from './AppIcon.vue'

const props = defineProps<{ selection: Selection }>()

const emit = defineEmits<{ clear: [] }>()

const text = computed(() => selectionPillText(nodeIdLabel(props.selection.node), props.selection.root))
</script>

<template>
  <div class="selection-pill" role="group" :aria-label="SELECTED">
    <span class="selection-pill__text" :title="text">{{ text }}</span>
    <button type="button" class="selection-pill__clear" :aria-label="CLEAR_SELECTION" :title="CLEAR_SELECTION" @click="emit('clear')">
      <AppIcon name="x" :size="18" />
    </button>
  </div>
</template>

<style scoped>
.selection-pill {
  display: inline-flex;
  flex: 0 1 auto;
  align-items: center;
  gap: 2px;
  min-width: 0;
  max-width: min(440px, 100%);
  height: 32px;
  padding: 0 2px 0 12px;
  border: 1px solid var(--accent);
  border-radius: 16px;
  background: var(--surface-selected);
  color: var(--text);
}

.selection-pill__text {
  min-width: 0;
  overflow: hidden;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.selection-pill__clear {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: none;
  color: inherit;
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
}

.selection-pill__clear:hover {
  background: var(--surface-hover);
}
</style>
