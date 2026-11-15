<script setup lang="ts">
import type { Badge } from '../badges.ts'

defineProps<{ badges: readonly Badge[] }>()
</script>

<template>
  <span
    v-for="badge in badges"
    :key="badge.key"
    class="badge"
    :class="[`badge--${badge.tone}`, { 'badge--outline': badge.outlined }]"
    :title="badge.title"
    data-testid="node-badge"
  >
    {{ badge.label }}
  </span>
</template>
