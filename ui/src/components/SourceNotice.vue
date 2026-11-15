<script setup lang="ts">
import type { ShownSource } from '../source.ts'
import { BACK_TO_WORKING_TREE, commitNoticeText } from '../vocabulary.ts'
import AppIcon from './AppIcon.vue'

defineProps<{ source: Extract<ShownSource, { kind: 'commit' }> }>()

const emit = defineEmits<{ back: [] }>()

const now = Date.now()
</script>

<template>
  <div class="source-notice">
    <AppIcon class="source-notice__icon" name="git-branch" />
    <p class="source-notice__text">{{ commitNoticeText(source, now) }}</p>
    <button type="button" class="button source-notice__back" @click="emit('back')">{{ BACK_TO_WORKING_TREE }}</button>
  </div>
</template>

<style scoped>
.source-notice {
  display: flex;
  flex: none;
  align-items: center;
  gap: 10px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--source-commit-border);
  border-left: 4px solid var(--source-commit-border);
  background: var(--source-commit-bg);
  color: var(--source-commit-fg);
}

.source-notice__icon {
  flex: none;
}

.source-notice__text {
  flex: 1;
  min-width: 0;
  margin: 0;
  white-space: normal;
}

.source-notice__back {
  flex: none;
}
</style>
