<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { EnrichmentStatus } from '../../../src/enrich/types.ts'
import type { DepKind, NodeId } from '../../../src/model.ts'
import { createApi, type RootSummary, type SearchHit } from '../api.ts'
import { orderHitsByScope, type Selection } from '../context.ts'
import { rootLabel } from '../labels.ts'
import { peerVariantsPerGroup } from '../node-id.ts'
import {
  DEPENDENCY_TYPES,
  KEYBOARD_SHORTCUTS,
  kindsChipText,
  noSearchMatchText,
  peerVariantText,
  PRODUCT_NAME,
  SEARCH_PACKAGES,
  SEARCH_PLACEHOLDER,
  SEARCH_RESULTS,
  searchFailedText,
  SEARCHING,
  searchOptionName,
  searchShortcutHint,
  SHOW_ALL_DEPENDENCY_TYPES,
} from '../vocabulary.ts'
import AppIcon from './AppIcon.vue'
import RefreshMenu from './RefreshMenu.vue'
import RootSwitcher from './RootSwitcher.vue'
import SourceSwitcher from './SourceSwitcher.vue'
import { SHOWN_SOURCE, type ShownSourceState } from '../source.ts'
import ShortcutsDialog from './ShortcutsDialog.vue'

const props = defineProps<{ repoPath?: string; scope?: string; roots: RootSummary[]; kinds: DepKind[]; enrichment?: EnrichmentStatus }>()

const emit = defineEmits<{
  pick: [selection: Selection]
  'choose-root': [root: string | undefined]
  'show-all-kinds': []
  rescan: []
  'check-again': []
}>()

type SearchOption = {
  position: number
  domId: string
  name: string
  version: string
  rootId: string
  nodeId: NodeId
  variant: string
}
type VersionGroup = { version: string; options: SearchOption[] }
type NameGroup = { name: string; versions: VersionGroup[] }

const SEARCH_DELAY_MS = 120
const SHORTCUT_HINT = searchShortcutHint(/Mac|iPhone|iPad/.test(navigator.userAgent))

const api = createApi()
const input = ref<HTMLInputElement | null>(null)
const switcher = ref<InstanceType<typeof RootSwitcher> | null>(null)
const sourceSwitcher = ref<InstanceType<typeof SourceSwitcher> | null>(null)
const shown = inject(SHOWN_SOURCE, { source: { kind: 'working' } } satisfies ShownSourceState)

function reloadBranch(): void {
  window.location.reload()
}
const refreshMenu = ref<InstanceType<typeof RefreshMenu> | null>(null)
const helpButton = ref<HTMLButtonElement | null>(null)
const showsShortcuts = ref(false)
let focusBeforeShortcuts: HTMLElement | null = null
const query = ref('')
const hits = ref<SearchHit[]>([])
const searchedTerm = ref('')
const searchError = ref<string | null>(null)
const open = ref(false)
const activeIndex = ref(-1)
let searchTimer: number | undefined
let latestSearch = 0

const term = computed(() => query.value.trim())
const repoName = computed(() => props.repoPath?.split(/[\\/]/).filter(Boolean).pop() ?? '')
const showResults = computed(() => open.value && term.value !== '')
const resultsAreCurrent = computed(() => searchedTerm.value === term.value)
const kindsChip = computed(() => kindsChipText(props.kinds))

const groups = computed<NameGroup[]>(() => {
  let position = 0
  return orderHitsByScope(hits.value, props.scope).map((hit) => ({
    name: hit.name,
    versions: hit.versions.map(({ version, roots }) => {
      const variants = peerVariantsPerGroup(
        roots,
        (location) => location.rootId,
        (location) => location.nodeId,
      )
      return {
        version,
        options: roots.map(({ rootId, nodeId }) => {
          const variant = variants.get(rootId)?.get(nodeId)
          const option: SearchOption = {
            position,
            domId: `search-option-${position}`,
            name: hit.name,
            version,
            rootId,
            nodeId,
            variant: variant === undefined ? '' : peerVariantText(variant),
          }
          position++
          return option
        }),
      }
    }),
  }))
})

const options = computed(() => groups.value.flatMap((group) => group.versions.flatMap((version) => version.options)))
const activeOption = computed<SearchOption | undefined>(() => options.value[activeIndex.value])

const status = computed(() => {
  if (!resultsAreCurrent.value) return SEARCHING
  if (searchError.value !== null) return searchFailedText(searchError.value)
  if (hits.value.length === 0) return noSearchMatchText(term.value)
  return ''
})

