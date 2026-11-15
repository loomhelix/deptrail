export class JsonEditError extends Error {}

const DEFAULT_INDENT_UNIT = '  '
const WHITESPACE = new Set([' ', '\t', '\n', '\r'])
const VALUE_TERMINATORS = new Set([',', '}', ']', ...WHITESPACE])

interface JsonMember {
  key: string
  start: number
  value: JsonNode
}

interface JsonNode {
  kind: 'string' | 'object' | 'other'
  start: number
  end: number
  members: JsonMember[]
}

class JsonScanner {
  private position = 0

  constructor(private readonly text: string) {}

  parseDocument(): JsonNode {
    const root = this.parseValue()
    this.skipWhitespace()
    if (this.position < this.text.length) this.fail('unexpected content after the document')
    return root
  }

  private fail(reason: string): never {
    throw new JsonEditError(`Malformed JSON at offset ${this.position}: ${reason}`)
  }

  private skipWhitespace(): void {
    while (this.position < this.text.length && WHITESPACE.has(this.text[this.position])) this.position++
  }

  private parseValue(): JsonNode {
    this.skipWhitespace()
    const character = this.text[this.position]
    if (character === undefined) return this.fail('unexpected end of input')
    if (character === '{') return this.parseObject()
    if (character === '[') return this.parseArray()
    if (character === '"') {
      const start = this.position
      this.readString()
      return { kind: 'string', start, end: this.position, members: [] }
    }
    return this.parseLiteral()
  }

  private readString(): string {
    const start = this.position
    this.position++
    while (this.position < this.text.length) {
      const character = this.text[this.position]
      if (character === '\\') this.position += 2
      else if (character === '"') {
        this.position++
        try {
          return JSON.parse(this.text.slice(start, this.position)) as string
        } catch {
          return this.fail('invalid string')
        }
      } else this.position++
    }
    return this.fail('unterminated string')
  }

  private parseLiteral(): JsonNode {
    const start = this.position
    while (this.position < this.text.length && !VALUE_TERMINATORS.has(this.text[this.position])) this.position++
    try {
      JSON.parse(this.text.slice(start, this.position))
    } catch {
      this.position = start
      this.fail('invalid value')
    }
    return { kind: 'other', start, end: this.position, members: [] }
  }

  private parseArray(): JsonNode {
    const start = this.position
    this.position++
    this.skipWhitespace()
    if (this.text[this.position] === ']') {
      this.position++
      return { kind: 'other', start, end: this.position, members: [] }
    }
    for (;;) {
      this.parseValue()
      this.skipWhitespace()
      const separator = this.text[this.position++]
      if (separator === ']') return { kind: 'other', start, end: this.position, members: [] }
      if (separator !== ',') {
        this.position--
        this.fail('expected , or ]')
      }
    }
  }

  private parseObject(): JsonNode {
    const start = this.position
    const members: JsonMember[] = []
    this.position++
    this.skipWhitespace()
    if (this.text[this.position] === '}') {
      this.position++
      return { kind: 'object', start, end: this.position, members }
    }
    for (;;) {
      this.skipWhitespace()
      if (this.text[this.position] !== '"') this.fail('expected a string key')
      const memberStart = this.position
      const key = this.readString()
      this.skipWhitespace()
      if (this.text[this.position] !== ':') this.fail('expected :')
      this.position++
      members.push({ key, start: memberStart, value: this.parseValue() })
      this.skipWhitespace()
      const separator = this.text[this.position++]
      if (separator === '}') return { kind: 'object', start, end: this.position, members }
      if (separator !== ',') {
        this.position--
        this.fail('expected , or }')
      }
    }
  }
}

function lineStartOf(text: string, offset: number): number {
  return text.lastIndexOf('\n', offset - 1) + 1
}

function leadingWhitespace(text: string, lineStart: number): string {
  let end = lineStart
  while (text[end] === ' ' || text[end] === '\t') end++
  return text.slice(lineStart, end)
}

function detectIndentUnit(text: string): string {
  const match = /^([ \t]+)[^ \t\r\n]/m.exec(text)
  return match ? match[1] : DEFAULT_INDENT_UNIT
}

function renderMember(keys: readonly string[], value: string, indent: string, unit: string, lineBreak: string): string {
  const [key, ...rest] = keys
  if (rest.length === 0) return `${JSON.stringify(key)}: ${JSON.stringify(value)}`
  const innerIndent = indent + unit
  const inner = renderMember(rest, value, innerIndent, unit, lineBreak)
  return `${JSON.stringify(key)}: {${lineBreak}${innerIndent}${inner}${lineBreak}${indent}}`
}

function insertMember(text: string, object: JsonNode, keys: readonly string[], value: string): string {
  const lineBreak = text.includes('\r\n') ? '\r\n' : '\n'
  const unit = detectIndentUnit(text)
  const last = object.members[object.members.length - 1]
  if (!last) {
    const objectIndent = leadingWhitespace(text, lineStartOf(text, object.start))
    const memberIndent = objectIndent + unit
    const member = renderMember(keys, value, memberIndent, unit, lineBreak)
    return (
      text.slice(0, object.start + 1) +
      lineBreak + memberIndent + member + lineBreak + objectIndent +
      text.slice(object.end - 1)
    )
  }
  const lastLineStart = lineStartOf(text, last.start)
  const sharesLineWithBrace = lastLineStart <= object.start
  const memberIndent = leadingWhitespace(text, lastLineStart)
  const separator = sharesLineWithBrace ? ', ' : `,${lineBreak}${memberIndent}`
  const member = renderMember(keys, value, memberIndent, unit, lineBreak)
  return text.slice(0, last.value.end) + separator + member + text.slice(last.value.end)
}

export function setJsonString(text: string, path: readonly string[], value: string): string {
  if (path.length === 0) throw new JsonEditError('The path is empty')
  let current = new JsonScanner(text).parseDocument()
  if (current.kind !== 'object') throw new JsonEditError('The document is not an object')
  for (let index = 0; index < path.length; index++) {
    const key = path[index]
    const member = current.members.filter((candidate) => candidate.key === key).at(-1)
    if (!member) return insertMember(text, current, path.slice(index), value)
    const isLast = index === path.length - 1
    if (isLast) {
      if (member.value.kind !== 'string') throw new JsonEditError(`${path.join('.')} is not a string`)
      return text.slice(0, member.value.start) + JSON.stringify(value) + text.slice(member.value.end)
    }
    if (member.value.kind !== 'object') throw new JsonEditError(`${path.slice(0, index + 1).join('.')} is not an object`)
    current = member.value
  }
  throw new JsonEditError('The path was not resolved')
}
