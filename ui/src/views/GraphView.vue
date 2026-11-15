<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import type { DepKind, NodeId } from '../../../src/model.ts'
import { createApi, type SearchHit, type SubgraphResult } from '../api.ts'
import GraphCanvas from '../components/GraphCanvas.vue'
import type { NodeDecorations } from '../decorations.ts'
import type { ExploreFilterChange, GraphOptions } from '../explore-options.ts'
import { focusScene, type GraphScene, type StubSceneNode } from '../graph/graph-scene.ts'
import { loadRootVariants, variantNodeRefs } from '../graph/root-variants.ts'
import { clusterNodes, firstNodesByLayer, mergeImporterSubgraphs, wholeRootScene, type MergedRoot } from '../graph/whole-root.ts'
import { nodeIdLabel, rootLabel } from '../labels.ts'
import type { PeerVariant } from '../node-id.ts'
import { isMissingNode, isRootBusy } from '../scan-state.ts'
import { GRAPH_CLUSTERS, GRAPH_HINT, graphLoadFailedText, LOADING, notInRootSentence, scanningMessage, truncatedGraphText, wholeRootLimitText } from '../vocabulary.ts'

const props = defineProps<{
  root: string
  revision: string
  anchor?: NodeId
  selected?: NodeId
  kinds: DepKind[]
  duplicatesOnly: boolean
  duplicateVersions: ReadonlyMap<string, string>
  duplicatesError: string | null
  decorations: NodeDecorations
  up: number
  down: number
  options: GraphOptions
}>()

const emit = defineEmits<{
  select: [nodeId: NodeId]
  'depth-change': [change: ExploreFilterChange]
  'root-busy': []
}>()

type LoadedGraph =
  | { scope: 'package'; result: SubgraphResult; limit: number; variants: ReadonlyMap<NodeId, PeerVariant> }
  | { scope: 'whole-root'; merged: MergedRoot; limit: number; variants: ReadonlyMap<NodeId, PeerVariant> }

const REPOSITORY_IMPORTER_ID = 'importer:.'
const EMPTY_SCENE: GraphScene = { nodes: [], edges: [] }

const api = createApi()
const loaded = shallowRef<LoadedGraph | null>(null)
const expandedClusterIds = shallowRef<ReadonlySet<string>>(new Set())
const loadError = ref<string | null>(null)
const rootBusy = ref(false)
const loading = ref(false)
let latestLoad = 0
const searches = new Map<string, Promise<SearchHit[]>>()

const startId = computed(() => props.anchor ?? REPOSITORY_IMPORTER_ID)
const kindsKey = computed(() => props.kinds.join(','))
const scope = computed(() => props.options.scope)
const requestKey = computed(() =>
  scope.value === 'package'
    ? ['package', props.root, props.revision, startId.value, kindsKey.value, props.up, props.down, props.options.nodeLimit].join('\u0000')
    : ['whole-root', props.root, props.revision, kindsKey.value, props.options.wholeRootDown, props.options.nodeLimit].join('\u0000'),
)
const resetKey = computed(() => [props.root, scope.value, scope.value === 'package' ? startId.value : ''].join('\u0000'))

const visibleRoot = computed(() => {
  const current = loaded.value
  return current?.scope === 'whole-root' ? firstNodesByLayer(current.merged, current.limit) : null
})
const clusters = computed(() => (visibleRoot.value ? clusterNodes(visibleRoot.value) : []))

const scene = computed<GraphScene>(() => {
  const current = loaded.value
  if (!current) return EMPTY_SCENE
  if (current.scope === 'package') return focusScene(current.result, current.variants)
  return visibleRoot.value ? wholeRootScene(visibleRoot.value, clusters.value, expandedClusterIds.value, current.variants) : EMPTY_SCENE
})

const limitNotice = computed(() => {
  const current = loaded.value
  if (!current) return null
  if (current.scope === 'whole-root' && current.merged.nodes.length > current.limit) return wholeRootLimitText(current.merged.nodes.length, current.limit)
  const truncated = current.scope === 'package' ? current.result.truncated : current.merged.truncated
  return truncated ? truncatedGraphText(current.limit) : null
})

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function cachedSearch(root: string): (name: string) => Promise<SearchHit[]> {
  return (name) => {
    const key = `${root}\u0000${name}`
    const known = searches.get(key)
    if (known) return known
    const pending = api.search(name)
    searches.set(key, pending)
    pending.catch(() => searches.delete(key))
    return pending
  }
}

async function fetchAroundPackage(root: string, start: NodeId, up: number, down: number, limit: number, kinds: DepKind[]): Promise<LoadedGraph> {
  const result = await api.subgraph(root, start, up, down, limit, kinds)
  const variants = await loadRootVariants(root, variantNodeRefs(result.nodes), cachedSearch(root))
  return { scope: 'package', result, limit, variants }
}

