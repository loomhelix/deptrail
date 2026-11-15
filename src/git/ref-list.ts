import { isObjectId } from './git-commands.ts'

export type RefKind = 'branch' | 'remote' | 'tag'
export type GitRef = { name: string; short: string; kind: RefKind; commit: string; committedAt: string }
export type RefListing = { refs: GitRef[]; defaultBranch?: string }

const PREFIXES: readonly { prefix: string; kind: RefKind }[] = [
  { prefix: 'refs/heads/', kind: 'branch' },
  { prefix: 'refs/remotes/', kind: 'remote' },
  { prefix: 'refs/tags/', kind: 'tag' },
]
const KIND_ORDER: Record<RefKind, number> = { branch: 0, remote: 1, tag: 2 }
const REMOTE_HEAD = /^refs\/remotes\/[^/]+\/HEAD$/

type Fields = {
  name: string
  objectType: string
  objectId: string
  peeledType: string
  peeledId: string
  committerSeconds: string
  peeledSeconds: string
  symref: string
}

function toFields(record: string): Fields | null {
  const parts = record.split('\0')
  if (parts.length < 8) return null
  const [name, objectType, objectId, peeledType, peeledId, committerSeconds, peeledSeconds, symref] = parts as [
    string, string, string, string, string, string, string, string,
  ]
  return { name, objectType, objectId, peeledType, peeledId, committerSeconds, peeledSeconds, symref }
}

function toIso(seconds: string): string | null {
  if (!/^\d+$/.test(seconds)) return null
  const date = new Date(Number(seconds) * 1000)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function toRef(fields: Fields): GitRef | null {
  const matched = PREFIXES.find(({ prefix }) => fields.name.startsWith(prefix))
  if (!matched) return null
  const short = fields.name.slice(matched.prefix.length)
  if (short.startsWith('-')) return null
  let commit: string
  let seconds: string
  if (fields.objectType === 'commit') {
    commit = fields.objectId
    seconds = fields.committerSeconds
  } else if (fields.objectType === 'tag' && fields.peeledType === 'commit') {
    commit = fields.peeledId
    seconds = fields.peeledSeconds
  } else return null
  if (!isObjectId(commit)) return null
  const committedAt = toIso(seconds)
  if (committedAt === null) return null
  return { name: fields.name, short, kind: matched.kind, commit, committedAt }
}

function compareRefs(left: GitRef, right: GitRef): number {
  if (left.kind !== right.kind) return KIND_ORDER[left.kind] - KIND_ORDER[right.kind]
  if (left.committedAt !== right.committedAt) return left.committedAt < right.committedAt ? 1 : -1
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
}

export function parseRefs(output: string): RefListing {
  const refs: GitRef[] = []
  const remoteHeadTargets: string[] = []
  for (const record of output.split('\n')) {
    if (record === '') continue
    const fields = toFields(record)
    if (!fields) continue
    if (fields.symref !== '') {
      if (REMOTE_HEAD.test(fields.name)) remoteHeadTargets.push(fields.symref)
      continue
    }
    const ref = toRef(fields)
    if (ref) refs.push(ref)
  }
  refs.sort(compareRefs)
  const listed = new Set(refs.map((ref) => ref.name))
  const defaultBranch =
    remoteHeadTargets.find((target) => listed.has(target)) ??
    ['refs/heads/main', 'refs/heads/master'].find((name) => listed.has(name))
  return { refs, defaultBranch }
}
