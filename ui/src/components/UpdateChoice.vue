<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import { importerLabel } from '../../../src/actions/labels.ts'
import type { UpdateActions } from '../../../src/actions/types.ts'
import type { NodeId } from '../../../src/model.ts'
import { importerChangeText, newerVersions, selectableVersions, updateChoiceFor, updateWarnings, versionLabel } from '../update-choice.ts'
import { SHOW_PRERELEASES, updateHeading, VERSION, WORKSPACE_PACKAGES } from '../vocabulary.ts'
import WorkspaceName from './WorkspaceName.vue'

const props = defineProps<{
  update: UpdateActions
  root: string
}>()

const version = defineModel<string>('version', { required: true })
const importers = defineModel<NodeId[]>('importers', { required: true })
const showPrereleases = defineModel<boolean>('showPrereleases', { required: true })

const elementId = useId()
const versionSelect = ref<HTMLSelectElement | null>(null)

const hasNewerPrereleases = computed(() => newerVersions(props.update).some((entry) => entry.prerelease))
const listedVersions = computed(() => {
  const selectable = selectableVersions(props.update, showPrereleases.value)
  const currentEntry = props.update.versions.find((entry) => entry.version === props.update.current)
  return currentEntry ? [...selectable, currentEntry] : selectable
})
const relocksOnly = computed(() => version.value !== '' && updateChoiceFor(props.update, version.value) === 'wanted')
const warnings = computed(() => (version.value === '' ? [] : updateWarnings(props.update, version.value, importers.value)))

function focusVersion(): boolean {
  if (!versionSelect.value) return false
  versionSelect.value.focus()
  return true
}

defineExpose({ focusVersion })
</script>

<template>
  <div class="update-choice">
    <p class="update-choice__goal">{{ updateHeading(update.name, root) }}</p>
    <div class="update-choice__field">
      <label class="update-choice__label" :for="`${elementId}-version`">{{ VERSION }}</label>
      <select :id="`${elementId}-version`" ref="versionSelect" v-model="version" class="update-choice__select">
        <option v-for="entry in listedVersions" :key="entry.version" :value="entry.version" :disabled="entry.version === update.current">
          {{ versionLabel(entry, update) }}
        </option>
      </select>
    </div>
    <label v-if="hasNewerPrereleases" class="update-choice__toggle">
      <input v-model="showPrereleases" type="checkbox" />
      {{ SHOW_PRERELEASES }}
    </label>
    <fieldset class="update-choice__importers">
      <legend class="update-choice__label">{{ WORKSPACE_PACKAGES }}</legend>
      <label
        v-for="importer in update.importers"
        :key="importer.id"
        class="importer"
        :class="{ 'importer--disabled': relocksOnly || !importer.editable }"
        data-testid="update-importer"
      >
        <input v-if="relocksOnly" type="checkbox" disabled />
        <input v-else v-model="importers" type="checkbox" :value="importer.id" :disabled="!importer.editable" />
        <span class="importer__name"><WorkspaceName :name="importerLabel(importer.id)" /></span>
        <template v-if="relocksOnly">
          <span class="mono">{{ importer.specifier }}</span>
          <span class="importer__reason">{{ importerChangeText(importer, version, true) }}</span>
        </template>
        <span v-else-if="importer.editable && version !== ''" class="mono">{{ importerChangeText(importer, version, false) }}</span>
        <template v-else>
          <span class="mono">{{ importer.specifier }}</span>
          <span v-if="!importer.editable" class="importer__reason">{{ importer.reason }}</span>
        </template>
      </label>
    </fieldset>
    <ul v-if="warnings.length > 0" class="update-choice__warnings">
      <li v-for="warning in warnings" :key="warning" class="update-choice__warning" data-testid="update-warning">{{ warning }}</li>
    </ul>
  </div>
</template>

<style scoped>
.update-choice {
  display: grid;
  gap: 8px;
}

.update-choice p {
  margin: 0;
}

.update-choice__goal {
  color: var(--text-muted);
  overflow-wrap: anywhere;
}

.update-choice__field {
  display: flex;
  align-items: center;
  gap: 10px;
}

.update-choice__label {
  color: var(--text);
  font-size: 13px;
  font-weight: 600;
}

.update-choice__select {
  flex: 1;
  min-width: 0;
  max-width: 280px;
  height: 32px;
  padding: 0 8px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  background: var(--surface-raised);
  color: var(--text);
  font-family: var(--font-mono);
  font-size: 13px;
}

.update-choice__toggle {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  justify-self: start;
  color: var(--text-muted);
  cursor: pointer;
}

.update-choice__toggle input,
.importer input {
  margin: 0;
  accent-color: var(--accent);
}

.update-choice__importers {
  display: grid;
  gap: 4px;
  min-width: 0;
  margin: 4px 0 0;
  padding: 0;
  border: 0;
}

.update-choice__importers legend {
  margin-bottom: 4px;
  padding: 0;
}

.importer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 8px;
  cursor: pointer;
  overflow-wrap: anywhere;
}

.importer--disabled {
  cursor: default;
}

.importer__name {
  font-weight: 500;
}

.importer__reason {
  color: var(--text-faint);
  font-size: 13px;
}

.update-choice__warnings {
  margin: 0;
  padding: 0;
  list-style: none;
}

.update-choice__warning {
  color: var(--badge-warn-fg);
  font-size: 13px;
  font-weight: 500;
  overflow-wrap: anywhere;
}
</style>