async function fetchWholeRoot(root: string, down: number, limit: number, kinds: DepKind[]): Promise<LoadedGraph> {
  const importers = await api.importers(root)
  const results = await Promise.all(importers.map((importer) => api.subgraph(root, importer.id, 0, down, limit, kinds)))
  const merged = mergeImporterSubgraphs(results)
  const drawn = firstNodesByLayer(merged, limit)
  const variants = await loadRootVariants(root, variantNodeRefs(drawn.nodes), cachedSearch(root))
  return { scope: 'whole-root', merged, limit, variants }
}

async function load(): Promise<void> {
  const request = ++latestLoad
  const root = props.root
  const subject = scope.value === 'package' ? nodeIdLabel(startId.value) : rootLabel(root)
  const missingText = scope.value === 'package' ? notInRootSentence(nodeIdLabel(startId.value), root) : undefined
  const { nodeLimit, wholeRootDown } = props.options
  const pending =
    scope.value === 'package'
      ? fetchAroundPackage(props.root, startId.value, props.up, props.down, nodeLimit, props.kinds)
      : fetchWholeRoot(props.root, wholeRootDown, nodeLimit, props.kinds)
  loadError.value = null
  rootBusy.value = false
  loading.value = true
  try {
    const next = await pending
    if (request !== latestLoad) return
    loaded.value = next
  } catch (error) {
    if (request !== latestLoad) return
    loaded.value = null
    if (isRootBusy(error)) {
      rootBusy.value = true
      emit('root-busy')
      return
    }
    loadError.value = missingText !== undefined && isMissingNode(error) ? missingText : graphLoadFailedText(subject, messageOf(error))
  } finally {
    if (request === latestLoad) loading.value = false
  }
}

function expandStub(stub: StubSceneNode): void {
  emit('depth-change', stub.side === 'up' ? { up: props.up + 1 } : { down: props.down + 1 })
}

function toggleCluster(clusterId: string): void {
  const next = new Set(expandedClusterIds.value)
  if (!next.delete(clusterId)) next.add(clusterId)
  expandedClusterIds.value = next
}

watch(requestKey, () => void load(), { immediate: true })
watch([() => props.root, () => props.revision], () => {
  searches.clear()
  expandedClusterIds.value = new Set()
  loaded.value = null
})
</script>

<template>
  <div class="graph">
    <div class="graph__controls">
      <span v-if="loading" class="graph__status muted" role="status">{{ LOADING }}</span>
      <span class="graph__hint muted">{{ GRAPH_HINT }}</span>
    </div>
    <p v-if="rootBusy" class="graph__notice" role="status">{{ scanningMessage(root) }}</p>
    <p v-if="loadError" class="graph__notice graph__notice--error" role="alert">{{ loadError }}</p>
    <p v-if="duplicatesError" class="graph__notice" role="status">{{ duplicatesError }}</p>
    <p v-if="limitNotice" class="graph__notice graph__notice--warn" role="status">{{ limitNotice }}</p>
    <div v-if="clusters.length > 0" class="graph__clusters" role="group" :aria-label="GRAPH_CLUSTERS">
      <span class="graph__clusters-title">{{ GRAPH_CLUSTERS }}</span>
      <button
        v-for="cluster in clusters"
        :key="cluster.id"
        type="button"
        class="graph__cluster"
        :aria-pressed="expandedClusterIds.has(cluster.id)"
        :title="cluster.title"
        @click="toggleCluster(cluster.id)"
      >
        {{ cluster.label }}
      </button>
    </div>
    <GraphCanvas
      :scene="scene"
      :anchor="anchor"
      :selected="selected"
      :reset-key="resetKey"
      :duplicate-versions="duplicateVersions"
      :duplicates-only="duplicatesOnly"
      :decorations="decorations"
      @select="(id: NodeId) => emit('select', id)"
      @expand-stub="expandStub"
      @expand-cluster="toggleCluster"
    />
  </div>
</template>

<style scoped>
.graph {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.graph__controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 16px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-panel);
}

.graph__status,
.graph__hint {
  font-size: 12px;
}

.graph__hint {
  margin-left: auto;
}

.graph__notice {
  margin: 0;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
  color: var(--text-muted);
}

.graph__notice--warn {
  background: var(--badge-warn-bg);
  color: var(--badge-warn-fg);
}

.graph__notice--error {
  color: var(--danger);
}

.graph__clusters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 6px;
  max-height: 88px;
  padding: 6px 12px;
  overflow-y: auto;
  border-bottom: 1px solid var(--border);
}

.graph__clusters-title {
  color: var(--text);
  font-size: 13px;
  font-weight: 600;
}

.graph__cluster {
  height: 24px;
  padding: 0 10px;
  border: 1px dashed var(--border-strong);
  border-radius: 12px;
  background: var(--surface-panel);
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}

.graph__cluster:hover {
  color: var(--text);
}

.graph__cluster[aria-pressed='true'] {
  border-style: solid;
  border-color: var(--accent);
  background: var(--surface-selected);
  color: var(--text);
}
</style>
