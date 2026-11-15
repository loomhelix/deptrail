<script setup lang="ts">
import { useId } from 'vue'
import type { NodeId } from '../../../src/model.ts'
import { DEPENDENTS, moreCountText, NO_DEPENDENTS, OPEN_IN_EXPLORE, whyHereDetailText } from '../vocabulary.ts'
import type { WhyHereRow } from '../why-here.ts'

defineProps<{ rows: readonly WhyHereRow[]; more: number }>()

const emit = defineEmits<{ select: [node: NodeId]; 'open-trail': [] }>()

const headingId = useId()
</script>

<template>
  <section class="why-here" :aria-labelledby="headingId">
    <h3 :id="headingId" class="panel-heading">{{ DEPENDENTS }}</h3>
    <p v-if="rows.length === 0" class="why-here__empty">{{ NO_DEPENDENTS }}</p>
    <ul v-else class="why-here__rows">
      <li v-for="(row, position) in rows" :key="`${position}\n${row.parent}`" class="why-here__row" data-testid="why-here-row">
        <button type="button" class="why-here__parent mono" @click="emit('select', row.parent)">{{ row.parentLabel }}</button>
        {{ whyHereDetailText(row.range, row.direct, row.from) }}
      </li>
    </ul>
    <p v-if="more > 0" class="why-here__more">{{ moreCountText(more) }}</p>
    <p class="why-here__actions">
      <button type="button" class="button why-here__trail" @click="emit('open-trail')">{{ OPEN_IN_EXPLORE }}</button>
    </p>
  </section>
</template>

<style scoped>
.why-here {
  display: grid;
  gap: 8px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
}

.why-here p {
  margin: 0;
}

.why-here__empty,
.why-here__more {
  color: var(--text-muted);
}

.why-here__rows {
  display: grid;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.why-here__row {
  min-height: 28px;
  padding: 3px 0;
  overflow-wrap: anywhere;
}

.why-here__parent {
  display: inline;
  padding: 0;
  border: 0;
  background: none;
  color: var(--accent);
  text-align: left;
  cursor: pointer;
}

.why-here__parent:hover {
  text-decoration: underline;
}

.why-here__trail {
  height: 32px;
}
</style>
