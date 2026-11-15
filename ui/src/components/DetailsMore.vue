<script setup lang="ts">
import { computed } from 'vue'
import type { PackageInsight } from '../../../src/query/package-insight.ts'
import { npmPackageUrl } from '../labels.ts'
import { MORE, NPM } from '../vocabulary.ts'
import { detailsMoreFacts } from '../why-here.ts'
import AppIcon from './AppIcon.vue'

const props = defineProps<{ name: string; insight: PackageInsight | null; isDirect: boolean; now: number }>()

const facts = computed(() => detailsMoreFacts(props.insight, props.isDirect, props.now))
</script>

<template>
  <details class="details-more" data-testid="details-more">
    <summary class="details-more__summary"><AppIcon class="summary-chevron" name="chevron-right" :size="18" />{{ MORE }}</summary>
    <div class="details-more__body">
      <p v-if="facts.latest !== undefined">{{ facts.latest }}</p>
      <p v-for="check in facts.checks" :key="check" class="details-more__check">{{ check }}</p>
      <p v-for="note in facts.notes" :key="note">{{ note }}</p>
      <p class="details-more__links">
        <a :href="npmPackageUrl(name)" target="_blank" rel="noopener noreferrer">{{ NPM }}</a>
      </p>
    </div>
  </details>
</template>

<style scoped>
.details-more {
  padding: 6px 16px;
  border-bottom: 1px solid var(--border);
}

.details-more__summary {
  min-height: 32px;
  padding: 5px 0;
  font-weight: 600;
  cursor: pointer;
}

.details-more__body {
  display: grid;
  gap: 6px;
  padding: 4px 0 8px;
}

.details-more__body p {
  margin: 0;
  overflow-wrap: anywhere;
}

.details-more__check {
  color: var(--text-muted);
}

.details-more__links {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
}

.details-more__links a {
  color: var(--accent);
}
</style>
