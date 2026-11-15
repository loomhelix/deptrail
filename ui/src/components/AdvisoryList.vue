<script setup lang="ts">
import { computed, useId } from 'vue'
import type { InsightAdvisory } from '../../../src/query/package-insight.ts'
import { severityTone, type BadgeTone } from '../badges.ts'
import { advisoriesHeading, DEPRECATED, deprecationMessageText, fixedInText, LIST_SEPARATOR, MALICIOUS } from '../vocabulary.ts'

const props = defineProps<{ advisories: readonly InsightAdvisory[]; deprecated?: string }>()

const headingId = useId()
const hasContent = computed(() => props.advisories.length > 0 || props.deprecated !== undefined)
const heading = computed(() => advisoriesHeading(props.advisories.length, props.deprecated !== undefined))

function toneOf(advisory: InsightAdvisory): BadgeTone {
  return advisory.malicious ? 'danger' : severityTone(advisory.severity)
}
</script>

<template>
  <section v-if="hasContent" class="advisory-list" :aria-labelledby="headingId">
    <h3 :id="headingId" class="panel-heading">{{ heading }}</h3>
    <article v-for="advisory in advisories" :key="advisory.id" class="advisory" data-testid="advisory">
      <p class="advisory__head">
        <span class="badge" :class="`badge--${toneOf(advisory)}`">{{ advisory.malicious ? MALICIOUS : advisory.severity }}</span>
        <a class="advisory__id mono" :href="advisory.url" target="_blank" rel="noopener noreferrer">{{ advisory.id }}</a>
        <span v-if="advisory.aliases.length > 0" class="advisory__aliases">{{ advisory.aliases.join(LIST_SEPARATOR) }}</span>
      </p>
      <p v-if="advisory.summary" class="advisory__summary">{{ advisory.summary }}</p>
      <p v-if="advisory.fixedIn.length > 0" class="advisory__fixed">{{ fixedInText(advisory.fixedIn) }}</p>
    </article>
    <article v-if="deprecated !== undefined" class="advisory" data-testid="deprecation">
      <p class="advisory__head"><span class="badge badge--warn">{{ DEPRECATED }}</span></p>
      <p class="advisory__summary">{{ deprecationMessageText(deprecated) }}</p>
    </article>
  </section>
</template>

<style scoped>
.advisory-list {
  display: grid;
  gap: 8px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
}

.advisory {
  display: grid;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-raised);
}

.advisory p {
  margin: 0;
  overflow-wrap: anywhere;
}

.advisory__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
}

.advisory__id {
  color: var(--accent);
}

.advisory__aliases,
.advisory__fixed {
  color: var(--text-muted);
  font-size: 13px;
}
</style>
