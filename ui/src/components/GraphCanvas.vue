<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { NodeId } from '../../../src/model.ts'
import { fitTransform, type ViewPoint, type ViewSize } from '../graph/fit-view.ts'
import { nodeBadges, vulnerabilityTone, type Badge, type BadgeTone } from '../badges.ts'
import type { NodeDecorations } from '../decorations.ts'
import {
  LABEL_PADDING,
  layerGapFor,
  PILL_GAP,
  pillWidth,
  pillsWidth,
  type GraphScene,
  type PackageSceneNode,
  type SceneNode,
  type StubSceneNode,
} from '../graph/graph-scene.ts'
import { layeredLayout } from '../graph/layered-layout.ts'
import { createPanZoom, type PanZoomTransform } from '../graph/pan-zoom.ts'
import { nodeIdLabel } from '../labels.ts'
import {
  CLICK_TO_EXPAND,
  duplicateVersionsLine,
  expandName,
  GRAPH_ANCHOR_NOTE,
  GRAPH_LABEL,
  GRAPH_NODE_HINT,
  graphNodeDescription,
  stubName,
  stubTitle,
  workspacePackageTitle,
} from '../vocabulary.ts'

const props = defineProps<{
  scene: GraphScene
  anchor?: NodeId
  selected?: NodeId
  resetKey: string
  duplicateVersions: ReadonlyMap<string, string>
  duplicatesOnly: boolean
  decorations: NodeDecorations
}>()

const emit = defineEmits<{
  select: [nodeId: NodeId]
  'expand-stub': [stub: StubSceneNode]
  'expand-cluster': [clusterId: string]
}>()

const NODE_HEIGHT = 26
const PILL_HEIGHT = 16
const PILL_TOP = -11
const SPACE_BETWEEN_ROWS = 6
const ROW_GAP = NODE_HEIGHT - PILL_TOP + SPACE_BETWEEN_ROWS
const STRIPE_WIDTH = 4
const IMPORTER_INSET = 3
const ANCHOR_RING_OFFSET = 4
const CLUSTER_STACK_OFFSET = 4
const IDENTITY: PanZoomTransform = { x: 0, y: 0, k: 1 }
const TEST_IDS: Record<SceneNode['kind'], string> = {
  package: 'graph-node',
  importer: 'graph-node',
  stub: 'graph-stub',
  cluster: 'graph-cluster',
}

const svg = ref<SVGSVGElement | null>(null)
const viewport = shallowRef<ViewSize>({ width: 0, height: 0 })
const userTransform = shallowRef<PanZoomTransform>(IDENTITY)
let disposePanZoom: (() => void) | undefined
let resizeObserver: ResizeObserver | undefined

function badgesOf(node: PackageSceneNode): Badge[] {
  return nodeBadges(props.decorations[node.id], { isDirect: node.isDirect, compact: true, version: node.version })
}

function widthWithBadges(node: SceneNode): number {
  return isPackage(node) ? Math.max(node.width, pillsWidth(badgesOf(node).map((badge) => badge.label))) : node.width
}

const drawnWidths = computed(() => new Map(props.scene.nodes.map((node) => [node.key, widthWithBadges(node)])))

function drawnWidthOf(node: SceneNode): number {
  return drawnWidths.value.get(node.key) ?? node.width
}

const layout = computed(() =>
  layeredLayout(
    {
      nodes: props.scene.nodes.map((node) => ({ id: node.key, layer: node.layer, width: drawnWidthOf(node) })),
      edges: props.scene.edges,
    },
    { layerGap: layerGapFor(props.scene.nodes.map(drawnWidthOf)), rowGap: ROW_GAP },
  ),
)

const placedNodes = computed(() =>
  props.scene.nodes.flatMap((node) => {
    const position = layout.value.positions.get(node.key)
    return position ? [{ node, x: position.x, y: position.y }] : []
  }),
)

type PlacedPill = { badge: Badge; x: number; width: number }
type DecoratedNode = {
  node: SceneNode
  x: number
  y: number
  width: number
  pills: PlacedPill[]
  stripeTone: BadgeTone | undefined
}

