<script setup lang="ts">
import { computed } from 'vue'
import type { ViaLabels } from '../issues-model.ts'
import { moreCountText } from '../vocabulary.ts'
import BreakableName from './BreakableName.vue'
import WorkspaceName from './WorkspaceName.vue'

const props = defineProps<{ via: ViaLabels; prefix: string; id?: string }>()

const SEPARATOR = ','

const hasNames = computed(() => props.via.shown.length > 0 || props.via.more > 0)
const lastShown = computed(() => props.via.shown.length - 1)
const title = computed(() => (props.via.more > 0 ? props.via.all.map((entry) => entry.name).join(`${SEPARATOR} `) : undefined))
</script>

<template>
  <span v-if="hasNames" :id="id" class="via-list" data-testid="via-list" :title="title"
    ><span v-if="via.shown.length === 0" class="via-list__prefix muted">{{ prefix }}</span
    ><template v-for="(entry, position) in via.shown" :key="entry.name"
      ><span class="via-list__item"
        ><template v-if="position === 0"><span class="via-list__prefix muted">{{ prefix }}</span>{{ ' ' }}</template
        ><WorkspaceName v-if="entry.workspace" :name="entry.name" /><span v-else class="via-list__name mono"><BreakableName :name="entry.name" /></span
        ><template v-if="position < lastShown">{{ SEPARATOR }}</template></span
      >{{ position < lastShown ? ' ' : '' }}</template
    ><template v-if="via.more > 0">{{ ' ' }}<span class="via-list__more muted">{{ moreCountText(via.more) }}</span></template></span
  >
</template>

<style scoped>
.via-list__item {
  display: inline-block;
  max-width: 100%;
  overflow-wrap: anywhere;
}

.via-list__more {
  white-space: nowrap;
}
</style>
