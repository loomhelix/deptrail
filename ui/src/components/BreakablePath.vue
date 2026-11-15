<script setup lang="ts">
import { computed } from 'vue'
import { pathWords } from '../labels.ts'

const props = defineProps<{ text: string }>()

const words = computed(() => pathWords(props.text))
</script>

<template>
  <template v-for="(segments, wordIndex) in words" :key="wordIndex"
    ><template v-if="wordIndex > 0">{{ ' ' }}</template
    ><template v-for="(segment, position) in segments" :key="position"><span class="breakable-path__segment">{{ segment }}</span><wbr /></template
  ></template>
</template>

<style scoped>
.breakable-path__segment {
  white-space: nowrap;
}
</style>