function placePills(badges: Badge[], width: number): PlacedPill[] {
  let cursor = width - pillsWidth(badges.map((badge) => badge.label))
  return badges.map((badge) => {
    const pill = { badge, x: cursor, width: pillWidth(badge.label) }
    cursor += pill.width + PILL_GAP
    return pill
  })
}

function decorate(placed: { node: SceneNode; x: number; y: number }): DecoratedNode {
  const { node } = placed
  if (!isPackage(node)) return { ...placed, width: node.width, pills: [], stripeTone: undefined }
  const decoration = props.decorations[node.id]
  const width = drawnWidthOf(node)
  return {
    ...placed,
    width,
    pills: placePills(badgesOf(node), width),
    stripeTone: decoration?.vuln ? vulnerabilityTone(decoration.vuln) : undefined,
  }
}

const decoratedNodes = computed(() => placedNodes.value.map(decorate))

const stubKeys = computed(() => new Set(props.scene.nodes.filter((node) => node.kind === 'stub').map((node) => node.key)))

const anchorPoint = computed<ViewPoint | undefined>(() => {
  const placed = placedNodes.value.find(({ node }) => isPackage(node) && node.id === props.anchor)
  return placed ? { x: placed.x + drawnWidthOf(placed.node) / 2, y: placed.y + ROW_GAP / 2 } : undefined
})

const contentTransform = computed(() => {
  const fit = fitTransform({ width: layout.value.width, height: layout.value.height }, viewport.value, anchorPoint.value)
  return `translate(${fit.x} ${fit.y}) scale(${fit.k}) translate(0 ${ROW_GAP / 2})`
})

const viewportTransform = computed(() => {
  const { x, y, k } = userTransform.value
  return `translate(${x} ${y}) scale(${k})`
})

function isPackage(node: SceneNode): node is PackageSceneNode {
  return node.kind === 'package' || node.kind === 'importer'
}

function isDuplicate(node: SceneNode): boolean {
  return node.kind === 'package' && props.duplicateVersions.has(node.name)
}

function isAnchor(node: SceneNode): boolean {
  return isPackage(node) && node.id === props.anchor
}

function nodeClasses(node: SceneNode): Record<string, boolean> {
  return {
    [`graph-node--${node.kind}`]: true,
    'graph-node--anchor': isAnchor(node),
    'graph-node--selected': isPackage(node) && node.id === props.selected,
    'graph-node--dimmed': props.duplicatesOnly && node.kind === 'package' && !isDuplicate(node),
  }
}

function ariaLabelOf(node: SceneNode): string {
  if (node.kind === 'stub') return stubName(node.side, node.label, nodeIdLabel(node.at))
  if (node.kind === 'cluster') return expandName(node.label)
  return node.label
}

function packageNotes(node: PackageSceneNode): string[] {
  const notes: string[] = []
  if (isDuplicate(node)) notes.push(duplicateVersionsLine(props.duplicateVersions.get(node.name) ?? ''))
  if (isAnchor(node)) notes.push(GRAPH_ANCHOR_NOTE)
  notes.push(GRAPH_NODE_HINT)
  return notes
}

function descriptionOf(node: SceneNode): string | undefined {
  return isPackage(node) ? graphNodeDescription(packageNotes(node)) : undefined
}

function titleOf(node: SceneNode): string {
  if (node.kind === 'stub') return stubTitle(node.side, node.label)
  if (node.kind === 'cluster') return `${node.title}\n${CLICK_TO_EXPAND}`
  const headline = node.kind === 'importer' ? workspacePackageTitle(node.label) : node.label
  return [headline, ...packageNotes(node)].join('\n')
}

function activate(node: SceneNode): void {
  if (isPackage(node)) emit('select', node.id)
  else if (node.kind === 'stub') emit('expand-stub', node)
  else emit('expand-cluster', node.clusterId)
}

function restartPanZoom(): void {
  disposePanZoom?.()
  userTransform.value = IDENTITY
  if (svg.value) disposePanZoom = createPanZoom(svg.value, (transform) => (userTransform.value = transform))
}