function optionLabel(option: SearchOption): string {
  return searchOptionName(option.name, option.version, option.rootId, option.variant)
}

async function runSearch(searchTerm: string): Promise<void> {
  const request = ++latestSearch
  try {
    const result = await api.search(searchTerm)
    if (request !== latestSearch) return
    hits.value = result
    searchError.value = null
  } catch (error) {
    if (request !== latestSearch) return
    hits.value = []
    searchError.value = error instanceof Error ? error.message : String(error)
  }
  searchedTerm.value = searchTerm
}

watch(term, (value) => {
  window.clearTimeout(searchTimer)
  activeIndex.value = -1
  if (value === '') {
    latestSearch++
    hits.value = []
    searchedTerm.value = ''
    return
  }
  searchTimer = window.setTimeout(() => void runSearch(value), SEARCH_DELAY_MS)
})

async function moveActive(step: number): Promise<void> {
  const count = options.value.length
  if (count === 0) return
  activeIndex.value = (activeIndex.value + step + count) % count
  await nextTick()
  const active = activeOption.value
  if (active) document.getElementById(active.domId)?.scrollIntoView({ block: 'nearest' })
}

function pick(option: SearchOption): void {
  emit('pick', { root: option.rootId, node: option.nodeId })
  open.value = false
  activeIndex.value = -1
  input.value?.blur()
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    open.value = true
    void moveActive(event.key === 'ArrowDown' ? 1 : -1)
    return
  }
  if (event.key === 'Enter') {
    const option = activeOption.value ?? (resultsAreCurrent.value ? options.value[0] : undefined)
    if (!option) return
    event.preventDefault()
    pick(option)
    return
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    if (showResults.value) open.value = false
    else input.value?.blur()
  }
}

function focusSearch(): void {
  input.value?.focus()
  input.value?.select()
  open.value = true
}

function showAllKinds(): void {
  emit('show-all-kinds')
  switcher.value?.focusButton()
}

function focusedElement(): HTMLElement | null {
  const focused = document.activeElement
  return focused instanceof HTMLElement && focused !== document.body ? focused : null
}

function openShortcuts(): void {
  if (showsShortcuts.value) return
  focusBeforeShortcuts = focusedElement()
  showsShortcuts.value = true
}

async function closeShortcuts(): Promise<void> {
  showsShortcuts.value = false
  await nextTick()
  const returnTo = focusBeforeShortcuts?.isConnected === true ? focusBeforeShortcuts : helpButton.value
  focusBeforeShortcuts = null
  returnTo?.focus()
}

function dismissPopups(): boolean {
  const closedMenus = [sourceSwitcher.value?.dismiss() === true, switcher.value?.dismiss() === true, refreshMenu.value?.dismiss() === true]
  const closedShortcuts = showsShortcuts.value
  if (closedShortcuts) void closeShortcuts()
  return closedShortcuts || closedMenus.includes(true)
}

defineExpose({ focusSearch, openShortcuts, dismissPopups })

onBeforeUnmount(() => {
  window.clearTimeout(searchTimer)
})
</script>

