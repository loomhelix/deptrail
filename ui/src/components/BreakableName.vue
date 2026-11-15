<script setup lang="ts">
import { computed } from 'vue'
import { nameSegments } from '../labels.ts'

const props = defineProps<{ name: string; version?: string }>()

const segments = computed(() => nameSegments(props.name))
</script>

<template>
  <template v-for="(segment, position) in segments" :key="position">{{ segment }}<wbr v-if="position < segments.length - 1" /></template
  ><template v-if="version">{{ ' ' }}{{ version }}</template>
</template>