function measureViewport(): void {
  const bounds = svg.value?.getBoundingClientRect()
  if (bounds) viewport.value = { width: bounds.width, height: bounds.height }
}

watch(() => props.resetKey, restartPanZoom)

onMounted(() => {
  restartPanZoom()
  measureViewport()
  if (svg.value && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(measureViewport)
    resizeObserver.observe(svg.value)
  }
})

onBeforeUnmount(() => {
  disposePanZoom?.()
  resizeObserver?.disconnect()
})
</script>

<template>
  <svg ref="svg" class="graph-canvas" data-testid="graph-canvas" role="group" :aria-label="GRAPH_LABEL">
    <g data-testid="graph-viewport" :transform="viewportTransform">
      <g :transform="contentTransform">
        <path
          v-for="path in layout.paths"
          :key="`${path.from}→${path.to}`"
          class="graph-edge"
          :class="{ 'graph-edge--stub': stubKeys.has(path.from) || stubKeys.has(path.to) }"
          :d="path.d"
        />
        <g
          v-for="{ node, x, y, width, pills, stripeTone } in decoratedNodes"
          :key="node.key"
          class="graph-node"
          :class="nodeClasses(node)"
          :transform="`translate(${x} ${y - NODE_HEIGHT / 2})`"
          :data-testid="TEST_IDS[node.kind]"
          :data-id="isPackage(node) ? node.id : undefined"
          :data-kind="node.kind"
          :aria-current="isPackage(node) && node.id === selected ? 'true' : undefined"
          :aria-label="ariaLabelOf(node)"
          :aria-description="descriptionOf(node)"
          role="button"
          tabindex="0"
          @click="activate(node)"
          @keydown.enter.prevent="activate(node)"
          @keydown.space.prevent="activate(node)"
        >
          <title>{{ titleOf(node) }}</title>
          <rect
            v-if="isAnchor(node)"
            class="graph-node__anchor-ring"
            data-testid="graph-anchor-ring"
            :x="-ANCHOR_RING_OFFSET"
            :y="-ANCHOR_RING_OFFSET"
            :width="width + 2 * ANCHOR_RING_OFFSET"
            :height="NODE_HEIGHT + 2 * ANCHOR_RING_OFFSET"
            rx="6"
          />
          <rect
            v-if="node.kind === 'cluster'"
            class="graph-node__stack"
            :x="CLUSTER_STACK_OFFSET"
            :y="-CLUSTER_STACK_OFFSET"
            :width="node.width"
            :height="NODE_HEIGHT"
            rx="4"
          />
          <rect class="graph-node__box" :width="width" :height="NODE_HEIGHT" rx="4" />
          <rect
            v-if="node.kind === 'importer'"
            class="graph-node__inner"
            :x="IMPORTER_INSET"
            :y="IMPORTER_INSET"
            :width="width - 2 * IMPORTER_INSET"
            :height="NODE_HEIGHT - 2 * IMPORTER_INSET"
            rx="2"
          />
          <text class="graph-node__label" :x="LABEL_PADDING" :y="NODE_HEIGHT / 2" dominant-baseline="central">{{ node.text }}</text>
          <rect
            v-if="stripeTone"
            class="graph-node__stripe"
            :class="`graph-tone--${stripeTone}`"
            data-testid="graph-stripe"
            :width="STRIPE_WIDTH"
            :height="NODE_HEIGHT"
            rx="2"
          />
          <g
            v-for="pill in pills"
            :key="pill.badge.key"
            class="graph-pill"
            :class="[`graph-tone--${pill.badge.tone}`, { 'graph-pill--outline': pill.badge.outlined }]"
            data-testid="graph-badge"
            :transform="`translate(${pill.x} ${PILL_TOP})`"
          >
            <title>{{ pill.badge.title }}</title>
            <rect class="graph-pill__box" :width="pill.width" :height="PILL_HEIGHT" rx="8" />
            <text class="graph-pill__label" :x="pill.width / 2" :y="PILL_HEIGHT / 2" text-anchor="middle" dominant-baseline="central">
              {{ pill.badge.label }}
            </text>
          </g>
          <circle v-if="isDuplicate(node)" class="graph-node__duplicate" :cx="width" cy="0" r="4" />
        </g>
      </g>
    </g>
  </svg>
