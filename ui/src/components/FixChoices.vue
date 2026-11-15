<script setup lang="ts">
import { ref, useId } from 'vue'
import type { FixActions, FixChoice } from '../../../src/actions/types.ts'
import { rootLabel } from '../labels.ts'
import { fixOptionTitle, goalHeading, RECOMMENDED, stepText, unavailableOptionNote } from '../vocabulary.ts'

defineProps<{
  fix: FixActions
  root: string
}>()

const selected = defineModel<FixChoice | null>({ required: true })

const elementId = useId()
const choices = ref<HTMLElement | null>(null)

function focusSelected(): boolean {
  const radio = choices.value?.querySelector<HTMLInputElement>('input[type="radio"]:checked')
  if (!radio) return false
  radio.focus()
  return true
}

defineExpose({ focusSelected })
</script>

<template>
  <div class="fix-choices">
    <p :id="`${elementId}-goal`" class="fix-choices__goal">{{ goalHeading(fix.goal, rootLabel(root)) }}</p>
    <div v-if="fix.options.length > 0" ref="choices" class="fix-choices__options" role="radiogroup" :aria-labelledby="`${elementId}-goal`">
      <div
        v-for="option in fix.options"
        :key="option.choice"
        class="choice"
        :class="{ 'choice--selected': selected === option.choice }"
        data-testid="fix-option"
        @click="selected = option.choice"
      >
        <div class="choice__head">
          <label class="choice__label">
            <input v-model="selected" type="radio" :name="`${elementId}-fix`" :value="option.choice" />
            {{ fixOptionTitle(option, fix.goal) }}
          </label>
          <span v-if="option.recommended" class="badge badge--ok">{{ RECOMMENDED }}</span>
        </div>
        <ul class="choice__steps">
          <li v-for="(step, position) in option.steps" :key="position" class="choice__step">
            <span>{{ stepText(step) }}</span>
            <span class="choice__reason">{{ step.reason }}</span>
          </li>
        </ul>
        <ul v-if="option.warnings.length > 0" class="choice__warnings">
          <li v-for="warning in option.warnings" :key="warning" class="choice__warning">{{ warning }}</li>
        </ul>
      </div>
    </div>
    <p v-for="entry in fix.unavailable" :key="entry.choice" class="fix-choices__note muted">
      {{ unavailableOptionNote(entry.choice, entry.reason) }}
    </p>
    <p v-if="fix.options.length === 0 && fix.reason" class="fix-choices__note muted">{{ fix.reason }}</p>
  </div>
</template>

<style scoped>
.fix-choices {
  display: grid;
  gap: 8px;
}

.fix-choices p {
  margin: 0;
}

.fix-choices__goal {
  color: var(--text-muted);
  overflow-wrap: anywhere;
}

.fix-choices__options {
  display: grid;
  gap: 8px;
}

.fix-choices__note {
  overflow-wrap: anywhere;
}

.choice {
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-raised);
  cursor: pointer;
}

.choice--selected {
  border-color: var(--accent);
  box-shadow: inset 3px 0 0 var(--accent);
}

.choice__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
}

.choice__label {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  cursor: pointer;
}

.choice__label input {
  margin: 0;
  accent-color: var(--accent);
}

.choice__steps {
  margin: 4px 0 0;
  padding-left: 40px;
}

.choice__step {
  margin: 4px 0 0;
  overflow-wrap: anywhere;
}

.choice__step > span {
  display: block;
}

.choice__reason {
  color: var(--text-faint);
  font-size: 13px;
}

.choice__warnings {
  margin: 6px 0 0;
  padding: 0 0 0 22px;
  list-style: none;
}

.choice__warning {
  color: var(--badge-warn-fg);
  font-size: 13px;
  font-weight: 500;
  overflow-wrap: anywhere;
}
</style>
