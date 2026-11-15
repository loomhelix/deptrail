<script setup lang="ts">
import { computed, ref } from 'vue'
import type { NodeId } from '../../../src/model.ts'
import type { RiskChange, RootComparison } from '../../../src/query/compare-shape.ts'
import { COMPARE_ROW_LIMIT, compareNoteText, presenceText, type SideLabels } from '../compare-model.ts'
import { rootLabel } from '../labels.ts'
import {
  CHANGE_COLUMN,
  DEPENDENCY_COLUMN,
  DEPRECATED_ISSUE,
  DIRECTS_HEADING,
  ISSUE_COLUMN,
  PACKAGE_COLUMN,
  RISK_HEADING,
  riskPendingText,
  showAllText,
  TYPE_COLUMN,
  VERSIONS_HEADING,
  vulnerableIssueText,
  WORKSPACE_PACKAGE_COLUMN,
  workspacePackageChangeText,
} from '../vocabulary.ts'
import BreakableName from './BreakableName.vue'

const props = defineProps<{ root: RootComparison; labels: SideLabels }>()

const emit = defineEmits<{ select: [node: NodeId] }>()

const showsAllVersions = ref(false)
const showsAllDirects = ref(false)

const presence = computed(() => presenceText(props.root.presence, props.labels))
const shownVersions = computed(() => (showsAllVersions.value ? props.root.versions : props.root.versions.slice(0, COMPARE_ROW_LIMIT)))
const shownDirects = computed(() => (showsAllDirects.value ? props.root.directs : props.root.directs.slice(0, COMPARE_ROW_LIMIT)))

function issueText(risk: RiskChange): string {
  return risk.issue === 'deprecated' ? DEPRECATED_ISSUE : vulnerableIssueText(risk.severity ?? 'unknown')
}

function versionsText(versions: readonly string[]): string {
  return versions.length === 0 ? '—' : versions.join(', ')
}
</script>

<template>
  <section class="compare-root">
    <h3 class="compare-root__title">
      <span class="mono">{{ rootLabel(root.rootId) }}</span>
      <span v-if="presence" class="badge badge--info">{{ presence }}</span>
    </h3>
    <p v-for="(note, position) in root.notes" :key="position" class="compare-root__note">{{ compareNoteText(note, labels) }}</p>
    <p v-for="importer in root.importers" :key="`${importer.change}:${importer.path}`" class="compare-root__note">
      {{ workspacePackageChangeText(importer.change, importer.name, importer.path) }}
    </p>
    <p v-if="root.riskPending > 0" class="compare-root__note muted">{{ riskPendingText(root.riskPending) }}</p>

    <template v-if="root.risk.length > 0">
      <h4 class="compare-root__heading">{{ RISK_HEADING }}</h4>
      <table class="compare-table">
        <colgroup>
          <col class="compare-table__col-name" />
          <col />
          <col class="compare-table__narrow" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">{{ PACKAGE_COLUMN }}</th>
            <th scope="col">{{ ISSUE_COLUMN }}</th>
            <th scope="col">{{ CHANGE_COLUMN }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="risk in root.risk" :key="`${risk.issue}:${risk.change}:${risk.name}@${risk.version}`">
            <td>
              <button v-if="risk.targetNode" type="button" class="compare-table__link mono" @click="emit('select', risk.targetNode)">
                <BreakableName :name="risk.name" :version="risk.version" />
              </button>
              <span v-else class="mono"><BreakableName :name="risk.name" :version="risk.version" /></span>
            </td>
            <td>{{ issueText(risk) }}</td>
            <td>
              <span class="badge" :class="risk.change === 'introduced' ? 'badge--danger' : 'badge--ok'">{{ risk.change }}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </template>

    <template v-if="root.directs.length > 0">
      <h4 class="compare-root__heading">{{ DIRECTS_HEADING }}</h4>
      <table class="compare-table">
        <thead>
          <tr>
            <th scope="col">{{ WORKSPACE_PACKAGE_COLUMN }}</th>
            <th scope="col">{{ DEPENDENCY_COLUMN }}</th>
            <th scope="col" class="compare-table__narrow">{{ TYPE_COLUMN }}</th>
            <th scope="col">{{ labels.base }}</th>
            <th scope="col">{{ labels.target }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="direct in shownDirects" :key="`${direct.importer}:${direct.name}:${direct.kind}`">
            <td class="mono"><BreakableName :name="direct.importerName" /></td>
            <td>
              <button v-if="direct.targetNode" type="button" class="compare-table__link mono" @click="emit('select', direct.targetNode)">
                <BreakableName :name="direct.name" />
              </button>
              <span v-else class="mono"><BreakableName :name="direct.name" /></span>
            </td>
            <td class="compare-table__narrow">{{ direct.kind }}</td>
            <td class="mono">{{ direct.base ?? '—' }}</td>
            <td class="mono">{{ direct.target ?? '—' }}</td>
          </tr>
        </tbody>
      </table>
      <button v-if="!showsAllDirects && root.directs.length > COMPARE_ROW_LIMIT" type="button" class="button compare-root__more" @click="showsAllDirects = true">
        {{ showAllText(root.directs.length) }}
      </button>
    </template>

    <template v-if="root.versions.length > 0">
      <h4 class="compare-root__heading">{{ VERSIONS_HEADING }}</h4>
      <table class="compare-table">
        <thead>
          <tr>
            <th scope="col">{{ PACKAGE_COLUMN }}</th>
            <th scope="col">{{ labels.base }}</th>
            <th scope="col">{{ labels.target }}</th>
            <th scope="col" class="compare-table__narrow">{{ CHANGE_COLUMN }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="version in shownVersions" :key="version.name">
            <td>
              <button v-if="version.targetNode" type="button" class="compare-table__link mono" @click="emit('select', version.targetNode)">
                <BreakableName :name="version.name" />
              </button>
              <span v-else class="mono"><BreakableName :name="version.name" /></span>
            </td>
            <td class="mono">{{ versionsText(version.base) }}</td>
            <td class="mono">{{ versionsText(version.target) }}</td>
            <td class="compare-table__narrow">{{ version.change }}</td>
          </tr>
        </tbody>
      </table>
      <button v-if="!showsAllVersions && root.versions.length > COMPARE_ROW_LIMIT" type="button" class="button compare-root__more" @click="showsAllVersions = true">
        {{ showAllText(root.versions.length) }}
      </button>
    </template>
  </section>
</template>

<style scoped>
.compare-root {
  padding: 12px 16px 20px;
  border-bottom: 1px solid var(--border);
  white-space: normal;
}

.compare-root__title {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  margin: 0 0 8px;
  font-size: 15px;
}

.compare-root__heading {
  margin: 16px 0 6px;
  font-size: 14px;
}

.compare-root__note {
  margin: 4px 0;
  overflow-wrap: anywhere;
}

.compare-root__more {
  margin-top: 8px;
}

.compare-table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
}

.compare-table th {
  padding: 6px 8px;
  border-bottom: 1px solid var(--border-strong);
  background: var(--surface-panel);
  font-size: 13px;
  font-weight: 600;
  text-align: left;
  overflow-wrap: anywhere;
}

.compare-table td {
  padding: 5px 8px;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
  overflow-wrap: anywhere;
}

.compare-table__col-name {
  width: 40%;
}

.compare-table__narrow {
  width: 104px;
}

.compare-table__link {
  padding: 0;
  border: 0;
  background: none;
  color: var(--accent);
  font-size: inherit;
  line-height: inherit;
  text-align: left;
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
  overflow-wrap: anywhere;
}
</style>
