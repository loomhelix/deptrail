<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useId } from 'vue'
import type { Goal, Preview } from '../../../src/actions/types.ts'
import { APPLY, applyTitle, CANCEL, installCommand, installNote, outsideInstallNote, previewGoalLine, RUN_INSTALL, unmetGoalsHeading, writesSentence } from '../vocabulary.ts'

const props = defineProps<{
  preview: Preview
  rootName: string
  installByDefault: boolean
  goals: ReadonlyMap<string, Goal>
}>()

const emit = defineEmits<{ cancel: []; apply: [install: boolean] }>()

const elementId = useId()
const dialog = ref<HTMLDialogElement | null>(null)
const install = ref(props.installByDefault)

const unmetLines = computed(() =>
  props.preview.goals.filter((goal) => !goal.met).map((goal) => previewGoalLine(goal, props.goals.get(goal.itemId))),
)

const describedBy = computed(() =>
  props.preview.outsidePackages ? `${elementId}-note ${elementId}-outside` : `${elementId}-note`,
)

onMounted(() => dialog.value?.showModal())
onBeforeUnmount(() => dialog.value?.close())
</script>

<template>
  <dialog ref="dialog" class="apply" :aria-labelledby="`${elementId}-title`" @cancel.prevent="emit('cancel')">
    <form class="apply__form" @submit.prevent="emit('apply', install)">
      <h2 :id="`${elementId}-title`" class="apply__title">{{ applyTitle(preview.goals.length, rootName) }}</h2>
      <div v-if="unmetLines.length > 0" class="apply__unmet" data-testid="apply-unmet">
        <p class="apply__unmet-heading">{{ unmetGoalsHeading(unmetLines.length) }}</p>
        <ul class="apply__unmet-lines">
          <li v-for="(line, position) in unmetLines" :key="position">{{ line }}</li>
        </ul>
      </div>
      <p class="apply__writes">{{ writesSentence(preview.files) }}</p>
      <div class="apply__install">
        <label class="apply__install-label">
          <input v-model="install" type="checkbox" :aria-describedby="describedBy" />
          <span>{{ RUN_INSTALL }} <span class="mono">{{ installCommand(preview.manager.name) }}</span></span>
        </label>
        <p :id="`${elementId}-note`" class="apply__note">{{ installNote(preview.manager.name) }}</p>
        <p v-if="preview.outsidePackages" :id="`${elementId}-outside`" class="apply__note">{{ outsideInstallNote(preview.outsidePackages) }}</p>
      </div>
      <div class="apply__buttons">
        <button type="button" class="button apply__button" autofocus @click="emit('cancel')">{{ CANCEL }}</button>
        <button type="submit" class="button button--primary apply__button">{{ APPLY }}</button>
      </div>
    </form>
  </dialog>
</template>

<style scoped>
.apply {
  width: min(560px, calc(100vw - 32px));
  padding: 0;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  background: var(--surface-raised);
  color: var(--text);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.18);
}

.apply::backdrop {
  background: rgba(15, 18, 22, 0.45);
}

.apply__form {
  display: grid;
  gap: 12px;
  padding: 18px 20px 16px;
}

.apply__form p {
  margin: 0;
}

.apply__title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.apply__unmet {
  display: grid;
  gap: 4px;
  padding: 8px 10px;
  border-radius: var(--radius);
  background: var(--badge-danger-bg);
  color: var(--badge-danger-fg);
}

.apply__unmet-heading {
  font-weight: 600;
}

.apply__unmet-lines {
  margin: 0;
  padding-left: 18px;
  overflow-wrap: anywhere;
}

.apply__writes {
  overflow-wrap: anywhere;
}

.apply__install {
  display: grid;
  gap: 2px;
}

.apply__install-label {
  display: flex;
  align-items: baseline;
  gap: 8px;
  cursor: pointer;
}

.apply__install-label input {
  margin: 0;
  accent-color: var(--accent);
  transform: translateY(2px);
}

.apply__note {
  padding-left: 21px;
  color: var(--text-faint);
  font-size: 13px;
}

.apply__buttons {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}

.apply__button {
  height: 32px;
}
</style>
