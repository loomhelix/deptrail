const ANY_SEGMENTS = Symbol('any-segments')
const PARENT_SEGMENT = '..'
const HIDDEN_PREFIX = '.'
const NEGATION_PREFIX = '!'
const CLASS_NEGATIONS = new Set(['!', '^'])

type PatternSegment = RegExp | typeof ANY_SEGMENTS
type BraceGroup = { start: number; end: number; alternatives: string[] }

function braceGroupAt(pattern: string, start: number): BraceGroup | undefined {
  const alternatives: string[] = []
  let depth = 0
  let alternativeStart = start + 1
  for (let index = start; index < pattern.length; index++) {
    const character = pattern[index]
    if (character === '{') depth++
    if (character === ',' && depth === 1) {
      alternatives.push(pattern.slice(alternativeStart, index))
      alternativeStart = index + 1
    }
    if (character === '}' && --depth === 0) {
      alternatives.push(pattern.slice(alternativeStart, index))
      return alternatives.length > 1 ? { start, end: index, alternatives } : undefined
    }
  }
  return undefined
}

function firstBraceGroup(pattern: string): BraceGroup | undefined {
  for (let start = pattern.indexOf('{'); start !== -1; start = pattern.indexOf('{', start + 1)) {
    const group = braceGroupAt(pattern, start)
    if (group !== undefined) return group
  }
  return undefined
}

function expandBraces(pattern: string): string[] {
  const group = firstBraceGroup(pattern)
  if (group === undefined) return [pattern]
  const prefix = pattern.slice(0, group.start)
  const suffix = pattern.slice(group.end + 1)
  return group.alternatives.flatMap((alternative) => expandBraces(`${prefix}${alternative}${suffix}`))
}

function expandPattern(rawPattern: string): string[] {
  const negated = rawPattern.startsWith(NEGATION_PREFIX)
  const body = negated ? rawPattern.slice(NEGATION_PREFIX.length) : rawPattern
  return expandBraces(body).map((expanded) => (negated ? `${NEGATION_PREFIX}${expanded}` : expanded))
}

function escapeLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function classToRegExp(segment: string, open: number): { source: string; next: number } | undefined {
  const negated = CLASS_NEGATIONS.has(segment[open + 1] ?? '')
  const bodyStart = negated ? open + 2 : open + 1
  const close = segment.indexOf(']', bodyStart + 1)
  if (close === -1) return undefined
  const body = segment.slice(bodyStart, close).replace(/[\\\]^]/g, '\\$&')
  return { source: `[${negated ? '^' : ''}${body}]`, next: close + 1 }
}

function segmentToRegExp(segment: string): RegExp {
  let source = ''
  let index = 0
  while (index < segment.length) {
    const character = segment[index]
    const characterClass = character === '[' ? classToRegExp(segment, index) : undefined
    if (characterClass !== undefined) {
      source += characterClass.source
      index = characterClass.next
      continue
    }
    if (character === '*') source += '[^/]*'
    else if (character === '?') source += '[^/]'
    else source += escapeLiteral(character)
    index++
  }
  const parentGuard = segment === PARENT_SEGMENT ? '' : '(?!\\.\\.$)'
  const hiddenGuard = segment.startsWith(HIDDEN_PREFIX) ? '' : '(?!\\.)'
  return new RegExp(`^${parentGuard}${hiddenGuard}${source}$`)
}

function compilePattern(rawPattern: string): { negated: boolean; segments: PatternSegment[] } {
  const negated = rawPattern.startsWith('!')
  const body = (negated ? rawPattern.slice(1) : rawPattern).replace(/^\.\//, '').replace(/\/+$/, '')
  const segments = body
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment): PatternSegment => (segment === '**' ? ANY_SEGMENTS : segmentToRegExp(segment)))
  return { negated, segments }
}

function matchesSegments(pattern: PatternSegment[], patternIndex: number, path: string[], pathIndex: number): boolean {
  if (patternIndex === pattern.length) return pathIndex === path.length
  const current = pattern[patternIndex]
  if (current === ANY_SEGMENTS) {
    for (let skipTo = pathIndex; skipTo <= path.length; skipTo++) {
      if (matchesSegments(pattern, patternIndex + 1, path, skipTo)) return true
      if (path[skipTo]?.startsWith(HIDDEN_PREFIX)) return false
    }
    return false
  }
  if (pathIndex === path.length || !current.test(path[pathIndex])) return false
  return matchesSegments(pattern, patternIndex + 1, path, pathIndex + 1)
}

export function compileWorkspacePatterns(patterns: string[]): (relPath: string) => boolean {
  const compiled = patterns.flatMap(expandPattern).map(compilePattern)
  return (relPath) => {
    const pathSegments = relPath.split('/').filter((segment) => segment !== '')
    let included = false
    for (const pattern of compiled) {
      if (pattern.negated === included && matchesSegments(pattern.segments, 0, pathSegments, 0)) {
        included = !pattern.negated
      }
    }
    return included
  }
}
