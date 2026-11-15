export const DIFF_CONTEXT_LINES = 3
export const MAX_EDIT_DISTANCE = 4000

export type LineDiff = { diff: string; added: number; removed: number }

type OperationKind = 'equal' | 'remove' | 'add'

type Operation = { kind: OperationKind; oldIndex: number; newIndex: number }

type SplitText = { lines: string[]; keys: string[]; lastLineUnterminated: boolean }

const NO_NEWLINE_MARKER = '\\ No newline at end of file'
const LINE_PREFIX: Record<OperationKind, string> = { equal: ' ', remove: '-', add: '+' }

function splitLines(text: string | null): SplitText {
  if (text === null || text === '') return { lines: [], keys: [], lastLineUnterminated: false }
  const lines = text.split('\n')
  const lastLineUnterminated = lines[lines.length - 1] !== ''
  if (!lastLineUnterminated) lines.pop()
  const keys = lines.slice()
  if (lastLineUnterminated) keys[keys.length - 1] += '\n'
  return { lines, keys, lastLineUnterminated }
}

function commonPrefixLength(before: string[], after: string[]): number {
  const limit = Math.min(before.length, after.length)
  let length = 0
  while (length < limit && before[length] === after[length]) length++
  return length
}

function commonSuffixLength(before: string[], after: string[], prefix: number): number {
  const limit = Math.min(before.length, after.length) - prefix
  let length = 0
  while (length < limit && before[before.length - 1 - length] === after[after.length - 1 - length]) length++
  return length
}

function replacementOperations(removedCount: number, addedCount: number, oldOffset: number, newOffset: number): Operation[] {
  const operations: Operation[] = []
  for (let index = 0; index < removedCount; index++) {
    operations.push({ kind: 'remove', oldIndex: oldOffset + index, newIndex: newOffset })
  }
  for (let index = 0; index < addedCount; index++) {
    operations.push({ kind: 'add', oldIndex: oldOffset + removedCount, newIndex: newOffset + index })
  }
  return operations
}

function myersTrace(before: string[], after: string[], maxDistance: number): Int32Array[] | null {
  const beforeLength = before.length
  const afterLength = after.length
  const limit = Math.min(beforeLength + afterLength, maxDistance)
  const offset = limit + 1
  const furthest = new Int32Array(2 * limit + 3)
  const trace: Int32Array[] = []
  for (let distance = 0; distance <= limit; distance++) {
    const snapshot = new Int32Array(distance + 1)
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      let x: number
      if (diagonal === -distance || (diagonal !== distance && furthest[offset + diagonal - 1] < furthest[offset + diagonal + 1])) {
        x = furthest[offset + diagonal + 1]
      } else {
        x = furthest[offset + diagonal - 1] + 1
      }
      let y = x - diagonal
      while (x < beforeLength && y < afterLength && before[x] === after[y]) {
        x++
        y++
      }
      furthest[offset + diagonal] = x
      snapshot[(diagonal + distance) / 2] = x
      if (x >= beforeLength && y >= afterLength) {
        trace.push(snapshot)
        return trace
      }
    }
    trace.push(snapshot)
  }
  return null
}

function operationsFromTrace(trace: Int32Array[], beforeLength: number, afterLength: number): Operation[] {
  const reversed: Operation[] = []
  let x = beforeLength
  let y = afterLength
  for (let distance = trace.length - 1; distance >= 0; distance--) {
    const diagonal = x - y
    let previousX = 0
    let previousY = 0
    let editFromRemoval = false
    if (distance > 0) {
      const previous = trace[distance - 1]
      const valueAt = (k: number) => previous[(k + distance - 1) / 2]
      const cameFromAbove =
        diagonal === -distance || (diagonal !== distance && valueAt(diagonal - 1) < valueAt(diagonal + 1))
      const previousDiagonal = cameFromAbove ? diagonal + 1 : diagonal - 1
      previousX = valueAt(previousDiagonal)
      previousY = previousX - previousDiagonal
      editFromRemoval = !cameFromAbove
    }
    const snakeStartX = distance > 0 ? (editFromRemoval ? previousX + 1 : previousX) : 0
    while (x > snakeStartX) {
      x--
      y--
      reversed.push({ kind: 'equal', oldIndex: x, newIndex: y })
    }
    if (distance > 0) {
      if (editFromRemoval) {
        reversed.push({ kind: 'remove', oldIndex: previousX, newIndex: previousY })
      } else {
        reversed.push({ kind: 'add', oldIndex: previousX, newIndex: previousY })
      }
      x = previousX
      y = previousY
    }
  }
  return reversed.reverse()
}

