const ANY_SEGMENTS = Symbol('any-segments')
const PARENT_SEGMENT = '..'

type PatternSegment = RegExp | typeof ANY_SEGMENTS

function segmentToRegExp(segment: string): RegExp {
  const source = [...segment]
    .map((character) => {
      if (character === '*') return '[^/]*'
      if (character === '?') return '[^/]'
      return character.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    })
    .join('')
  const parentGuard = segment === PARENT_SEGMENT ? '' : '(?!\\.\\.$)'
  return new RegExp(`^${parentGuard}${source}$`)
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
      if (path[skipTo] === PARENT_SEGMENT) return false
    }
    return false
  }
  if (pathIndex === path.length || !current.test(path[pathIndex])) return false
  return matchesSegments(pattern, patternIndex + 1, path, pathIndex + 1)
}

export function compileWorkspacePatterns(patterns: string[]): (relPath: string) => boolean {
  const compiled = patterns.map(compilePattern)
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
