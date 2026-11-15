<script setup lang="ts">
import type { NodeView } from '../../../src/query/lookup.ts'
import type { Selection } from '../context.ts'
import type { PeerVariant } from '../node-id.ts'
import { rootLabel } from '../labels.ts'
import { ALSO_IN, alsoInRootText, LIST_SEPARATOR, moreCountText, peerVariantText, rootSwitcherName } from '../vocabulary.ts'
import type { AlsoInRoot, HeaderLabel } from '../why-here.ts'

const props = withDefaults(
  defineProps<{
    node: Pick<NodeView, 'name' | 'version' | 'peerSuffix'>
    root: string
    labels: readonly HeaderLabel[]
    alsoIn: { roots: readonly AlsoInRoot[]; more: number }
    variant?: PeerVariant
    notices?: readonly string[]
    loading?: boolean
  }>(),
  { notices: () => [], loading: false },
)

const emit = defineEmits<{ 'open-in-root': [selection: Selection] }>()

const SEPARATOR_MARK = LIST_SEPARATOR.trimEnd()

function hasSeparatorAfter(position: number): boolean {
  return position < props.alsoIn.roots.length - 1
}

function openInRoot(entry: AlsoInRoot): void {
  emit('open-in-root', { root: entry.root, node: entry.node })
}
</script>

<template>
  <div class="package-header">
    <div v-if="notices.length > 0" class="package-header__notice" data-testid="check-notice">
      <p v-for="notice in notices" :key="notice" class="package-header__notice-text">{{ notice }}</p>
    </div>
    <header class="package-header__main" :class="{ 'package-header__main--loading': loading }">
      <h2 class="package-header__title" :title="node.peerSuffix || undefined">
        <span class="mono">{{ node.name }}</span>{{ ' ' }}<span class="package-header__version mono">{{ node.version }}</span>
      </h2>
      <p v-if="variant" class="package-header__peer" :title="variant.suffix">{{ peerVariantText(variant) }}</p>
      <p class="package-header__place">
        <span class="badge package-header__root" :title="rootSwitcherName(root)" data-testid="root-badge">{{ rootLabel(root) }}</span>
        <span v-if="alsoIn.roots.length > 0" class="package-header__also-in" data-testid="also-in">
          {{ ' ' }}{{ ALSO_IN }}
          <template v-for="(entry, position) in alsoIn.roots" :key="entry.root">
            <button type="button" class="package-header__link" @click="openInRoot(entry)">
              {{ alsoInRootText(entry.root, entry.version)
              }}<span v-if="hasSeparatorAfter(position)" class="package-header__separator" aria-hidden="true">{{ SEPARATOR_MARK }}</span>
            </button>
          </template>
          <template v-if="alsoIn.more > 0">{{ ' ' }}{{ moreCountText(alsoIn.more) }}</template>
        </span>
      </p>
      <p v-if="labels.length > 0" class="package-header__labels">
        <span
          v-for="label in labels"
          :key="label.key"
          class="badge"
          :class="[`badge--${label.tone}`, { 'badge--outline': label.outlined }]"
          :title="label.title"
          data-testid="header-label"
        >
          {{ label.text }}
        </span>
      </p>
    </header>
  </div>
</template>

<style scoped>
.package-header__notice {
  display: grid;
  gap: 4px;
  margin: 12px 16px 0;
  padding: 8px 12px;
  border-left: 4px solid var(--badge-warn-fg);
  border-radius: var(--radius);
  background: var(--badge-warn-bg);
  color: var(--badge-warn-fg);
}

.package-header__notice-text {
  margin: 0;
  overflow-wrap: anywhere;
}

.package-header__main {
  display: grid;
  gap: 6px;
  padding: 16px 16px 14px;
  border-bottom: 1px solid var(--border);
  transition: opacity 0.15s;
}

.package-header__main--loading {
  opacity: 0.6;
}

.package-header__main p {
  margin: 0;
}

.package-header__title {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.package-header__title .mono {
  font-size: 16px;
}

.package-header__version {
  color: var(--text-muted);
  font-weight: 500;
}

.package-header__peer {
  color: var(--text-muted);
  overflow-wrap: anywhere;
}

.package-header__place {
  color: var(--text-muted);
  overflow-wrap: anywhere;
}

.package-header__root {
  margin-right: 4px;
  font-size: 13px;
}

.package-header__link {
  display: inline;
  padding: 0;
  border: 0;
  background: none;
  color: var(--accent);
  text-align: left;
  cursor: pointer;
}

.package-header__link:hover {
  text-decoration: underline;
}

.package-header__separator {
  display: inline-block;
  color: var(--text-muted);
}

.package-header__labels {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
</style>