function diffOperations(before: string[], after: string[]): Operation[] {
  const prefix = commonPrefixLength(before, after)
  const suffix = commonSuffixLength(before, after, prefix)
  const middleBefore = before.slice(prefix, before.length - suffix)
  const middleAfter = after.slice(prefix, after.length - suffix)
  const operations: Operation[] = []
  for (let index = 0; index < prefix; index++) operations.push({ kind: 'equal', oldIndex: index, newIndex: index })
  const trace = myersTrace(middleBefore, middleAfter, MAX_EDIT_DISTANCE)
  const middle = trace
    ? operationsFromTrace(trace, middleBefore.length, middleAfter.length)
    : replacementOperations(middleBefore.length, middleAfter.length, 0, 0)
  for (const operation of middle) {
    operations.push({ kind: operation.kind, oldIndex: operation.oldIndex + prefix, newIndex: operation.newIndex + prefix })
  }
  for (let index = 0; index < suffix; index++) {
    operations.push({
      kind: 'equal',
      oldIndex: before.length - suffix + index,
      newIndex: after.length - suffix + index
    })
  }
  return operations
}

function hunkRanges(operations: Operation[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  let current: [number, number] | null = null
  for (let index = 0; index < operations.length; index++) {
    if (operations[index].kind === 'equal') continue
    const start = Math.max(0, index - DIFF_CONTEXT_LINES)
    const end = Math.min(operations.length, index + DIFF_CONTEXT_LINES + 1)
    if (current && start <= current[1]) {
      current[1] = end
    } else {
      current = [start, end]
      ranges.push(current)
    }
  }
  return ranges
}

function rangeText(start: number, count: number): string {
  if (count === 1) return String(start)
  return `${start},${count}`
}

function hunkHeader(slice: Operation[]): string {
  const oldCount = slice.filter((operation) => operation.kind !== 'add').length
  const newCount = slice.filter((operation) => operation.kind !== 'remove').length
  const oldStart = oldCount === 0 ? slice[0].oldIndex : slice[0].oldIndex + 1
  const newStart = newCount === 0 ? slice[0].newIndex : slice[0].newIndex + 1
  return `@@ -${rangeText(oldStart, oldCount)} +${rangeText(newStart, newCount)} @@`
}

function renderHunk(slice: Operation[], before: SplitText, after: SplitText): string[] {
  const output = [hunkHeader(slice)]
  for (const operation of slice) {
    const source = operation.kind === 'add' ? after : before
    const index = operation.kind === 'add' ? operation.newIndex : operation.oldIndex
    output.push(LINE_PREFIX[operation.kind] + source.lines[index])
    if (source.lastLineUnterminated && index === source.lines.length - 1) output.push(NO_NEWLINE_MARKER)
  }
  return output
}

export function unifiedDiff(path: string, beforeText: string | null, afterText: string | null): LineDiff {
  if (beforeText === afterText) return { diff: '', added: 0, removed: 0 }
  const before = splitLines(beforeText)
  const after = splitLines(afterText)
  const operations = diffOperations(before.keys, after.keys)
  const ranges = hunkRanges(operations)
  if (ranges.length === 0) return { diff: '', added: 0, removed: 0 }
  const output = [
    beforeText === null ? '--- /dev/null' : `--- a/${path}`,
    afterText === null ? '+++ /dev/null' : `+++ b/${path}`
  ]
  for (const [start, end] of ranges) output.push(...renderHunk(operations.slice(start, end), before, after))
  const added = operations.filter((operation) => operation.kind === 'add').length
  const removed = operations.filter((operation) => operation.kind === 'remove').length
  return { diff: output.join('\n') + '\n', added, removed }
}

export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= maxBytes) return { text, truncated: false }
  const lastLineBreak = bytes.subarray(0, maxBytes).lastIndexOf(0x0a)
  if (lastLineBreak < 0) return { text: '', truncated: true }
  return { text: bytes.subarray(0, lastLineBreak + 1).toString('utf8'), truncated: true }
}
