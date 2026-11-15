<script setup lang="ts">
import { computed, useId } from 'vue'
import { goalText } from '../../../src/actions/labels.ts'
import type { ChangeItem } from '../../../src/actions/types.ts'
import { changesInRootHeading, moreCountText, REVIEW_CHANGES } from '../vocabulary.ts'

const props = defineProps<{ root: string; items: readonly ChangeItem[]; href: string }>()

const emit = defineEmits<{ review: [] }>()

const SHOWN_ITEMS = 5

const headingId = useId()
const shownItems = computed(() => props.items.slice(0, SHOWN_ITEMS))
const hiddenCount = computed(() => props.items.length - shownItems.value.length)

function review(event: MouseEvent): void {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  event.preventDefault()
  emit('review')
}
</script>

<template>
  <section class="change-goals" :aria-labelledby="headingId">
    <h3 :id="headingId" class="panel-heading">{{ changesInRootHeading(root) }}</h3>
    <ul class="change-goals__items">
      <li v-for="item in shownItems" :key="item.id" class="change-goals__item">{{ goalText(item.goal) }}</li>
    </ul>
    <p v-if="hiddenCount > 0" class="change-goals__more">{{ moreCountText(hiddenCount) }}</p>
    <p><a class="change-goals__review" :href="href" @click="review">{{ REVIEW_CHANGES }}</a></p>
  </section>
</template>

<style scoped>
.change-goals {
  display: grid;
  gap: 8px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
}

.change-goals p {
  margin: 0;
}

.change-goals__items {
  display: grid;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.change-goals__item {
  overflow-wrap: anywhere;
}

.change-goals__more {
  color: var(--text-muted);
}

.change-goals__review {
  color: var(--accent);
}
</style>
