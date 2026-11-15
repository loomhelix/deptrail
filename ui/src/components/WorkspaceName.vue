<script setup lang="ts">
import BreakableName from './BreakableName.vue'

defineProps<{ name: string }>()
</script>

<template>
  <span class="workspace-name mono" data-testid="workspace-name"><BreakableName :name="name" /></span>
</template>

<style scoped>
.workspace-name {
  display: inline-block;
  max-width: 100%;
  padding: 0 4px;
  border: 1px solid var(--workspace-border);
  border-radius: var(--radius);
  background: var(--workspace-bg);
  color: var(--workspace-fg);
  overflow-wrap: anywhere;
}
</style>
