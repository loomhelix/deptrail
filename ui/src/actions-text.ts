import type { Preview, PreviewFile } from '../../src/actions/types.ts'
import type { PackageChange } from '../../src/query/graph-diff.ts'
import { HEALTH_SEPARATOR, LIST_SEPARATOR, relativeTime } from './vocabulary.ts'

const MINUS = '−'
const CODE_QUOTE = '`'

export type DiffTone = 'meta' | 'context' | 'added' | 'removed'
export type DiffLine = { text: string; tone: DiffTone }
export type TextSegment = { text: string; code: boolean }

const DIFF_HEADER_LINES = 2
const DIFF_HEADER_PREFIXES = ['--- ', '+++ ']
const DIFF_META_PREFIXES = ['@@', '\\']

export function packageChangeText(change: PackageChange): string {
  const removed = change.removed.join(LIST_SEPARATOR)
  const added = change.added.join(LIST_SEPARATOR)
  if (change.removed.length === 0) return `+ ${change.name} ${added}`
  if (change.added.length === 0) return `${MINUS} ${change.name} ${removed}`
  return `${change.name} ${removed} → ${added}`
}

export function fileStats(file: PreviewFile): string {
  return `+${file.added} ${MINUS}${file.removed}`
}

export function previewMetaText(preview: Pick<Preview, 'manager' | 'createdAt'>, now: number): string {
  return `${preview.manager.name} ${preview.manager.version}${HEALTH_SEPARATOR}${relativeTime(preview.createdAt, now)}`
}

export function codeSegments(text: string): TextSegment[] {
  return text
    .split(CODE_QUOTE)
    .map((part, position) => ({ text: part, code: position % 2 === 1 }))
    .filter((segment) => segment.text !== '')
}

function diffTone(line: string, position: number): DiffTone {
  if (position < DIFF_HEADER_LINES && DIFF_HEADER_PREFIXES.some((prefix) => line.startsWith(prefix))) return 'meta'
  if (DIFF_META_PREFIXES.some((prefix) => line.startsWith(prefix))) return 'meta'
  if (line.startsWith('+')) return 'added'
  return line.startsWith('-') ? 'removed' : 'context'
}

export function diffLines(diff: string): DiffLine[] {
  if (diff === '') return []
  const lines = diff.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.map((text, position) => ({ text, tone: diffTone(text, position) }))
}