<template>
  <header class="topbar">
    <div class="topbar__brand">
      <span class="topbar__name">{{ PRODUCT_NAME }}</span>
      <span v-if="repoName" class="topbar__repo muted mono" :title="repoPath">{{ repoName }}</span>
    </div>
    <SourceSwitcher ref="sourceSwitcher" />
    <RootSwitcher ref="switcher" :roots="roots" :scope="scope" @choose="(root) => emit('choose-root', root)" />
    <span v-if="kindsChip" class="kinds-chip">
      <span class="kinds-chip__text"><span class="sr-only">{{ DEPENDENCY_TYPES }}: </span>{{ kindsChip }}</span>
      <button type="button" class="kinds-chip__clear" :aria-label="SHOW_ALL_DEPENDENCY_TYPES" :title="SHOW_ALL_DEPENDENCY_TYPES" @click="showAllKinds"><AppIcon name="x" :size="18" /></button>
    </span>
    <div class="search">
      <input
        ref="input"
        v-model="query"
        class="search__input"
        type="text"
        role="combobox"
        :aria-label="SEARCH_PACKAGES"
        aria-autocomplete="list"
        aria-controls="search-results"
        :aria-expanded="showResults"
        :aria-activedescendant="activeOption?.domId"
        :placeholder="SEARCH_PLACEHOLDER"
        autocomplete="off"
        spellcheck="false"
        @focus="open = true"
        @blur="open = false"
        @input="open = true"
        @keydown="onKeydown"
      />
      <kbd class="search__hint">{{ SHORTCUT_HINT }}</kbd>
      <div v-show="showResults" class="search__dropdown">
        <p v-if="status" class="search__status muted">{{ status }}</p>
        <div id="search-results" role="listbox" :aria-label="SEARCH_RESULTS">
          <div v-for="group in groups" :key="group.name" class="search__group" role="group" :aria-label="group.name">
            <div class="search__name mono">{{ group.name }}</div>
            <div v-for="version in group.versions" :key="version.version" class="search__version">
              <span class="search__version-label mono">{{ version.version }}</span>
              <span class="search__roots">
                <span
                  v-for="option in version.options"
                  :id="option.domId"
                  :key="option.domId"
                  role="option"
                  class="search__option"
                  :class="{ 'search__option--active': option === activeOption }"
                  :aria-selected="option === activeOption"
                  :aria-label="optionLabel(option)"
                  @mousedown.prevent
                  @mousemove="activeIndex = option.position"
                  @click="pick(option)"
                >
                  {{ rootLabel(option.rootId) }}<span v-if="option.variant" class="search__variant">{{ option.variant }}</span>
                </span>
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div class="topbar__end">
      <RefreshMenu
        ref="refreshMenu"
        :status="enrichment"
        :reloads-branch="shown.source.kind === 'commit'"
        @rescan="emit('rescan')"
        @check-again="emit('check-again')"
        @reload="reloadBranch"
      />
      <button
        ref="helpButton"
        type="button"
        class="topbar__help"
        :aria-label="KEYBOARD_SHORTCUTS"
        :title="KEYBOARD_SHORTCUTS"
        @click="openShortcuts"
      >
        ?
      </button>
    </div>
    <ShortcutsDialog v-if="showsShortcuts" @close="closeShortcuts" />
  </header>
</template>

<style scoped>
.topbar {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 52px;
  padding: 0 14px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}

.topbar__brand {
  display: flex;
  flex: 0 1 auto;
  align-items: baseline;
  gap: 8px;
  max-width: 240px;
  min-width: 0;
}

.topbar__name {
  font-size: 16px;
  font-weight: 650;
  letter-spacing: -0.01em;
}

.topbar__repo {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kinds-chip {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 2px;
  height: 32px;
  padding: 0 2px 0 12px;
  border: 1px solid var(--badge-info-fg);
  border-radius: 16px;
  background: var(--badge-info-bg);
  color: var(--badge-info-fg);
  white-space: nowrap;
}

.kinds-chip__clear {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: none;
  color: inherit;
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
}

.kinds-chip__clear:hover {
  background: var(--surface-hover);
}

.search {
  position: relative;
  flex: 1 1 360px;
  max-width: 560px;
  min-width: 160px;
}

.search__input {
  width: 100%;
  height: 32px;
  padding: 0 56px 0 12px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  background: var(--surface-panel);
}

.search__input::placeholder {
  color: var(--text-faint);
}

.search__input:focus {
  border-color: var(--accent);
  outline: none;
  background: var(--surface);
}

.search__hint {
  position: absolute;
  top: 50%;
  right: 8px;
  padding: 0 5px;
  border: 1px solid var(--border);
  border-radius: 3px;
  color: var(--text-faint);
  font: 12px/18px var(--font-ui);
  transform: translateY(-50%);
  pointer-events: none;
}

.search__dropdown {
  position: absolute;
  z-index: 10;
  top: calc(100% + 4px);
  right: 0;
  left: 0;
  max-height: min(60vh, 520px);
  overflow-y: auto;
  padding: 4px 0;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: var(--surface-raised);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.16);
}

.search__status {
  margin: 0;
  padding: 6px 12px;
}

.search__group {
  padding: 4px 0;
}

.search__group + .search__group {
  border-top: 1px solid var(--border);
}

.search__name {
  padding: 4px 14px;
  font-weight: 600;
}

.search__version {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding: 2px 14px 2px 26px;
}

.search__version-label {
  flex-shrink: 0;
  min-width: 80px;
  color: var(--text-muted);
}

.search__roots {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 4px;
}

.search__option {
  padding: 2px 8px;
  border-radius: var(--radius);
  cursor: pointer;
}

.search__option--active {
  background: var(--surface-selected);
}

.topbar__end {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

.topbar__help {
  width: 32px;
  height: 32px;
  padding: 0;
  border: 1px solid var(--border-strong);
  border-radius: 50%;
  background: var(--surface-raised);
  font-weight: 600;
  cursor: pointer;
}

.topbar__help:hover {
  background: var(--surface-hover);
}

.search__variant {
  margin-left: 4px;
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 12px;
}
</style>