</template>

<style scoped>
.graph-canvas {
  display: block;
  flex: 1;
  width: 100%;
  min-height: 0;
  background: var(--surface);
  cursor: grab;
  touch-action: none;
  user-select: none;
}

.graph-edge {
  fill: none;
  stroke: var(--text-faint);
  stroke-width: 1.25;
}

.graph-edge--stub {
  stroke-dasharray: 4 3;
}

.graph-node {
  cursor: pointer;
  outline: none;
}

.graph-node__box {
  fill: var(--surface-raised);
  stroke: var(--border-strong);
  stroke-width: 1;
}

.graph-node__inner {
  fill: none;
  stroke: var(--text-muted);
  stroke-width: 1;
}

.graph-node__stack {
  fill: var(--surface-panel);
  stroke: var(--border-strong);
  stroke-width: 1;
}

.graph-node__label {
  fill: var(--text);
  font-family: var(--font-mono);
  font-size: 13px;
}

.graph-node__duplicate {
  fill: var(--badge-warn-fg);
  stroke: var(--surface);
  stroke-width: 1.5;
}

.graph-node__stripe {
  fill: var(--badge-neutral-fg);
}

.graph-pill__box {
  fill: var(--badge-neutral-bg);
}

.graph-pill__label {
  fill: var(--badge-neutral-fg);
  font-family: var(--font-ui);
  font-size: 12px;
  font-weight: 500;
}

.graph-pill--outline .graph-pill__box {
  fill: var(--surface);
  stroke: var(--badge-neutral-fg);
  stroke-width: 1;
}

.graph-tone--danger.graph-node__stripe,
.graph-tone--danger .graph-pill__label {
  fill: var(--badge-danger-fg);
}

.graph-tone--warn.graph-node__stripe,
.graph-tone--warn .graph-pill__label {
  fill: var(--badge-warn-fg);
}

.graph-tone--info .graph-pill__label {
  fill: var(--badge-info-fg);
}

.graph-tone--danger .graph-pill__box {
  fill: var(--badge-danger-bg);
}

.graph-tone--warn .graph-pill__box {
  fill: var(--badge-warn-bg);
}

.graph-tone--info .graph-pill__box {
  fill: var(--badge-info-bg);
}

.graph-tone--danger.graph-pill--outline .graph-pill__box {
  fill: var(--surface);
  stroke: var(--badge-danger-fg);
}

.graph-tone--warn.graph-pill--outline .graph-pill__box {
  fill: var(--surface);
  stroke: var(--badge-warn-fg);
}

.graph-tone--info.graph-pill--outline .graph-pill__box {
  fill: var(--surface);
  stroke: var(--badge-info-fg);
}

.graph-node--importer .graph-node__box {
  fill: var(--workspace-bg);
  stroke: var(--workspace-border);
}

.graph-node--importer .graph-node__label {
  fill: var(--workspace-fg);
  font-weight: 600;
}

.graph-node--cluster .graph-node__box {
  fill: var(--surface-panel);
}

.graph-node--cluster .graph-node__label,
.graph-node--stub .graph-node__label {
  fill: var(--text-muted);
}

.graph-node--stub .graph-node__box {
  fill: var(--surface);
  stroke: var(--text-faint);
  stroke-dasharray: 4 3;
}

.graph-node__anchor-ring {
  fill: none;
  stroke: var(--text-muted);
  stroke-width: 1.5;
  stroke-dasharray: 5 3;
}

.graph-node--selected .graph-node__anchor-ring {
  stroke: var(--accent);
}

.graph-node--selected .graph-node__box {
  fill: var(--surface-selected);
  stroke: var(--accent);
  stroke-width: 1.5;
}

.graph-node--selected .graph-node__inner {
  stroke: var(--accent);
}

.graph-node:hover .graph-node__box {
  stroke: var(--accent);
}

.graph-node:focus-visible .graph-node__box {
  stroke: var(--accent);
  stroke-width: 2;
}

.graph-node--dimmed {
  opacity: 0.35;
}
</style>
